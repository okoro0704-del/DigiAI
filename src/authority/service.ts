import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type {
  ActionClass,
  ActionParameters,
  ActionTarget,
  ActionType,
  AuthorityAuditEvent,
  AuthorityLimits,
  AuthorityScope,
  DecisionScope,
  DigiAiActionAuthorization,
  DigiAiActionIntent,
  DigiAiAuthorityGrant,
  DigiAiHumanDecision,
  DigiAiHumanDecisionRequest,
  HumanDecisionValue,
} from "../contracts/authority.js";
import { AUTHORITY_POLICY_ID, AUTHORITY_POLICY_VERSION, isActionClass, isActionType } from "../contracts/authority.js";
import { rejectConnectorSpoof } from "../connectors/service.js";
import { clip, newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import type { DigiAiStore } from "../store/types.js";
import { actionDigest, publicParameters } from "./digest.js";
import { evaluateAuthority } from "./evaluate.js";
import { strongestClass } from "./policy.js";

export type ProposeActionInput = {
  objectiveId?: string;
  planId?: string;
  stepId?: string;
  actionClass: ActionClass;
  additionalClasses?: ActionClass[];
  actionType: ActionType;
  target: ActionTarget;
  parameters?: ActionParameters;
  riskContext?: string;
};

export async function proposeAction(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  body: ProposeActionInput;
  now?: string;
}): Promise<{ intent: DigiAiActionIntent; decision?: ReturnType<typeof evaluateAuthority>; request?: DigiAiHumanDecisionRequest; authorization?: DigiAiActionAuthorization }> {
  rejectIdentitySpoof(input.body as unknown as Record<string, unknown>);
  if (!isActionClass(input.body.actionClass) || !isActionType(input.body.actionType)) {
    throw new DigiAiError(400, "invalid_request", "Unknown action class or type.");
  }
  if (!input.body.target?.resourceType || !input.body.target.resourceId) {
    throw new DigiAiError(400, "invalid_request", "An exact action target is required.");
  }
  if (input.body.objectiveId) {
    const objective = await ownedObjective(input.store, input.body.objectiveId, input.actor, input.caller);
    if (objective.cancelRequested) throw new DigiAiError(409, "cancelled", "A cancelled objective cannot propose actions.");
  }
  const parameters = sanitizeParameters(input.body.parameters ?? {});
  const target = { ...input.body.target, tenantId: input.actor.tenantId ?? input.body.target.tenantId };
  const digest = actionDigest({
    actionClass: strongestClass([input.body.actionClass, ...(input.body.additionalClasses ?? [])]),
    actionType: input.body.actionType,
    target,
    parameters,
  });
  const now = input.now ?? nowIso();
  const intent: DigiAiActionIntent = {
    actionIntentId: newId("aint"),
    objectiveId: input.body.objectiveId,
    planId: input.body.planId,
    stepId: input.body.stepId,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId ?? input.body.target.tenantId,
    applicationId: input.caller.id,
    actionClass: input.body.actionClass,
    additionalClasses: input.body.additionalClasses,
    actionType: input.body.actionType,
    target,
    scope: {
      actorId: input.actor.trustId,
      tenantId: input.actor.tenantId,
      applicationId: input.caller.id,
      objectiveId: input.body.objectiveId,
      actionClasses: [input.body.actionClass, ...(input.body.additionalClasses ?? [])],
      actionTypes: [input.body.actionType],
      resourceType: input.body.target.resourceType,
      resourceId: input.body.target.resourceId,
    },
    parameters,
    parametersDigest: digest,
    riskContext: input.body.riskContext,
    status: "PROPOSED",
    authorityPolicyId: AUTHORITY_POLICY_ID,
    authorityPolicyVersion: AUTHORITY_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  await input.store.putActionIntent(intent);
  await audit(input.store, { eventType: "ACTION_PROPOSED", actionIntentId: intent.actionIntentId, actorId: intent.actorId, tenantId: intent.tenantId });
  return evaluateAndPersist({ store: input.store, intent, now });
}

export async function evaluateAndPersist(input: { store: DigiAiStore; intent: DigiAiActionIntent; now?: string }) {
  const now = input.now ?? nowIso();
  const grants = await input.store.listAuthorityGrants({ actorId: input.intent.actorId, tenantId: input.intent.tenantId });
  const decisions = await input.store.listHumanDecisions(input.intent.actionIntentId);
  const decision = evaluateAuthority({ intent: input.intent, grants, decisions, now });
  input.intent.status = "EVALUATED";
  input.intent.evaluationOutcome = decision.outcome;
  input.intent.evaluationReason = decision.reasonCode;
  input.intent.updatedAt = now;
  await input.store.putActionIntent(input.intent);
  await audit(input.store, {
    eventType: "AUTHORITY_EVALUATED",
    actionIntentId: input.intent.actionIntentId,
    actorId: input.intent.actorId,
    tenantId: input.intent.tenantId,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    grantId: decision.grantId,
  });

  if (decision.outcome === "AUTHORIZED_AUTOMATICALLY" || decision.outcome === "AUTHORIZED_BY_GRANT") {
    try {
      const authorization = await issueAuthorization({
        store: input.store,
        intent: input.intent,
        source: decision.grantId ? "grant" : decision.decisionId ? "human_decision" : "automatic",
        sourceId: decision.grantId ?? decision.decisionId,
        now,
      });
      return { intent: input.intent, decision, authorization };
    } catch (err) {
      if (err instanceof DigiAiError && err.status === 409) {
        input.intent.status = "DENIED";
        input.intent.evaluationOutcome = "DENIED";
        input.intent.evaluationReason = (err.code as DigiAiActionIntent["evaluationReason"]) ?? "OCCURRENCE_LIMIT_EXCEEDED";
        input.intent.updatedAt = now;
        await input.store.putActionIntent(input.intent);
        return {
          intent: input.intent,
          decision: {
            ...decision,
            outcome: "DENIED" as const,
            reasonCode: input.intent.evaluationReason ?? "OCCURRENCE_LIMIT_EXCEEDED",
            explanation: err.message,
          },
        };
      }
      throw err;
    }
  }

  if (decision.outcome === "HUMAN_DECISION_REQUIRED") {
    const request = await createDecisionRequest(input.store, input.intent, decision.reasonCode);
    input.intent.status = "HUMAN_DECISION_REQUIRED";
    input.intent.decisionRequestId = request.decisionRequestId;
    input.intent.updatedAt = now;
    await input.store.putActionIntent(input.intent);
    if (input.intent.objectiveId) {
      const objective = await input.store.getObjective(input.intent.objectiveId);
      if (objective && !objective.cancelRequested && objective.status !== "CANCELLED" && objective.status !== "FAILED") {
        objective.status = "WAITING_FOR_HUMAN";
        objective.updatedAt = now;
        await input.store.putObjective(objective);
      }
      if (input.intent.stepId) {
        await input.store.updateStep(input.intent.stepId, { status: "WAITING_FOR_HUMAN", actionIntentId: input.intent.actionIntentId });
      }
    }
    return { intent: input.intent, decision, request };
  }

  input.intent.status = "DENIED";
  input.intent.updatedAt = now;
  await input.store.putActionIntent(input.intent);
  if (input.intent.stepId) {
    await input.store.updateStep(input.intent.stepId, { status: "FAILED", error: decision.reasonCode, actionIntentId: input.intent.actionIntentId, completedAt: now });
  }
  return { intent: input.intent, decision };
}

export async function decideAction(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  actionIntentId: string;
  decision: HumanDecisionValue;
  scope?: DecisionScope;
  expiresAt?: string;
  now?: string;
}) {
  const intent = await ownedIntent(input.store, input.actionIntentId, input.actor, input.caller);
  const now = input.now ?? nowIso();
  const currentDigest = actionDigest({
    actionClass: strongestClass([intent.actionClass, ...(intent.additionalClasses ?? [])]),
    actionType: intent.actionType,
    target: intent.target,
    parameters: intent.parameters,
  });
  if (currentDigest !== intent.parametersDigest) {
    throw new DigiAiError(409, "action_digest_changed", "The action changed after it was proposed. A new decision is required.");
  }
  const row: DigiAiHumanDecision = {
    decisionId: newId("adec"),
    actionIntentId: intent.actionIntentId,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId ?? intent.tenantId,
    decision: input.decision,
    scope: input.scope ?? "THIS_ACTION",
    actionDigest: currentDigest,
    expiresAt: input.expiresAt,
    createdAt: now,
  };
  await input.store.putHumanDecision(row);
  await audit(input.store, {
    eventType: input.decision === "APPROVE" ? "HUMAN_APPROVED" : "HUMAN_DENIED",
    actionIntentId: intent.actionIntentId,
    actorId: row.actorId,
    tenantId: row.tenantId,
    reasonCode: input.decision === "APPROVE" ? "HUMAN_APPROVED_EXACT_ACTION" : "AUTHORITY_UNPROVEN",
  });
  if (input.decision === "DENY") {
    intent.status = "DENIED";
    intent.evaluationOutcome = "DENIED";
    intent.evaluationReason = "AUTHORITY_UNPROVEN";
    intent.updatedAt = now;
    await input.store.putActionIntent(intent);
    if (intent.stepId) {
      await input.store.updateStep(intent.stepId, { status: "FAILED", error: "human_denied", completedAt: now });
    }
    if (intent.objectiveId) {
      const objective = await input.store.getObjective(intent.objectiveId);
      const steps = await input.store.listSteps(intent.objectiveId);
      if (objective) {
        const requiredFailed = steps.some((item) => item.required && item.status === "FAILED");
        const optionalFailed = steps.some((item) => !item.required && item.status === "FAILED");
        const requiredDone = steps.filter((item) => item.required).every((item) => item.status === "COMPLETED");
        objective.status = requiredFailed ? "FAILED" : requiredDone && optionalFailed ? "PARTIAL" : "FAILED";
        objective.updatedAt = now;
        await input.store.putObjective(objective);
      }
    }
    return { intent, decision: row };
  }
  const issued = await issueAuthorization({
    store: input.store,
    intent,
    source: "human_decision",
    sourceId: row.decisionId,
    now,
    expiresAt: input.expiresAt,
  });
  return { intent, decision: row, authorization: issued };
}

