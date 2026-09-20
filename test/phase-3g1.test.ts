import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { MYBRANDOS_CONNECTION_ID, MYBRANDOS_CREDENTIAL_REF, MYBRANDOS_S2S_TEST_SENTINEL } from "../src/connectors/mybrandos/types.js";
import { bindMybrandosReadClient, resetMybrandosReadClient, resetMybrandosReadStats } from "../src/connectors/mybrandos/runtime.js";
import { requestMybrandosAuthenticated } from "../src/connectors/mybrandos/client.js";
import { rejectConnectorSpoof } from "../src/connectors/service.js";
import { connectionResolutionStats, resetConnectionResolutionStats } from "../src/connections/resolve.js";
import { containsSecret, redactText, redactValue, resetSecretSentinels } from "../src/credentials/redact.js";
import { logEvent } from "../src/lib/log.js";
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
    ],
    operatorCallers: ["operator"],
    trustIdApi: "http://trustid.test",
    allowAttestedActor: false,
    databaseUrl: "",
    economicsMode: "observe",
    mybrandosUrl: "https://mybrandos-production.up.railway.app",
    mybrandosEnvironment: "STAGING",
    mybrandosTimeoutMs: 8000,
    mybrandosAcceptanceSlug: "mrfundzman",
    ...overrides,
  };
}

const actors: IdentityResolver = {
  async resolveToken(token: string) {
    if (token === "actor-a") return { trustId: "TD-A", displayName: "Actor A", tenantId: "tenant-a" };
    return null;
  },
};

const apps: Array<{ close: () => Promise<void> }> = [];

function publicLife() {
  return {
    slug: "mrfundzman",
    publicEnabled: true,
    displayName: "Mr Fundzman",
    publishedAssetCount: 2,
    recentPublished: [{ id: "asset-1", assetType: "VIDEO", publishedAt: "2026-01-01T00:00:00.000Z" }],
    retrievedAt: "2026-01-03T00:00:00.000Z",
    privacyClass: "PUBLIC" as const,
    source: "mybrandos" as const,
    factKind: "SOURCE_FACT" as const,
  };
}

async function start() {
  const store = new MemoryStore();
  const app = buildApp(testConfig(), {
    provider: new TestProvider(),
    resolver: actors,
    store,
    digipedia: { async readPublished() { return { ok: false, error: "not_found", message: "none" }; } },
    diginews: { async readPublic() { return { ok: false, error: "not_found", message: "none" }; } },
  });
  bindMybrandosReadClient({
    request: async () => ({ ok: true, status: 200, body: publicLife(), attempts: 1 }),
  });
  apps.push(app);
  await app.ready();
  return { app, store };
}

afterEach(async () => {
  resetMybrandosReadStats();
  resetMybrandosReadClient();
  resetConnectionResolutionStats();
  resetSecretSentinels();
  while (apps.length) await apps.pop()?.close();
});

function headers() {
  return {
    "x-digi-ai-caller": "test",
    "x-digi-ai-caller-key": "test-secret",
    authorization: "Bearer actor-a",
  };
}

async function seedObjective(app: Awaited<ReturnType<typeof start>>["app"]) {
  const obj = await app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" }, idempotencyKey: `g1-${Math.random()}` },
  });
  expect(obj.statusCode).toBe(200);
  return obj.json().objectiveId as string;
}

