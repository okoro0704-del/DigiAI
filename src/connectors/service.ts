import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { DigiAiActionExecution } from "../contracts/execution.js";
import type {
  DigiAiToolInvocation,
  DigiAiToolInvocationResult,
  ToolAuditEvent,
} from "../contracts/connectors.js";
import { TOOL_SCHEMA_VERSION } from "../contracts/connectors.js";
import { clip, newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import type { DigiAiStore } from "../store/types.js";
import { requiredScopesForOperation } from "../connections/lifecycle.js";
import { resolveEligibleConnection, resolveSecretForConnection } from "../connections/resolve.js";
import { resolveCredential } from "./credentials.js";
import { toolRequestDigest, toolResponseDigest } from "./digest.js";
import { runFixtureConnector } from "./fixtures.js";
import { runMybrandosConnector, runMybrandosCreateDraft } from "./mybrandos/runtime.js";
import { requireSlug } from "../lib/slug.js";
import { isMybrandosGovernedActionType, isMybrandosWriteActionType } from "../contracts/execution.js";
import { assertNotArbitraryNetwork } from "./network.js";
import { assertOperationAllowed } from "./policy.js";
import { getConnector, getOperation, resolveByActionType, sanitizedCatalog } from "./registry.js";
import { minimizedInput, validateToolInput, validateToolOutput } from "./validate.js";

const FORBIDDEN_CREDENTIAL_FIELDS = [
  "connectorId",
  "operationId",
  "credentialRef",
  "credential",
  "apiKey",
  "accessToken",
  "refreshToken",
  "password",
  "clientSecret",
  "privateKey",
  "Authorization",
  "authorization",
  "token",
  "secret",
  "connectionId",
  "path",
  "method",
  "endpoint",
  "href",
];

export function rejectConnectorSpoof(body: Record<string, unknown>) {
  if (FORBIDDEN_CREDENTIAL_FIELDS.some((field) => field in body)) {
    throw new DigiAiError(400, "invalid_request", "Connector, operation, and credential selection is reserved to Digi AI.");
  }
  assertNotArbitraryNetwork({
    host: typeof body.host === "string" ? body.host : undefined,
    scheme: typeof body.scheme === "string" ? body.scheme : undefined,
    port: typeof body.port === "string" || typeof body.port === "number" ? body.port : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
  });
}

export async function invokeTool(input: {
  store: DigiAiStore;
  execution: DigiAiActionExecution;
  actor: ActorContext;
  caller: CallerApplication;
  resume?: boolean;
  reconcile?: boolean;
  selectionId?: string;
}): Promise<DigiAiToolInvocationResult> {
  const execution = await ownedExecution(input.store, input.execution.executionId, input.actor, input.caller);
  const existing = await input.store.getToolInvocationByExecution(execution.executionId);
  if (existing && !input.resume && !input.reconcile) {
    if (existing.status === "SUCCEEDED" || existing.status === "FAILED" || existing.status === "CANCELLED" || existing.status === "UNKNOWN_OUTCOME" || existing.status === "WAITING") {
      return toResult(existing);
    }
  }
  if (existing && input.reconcile) return reconcileToolInvocation({ store: input.store, actor: input.actor, caller: input.caller, toolInvocationId: existing.toolInvocationId });
  if (existing && input.resume) return resumeToolInvocation({ store: input.store, actor: input.actor, caller: input.caller, invocation: existing });

  const environment =
    String(
      execution.parameters.environment ??
        (isMybrandosGovernedActionType(execution.actionType) ? (getConnector("mybrandos")?.environment ?? "STAGING") : "STAGING"),
    ).toUpperCase() === "PRODUCTION"
      ? "PRODUCTION"
      : "STAGING";
  const resolved = resolveByActionType(execution.actionType, environment);
  if (resolved.connector.status === "DISABLED") throw new DigiAiError(409, "CONNECTOR_DISABLED", "The connector is disabled.");
  if (!resolved.operation.enabled) throw new DigiAiError(409, "OPERATION_DISABLED", "The connector operation is disabled.");
  if (!resolved.operation.actionTypes.includes(execution.actionType)) {
    throw new DigiAiError(403, "ACTION_TYPE_MISMATCH", "The connector operation is not bound to this action type.");
  }
  assertOperationAllowed({ sideEffectClass: resolved.operation.sideEffectClass, environment, operationId: resolved.operation.operationId });
  const minimized = minimizedInput(resolved.operation, execution.parameters as Record<string, unknown>);
  if (resolved.operation.operationId === "fixture.delete") {
    minimized.resourceType = execution.target.resourceType;
    minimized.resourceId = execution.target.resourceId;
  }
  if (resolved.connector.connectorId === "mybrandos" && resolved.operation.operationId === "mybrandos.createDraft") {
    minimized.title = String(execution.parameters.contentReference ?? "");
  } else if (resolved.connector.connectorId === "mybrandos") {
    minimized.slug = requireSlug(execution.target.resourceId, "mybrandOS");
  }
  validateToolInput(resolved.operation, minimized);
  const digest = toolRequestDigest({
    executionId: execution.executionId,
    operationId: resolved.operation.operationId,
    actionType: execution.actionType,
    environment,
    target: execution.target,
    parameters: minimized,
  });
  if (existing && existing.requestDigest !== digest) {
    throw new DigiAiError(403, "PARAMETER_MISMATCH", "Invocation input does not match the stored request digest.");
  }
  if (resolved.connector.connectorId !== "mybrandos") {
    resolveCredential({
      required: resolved.operation.requiresCredential || resolved.connector.requiresCredential,
      tenantId: execution.tenantId,
      actorId: execution.actorId,
      environment: resolved.connector.environment,
      system: resolved.connector.system,
      credentialRef: resolved.connector.credentialRef,
    });
  }
  let connection;
  try {
    connection = (resolved.operation.requiresCredential || resolved.connector.requiresCredential || resolved.connector.connectorId === "mybrandos")
      ? await resolveEligibleConnection({
          store: input.store,
          actor: input.actor,
          caller: input.caller,
          system: resolved.connector.system,
          connectorId: resolved.connector.connectorId,
          environment: resolved.connector.environment === "PRODUCTION" ? "PRODUCTION" : resolved.connector.environment === "FIXTURE" ? "TEST" : "STAGING",
          requiredScopes: requiredScopesForOperation(resolved.operation.operationId),
          selectionId: input.selectionId,
          executionId: execution.executionId,
          objectiveId: execution.objectiveId,
        })
      : undefined;
  } catch (err) {
    if (resolved.connector.connectorId === "mybrandos") {
      await audit(input.store, {
        eventType: isMybrandosWriteActionType(execution.actionType) ? "DRAFT_CREATE_DENIED" : "MYBRANDOS_READ_DENIED",
        toolInvocationId: "unbound",
        connectorId: resolved.connector.connectorId,
        operationId: resolved.operation.operationId,
        executionId: execution.executionId,
        actorId: execution.actorId,
        tenantId: execution.tenantId,
      });
    }
    throw err;
  }

  const now = nowIso();
  const invocation: DigiAiToolInvocation = {
    toolInvocationId: newId("tinv"),
    executionId: execution.executionId,
    connectorId: resolved.connector.connectorId,
    operationId: resolved.operation.operationId,
    actorId: execution.actorId,
    tenantId: execution.tenantId,
    applicationId: execution.applicationId,
    objectiveId: execution.objectiveId,
    actionIntentId: execution.actionIntentId,
    actionAuthorizationId: execution.authorizationId,
    requestDigest: digest,
    idempotencyKey: execution.externalIdempotencyKey,
    input: minimized,
    connectionId: connection?.connectionId,
    credentialRef: connection?.credentialRef,
    authenticationMode: connection?.authenticationMode,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };
  const claimed = await input.store.beginToolInvocation(invocation);
  await audit(input.store, { eventType: "TOOL_INVOCATION_REQUESTED", toolInvocationId: claimed.invocation.toolInvocationId, executionId: execution.executionId, actorId: execution.actorId, tenantId: execution.tenantId });
  await audit(input.store, { eventType: "CONNECTOR_RESOLVED", toolInvocationId: claimed.invocation.toolInvocationId, connectorId: resolved.connector.connectorId, operationId: resolved.operation.operationId });
  if (resolved.connector.connectorId === "mybrandos") {
    const write = resolved.operation.operationId === "mybrandos.createDraft";
    await audit(input.store, { eventType: write ? "DRAFT_CREATE_REQUESTED" : "MYBRANDOS_READ_REQUESTED", toolInvocationId: claimed.invocation.toolInvocationId, connectorId: resolved.connector.connectorId, operationId: resolved.operation.operationId, executionId: execution.executionId, actorId: execution.actorId, tenantId: execution.tenantId });
    await audit(input.store, { eventType: write ? "DRAFT_CREATE_AUTHORIZED" : "MYBRANDOS_READ_AUTHORIZED", toolInvocationId: claimed.invocation.toolInvocationId, connectorId: resolved.connector.connectorId, operationId: resolved.operation.operationId });
  }
  if (!resolved.operation.requiresCredential) {
    await audit(input.store, { eventType: "CREDENTIAL_RESOLVED", toolInvocationId: claimed.invocation.toolInvocationId, connectorId: resolved.connector.connectorId });
  }
  if (!claimed.invoke) return toResult(claimed.invocation);
  return submit(input.store, claimed.invocation, execution, { resume: false, reconcile: false });
}

async function resumeToolInvocation(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; invocation: DigiAiToolInvocation }) {
  const invocation = await ownedInvocation(input.store, input.invocation.toolInvocationId, input.actor, input.caller);
  if (invocation.status === "UNKNOWN_OUTCOME") return toResult(invocation);
  return submit(input.store, invocation, (await input.store.getActionExecution(invocation.executionId))!, { resume: true, reconcile: false });
}