export async function createGrant(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  scope?: AuthorityScope;
  allowedActionClasses: ActionClass[];
  allowedActionTypes?: ActionType[];
  resourceConstraints?: { resourceType?: string; resourceId?: string };
  objectiveConstraint?: string;
  applicationConstraint?: string;
  limits?: AuthorityLimits;
  effectiveFrom?: string;
  expiresAt?: string;
}) {
  rejectIdentitySpoof(input as unknown as Record<string, unknown>);
  if (!input.allowedActionClasses?.length || input.allowedActionClasses.some((row) => !isActionClass(row))) {
    throw new DigiAiError(400, "invalid_request", "A bounded set of allowed action classes is required.");
  }
  const now = nowIso();
  const grant: DigiAiAuthorityGrant = {
    grantId: newId("agrn"),
    grantorActorId: input.actor.trustId,
    tenantId: input.actor.tenantId ?? input.scope?.tenantId,
    delegate: "digi-ai",
    scope: {
      ...input.scope,
      actorId: input.actor.trustId,
      tenantId: input.actor.tenantId ?? input.scope?.tenantId,
      applicationId: input.applicationConstraint ?? input.caller.id,
      objectiveId: input.objectiveConstraint ?? input.scope?.objectiveId,
      actionClasses: input.allowedActionClasses,
      actionTypes: input.allowedActionTypes,
      resourceType: input.resourceConstraints?.resourceType ?? input.scope?.resourceType,
      resourceId: input.resourceConstraints?.resourceId ?? input.scope?.resourceId,
    },
    allowedActionClasses: input.allowedActionClasses,
    allowedActionTypes: input.allowedActionTypes,
    resourceConstraints: input.resourceConstraints,
    objectiveConstraint: input.objectiveConstraint,
    applicationConstraint: input.applicationConstraint ?? input.caller.id,
    limits: input.limits ?? {},
    effectiveFrom: input.effectiveFrom ?? now,
    expiresAt: input.expiresAt,
    status: "active",
    consumedOccurrences: 0,
    policyId: AUTHORITY_POLICY_ID,
    policyVersion: AUTHORITY_POLICY_VERSION,
    createdAt: now,
  };
  await input.store.putAuthorityGrant(grant);
  await audit(input.store, { eventType: "GRANT_CREATED", grantId: grant.grantId, actorId: grant.grantorActorId, tenantId: grant.tenantId, policyVersion: grant.policyVersion });
  return grant;
}

