import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { ACTION_SCHEMA_VERSION } from "../src/contracts/execution.js";
import { PLATFORM_JOBS_ACTION_INTEGRATION } from "../src/execution/jobs.js";
import { fixturePublisher, fixtureStats, resetFixtureStats } from "../src/execution/executors.js";
import { registeredActionTypes, resolveExecutor } from "../src/execution/registry.js";
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

async function start(opts: { store?: MemoryStore; config?: Partial<AppConfig> } = {}) {
  const store = opts.store ?? new MemoryStore();
  const app = buildApp(testConfig(opts.config), {
    provider: new TestProvider(),
    resolver: actors,
    store,
    digipedia: { async readPublished() { return { ok: false, error: "not_found", message: "none" }; } },
    diginews: { async readPublic() { return { ok: false, error: "not_found", message: "none" }; } },
  });
  apps.push(app);
  return { app, store };
}

afterEach(async () => {
  resetFixtureStats();
  while (apps.length) await apps.pop()?.close();
});

function headers(token = "actor-a", caller = "test", key = "test-secret") {
  return {
    "x-digi-ai-caller": caller,
    "x-digi-ai-caller-key": key,
    authorization: `Bearer ${token}`,
  };
}

const publishParams = { contentReference: "draft-1", contentDigest: "digest-v1", destination: "fixture", visibility: "public" };
const publishTarget = { resourceType: "fixture-post", resourceId: "draft-1" };

async function seed(app: Awaited<ReturnType<typeof start>>["app"], key = `obj-${Math.random()}`) {
  const obj = await app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" }, idempotencyKey: key },
  });
  expect(obj.statusCode).toBe(200);
  return obj.json().objectiveId as string;
}

async function propose(app: Awaited<ReturnType<typeof start>>["app"], objectiveId: string, payload: Record<string, unknown>, hdr = headers()) {
  return app.inject({
    method: "POST",
    url: `/v1/objectives/${objectiveId}/actions`,
    headers: hdr,
    payload,
  });
}

async function approve(app: Awaited<ReturnType<typeof start>>["app"], actionIntentId: string, hdr = headers()) {
  return app.inject({
    method: "POST",
    url: `/v1/actions/${actionIntentId}/decision`,
    headers: hdr,
    payload: { decision: "APPROVE" },
  });
}

async function authorizePublish(app: Awaited<ReturnType<typeof start>>["app"], extra: Record<string, unknown> = {}) {
  const objectiveId = await seed(app);
  const proposed = await propose(app, objectiveId, {
    actionClass: "PUBLISH",
    actionType: "PUBLISH_FIXTURE_POST",
    target: publishTarget,
    parameters: publishParams,
    ...extra,
  });
  expect(proposed.json().decision.outcome).toBe("HUMAN_DECISION_REQUIRED");
  const approved = await approve(app, proposed.json().intent.actionIntentId);
  expect(approved.json().authorization.status).toBe("issued");
  return { objectiveId, intentId: proposed.json().intent.actionIntentId as string, authorizationId: approved.json().authorization.authorizationId as string };
}

test("1-27 contract, registry, claim, success receipt, replay", async () => {
  expect(registeredActionTypes()).toEqual(["PUBLISH_FIXTURE_POST", "MESSAGE_FIXTURE", "SPEND_FIXTURE", "DEPLOY_FIXTURE", "DELETE_FIXTURE"]);
  expect(resolveExecutor("PUBLISH_MYBRANDOS_POST" as never)).toBeUndefined();
  expect(resolveExecutor("PUBLISH_FIXTURE_POST")?.executorId).toBe("fixture-publisher");
  expect(PLATFORM_JOBS_ACTION_INTEGRATION).toBe("BRIDGE_DEFINED");
  const live = await start();
  const authorized = await authorizePublish(live.app);
  const first = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${authorized.intentId}/execute`,
    headers: headers(),
    payload: { authorizationId: authorized.authorizationId },
  });
  expect(first.statusCode).toBe(200);
  expect(first.json().status).toBe("SUCCEEDED");
  expect(first.json().executed).toBe(true);
  expect(first.json().receiptStatus).toBe("SUCCEEDED");
  expect(first.json().executorId).toBe("fixture-publisher");
  expect(first.json().actionSchemaVersion).toBe(ACTION_SCHEMA_VERSION);
  expect(first.json().resultReference).toMatch(/^fixture:publication:/);
  expect(fixtureStats.invocations).toBe(1);
  const auth = live.store.actionAuthorizations.find((row) => row.authorizationId === authorized.authorizationId)!;
  expect(auth.status).toBe("consumed");
  expect(auth.claimedByExecutionId).toBe(first.json().executionId);
  const execution = live.store.actionExecutions[0]!;
  expect(execution.externalIdempotencyKey).toBe(execution.executionId);
  expect(live.store.executionAudit.map((row) => row.eventType)).toEqual(expect.arrayContaining([
    "EXECUTION_REQUESTED",
    "AUTHORIZATION_CLAIMED",
    "EXECUTOR_RESOLVED",
    "EXECUTION_STARTED",
    "EXECUTION_SUCCEEDED",
  ]));
  const replay = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${authorized.intentId}/execute`,
    headers: headers(),
    payload: { authorizationId: authorized.authorizationId },
  });
  expect(replay.json().executionId).toBe(first.json().executionId);
  expect(fixtureStats.invocations).toBe(1);
  expect(live.store.actionExecutions).toHaveLength(1);
  expect(live.store.creditEntries).toHaveLength(0);
});

