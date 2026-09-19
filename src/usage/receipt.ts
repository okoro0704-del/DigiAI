import type { UsageSnapshot } from "../contracts/response.js";
import type { NativeUsage, RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { estimateTokenCost } from "../registry/pricing.js";
import { listCatalogModels } from "../registry/models.js";
import { nowIso } from "../lib/crypto.js";

export function nativeUsageFromTokens(input?: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}): NativeUsage | undefined {
  if (!input) return undefined;
  const native: NativeUsage = {};
  if (typeof input.inputTokens === "number") native.inputTokens = input.inputTokens;
  if (typeof input.outputTokens === "number") native.outputTokens = input.outputTokens;
  if (typeof input.totalTokens === "number") native.totalTokens = input.totalTokens;
  if (typeof input.cachedTokens === "number") native.cachedTokens = input.cachedTokens;
  return Object.keys(native).length ? native : undefined;
}

export function buildUsageRecord(input: {
  usageId: string;
  requestId: string;
  correlationId: string;
  actorTrustId: string;
  callerId: string;
  entitySlug?: string;
  tenantId?: string;
  capability?: string;
  providerId: string;
  modelId?: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs: number;
  success: boolean;
  status?: UsageRecord["status"];
  nativeUsage?: NativeUsage;
  providerRequestId?: string;
  errorClass?: string;
}): UsageRecord {
  const pricingRef = input.modelId
    ? listCatalogModels().find((row) => row.id === input.modelId && row.providerId === input.providerId)?.pricingRef
    : undefined;
  const estimated = estimateTokenCost(pricingRef, {
    inputTokens: input.nativeUsage?.inputTokens,
    outputTokens: input.nativeUsage?.outputTokens,
  });
  const completedAt = input.completedAt ?? nowIso();
  return {
    usageId: input.usageId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    applicationId: input.callerId,
    entitySlug: input.entitySlug,
    tenantId: input.tenantId,
    capability: input.capability,
    provider: input.providerId,
    providerId: input.providerId,
    model: input.modelId,
    modelId: input.modelId,
    inputTokens: input.nativeUsage?.inputTokens,
    outputTokens: input.nativeUsage?.outputTokens,
    totalTokens: input.nativeUsage?.totalTokens,
    nativeUsage: input.nativeUsage,
    providerRequestId: input.providerRequestId,
    estimatedProviderCost: estimated,
    actualProviderCost: null,
    digiAiUnits: null,
    errorClass: input.errorClass,
    startedAt: input.startedAt,
    completedAt,
    latencyMs: input.latencyMs,
    success: input.success,
    status: input.status ?? (input.success ? "completed" : "failed"),
    createdAt: completedAt,
  };
}

export function buildRequestReceipt(input: {
  receiptId: string;
  requestId: string;
  correlationId: string;
  actorTrustId: string;
  callerId: string;
  entitySlug?: string;
  tenantId?: string;
  operation: string;
  sourcesAccessed: string[];
  provider?: string;
  model?: string;
  capability?: string;
  routeExplanation?: string;
  resultStatus: RequestReceipt["resultStatus"];
  usageId?: string;
}): RequestReceipt {
  return {
    receiptId: input.receiptId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    entitySlug: input.entitySlug,
    tenantId: input.tenantId,
    operation: input.operation,
    sourcesAccessed: input.sourcesAccessed,
    provider: input.provider,
    model: input.model,
    capability: input.capability,
    routeExplanation: input.routeExplanation,
    resultStatus: input.resultStatus,
    usageId: input.usageId,
    createdAt: nowIso(),
  };
}

export function snapshotFromRecord(row: UsageRecord): UsageSnapshot {
  return {
    usageId: row.usageId,
    provider: row.provider,
    model: row.model,
    capability: row.capability,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    nativeUsage: row.nativeUsage,
    estimatedProviderCost: row.estimatedProviderCost ?? null,
    actualProviderCost: row.actualProviderCost ?? null,
    digiAiUnits: null,
    latencyMs: row.latencyMs,
    success: row.success,
  };
}
