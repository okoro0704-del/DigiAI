import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import type { LedgerEntry, LedgerQuery, LedgerStatus } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { logEvent } from "../lib/log.js";
import { aggregateEntries } from "../usage/aggregate.js";
import { usageFromLedger } from "../usage/ledger.js";
import type { DigiAiStore } from "./types.js";

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
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_request_usage
  ON usage_ledger (request_id) WHERE kind = 'usage';
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_provider_request
  ON usage_ledger (provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS request_receipts (
  receipt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

  async recordLedger(entry: LedgerEntry) {
    await this.ready();
    try {
      const result = await this.pool.query(
        `INSERT INTO usage_ledger (
          ledger_id, kind, receipt_id, request_id, provider_request_id, actor_id, tenant_id,
          application_id, capability, provider_id, model_id, privacy_class, started_at, completed_at,
          status, error_class, native_usage, pricing_version, estimated_provider_cost, actual_provider_cost,
          currency, digi_ai_units, route_explanation, reconciliation, created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,NULL,$22,$23::jsonb,$24
        )
        ON CONFLICT (receipt_id) DO NOTHING`,
        [
          entry.ledgerId,
          entry.kind,
          entry.receiptId,
          entry.requestId,
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
}