test("28-45 no authorization, expiry, revoke, digest/target/amount/currency/env/artifact swaps", async () => {
  const live = await start();
  const objectiveId = await seed(live.app, "swap");
  const proposed = await propose(live.app, objectiveId, {
    actionClass: "PUBLISH",
    actionType: "PUBLISH_FIXTURE_POST",
    target: publishTarget,
    parameters: publishParams,
  });
  const unapproved = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${proposed.json().intent.actionIntentId}/execute`,
    headers: headers(),
  });
  expect(unapproved.statusCode).toBe(403);
  expect(unapproved.json().error).toBe("AUTHORITY_INVALID");
  expect(fixtureStats.invocations).toBe(0);

  const expired = await authorizePublish(live.app);
  const auth = live.store.actionAuthorizations.find((row) => row.authorizationId === expired.authorizationId)!;
  auth.expiresAt = "2000-01-01T00:00:00.000Z";
  const late = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${expired.intentId}/execute`,
    headers: headers(),
  });
  expect(late.statusCode).toBe(403);
  expect(late.json().error).toBe("AUTHORIZATION_EXPIRED");
  expect(fixtureStats.invocations).toBe(0);

  await live.app.inject({
    method: "POST",
    url: "/v1/authority/grants",
    headers: headers(),
    payload: { allowedActionClasses: ["PUBLISH"], expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  const grantBacked = await propose(live.app, objectiveId, {
    actionClass: "PUBLISH",
    actionType: "PUBLISH_FIXTURE_POST",
    target: { resourceType: "fixture-post", resourceId: "draft-grant" },
    parameters: { ...publishParams, contentReference: "draft-grant" },
  });
  expect(grantBacked.json().decision.outcome).toBe("AUTHORIZED_BY_GRANT");
  const grantId = live.store.authorityGrants[0]!.grantId;
  await live.app.inject({ method: "POST", url: `/v1/authority/grants/${grantId}/revoke`, headers: headers() });
  const revoked = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${grantBacked.json().intent.actionIntentId}/execute`,
    headers: headers(),
  });
  expect(revoked.statusCode).toBe(403);
  expect(fixtureStats.invocations).toBe(0);

  const message = await propose(live.app, objectiveId, {
    actionClass: "MESSAGE",
    actionType: "MESSAGE_FIXTURE",
    target: { resourceType: "conversation", resourceId: "conv-1" },
    parameters: { messageDigest: "A", recipient: "user-1" },
  });
  await approve(live.app, message.json().intent.actionIntentId);
  const digestSwap = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${message.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { parameters: { messageDigest: "B", recipient: "user-1" } },
  });
  expect(digestSwap.statusCode).toBe(403);
  expect(digestSwap.json().error).toBe("PARAMETER_MISMATCH");

  const targetSwap = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${message.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { target: { resourceType: "conversation", resourceId: "conv-2" } },
  });
  expect(targetSwap.statusCode).toBe(403);

  const spend = await propose(live.app, objectiveId, {
    actionClass: "SPEND",
    actionType: "SPEND_FIXTURE",
    target: { resourceType: "fixture-value", resourceId: "pay-1" },
    parameters: { amount: 25000, currency: "NGN", recipient: "merchant-a" },
  });
  await approve(live.app, spend.json().intent.actionIntentId);
  const amount = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${spend.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { parameters: { amount: 25001, currency: "NGN", recipient: "merchant-a" } },
  });
  expect(amount.statusCode).toBe(403);
  const currency = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${spend.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { parameters: { amount: 25000, currency: "USD", recipient: "merchant-a" } },
  });
  expect(currency.statusCode).toBe(403);

  const deploy = await propose(live.app, objectiveId, {
    actionClass: "DEPLOY",
    actionType: "DEPLOY_FIXTURE",
    target: { resourceType: "service", resourceId: "ecommerceos" },
    parameters: { artifact: "commit-A", environment: "staging", service: "ecommerceos" },
  });
  await approve(live.app, deploy.json().intent.actionIntentId);
  const env = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${deploy.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { parameters: { artifact: "commit-A", environment: "production", service: "ecommerceos" } },
  });
  expect(env.statusCode).toBe(403);
  const artifact = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${deploy.json().intent.actionIntentId}/execute`,
    headers: headers(),
    payload: { parameters: { artifact: "commit-B", environment: "staging", service: "ecommerceos" } },
  });
  expect(artifact.statusCode).toBe(403);
  expect(fixtureStats.invocations).toBe(0);
});