export async function revokeGrant(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; grantId: string }) {
  const grant = await ownedGrant(input.store, input.grantId, input.actor, input.caller);
  const now = nowIso();
  grant.status = "revoked";
  grant.revokedAt = now;
  await input.store.putAuthorityGrant(grant);
  await audit(input.store, { eventType: "GRANT_REVOKED", grantId: grant.grantId, actorId: input.actor.trustId, tenantId: grant.tenantId });
  return grant;
}

export async function inspectAction(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; actionIntentId: string }) {
  const intent = await ownedIntent(input.store, input.actionIntentId, input.actor, input.caller);
  const authorization = intent.authorizationId ? await input.store.getActionAuthorization(intent.authorizationId) : null;
  const request = intent.decisionRequestId ? await input.store.getDecisionRequest(intent.decisionRequestId) : null;
  return { intent: sanitizeIntent(intent), authorization: authorization ? sanitizeAuthorization(authorization) : null, decisionRequest: request };
}

export async function inspectGrant(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; grantId: string }) {
  return ownedGrant(input.store, input.grantId, input.actor, input.caller);
}

export async function consumeAuthorization(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; authorizationId: string; now?: string }) {
  return input.store.consumeActionAuthorization({
    authorizationId: input.authorizationId,
    actorId: input.actor.trustId,
    applicationId: input.caller.id,
    tenantId: input.actor.tenantId,
    now: input.now ?? nowIso(),
  });
}

