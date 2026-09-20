import { decideAction, inspectAction, proposeAction } from "../../authority/service.js";
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

export async function runMybrandosPublishDraftAcceptance(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  stage: "propose" | "approve" | "reject" | "execute";
  draftId?: string;
  title?: string;
  description?: string;
  contentDigest?: string;
  actionIntentId?: string;
  authorizationId?: string;
}) {
  if (input.stage === "propose") {
    let draftId = input.draftId?.trim() ?? "";
    let title = (input.title ?? "").trim();
    let description = input.description ?? "";
    let contentDigest = input.contentDigest?.trim().toLowerCase() ?? "";
    if (!draftId) {
      title = title || `Digiconomy governed publish acceptance — ${new Date().toISOString().slice(0, 19)}`;
      const created = await runMybrandosCreateDraftAcceptance({
        store: input.store,
        actor: input.actor,
        caller: input.caller,
        title,
      });
      if (created.status !== "SUCCEEDED" || !created.draftId) {
        throw new DigiAiError(409, "AUTHORITY_INVALID", "A dedicated 3I acceptance draft could not be created.");
      }
      draftId = created.draftId;
      const { publishPayloadDigest } = await import("./subject.js");
      contentDigest = publishPayloadDigest({
        draftId,
        ownerId: created.ownerRef || process.env.MYBRANDOS_ACCEPTANCE_OWNER_ID || "",
        title,
        description,
        writingBody: description,
        assetType: "WRITING",
        dataZoneId: "",
        intendedState: "PUBLISHED",
        intendedVisibility: "public",
      });
    }
    if (!draftId || !/^[a-f0-9]{64}$/.test(contentDigest)) {
      throw new DigiAiError(400, "invalid_request", "Exact draftId and approved content digest are required.");
    }
    const proposed = await proposeAction({
      store: input.store,
      actor: input.actor,
      caller: input.caller,
      body: {
        actionClass: "PUBLISH",
        actionType: "PUBLISH_MYBRANDOS_DRAFT",
        target: { resourceType: "mybrandos.draft", resourceId: draftId },
        parameters: {
          contentReference: title || draftId,
          contentDigest,
          destination: "mybrandos",
          visibility: "public",
        },
      },
    });
    if (proposed.authorization) {
      throw new DigiAiError(403, "AUTHORITY_INVALID", "PUBLISH must not be authorized automatically.");
    }
    const inspected = await inspectAction({
      store: input.store,
      actor: input.actor,
      caller: input.caller,
      actionIntentId: proposed.intent.actionIntentId,
    });
    return {
      stage: "propose" as const,
      actionType: "PUBLISH_MYBRANDOS_DRAFT" as const,
      operation: "mybrandos.publishDraft",
      authorityClass: "PUBLISH" as const,
      status: proposed.intent.status,
      evaluationOutcome: proposed.intent.evaluationOutcome,
      actionIntentId: proposed.intent.actionIntentId,
      draftId,
      approvedContentDigest: contentDigest,
      ceremony: inspected.ceremony,
      decisionRequest: proposed.request,
      authorizationId: null,
      hostedTrustIdPublishAuthority: false,
      subjectAuthoritySource: "AUTHENTICATED_OPERATOR_BOUND_OWNER",
      claim: "I can publish this if you approve.",
    };
  }

  if (!input.actionIntentId) {
    throw new DigiAiError(400, "invalid_request", "actionIntentId is required.");
  }

  if (input.stage === "approve") {
    const decided = await decideAction({
      store: input.store,
      actor: input.actor,
      caller: input.caller,
      actionIntentId: input.actionIntentId,
      decision: "APPROVE",
    });
    return {
      stage: "approve" as const,
      actionType: "PUBLISH_MYBRANDOS_DRAFT" as const,
      authorityClass: "PUBLISH" as const,
      actionIntentId: input.actionIntentId,
      authorizationId: decided.authorization?.authorizationId ?? null,
      issuedAt: decided.authorization?.issuedAt,
      expiresAt: decided.authorization?.expiresAt,
      authorizationStatus: decided.authorization?.status,
      hostedTrustIdPublishAuthority: false,
      subjectAuthoritySource: "AUTHENTICATED_OPERATOR_BOUND_EXPLICIT_HUMAN_APPROVAL",
      claim: "Approval recorded. Publication has not been verified yet.",
    };
  }

  if (input.stage === "reject") {
    const decided = await decideAction({
      store: input.store,
      actor: input.actor,
      caller: input.caller,
      actionIntentId: input.actionIntentId,
      decision: "DENY",
    });
    return {
      stage: "reject" as const,
      actionType: "PUBLISH_MYBRANDOS_DRAFT" as const,
      actionIntentId: input.actionIntentId,
      authorizationId: null,
      intentStatus: decided.intent.status,
      executed: false,
      published: false,
    };
  }

  const inspected = await inspectAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    actionIntentId: input.actionIntentId,
  });
  if (!inspected.authorization?.authorizationId) {
    throw new DigiAiError(403, "AUTHORITY_INVALID", "Explicit human approval is required before publish execution.");
  }
  if (input.authorizationId && input.authorizationId !== inspected.authorization.authorizationId) {
    throw new DigiAiError(403, "AUTHORITY_INVALID", "Authorization does not match the approved publish intent.");
  }
  const execution = await executeAuthorizedAction({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    actionIntentId: input.actionIntentId,
    authorizationId: inspected.authorization.authorizationId,
    allowFixture: false,
  });
  const receipt = execution.receiptId ? await input.store.getActionExecutionReceipt(execution.receiptId) : null;
  const evidence = receipt?.evidence ?? {};
  return {
    stage: "execute" as const,
    actionType: "PUBLISH_MYBRANDOS_DRAFT" as const,
    operation: "mybrandos.publishDraft",
    authorityClass: "PUBLISH" as const,
    subjectAuthoritySource: "AUTHENTICATED_OPERATOR_BOUND_EXPLICIT_HUMAN_APPROVAL",
    hostedTrustIdPublishAuthority: false,
    status: execution.status,
    receiptStatus: execution.receiptStatus,
    authorizationId: inspected.authorization.authorizationId,
    executionId: execution.executionId,
    toolInvocationId: execution.toolInvocationId,
    connectorId: execution.connectorId,
    connectionId: execution.connectionId,
    operationId: execution.operationId,
    draftId: evidence.draftId,
    publicationRef: evidence.publicationRef,
    preState: "DRAFT",
    postState: evidence.state,
    visibility: evidence.visibility,
    publishedAt: evidence.publishedAt,
    approvedContentDigest: evidence.approvedContentDigest,
    publishedContentDigest: evidence.publishedContentDigest,
    privacyTransition: evidence.privacyTransition,
    requestDigest: evidence.approvedContentDigest,
    responseDigest: evidence.responseDigest,
    idempotencyKeyRef: evidence.idempotencyKeyRef ?? execution.executionId,
    credentialRef: typeof evidence.credentialRef === "string" ? evidence.credentialRef : undefined,
    credentialExposed: false,
    published: execution.status === "SUCCEEDED",
    scheduled: false,
    claim: execution.status === "SUCCEEDED"
      ? "I published the approved draft to mybrandOS."
      : execution.status === "UNKNOWN_OUTCOME"
        ? "I couldn't yet verify whether the publication completed."
        : "Publication was not verified.",
  };
}