export async function reconcileToolInvocation(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; toolInvocationId: string }) {
  const invocation = await ownedInvocation(input.store, input.toolInvocationId, input.actor, input.caller);
  const operation = getOperation(invocation.operationId);
  if (!operation || operation.reconciliationMode === "UNSUPPORTED") {
    throw new DigiAiError(409, "RECONCILIATION_UNSUPPORTED", "This connector operation cannot be reconciled.");
  }
  const execution = await input.store.getActionExecution(invocation.executionId);
  if (!execution) throw new DigiAiError(404, "not_found", "Action execution was not found.");
  return submit(input.store, invocation, execution, { resume: false, reconcile: true });
}

export async function inspectToolInvocation(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication; toolInvocationId: string }) {
  const invocation = await ownedInvocation(input.store, input.toolInvocationId, input.actor, input.caller);
  return inspectSafe(invocation);
}

export function listToolCatalog() {
  return sanitizedCatalog();
}

export function evaluateConnectorGate(input: {
  operationId: string;
  environment?: "FIXTURE" | "STAGING" | "PRODUCTION";
  tenantId?: string;
  actorId?: string;
  credentialRef?: string;
}) {
  const operation = getOperation(input.operationId);
  if (!operation) throw new DigiAiError(404, "OPERATION_DISABLED", "Unknown connector operation.");
  const connector = getConnector(operation.connectorId);
  if (!connector) throw new DigiAiError(404, "CONNECTOR_DISABLED", "Connector was not found.");
  if (connector.status === "DISABLED") throw new DigiAiError(409, "CONNECTOR_DISABLED", "The connector is disabled.");
  if (!operation.enabled) throw new DigiAiError(409, "OPERATION_DISABLED", "The connector operation is disabled.");
  assertOperationAllowed({ sideEffectClass: operation.sideEffectClass, environment: input.environment ?? connector.environment, operationId: operation.operationId });
  if ((input.environment === "PRODUCTION" && connector.environment !== "PRODUCTION") || (input.environment === "PRODUCTION" && operation.sideEffectClass !== "READ_ONLY" && operation.operationId !== "mybrandos.createDraft")) {
    throw new DigiAiError(403, "ENVIRONMENT_DENIED", "A staging connector cannot be used for production.");
  }
  if (connector.connectorId !== "mybrandos") {
    resolveCredential({
      required: operation.requiresCredential || connector.requiresCredential,
      tenantId: input.tenantId,
      actorId: input.actorId,
      environment: connector.environment,
      system: connector.system,
      credentialRef: input.credentialRef ?? connector.credentialRef,
    });
  }
  return { connector, operation };
}

