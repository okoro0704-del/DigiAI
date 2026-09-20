import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type {
  ConnectionEnvironment,
  DigiAiConnectionSelection,
  DigiAiExternalConnection,
} from "../contracts/connections.js";
import { toSafeConnectionView } from "../contracts/connections.js";
import { DigiAiError } from "../lib/http.js";
import { newId, nowIso } from "../lib/crypto.js";
import type { DigiAiStore } from "../store/types.js";
import { currentSecureCredentialBackend } from "../credentials/factory.js";
import { redactValue } from "../credentials/redact.js";
import { evaluateConnectionLifecycle } from "./lifecycle.js";

export const connectionResolutionStats = {
  secretsResolved: 0,
  lastCredentialRef: "",
  lastGeneration: 0,
};

export function resetConnectionResolutionStats() {
  connectionResolutionStats.secretsResolved = 0;
  connectionResolutionStats.lastCredentialRef = "";
  connectionResolutionStats.lastGeneration = 0;
}

export async function listEligibleConnections(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  system: string;
  connectorId?: string;
  environment: ConnectionEnvironment;
  requiredScopes: string[];
}): Promise<DigiAiExternalConnection[]> {
  const rows = await input.store.listExternalConnections({
    tenantId: input.actor.tenantId,
    actorId: input.actor.trustId,
    applicationId: input.caller.id,
    system: input.system,
    environment: input.environment,
  });
  const now = nowIso();
  return rows.filter((row) => {
    const live = evaluateConnectionLifecycle(row, now);
    if (live.status !== "ACTIVE") return false;
    if (row.system !== input.system) return false;
    if (input.connectorId && row.connectorId && row.connectorId !== input.connectorId) return false;
    if (!scopesCovered(input.requiredScopes, live.scopes)) return false;
    if (!ownerMayUse(live, input.actor, input.caller)) return false;
    return true;
  });
}

export async function resolveEligibleConnection(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  system: string;
  connectorId?: string;
  environment: ConnectionEnvironment;
  requiredScopes: string[];
  selectionId?: string;
  executionId?: string;
  objectiveId?: string;
}): Promise<DigiAiExternalConnection> {
  if (input.selectionId) {
    const selection = await input.store.getConnectionSelection(input.selectionId);
    assertUsableSelection(selection, input);
    const chosen = await input.store.getExternalConnection(selection!.chosenConnectionId);
    if (!chosen) throw new DigiAiError(409, "CONNECTION_UNAVAILABLE", "The selected connection is no longer available.");
    const live = evaluateConnectionLifecycle(chosen, nowIso());
    assertUsableConnection(live, input);
    return live;
  }
  const eligible = await listEligibleConnections(input);
  if (eligible.length === 0) {
    const sameSystem = (await input.store.listExternalConnections({
      tenantId: input.actor.tenantId,
      actorId: input.actor.trustId,
      applicationId: input.caller.id,
      system: input.system,
      environment: input.environment,
    })).filter((row) => evaluateConnectionLifecycle(row, nowIso()).status === "ACTIVE" && ownerMayUse(row, input.actor, input.caller));
    if (sameSystem.length && sameSystem.every((row) => !scopesCovered(input.requiredScopes, row.scopes))) {
      await auditDenied(input.store, input, "CREDENTIAL_SCOPE_INSUFFICIENT");
      throw new DigiAiError(409, "CREDENTIAL_SCOPE_INSUFFICIENT", "The connection does not grant the required scopes.");
    }
    await auditDenied(input.store, input, "CONNECTION_UNAVAILABLE");
    throw new DigiAiError(409, "CONNECTION_UNAVAILABLE", "No eligible connection is available.");
  }
  if (eligible.length > 1) {
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CONNECTION_SELECTION_REQUIRED",
      actorId: input.actor.trustId,
      tenantId: input.actor.tenantId,
      applicationId: input.caller.id,
      createdAt: nowIso(),
    });
    throw Object.assign(new DigiAiError(409, "CONNECTION_SELECTION_REQUIRED", "Multiple eligible connections exist. A human selection is required."), {
      extra: { connections: eligible.map(toSafeConnectionView) },
    });
  }
  return eligible[0];
}

