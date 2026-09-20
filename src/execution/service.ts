import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { ActionParameters } from "../contracts/authority.js";
import {
  ACTION_SCHEMA_VERSION,
  isFixtureActionType,
  isFixtureMode,
  type DigiAiActionExecution,
  type DigiAiActionExecutionReceipt,
  type DigiAiActionExecutionRequest,
  type ExecutionAuditEvent,
  type FixtureMode,
} from "../contracts/execution.js";
import { actionDigest } from "../authority/digest.js";
import { strongestClass } from "../authority/policy.js";
import { clip, newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import type { DigiAiStore } from "../store/types.js";
import { rejectConnectorSpoof } from "../connectors/service.js";
import { resolveExecutor } from "./registry.js";
import { validateActionParameters } from "./validate.js";

export async function executeAuthorizedAction(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  actionIntentId: string;
  authorizationId?: string;
  parameters?: ActionParameters;
  idempotencyKey?: string;
  fixtureMode?: FixtureMode;
  allowFixture: boolean;
  deferInvocation?: boolean;
  selectionId?: string;
  now?: string;
}) {
  const now = input.now ?? nowIso();
  const intent = await ownedIntent(input.store, input.actionIntentId, input.actor, input.caller);
  const authorizationId = input.authorizationId ?? intent.authorizationId;
  if (!authorizationId) throw new DigiAiError(403, "AUTHORITY_INVALID", "No action authorization exists.");
  const authorization = await input.store.getActionAuthorization(authorizationId);
  if (!authorization) throw new DigiAiError(403, "AUTHORITY_INVALID", "Action authorization was not found.");
  assertAuthorizationOwnership(authorization, input.actor, input.caller);
  if (authorization.actionIntentId !== intent.actionIntentId) throw new DigiAiError(403, "AUTHORITY_INVALID", "Authorization does not match the action intent.");
  if (authorization.expiresAt && authorization.expiresAt <= now) throw new DigiAiError(403, "AUTHORIZATION_EXPIRED", "Authorization has expired.");
  if (authorization.status === "invalidated") throw new DigiAiError(403, "AUTHORITY_INVALID", "Authorization is no longer valid.");
  if (authorization.status === "issued" && authorization.authoritySource === "grant" && authorization.authoritySourceId) {
    const grant = await input.store.getAuthorityGrant(authorization.authoritySourceId);
    if (!grant || grant.status === "revoked" || grant.revokedAt) {
      throw new DigiAiError(403, "AUTHORITY_INVALID", "Covering grant was revoked before the authorization was claimed.");
    }
    if (grant.expiresAt && grant.expiresAt <= now) {
      throw new DigiAiError(403, "AUTHORIZATION_EXPIRED", "Covering grant has expired.");
    }
  }
  if (authorization.status === "consumed") {
    const existing = await input.store.getExecutionByAuthorization(authorization.authorizationId);
    if (existing) return inspectSafe(existing, await receiptOf(input.store, existing));
    throw new DigiAiError(409, "AUTHORIZATION_CONSUMED", "Authorization has already been consumed.");
  }
  const parameters = input.parameters ?? intent.parameters;
  const digest = actionDigest({
    actionClass: strongestClass([intent.actionClass, ...(intent.additionalClasses ?? [])]),
    actionType: intent.actionType,
    target: intent.target,
    parameters,
  });
  if (digest !== intent.parametersDigest || digest !== authorization.actionDigest) {
    throw new DigiAiError(403, "PARAMETER_MISMATCH", "Execution parameters do not match the authorized action digest.");
  }
  if (intent.objectiveId) {
    const objective = await input.store.getObjective(intent.objectiveId);
    if (!objective || objective.cancelRequested || objective.status === "CANCELLED") {
      throw new DigiAiError(409, "cancelled", "The objective does not permit execution.");
    }
  }
  if (!isFixtureActionType(intent.actionType)) {
    throw new DigiAiError(409, "EXECUTOR_NOT_FOUND", "Real external executors are not enabled.");
  }
  if (!input.allowFixture) throw new DigiAiError(403, "fixture_forbidden", "Fixture action execution is isolated from ordinary production callers.");
  validateActionParameters(intent.actionType, intent.actionClass, parameters);
  const executor = resolveExecutor(intent.actionType);
  if (!executor) throw new DigiAiError(404, "EXECUTOR_NOT_FOUND", "No registered executor exists for that action type.");

  const idempotencyKey = input.idempotencyKey ?? `${authorization.authorizationId}:${intent.actionIntentId}`;
  const existing = (await input.store.findExecutionByIdempotency(input.caller.id, input.actor.trustId, idempotencyKey))
    ?? (await input.store.getExecutionByAuthorization(authorization.authorizationId));
  if (existing) {
    if (existing.status === "SUCCEEDED" || existing.status === "FAILED" || existing.status === "CANCELLED" || existing.status === "UNKNOWN_OUTCOME" || existing.status === "WAITING") {
      return inspectSafe(existing, await receiptOf(input.store, existing));
    }
    return invokeIfNeeded({ store: input.store, execution: existing, actor: input.actor, caller: input.caller, now });
  }

  const executionId = newId("aex");
  const request: DigiAiActionExecutionRequest = {
    executionRequestId: newId("aexq"),
    actionIntentId: intent.actionIntentId,
    authorizationId: authorization.authorizationId,
    objectiveId: intent.objectiveId,
    planId: intent.planId,
    stepId: intent.stepId,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId ?? intent.tenantId,
    applicationId: input.caller.id,
    actionClass: intent.actionClass,
    actionType: intent.actionType,
    target: intent.target,
    parameters,
    parametersDigest: digest,
    idempotencyKey,
    createdAt: now,
  };
  const execution: DigiAiActionExecution = {
    executionId,
    executionRequestId: request.executionRequestId,
    actionIntentId: intent.actionIntentId,
    authorizationId: authorization.authorizationId,
    objectiveId: intent.objectiveId,
    stepId: intent.stepId,
    actorId: request.actorId,
    tenantId: request.tenantId,
    applicationId: request.applicationId,
    executorId: executor.executorId,
    executorVersion: executor.version,
    actionClass: intent.actionClass,
    actionType: intent.actionType,
    target: intent.target,
    parameters,
    parametersDigest: digest,
    actionSchemaVersion: ACTION_SCHEMA_VERSION,
    status: "PENDING",
    attemptCount: 0,
    externalIdempotencyKey: executionId,
    fixtureMode: input.allowFixture && isFixtureMode(input.fixtureMode) ? input.fixtureMode : "SUCCESS",
    connectionSelectionId: input.selectionId,
    createdAt: now,
    updatedAt: now,
  };
  await input.store.putActionExecutionRequest(request);
  await audit(input.store, { eventType: "EXECUTION_REQUESTED", executionId, actionIntentId: intent.actionIntentId, authorizationId: authorization.authorizationId, actorId: request.actorId, tenantId: request.tenantId });
  const claimed = await input.store.claimActionAuthorization({
    authorizationId: authorization.authorizationId,
    actorId: input.actor.trustId,
    applicationId: input.caller.id,
    tenantId: input.actor.tenantId,
    now,
    execution,
  });
  await audit(input.store, { eventType: "AUTHORIZATION_CLAIMED", executionId: claimed.execution.executionId, authorizationId: authorization.authorizationId, actorId: request.actorId });
  await audit(input.store, { eventType: "EXECUTOR_RESOLVED", executionId: claimed.execution.executionId, status: claimed.execution.status });
  if (input.deferInvocation) return inspectSafe(claimed.execution);
  return invokeIfNeeded({ store: input.store, execution: claimed.execution, actor: input.actor, caller: input.caller, now });
}

