import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { AppConfig } from "../config.js";
import {
  isAuthenticationMode,
  isConnectionEnvironment,
  isConnectionOwnerType,
  toSafeConnectionView,
  type AuthenticationMode,
  type ConnectionEnvironment,
  type ConnectionOwnerType,
  type DigiAiExternalConnection,
} from "../contracts/connections.js";
import { currentSecureCredentialBackend } from "../credentials/factory.js";
import { redactValue } from "../credentials/redact.js";
import { DigiAiError } from "../lib/http.js";
import { newId, nowIso } from "../lib/crypto.js";
import type { DigiAiStore } from "../store/types.js";
import { isOperatorCaller } from "../usage/query.js";
import { assertConnectionRateLimit } from "./limits.js";
import { evaluateConnectionLifecycle } from "./lifecycle.js";
import { initiateOAuth, validateOAuthCallback } from "./oauth.js";

const FORBIDDEN_CREATE_FIELDS = [
  "actorId",
  "tenantId",
  "applicationId",
  "credentialRef",
  "apiKey",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "clientSecret",
  "privateKey",
  "authorization",
  "Authorization",
];

export function parseConnectionCreateBody(raw: unknown) {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const field of FORBIDDEN_CREATE_FIELDS) {
    if (field in body) throw new DigiAiError(400, "invalid_request", "Identity and credential fields are reserved to Digi AI.");
  }
  if (!isConnectionOwnerType(body.ownerType)) throw new DigiAiError(400, "invalid_request", "A valid connection owner type is required.");
  if (!isConnectionEnvironment(body.environment)) throw new DigiAiError(400, "invalid_request", "A valid connection environment is required.");
  if (!isAuthenticationMode(body.authenticationMode)) throw new DigiAiError(400, "invalid_request", "A valid authentication mode is required.");
  if (typeof body.system !== "string" || !body.system.trim()) throw new DigiAiError(400, "invalid_request", "A system binding is required.");
  return {
    ownerType: body.ownerType,
    environment: body.environment,
    authenticationMode: body.authenticationMode,
    system: body.system.trim(),
    connectorId: typeof body.connectorId === "string" ? body.connectorId : undefined,
    scopes: Array.isArray(body.scopes) ? body.scopes.filter((row): row is string => typeof row === "string") : [],
    displayLabel: typeof body.displayLabel === "string" ? body.displayLabel : body.system,
    accountAlias: typeof body.accountAlias === "string" ? body.accountAlias : undefined,
    secret: typeof body.secret === "string" ? body.secret : undefined,
    logicalName: typeof body.logicalName === "string" ? body.logicalName : undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    requirePkce: body.requirePkce !== false,
  };
}