async function submit(
  store: DigiAiStore,
  invocation: DigiAiToolInvocation,
  execution: DigiAiActionExecution,
  opts: { resume: boolean; reconcile: boolean },
) {
  const operation = getOperation(invocation.operationId)!;
  const connector = getConnector(invocation.connectorId)!;
  invocation.status = "SUBMITTING";
  invocation.updatedAt = nowIso();
  await store.putToolInvocation(invocation);
  await audit(store, { eventType: "TOOL_SUBMISSION_STARTED", toolInvocationId: invocation.toolInvocationId, status: "SUBMITTING" });
  if (connector.connectorId === "mybrandos") {
    await audit(store, { eventType: operation.operationId === "mybrandos.createDraft" ? "DRAFT_CREATE_SUBMITTED" : "MYBRANDOS_READ_SUBMITTED", toolInvocationId: invocation.toolInvocationId, connectorId: connector.connectorId, operationId: operation.operationId });
  }
  const started = Date.now();
  let serviceSecret: string | undefined;
  if ((operation.requiresCredential || connector.connectorId === "mybrandos") && invocation.connectionId) {
    const connection = await store.getExternalConnection(invocation.connectionId);
    if (!connection) throw new DigiAiError(409, "CONNECTION_UNAVAILABLE", "No eligible connection is available.");
    const resolvedSecret = await resolveSecretForConnection({
      store,
      connection,
      actor: { trustId: invocation.actorId, tenantId: invocation.tenantId },
      caller: { id: invocation.applicationId, via: "s2s" },
      operationId: operation.operationId,
    });
    serviceSecret = resolvedSecret.secret.reveal();
    await audit(store, { eventType: "CREDENTIAL_RESOLVED", toolInvocationId: invocation.toolInvocationId, connectorId: connector.connectorId });
  } else if (connector.connectorId === "mybrandos") {
    throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "mybrandOS S2S operations require a resolved platform credential.");
  }
  const result = connector.connectorId === "mybrandos"
    ? operation.operationId === "mybrandos.createDraft"
      ? await runMybrandosCreateDraft({
          operation,
          serviceSecret,
          ownerId: execution.target.resourceId,
          title: String(invocation.input.title ?? execution.parameters.contentReference ?? ""),
          idempotencyKey: invocation.idempotencyKey || execution.externalIdempotencyKey || execution.executionId,
          payloadDigest: String(execution.parameters.contentDigest ?? ""),
          reconcile: opts.reconcile,
        })
      : await runMybrandosConnector({
        operation,
        slug: String(invocation.input.slug ?? ""),
        serviceSecret,
      })
    : runFixtureConnector({
    operation,
    executionId: execution.executionId,
    idempotencyKey: invocation.idempotencyKey,
    input: invocation.input,
    existingExternalReference: invocation.externalOperationRef ?? execution.externalReference,
    fixtureMode: execution.fixtureMode,
    resume: opts.resume,
    reconcile: opts.reconcile,
  });
  serviceSecret = undefined;
  logEvent("tool_invocation", {
    connectorId: connector.connectorId,
    operationId: operation.operationId,
    status: result.status,
    failureCode: result.failureCode ?? "",
    latencyMs: String(Date.now() - started),
    schema: TOOL_SCHEMA_VERSION,
  });
  if (result.status === "SUCCEEDED") {
    try {
      validateToolOutput(operation, result.output, result.status);
    } catch (err) {
      invocation.status = "FAILED";
      invocation.failureCode = "MALFORMED_RESPONSE";
      invocation.completedAt = nowIso();
      invocation.updatedAt = invocation.completedAt;
      await store.putToolInvocation(invocation);
      await audit(store, { eventType: "TOOL_FAILED", toolInvocationId: invocation.toolInvocationId, status: "FAILED" });
      throw err;
    }
  }
  if (result.submitted) invocation.submittedAt = invocation.submittedAt ?? nowIso();
  invocation.externalOperationRef = result.externalOperationRef ?? invocation.externalOperationRef;
  invocation.resultReference = result.resultReference ?? invocation.resultReference;
  invocation.evidence = result.evidence;
  invocation.responseDigest = result.output ? toolResponseDigest(result.output) : undefined;
  invocation.failureCode = result.failureCode;
  invocation.status = result.status;
  invocation.retryability = result.status === "FAILED" && !result.submitted ? "safe" : result.status === "UNKNOWN_OUTCOME" ? "unsafe" : "unknown";
  invocation.completedAt = result.status === "WAITING" ? undefined : nowIso();
  invocation.updatedAt = nowIso();
  await store.putToolInvocation(invocation);
  await audit(store, {
    eventType: opts.reconcile
      ? "TOOL_RECONCILED"
      : result.status === "WAITING"
        ? "TOOL_WAITING"
        : result.status === "SUCCEEDED"
          ? "TOOL_SUCCEEDED"
          : result.status === "UNKNOWN_OUTCOME"
            ? "TOOL_UNKNOWN_OUTCOME"
            : "TOOL_FAILED",
    toolInvocationId: invocation.toolInvocationId,
    status: result.status,
  });
  if (connector.connectorId === "mybrandos") {
    const write = operation.operationId === "mybrandos.createDraft";
    await audit(store, {
      eventType: write
        ? result.status === "SUCCEEDED"
          ? "DRAFT_CREATE_SUCCEEDED"
          : result.status === "UNKNOWN_OUTCOME"
            ? "DRAFT_CREATE_UNKNOWN"
            : "DRAFT_CREATE_FAILED"
        : result.status === "SUCCEEDED"
          ? "MYBRANDOS_READ_SUCCEEDED"
          : "MYBRANDOS_READ_FAILED",
      toolInvocationId: invocation.toolInvocationId,
      connectorId: connector.connectorId,
      operationId: operation.operationId,
      status: result.status,
    });
  }
  if (result.submitted) await audit(store, { eventType: "TOOL_SUBMITTED", toolInvocationId: invocation.toolInvocationId });
  return toResult(invocation);
}

