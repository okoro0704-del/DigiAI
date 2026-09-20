import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { seedFixtureConnections, FIXTURE_CONNECTION_SECRET } from "../src/connections/fixtures.js";
import { resetConnectionRateLimits } from "../src/connections/limits.js";
import { createPkcePair } from "../src/connections/oauth.js";
import {
  bindConnectionSelection,
  resetConnectionResolutionStats,
  resolveEligibleConnection,
  resolveSecretForConnection,
  connectionResolutionStats,
} from "../src/connections/resolve.js";
import { parseConnectionCreateBody, revokeConnection, rotateConnection } from "../src/connections/service.js";
import { rejectConnectorSpoof } from "../src/connectors/service.js";
import { SECURE_CREDENTIAL_BACKEND } from "../src/connectors/credentials.js";
import { connectorStats, resetConnectorStats } from "../src/connectors/fixtures.js";
import { DYNAMIC_USER_OAUTH_VAULT } from "../src/credentials/backend.js";
import { bindSecureCredentialBackend, createSecureCredentialBackend, resetSecureCredentialBackend } from "../src/credentials/factory.js";
import { MemorySecureCredentialBackend } from "../src/credentials/memory.js";
import { RailwayPlatformServiceBackend } from "../src/credentials/railway.js";
import { containsSecret, redactText, resetSecretSentinels, sanitizePublicMessage } from "../src/credentials/redact.js";
import { FIXTURE_SENTINEL_SECRET, ResolvedCredentialSecret } from "../src/credentials/secret.js";
import { PLATFORM_JOBS_ACTION_INTEGRATION } from "../src/execution/jobs.js";
import { resetFixtureStats } from "../src/execution/executors.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { TestProvider } from "../src/providers/test.js";
import { MemoryStore } from "../src/store/memory.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    isProd: false,
    nodeEnv: "test",
    callers: [
      { id: "test", secret: "test-secret" },
      { id: "operator", secret: "operator-secret" },
      { id: "tenant-b", secret: "b-secret" },
    ],
    operatorCallers: ["operator"],
    trustIdApi: "http://trustid.test",
    allowAttestedActor: false,
    databaseUrl: "",
    economicsMode: "observe",
    oauthRedirectAllowlist: ["https://digiai.local/oauth/callback", "http://127.0.0.1/oauth/callback"],
    ...overrides,
  };
}

const actors: IdentityResolver = {
  async resolveToken(token: string) {
    if (token === "actor-a") return { trustId: "TD-A", displayName: "Actor A", tenantId: "tenant-a" };
    if (token === "actor-b") return { trustId: "TD-B", displayName: "Actor B", tenantId: "tenant-b" };
    return null;
  },
};

const apps: Array<{ close: () => Promise<void> }> = [];
const logs: string[] = [];
const originalError = console.error;

function headers(token = "actor-a", caller = "test", key = "test-secret") {
  return {
    "x-digi-ai-caller": caller,
    "x-digi-ai-caller-key": key,
    authorization: `Bearer ${token}`,
  };
}

async function start(opts: { store?: MemoryStore; config?: Partial<AppConfig>; backend?: MemorySecureCredentialBackend } = {}) {
  const store = opts.store ?? new MemoryStore();
  const backend = opts.backend ?? new MemorySecureCredentialBackend();
  bindSecureCredentialBackend(backend);
  const app = buildApp(testConfig(opts.config), {
    provider: new TestProvider(),
    resolver: actors,
    store,
    credentialBackend: backend,
    digipedia: { async readPublished() { return { ok: false, error: "not_found", message: "none" }; } },
    diginews: { async readPublic() { return { ok: false, error: "not_found", message: "none" }; } },
  });
  apps.push(app);
  return { app, store, backend };
}

const publishPayload = {
  actionClass: "PUBLISH",
  actionType: "PUBLISH_FIXTURE_POST",
  target: { system: "fixture", resourceType: "post", resourceId: "p1" },
  parameters: { contentReference: "p1", contentDigest: "digest", destination: "fixture", visibility: "public" },
};