export async function createConnection(input: {
  store: DigiAiStore;
  config: AppConfig;
  actor: ActorContext;
  caller: CallerApplication;
  body: ReturnType<typeof parseConnectionCreateBody>;
}): Promise<DigiAiExternalConnection> {
  assertConnectionRateLimit(`create:${input.caller.id}:${input.actor.trustId}`);
  const owner = bindOwner(input.body.ownerType, input.actor, input.caller, input.config);
  if (input.body.secret && input.config.isProd) {
    throw new DigiAiError(400, "invalid_request", "Secrets cannot be submitted through the API.");
  }
  if (input.body.idempotencyKey) {
    const existing = await input.store.findConnectionByIdempotency(input.caller.id, input.actor.trustId, input.body.idempotencyKey);
    if (existing) return evaluateConnectionLifecycle(existing, nowIso());
  }
  const backend = currentSecureCredentialBackend();
  const stored = await backend.store({
    secret: input.config.isProd ? undefined : input.body.secret,
    logicalName: input.body.logicalName,
    system: input.body.system,
    environment: input.body.environment,
    authenticationMode: input.body.authenticationMode,
    scopes: input.body.scopes,
    ownerType: owner.ownerType,
    tenantId: owner.tenantId,
    actorId: owner.actorId,
    applicationId: owner.applicationId,
    expiresAt: input.body.expiresAt,
    refreshSupported: input.body.authenticationMode === "OAUTH2",
  });
  await input.store.putCredentialMetadata(stored);
  const now = nowIso();
  const validated = input.body.status === "PENDING" ? false : Boolean(stored.status === "available");
  const row: DigiAiExternalConnection = {
    connectionId: newId("conn"),
    connectorId: input.body.connectorId,
    system: input.body.system,
    tenantId: owner.tenantId,
    actorId: owner.actorId,
    applicationId: owner.applicationId,
    ownerType: owner.ownerType,
    environment: input.body.environment,
    authenticationMode: input.body.authenticationMode,
    credentialRef: stored.credentialRef,
    credentialGeneration: stored.generation,
    status: validated ? (input.body.expiresAt && input.body.expiresAt <= now ? "EXPIRED" : "ACTIVE") : "PENDING",
    scopes: [...input.body.scopes],
    displayLabel: input.body.displayLabel,
    accountAlias: input.body.accountAlias,
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: validated ? now : undefined,
    expiresAt: input.body.expiresAt,
    idempotencyKey: input.body.idempotencyKey,
  };
  if (input.body.status === "DISABLED") row.status = "DISABLED";
  if (input.body.status === "REVOKED") {
    row.status = "REVOKED";
    row.revokedAt = now;
  }
  if (input.body.status === "INVALID") row.status = "INVALID";
  await input.store.putExternalConnection(row);
  await input.store.appendConnectionAudit({
    eventId: newId("caud"),
    eventType: "CONNECTION_CREATED",
    connectionId: row.connectionId,
    credentialRef: row.credentialRef,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    createdAt: now,
  });
  await input.store.appendConnectionAudit({
    eventId: newId("caud"),
    eventType: "CREDENTIAL_STORED",
    connectionId: row.connectionId,
    credentialRef: row.credentialRef,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    createdAt: now,
  });
  if (row.status === "ACTIVE") {
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CONNECTION_VALIDATED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      createdAt: now,
    });
  }
  return row;
}

export async function listConnections(input: { store: DigiAiStore; actor: ActorContext; caller: CallerApplication }) {
  const rows = await input.store.listExternalConnections({
    tenantId: input.actor.tenantId,
    actorId: input.actor.trustId,
    applicationId: input.caller.id,
  });
  return visibleConnections(rows, input.actor, input.caller).map((row) => toSafeConnectionView(evaluateConnectionLifecycle(row, nowIso())));
}

export async function inspectConnection(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  connectionId: string;
}) {
  const row = await ownedConnection(input.store, input.connectionId, input.actor, input.caller);
  return toSafeConnectionView(evaluateConnectionLifecycle(row, nowIso()));
}

export async function revokeConnection(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  config: AppConfig;
  connectionId: string;
}) {
  assertConnectionRateLimit(`revoke:${input.caller.id}:${input.connectionId}`);
  return input.store.lockExternalConnection(input.connectionId, async (row) => {
    assertCanAdminister(row, input.actor, input.caller, input.config, "revoke");
    if (row.status === "REVOKED") return evaluateConnectionLifecycle(row, nowIso());
    const backend = currentSecureCredentialBackend();
    await backend.revoke(row.credentialRef);
    const meta = await backend.inspectMetadata(row.credentialRef);
    if (meta) await input.store.putCredentialMetadata(meta);
    row.status = "REVOKED";
    row.revokedAt = nowIso();
    row.updatedAt = row.revokedAt;
    await input.store.putExternalConnection(row);
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CONNECTION_REVOKED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      actorId: input.actor.trustId,
      tenantId: input.actor.tenantId,
      applicationId: input.caller.id,
      createdAt: row.revokedAt,
    });
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CREDENTIAL_REVOKED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      createdAt: row.revokedAt,
    });
    return row;
  });
}