export async function bindConnectionSelection(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  connectionId: string;
  system: string;
  environment: ConnectionEnvironment;
  eligibleConnectionIds: string[];
  objectiveId?: string;
  executionId?: string;
}): Promise<DigiAiConnectionSelection> {
  if (!input.eligibleConnectionIds.includes(input.connectionId)) {
    throw new DigiAiError(403, "CONNECTION_SELECTION_DENIED", "That connection is not in the eligible set.");
  }
  const row = await input.store.getExternalConnection(input.connectionId);
  if (!row) throw new DigiAiError(404, "not_found", "Connection was not found.");
  const live = evaluateConnectionLifecycle(row, nowIso());
  assertUsableConnection(live, input);
  const selection: DigiAiConnectionSelection = {
    selectionId: newId("csel"),
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    system: input.system,
    environment: input.environment,
    eligibleConnectionIds: [...input.eligibleConnectionIds],
    chosenConnectionId: input.connectionId,
    objectiveId: input.objectiveId,
    executionId: input.executionId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    createdAt: nowIso(),
  };
  await input.store.putConnectionSelection(selection);
  await input.store.appendConnectionAudit({
    eventId: newId("caud"),
    eventType: "CONNECTION_SELECTION_BOUND",
    connectionId: input.connectionId,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    createdAt: nowIso(),
  });
  return selection;
}

export async function resolveSecretForConnection(input: {
  store: DigiAiStore;
  connection: DigiAiExternalConnection;
  actor: ActorContext;
  caller: CallerApplication;
  operationId?: string;
}) {
  const latest = await input.store.lockExternalConnection(input.connection.connectionId, async (row) => row);
  const live = evaluateConnectionLifecycle(latest, nowIso());
  if (live.status === "REVOKED") {
    await auditDenied(input.store, input, "CONNECTION_REVOKED", live.connectionId, live.credentialRef);
    throw new DigiAiError(409, "CONNECTION_REVOKED", "The connection has been revoked.");
  }
  if (live.status === "DISABLED") {
    await auditDenied(input.store, input, "CONNECTION_DISABLED", live.connectionId, live.credentialRef);
    throw new DigiAiError(409, "CONNECTION_DISABLED", "The connection is disabled.");
  }
  if (live.status === "EXPIRED") {
    await auditDenied(input.store, input, "CREDENTIAL_EXPIRED", live.connectionId, live.credentialRef);
    throw new DigiAiError(409, "CREDENTIAL_EXPIRED", "The credential has expired.");
  }
  if (live.status !== "ACTIVE") {
    await auditDenied(input.store, input, "CONNECTION_UNAVAILABLE", live.connectionId, live.credentialRef);
    throw new DigiAiError(409, "CONNECTION_UNAVAILABLE", "The connection is not active.");
  }
  if (!ownerMayUse(live, input.actor, input.caller)) {
    await auditDenied(input.store, input, "CONNECTION_FORBIDDEN", live.connectionId, live.credentialRef);
    throw new DigiAiError(403, "cross_tenant_forbidden", "That connection is not usable by this caller.");
  }
  const metadata = await input.store.getCredentialMetadata(live.credentialRef);
  if (!metadata) {
    await auditDenied(input.store, input, "CREDENTIAL_UNAVAILABLE", live.connectionId, live.credentialRef);
    throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
  }
  const secret = await currentSecureCredentialBackend().resolveUsingMetadata(metadata);
  connectionResolutionStats.secretsResolved += 1;
  connectionResolutionStats.lastCredentialRef = live.credentialRef;
  connectionResolutionStats.lastGeneration = secret.generation;
  await input.store.appendConnectionAudit(redactValue({
    eventId: newId("caud"),
    eventType: "CREDENTIAL_RESOLUTION_ALLOWED",
    connectionId: live.connectionId,
    credentialRef: live.credentialRef,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    operationId: input.operationId,
    createdAt: nowIso(),
  }) as import("../contracts/connections.js").ConnectionAuditEvent);
  return { connection: live, secret };
}