export async function advanceExecution(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; executionId: string; now?: string }) {
  const execution = await ownedExecution(input.store, input.executionId, input.actor, input.caller);
  if (execution.status === "SUCCEEDED" || execution.status === "FAILED" || execution.status === "CANCELLED") {
    return inspectSafe(execution, await receiptOf(input.store, execution));
  }
  if (execution.status === "UNKNOWN_OUTCOME") {
    return inspectSafe(execution, await receiptOf(input.store, execution));
  }
  return invokeIfNeeded({ store: input.store, execution, actor: input.actor, caller: input.caller, now: input.now ?? nowIso(), resume: execution.status === "WAITING" || Boolean(execution.submittedAt) });
}

export async function cancelExecution(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; executionId: string }) {
  const execution = await ownedExecution(input.store, input.executionId, input.actor, input.caller);
  if (execution.status === "SUCCEEDED") return inspectSafe(execution, await receiptOf(input.store, execution));
  if (execution.status === "FAILED" || execution.status === "CANCELLED" || execution.status === "UNKNOWN_OUTCOME") {
    return inspectSafe(execution, await receiptOf(input.store, execution));
  }
  if (execution.submittedAt || execution.status === "WAITING" || execution.status === "RUNNING") {
    return inspectSafe(execution, await receiptOf(input.store, execution));
  }
  execution.status = "CANCELLED";
  execution.failureCode = "CANCELLED_BEFORE_SUBMISSION";
  execution.completedAt = nowIso();
  execution.updatedAt = execution.completedAt;
  await input.store.putActionExecution(execution);
  await input.store.consumeActionAuthorization({
    authorizationId: execution.authorizationId,
    actorId: input.actor.trustId,
    applicationId: input.caller.id,
    tenantId: input.actor.tenantId,
    now: execution.completedAt,
  }).catch(() => undefined);
  await audit(input.store, { eventType: "EXECUTION_CANCELLED", executionId: execution.executionId, actorId: execution.actorId });
  return inspectSafe(execution);
}