function toResult(row: DigiAiToolInvocation): DigiAiToolInvocationResult {
  return {
    toolInvocationId: row.toolInvocationId,
    status: row.status,
    externalOperationRef: row.externalOperationRef,
    resultReference: row.resultReference,
    responseDigest: row.responseDigest,
    evidence: row.evidence,
    retryability: row.retryability,
    submittedAt: row.submittedAt,
    completedAt: row.completedAt,
    failureCode: row.failureCode,
    retryAfter: row.retryAfter,
  };
}

export function inspectSafe(row: DigiAiToolInvocation) {
  return {
    toolInvocationId: row.toolInvocationId,
    executionId: row.executionId,
    connectorId: row.connectorId,
    operationId: row.operationId,
    status: row.status,
    externalOperationRef: row.externalOperationRef,
    resultReference: row.resultReference,
    failureCode: row.failureCode,
    requestDigest: row.requestDigest,
    connectionId: row.connectionId,
    credentialRef: row.credentialRef,
    authenticationMode: row.authenticationMode,
    createdAt: row.createdAt,
    targetSummary: clip(`${String(row.input.resourceType ?? "")}:${String(row.input.resourceId ?? "")}`, 80),
  };
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

async function ownedInvocation(store: DigiAiStore, toolInvocationId: string, actor: ActorContext, caller: CallerApplication) {
  const row = await store.getToolInvocation(toolInvocationId);
  if (!row) throw new DigiAiError(404, "not_found", "Tool invocation was not found.");
  if (row.actorId !== actor.trustId || row.applicationId !== caller.id) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That tool invocation is not visible to this caller.");
  }
  if (row.tenantId && actor.tenantId && row.tenantId !== actor.tenantId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That tool invocation is not visible to this tenant.");
  }
  return row;
}

