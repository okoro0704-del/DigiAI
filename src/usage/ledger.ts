import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { NativeUsage, RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { newId, nowIso } from "../lib/crypto.js";
import { estimateProviderCost } from "./cost.js";

export function trustedTenantId(input: { entitySlug?: string; actorTrustId: string }): string {
  return input.entitySlug?.trim() || input.actorTrustId;
}

export function trustedApplicationId(caller: CallerApplication): string {
  return caller.id;
}

export function buildLedgerEntry(input: {
  receiptId: string;
  requestId: string;
  actor: ActorContext;
  caller: CallerApplication;
  entitySlug?: string;
  capability?: string;
  providerId: string;
  modelId?: string;
  privacyClass?: string;
  startedAt?: string;
  completedAt?: string;
  status: string;
  errorClass?: string;
  nativeUsage?: NativeUsage;
  routeExplanation?: string;
  providerRequestId?: string;
}): LedgerEntry {
  const completedAt = input.completedAt ?? nowIso();
  const cost = estimateProviderCost({
    providerId: input.providerId,
    modelId: input.modelId,
    nativeUsage: input.nativeUsage,
    at: completedAt,
  });
  return {
    ledgerId: newId("led"),
    kind: "usage",
    receiptId: input.receiptId,
    requestId: input.requestId,
    actorId: input.actor.trustId,
    tenantId: trustedTenantId({ entitySlug: input.entitySlug, actorTrustId: input.actor.trustId }),
    applicationId: trustedApplicationId(input.caller),
    capability: input.capability,
    providerId: input.providerId,
    modelId: input.modelId,
    privacyClass: input.privacyClass,
    startedAt: input.startedAt,
    completedAt,
    status: input.status,
    errorClass: input.errorClass,
    nativeUsage: input.nativeUsage ?? {},
    pricingVersion: cost.pricingVersion,
    estimatedProviderCost: cost.estimatedProviderCost,
    actualProviderCost: null,
    currency: cost.currency,
    digiAiUnits: null,
    routeExplanation: input.routeExplanation,
    providerRequestId: input.providerRequestId,
    reconciliation: null,
    createdAt: completedAt,
  };
}

export function usageFromLedger(entry: LedgerEntry, extras?: Partial<UsageRecord>): UsageRecord {
  return {
    usageId: extras?.usageId ?? entry.ledgerId,
    requestId: entry.requestId,
    correlationId: extras?.correlationId ?? entry.requestId,
    actorTrustId: entry.actorId,
    callerId: extras?.callerId ?? entry.applicationId,
    entitySlug: extras?.entitySlug,
    tenantId: entry.tenantId,
    applicationId: entry.applicationId,
    receiptId: entry.receiptId,
    capability: entry.capability,
    privacyClass: entry.privacyClass,
    provider: entry.providerId,
    providerId: entry.providerId,
    model: entry.modelId,
    modelId: entry.modelId,
    inputTokens: entry.nativeUsage.inputTokens,
    outputTokens: entry.nativeUsage.outputTokens,
    totalTokens: entry.nativeUsage.totalTokens,
    nativeUsage: entry.nativeUsage,
    providerRequestId: entry.providerRequestId,
    pricingVersion: entry.pricingVersion,
    currency: entry.currency,
    estimatedProviderCost: entry.estimatedProviderCost,
    actualProviderCost: entry.actualProviderCost,
    digiAiUnits: null,
    errorClass: entry.errorClass,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    latencyMs: extras?.latencyMs ?? 0,
    success: entry.status === "completed",
    status: extras?.status ?? (entry.status === "completed" ? "completed" : "failed"),
    createdAt: entry.createdAt,
  };
}

export function receiptFromParts(input: RequestReceipt): RequestReceipt {
  return input;
}