export async function reconcileExecution(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; executionId: string }) {
  const execution = await ownedExecution(input.store, input.executionId, input.actor, input.caller);
  if (execution.status !== "UNKNOWN_OUTCOME" && execution.status !== "WAITING") {
    return inspectSafe(execution, await receiptOf(input.store, execution));
  }
  const executor = resolveExecutor(execution.actionType);
  if (!executor) throw new DigiAiError(404, "EXECUTOR_NOT_FOUND", "No registered executor exists for that action type.");
  const result = await executor.reconcile({
    executionId: execution.executionId,
    externalIdempotencyKey: execution.externalIdempotencyKey,
    actionType: execution.actionType,
    actionClass: execution.actionClass,
    parameters: execution.parameters,
    target: execution.target,
    existingExternalReference: execution.externalReference,
    fixtureMode: execution.fixtureMode,
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    execution,
    reconcile: true,
  });
  return persistOutcome({ store: input.store, execution, result, actor: input.actor, reconciled: true });
}

export async function inspectExecution(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; executionId: string }) {
  const execution = await ownedExecution(input.store, input.executionId, input.actor, input.caller);
  return inspectSafe(execution, await receiptOf(input.store, execution));
}

async function invokeIfNeeded(input: { store: DigiAiStore; execution: DigiAiActionExecution; actor: ActorContext; caller: CallerApplication; now: string; resume?: boolean }) {
  let execution = input.execution;
  if (execution.status === "UNKNOWN_OUTCOME" && !input.resume) return inspectSafe(execution, await receiptOf(input.store, execution));
  const authorization = await input.store.getActionAuthorization(execution.authorizationId);
  if (authorization && (authorization.status === "invalidated" || authorization.status === "expired") && !execution.submittedAt) {
    execution.status = "CANCELLED";
    execution.failureCode = "AUTHORITY_INVALID";
    execution.completedAt = input.now;
    execution.updatedAt = input.now;
    await input.store.putActionExecution(execution);
    await audit(input.store, { eventType: "EXECUTION_CANCELLED", executionId: execution.executionId, status: "CANCELLED" });
    return inspectSafe(execution);
  }
  const executor = resolveExecutor(execution.actionType);
  if (!executor) throw new DigiAiError(404, "EXECUTOR_NOT_FOUND", "No registered executor exists for that action type.");
  if (execution.submittedAt && execution.status === "WAITING" && !input.resume) {
    return inspectSafe(execution, await receiptOf(input.store, execution));
  }
  const started = await input.store.beginActionExecution(execution.executionId, input.now, { resume: input.resume });
  execution = started.execution;
  if (!started.invoke) return inspectSafe(execution, await receiptOf(input.store, execution));
  await audit(input.store, { eventType: "EXECUTION_STARTED", executionId: execution.executionId, status: "RUNNING" });
  const resume = Boolean(input.resume || execution.submittedAt);
  const result = resume
    ? await executor.resume({
        executionId: execution.executionId,
        externalIdempotencyKey: execution.externalIdempotencyKey,
        actionType: execution.actionType,
        actionClass: execution.actionClass,
        parameters: execution.parameters,
        target: execution.target,
        fixtureMode: execution.fixtureMode,
        resume: true,
        existingExternalReference: execution.externalReference,
        store: input.store,
        actor: input.actor,
        caller: input.caller,
        execution,
      })
    : await executor.execute({
        executionId: execution.executionId,
        externalIdempotencyKey: execution.externalIdempotencyKey,
        actionType: execution.actionType,
        actionClass: execution.actionClass,
        parameters: execution.parameters,
        target: execution.target,
        fixtureMode: execution.fixtureMode,
        store: input.store,
        actor: input.actor,
        caller: input.caller,
        execution,
      });
  return persistOutcome({ store: input.store, execution, result, actor: input.actor });
}