export async function invalidateObjectiveAuthorizations(store: DigiAiStore, objectiveId: string, actorId: string) {
  const intents = await store.listActionIntents(objectiveId);
  const now = nowIso();
  for (const intent of intents) {
    if (!intent.authorizationId) continue;
    const auth = await store.getActionAuthorization(intent.authorizationId);
    if (!auth || auth.status !== "issued") continue;
    auth.status = "invalidated";
    await store.putActionAuthorization(auth);
    await audit(store, {
      eventType: "AUTHORIZATION_INVALIDATED",
      actionIntentId: intent.actionIntentId,
      authorizationId: auth.authorizationId,
      actorId,
    });
    void now;
  }
}

export async function issueAuthorization(input: {
  store: DigiAiStore;
  intent: DigiAiActionIntent;
  source: DigiAiActionAuthorization["authoritySource"];
  sourceId?: string;
  now: string;
  expiresAt?: string;
}) {
  if (input.source === "grant" && input.sourceId) {
    const reserved = await input.store.reserveGrantOccurrence(input.sourceId, input.now);
    if (!reserved.ok) {
      input.intent.status = "DENIED";
      input.intent.evaluationOutcome = reserved.outcome;
      input.intent.evaluationReason = reserved.reason;
      input.intent.updatedAt = input.now;
      await input.store.putActionIntent(input.intent);
      throw new DigiAiError(409, reserved.reason, reserved.message);
    }
  }
  const authorization: DigiAiActionAuthorization = {
    authorizationId: newId("aauth"),
    actionIntentId: input.intent.actionIntentId,
    actorId: input.intent.actorId,
    tenantId: input.intent.tenantId,
    applicationId: input.intent.applicationId,
    actionDigest: input.intent.parametersDigest,
    authoritySource: input.source,
    authoritySourceId: input.sourceId,
    policyId: input.intent.authorityPolicyId,
    policyVersion: input.intent.authorityPolicyVersion,
    issuedAt: input.now,
    expiresAt: input.expiresAt,
    status: "issued",
  };
  await input.store.putActionAuthorization(authorization);
  input.intent.status = "AUTHORIZED";
  input.intent.authorizationId = authorization.authorizationId;
  input.intent.evaluationOutcome = input.source === "automatic" ? "AUTHORIZED_AUTOMATICALLY" : "AUTHORIZED_BY_GRANT";
  input.intent.updatedAt = input.now;
  await input.store.putActionIntent(input.intent);
  if (input.intent.stepId) {
    await input.store.updateStep(input.intent.stepId, {
      actionIntentId: input.intent.actionIntentId,
      authorizationId: authorization.authorizationId,
    });
  }
  await audit(input.store, {
    eventType: "AUTHORIZATION_ISSUED",
    actionIntentId: input.intent.actionIntentId,
    authorizationId: authorization.authorizationId,
    grantId: input.source === "grant" ? input.sourceId : undefined,
    actorId: input.intent.actorId,
    tenantId: input.intent.tenantId,
    policyVersion: authorization.policyVersion,
  });
  return authorization;
}

async function createDecisionRequest(store: DigiAiStore, intent: DigiAiActionIntent, reason: DigiAiActionIntent["evaluationReason"]) {
  const strongest = strongestClass([intent.actionClass, ...(intent.additionalClasses ?? [])]);
  const request: DigiAiHumanDecisionRequest = {
    decisionRequestId: newId("adreq"),
    actionIntentId: intent.actionIntentId,
    summary: decisionSummary(intent),
    actionClass: strongest,
    actionType: intent.actionType,
    targetSummary: `${intent.target.resourceType}:${intent.target.resourceId}`,
    materialParameters: publicParameters(strongest, intent.parameters),
    reasonCode: reason ?? "ACTION_REQUIRES_HUMAN",
    createdAt: nowIso(),
  };
  await store.putDecisionRequest(request);
  await audit(store, { eventType: "HUMAN_DECISION_REQUESTED", actionIntentId: intent.actionIntentId, actorId: intent.actorId, reasonCode: request.reasonCode });
  return request;
}

