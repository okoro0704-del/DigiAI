import type { NativeUsage } from "./usage.js";

export type LedgerEntryKind = "usage" | "adjustment";

export type ReconciliationHook = {
  reconciledAt?: string;
  source?: string;
  actualProviderCost?: number | null;
  discrepancyStatus?: string;
};

export type LedgerEntry = {
  ledgerId: string;
  kind: LedgerEntryKind;
  receiptId: string;
  requestId: string;
  attemptIndex?: number;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  capability?: string;
  providerId: string;
  modelId?: string;
  privacyClass?: string;
  startedAt?: string;
  completedAt: string;
  status: string;
  errorClass?: string;
  nativeUsage: NativeUsage;
  pricingVersion?: string | null;
  estimatedProviderCost: number | null;
  actualProviderCost: number | null;
  currency?: string | null;
  digiAiUnits: null;
  routeExplanation?: string;
  providerRequestId?: string;
  reconciliation?: ReconciliationHook | null;
  createdAt: string;
};

export type LedgerQuery = {
  from?: string;
  to?: string;
  actorId?: string;
  tenantId?: string;
  applicationId?: string;
  capability?: string;
  providerId?: string;
  modelId?: string;
  status?: string;
};

export type NativeTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  imageCount: number;
  audioSeconds: number;
  videoSeconds: number;
  generatedSeconds: number;
};

export type UsageBreakdown = Record<string, { count: number; estimatedProviderCost: number | null; actualProviderCost: number | null }>;

export type UsageAggregate = {
  requestCount: number;
  attemptCount: number;
  successful: number;
  failed: number;
  native: NativeTotals;
  estimatedProviderCost: number | null;
  actualProviderCost: number | null;
  currency: string | null;
  byActor: UsageBreakdown;
  byTenant: UsageBreakdown;
  byApplication: UsageBreakdown;
  byCapability: UsageBreakdown;
  byProvider: UsageBreakdown;
  byModel: UsageBreakdown;
  byStatus: UsageBreakdown;
};

export type LedgerStatus = {
  durable: boolean;
  writable: boolean;
  backend: "memory" | "postgres" | "file";
};