test("46-65 concurrency, crash, unknown, waiting, reconcile, cancel, native idempotency", async () => {
  const live = await start();
  const authorized = await authorizePublish(live.app);
  const [a, b] = await Promise.all([
    live.app.inject({ method: "POST", url: `/v1/actions/${authorized.intentId}/execute`, headers: headers(), payload: {} }),
    live.app.inject({ method: "POST", url: `/v1/actions/${authorized.intentId}/execute`, headers: headers(), payload: {} }),
  ]);
  expect(a.json().executionId).toBe(b.json().executionId);
  expect(live.store.actionExecutions).toHaveLength(1);
  expect(fixtureStats.invocations).toBe(1);

  resetFixtureStats();
  const deferred = await authorizePublish(live.app);
  const parked = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${deferred.intentId}/execute`,
    headers: headers(),
    payload: { deferInvocation: true },
  });
  expect(parked.json().status).toBe("AUTHORIZED");
  expect(fixtureStats.invocations).toBe(0);
  const cancelled = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${parked.json().executionId}/cancel`,
    headers: headers(),
  });
  expect(cancelled.json().status).toBe("CANCELLED");
  expect(fixtureStats.invocations).toBe(0);

  const crash = await authorizePublish(live.app);
  const claimed = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${crash.intentId}/execute`,
    headers: headers(),
    payload: { deferInvocation: true },
  });
  expect(claimed.json().status).toBe("AUTHORIZED");
  const resumed = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${claimed.json().executionId}/advance`,
    headers: headers(),
  });
  expect(resumed.json().status).toBe("SUCCEEDED");
  expect(fixtureStats.invocations).toBe(1);

  resetFixtureStats();
  const unknownAuth = await authorizePublish(live.app);
  const unknown = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${unknownAuth.intentId}/execute`,
    headers: headers(),
    payload: { fixtureMode: "UNKNOWN_OUTCOME" },
  });
  expect(unknown.json().status).toBe("UNKNOWN_OUTCOME");
  expect(unknown.json().receiptStatus).toBe("UNKNOWN_OUTCOME");
  const retry = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${unknown.json().executionId}/advance`,
    headers: headers(),
  });
  expect(retry.json().status).toBe("UNKNOWN_OUTCOME");
  expect(fixtureStats.invocations).toBe(1);
  const reconciled = await live.app.inject({
    method: "POST",
    url: `/internal/action-executions/${unknown.json().executionId}/reconcile`,
    headers: headers(),
  });
  expect(reconciled.json().status).toBe("SUCCEEDED");
  expect(reconciled.json().executionId).toBe(unknown.json().executionId);
  expect(live.store.executionAudit.some((row) => row.eventType === "EXECUTION_RECONCILED")).toBe(true);
  expect(fixtureStats.invocations).toBe(1);

  resetFixtureStats();
  const waitingAuth = await authorizePublish(live.app);
  const waiting = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${waitingAuth.intentId}/execute`,
    headers: headers(),
    payload: { fixtureMode: "WAITING" },
  });
  expect(waiting.json().status).toBe("WAITING");
  const advanced = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${waiting.json().executionId}/advance`,
    headers: headers(),
  });
  expect(advanced.json().status).toBe("SUCCEEDED");
  expect(advanced.json().externalReference).toBe(waiting.json().externalReference);
  expect(fixtureStats.effects.size).toBe(1);

  const successCancel = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${advanced.json().executionId}/cancel`,
    headers: headers(),
  });
  expect(successCancel.json().status).toBe("SUCCEEDED");

  resetFixtureStats();
  await fixturePublisher.execute({
    executionId: "exec-native",
    externalIdempotencyKey: "stable-key",
    actionType: "PUBLISH_FIXTURE_POST",
    actionClass: "PUBLISH",
    parameters: publishParams,
    target: publishTarget,
    fixtureMode: "UNKNOWN_OUTCOME",
  });
  await fixturePublisher.execute({
    executionId: "exec-native",
    externalIdempotencyKey: "stable-key",
    actionType: "PUBLISH_FIXTURE_POST",
    actionClass: "PUBLISH",
    parameters: publishParams,
    target: publishTarget,
  });
  expect(fixtureStats.effects.get("stable-key")).toBe(1);
});

test("66-85 fixtures, security, objective integration, health", async () => {
  const live = await start();
  const objectiveId = await seed(live.app, "fix");
  for (const [actionClass, actionType, target, parameters] of [
    ["MESSAGE", "MESSAGE_FIXTURE", { resourceType: "conversation", resourceId: "c1" }, { messageDigest: "m1", recipient: "r1" }],
    ["SPEND", "SPEND_FIXTURE", { resourceType: "fixture-value", resourceId: "v1" }, { amount: 100, currency: "NGN", recipient: "r1" }],
    ["DEPLOY", "DEPLOY_FIXTURE", { resourceType: "service", resourceId: "svc" }, { artifact: "a1", environment: "staging", service: "svc" }],
    ["DELETE", "DELETE_FIXTURE", { resourceType: "fixture-resource", resourceId: "res-1" }, { resourceType: "fixture-resource", resourceId: "res-1" }],
  ] as const) {
    const row = await propose(live.app, objectiveId, { actionClass, actionType, target, parameters });
    await approve(live.app, row.json().intent.actionIntentId);
    const exec = await live.app.inject({
      method: "POST",
      url: `/v1/actions/${row.json().intent.actionIntentId}/execute`,
      headers: headers(),
    });
    expect(exec.json().status).toBe("SUCCEEDED");
    expect(exec.json().resultReference).toMatch(/^fixture:/);
  }

  const real = await propose(live.app, objectiveId, {
    actionClass: "PUBLISH",
    actionType: "PUBLISH_MYBRANDOS_POST",
    target: { resourceType: "mybrandos-post", resourceId: "draft-1" },
    parameters: { contentDigest: "x", destination: "mybrandos", visibility: "public" },
  });
  await approve(live.app, real.json().intent.actionIntentId);
  const realExec = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${real.json().intent.actionIntentId}/execute`,
    headers: headers(),
  });
  expect(realExec.statusCode).toBe(409);
  expect(realExec.json().error).toBe("EXECUTOR_NOT_FOUND");

  const owned = await authorizePublish(live.app);
  const theft = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${owned.intentId}/execute`,
    headers: headers("actor-b", "tenant-b", "b-secret"),
    payload: { authorizationId: owned.authorizationId },
  });
  expect(theft.statusCode).toBe(403);
  const executed = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${owned.intentId}/execute`,
    headers: headers(),
  });
  const inspectB = await live.app.inject({
    method: "GET",
    url: `/v1/action-executions/${executed.json().executionId}`,
    headers: headers("actor-b", "tenant-b", "b-secret"),
  });
  expect(inspectB.statusCode).toBe(403);
  const advanceB = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${executed.json().executionId}/advance`,
    headers: headers("actor-b", "tenant-b", "b-secret"),
  });
  expect(advanceB.statusCode).toBe(403);
  const cancelB = await live.app.inject({
    method: "POST",
    url: `/v1/action-executions/${executed.json().executionId}/cancel`,
    headers: headers("actor-b", "tenant-b", "b-secret"),
  });
  expect(cancelB.statusCode).toBe(403);
  const reconcileB = await live.app.inject({
    method: "POST",
    url: `/internal/action-executions/${executed.json().executionId}/reconcile`,
    headers: headers("actor-b", "tenant-b", "b-secret"),
  });
  expect(reconcileB.statusCode).toBe(403);

  const spoof = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${owned.intentId}/execute`,
    headers: headers(),
    payload: { actorId: "TD-B", tenantId: "tenant-b", applicationId: "digi-twin", executorId: "fixture-deployer" },
  });
  expect(spoof.statusCode).toBe(400);

  const restarted = new MemoryStore();
  restarted.actionIntents.push(...live.store.actionIntents);
  restarted.actionAuthorizations.push(...live.store.actionAuthorizations);
  restarted.actionExecutions.push(...live.store.actionExecutions);
  restarted.actionExecutionRequests.push(...live.store.actionExecutionRequests);
  restarted.actionExecutionReceipts.push(...live.store.actionExecutionReceipts);
  const again = await start({ store: restarted });
  const inspect = await again.app.inject({
    method: "GET",
    url: `/v1/action-executions/${executed.json().executionId}`,
    headers: headers(),
  });
  expect(inspect.json().executionId).toBe(executed.json().executionId);
  expect(inspect.json().status).toBe("SUCCEEDED");

  const waitingHuman = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "publish_fixture post", constraints: { orchestrationFixture: "action-publish-fixture" } },
  });
  expect(waitingHuman.json().status).toBe("WAITING_FOR_HUMAN");
  const intent = live.store.actionIntents.find((row) => row.objectiveId === waitingHuman.json().objectiveId)!;
  await approve(live.app, intent.actionIntentId);
  const advanced = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${waitingHuman.json().objectiveId}/advance`,
    headers: headers(),
  });
  expect(advanced.json().status).toBe("COMPLETED");
  expect(advanced.json().outputs.some((row: { data?: { executed?: boolean; fixture?: boolean } }) => row.data?.executed && row.data?.fixture)).toBe(true);

  const optional = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "action-optional-fail", constraints: { orchestrationFixture: "action-optional-fail" } },
  });
  const optionalIntent = live.store.actionIntents.find((row) => row.objectiveId === optional.json().objectiveId)!;
  await approve(live.app, optionalIntent.actionIntentId);
  const optionalDone = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${optional.json().objectiveId}/advance`,
    headers: headers(),
  });
  expect(optionalDone.json().status).toBe("PARTIAL");
  expect(optionalDone.json().completedSteps).toContain("write");

  const required = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "action-required-fail", constraints: { orchestrationFixture: "action-required-fail" } },
  });
  const requiredIntent = live.store.actionIntents.find((row) => row.objectiveId === required.json().objectiveId)!;
  await approve(live.app, requiredIntent.actionIntentId);
  const requiredDone = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${required.json().objectiveId}/advance`,
    headers: headers(),
  });
  expect(requiredDone.json().status).toBe("FAILED");

  const unknownObj = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "action-unknown", constraints: { orchestrationFixture: "action-unknown" } },
  });
  const unknownIntent = live.store.actionIntents.find((row) => row.objectiveId === unknownObj.json().objectiveId)!;
  await approve(live.app, unknownIntent.actionIntentId);
  const unknownDone = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${unknownObj.json().objectiveId}/advance`,
    headers: headers(),
  });
  expect(unknownDone.json().status).toBe("UNKNOWN_ACTION_OUTCOME");

  const frozen3c = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "publish_mybrandos post", constraints: { orchestrationFixture: "authority-publish" } },
  });
  expect(frozen3c.json().status).toBe("WAITING_FOR_HUMAN");

  const anon = await live.app.inject({ method: "POST", url: `/v1/actions/${owned.intentId}/execute`, payload: {} });
  expect(anon.statusCode).toBe(401);
  const health = (await live.app.inject({ method: "GET", url: "/health" })).json();
  expect(health.actionExecution.supported).toBe(true);
  expect(health.actionExecution.authorizationRequired).toBe(true);
  expect(health.actionExecution.realExternalExecutors.enabled).toBe(false);
  expect(health.actionExecution.fixtureExecutors.available).toBe(true);
  expect(health.actionExecution.unknownOutcomeSupported).toBe(true);
  expect(health.authority.externalActionExecution.supported).toBe(false);
  expect(health.economics.metering.mode).toBe("observe");
  expect(JSON.stringify(health)).not.toMatch(/TD-A|digest-v1|test-secret|fixture-op-/);
  expect(live.store.creditEntries).toHaveLength(0);
});