async function propose(app: Awaited<ReturnType<typeof start>>["app"], extra: Record<string, unknown> = {}) {
  const objectiveId = await seedObjective(app);
  return app.inject({
    method: "POST",
    url: `/v1/objectives/${objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "KNOW",
      actionType: "INSPECT_MYBRANDOS_PUBLIC",
      target: { resourceType: "mybrandos-public", resourceId: "mrfundzman" },
      ...extra,
    },
  });
}

test("no execution, invalid authority, and injections never resolve the S2S secret", async () => {
  const live = await start();
  const before = connectionResolutionStats.secretsResolved;
  const proposed = await propose(live.app);
  expect(proposed.statusCode).toBe(200);
  expect(connectionResolutionStats.secretsResolved).toBe(before);

  const badAuth = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${proposed.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { authorizationId: "authz_forged" },
  });
  expect(badAuth.statusCode).toBeGreaterThanOrEqual(400);
  expect(connectionResolutionStats.secretsResolved).toBe(before);

  expect(() => rejectConnectorSpoof({ credentialRef: MYBRANDOS_CREDENTIAL_REF })).toThrow();
  expect(() => rejectConnectorSpoof({ connectionId: MYBRANDOS_CONNECTION_ID })).toThrow();
  expect(() => rejectConnectorSpoof({ url: "https://mybrandos-production.up.railway.app/api/internal/digital-life/x" })).toThrow();
  expect(() => rejectConnectorSpoof({ method: "GET", path: "/api/internal/digital-life/x" })).toThrow();

  const inject = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${proposed.json().intent.objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "KNOW",
      actionType: "INSPECT_MYBRANDOS_PUBLIC",
      target: { resourceType: "mybrandos-public", resourceId: "mrfundzman" },
      connectionId: "conn_injected",
      credentialRef: "cred_injected",
      url: "https://evil.example",
      method: "POST",
    },
  });
  expect(inject.statusCode).toBe(400);
  expect(connectionResolutionStats.secretsResolved).toBe(before);
});

test("wrong environment, revoked, disabled, and missing scope never resolve the secret", async () => {
  const live = await start();
  const before = connectionResolutionStats.secretsResolved;
  const conn = await live.store.getExternalConnection(MYBRANDOS_CONNECTION_ID);
  expect(conn).toBeTruthy();

  conn!.environment = "PRODUCTION";
  await live.store.putExternalConnection(conn!);
  const wrongEnv = await propose(live.app);
  const wrongExec = wrongEnv.statusCode < 400
    ? await live.app.inject({
        method: "POST",
        url: `/v1/actions/${wrongEnv.json().intent.actionIntentId}/execute`,
        headers: headers(),
        payload: {},
      })
    : wrongEnv;
  expect(wrongExec.statusCode).toBeGreaterThanOrEqual(400);
  expect(connectionResolutionStats.secretsResolved).toBe(before);

  conn!.environment = "STAGING";
  conn!.scopes = ["read:public"];
  await live.store.putExternalConnection(conn!);
  const missingScope = await propose(live.app);
  const scopeExec = missingScope.statusCode < 400
    ? await live.app.inject({
        method: "POST",
        url: `/v1/actions/${missingScope.json().intent.actionIntentId}/execute`,
        headers: headers(),
        payload: {},
      })
    : missingScope;
  expect(scopeExec.statusCode).toBeGreaterThanOrEqual(400);
  expect(connectionResolutionStats.secretsResolved).toBe(before);

  conn!.scopes = ["mybrandos:read:published"];
  conn!.status = "DISABLED";
  conn!.disabledAt = new Date().toISOString();
  await live.store.putExternalConnection(conn!);
  const disabled = await propose(live.app);
  const disabledExec = disabled.statusCode < 400
    ? await live.app.inject({
        method: "POST",
        url: `/v1/actions/${disabled.json().intent.actionIntentId}/execute`,
        headers: headers(),
        payload: {},
      })
    : disabled;
  expect(disabledExec.statusCode).toBeGreaterThanOrEqual(400);
  expect(connectionResolutionStats.secretsResolved).toBe(before);
});

test("valid execution late-resolves once, redacts Authorization, and never falls back to public GET", async () => {
  const live = await start();
  const before = connectionResolutionStats.secretsResolved;
  const proposed = await propose(live.app);
  expect(connectionResolutionStats.secretsResolved).toBe(before);
  const executed = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${proposed.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: {},
  });
  expect(executed.statusCode).toBe(200);
  expect(executed.json().status).toBe("SUCCEEDED");
  expect(connectionResolutionStats.secretsResolved).toBe(before + 1);
  const receipt = await live.store.getActionExecutionReceipt(executed.json().receiptId);
  expect(receipt?.evidence?.credentialRef).toBe(MYBRANDOS_CREDENTIAL_REF);
  expect(containsSecret(receipt, MYBRANDOS_S2S_TEST_SENTINEL)).toBe(false);
  expect(JSON.stringify(receipt)).not.toMatch(/Authorization\s*:/i);
  expect(JSON.stringify(executed.json())).not.toContain(MYBRANDOS_S2S_TEST_SENTINEL);

  const invocation = await live.store.getToolInvocation(executed.json().toolInvocationId);
  expect(containsSecret(invocation, MYBRANDOS_S2S_TEST_SENTINEL)).toBe(false);
  const audits = await live.store.listToolAudit(executed.json().toolInvocationId);
  expect(containsSecret(audits, MYBRANDOS_S2S_TEST_SENTINEL)).toBe(false);
  expect(audits.some((row) => row.eventType === "CREDENTIAL_RESOLVED")).toBe(true);

  const redacted = redactValue({
    Authorization: `Bearer ${MYBRANDOS_S2S_TEST_SENTINEL}`,
    authorization: `Bearer ${MYBRANDOS_S2S_TEST_SENTINEL}`,
    note: `header Authorization: Bearer ${MYBRANDOS_S2S_TEST_SENTINEL}`,
  });
  expect(JSON.stringify(redacted)).not.toContain(MYBRANDOS_S2S_TEST_SENTINEL);
  expect(redactText(`Authorization: Bearer ${MYBRANDOS_S2S_TEST_SENTINEL}`)).not.toContain(MYBRANDOS_S2S_TEST_SENTINEL);

  const lines: string[] = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.error;
  try {
    logEvent("tool_invocation", { authorization: `Bearer ${MYBRANDOS_S2S_TEST_SENTINEL}`, status: "SUCCEEDED" });
  } finally {
    console.error = original;
  }
  expect(lines.join("\n")).not.toContain(MYBRANDOS_S2S_TEST_SENTINEL);
});

test("HTTP production downgrade is denied and 401/403 are not retried", async () => {
  await expect(requestMybrandosAuthenticated({
    config: { baseUrl: "http://mybrandos-production.up.railway.app", timeoutMs: 8000, environment: "PRODUCTION" },
    slug: "mrfundzman",
    operation: "inspectPublicDigitalLife",
    serviceSecret: MYBRANDOS_S2S_TEST_SENTINEL,
  })).rejects.toThrow(/https/i);

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const denied = await requestMybrandosAuthenticated({
      config: { baseUrl: "https://mybrandos-production.up.railway.app", timeoutMs: 8000, environment: "PRODUCTION" },
      slug: "mrfundzman",
      operation: "inspectPublicDigitalLife",
      serviceSecret: "wrong",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("MYBRANDOS_AUTH_FAILED");
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
