import type {
  CreditAccount,
  CreditBalance,
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
  AuthorityOutcome,
  AuthorityReason,
  DigiAiActionAuthorization,
  DigiAiActionIntent,
  DigiAiAuthorityGrant,
  DigiAiHumanDecision,
  DigiAiHumanDecisionRequest,
} from "../contracts/authority.js";
import type { DigiAiExecutionPlan, DigiAiExecutionStep, DigiAiObjective } from "../contracts/orchestration.js";
import type {
  DigiAiActionExecution,
  DigiAiActionExecutionReceipt,
  DigiAiActionExecutionRequest,
  ExecutionAuditEvent,
} from "../contracts/execution.js";
import type { LedgerEntry, LedgerQuery, LedgerStatus, UsageAggregate } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";

export type EnsureCreditAccountInput = {
  ownerType: CreditOwnerType;
  ownerId: string;
  tenantId?: string;
};

export type GrantCreditsInput = {
  ownerType: CreditOwnerType;
  ownerId: string;
  tenantId?: string;
  units: number;
  idempotencyKey: string;
  applicationId?: string;
  actorId?: string;
  authorizedBy: string;
  reasonCode: string;
};

export type AdjustCreditsInput = {
  accountId?: string;
  ownerType?: CreditOwnerType;
  ownerId?: string;
  tenantId?: string;
  units: number;
  idempotencyKey: string;
  applicationId?: string;
  actorId?: string;
  authorizedBy: string;
  reasonCode: string;
};

export type ReserveCreditsInput = {
  accountId: string;
  logicalRequestId: string;
  estimatedUnits: number;
  reservedUnits: number;
  meteringPolicyVersion: string;
  capability?: string;
  idempotencyKey?: string;
  applicationId?: string;
  actorId?: string;
  tenantId?: string;
  expiresAt?: string;
  observeOnly?: boolean;
};

export type SettleReservationInput = {
  reservationId: string;
  actualUnits: number;
  usageReceiptId?: string;
  additionalAvailable?: number;
};

export type ReleaseReservationInput = {
  reservationId: string;
  reasonCode?: string;
};

export type CreditMutationResult<T> = {
  inserted: boolean;
  account?: CreditAccount;
  entry?: CreditLedgerEntry;
  reservation?: CreditReservation;
  balance?: CreditBalance;
  value: T;
};