function decisionSummary(intent: DigiAiActionIntent): string {
  const strongest = strongestClass([intent.actionClass, ...(intent.additionalClasses ?? [])]);
  if (strongest === "PUBLISH") {
    return `Publish ${intent.parameters.contentReference ?? "content"} to ${intent.parameters.destination ?? intent.target.resourceId} as ${intent.parameters.visibility ?? "specified visibility"}.`;
  }
  if (strongest === "MESSAGE") {
    return `Send a message to ${intent.parameters.conversationId ?? intent.parameters.recipient ?? intent.target.resourceId}.`;
  }
  if (strongest === "SPEND") {
    return `Commit ${intent.parameters.amount ?? "?"} ${intent.parameters.currency ?? intent.parameters.valueAsset ?? ""} for ${intent.target.resourceId}. No money is moved in this phase.`;
  }
  if (strongest === "DEPLOY") {
    return `Deploy artifact ${intent.parameters.artifact ?? "unknown"} to ${intent.parameters.environment ?? "unknown"} on ${intent.parameters.service ?? intent.target.resourceId}. No deployment occurs in this phase.`;
  }
  if (strongest === "DELETE") {
    return `Delete ${intent.target.resourceType} ${intent.target.resourceId}. No deletion occurs in this phase.`;
  }
  if (strongest === "CHANGE") {
    return `Change ${intent.target.resourceType} ${intent.target.resourceId}.`;
  }
  return `Perform ${strongest} ${intent.actionType} on ${intent.target.resourceType} ${intent.target.resourceId}.`;
}

function sanitizeParameters(raw: ActionParameters): ActionParameters {
  return {
    contentReference: clip(String(raw.contentReference ?? ""), 200) || undefined,
    contentDigest: raw.contentDigest,
    destination: raw.destination,
    visibility: raw.visibility,
    recipient: raw.recipient,
    conversationId: raw.conversationId,
    messageDigest: raw.messageDigest,
    messagePreview: raw.messagePreview ? clip(raw.messagePreview, 160) : undefined,
    amount: typeof raw.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : undefined,
    currency: raw.currency,
    valueAsset: raw.valueAsset,
    artifact: raw.artifact,
    environment: raw.environment,
    service: raw.service,
    resourceType: raw.resourceType,
    resourceId: raw.resourceId,
  };
}

export function rejectIdentitySpoof(body: Record<string, unknown>) {
  if ("applicationId" in body || "actorId" in body || "grantorActorId" in body || "ownerId" in body || "tenantId" in body) {
    throw new DigiAiError(400, "invalid_request", "Identity fields are reserved to Digi AI.");
  }
}

export function sanitizeIntent(intent: DigiAiActionIntent) {
  return {
    actionIntentId: intent.actionIntentId,
    objectiveId: intent.objectiveId,
    stepId: intent.stepId,
    actionClass: intent.actionClass,
    additionalClasses: intent.additionalClasses,
    actionType: intent.actionType,
    target: intent.target,
    parameters: publicParameters(intent.actionClass, intent.parameters),
    parametersDigest: intent.parametersDigest,
    status: intent.status,
    evaluationOutcome: intent.evaluationOutcome,
    evaluationReason: intent.evaluationReason,
    authorityPolicyVersion: intent.authorityPolicyVersion,
    authorizationId: intent.authorizationId,
    createdAt: intent.createdAt,
  };
}

function sanitizeAuthorization(row: DigiAiActionAuthorization) {
  return {
    authorizationId: row.authorizationId,
    actionIntentId: row.actionIntentId,
    actionDigest: row.actionDigest,
    authoritySource: row.authoritySource,
    policyVersion: row.policyVersion,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  };
}

async function ownedObjective(store: DigiAiStore, objectiveId: string, actor: ActorContext, caller: CallerApplication) {
  const row = await store.getObjective(objectiveId);
  if (!row) throw new DigiAiError(404, "not_found", "Objective was not found.");
  if (row.actorId !== actor.trustId || row.applicationId !== caller.id) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That objective is not visible to this caller.");
  }
  return row;
}