export async function rotateConnection(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  config: AppConfig;
  connectionId: string;
  secret?: string;
  logicalName?: string;
}) {
  assertConnectionRateLimit(`rotate:${input.caller.id}:${input.connectionId}`);
  if (input.secret && input.config.isProd) throw new DigiAiError(400, "invalid_request", "Secrets cannot be submitted through the API.");
  return input.store.lockExternalConnection(input.connectionId, async (row) => {
    assertCanAdminister(row, input.actor, input.caller, input.config, "rotate");
    if (row.status === "REVOKED") throw new DigiAiError(409, "CONNECTION_REVOKED", "A revoked connection cannot be rotated.");
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CREDENTIAL_ROTATION_REQUESTED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      actorId: input.actor.trustId,
      createdAt: nowIso(),
    });
    const backend = currentSecureCredentialBackend();
    const next = await backend.rotate({
      currentRef: row.credentialRef,
      secret: input.config.isProd ? undefined : input.secret,
      logicalName: input.logicalName,
    });
    await input.store.putCredentialMetadata(next);
    const previous = await backend.inspectMetadata(row.credentialRef);
    if (previous) await input.store.putCredentialMetadata(previous);
    row.credentialRef = next.credentialRef;
    row.credentialGeneration = next.generation;
    row.updatedAt = nowIso();
    row.status = row.status === "PENDING" ? "PENDING" : "ACTIVE";
    row.lastValidatedAt = row.status === "ACTIVE" ? row.updatedAt : row.lastValidatedAt;
    await input.store.putExternalConnection(row);
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CREDENTIAL_ROTATED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      createdAt: row.updatedAt,
    });
    return row;
  });
}

export async function disableConnection(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  config: AppConfig;
  connectionId: string;
}) {
  return input.store.lockExternalConnection(input.connectionId, async (row) => {
    assertCanAdminister(row, input.actor, input.caller, input.config, "revoke");
    row.status = "DISABLED";
    row.disabledAt = nowIso();
    row.updatedAt = row.disabledAt;
    await input.store.putExternalConnection(row);
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "CONNECTION_DISABLED",
      connectionId: row.connectionId,
      createdAt: row.updatedAt,
    });
    return row;
  });
}

export async function startOAuth(input: {
  store: DigiAiStore;
  config: AppConfig;
  actor: ActorContext;
  caller: CallerApplication;
  system: string;
  environment: ConnectionEnvironment;
  redirectUri: string;
  scopes: string[];
}) {
  assertConnectionRateLimit(`oauth:${input.caller.id}:${input.actor.trustId}`);
  const started = await initiateOAuth({
    store: input.store,
    actor: input.actor,
    caller: input.caller,
    system: input.system,
    environment: input.environment,
    redirectUri: input.redirectUri,
    allowlist: input.config.oauthRedirectAllowlist,
    scopes: input.scopes,
  });
  await input.store.appendConnectionAudit({
    eventId: newId("caud"),
    eventType: "OAUTH_INITIATED",
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    createdAt: nowIso(),
  });
  return started;
}