function scopesCovered(required: string[], granted: string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}

function ownerMayUse(row: DigiAiExternalConnection, actor: ActorContext, caller: CallerApplication): boolean {
  if (row.ownerType === "ACTOR") return row.actorId === actor.trustId;
  if (row.ownerType === "TENANT") return Boolean(row.tenantId && actor.tenantId && row.tenantId === actor.tenantId);
  if (row.ownerType === "APPLICATION") return row.applicationId === caller.id;
  if (row.ownerType === "PLATFORM_SERVICE") return true;
  return false;
}

function assertUsableConnection(
  row: DigiAiExternalConnection,
  input: { actor: ActorContext; caller: CallerApplication; system: string; connectorId?: string; environment: ConnectionEnvironment; requiredScopes?: string[] },
) {
  if (row.system !== input.system) throw new DigiAiError(403, "SYSTEM_MISMATCH", "Connection system does not match the connector.");
  if (row.environment !== input.environment) throw new DigiAiError(403, "ENVIRONMENT_DENIED", "Connection environment does not match the requested environment.");
  if (input.connectorId && row.connectorId && row.connectorId !== input.connectorId) {
    throw new DigiAiError(403, "CONNECTOR_MISMATCH", "Connection is not bound to this connector.");
  }
  if (input.requiredScopes && !scopesCovered(input.requiredScopes, row.scopes)) {
    throw new DigiAiError(409, "CREDENTIAL_SCOPE_INSUFFICIENT", "The connection does not grant the required scopes.");
  }
  if (!ownerMayUse(row, input.actor, input.caller)) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That connection is not usable by this caller.");
  }
  if (row.status !== "ACTIVE") throw new DigiAiError(409, `CONNECTION_${row.status}`, `The connection is ${row.status.toLowerCase()}.`);
}

function assertUsableSelection(
  selection: DigiAiConnectionSelection | null,
  input: { actor: ActorContext; caller: CallerApplication; system: string; environment: ConnectionEnvironment; executionId?: string; objectiveId?: string },
) {
  if (!selection) throw new DigiAiError(403, "CONNECTION_SELECTION_DENIED", "Connection selection is unknown.");
  if (selection.consumedAt) throw new DigiAiError(403, "CONNECTION_SELECTION_DENIED", "Connection selection has already been used.");
  if (selection.expiresAt <= nowIso()) throw new DigiAiError(403, "CONNECTION_SELECTION_DENIED", "Connection selection has expired.");
  if (selection.actorId !== input.actor.trustId || selection.applicationId !== input.caller.id) {
    throw new DigiAiError(403, "CONNECTION_SELECTION_DENIED", "Connection selection is bound to a different identity.");
  }
  if (selection.system !== input.system || selection.environment !== input.environment) {
    throw new DigiAiError(403, "CONNECTION_SELECTION_DENIED", "Connection selection does not match this operation.");
  }
}

async function auditDenied(
  store: DigiAiStore,
  input: { actor?: ActorContext; caller?: CallerApplication; operationId?: string },
  reasonCode: string,
  connectionId?: string,
  credentialRef?: string,
) {
  await store.appendConnectionAudit({
    eventId: newId("caud"),
    eventType: "CREDENTIAL_RESOLUTION_DENIED",
    connectionId,
    credentialRef,
    actorId: input.actor?.trustId,
    tenantId: input.actor?.tenantId,
    applicationId: input.caller?.id,
    operationId: input.operationId,
    reasonCode,
    createdAt: nowIso(),
  });
}
