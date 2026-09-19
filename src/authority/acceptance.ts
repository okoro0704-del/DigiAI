import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { DigiAiStore } from "../store/types.js";
import { consumeAuthorization, createGrant, decideAction, proposeAction, revokeGrant } from "./service.js";

export const AUTHORITY_ACCEPTANCE_NOTE =
  "AUTHORITY ACCEPTANCE. Deterministic governance fixture. No external action executed.";

export async function runAuthorityAcceptance(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication }) {
  const created = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "CREATE",
      actionType: "GENERATE_CAMPAIGN_COPY",
      target: { resourceType: "campaign", resourceId: "accept-copy" },
      parameters: { contentReference: "accept-copy" },
    },
  });
  const publish = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "PUBLISH",
      actionType: "PUBLISH_MYBRANDOS_POST",
      target: { resourceType: "mybrandos-post", resourceId: "accept-draft" },
      parameters: { contentReference: "accept-draft", contentDigest: "v1", destination: "mybrandos", visibility: "public" },
    },
  });
  const approved = publish.intent.status === "HUMAN_DECISION_REQUIRED"
    ? await decideAction({
        store: input.store,
        actor: input.actor,
        caller: input.caller,
        actionIntentId: publish.intent.actionIntentId,
        decision: "APPROVE",
      })
    : publish;
  const grant = await createGrant({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    allowedActionClasses: ["SPEND"],
    limits: { maxValue: 50000, currency: "NGN" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const spendOk = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "accept-spend" },
      parameters: { amount: 25000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  const spendOver = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "accept-spend-over" },
      parameters: { amount: 60000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  const revoked = await revokeGrant({ store: input.store, actor: input.actor, caller: input.caller, grantId: grant.grantId });
  const afterRevoke = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "accept-spend-revoked" },
      parameters: { amount: 1000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  const authId = "authorization" in approved ? approved.authorization?.authorizationId : publish.authorization?.authorizationId;
  let consumed = false;
  let replayDenied = false;
  if (authId) {
    await consumeAuthorization({ store: input.store, actor: input.actor, caller: input.caller, authorizationId: authId });
    consumed = true;
    try {
      await consumeAuthorization({ store: input.store, actor: input.actor, caller: input.caller, authorizationId: authId });
    } catch {
      replayDenied = true;
    }
  }
  return {
    ok: true,
    note: AUTHORITY_ACCEPTANCE_NOTE,
    executed: false,
    createOutcome: created.decision?.outcome,
    publishRequiredHuman: publish.decision?.outcome === "HUMAN_DECISION_REQUIRED" || publish.intent.status === "HUMAN_DECISION_REQUIRED",
    publishStatus: publish.intent.status,
    publishOutcome: publish.decision?.outcome,
    publishAuthorized: Boolean(authId),
    spendWithinGrant: spendOk.decision?.outcome,
    spendOverGrant: spendOver.decision?.outcome,
    grantRevoked: revoked.status === "revoked",
    afterRevokeOutcome: afterRevoke.decision?.outcome,
    consumed,
    replayDenied,
  };
}