async function ownedIntent(store: DigiAiStore, actionIntentId: string, actor: ActorContext, caller: CallerApplication) {
  const row = await store.getActionIntent(actionIntentId);
  if (!row) throw new DigiAiError(404, "not_found", "Action intent was not found.");
  if (row.actorId !== actor.trustId || row.applicationId !== caller.id) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That action is not visible to this caller.");
  }
  if (row.tenantId && actor.tenantId && row.tenantId !== actor.tenantId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That action is not visible to this tenant.");
  }
  return row;
}

async function ownedGrant(store: DigiAiStore, grantId: string, actor: ActorContext, caller: CallerApplication) {
  const row = await store.getAuthorityGrant(grantId);
  if (!row) throw new DigiAiError(404, "not_found", "Authority grant was not found.");
  if (row.grantorActorId !== actor.trustId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That grant is not visible to this caller.");
  }
  if (row.tenantId && actor.tenantId && row.tenantId !== actor.tenantId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That grant is not visible to this tenant.");
  }
  if (row.applicationConstraint && row.applicationConstraint !== caller.id) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That grant is not visible to this application.");
  }
  return row;
}

async function audit(store: DigiAiStore, event: Omit<AuthorityAuditEvent, "eventId" | "createdAt">) {
  await store.appendAuthorityAudit({
    ...event,
    eventId: newId("aaud"),
    createdAt: nowIso(),
  });
}

export function parseActionBody(raw: unknown): ProposeActionInput {
  if (!raw || typeof raw !== "object") throw new DigiAiError(400, "invalid_request", "JSON body is required.");
  const body = raw as Record<string, unknown>;
  rejectIdentitySpoof(body);
  rejectConnectorSpoof(body);
  if ("provider" in body || "model" in body) throw new DigiAiError(400, "invalid_request", "Provider and model selection is reserved to Digi AI.");
  const target = body.target && typeof body.target === "object" ? (body.target as ActionTarget) : undefined;
  if (!isActionClass(body.actionClass) || !isActionType(body.actionType) || !target) {
    throw new DigiAiError(400, "invalid_request", "actionClass, actionType, and target are required.");
  }
  return {
    objectiveId: typeof body.objectiveId === "string" ? body.objectiveId : undefined,
    planId: typeof body.planId === "string" ? body.planId : undefined,
    stepId: typeof body.stepId === "string" ? body.stepId : undefined,
    actionClass: body.actionClass,
    additionalClasses: Array.isArray(body.additionalClasses) ? body.additionalClasses.filter(isActionClass) : undefined,
    actionType: body.actionType,
    target,
    parameters: body.parameters && typeof body.parameters === "object" ? (body.parameters as ActionParameters) : undefined,
    riskContext: typeof body.riskContext === "string" ? body.riskContext : undefined,
  };
}

export function parseGrantBody(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new DigiAiError(400, "invalid_request", "JSON body is required.");
  const body = raw as Record<string, unknown>;
  rejectIdentitySpoof(body);
  const classes = Array.isArray(body.allowedActionClasses) ? body.allowedActionClasses.filter(isActionClass) : [];
  if (!classes.length) throw new DigiAiError(400, "invalid_request", "allowedActionClasses is required.");
  return {
    allowedActionClasses: classes,
    allowedActionTypes: Array.isArray(body.allowedActionTypes) ? body.allowedActionTypes.filter(isActionType) : undefined,
    resourceConstraints: body.resourceConstraints && typeof body.resourceConstraints === "object" ? (body.resourceConstraints as { resourceType?: string; resourceId?: string }) : undefined,
    objectiveConstraint: typeof body.objectiveConstraint === "string" ? body.objectiveConstraint : undefined,
    applicationConstraint: undefined,
    limits: body.limits && typeof body.limits === "object" ? (body.limits as AuthorityLimits) : undefined,
    effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    scope: body.scope && typeof body.scope === "object" ? (body.scope as AuthorityScope) : undefined,
  };
}

export function parseDecisionBody(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new DigiAiError(400, "invalid_request", "JSON body is required.");
  const body = raw as Record<string, unknown>;
  rejectIdentitySpoof(body);
  if (body.decision !== "APPROVE" && body.decision !== "DENY") {
    throw new DigiAiError(400, "invalid_request", "decision must be APPROVE or DENY.");
  }
  return {
    decision: body.decision as HumanDecisionValue,
    scope: body.scope === "OBJECTIVE" || body.scope === "BOUNDED_GRANT" ? body.scope : "THIS_ACTION" as DecisionScope,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
  };
}