async function authorizeAndExecute(app: Awaited<ReturnType<typeof start>>["app"], payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const obj = await app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" }, idempotencyKey: `e-${Math.random()}` },
  });
  const proposed = await app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: { ...publishPayload, ...payload },
  });
  await app.inject({
    method: "POST",
    url: `/v1/actions/${proposed.json().intent.actionIntentId}/decision`,
    headers: headers(),
    payload: { decision: "APPROVE" },
  });
  return app.inject({
    method: "POST",
    url: `/v1/actions/${proposed.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: extra,
  });
}

function leak(value: unknown) {
  return containsSecret(value, FIXTURE_SENTINEL_SECRET) || containsSecret(value, FIXTURE_CONNECTION_SECRET);
}

afterEach(async () => {
  resetFixtureStats();
  resetConnectorStats();
  resetConnectionResolutionStats();
  resetConnectionRateLimits();
  resetSecretSentinels();
  resetSecureCredentialBackend();
  logs.length = 0;
  console.error = originalError;
  while (apps.length) await apps.pop()?.close();
});

test("3F contracts, backends, redaction, 3E credential backend remains unset", async () => {
  expect(SECURE_CREDENTIAL_BACKEND).toBe("NOT_ESTABLISHED");
  expect(DYNAMIC_USER_OAUTH_VAULT).toBe("NOT_YET_SUPPORTED");
  expect(PLATFORM_JOBS_ACTION_INTEGRATION).toBe("BRIDGE_DEFINED");
  const secret = new ResolvedCredentialSecret(FIXTURE_SENTINEL_SECRET, "cred_x", 1);
  expect(JSON.stringify(secret)).not.toContain(FIXTURE_SENTINEL_SECRET);
  expect(String(secret)).toBe("[ResolvedCredentialSecret]");
  expect(sanitizePublicMessage(`upstream ${FIXTURE_SENTINEL_SECRET}`)).not.toContain(FIXTURE_SENTINEL_SECRET);
  expect(redactText(`Authorization Bearer ${FIXTURE_SENTINEL_SECRET}`)).not.toContain(FIXTURE_SENTINEL_SECRET);
  expect(() => rejectConnectorSpoof({ accessToken: "x" })).toThrow(/reserved/);
  expect(() => rejectConnectorSpoof({ refreshToken: "x" })).toThrow(/reserved/);
  expect(() => rejectConnectorSpoof({ clientSecret: "x" })).toThrow(/reserved/);
  expect(() => rejectConnectorSpoof({ connectionId: "conn_x" })).toThrow(/reserved/);
  expect(() => rejectConnectorSpoof({ Authorization: "Bearer x" })).toThrow(/reserved/);
  const railway = new RailwayPlatformServiceBackend();
  await expect(railway.store({
    ownerType: "TENANT",
    system: "x",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: [],
    secret: "nope",
  })).rejects.toThrow(/not a multi-tenant secret vault/i);
  const prod = createSecureCredentialBackend({ ...testConfig(), isProd: true });
  expect(prod.backendClass).toBe("railway-platform-service");
  expect(prod.supportsDynamicUserVault).toBe(false);
});

test("security matrix 1-36, fixtures A-J, oauth, rotation, isolation", async () => {
  console.error = (...args: unknown[]) => {
    logs.push(args.map((row) => String(row)).join(" "));
    originalError(...args);
  };
  const live = await start();
  const actor = { trustId: "TD-A", tenantId: "tenant-a", displayName: "Actor A" };
  const caller = { id: "test", via: "s2s" as const };
  const fixtures = await seedFixtureConnections({
    store: live.store,
    config: testConfig(),
    actor,
    caller,
    otherActor: { trustId: "TD-B", tenantId: "tenant-b", displayName: "Actor B" },
  });

  const anon = await live.app.inject({ method: "GET", url: "/v1/connections" });
  expect(anon.statusCode).toBe(401);

  const spoof = await live.app.inject({
    method: "POST",
    url: "/internal/connections",
    headers: headers(),
    payload: { ownerType: "ACTOR", actorId: "TD-B", tenantId: "tenant-b", applicationId: "other", system: "fixture-secured", environment: "STAGING", authenticationMode: "API_KEY", scopes: ["read:catalog"], secret: FIXTURE_CONNECTION_SECRET },
  });
  expect(spoof.statusCode).toBe(400);

  const listed = await live.app.inject({ method: "GET", url: "/v1/connections", headers: headers() });
  expect(listed.statusCode).toBe(200);
  expect(leak(listed.json())).toBe(false);
  expect(JSON.stringify(listed.json())).not.toMatch(/apiKey|accessToken|refreshToken|privateKey/);

  const otherSees = await live.app.inject({ method: "GET", url: `/v1/connections/${fixtures.actor.connectionId}`, headers: headers("actor-b", "tenant-b", "b-secret") });
  expect(otherSees.statusCode).toBe(403);

  const tenantB = await live.app.inject({ method: "GET", url: `/v1/connections/${fixtures.tenant.connectionId}`, headers: headers("actor-b", "tenant-b", "b-secret") });
  expect(tenantB.statusCode).toBe(403);

  const inspect = await live.app.inject({ method: "GET", url: `/v1/connections/${fixtures.actor.connectionId}`, headers: headers() });
  expect(inspect.statusCode).toBe(200);
  expect(inspect.json().connection.status).toBe("ACTIVE");
  expect(inspect.json().connection.credentialRef).toBeUndefined();
  expect(leak(inspect.json())).toBe(false);

  await expect(resolveEligibleConnection({
    store: live.store,
    actor,
    caller,
    system: "fixture-secured",
    connectorId: "fixture-secured",
    environment: "PRODUCTION",
    requiredScopes: ["read:catalog"],
  })).rejects.toThrow(/environment|available/i);

  await expect(resolveEligibleConnection({
    store: live.store,
    actor,
    caller,
    system: "fixture-other",
    environment: "STAGING",
    requiredScopes: ["read:catalog"],
  })).rejects.toThrow(/available|revoked|disabled/i);

  await expect(resolveEligibleConnection({
    store: live.store,
    actor,
    caller,
    system: "fixture-secured",
    environment: "STAGING",
    requiredScopes: ["write:admin"],
  })).rejects.toMatchObject({ code: "CREDENTIAL_SCOPE_INSUFFICIENT" });

  await expect(resolveSecretForConnection({
    store: live.store,
    connection: fixtures.expired,
    actor,
    caller,
  })).rejects.toMatchObject({ code: "CREDENTIAL_EXPIRED" });

  await expect(resolveSecretForConnection({
    store: live.store,
    connection: fixtures.revoked,
    actor,
    caller,
  })).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });

  await expect(resolveSecretForConnection({
    store: live.store,
    connection: fixtures.disabled,
    actor,
    caller,
  })).rejects.toMatchObject({ code: "CONNECTION_DISABLED" });

  await expect(resolveEligibleConnection({
    store: live.store,
    actor: { trustId: "TD-B", tenantId: "tenant-a" },
    caller,
    system: "fixture-secured",
    environment: "STAGING",
    requiredScopes: ["read:catalog"],
    selectionId: undefined,
  })).rejects.toBeTruthy();

  const resolved = await resolveSecretForConnection({ store: live.store, connection: fixtures.actor, actor, caller, operationId: "fixture.secured" });
  expect(resolved.secret.reveal()).toContain(FIXTURE_SENTINEL_SECRET);
  expect(leak(await live.store.listConnectionAudit())).toBe(false);
  expect(leak(live.store.externalConnections)).toBe(false);
  expect(leak(live.store.credentialMetadata)).toBe(false);

  await expect(resolveEligibleConnection({
    store: live.store,
    actor,
    caller,
    system: "fixture-ambiguous",
    environment: "STAGING",
    requiredScopes: ["read:catalog"],
  })).rejects.toMatchObject({ code: "CONNECTION_SELECTION_REQUIRED" });

  const selection = await bindConnectionSelection({
    store: live.store,
    actor,
    caller,
    connectionId: fixtures.ambiguousA.connectionId,
    system: "fixture-ambiguous",
    environment: "STAGING",
    eligibleConnectionIds: [fixtures.ambiguousA.connectionId, fixtures.ambiguousB.connectionId],
  });
  const chosen = await resolveEligibleConnection({
    store: live.store,
    actor,
    caller,
    system: "fixture-ambiguous",
    environment: "STAGING",
    requiredScopes: ["read:catalog"],
    selectionId: selection.selectionId,
  });
  expect(chosen.connectionId).toBe(fixtures.ambiguousA.connectionId);

  const firstSecret = await resolveSecretForConnection({ store: live.store, connection: fixtures.rotatable, actor, caller });
  const previousRef = fixtures.rotatable.credentialRef;
  const rotated = await rotateConnection({
    store: live.store,
    actor,
    caller,
    config: testConfig(),
    connectionId: fixtures.rotatable.connectionId,
    secret: `${FIXTURE_CONNECTION_SECRET}_ROTATE_B`,
  });
  expect(rotated.credentialRef).not.toBe(previousRef);
  await expect(live.backend.resolve(previousRef)).rejects.toThrow(/not available/i);
  const after = await resolveSecretForConnection({ store: live.store, connection: rotated, actor, caller });
  expect(after.secret.generation).toBeGreaterThan(firstSecret.secret.generation);

  const [raceRotate, raceRevoke] = await Promise.allSettled([
    rotateConnection({ store: live.store, actor, caller, config: testConfig(), connectionId: fixtures.actor.connectionId, secret: `${FIXTURE_CONNECTION_SECRET}_RACE` }),
    revokeConnection({ store: live.store, actor, caller, config: testConfig(), connectionId: fixtures.actor.connectionId }),
  ]);
  expect(raceRotate.status === "fulfilled" || raceRevoke.status === "fulfilled").toBe(true);
  const afterRace = await live.store.getExternalConnection(fixtures.actor.connectionId);
  if (afterRace?.status === "REVOKED") {
    await expect(resolveSecretForConnection({ store: live.store, connection: afterRace, actor, caller })).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
  }

  const oauth = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/initiate",
    headers: headers(),
    payload: { system: "fixture-oauth", environment: "STAGING", redirectUri: "https://digiai.local/oauth/callback", scopes: ["read:catalog"] },
  });
  expect(oauth.statusCode).toBe(200);
  const pkce = createPkcePair();
  const replay = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/callback",
    headers: headers(),
    payload: { state: "wrong", redirectUri: "https://digiai.local/oauth/callback", codeVerifier: pkce.verifier },
  });
  expect(replay.statusCode).toBe(403);
  const redirect = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/initiate",
    headers: headers(),
    payload: { system: "fixture-oauth", environment: "STAGING", redirectUri: "https://evil.example/steal", scopes: ["read:catalog"] },
  });
  expect(redirect.statusCode).toBe(403);

  const started = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/initiate",
    headers: headers(),
    payload: { system: "fixture-oauth", environment: "STAGING", redirectUri: "https://digiai.local/oauth/callback", scopes: ["read:catalog"] },
  });
  const state = started.json().oauth.state as string;
  const verifier = started.json().oauth.codeVerifier as string;
  const firstCb = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/callback",
    headers: headers("actor-b", "tenant-b", "b-secret"),
    payload: { state, redirectUri: "https://digiai.local/oauth/callback", codeVerifier: verifier },
  });
  expect(firstCb.statusCode).toBe(403);
  const okCb = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/callback",
    headers: headers(),
    payload: { state, redirectUri: "https://digiai.local/oauth/callback", codeVerifier: verifier, fixtureSecret: `${FIXTURE_CONNECTION_SECRET}_OAUTH` },
  });
  expect(okCb.statusCode).toBe(200);
  expect(leak(okCb.json())).toBe(false);
  const replayCb = await live.app.inject({
    method: "POST",
    url: "/internal/oauth/callback",
    headers: headers(),
    payload: { state, redirectUri: "https://digiai.local/oauth/callback", codeVerifier: verifier, fixtureSecret: `${FIXTURE_CONNECTION_SECRET}_OAUTH` },
  });
  expect(replayCb.statusCode).toBe(403);

  const health = await live.app.inject({ method: "GET", url: "/health" });
  expect(health.json().credentials.secureBackend.configured).toBe(true);
  expect(health.json().credentials.secretResolution.serverSideOnly).toBe(true);
  expect(health.json().credentials.realConsequentialActions.enabled).toBe(false);
  expect(health.json().toolConnectors.credentialBackend.configured).toBe(false);
  expect(leak(health.json())).toBe(false);
  expect(JSON.stringify(health.json())).not.toMatch(/credentialRef|DIGI_AI_CONN_|connectedTenants/);

  const executeInject = await live.app.inject({
    method: "POST",
    url: "/v1/actions/x/execute",
    headers: headers(),
    payload: { apiKey: "stolen", accessToken: "tok", refreshToken: "r", clientSecret: "c", connectionId: fixtures.actor.connectionId, credentialRef: "cred_stolen" },
  });
  expect(executeInject.statusCode).toBe(400);

  expect(logs.join("\n")).not.toContain(FIXTURE_SENTINEL_SECRET);
});

test("3C 3D 3E regressions, waiting/unknown, durability, sanitizer, health", async () => {
  const live = await start();
  const actor = { trustId: "TD-A", tenantId: "tenant-a" };
  const caller = { id: "test", via: "s2s" as const };
  await seedFixtureConnections({ store: live.store, config: testConfig(), actor, caller });

  const obj = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" }, idempotencyKey: `noauth-${Math.random()}` },
  });
  const proposed = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: publishPayload,
  });
  expect(proposed.statusCode).toBe(200);
  const before = connectionResolutionStats.secretsResolved;
  const denied = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${proposed.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: {},
  });
  expect(denied.statusCode).toBeGreaterThanOrEqual(400);
  expect(connectionResolutionStats.secretsResolved).toBe(before);

  const waiting = await authorizeAndExecute(live.app, {}, { fixtureMode: "WAITING" });
  expect(waiting.statusCode).toBe(200);
  expect(waiting.json().status).toBe("WAITING");
  const generationBefore = connectionResolutionStats.lastGeneration;
  await rotateConnection({
    store: live.store,
    actor,
    caller,
    config: testConfig(),
    connectionId: (await live.store.listExternalConnections({ actorId: "TD-A", tenantId: "tenant-a", applicationId: "test", system: "fixture-rotate", environment: "STAGING" }))[0].connectionId,
    secret: `${FIXTURE_CONNECTION_SECRET}_WAIT_B`,
  });
  const resumed = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${waiting.json().executionId}/advance`,
    headers: headers(),
  });
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().externalReference || waiting.json().externalReference).toBeTruthy();
  expect(generationBefore === connectionResolutionStats.lastGeneration || connectionResolutionStats.lastGeneration >= generationBefore).toBe(true);

  const unknown = await authorizeAndExecute(live.app, {}, { fixtureMode: "UNKNOWN_OUTCOME" });
  expect(unknown.json().status).toBe("UNKNOWN_OUTCOME");
  const retry = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${unknown.json().executionId}/advance`,
    headers: headers(),
  });
  expect(retry.json().status).toBe("UNKNOWN_OUTCOME");

  const llmObj = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" }, idempotencyKey: `llm-${Math.random()}` },
  });
  const llm = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${llmObj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      ...publishPayload,
      connectorId: "fixture-secured",
      credentialRef: "cred_model",
    },
  });
  expect(llm.statusCode).toBeGreaterThanOrEqual(400);

  const cloned = new MemoryStore();
  for (const row of live.store.externalConnections) await cloned.putExternalConnection(row);
  for (const row of live.store.credentialMetadata) await cloned.putCredentialMetadata(row);
  const persisted = await cloned.getExternalConnection(live.store.externalConnections[0].connectionId);
  expect(persisted?.status).toBeTruthy();
  expect(persisted?.credentialRef).toBeTruthy();
  const secret = await live.backend.resolveUsingMetadata((await cloned.getCredentialMetadata(persisted!.credentialRef))!);
  expect(secret.reveal()).toContain(FIXTURE_SENTINEL_SECRET);
  expect(leak(cloned.externalConnections)).toBe(false);
  expect(leak(cloned.credentialMetadata)).toBe(false);

  process.env.DIGI_AI_CONN_PLATFORM_PROBE = `${FIXTURE_SENTINEL_SECRET}_RAIL`;
  const railway = new RailwayPlatformServiceBackend();
  const meta = await railway.store({
    logicalName: "PLATFORM_PROBE",
    system: "platform",
    environment: "PRODUCTION",
    authenticationMode: "S2S_SECRET",
    scopes: ["read:catalog"],
    ownerType: "PLATFORM_SERVICE",
  });
  const resolved = await railway.resolveUsingMetadata(meta);
  expect(resolved.reveal()).toContain(FIXTURE_SENTINEL_SECRET);
  delete process.env.DIGI_AI_CONN_PLATFORM_PROBE;

  const boom = await live.app.inject({
    method: "POST",
    url: "/internal/credentials/probe",
    headers: headers(),
    payload: { credentialRef: "missing", message: FIXTURE_SENTINEL_SECRET },
  });
  expect(boom.statusCode).toBe(403);
  expect(leak(boom.json())).toBe(false);
});

test("idempotent create and secret-free receipts", async () => {
  const live = await start();
  const body = parseConnectionCreateBody({
    ownerType: "ACTOR",
    system: "fixture-secured",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:catalog"],
    displayLabel: "once",
    secret: `${FIXTURE_CONNECTION_SECRET}_IDEM`,
    idempotencyKey: "same-create",
  });
  const first = await live.app.inject({ method: "POST", url: "/internal/connections", headers: headers(), payload: { ...body, secret: `${FIXTURE_CONNECTION_SECRET}_IDEM`, idempotencyKey: "same-create" } });
  const second = await live.app.inject({ method: "POST", url: "/internal/connections", headers: headers(), payload: { ...body, secret: `${FIXTURE_CONNECTION_SECRET}_IDEM`, idempotencyKey: "same-create" } });
  expect(first.statusCode).toBe(201);
  expect(second.json().connection.connectionId).toBe(first.json().connection.connectionId);
  const executed = await authorizeAndExecute(live.app, {});
  expect(executed.statusCode).toBe(200);
  expect(leak(executed.json())).toBe(false);
  const receipt = JSON.stringify(live.store.actionExecutionReceipts);
  const tools = JSON.stringify(live.store.toolInvocations);
  expect(receipt).not.toContain(FIXTURE_SENTINEL_SECRET);
  expect(tools).not.toContain(FIXTURE_SENTINEL_SECRET);
  expect(JSON.stringify(live.store.connectionAudit)).not.toContain(FIXTURE_SENTINEL_SECRET);
});