export async function completeOAuth(input: {
  store: DigiAiStore;
  config: AppConfig;
  actor: ActorContext;
  caller: CallerApplication;
  state: string;
  redirectUri: string;
  codeVerifier?: string;
  fixtureSecret?: string;
}) {
  assertConnectionRateLimit(`oauth-cb:${input.caller.id}:${input.actor.trustId}`);
  try {
    const record = await validateOAuthCallback({
      store: input.store,
      actor: input.actor,
      caller: input.caller,
      state: input.state,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    if (input.config.isProd || !currentSecureCredentialBackend().supportsDynamicUserVault) {
      await input.store.appendConnectionAudit({
        eventId: newId("caud"),
        eventType: "OAUTH_CALLBACK_ACCEPTED",
        actorId: input.actor.trustId,
        createdAt: nowIso(),
      });
      throw new DigiAiError(409, "DYNAMIC_USER_VAULT_UNSUPPORTED", "Dynamic user OAuth secret storage is not yet supported.");
    }
    const connection = await createConnection({
      store: input.store,
      config: input.config,
      actor: input.actor,
      caller: input.caller,
      body: parseConnectionCreateBody({
        ownerType: "ACTOR",
        environment: record.environment,
        authenticationMode: "OAUTH2",
        system: record.system,
        scopes: record.scopes,
        displayLabel: `${record.system} account`,
        secret: input.fixtureSecret,
      }),
    });
    await input.store.appendConnectionAudit({
      eventId: newId("caud"),
      eventType: "OAUTH_CALLBACK_ACCEPTED",
      connectionId: connection.connectionId,
      actorId: input.actor.trustId,
      createdAt: nowIso(),
    });
    return toSafeConnectionView(connection);
  } catch (err) {
    if (err instanceof DigiAiError && err.code !== "DYNAMIC_USER_VAULT_UNSUPPORTED") {
      await input.store.appendConnectionAudit({
        eventId: newId("caud"),
        eventType: "OAUTH_CALLBACK_REJECTED",
        actorId: input.actor.trustId,
        reasonCode: err.code,
        createdAt: nowIso(),
      });
    }
    throw err;
  }
}

export function inspectSafeConnections(rows: DigiAiExternalConnection[]) {
  return rows.map((row) => toSafeConnectionView(evaluateConnectionLifecycle(row, nowIso())));
}

function bindOwner(ownerType: ConnectionOwnerType, actor: ActorContext, caller: CallerApplication, config: AppConfig) {
  if (ownerType === "ACTOR") {
    return { ownerType, actorId: actor.trustId, tenantId: actor.tenantId, applicationId: caller.id };
  }
  if (ownerType === "TENANT") {
    if (!actor.tenantId) throw new DigiAiError(400, "invalid_request", "A tenant-scoped connection requires a tenant identity.");
    return { ownerType, tenantId: actor.tenantId, applicationId: caller.id };
  }
  if (ownerType === "APPLICATION") {
    return { ownerType, applicationId: caller.id, tenantId: actor.tenantId };
  }
  if (!isOperatorCaller(config, caller)) {
    throw new DigiAiError(403, "operator_required", "Platform service connections require trusted service identity.");
  }
  return { ownerType, applicationId: caller.id };
}

async function ownedConnection(store: DigiAiStore, connectionId: string, actor: ActorContext, caller: CallerApplication) {
  const row = await store.getExternalConnection(connectionId);
  if (!row) throw new DigiAiError(404, "not_found", "Connection was not found.");
  if (!canSee(row, actor, caller)) throw new DigiAiError(403, "cross_tenant_forbidden", "That connection is not visible to this caller.");
  return row;
}

function visibleConnections(rows: DigiAiExternalConnection[], actor: ActorContext, caller: CallerApplication) {
  return rows.filter((row) => canSee(row, actor, caller));
}

function canSee(row: DigiAiExternalConnection, actor: ActorContext, caller: CallerApplication) {
  if (row.ownerType === "ACTOR") return row.actorId === actor.trustId;
  if (row.ownerType === "TENANT") return Boolean(row.tenantId && actor.tenantId && row.tenantId === actor.tenantId);
  if (row.ownerType === "APPLICATION") return row.applicationId === caller.id;
  return caller.via === "s2s";
}

function assertCanAdminister(
  row: DigiAiExternalConnection,
  actor: ActorContext,
  caller: CallerApplication,
  config: AppConfig,
  action: "revoke" | "rotate",
) {
  if (row.ownerType === "ACTOR" && row.actorId === actor.trustId) return;
  if (row.ownerType === "TENANT" && row.tenantId && actor.tenantId === row.tenantId && action === "revoke") return;
  if (isOperatorCaller(config, caller)) return;
  if (row.ownerType === "PLATFORM_SERVICE" || row.ownerType === "APPLICATION" || action === "rotate") {
    throw new DigiAiError(403, "operator_required", "Administrative connection authority is required.");
  }
  throw new DigiAiError(403, "cross_tenant_forbidden", "That connection is not administrable by this caller.");
}

export function publicConnectionPayload(row: DigiAiExternalConnection) {
  return redactValue(toSafeConnectionView(evaluateConnectionLifecycle(row, nowIso())));
}

export type { AuthenticationMode, ConnectionEnvironment, ConnectionOwnerType };
