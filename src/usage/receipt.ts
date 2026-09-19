import type { UsageSnapshot } from "../contracts/response.js";
import type { NativeUsage, RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { nowIso } from "../lib/crypto.js";
import { estimateProviderCost } from "./cost.js";

export function nativeUsageFromTokens(input?: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  imageCount?: number;
  generatedImageCount?: number;
  imageWidth?: number;
  imageHeight?: number;
  imageBytes?: number;
  audioSeconds?: number;
  generatedSeconds?: number;
  characterCount?: number;
  inputBytes?: number;
  outputBytes?: number;
}): NativeUsage | undefined {
  if (!input) return undefined;
  const native: NativeUsage = {};
  if (typeof input.inputTokens === "number") native.inputTokens = input.inputTokens;
  if (typeof input.outputTokens === "number") native.outputTokens = input.outputTokens;
  if (typeof input.totalTokens === "number") native.totalTokens = input.totalTokens;
  if (typeof input.cachedTokens === "number") native.cachedTokens = input.cachedTokens;
  if (typeof input.imageCount === "number") native.imageCount = input.imageCount;
  if (typeof input.generatedImageCount === "number") native.generatedImageCount = input.generatedImageCount;
  if (typeof input.imageWidth === "number") native.imageWidth = input.imageWidth;
  if (typeof input.imageHeight === "number") native.imageHeight = input.imageHeight;
  if (typeof input.imageBytes === "number") native.imageBytes = input.imageBytes;
  if (typeof input.audioSeconds === "number") native.audioSeconds = input.audioSeconds;
  if (typeof input.generatedSeconds === "number") native.generatedSeconds = input.generatedSeconds;
  if (typeof input.characterCount === "number") native.characterCount = input.characterCount;
  if (typeof input.inputBytes === "number") native.inputBytes = input.inputBytes;
  if (typeof input.outputBytes === "number") native.outputBytes = input.outputBytes;
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
  receiptId?: string;
  capability?: string;
  privacyClass?: string;
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
  const completedAt = input.completedAt ?? nowIso();
  const cost = estimateProviderCost({
    providerId: input.providerId,
    modelId: input.modelId,
    nativeUsage: input.nativeUsage,
    at: completedAt,
  });
  return {
    usageId: input.usageId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    applicationId: input.callerId,
    entitySlug: input.entitySlug,
    tenantId: input.tenantId,
    receiptId: input.receiptId,
    capability: input.capability,
    privacyClass: input.privacyClass,
    provider: input.providerId,
    providerId: input.providerId,
    model: input.modelId,
    modelId: input.modelId,
    inputTokens: input.nativeUsage?.inputTokens,
    outputTokens: input.nativeUsage?.outputTokens,
    totalTokens: input.nativeUsage?.totalTokens,
    nativeUsage: input.nativeUsage,
    providerRequestId: input.providerRequestId,
    pricingVersion: cost.pricingVersion,
    currency: cost.currency,
    estimatedProviderCost: cost.estimatedProviderCost,
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
  idempotencyKey?: string;
  resultSnapshot?: RequestReceipt["resultSnapshot"];
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
    idempotencyKey: input.idempotencyKey,
    resultSnapshot: input.resultSnapshot,
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
    pricingVersion: row.pricingVersion ?? null,
    currency: row.currency ?? null,
    digiAiUnits: null,
    latencyMs: row.latencyMs,
    success: row.success,
  };
}