async function persistOutcome(input: {
  store: DigiAiStore;
  execution: DigiAiActionExecution;
  result: Awaited<ReturnType<NonNullable<ReturnType<typeof resolveExecutor>>["execute"]>>;
  actor: ActorContext;
  reconciled?: boolean;
}) {
  const now = nowIso();
  const execution = input.execution;
  const tool = await input.store.getToolInvocationByExecution(execution.executionId);
  if (tool) {
    execution.toolInvocationId = tool.toolInvocationId;
    execution.connectorId = tool.connectorId;
    execution.operationId = tool.operationId;
  }
  if (input.result.submitted) execution.submittedAt = execution.submittedAt ?? now;
  execution.externalReference = input.result.externalReference ?? execution.externalReference;
  execution.resultReference = input.result.resultReference ?? execution.resultReference;
  execution.updatedAt = now;
  if (input.result.outcome === "WAITING") {
    execution.status = "WAITING";
    execution.failureCode = "SUBMITTED_WAITING";
    await input.store.putActionExecution(execution);
    const receipt = await writeReceipt(input.store, execution, "WAITING", input.result.evidence);
    await audit(input.store, { eventType: "EXECUTION_WAITING", executionId: execution.executionId, status: "WAITING" });
    await syncStep(input.store, execution, "WAITING_FOR_ACTION");
    return inspectSafe(execution, receipt);
  }
  if (input.result.outcome === "UNKNOWN_OUTCOME") {
    execution.status = "UNKNOWN_OUTCOME";
    execution.failureCode = "UNKNOWN_REMOTE_OUTCOME";
    execution.completedAt = now;
    await input.store.putActionExecution(execution);
    await consumeQuiet(input.store, execution, input.actor, now);
    const receipt = await writeReceipt(input.store, execution, "UNKNOWN_OUTCOME", input.result.evidence);
    await audit(input.store, { eventType: input.reconciled ? "EXECUTION_RECONCILED" : "EXECUTION_UNKNOWN", executionId: execution.executionId, status: "UNKNOWN_OUTCOME" });
    await syncStep(input.store, execution, "UNKNOWN_ACTION_OUTCOME");
    return inspectSafe(execution, receipt);
  }
  if (input.result.outcome === "SUCCEEDED") {
    execution.status = "SUCCEEDED";
    execution.completedAt = now;
    await input.store.putActionExecution(execution);
    await consumeQuiet(input.store, execution, input.actor, now);
    const receipt = await writeReceipt(input.store, execution, "SUCCEEDED", input.result.evidence);
    await audit(input.store, { eventType: input.reconciled ? "EXECUTION_RECONCILED" : "EXECUTION_SUCCEEDED", executionId: execution.executionId, status: "SUCCEEDED" });
    await syncStep(input.store, execution, "COMPLETED", receipt);
    return inspectSafe(execution, receipt);
  }
  execution.status = "FAILED";
  execution.failureCode = input.result.failureCode === "TRANSIENT_BEFORE_SUBMISSION" ? "TRANSIENT_BEFORE_SUBMISSION" : "REMOTE_FAILED";
  execution.completedAt = now;
  await input.store.putActionExecution(execution);
  if (input.result.submitted) await consumeQuiet(input.store, execution, input.actor, now);
  const receipt = execution.submittedAt ? await writeReceipt(input.store, execution, "FAILED", input.result.evidence) : undefined;
  await audit(input.store, { eventType: "EXECUTION_FAILED", executionId: execution.executionId, status: "FAILED" });
  await syncStep(input.store, execution, "FAILED");
  return inspectSafe(execution, receipt);
}

