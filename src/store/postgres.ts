import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import type {
  CreditAccount,
  CreditEntryKind,
  CreditLedgerEntry,
  CreditLedgerPage,
  CreditLedgerQuery,
  CreditOwnerType,
  CreditReservation,
  ReservationStatus,
} from "../contracts/credits.js";
import type { DigiAiExecutionPlan, DigiAiExecutionStep, DigiAiObjective } from "../contracts/orchestration.js";
import type { LedgerEntry, LedgerQuery, LedgerStatus } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { creditCursor, deriveCreditBalance, parseCreditCursor } from "../credits/balance.js";
import { addUnits, assertNonNegativeUnits, assertPositiveUnits, assertUnits, clampNonNegative, minUnits, subUnits } from "../credits/units.js";
import { newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import { aggregateEntries } from "../usage/aggregate.js";
import { usageFromLedger } from "../usage/ledger.js";
import type {
  AdjustCreditsInput,
  DigiAiStore,
  EnsureCreditAccountInput,
  GrantCreditsInput,
  ReleaseReservationInput,
  ReserveCreditsInput,
  SettleReservationInput,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_ledger (
  ledger_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'usage',
  receipt_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  provider_request_id TEXT,
  actor_id TEXT NOT NULL,
  tenant_id TEXT,
  application_id TEXT NOT NULL,
  capability TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  privacy_class TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  error_class TEXT,
  native_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  pricing_version TEXT,
  estimated_provider_cost NUMERIC,
  actual_provider_cost NUMERIC,
  currency TEXT,
  digi_ai_units NUMERIC,
  route_explanation TEXT,
  reconciliation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS attempt_index INTEGER;
DROP INDEX IF EXISTS usage_ledger_request_usage;
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_request_attempt
  ON usage_ledger (request_id, attempt_index) WHERE kind = 'usage' AND attempt_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_provider_request
  ON usage_ledger (provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS request_receipts (
  receipt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credit_accounts (
  account_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  tenant_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);
CREATE TABLE IF NOT EXISTS credit_ledger (
  entry_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  units BIGINT NOT NULL,
  reservation_id TEXT,
  logical_request_id TEXT,
  usage_receipt_id TEXT,
  metering_policy_version TEXT,
  idempotency_key TEXT,
  application_id TEXT,
  actor_id TEXT,
  tenant_id TEXT,
  authorized_by TEXT,
  reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_idempotency
  ON credit_ledger (account_id, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_consume_request
  ON credit_ledger (account_id, logical_request_id)
  WHERE kind = 'CONSUME' AND logical_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS credit_reservations (
  reservation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  logical_request_id TEXT NOT NULL,
  estimated_units BIGINT NOT NULL,
  reserved_units BIGINT NOT NULL,
  consumed_units BIGINT NOT NULL DEFAULT 0,
  released_units BIGINT NOT NULL DEFAULT 0,
  shortfall_units BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  metering_policy_version TEXT NOT NULL,
  capability TEXT,
  provider_operation_id TEXT,
  idempotency_key TEXT,
  application_id TEXT,
  actor_id TEXT,
  tenant_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_reservations_request
  ON credit_reservations (account_id, logical_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_reservations_idempotency
  ON credit_reservations (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS ai_objectives (
  objective_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_objectives_idempotency
  ON ai_objectives (application_id, actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS ai_execution_plans (
  plan_id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_execution_steps (
  step_id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (objective_id, step_key)
);
`;

function poolConfig(url: string): PoolConfig {
  const local = /localhost|127\.0\.0\.1/.test(url);
  return {
    connectionString: url,
    max: 5,
    ssl: local ? undefined : { rejectUnauthorized: false },
  };
}

function toEntry(row: QueryResultRow): LedgerEntry {
  return {
    ledgerId: String(row.ledger_id),
    kind: row.kind === "adjustment" ? "adjustment" : "usage",
    receiptId: String(row.receipt_id),
    requestId: String(row.request_id),
    attemptIndex: row.attempt_index == null ? undefined : Number(row.attempt_index),
    actorId: String(row.actor_id),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    applicationId: String(row.application_id),
    capability: row.capability ? String(row.capability) : undefined,
    providerId: String(row.provider_id),
    modelId: row.model_id ? String(row.model_id) : undefined,
    privacyClass: row.privacy_class ? String(row.privacy_class) : undefined,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : undefined,
    completedAt: new Date(row.completed_at).toISOString(),
    status: String(row.status),
    errorClass: row.error_class ? String(row.error_class) : undefined,
    nativeUsage: (row.native_usage ?? {}) as LedgerEntry["nativeUsage"],
    pricingVersion: row.pricing_version ? String(row.pricing_version) : null,
    estimatedProviderCost: row.estimated_provider_cost == null ? null : Number(row.estimated_provider_cost),
    actualProviderCost: row.actual_provider_cost == null ? null : Number(row.actual_provider_cost),
    currency: row.currency ? String(row.currency) : null,
    digiAiUnits: null,
    routeExplanation: row.route_explanation ? String(row.route_explanation) : undefined,
    providerRequestId: row.provider_request_id ? String(row.provider_request_id) : undefined,
    reconciliation: (row.reconciliation ?? null) as LedgerEntry["reconciliation"],
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class PostgresStore implements DigiAiStore {
  private readonly pool: Pool;
  private readyPromise: Promise<void> | null = null;
  private writable = true;

  constructor(databaseUrl: string) {
    this.pool = new Pool(poolConfig(databaseUrl));
  }

  async ready() {
    if (!this.readyPromise) {
      this.readyPromise = this.pool.query(SCHEMA).then(() => undefined);
    }
    await this.readyPromise;
  }

  async recordUsage(row: UsageRecord) {
    await this.ready();
    if (!row.receiptId) return;
    const existing = await this.getLedgerByReceiptId(row.receiptId);
    if (existing) return;
  }

  async recordReceipt(row: RequestReceipt) {
    await this.ready();
    await this.pool.query(
      `INSERT INTO request_receipts (receipt_id, request_id, payload, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (receipt_id) DO NOTHING`,
      [row.receiptId, row.requestId, JSON.stringify(row), row.createdAt],
    );
  }

  async listUsage() {
    const rows = await this.queryLedger({});
    return rows.map((entry) => usageFromLedger(entry));
  }

  async listReceipts() {
    await this.ready();
    const result = await this.pool.query(`SELECT payload FROM request_receipts ORDER BY created_at ASC`);
    return result.rows.map((row) => row.payload as RequestReceipt);
  }

  async findReceiptByIdempotency(callerId: string, idempotencyKey: string) {
    await this.ready();
    const result = await this.pool.query(
      `SELECT payload FROM request_receipts
       WHERE payload->>'callerId' = $1 AND payload->>'idempotencyKey' = $2
       ORDER BY CASE WHEN payload->>'resultStatus' = 'completed' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
      [callerId, idempotencyKey],
    );
    return result.rows[0] ? (result.rows[0].payload as RequestReceipt) : null;
  }

  async updateReceiptSnapshot(receiptId: string, resultSnapshot: RequestReceipt["resultSnapshot"]) {
    await this.ready();
    const existing = await this.pool.query(`SELECT payload FROM request_receipts WHERE receipt_id = $1`, [receiptId]);
    const current = existing.rows[0]?.payload as RequestReceipt | undefined;
    if (!current) return;
    current.resultSnapshot = resultSnapshot;
    await this.pool.query(`UPDATE request_receipts SET payload = $2::jsonb WHERE receipt_id = $1`, [
      receiptId,
      JSON.stringify(current),
    ]);
  }

  async recordLedger(entry: LedgerEntry) {
    await this.ready();
    try {
      const result = await this.pool.query(
        `INSERT INTO usage_ledger (
          ledger_id, kind, receipt_id, request_id, attempt_index, provider_request_id, actor_id, tenant_id,
          application_id, capability, provider_id, model_id, privacy_class, started_at, completed_at,
          status, error_class, native_usage, pricing_version, estimated_provider_cost, actual_provider_cost,
          currency, digi_ai_units, route_explanation, reconciliation, created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,NULL,$23,$24::jsonb,$25
        )
        ON CONFLICT (receipt_id) DO NOTHING`,
        [
          entry.ledgerId,
          entry.kind,
          entry.receiptId,
          entry.requestId,
          entry.attemptIndex ?? null,
          entry.providerRequestId ?? null,
          entry.actorId,
          entry.tenantId ?? null,
          entry.applicationId,
          entry.capability ?? null,
          entry.providerId,
          entry.modelId ?? null,
          entry.privacyClass ?? null,
          entry.startedAt ?? null,
          entry.completedAt,
          entry.status,
          entry.errorClass ?? null,
          JSON.stringify(entry.nativeUsage ?? {}),
          entry.pricingVersion ?? null,
          entry.estimatedProviderCost,
          entry.actualProviderCost,
          entry.currency ?? null,
          entry.routeExplanation ?? null,
          entry.reconciliation ? JSON.stringify(entry.reconciliation) : null,
          entry.createdAt,
        ],
      );
      return { inserted: (result.rowCount ?? 0) > 0 };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
      if (code === "23505") return { inserted: false };
      this.writable = false;
      logEvent("ledger_write_failed", { message: err instanceof Error ? err.message : "write_failed" });
      throw err;
    }
  }

  async getLedgerByReceiptId(receiptId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM usage_ledger WHERE receipt_id = $1`, [receiptId]);
    return result.rows[0] ? toEntry(result.rows[0]) : null;
  }

  async queryLedger(query: LedgerQuery) {
    await this.ready();
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (query.from) add("completed_at >= ?", query.from);
    if (query.to) add("completed_at <= ?", query.to);
    if (query.actorId) add("actor_id = ?", query.actorId);
    if (query.tenantId) add("tenant_id = ?", query.tenantId);
    if (query.applicationId) add("application_id = ?", query.applicationId);
    if (query.capability) add("capability = ?", query.capability);
    if (query.providerId) add("provider_id = ?", query.providerId);
    if (query.modelId) add("model_id = ?", query.modelId);
    if (query.status) add("status = ?", query.status);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.pool.query(`SELECT * FROM usage_ledger ${where} ORDER BY completed_at ASC`, values);
    return result.rows.map(toEntry);
  }

  async aggregateUsage(query: LedgerQuery) {
    return aggregateEntries(await this.queryLedger(query));
  }

  ledgerStatus(): LedgerStatus {
    return { durable: true, writable: this.writable, backend: "postgres" };
  }

  creditStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  private async withCreditTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
      if (code === "23505") throw err;
      this.writable = false;
      logEvent("credit_ledger_write_failed", { message: err instanceof Error ? err.message : "write_failed" });
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadBalance(client: PoolClient, accountId: string) {
    const entries = await client.query(`SELECT * FROM credit_ledger WHERE account_id = $1`, [accountId]);
    const reservations = await client.query(`SELECT * FROM credit_reservations WHERE account_id = $1`, [accountId]);
    return deriveCreditBalance({
      accountId,
      entries: entries.rows.map(toCreditEntry),
      reservations: reservations.rows.map(toReservation),
    });
  }

  private async lockAccount(client: PoolClient, accountId: string) {
    await client.query(`SELECT account_id FROM credit_accounts WHERE account_id = $1 FOR UPDATE`, [accountId]);
  }

  private async insertAccount(client: PoolClient, input: EnsureCreditAccountInput): Promise<CreditAccount> {
    const existing = await client.query(
      `SELECT * FROM credit_accounts WHERE owner_type = $1 AND owner_id = $2`,
      [input.ownerType, input.ownerId],
    );
    if (existing.rows[0]) return toAccount(existing.rows[0]);
    const account: CreditAccount = {
      accountId: newId("acct"),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      status: "active",
      createdAt: nowIso(),
    };
    await client.query(
      `INSERT INTO credit_accounts (account_id, owner_type, owner_id, tenant_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_type, owner_id) DO NOTHING`,
      [account.accountId, account.ownerType, account.ownerId, account.tenantId ?? null, account.status, account.createdAt],
    );
    const row = await client.query(`SELECT * FROM credit_accounts WHERE owner_type = $1 AND owner_id = $2`, [input.ownerType, input.ownerId]);
    return toAccount(row.rows[0]);
  }

  async ensureCreditAccount(input: EnsureCreditAccountInput) {
    return this.withCreditTx(async (client) => this.insertAccount(client, input));
  }

  async getCreditAccount(accountId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM credit_accounts WHERE account_id = $1`, [accountId]);
    return result.rows[0] ? toAccount(result.rows[0]) : null;
  }

  async getCreditAccountByOwner(ownerType: CreditOwnerType, ownerId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM credit_accounts WHERE owner_type = $1 AND owner_id = $2`, [ownerType, ownerId]);
    return result.rows[0] ? toAccount(result.rows[0]) : null;
  }

  async computeCreditBalance(accountId: string) {
    await this.ready();
    const client = await this.pool.connect();
    try {
      return await this.loadBalance(client, accountId);
    } finally {
      client.release();
    }
  }

  async grantCredits(input: GrantCreditsInput) {
    const units = assertPositiveUnits(input.units, "grant");
    return this.withCreditTx(async (client) => {
      const account = await this.insertAccount(client, input);
      await this.lockAccount(client, account.accountId);
      const existing = await client.query(
        `SELECT * FROM credit_ledger WHERE account_id = $1 AND kind = 'GRANT' AND idempotency_key = $2`,
        [account.accountId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return { inserted: false, account, entry: toCreditEntry(existing.rows[0]), balance: await this.loadBalance(client, account.accountId) };
      }
      const entry = creditEntryRow({
        accountId: account.accountId,
        kind: "GRANT",
        units,
        idempotencyKey: input.idempotencyKey,
        applicationId: input.applicationId,
        actorId: input.actorId,
        tenantId: input.tenantId ?? account.tenantId,
        authorizedBy: input.authorizedBy,
        reasonCode: input.reasonCode,
      });
      await insertCreditEntry(client, entry);
      return { inserted: true, account, entry, balance: await this.loadBalance(client, account.accountId) };
    });
  }

  async adjustCredits(input: AdjustCreditsInput) {
    const units = assertUnits(input.units, "adjustment");
    if (units === 0) throw new DigiAiError(400, "invalid_units", "Adjustment cannot be zero.");
    return this.withCreditTx(async (client) => {
      let account: CreditAccount | null = null;
      if (input.accountId) {
        const found = await client.query(`SELECT * FROM credit_accounts WHERE account_id = $1`, [input.accountId]);
        account = found.rows[0] ? toAccount(found.rows[0]) : null;
      } else {
        account = await this.insertAccount(client, { ownerType: input.ownerType!, ownerId: input.ownerId!, tenantId: input.tenantId });
      }
      if (!account) throw new DigiAiError(404, "account_not_found", "Credit account was not found.");
      await this.lockAccount(client, account.accountId);
      const existing = await client.query(
        `SELECT * FROM credit_ledger WHERE account_id = $1 AND kind = 'ADJUSTMENT' AND idempotency_key = $2`,
        [account.accountId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return { inserted: false, account, entry: toCreditEntry(existing.rows[0]), balance: await this.loadBalance(client, account.accountId) };
      }
      const entry = creditEntryRow({
        accountId: account.accountId,
        kind: "ADJUSTMENT",
        units,
        idempotencyKey: input.idempotencyKey,
        applicationId: input.applicationId,
        actorId: input.actorId,
        tenantId: input.tenantId ?? account.tenantId,
        authorizedBy: input.authorizedBy,
        reasonCode: input.reasonCode,
      });
      await insertCreditEntry(client, entry);
      return { inserted: true, account, entry, balance: await this.loadBalance(client, account.accountId) };
    });
  }

  async reserveCredits(input: ReserveCreditsInput) {
    const reservedUnits = assertNonNegativeUnits(input.reservedUnits, "reserve");
    const estimatedUnits = assertNonNegativeUnits(input.estimatedUnits, "estimate");
    return this.withCreditTx(async (client) => {
      await this.lockAccount(client, input.accountId);
      const existing = input.idempotencyKey
        ? await client.query(
            `SELECT * FROM credit_reservations WHERE account_id = $1 AND (idempotency_key = $2 OR logical_request_id = $3) LIMIT 1`,
            [input.accountId, input.idempotencyKey, input.logicalRequestId],
          )
        : await client.query(
            `SELECT * FROM credit_reservations WHERE account_id = $1 AND logical_request_id = $2`,
            [input.accountId, input.logicalRequestId],
          );
      if (existing.rows[0]) {
        return {
          inserted: false,
          reservation: toReservation(existing.rows[0]),
          balance: await this.loadBalance(client, input.accountId),
          insufficient: false,
        };
      }
      const balance = await this.loadBalance(client, input.accountId);
      if (!input.observeOnly && reservedUnits > balance.availableUnits) {
        return {
          inserted: false,
          reservation: {
            reservationId: "",
            accountId: input.accountId,
            logicalRequestId: input.logicalRequestId,
            estimatedUnits,
            reservedUnits,
            consumedUnits: 0,
            releasedUnits: 0,
            shortfallUnits: 0,
            status: "held" as const,
            meteringPolicyVersion: input.meteringPolicyVersion,
            capability: input.capability,
            idempotencyKey: input.idempotencyKey,
            applicationId: input.applicationId,
            actorId: input.actorId,
            tenantId: input.tenantId,
            expiresAt: input.expiresAt,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
          balance,
          insufficient: true,
        };
      }
      const now = nowIso();
      const reservation: CreditReservation = {
        reservationId: newId("rsv"),
        accountId: input.accountId,
        logicalRequestId: input.logicalRequestId,
        estimatedUnits,
        reservedUnits,
        consumedUnits: 0,
        releasedUnits: 0,
        shortfallUnits: 0,
        status: input.observeOnly ? "observe" : "held",
        meteringPolicyVersion: input.meteringPolicyVersion,
        capability: input.capability,
        idempotencyKey: input.idempotencyKey,
        applicationId: input.applicationId,
        actorId: input.actorId,
        tenantId: input.tenantId,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `INSERT INTO credit_reservations (
          reservation_id, account_id, logical_request_id, estimated_units, reserved_units, consumed_units,
          released_units, shortfall_units, status, metering_policy_version, capability, provider_operation_id,
          idempotency_key, application_id, actor_id, tenant_id, expires_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,0,0,0,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15)`,
        [
          reservation.reservationId,
          reservation.accountId,
          reservation.logicalRequestId,
          reservation.estimatedUnits,
          reservation.reservedUnits,
          reservation.status,
          reservation.meteringPolicyVersion,
          reservation.capability ?? null,
          reservation.idempotencyKey ?? null,
          reservation.applicationId ?? null,
          reservation.actorId ?? null,
          reservation.tenantId ?? null,
          reservation.expiresAt ?? null,
          reservation.createdAt,
          reservation.updatedAt,
        ],
      );
      const entry = creditEntryRow({
        accountId: input.accountId,
        kind: "RESERVE",
        units: reservedUnits,
        reservationId: reservation.reservationId,
        logicalRequestId: input.logicalRequestId,
        meteringPolicyVersion: input.meteringPolicyVersion,
        idempotencyKey: input.idempotencyKey,
        applicationId: input.applicationId,
        actorId: input.actorId,
        tenantId: input.tenantId,
        reasonCode: input.observeOnly ? "observe" : "reserve",
      });
      await insertCreditEntry(client, entry);
      return {
        inserted: true,
        reservation,
        entry,
        balance: await this.loadBalance(client, input.accountId),
        insufficient: false,
      };
    });
  }

  async settleReservation(input: SettleReservationInput) {
    const actual = assertNonNegativeUnits(input.actualUnits, "actual");
    return this.withCreditTx(async (client) => {
      const found = await client.query(`SELECT * FROM credit_reservations WHERE reservation_id = $1`, [input.reservationId]);
      if (!found.rows[0]) throw new DigiAiError(404, "reservation_not_found", "Reservation was not found.");
      const reservation = toReservation(found.rows[0]);
      await this.lockAccount(client, reservation.accountId);
      const locked = toReservation((await client.query(`SELECT * FROM credit_reservations WHERE reservation_id = $1 FOR UPDATE`, [input.reservationId])).rows[0]);
      if (locked.status === "settled" || locked.status === "released") {
        return { inserted: false, reservation: locked, balance: await this.loadBalance(client, locked.accountId) };
      }
      const consumeExisting = await client.query(
        `SELECT * FROM credit_ledger WHERE account_id = $1 AND kind = 'CONSUME' AND logical_request_id = $2`,
        [locked.accountId, locked.logicalRequestId],
      );
      if (consumeExisting.rows[0]) {
        return { inserted: false, reservation: locked, consume: toCreditEntry(consumeExisting.rows[0]), balance: await this.loadBalance(client, locked.accountId) };
      }
      const availableExtra = assertNonNegativeUnits(input.additionalAvailable ?? 0, "additional");
      const consumeUnits = minUnits(actual, addUnits(locked.reservedUnits, availableExtra));
      const releaseUnits = clampNonNegative(subUnits(locked.reservedUnits, consumeUnits));
      const shortfall = clampNonNegative(subUnits(actual, consumeUnits));
      let consume: CreditLedgerEntry | undefined;
      let release: CreditLedgerEntry | undefined;
      if (consumeUnits > 0) {
        consume = creditEntryRow({
          accountId: locked.accountId,
          kind: "CONSUME",
          units: consumeUnits,
          reservationId: locked.reservationId,
          logicalRequestId: locked.logicalRequestId,
          usageReceiptId: input.usageReceiptId,
          meteringPolicyVersion: locked.meteringPolicyVersion,
          idempotencyKey: locked.idempotencyKey ? `${locked.idempotencyKey}:consume` : undefined,
          applicationId: locked.applicationId,
          actorId: locked.actorId,
          tenantId: locked.tenantId,
          reasonCode: "settle",
        });
        await insertCreditEntry(client, consume);
      }
      if (releaseUnits > 0) {
        release = creditEntryRow({
          accountId: locked.accountId,
          kind: "RELEASE",
          units: releaseUnits,
          reservationId: locked.reservationId,
          logicalRequestId: locked.logicalRequestId,
          usageReceiptId: input.usageReceiptId,
          meteringPolicyVersion: locked.meteringPolicyVersion,
          idempotencyKey: locked.idempotencyKey ? `${locked.idempotencyKey}:release` : undefined,
          applicationId: locked.applicationId,
          actorId: locked.actorId,
          tenantId: locked.tenantId,
          reasonCode: "unused_reservation",
        });
        await insertCreditEntry(client, release);
      }
      const next: CreditReservation = {
        ...locked,
        consumedUnits: consumeUnits,
        releasedUnits: releaseUnits,
        shortfallUnits: shortfall,
        status: shortfall > 0 ? "shortfall" : "settled",
        updatedAt: nowIso(),
      };
      await client.query(
        `UPDATE credit_reservations SET consumed_units=$2, released_units=$3, shortfall_units=$4, status=$5, updated_at=$6 WHERE reservation_id=$1`,
        [next.reservationId, next.consumedUnits, next.releasedUnits, next.shortfallUnits, next.status, next.updatedAt],
      );
      return { inserted: true, reservation: next, consume, release, balance: await this.loadBalance(client, next.accountId) };
    });
  }

  async releaseReservation(input: ReleaseReservationInput) {
    return this.withCreditTx(async (client) => {
      const found = await client.query(`SELECT * FROM credit_reservations WHERE reservation_id = $1`, [input.reservationId]);
      if (!found.rows[0]) throw new DigiAiError(404, "reservation_not_found", "Reservation was not found.");
      const reservation = toReservation(found.rows[0]);
      await this.lockAccount(client, reservation.accountId);
      const locked = toReservation((await client.query(`SELECT * FROM credit_reservations WHERE reservation_id = $1 FOR UPDATE`, [input.reservationId])).rows[0]);
      if (locked.status === "released" || locked.status === "settled") {
        return { inserted: false, reservation: locked, balance: await this.loadBalance(client, locked.accountId) };
      }
      const remaining = clampNonNegative(subUnits(locked.reservedUnits, addUnits(locked.consumedUnits, locked.releasedUnits)));
      let entry: CreditLedgerEntry | undefined;
      if (remaining > 0) {
        entry = creditEntryRow({
          accountId: locked.accountId,
          kind: "RELEASE",
          units: remaining,
          reservationId: locked.reservationId,
          logicalRequestId: locked.logicalRequestId,
          meteringPolicyVersion: locked.meteringPolicyVersion,
          idempotencyKey: locked.idempotencyKey ? `${locked.idempotencyKey}:abort` : undefined,
          applicationId: locked.applicationId,
          actorId: locked.actorId,
          tenantId: locked.tenantId,
          reasonCode: input.reasonCode ?? "release",
        });
        await insertCreditEntry(client, entry);
      }
      const next: CreditReservation = {
        ...locked,
        releasedUnits: addUnits(locked.releasedUnits, remaining),
        status: "released",
        updatedAt: nowIso(),
      };
      await client.query(
        `UPDATE credit_reservations SET released_units=$2, status=$3, updated_at=$4 WHERE reservation_id=$1`,
        [next.reservationId, next.releasedUnits, next.status, next.updatedAt],
      );
      return { inserted: true, reservation: next, entry, balance: await this.loadBalance(client, next.accountId) };
    });
  }

  async getReservation(reservationId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM credit_reservations WHERE reservation_id = $1`, [reservationId]);
    return result.rows[0] ? toReservation(result.rows[0]) : null;
  }

  async getReservationByIdempotency(accountId: string, idempotencyKey: string) {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM credit_reservations WHERE account_id = $1 AND idempotency_key = $2`,
      [accountId, idempotencyKey],
    );
    return result.rows[0] ? toReservation(result.rows[0]) : null;
  }

  async getReservationByRequest(accountId: string, logicalRequestId: string) {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM credit_reservations WHERE account_id = $1 AND logical_request_id = $2`,
      [accountId, logicalRequestId],
    );
    return result.rows[0] ? toReservation(result.rows[0]) : null;
  }

  async updateReservationHold(reservationId: string, patch: { providerOperationId?: string; expiresAt?: string; status?: ReservationStatus }) {
    await this.ready();
    const current = await this.getReservation(reservationId);
    if (!current) return null;
    const next = {
      ...current,
      providerOperationId: patch.providerOperationId ?? current.providerOperationId,
      expiresAt: patch.expiresAt ?? current.expiresAt,
      status: patch.status ?? current.status,
      updatedAt: nowIso(),
    };
    await this.pool.query(
      `UPDATE credit_reservations SET provider_operation_id=$2, expires_at=$3, status=$4, updated_at=$5 WHERE reservation_id=$1`,
      [reservationId, next.providerOperationId ?? null, next.expiresAt ?? null, next.status, next.updatedAt],
    );
    return next;
  }

  async listCreditEntries(query: CreditLedgerQuery): Promise<CreditLedgerPage> {
    await this.ready();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const cursor = parseCreditCursor(query.after);
    const values: unknown[] = [query.accountId];
    let where = "account_id = $1";
    if (cursor) {
      values.push(cursor.createdAt, cursor.entryId);
      where += ` AND (created_at > $2 OR (created_at = $2 AND entry_id > $3))`;
    }
    values.push(limit + 1);
    const result = await this.pool.query(
      `SELECT * FROM credit_ledger WHERE ${where} ORDER BY created_at ASC, entry_id ASC LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.map(toCreditEntry);
    const entries = rows.slice(0, limit);
    return { entries, nextCursor: rows.length > limit ? creditCursor(entries[entries.length - 1]!) : undefined };
  }

  async listCreditReservations(accountId?: string) {
    await this.ready();
    const result = accountId
      ? await this.pool.query(`SELECT * FROM credit_reservations WHERE account_id = $1`, [accountId])
      : await this.pool.query(`SELECT * FROM credit_reservations`);
    return result.rows.map(toReservation);
  }

  async listCreditAccounts() {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM credit_accounts ORDER BY created_at ASC`);
    return result.rows.map(toAccount);
  }

  async findCreditEntry(accountId: string, kind: CreditEntryKind, idempotencyKey: string) {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM credit_ledger WHERE account_id = $1 AND kind = $2 AND idempotency_key = $3`,
      [accountId, kind, idempotencyKey],
    );
    return result.rows[0] ? toCreditEntry(result.rows[0]) : null;
  }

  orchestrationStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  async putObjective(row: DigiAiObjective) {
    await this.ready();
    if (row.idempotencyKey) {
      const existing = await this.findObjectiveByIdempotency(row.applicationId, row.actorId, row.idempotencyKey);
      if (existing && existing.objectiveId !== row.objectiveId) return { inserted: false };
    }
    const result = await this.pool.query(
      `INSERT INTO ai_objectives (objective_id, application_id, actor_id, idempotency_key, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (objective_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [row.objectiveId, row.applicationId, row.actorId, row.idempotencyKey ?? null, JSON.stringify(row), row.createdAt, row.updatedAt],
    );
    return { inserted: (result.rowCount ?? 0) > 0 };
  }

  async getObjective(objectiveId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT payload FROM ai_objectives WHERE objective_id = $1`, [objectiveId]);
    return result.rows[0] ? (result.rows[0].payload as DigiAiObjective) : null;
  }

  async findObjectiveByIdempotency(applicationId: string, actorId: string, idempotencyKey: string) {
    await this.ready();
    const result = await this.pool.query(
      `SELECT payload FROM ai_objectives WHERE application_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [applicationId, actorId, idempotencyKey],
    );
    return result.rows[0] ? (result.rows[0].payload as DigiAiObjective) : null;
  }

  async putPlan(row: DigiAiExecutionPlan) {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ai_execution_plans (plan_id, objective_id, payload, created_at)
       VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (plan_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [row.planId, row.objectiveId, JSON.stringify(row), row.createdAt],
    );
  }

  async getPlan(objectiveId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT payload FROM ai_execution_plans WHERE objective_id = $1 ORDER BY created_at ASC LIMIT 1`, [objectiveId]);
    return result.rows[0] ? (result.rows[0].payload as DigiAiExecutionPlan) : null;
  }

  async putStep(row: DigiAiExecutionStep) {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ai_execution_steps (step_id, objective_id, step_key, payload, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (step_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [row.stepId, row.objectiveId, row.stepKey, JSON.stringify(row), row.createdAt],
    );
  }

  async updateStep(stepId: string, patch: Partial<DigiAiExecutionStep>) {
    await this.ready();
    const found = await this.pool.query(`SELECT payload FROM ai_execution_steps WHERE step_id = $1`, [stepId]);
    if (!found.rows[0]) return null;
    const next = { ...(found.rows[0].payload as DigiAiExecutionStep), ...patch };
    await this.pool.query(`UPDATE ai_execution_steps SET payload = $2::jsonb WHERE step_id = $1`, [stepId, JSON.stringify(next)]);
    return next;
  }

  async listSteps(objectiveId: string) {
    await this.ready();
    const result = await this.pool.query(`SELECT payload FROM ai_execution_steps WHERE objective_id = $1`, [objectiveId]);
    return result.rows.map((row) => row.payload as DigiAiExecutionStep);
  }

  async listObjectives() {
    await this.ready();
    const result = await this.pool.query(`SELECT payload FROM ai_objectives ORDER BY created_at ASC`);
    return result.rows.map((row) => row.payload as DigiAiObjective);
  }
}

function toAccount(row: QueryResultRow): CreditAccount {
  return {
    accountId: String(row.account_id),
    ownerType: row.owner_type === "tenant" ? "tenant" : "actor",
    ownerId: String(row.owner_id),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toCreditEntry(row: QueryResultRow): CreditLedgerEntry {
  return {
    entryId: String(row.entry_id),
    accountId: String(row.account_id),
    kind: String(row.kind) as CreditLedgerEntry["kind"],
    units: Number(row.units),
    reservationId: row.reservation_id ? String(row.reservation_id) : undefined,
    logicalRequestId: row.logical_request_id ? String(row.logical_request_id) : undefined,
    usageReceiptId: row.usage_receipt_id ? String(row.usage_receipt_id) : undefined,
    meteringPolicyVersion: row.metering_policy_version ? String(row.metering_policy_version) : undefined,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    applicationId: row.application_id ? String(row.application_id) : undefined,
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    authorizedBy: row.authorized_by ? String(row.authorized_by) : undefined,
    reasonCode: row.reason_code ? String(row.reason_code) : undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toReservation(row: QueryResultRow): CreditReservation {
  return {
    reservationId: String(row.reservation_id),
    accountId: String(row.account_id),
    logicalRequestId: String(row.logical_request_id),
    estimatedUnits: Number(row.estimated_units),
    reservedUnits: Number(row.reserved_units),
    consumedUnits: Number(row.consumed_units),
    releasedUnits: Number(row.released_units),
    shortfallUnits: Number(row.shortfall_units),
    status: String(row.status) as ReservationStatus,
    meteringPolicyVersion: String(row.metering_policy_version),
    capability: row.capability ? String(row.capability) : undefined,
    providerOperationId: row.provider_operation_id ? String(row.provider_operation_id) : undefined,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    applicationId: row.application_id ? String(row.application_id) : undefined,
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function creditEntryRow(input: Omit<CreditLedgerEntry, "entryId" | "createdAt">): CreditLedgerEntry {
  return { ...input, entryId: newId("crd"), createdAt: nowIso() };
}

async function insertCreditEntry(client: PoolClient, entry: CreditLedgerEntry) {
  await client.query(
    `INSERT INTO credit_ledger (
      entry_id, account_id, kind, units, reservation_id, logical_request_id, usage_receipt_id,
      metering_policy_version, idempotency_key, application_id, actor_id, tenant_id, authorized_by, reason_code, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      entry.entryId,
      entry.accountId,
      entry.kind,
      entry.units,
      entry.reservationId ?? null,
      entry.logicalRequestId ?? null,
      entry.usageReceiptId ?? null,
      entry.meteringPolicyVersion ?? null,
      entry.idempotencyKey ?? null,
      entry.applicationId ?? null,
      entry.actorId ?? null,
      entry.tenantId ?? null,
      entry.authorizedBy ?? null,
      entry.reasonCode ?? null,
      entry.createdAt,
    ],
  );
}