export interface DigiAiStore {
  recordUsage(row: UsageRecord): Promise<void>;
  recordReceipt(row: RequestReceipt): Promise<void>;
  listUsage(): Promise<UsageRecord[]>;
  listReceipts(): Promise<RequestReceipt[]>;
  recordLedger(entry: LedgerEntry): Promise<{ inserted: boolean }>;
  getLedgerByReceiptId(receiptId: string): Promise<LedgerEntry | null>;
  queryLedger(query: LedgerQuery): Promise<LedgerEntry[]>;
  aggregateUsage(query: LedgerQuery): Promise<UsageAggregate>;
  ledgerStatus(): LedgerStatus;
  findReceiptByIdempotency?(callerId: string, idempotencyKey: string): Promise<RequestReceipt | null>;
  updateReceiptSnapshot?(receiptId: string, resultSnapshot: RequestReceipt["resultSnapshot"]): Promise<void>;
  ready?(): Promise<void>;
  creditStatus(): LedgerStatus;
  ensureCreditAccount(input: EnsureCreditAccountInput): Promise<CreditAccount>;
  getCreditAccount(accountId: string): Promise<CreditAccount | null>;
  getCreditAccountByOwner(ownerType: CreditOwnerType, ownerId: string): Promise<CreditAccount | null>;
  computeCreditBalance(accountId: string): Promise<CreditBalance>;
  grantCredits(input: GrantCreditsInput): Promise<{ inserted: boolean; account: CreditAccount; entry: CreditLedgerEntry; balance: CreditBalance }>;
  adjustCredits(input: AdjustCreditsInput): Promise<{ inserted: boolean; account: CreditAccount; entry: CreditLedgerEntry; balance: CreditBalance }>;
  reserveCredits(input: ReserveCreditsInput): Promise<{
    inserted: boolean;
    reservation: CreditReservation;
    entry?: CreditLedgerEntry;
    balance: CreditBalance;
    insufficient: boolean;
  }>;
  settleReservation(input: SettleReservationInput): Promise<{
    inserted: boolean;
    reservation: CreditReservation;
    consume?: CreditLedgerEntry;
    release?: CreditLedgerEntry;
    balance: CreditBalance;
  }>;
  releaseReservation(input: ReleaseReservationInput): Promise<{
    inserted: boolean;
    reservation: CreditReservation;
    entry?: CreditLedgerEntry;
    balance: CreditBalance;
  }>;
  getReservation(reservationId: string): Promise<CreditReservation | null>;
  getReservationByIdempotency(accountId: string, idempotencyKey: string): Promise<CreditReservation | null>;
  getReservationByRequest(accountId: string, logicalRequestId: string): Promise<CreditReservation | null>;
  updateReservationHold(reservationId: string, patch: { providerOperationId?: string; expiresAt?: string; status?: ReservationStatus }): Promise<CreditReservation | null>;
  listCreditEntries(query: CreditLedgerQuery): Promise<CreditLedgerPage>;
  listCreditReservations(accountId?: string): Promise<CreditReservation[]>;
  listCreditAccounts(): Promise<CreditAccount[]>;
  findCreditEntry(accountId: string, kind: CreditEntryKind, idempotencyKey: string): Promise<CreditLedgerEntry | null>;
  orchestrationStatus(): LedgerStatus;
  putObjective(row: DigiAiObjective): Promise<{ inserted: boolean }>;
  getObjective(objectiveId: string): Promise<DigiAiObjective | null>;
  findObjectiveByIdempotency(applicationId: string, actorId: string, idempotencyKey: string): Promise<DigiAiObjective | null>;
  putPlan(row: DigiAiExecutionPlan): Promise<void>;
  getPlan(objectiveId: string): Promise<DigiAiExecutionPlan | null>;
  putStep(row: DigiAiExecutionStep): Promise<void>;
  updateStep(stepId: string, patch: Partial<DigiAiExecutionStep>): Promise<DigiAiExecutionStep | null>;
  listSteps(objectiveId: string): Promise<DigiAiExecutionStep[]>;
  listObjectives(): Promise<DigiAiObjective[]>;
  authorityStatus(): LedgerStatus;
  putActionIntent(row: DigiAiActionIntent): Promise<void>;
  getActionIntent(actionIntentId: string): Promise<DigiAiActionIntent | null>;
  listActionIntents(objectiveId: string): Promise<DigiAiActionIntent[]>;
  putAuthorityGrant(row: DigiAiAuthorityGrant): Promise<void>;
  getAuthorityGrant(grantId: string): Promise<DigiAiAuthorityGrant | null>;
  listAuthorityGrants(query: { actorId?: string; tenantId?: string }): Promise<DigiAiAuthorityGrant[]>;
  reserveGrantOccurrence(grantId: string, now: string): Promise<
    | { ok: true; grant: DigiAiAuthorityGrant }
    | { ok: false; outcome: AuthorityOutcome; reason: AuthorityReason; message: string }
  >;
  putHumanDecision(row: DigiAiHumanDecision): Promise<void>;
  listHumanDecisions(actionIntentId: string): Promise<DigiAiHumanDecision[]>;
  putDecisionRequest(row: DigiAiHumanDecisionRequest): Promise<void>;
  getDecisionRequest(decisionRequestId: string): Promise<DigiAiHumanDecisionRequest | null>;
  putActionAuthorization(row: DigiAiActionAuthorization): Promise<void>;
  getActionAuthorization(authorizationId: string): Promise<DigiAiActionAuthorization | null>;
  consumeActionAuthorization(input: {
    authorizationId: string;
    actorId: string;
    applicationId: string;
    tenantId?: string;
    now: string;
  }): Promise<DigiAiActionAuthorization>;
  appendAuthorityAudit(row: AuthorityAuditEvent): Promise<void>;
  listAuthorityAudit(query?: { actionIntentId?: string; grantId?: string }): Promise<AuthorityAuditEvent[]>;
  actionExecutionStatus(): LedgerStatus;
  claimActionAuthorization(input: {
    authorizationId: string;
    actorId: string;
    applicationId: string;
    tenantId?: string;
    now: string;
    execution: DigiAiActionExecution;
  }): Promise<{ authorization: DigiAiActionAuthorization; execution: DigiAiActionExecution; created: boolean }>;
  putActionExecutionRequest(row: DigiAiActionExecutionRequest): Promise<void>;
  putActionExecution(row: DigiAiActionExecution): Promise<void>;
  beginActionExecution(executionId: string, now: string, opts?: { resume?: boolean }): Promise<{ execution: DigiAiActionExecution; invoke: boolean }>;
  getActionExecution(executionId: string): Promise<DigiAiActionExecution | null>;
  getExecutionByAuthorization(authorizationId: string): Promise<DigiAiActionExecution | null>;
  findExecutionByIdempotency(applicationId: string, actorId: string, idempotencyKey: string): Promise<DigiAiActionExecution | null>;
  putActionExecutionReceipt(row: DigiAiActionExecutionReceipt): Promise<void>;
  getActionExecutionReceipt(receiptId: string): Promise<DigiAiActionExecutionReceipt | null>;
  appendExecutionAudit(row: ExecutionAuditEvent): Promise<void>;
  listExecutionAudit(executionId: string): Promise<ExecutionAuditEvent[]>;
}