async function writeReceipt(store: DigiAiStore, execution: DigiAiActionExecution, status: DigiAiActionExecutionReceipt["status"], evidence?: Record<string, string>) {
  const receipt: DigiAiActionExecutionReceipt = {
    receiptId: execution.receiptId ?? newId("aexr"),
    executionId: execution.executionId,
    actionIntentId: execution.actionIntentId,
    authorizationId: execution.authorizationId,
    executorId: execution.executorId,
    executorVersion: execution.executorVersion,
    actionClass: execution.actionClass,
    actionType: execution.actionType,
    targetDigest: clip(`${execution.target.resourceType}:${execution.target.resourceId}`, 120),
    parametersDigest: execution.parametersDigest,
    status,
    externalReference: execution.externalReference,
    resultReference: execution.resultReference,
    evidence,
    submittedAt: execution.submittedAt,
    resolvedAt: status === "WAITING" ? undefined : execution.completedAt,
    createdAt: nowIso(),
  };
  execution.receiptId = receipt.receiptId;
  await store.putActionExecution(execution);
  await store.putActionExecutionReceipt(receipt);
  return receipt;
}

async function syncStep(store: DigiAiStore, execution: DigiAiActionExecution, status: "COMPLETED" | "FAILED" | "WAITING_FOR_ACTION" | "UNKNOWN_ACTION_OUTCOME", receipt?: DigiAiActionExecutionReceipt) {
  if (!execution.stepId) return;
  await store.updateStep(execution.stepId, {
    status,
    authorizationId: execution.authorizationId,
    actionIntentId: execution.actionIntentId,
    completedAt: status === "COMPLETED" || status === "FAILED" ? execution.completedAt : undefined,
    error: status === "FAILED" ? execution.failureCode : undefined,
    output: status === "COMPLETED" && receipt
      ? {
          name: "actionResult",
          kind: "STRUCTURED_DATA",
          data: { executionId: execution.executionId, receiptId: receipt.receiptId, executed: true, fixture: true, reference: receipt.resultReference },
          generated: false,
          retrieved: false,
          stepId: execution.stepId,
          capability: "ACTION",
        }
      : undefined,
  });
  if (!execution.objectiveId) return;
  const objective = await store.getObjective(execution.objectiveId);
  const steps = await store.listSteps(execution.objectiveId);
  if (!objective) return;
  if (status === "UNKNOWN_ACTION_OUTCOME") objective.status = "UNKNOWN_ACTION_OUTCOME";
  else if (status === "WAITING_FOR_ACTION") objective.status = "WAITING_FOR_ACTION";
  else if (steps.some((row) => row.required && row.status === "FAILED")) objective.status = "FAILED";
  else if (steps.filter((row) => row.required).every((row) => row.status === "COMPLETED") && steps.some((row) => !row.required && row.status === "FAILED")) objective.status = "PARTIAL";
  else if (steps.every((row) => row.status === "COMPLETED" || row.status === "SKIPPED" || row.status === "CANCELLED")) objective.status = "COMPLETED";
  objective.updatedAt = nowIso();
  await store.putObjective(objective);
}

