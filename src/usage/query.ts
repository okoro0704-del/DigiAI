import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { LedgerQuery } from "../contracts/ledger.js";
import { DigiAiError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import type { DigiAiStore } from "../store/types.js";

export function isOperatorCaller(config: AppConfig, caller: CallerApplication): boolean {
  return caller.via === "s2s" && config.operatorCallers.includes(caller.id);
}

export function scopedLedgerQuery(input: {
  caller: CallerApplication;
  actor: ActorContext;
  requested: LedgerQuery;
  operator: boolean;
}): LedgerQuery {
  const query = { ...input.requested };
  if (input.operator) return query;

  if (query.applicationId && query.applicationId !== input.caller.id) {
    logEvent("cross_tenant_query_rejected", { callerId: input.caller.id, requestedApplication: query.applicationId });
    throw new DigiAiError(403, "cross_tenant_forbidden", "Application usage is not visible across callers.");
  }
  query.applicationId = input.caller.id;

  if (query.actorId && query.actorId !== input.actor.trustId) {
    logEvent("cross_tenant_query_rejected", { callerId: input.caller.id, requestedActor: query.actorId });
    throw new DigiAiError(403, "cross_tenant_forbidden", "Actor usage is not visible across tenants.");
  }
  query.actorId = input.actor.trustId;
  return query;
}

export async function readUsageSummary(store: DigiAiStore, query: LedgerQuery) {
  return store.aggregateUsage(query);
}

export async function readUsageReceipt(
  store: DigiAiStore,
  receiptId: string,
  scope: { operator: boolean; callerId: string; actorId: string },
) {
  const row = await store.getLedgerByReceiptId(receiptId);
  if (!row) return null;
  if (scope.operator) return row;
  if (row.applicationId !== scope.callerId || row.actorId !== scope.actorId) {
    logEvent("cross_tenant_query_rejected", { callerId: scope.callerId, receiptId });
    throw new DigiAiError(403, "cross_tenant_forbidden", "That usage record is not visible to this caller.");
  }
  return row;
}
