import { proposeAction } from "../../authority/service.js";
import type { ActorContext, CallerApplication } from "../../contracts/actor.js";
import { executeAuthorizedAction } from "../../execution/service.js";
import { requireSlug } from "../../lib/slug.js";
import { DigiAiError } from "../../lib/http.js";
import type { DigiAiStore } from "../../store/types.js";

export async function runMybrandosPublicReadAcceptance(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  slug: string;
  operation?: "inspectPublicDigitalLife" | "listPublishedAssets";
}) {
  const slug = requireSlug(input.slug, "mybrandOS");
  const actionType = input.operation === "listPublishedAssets" ? "LIST_MYBRANDOS_PUBLIC_ASSETS" : "INSPECT_MYBRANDOS_PUBLIC";
  const proposed = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "KNOW",
      actionType,
      target: { resourceType: "mybrandos-public", resourceId: slug },
    },
  });
  if (!proposed.authorization) {
    throw new DigiAiError(403, "AUTHORITY_INVALID", "mybrandOS public read was not authorized.");
  }
  const execution = await executeAuthorizedAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    actionIntentId: proposed.intent.actionIntentId,
    authorizationId: proposed.authorization.authorizationId,
    allowFixture: false,
  });
  const receipt = execution.receiptId ? await input.store.getActionExecutionReceipt(execution.receiptId) : null;
  const evidence = receipt?.evidence ?? {};
  return {
    operation: actionType,
    visibilityClass: "PUBLIC" as const,
    status: execution.status,
    receiptStatus: execution.receiptStatus,
    executionId: execution.executionId,
    toolInvocationId: execution.toolInvocationId,
    connectorId: execution.connectorId,
    connectionId: execution.connectionId,
    operationId: execution.operationId,
    slug: evidence.slug ?? slug,
    publishedAssetCount: evidence.publishedAssetCount,
    responseDigest: evidence.responseDigest,
    retrievedAt: evidence.retrievedAt,
    schemaValid: execution.status === "SUCCEEDED",
    factKind: "SOURCE_FACT" as const,
    privacyClass: "PUBLIC" as const,
    hostedTrustIdPrivateRead: false,
    realWritesEnabled: false,
    s2sAuthenticated: evidence.s2sAuthenticated === "true",
    connectionIdSelected: Boolean(execution.connectionId),
    credentialRef: typeof evidence.credentialRef === "string" ? evidence.credentialRef : undefined,
    credentialExposed: false,
  };
}

export async function runMybrandosCreateDraftAcceptance(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  title: string;
}) {
  const proposed = await proposeAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    body: {
      actionClass: "CREATE",
      actionType: "CREATE_MYBRANDOS_DRAFT",
      target: { resourceType: "mybrandos.owner", resourceId: process.env.MYBRANDOS_ACCEPTANCE_OWNER_ID || "TD-UNBOUND" },
      parameters: { contentReference: input.title },
    },
  });
  if (!proposed.authorization) {
    throw new DigiAiError(403, "AUTHORITY_INVALID", "mybrandOS create draft was not authorized.");
  }
  const execution = await executeAuthorizedAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    actionIntentId: proposed.intent.actionIntentId,
    authorizationId: proposed.authorization.authorizationId,
    allowFixture: false,
  });
  const receipt = execution.receiptId ? await input.store.getActionExecutionReceipt(execution.receiptId) : null;
  const evidence = receipt?.evidence ?? {};
  return {
    actionType: "CREATE_MYBRANDOS_DRAFT" as const,
    operation: "mybrandos.createDraft",
    authorityClass: "CREATE" as const,
    subjectAuthoritySource: "AUTHENTICATED_OPERATOR_BOUND_OWNER",
    hostedTrustIdCreateAuthority: false,
    status: execution.status,
    receiptStatus: execution.receiptStatus,
    executionId: execution.executionId,
    toolInvocationId: execution.toolInvocationId,
    connectorId: execution.connectorId,
    connectionId: execution.connectionId,
    operationId: execution.operationId,
    draftId: evidence.draftId,
    state: evidence.state,
    ownerRef: evidence.ownerRef,
    createdAt: evidence.createdAt,
    requestDigest: evidence.contentDigest,
    responseDigest: evidence.responseDigest,
    contentDigest: evidence.contentDigest,
    idempotencyKeyRef: evidence.idempotencyKeyRef ?? execution.executionId,
    privacyClass: "PRIVATE" as const,
    published: false,
    scheduled: false,
    distributed: false,
    schemaValid: execution.status === "SUCCEEDED" && Boolean(evidence.draftId),
    s2sAuthenticated: evidence.s2sAuthenticated === "true",
    credentialRef: typeof evidence.credentialRef === "string" ? evidence.credentialRef : undefined,
    credentialExposed: false,
    realWritesEnabled: false,
    realPublishEnabled: false,
  };
}
