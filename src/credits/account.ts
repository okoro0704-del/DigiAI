import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { CreditAccount, CreditOwnerType } from "../contracts/credits.js";
import { trustedTenantId } from "../usage/ledger.js";

export type CreditOwnerSelection = {
  ownerType: CreditOwnerType;
  ownerId: string;
  tenantId: string;
  applicationId: string;
  actorId: string;
};

export function selectCreditOwner(input: {
  actor: ActorContext;
  caller: CallerApplication;
  entitySlug?: string;
}): CreditOwnerSelection {
  const tenantId = trustedTenantId({ entitySlug: input.entitySlug, actorTrustId: input.actor.trustId });
  const business = Boolean(input.entitySlug?.trim());
  return {
    ownerType: business ? "tenant" : "actor",
    ownerId: business ? input.entitySlug!.trim() : input.actor.trustId,
    tenantId,
    applicationId: input.caller.id,
    actorId: input.actor.trustId,
  };
}

export function accountMatchesOwner(account: CreditAccount, owner: CreditOwnerSelection): boolean {
  return account.ownerType === owner.ownerType && account.ownerId === owner.ownerId;
}
