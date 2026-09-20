import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
import type {
  AuthorityAuditEvent,
  DigiAiActionAuthorization,
  DigiAiActionIntent,
  DigiAiAuthorityGrant,
  DigiAiHumanDecision,
  DigiAiHumanDecisionRequest,
} from "../contracts/authority.js";
import type { DigiAiToolInvocation, ToolAuditEvent } from "../contracts/connectors.js";
import type {
  DigiAiActionExecution,
  DigiAiActionExecutionReceipt,
  DigiAiActionExecutionRequest,
  ExecutionAuditEvent,
} from "../contracts/execution.js";
import type { DigiAiExecutionPlan, DigiAiExecutionStep, DigiAiObjective } from "../contracts/orchestration.js";
import type { LedgerEntry, LedgerQuery, LedgerStatus } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { creditCursor, deriveCreditBalance, parseCreditCursor } from "../credits/balance.js";
import { addUnits, assertNonNegativeUnits, assertPositiveUnits, assertUnits, clampNonNegative, minUnits, subUnits } from "../credits/units.js";
import { newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import { aggregateEntries, matchesLedgerQuery } from "../usage/aggregate.js";
import type {
  AdjustCreditsInput,
  DigiAiStore,
  EnsureCreditAccountInput,
  GrantCreditsInput,
  ReleaseReservationInput,
  ReserveCreditsInput,
  SettleReservationInput,
} from "./types.js";

export type { DigiAiStore } from "./types.js";

export class MemoryStore implements DigiAiStore {
  readonly usage: UsageRecord[] = [];
  readonly receipts: RequestReceipt[] = [];
  readonly ledger: LedgerEntry[] = [];
  readonly creditAccounts: CreditAccount[] = [];
  readonly creditEntries: CreditLedgerEntry[] = [];
  readonly creditReservations: CreditReservation[] = [];
  readonly objectives: DigiAiObjective[] = [];
  readonly plans: DigiAiExecutionPlan[] = [];
  readonly steps: DigiAiExecutionStep[] = [];
  readonly actionIntents: DigiAiActionIntent[] = [];
  readonly authorityGrants: DigiAiAuthorityGrant[] = [];
  readonly humanDecisions: DigiAiHumanDecision[] = [];
  readonly decisionRequests: DigiAiHumanDecisionRequest[] = [];
  readonly actionAuthorizations: DigiAiActionAuthorization[] = [];
  readonly authorityAudit: AuthorityAuditEvent[] = [];
  readonly actionExecutions: DigiAiActionExecution[] = [];
  readonly actionExecutionRequests: DigiAiActionExecutionRequest[] = [];
  readonly actionExecutionReceipts: DigiAiActionExecutionReceipt[] = [];
  readonly executionAudit: ExecutionAuditEvent[] = [];
  readonly toolInvocations: DigiAiToolInvocation[] = [];
  readonly toolAudit: ToolAuditEvent[] = [];
  private writable = true;
  private readonly creditLocks = new Map<string, Promise<void>>();
  private readonly authorityLocks = new Map<string, Promise<void>>();

  setWritable(value: boolean) {
    this.writable = value;
  }

  async recordUsage(row: UsageRecord) {
    if (!this.writable) throw new Error("usage_ledger_unavailable");
    if (row.receiptId && this.usage.some((existing) => existing.receiptId === row.receiptId)) return;
    if (this.usage.some((existing) => existing.usageId === row.usageId)) return;
    this.usage.push(row);
  }

  async recordReceipt(row: RequestReceipt) {
    if (!this.writable) throw new Error("usage_ledger_unavailable");
    if (this.receipts.some((existing) => existing.receiptId === row.receiptId)) return;
    this.receipts.push(row);
  }

  async listUsage() {
    return [...this.usage];
  }

  async listReceipts() {
    return [...this.receipts];
  }

  async findReceiptByIdempotency(callerId: string, idempotencyKey: string) {
    const matches = this.receipts.filter((row) => row.callerId === callerId && row.idempotencyKey === idempotencyKey);
    return matches.find((row) => row.resultStatus === "completed") ?? matches.at(-1) ?? null;
  }

  async updateReceiptSnapshot(receiptId: string, resultSnapshot: RequestReceipt["resultSnapshot"]) {
    const row = this.receipts.find((existing) => existing.receiptId === receiptId);
    if (row) row.resultSnapshot = resultSnapshot;
  }

  async recordLedger(entry: LedgerEntry) {
    if (!this.writable) throw new Error("usage_ledger_unavailable");
    const duplicate =
      this.ledger.some((row) => row.receiptId === entry.receiptId) ||
      Boolean(
        entry.attemptIndex != null &&
          this.ledger.some((row) => row.requestId === entry.requestId && row.attemptIndex === entry.attemptIndex && row.kind === "usage"),
      ) ||
      Boolean(entry.providerRequestId && this.ledger.some((row) => row.providerRequestId === entry.providerRequestId));
    if (duplicate) return { inserted: false };
    this.ledger.push(entry);
    return { inserted: true };
  }

  async getLedgerByReceiptId(receiptId: string) {
    return this.ledger.find((row) => row.receiptId === receiptId) ?? null;
  }

  async queryLedger(query: LedgerQuery) {
    return this.ledger.filter((row) => matchesLedgerQuery(row, query));
  }

  async aggregateUsage(query: LedgerQuery) {
    return aggregateEntries(await this.queryLedger(query));
  }

  ledgerStatus(): LedgerStatus {
    return { durable: false, writable: this.writable, backend: "memory" };
  }

  creditStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  private async withCreditLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.creditLocks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.creditLocks.set(accountId, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private requireWritable() {
    if (!this.writable) throw new Error("credit_ledger_unavailable");
  }

  private upsertAccount(input: EnsureCreditAccountInput): CreditAccount {
    const existing = this.creditAccounts.find((row) => row.ownerType === input.ownerType && row.ownerId === input.ownerId);
    if (existing) return existing;
    const account: CreditAccount = {
      accountId: newId("acct"),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      status: "active",
      createdAt: nowIso(),
    };
    this.creditAccounts.push(account);
    return account;
  }

  async ensureCreditAccount(input: EnsureCreditAccountInput) {
    this.requireWritable();
    return this.upsertAccount(input);
  }

  async getCreditAccount(accountId: string) {
    return this.creditAccounts.find((row) => row.accountId === accountId) ?? null;
  }

  async getCreditAccountByOwner(ownerType: CreditOwnerType, ownerId: string) {
    return this.creditAccounts.find((row) => row.ownerType === ownerType && row.ownerId === ownerId) ?? null;
  }

  async computeCreditBalance(accountId: string) {
    return deriveCreditBalance({
      accountId,
      entries: this.creditEntries.filter((row) => row.accountId === accountId),
      reservations: this.creditReservations.filter((row) => row.accountId === accountId),
    });
  }

  async grantCredits(input: GrantCreditsInput) {
    this.requireWritable();
    const units = assertPositiveUnits(input.units, "grant");
    const account = this.upsertAccount(input);
    return this.withCreditLock(account.accountId, async () => {
      const existing = this.creditEntries.find(
        (row) => row.accountId === account.accountId && row.kind === "GRANT" && row.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return { inserted: false, account, entry: existing, balance: await this.computeCreditBalance(account.accountId) };
      }
      const entry = appendCreditEntry(this.creditEntries, {
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
      return { inserted: true, account, entry, balance: await this.computeCreditBalance(account.accountId) };
    });
  }

  async adjustCredits(input: AdjustCreditsInput) {
    this.requireWritable();
    const units = assertUnits(input.units, "adjustment");
    if (units === 0) throw new DigiAiError(400, "invalid_units", "Adjustment cannot be zero.");
    const account = input.accountId
      ? this.creditAccounts.find((row) => row.accountId === input.accountId)
      : this.upsertAccount({ ownerType: input.ownerType!, ownerId: input.ownerId!, tenantId: input.tenantId });
    if (!account) throw new DigiAiError(404, "account_not_found", "Credit account was not found.");
    return this.withCreditLock(account.accountId, async () => {
      const existing = this.creditEntries.find(
        (row) => row.accountId === account.accountId && row.kind === "ADJUSTMENT" && row.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return { inserted: false, account, entry: existing, balance: await this.computeCreditBalance(account.accountId) };
      }
      const entry = appendCreditEntry(this.creditEntries, {
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
      return { inserted: true, account, entry, balance: await this.computeCreditBalance(account.accountId) };
    });
  }

  async reserveCredits(input: ReserveCreditsInput) {
    this.requireWritable();
    const reservedUnits = assertNonNegativeUnits(input.reservedUnits, "reserve");
    const estimatedUnits = assertNonNegativeUnits(input.estimatedUnits, "estimate");
    return this.withCreditLock(input.accountId, async () => {
      const byKey = input.idempotencyKey
        ? this.creditReservations.find((row) => row.accountId === input.accountId && row.idempotencyKey === input.idempotencyKey)
        : undefined;
      const byRequest = this.creditReservations.find(
        (row) => row.accountId === input.accountId && row.logicalRequestId === input.logicalRequestId,
      );
      const existing = byKey ?? byRequest;
      if (existing) {
        return {
          inserted: false,
          reservation: existing,
          balance: await this.computeCreditBalance(input.accountId),
          insufficient: false,
        };
      }
      const balance = await this.computeCreditBalance(input.accountId);
      const insufficient = !input.observeOnly && reservedUnits > balance.availableUnits;
      if (insufficient) {
        return { inserted: false, reservation: existingReservationStub(input, reservedUnits, estimatedUnits), balance, insufficient: true };
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
      this.creditReservations.push(reservation);
      const entry = appendCreditEntry(this.creditEntries, {
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
      return {
        inserted: true,
        reservation,
        entry,
        balance: await this.computeCreditBalance(input.accountId),
        insufficient: false,
      };
    });
  }

  async settleReservation(input: SettleReservationInput) {
    this.requireWritable();
    const actual = assertNonNegativeUnits(input.actualUnits, "actual");
    const found = this.creditReservations.find((row) => row.reservationId === input.reservationId);
    if (!found) throw new DigiAiError(404, "reservation_not_found", "Reservation was not found.");
    return this.withCreditLock(found.accountId, async () => {
      const reservation = this.creditReservations.find((row) => row.reservationId === input.reservationId);
      if (!reservation) throw new DigiAiError(404, "reservation_not_found", "Reservation was not found.");
      if (reservation.status === "settled" || reservation.status === "released") {
        return { inserted: false, reservation, balance: await this.computeCreditBalance(reservation.accountId) };
      }
      const consumeExisting = this.creditEntries.find(
        (row) => row.accountId === reservation.accountId && row.kind === "CONSUME" && row.logicalRequestId === reservation.logicalRequestId,
      );
      if (consumeExisting) {
        return { inserted: false, reservation, consume: consumeExisting, balance: await this.computeCreditBalance(reservation.accountId) };
      }
      const availableExtra = assertNonNegativeUnits(input.additionalAvailable ?? 0, "additional");
      const maxConsumable = addUnits(reservation.reservedUnits, availableExtra);
      const consumeUnits = minUnits(actual, maxConsumable);
      const releaseUnits = clampNonNegative(subUnits(reservation.reservedUnits, consumeUnits));
      const shortfall = clampNonNegative(subUnits(actual, consumeUnits));
      let consume: CreditLedgerEntry | undefined;
      let release: CreditLedgerEntry | undefined;
      if (consumeUnits > 0) {
        consume = appendCreditEntry(this.creditEntries, {
          accountId: reservation.accountId,
          kind: "CONSUME",
          units: consumeUnits,
          reservationId: reservation.reservationId,
          logicalRequestId: reservation.logicalRequestId,
          usageReceiptId: input.usageReceiptId,
          meteringPolicyVersion: reservation.meteringPolicyVersion,
          idempotencyKey: reservation.idempotencyKey ? `${reservation.idempotencyKey}:consume` : undefined,
          applicationId: reservation.applicationId,
          actorId: reservation.actorId,
          tenantId: reservation.tenantId,
          reasonCode: "settle",
        });
      }
      if (releaseUnits > 0) {
        release = appendCreditEntry(this.creditEntries, {
          accountId: reservation.accountId,
          kind: "RELEASE",
          units: releaseUnits,
          reservationId: reservation.reservationId,
          logicalRequestId: reservation.logicalRequestId,
          usageReceiptId: input.usageReceiptId,
          meteringPolicyVersion: reservation.meteringPolicyVersion,
          idempotencyKey: reservation.idempotencyKey ? `${reservation.idempotencyKey}:release` : undefined,
          applicationId: reservation.applicationId,
          actorId: reservation.actorId,
          tenantId: reservation.tenantId,
          reasonCode: "unused_reservation",
        });
      }
      reservation.consumedUnits = consumeUnits;
      reservation.releasedUnits = releaseUnits;
      reservation.shortfallUnits = shortfall;
      reservation.status = shortfall > 0 ? "shortfall" : "settled";
      reservation.updatedAt = nowIso();
      return {
        inserted: true,
        reservation,
        consume,
        release,
        balance: await this.computeCreditBalance(reservation.accountId),
      };
    });
  }

  async releaseReservation(input: ReleaseReservationInput) {
    this.requireWritable();
    const reservation = this.creditReservations.find((row) => row.reservationId === input.reservationId);
    if (!reservation) throw new DigiAiError(404, "reservation_not_found", "Reservation was not found.");
    return this.withCreditLock(reservation.accountId, async () => {
      if (reservation.status === "released" || reservation.status === "settled") {
        return { inserted: false, reservation, balance: await this.computeCreditBalance(reservation.accountId) };
      }
      const remaining = clampNonNegative(subUnits(reservation.reservedUnits, addUnits(reservation.consumedUnits, reservation.releasedUnits)));
      let entry: CreditLedgerEntry | undefined;
      if (remaining > 0) {
        entry = appendCreditEntry(this.creditEntries, {
          accountId: reservation.accountId,
          kind: "RELEASE",
          units: remaining,
          reservationId: reservation.reservationId,
          logicalRequestId: reservation.logicalRequestId,
          meteringPolicyVersion: reservation.meteringPolicyVersion,
          idempotencyKey: reservation.idempotencyKey ? `${reservation.idempotencyKey}:abort` : undefined,
          applicationId: reservation.applicationId,
          actorId: reservation.actorId,
          tenantId: reservation.tenantId,
          reasonCode: input.reasonCode ?? "release",
        });
      }
      reservation.releasedUnits = addUnits(reservation.releasedUnits, remaining);
      reservation.status = "released";
      reservation.updatedAt = nowIso();
      return { inserted: true, reservation, entry, balance: await this.computeCreditBalance(reservation.accountId) };
    });
  }

  async getReservation(reservationId: string) {
    return this.creditReservations.find((row) => row.reservationId === reservationId) ?? null;
  }

  async getReservationByIdempotency(accountId: string, idempotencyKey: string) {
    return this.creditReservations.find((row) => row.accountId === accountId && row.idempotencyKey === idempotencyKey) ?? null;
  }

  async getReservationByRequest(accountId: string, logicalRequestId: string) {
    return this.creditReservations.find((row) => row.accountId === accountId && row.logicalRequestId === logicalRequestId) ?? null;
  }

  async updateReservationHold(reservationId: string, patch: { providerOperationId?: string; expiresAt?: string; status?: ReservationStatus }) {
    const reservation = this.creditReservations.find((row) => row.reservationId === reservationId);
    if (!reservation) return null;
    if (patch.providerOperationId) reservation.providerOperationId = patch.providerOperationId;
    if (patch.expiresAt) reservation.expiresAt = patch.expiresAt;
    if (patch.status) reservation.status = patch.status;
    reservation.updatedAt = nowIso();
    return reservation;
  }

  async listCreditEntries(query: CreditLedgerQuery): Promise<CreditLedgerPage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const cursor = parseCreditCursor(query.after);
    const rows = this.creditEntries
      .filter((row) => row.accountId === query.accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId))
      .filter((row) => {
        if (!cursor) return true;
        return row.createdAt > cursor.createdAt || (row.createdAt === cursor.createdAt && row.entryId > cursor.entryId);
      });
    const entries = rows.slice(0, limit);
    const next = rows.length > limit ? creditCursor(entries[entries.length - 1]!) : undefined;
    return { entries, nextCursor: next };
  }

  async listCreditReservations(accountId?: string) {
    return this.creditReservations.filter((row) => !accountId || row.accountId === accountId);
  }

  async listCreditAccounts() {
    return [...this.creditAccounts];
  }

  async findCreditEntry(accountId: string, kind: CreditEntryKind, idempotencyKey: string) {
    return this.creditEntries.find((row) => row.accountId === accountId && row.kind === kind && row.idempotencyKey === idempotencyKey) ?? null;
  }

  orchestrationStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  async putObjective(row: DigiAiObjective) {
    const existing = this.objectives.find((item) => item.objectiveId === row.objectiveId);
    if (existing) {
      Object.assign(existing, row);
      return { inserted: false };
    }
    if (row.idempotencyKey) {
      const dup = this.objectives.find(
        (item) => item.applicationId === row.applicationId && item.actorId === row.actorId && item.idempotencyKey === row.idempotencyKey,
      );
      if (dup) return { inserted: false };
    }
    this.objectives.push(row);
    return { inserted: true };
  }

  async getObjective(objectiveId: string) {
    return this.objectives.find((row) => row.objectiveId === objectiveId) ?? null;
  }

  async findObjectiveByIdempotency(applicationId: string, actorId: string, idempotencyKey: string) {
    return this.objectives.find(
      (row) => row.applicationId === applicationId && row.actorId === actorId && row.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async putPlan(row: DigiAiExecutionPlan) {
    const idx = this.plans.findIndex((item) => item.planId === row.planId);
    if (idx >= 0) this.plans[idx] = row;
    else this.plans.push(row);
  }

  async getPlan(objectiveId: string) {
    return this.plans.find((row) => row.objectiveId === objectiveId) ?? null;
  }

  async putStep(row: DigiAiExecutionStep) {
    const idx = this.steps.findIndex((item) => item.stepId === row.stepId);
    if (idx >= 0) this.steps[idx] = row;
    else this.steps.push(row);
  }

  async updateStep(stepId: string, patch: Partial<DigiAiExecutionStep>) {
    const row = this.steps.find((item) => item.stepId === stepId);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  }

  async listSteps(objectiveId: string) {
    return this.steps.filter((row) => row.objectiveId === objectiveId);
  }

  async listObjectives() {
    return [...this.objectives];
  }

  authorityStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  async putActionIntent(row: DigiAiActionIntent) {
    const idx = this.actionIntents.findIndex((item) => item.actionIntentId === row.actionIntentId);
    if (idx >= 0) this.actionIntents[idx] = row;
    else this.actionIntents.push(row);
  }

  async getActionIntent(actionIntentId: string) {
    return this.actionIntents.find((row) => row.actionIntentId === actionIntentId) ?? null;
  }

  async listActionIntents(objectiveId: string) {
    return this.actionIntents.filter((row) => row.objectiveId === objectiveId);
  }

  async putAuthorityGrant(row: DigiAiAuthorityGrant) {
    const idx = this.authorityGrants.findIndex((item) => item.grantId === row.grantId);
    if (idx >= 0) this.authorityGrants[idx] = row;
    else this.authorityGrants.push(row);
  }

  async getAuthorityGrant(grantId: string) {
    return this.authorityGrants.find((row) => row.grantId === grantId) ?? null;
  }

  async listAuthorityGrants(query: { actorId?: string; tenantId?: string }) {
    return this.authorityGrants.filter(
      (row) => (!query.actorId || row.grantorActorId === query.actorId || row.scope.actorId === query.actorId) && (!query.tenantId || !row.tenantId || row.tenantId === query.tenantId),
    );
  }

  async reserveGrantOccurrence(grantId: string, now: string) {
    return this.withAuthorityLock(grantId, async () => {
      const grant = this.authorityGrants.find((row) => row.grantId === grantId);
      if (!grant) return { ok: false as const, outcome: "INVALID" as const, reason: "MALFORMED_GRANT" as const, message: "Grant was not found." };
      if (grant.status === "revoked" || grant.revokedAt) {
        return { ok: false as const, outcome: "REVOKED" as const, reason: "GRANT_REVOKED" as const, message: "Grant has been revoked." };
      }
      if ((grant.expiresAt && grant.expiresAt <= now) || grant.status === "expired") {
        grant.status = "expired";
        return { ok: false as const, outcome: "EXPIRED" as const, reason: "GRANT_EXPIRED" as const, message: "Grant has expired." };
      }
      if (grant.limits.maxOccurrences != null && grant.consumedOccurrences >= grant.limits.maxOccurrences) {
        return { ok: false as const, outcome: "DENIED" as const, reason: "OCCURRENCE_LIMIT_EXCEEDED" as const, message: "Grant occurrence limit has been consumed." };
      }
      grant.consumedOccurrences += 1;
      return { ok: true as const, grant };
    });
  }

  async putHumanDecision(row: DigiAiHumanDecision) {
    this.humanDecisions.push(row);
  }

  async listHumanDecisions(actionIntentId: string) {
    return this.humanDecisions.filter((row) => row.actionIntentId === actionIntentId);
  }

  async putDecisionRequest(row: DigiAiHumanDecisionRequest) {
    const idx = this.decisionRequests.findIndex((item) => item.decisionRequestId === row.decisionRequestId);
    if (idx >= 0) this.decisionRequests[idx] = row;
    else this.decisionRequests.push(row);
  }

  async getDecisionRequest(decisionRequestId: string) {
    return this.decisionRequests.find((row) => row.decisionRequestId === decisionRequestId) ?? null;
  }

  async putActionAuthorization(row: DigiAiActionAuthorization) {
    const idx = this.actionAuthorizations.findIndex((item) => item.authorizationId === row.authorizationId);
    if (idx >= 0) this.actionAuthorizations[idx] = row;
    else this.actionAuthorizations.push(row);
  }

  async getActionAuthorization(authorizationId: string) {
    return this.actionAuthorizations.find((row) => row.authorizationId === authorizationId) ?? null;
  }

  async consumeActionAuthorization(input: { authorizationId: string; actorId: string; applicationId: string; tenantId?: string; now: string }) {
    return this.withAuthorityLock(input.authorizationId, async () => {
      const row = this.actionAuthorizations.find((item) => item.authorizationId === input.authorizationId);
      if (!row) throw new DigiAiError(404, "not_found", "Action authorization was not found.");
      if (row.actorId !== input.actorId || row.applicationId !== input.applicationId) {
        throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not visible to this caller.");
      }
      if (row.tenantId && input.tenantId && row.tenantId !== input.tenantId) {
        throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not visible to this tenant.");
      }
      if (row.status === "consumed") throw new DigiAiError(409, "AUTHORIZATION_CONSUMED", "Authorization has already been consumed.");
      if (row.status === "invalidated") throw new DigiAiError(409, "AUTHORIZATION_INVALIDATED", "Authorization is no longer valid.");
      if (row.status === "expired" || (row.expiresAt && row.expiresAt <= input.now)) {
        row.status = "expired";
        throw new DigiAiError(409, "AUTHORIZATION_EXPIRED", "Authorization has expired.");
      }
      if (row.status !== "issued" && row.status !== "claimed") throw new DigiAiError(409, "AUTHORITY_INVALID", "Authorization cannot be consumed.");
      row.status = "consumed";
      row.consumedAt = input.now;
      this.authorityAudit.push({
        eventId: newId("aaud"),
        eventType: "AUTHORIZATION_CONSUMED",
        actionIntentId: row.actionIntentId,
        authorizationId: row.authorizationId,
        actorId: input.actorId,
        createdAt: input.now,
      });
      return row;
    });
  }

  async appendAuthorityAudit(row: AuthorityAuditEvent) {
    this.authorityAudit.push(row);
  }

  async listAuthorityAudit(query?: { actionIntentId?: string; grantId?: string }) {
    return this.authorityAudit.filter(
      (row) => (!query?.actionIntentId || row.actionIntentId === query.actionIntentId) && (!query?.grantId || row.grantId === query.grantId),
    );
  }

  actionExecutionStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  async claimActionAuthorization(input: {
    authorizationId: string;
    actorId: string;
    applicationId: string;
    tenantId?: string;
    now: string;
    execution: DigiAiActionExecution;
  }) {
    return this.withAuthorityLock(input.authorizationId, async () => {
      const row = this.actionAuthorizations.find((item) => item.authorizationId === input.authorizationId);
      if (!row) throw new DigiAiError(404, "not_found", "Action authorization was not found.");
      if (row.actorId !== input.actorId || row.applicationId !== input.applicationId) {
        throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not usable by this caller.");
      }
      if (row.tenantId && input.tenantId && row.tenantId !== input.tenantId) {
        throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not usable by this tenant.");
      }
      if (row.status === "consumed") throw new DigiAiError(409, "AUTHORIZATION_CONSUMED", "Authorization has already been consumed.");
      if (row.status === "invalidated") throw new DigiAiError(409, "AUTHORIZATION_INVALIDATED", "Authorization is no longer valid.");
      if (row.status === "expired" || (row.expiresAt && row.expiresAt <= input.now)) {
        row.status = "expired";
        throw new DigiAiError(409, "AUTHORIZATION_EXPIRED", "Authorization has expired.");
      }
      if (row.status === "claimed" && row.claimedByExecutionId) {
        const existing = this.actionExecutions.find((item) => item.executionId === row.claimedByExecutionId);
        if (existing) return { authorization: row, execution: existing, created: false };
        throw new DigiAiError(409, "AUTHORIZATION_CONSUMED", "Authorization is already claimed.");
      }
      row.status = "claimed";
      row.claimedByExecutionId = input.execution.executionId;
      row.claimedAt = input.now;
      input.execution.status = "AUTHORIZED";
      const idx = this.actionExecutions.findIndex((item) => item.executionId === input.execution.executionId);
      if (idx >= 0) this.actionExecutions[idx] = input.execution;
      else this.actionExecutions.push(input.execution);
      return { authorization: row, execution: input.execution, created: true };
    });
  }

  async putActionExecutionRequest(row: DigiAiActionExecutionRequest) {
    const idx = this.actionExecutionRequests.findIndex(
      (item) =>
        item.executionRequestId === row.executionRequestId
        || (item.applicationId === row.applicationId && item.actorId === row.actorId && item.idempotencyKey === row.idempotencyKey),
    );
    if (idx >= 0) this.actionExecutionRequests[idx] = row;
    else this.actionExecutionRequests.push(row);
  }

  async putActionExecution(row: DigiAiActionExecution) {
    const idx = this.actionExecutions.findIndex((item) => item.executionId === row.executionId);
    if (idx >= 0) this.actionExecutions[idx] = row;
    else this.actionExecutions.push(row);
  }

  async beginActionExecution(executionId: string, now: string, opts?: { resume?: boolean }) {
    return this.withAuthorityLock(`exec:${executionId}`, async () => {
      const row = this.actionExecutions.find((item) => item.executionId === executionId);
      if (!row) throw new DigiAiError(404, "not_found", "Action execution was not found.");
      if (row.status === "SUCCEEDED" || row.status === "FAILED" || row.status === "CANCELLED") {
        return { execution: row, invoke: false };
      }
      if (row.status === "UNKNOWN_OUTCOME" && !opts?.resume) return { execution: row, invoke: false };
      if (row.status === "RUNNING") return { execution: row, invoke: false };
      if (row.status === "WAITING" && !opts?.resume) return { execution: row, invoke: false };
      row.status = "RUNNING";
      row.startedAt = row.startedAt ?? now;
      row.attemptCount += 1;
      row.updatedAt = now;
      return { execution: row, invoke: true };
    });
  }

  async getActionExecution(executionId: string) {
    return this.actionExecutions.find((row) => row.executionId === executionId) ?? null;
  }

  async getExecutionByAuthorization(authorizationId: string) {
    return this.actionExecutions.find((row) => row.authorizationId === authorizationId) ?? null;
  }

  async findExecutionByIdempotency(applicationId: string, actorId: string, idempotencyKey: string) {
    const request = this.actionExecutionRequests.find(
      (row) => row.applicationId === applicationId && row.actorId === actorId && row.idempotencyKey === idempotencyKey,
    );
    return request ? this.actionExecutions.find((row) => row.executionRequestId === request.executionRequestId) ?? null : null;
  }

  async putActionExecutionReceipt(row: DigiAiActionExecutionReceipt) {
    const idx = this.actionExecutionReceipts.findIndex((item) => item.receiptId === row.receiptId);
    if (idx >= 0) this.actionExecutionReceipts[idx] = row;
    else this.actionExecutionReceipts.push(row);
  }

  async getActionExecutionReceipt(receiptId: string) {
    return this.actionExecutionReceipts.find((row) => row.receiptId === receiptId) ?? null;
  }

  async appendExecutionAudit(row: ExecutionAuditEvent) {
    this.executionAudit.push(row);
  }

  async listExecutionAudit(executionId: string) {
    return this.executionAudit.filter((row) => row.executionId === executionId);
  }

  toolConnectorStatus(): LedgerStatus {
    return this.ledgerStatus();
  }

  async putToolInvocation(row: DigiAiToolInvocation) {
    const idx = this.toolInvocations.findIndex((item) => item.toolInvocationId === row.toolInvocationId);
    if (idx >= 0) this.toolInvocations[idx] = row;
    else this.toolInvocations.push(row);
  }

  async beginToolInvocation(row: DigiAiToolInvocation) {
    return this.withAuthorityLock(`tool:${row.executionId}`, async () => {
      const existing = this.toolInvocations.find((item) => item.executionId === row.executionId);
      if (existing) {
        if (existing.status === "PENDING") return { invocation: existing, invoke: true };
        return { invocation: existing, invoke: false };
      }
      row.status = "PENDING";
      this.toolInvocations.push(row);
      return { invocation: row, invoke: true };
    });
  }

  async getToolInvocation(toolInvocationId: string) {
    return this.toolInvocations.find((row) => row.toolInvocationId === toolInvocationId) ?? null;
  }

  async getToolInvocationByExecution(executionId: string) {
    return this.toolInvocations.find((row) => row.executionId === executionId) ?? null;
  }

  async appendToolAudit(row: ToolAuditEvent) {
    this.toolAudit.push(row);
  }

  async listToolAudit(toolInvocationId: string) {
    return this.toolAudit.filter((row) => row.toolInvocationId === toolInvocationId);
  }

  private async withAuthorityLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.authorityLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.authorityLocks.set(key, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function appendCreditEntry(rows: CreditLedgerEntry[], input: Omit<CreditLedgerEntry, "entryId" | "createdAt">): CreditLedgerEntry {
  const entry: CreditLedgerEntry = {
    ...input,
    entryId: newId("crd"),
    createdAt: nowIso(),
  };
  rows.push(entry);
  return entry;
}

function existingReservationStub(input: ReserveCreditsInput, reservedUnits: number, estimatedUnits: number): CreditReservation {
  const now = nowIso();
  return {
    reservationId: "",
    accountId: input.accountId,
    logicalRequestId: input.logicalRequestId,
    estimatedUnits,
    reservedUnits,
    consumedUnits: 0,
    releasedUnits: 0,
    shortfallUnits: 0,
    status: "held",
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
}

export class FileBackedStore extends MemoryStore {
  constructor(private readonly dir: string) {
    super();
  }

  private async write(file: string, row: unknown) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, file), `${JSON.stringify(row)}\n`, "utf8");
  }

  override async recordUsage(row: UsageRecord) {
    await super.recordUsage(row);
    await this.write("usage.jsonl", row);
  }

  override async recordReceipt(row: RequestReceipt) {
    await super.recordReceipt(row);
    await this.write("receipts.jsonl", row);
  }

  override async recordLedger(entry: LedgerEntry) {
    const result = await super.recordLedger(entry);
    if (result.inserted) await this.write("ledger.jsonl", entry);
    return result;
  }

  override ledgerStatus(): LedgerStatus {
    return { durable: true, writable: true, backend: "file" };
  }
}

export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}
