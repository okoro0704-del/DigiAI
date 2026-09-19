import type { LedgerEntry, LedgerQuery, NativeTotals, UsageAggregate, UsageBreakdown } from "../contracts/ledger.js";

export function matchesLedgerQuery(row: LedgerEntry, query: LedgerQuery): boolean {
  if (query.from && row.completedAt < query.from) return false;
  if (query.to && row.completedAt > query.to) return false;
  if (query.actorId && row.actorId !== query.actorId) return false;
  if (query.tenantId && row.tenantId !== query.tenantId) return false;
  if (query.applicationId && row.applicationId !== query.applicationId) return false;
  if (query.capability && row.capability !== query.capability) return false;
  if (query.providerId && row.providerId !== query.providerId) return false;
  if (query.modelId && row.modelId !== query.modelId) return false;
  if (query.status && row.status !== query.status) return false;
  return true;
}

function emptyNative(): NativeTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    imageCount: 0,
    audioSeconds: 0,
    videoSeconds: 0,
    generatedSeconds: 0,
  };
}

function addBreakdown(target: UsageBreakdown, key: string, row: LedgerEntry) {
  const current = target[key] ?? { count: 0, estimatedProviderCost: null, actualProviderCost: null };
  current.count += 1;
  if (row.estimatedProviderCost != null) {
    current.estimatedProviderCost = Number(((current.estimatedProviderCost ?? 0) + row.estimatedProviderCost).toFixed(8));
  }
  if (row.actualProviderCost != null) {
    current.actualProviderCost = Number(((current.actualProviderCost ?? 0) + row.actualProviderCost).toFixed(8));
  }
  target[key] = current;
}

export function aggregateEntries(rows: LedgerEntry[]): UsageAggregate {
  const native = emptyNative();
  const byActor: UsageBreakdown = {};
  const byTenant: UsageBreakdown = {};
  const byApplication: UsageBreakdown = {};
  const byCapability: UsageBreakdown = {};
  const byProvider: UsageBreakdown = {};
  const byModel: UsageBreakdown = {};
  const byStatus: UsageBreakdown = {};
  let estimated = 0;
  let actual = 0;
  let hasEstimated = false;
  let hasActual = false;
  let currency: string | null = null;

  for (const row of rows) {
    if (row.kind !== "usage") continue;
    native.inputTokens += row.nativeUsage.inputTokens ?? 0;
    native.outputTokens += row.nativeUsage.outputTokens ?? 0;
    native.cachedInputTokens += row.nativeUsage.cachedInputTokens ?? row.nativeUsage.cachedTokens ?? 0;
    native.imageCount += row.nativeUsage.imageCount ?? 0;
    native.audioSeconds += row.nativeUsage.audioSeconds ?? 0;
    native.videoSeconds += row.nativeUsage.videoSeconds ?? 0;
    native.generatedSeconds += row.nativeUsage.generatedSeconds ?? 0;
    if (row.estimatedProviderCost != null) {
      estimated += row.estimatedProviderCost;
      hasEstimated = true;
    }
    if (row.actualProviderCost != null) {
      actual += row.actualProviderCost;
      hasActual = true;
    }
    if (row.currency) currency = currency ?? row.currency;
    addBreakdown(byActor, row.actorId, row);
    addBreakdown(byTenant, row.tenantId || "unscoped", row);
    addBreakdown(byApplication, row.applicationId, row);
    addBreakdown(byCapability, row.capability || "unknown", row);
    addBreakdown(byProvider, row.providerId, row);
    addBreakdown(byModel, row.modelId || "unknown", row);
    addBreakdown(byStatus, row.status, row);
  }

  const usageRows = rows.filter((row) => row.kind === "usage");
  const requestIds = new Set(usageRows.map((row) => row.requestId));
  const successfulRequests = new Set(
    usageRows.filter((row) => row.status === "completed").map((row) => row.requestId),
  );
  return {
    requestCount: requestIds.size,
    attemptCount: usageRows.length,
    successful: successfulRequests.size,
    failed: requestIds.size - successfulRequests.size,
    native,
    estimatedProviderCost: hasEstimated ? Number(estimated.toFixed(8)) : null,
    actualProviderCost: hasActual ? Number(actual.toFixed(8)) : null,
    currency,
    byActor,
    byTenant,
    byApplication,
    byCapability,
    byProvider,
    byModel,
    byStatus,
  };
}