async function audit(store: DigiAiStore, event: Omit<ToolAuditEvent, "eventId" | "createdAt">) {
  await store.appendToolAudit({ ...event, eventId: newId("taud"), createdAt: nowIso() });
}

export function mapToolToExecutor(result: DigiAiToolInvocationResult) {
  if (result.status === "SUCCEEDED") {
    return {
      outcome: "SUCCEEDED" as const,
      submitted: Boolean(result.submittedAt),
      invoked: true,
      resultReference: result.resultReference,
      externalReference: result.externalOperationRef,
      evidence: result.evidence,
    };
  }
  if (result.status === "WAITING") {
    return {
      outcome: "WAITING" as const,
      submitted: true,
      invoked: true,
      externalReference: result.externalOperationRef,
      evidence: result.evidence,
    };
  }
  if (result.status === "UNKNOWN_OUTCOME") {
    return {
      outcome: "UNKNOWN_OUTCOME" as const,
      submitted: true,
      invoked: true,
      externalReference: result.externalOperationRef,
      failureCode: "UNKNOWN_REMOTE_OUTCOME" as const,
      evidence: result.evidence,
    };
  }
  if (!result.submittedAt) {
    return { outcome: "REJECTED_BEFORE_SUBMISSION" as const, submitted: false, invoked: true, failureCode: "TRANSIENT_BEFORE_SUBMISSION" as const };
  }
  return { outcome: "FAILED" as const, submitted: true, invoked: true, failureCode: "REMOTE_FAILED" as const, evidence: result.evidence };
}

export async function invokeReadOnlyFixture(input: { item: string; operationId: "fixture.lookup" | "fixture.inspect" }) {
  const operation = getOperation(input.operationId);
  if (!operation) throw new DigiAiError(404, "OPERATION_DISABLED", "Unknown operation.");
  validateToolInput(operation, { item: input.item });
  const result = runFixtureConnector({
    operation,
    executionId: "catalog",
    idempotencyKey: `catalog:${input.operationId}:${input.item}`,
    input: { item: input.item },
  });
  validateToolOutput(operation, result.output, result.status);
  return result;
}
