import type { LedgerStatus } from "./ledger.js";

/** Integer micro-units. Never a floating-point balance. */
export type DigiAiUnits = number;

export type CreditOwnerType = "actor" | "tenant";

export type CreditAccountStatus = "active" | "suspended";

export type CreditEntryKind = "GRANT" | "RESERVE" | "CONSUME" | "RELEASE" | "ADJUSTMENT" | "EXPIRY";

export type ReservationStatus = "held" | "settled" | "released" | "expired" | "shortfall" | "observe";

export type EconomicsMode = "disabled" | "observe" | "enforce";

export type MeteringPolicyStatus = "development" | "commercial" | "disabled" | "superseded";

export type CreditAccount = {
  accountId: string;
  ownerType: CreditOwnerType;
  ownerId: string;
  tenantId?: string;
  status: CreditAccountStatus;
  createdAt: string;
};

export type CreditLedgerEntry = {
  entryId: string;
  accountId: string;
  kind: CreditEntryKind;
  units: DigiAiUnits;
  reservationId?: string;
  logicalRequestId?: string;
  usageReceiptId?: string;
  meteringPolicyVersion?: string;
  idempotencyKey?: string;
  applicationId?: string;
  actorId?: string;
  tenantId?: string;
  authorizedBy?: string;
  reasonCode?: string;
  createdAt: string;
};

export type CreditReservation = {
  reservationId: string;
  accountId: string;
  logicalRequestId: string;
  estimatedUnits: DigiAiUnits;
  reservedUnits: DigiAiUnits;
  consumedUnits: DigiAiUnits;
  releasedUnits: DigiAiUnits;
  shortfallUnits: DigiAiUnits;
  status: ReservationStatus;
  meteringPolicyVersion: string;
  capability?: string;
  providerOperationId?: string;
  idempotencyKey?: string;
  applicationId?: string;
  actorId?: string;
  tenantId?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreditBalance = {
  accountId: string;
  postedUnits: DigiAiUnits;
  reservedUnits: DigiAiUnits;
  availableUnits: DigiAiUnits;
};

export type CreditReceiptSnapshot = {
  estimatedDigiAiUnits: DigiAiUnits | null;
  reservedDigiAiUnits: DigiAiUnits | null;
  consumedDigiAiUnits: DigiAiUnits | null;
  releasedDigiAiUnits: DigiAiUnits | null;
  meteringPolicyVersion: string | null;
  mode: EconomicsMode;
  commercialPolicyConfigured: boolean;
  reservationId?: string;
  accountId?: string;
  shortfallUnits?: DigiAiUnits;
};

export type CreditSummary = {
  accountId: string;
  ownerType: CreditOwnerType;
  ownerId: string;
  postedUnits: DigiAiUnits;
  reservedUnits: DigiAiUnits;
  availableUnits: DigiAiUnits;
  mode: EconomicsMode;
  commercialPolicyConfigured: boolean;
  commercialAllowanceConfigured: boolean;
};

export type CreditLedgerQuery = {
  accountId: string;
  after?: string;
  limit?: number;
};

export type CreditLedgerPage = {
  entries: CreditLedgerEntry[];
  nextCursor?: string;
};

export type MeteringDimensionRate = {
  dimension: string;
  units: DigiAiUnits;
  per: DigiAiUnits;
};

export type DigiAiMeteringPolicy = {
  policyId: string;
  version: string;
  effectiveFrom: string;
  effectiveTo?: string;
  status: MeteringPolicyStatus;
  commercial: boolean;
  capability: string;
  providerId?: string;
  modelId?: string;
  meteringDimensions: MeteringDimensionRate[];
  minimumCharge: DigiAiUnits;
  maximumCharge?: DigiAiUnits;
  outputTokenHeadroom: DigiAiUnits;
  reservationTtlSeconds: DigiAiUnits;
  createdAt: string;
};

export type ReconciliationAnomaly = {
  code: string;
  message: string;
  logicalRequestId?: string;
  reservationId?: string;
  usageReceiptId?: string;
  accountId?: string;
};

export type CreditReconciliationReport = {
  generatedAt: string;
  anomalies: ReconciliationAnomaly[];
  overlappingPolicies: string[];
};

export type CreditLedgerStatus = LedgerStatus;