async function consumeQuiet(store: DigiAiStore, execution: DigiAiActionExecution, actor: ActorContext, now: string) {
  try {
    await store.consumeActionAuthorization({
      authorizationId: execution.authorizationId,
      actorId: execution.actorId,
      applicationId: execution.applicationId,
      tenantId: actor.tenantId ?? execution.tenantId,
      now,
    });
  } catch {
    /* already consumed or invalidated */
  }
}

function inspectSafe(execution: DigiAiActionExecution, receipt?: DigiAiActionExecutionReceipt | null) {
  return {
    executionId: execution.executionId,
    actionIntentId: execution.actionIntentId,
    authorizationId: execution.authorizationId,
    actionClass: execution.actionClass,
    actionType: execution.actionType,
    status: execution.status,
    targetSummary: `${execution.target.resourceType}:${execution.target.resourceId}`,
    resultReference: execution.resultReference,
    externalReference: execution.externalReference,
    failureCode: execution.failureCode,
    receiptId: receipt?.receiptId ?? execution.receiptId,
    receiptStatus: receipt?.status,
    executorId: execution.executorId,
    executorVersion: execution.executorVersion,
    actionSchemaVersion: execution.actionSchemaVersion,
    toolInvocationId: execution.toolInvocationId,
    connectorId: execution.connectorId,
    operationId: execution.operationId,
    createdAt: execution.createdAt,
    completedAt: execution.completedAt,
    executed: execution.status === "SUCCEEDED",
  };
}

async function receiptOf(store: DigiAiStore, execution: DigiAiActionExecution) {
  return execution.receiptId ? store.getActionExecutionReceipt(execution.receiptId) : null;
}

function assertAuthorizationOwnership(authorization: { actorId: string; applicationId: string; tenantId?: string }, actor: ActorContext, caller: CallerApplication) {
  if (authorization.actorId !== actor.trustId) throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not usable by this actor.");
  if (authorization.applicationId !== caller.id) throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not usable by this application.");
  if (authorization.tenantId && actor.tenantId && authorization.tenantId !== actor.tenantId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That authorization is not usable by this tenant.");
  }
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

async function ownedExecution(store: DigiAiStore, executionId: string, actor: ActorContext, caller: CallerApplication) {
  const row = await store.getActionExecution(executionId);
  if (!row) throw new DigiAiError(404, "not_found", "Action execution was not found.");
  if (row.actorId !== actor.trustId || row.applicationId !== caller.id) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That execution is not visible to this caller.");
  }
  if (row.tenantId && actor.tenantId && row.tenantId !== actor.tenantId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That execution is not visible to this tenant.");
  }
  return row;
}

async function audit(store: DigiAiStore, event: Omit<ExecutionAuditEvent, "eventId" | "createdAt">) {
  await store.appendExecutionAudit({ ...event, eventId: newId("aexaud"), createdAt: nowIso() });
}

export function parseExecuteBody(raw: unknown, allowFixture: boolean) {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if ("actorId" in body || "tenantId" in body || "applicationId" in body || "executorId" in body || "executorVersion" in body || "receiptStatus" in body || "externalReference" in body) {
    throw new DigiAiError(400, "invalid_request", "Identity and executor fields are reserved to Digi AI.");
  }
  rejectConnectorSpoof(body);
  if ("target" in body) throw new DigiAiError(403, "PARAMETER_MISMATCH", "Execution target is taken from the authorized action intent.");
  return {
    authorizationId: typeof body.authorizationId === "string" ? body.authorizationId : undefined,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    parameters: body.parameters && typeof body.parameters === "object" ? (body.parameters as ActionParameters) : undefined,
    fixtureMode: allowFixture && isFixtureMode(body.fixtureMode) ? body.fixtureMode : undefined,
    deferInvocation: allowFixture && body.deferInvocation === true,
    selectionId: typeof body.selectionId === "string" ? body.selectionId : undefined,
  };
}
