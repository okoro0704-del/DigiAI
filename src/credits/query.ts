import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { CreditLedgerQuery, CreditSummary } from "../contracts/credits.js";
import { DigiAiError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import type { DigiAiStore } from "../store/types.js";
import { isOperatorCaller } from "../usage/query.js";
import { selectCreditOwner } from "./account.js";
import { commercialPolicyConfigured } from "./policy.js";

export function assertOperatorEconomics(config: AppConfig, caller: CallerApplication) {
  if (!isOperatorCaller(config, caller)) {
    throw new DigiAiError(403, "operator_required", "Operator authorization is required for credit mutations.");
  }
  if (caller.via !== "s2s") {
    throw new DigiAiError(403, "operator_required", "Browser callers cannot change Digi AI Units.");
  }
}

export async function readOwnCreditSummary(input: {
  store: DigiAiStore;
  config: AppConfig;
  actor: ActorContext;
  caller: CallerApplication;
  entitySlug?: string;
}): Promise<CreditSummary> {
  const owner = selectCreditOwner({ actor: input.actor, caller: input.caller, entitySlug: input.entitySlug });
  const account = await input.store.getCreditAccountByOwner(owner.ownerType, owner.ownerId);
  if (!account) {
    return {
      accountId: "",
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      postedUnits: 0,
      reservedUnits: 0,
      availableUnits: 0,
      mode: input.config.economicsMode,
      commercialPolicyConfigured: commercialPolicyConfigured(),
      commercialAllowanceConfigured: false,
    };
  }
  const balance = await input.store.computeCreditBalance(account.accountId);
  return {
    accountId: account.accountId,
    ownerType: account.ownerType,
    ownerId: account.ownerId,
    postedUnits: balance.postedUnits,
    reservedUnits: balance.reservedUnits,
    availableUnits: balance.availableUnits,
    mode: input.config.economicsMode,
    commercialPolicyConfigured: commercialPolicyConfigured(),
    commercialAllowanceConfigured: balance.postedUnits > 0,
  };
}

export async function readOwnCreditLedger(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  entitySlug?: string;
  query: CreditLedgerQuery;
  operator: boolean;
}) {
  const owner = selectCreditOwner({ actor: input.actor, caller: input.caller, entitySlug: input.entitySlug });
  const account = input.query.accountId
    ? await input.store.getCreditAccount(input.query.accountId)
    : await input.store.getCreditAccountByOwner(owner.ownerType, owner.ownerId);
  if (!account) return { entries: [], nextCursor: undefined };
  if (!input.operator && (account.ownerType !== owner.ownerType || account.ownerId !== owner.ownerId)) {
    logEvent("cross_tenant_query_rejected", { callerId: input.caller.id, accountId: account.accountId });
    throw new DigiAiError(403, "cross_tenant_forbidden", "Credit history is not visible across tenants.");
  }
  return input.store.listCreditEntries({ accountId: account.accountId, after: input.query.after, limit: input.query.limit });
}
