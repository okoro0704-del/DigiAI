import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { actionDigest } from "../src/authority/digest.js";
import { evaluateAuthority } from "../src/authority/evaluate.js";
import { classRank, strongestClass } from "../src/authority/policy.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { ACTION_CLASSES } from "../src/contracts/authority.js";
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
  while (apps.length) await apps.pop()?.close();
});

function headers(token = "actor-a", caller = "test", key = "test-secret") {
  return {
    "x-digi-ai-caller": caller,
    "x-digi-ai-caller-key": key,
    authorization: `Bearer ${token}`,
  };
}

test("1-13 classification, automatic CREATE, consequential default", async () => {
  expect(ACTION_CLASSES).toEqual(["KNOW", "THINK", "CREATE", "CHANGE", "PUBLISH", "MESSAGE", "SPEND", "DEPLOY", "DELETE"]);
  expect(classRank("DELETE")).toBeGreaterThan(classRank("CHANGE"));
  expect(strongestClass(["CHANGE", "PUBLISH"])).toBe("PUBLISH");
  const live = await start();
  const create = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" } },
  });
  expect(create.statusCode).toBe(200);
  expect(create.json().status).toBe("COMPLETED");
  expect(create.json().outputs[0]?.data?.executed).toBe(false);
  const publish = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "publish_mybrandos post", constraints: { orchestrationFixture: "authority-publish" } },
  });
  expect(publish.json().status).toBe("WAITING_FOR_HUMAN");
  expect(publish.json().completedSteps).toContain("write");
  expect(JSON.stringify(publish.json())).not.toMatch(/published|tweeted|deployed to production/i);
});

test("14-32 grants, expiry, revocation, spend, currency, deploy, delete", async () => {
  const live = await start();
  const grant = await live.app.inject({
    method: "POST",
    url: "/v1/authority/grants",
    headers: headers(),
    payload: { allowedActionClasses: ["SPEND"], limits: { maxValue: 50000, currency: "NGN" }, expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  expect(grant.statusCode).toBe(200);
  const spendOk = await live.app.inject({
    method: "POST",
    url: "/v1/objectives/none/actions",
    headers: headers(),
    payload: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "op-1" },
      parameters: { amount: 25000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  expect(spendOk.statusCode).toBe(404);
  const obj = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" }, idempotencyKey: "o-spend" },
  });
  const spend = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "op-1" },
      parameters: { amount: 25000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  expect(spend.json().decision.outcome).toBe("AUTHORIZED_BY_GRANT");
  expect(spend.json().executed).toBe(false);
  const over = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "op-2" },
      parameters: { amount: 60000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  expect(over.json().decision.reasonCode).toBe("VALUE_LIMIT_EXCEEDED");
  const usd = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "op-3" },
      parameters: { amount: 25, currency: "USD", recipient: "merchant-a" },
    },
  });
  expect(usd.json().decision.reasonCode).toBe("CURRENCY_MISMATCH");
  const expired = await live.app.inject({
    method: "POST",
    url: "/v1/authority/grants",
    headers: headers(),
    payload: { allowedActionClasses: ["MESSAGE"], expiresAt: "2020-01-01T00:00:00.000Z", resourceConstraints: { resourceType: "elfcom-conversation", resourceId: "conv-a" } },
  });
  const late = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "MESSAGE",
      actionType: "SEND_ELFCOM_MESSAGE",
      target: { resourceType: "elfcom-conversation", resourceId: "conv-a" },
      parameters: { conversationId: "conv-a", messageDigest: "x" },
    },
  });
  expect(expired.statusCode).toBe(200);
  expect(["EXPIRED", "HUMAN_DECISION_REQUIRED"]).toContain(late.json().decision.outcome);
  await live.app.inject({ method: "POST", url: `/v1/authority/grants/${grant.json().grant.grantId}/revoke`, headers: headers() });
  const after = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "SPEND",
      actionType: "TRANSFER_FINPROVE_VALUE",
      target: { resourceType: "finprove-value", resourceId: "op-4" },
      parameters: { amount: 1000, currency: "NGN", recipient: "merchant-a" },
    },
  });
  expect(["REVOKED", "HUMAN_DECISION_REQUIRED"]).toContain(after.json().decision.outcome);
  expect(live.store.authorityAudit.some((row) => row.eventType === "GRANT_CREATED")).toBe(true);
  expect(live.store.authorityAudit.some((row) => row.eventType === "GRANT_REVOKED")).toBe(true);
  expect(live.store.creditEntries).toHaveLength(0);
});

test("33-50 human decision, digest, one-time consume, cancel, 3B wait/deny", async () => {
  const live = await start();
  const publish = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "publish_mybrandos post", constraints: { orchestrationFixture: "authority-publish" }, idempotencyKey: "pub-1" },
  });
  expect(publish.json().status).toBe("WAITING_FOR_HUMAN");
  const intent = live.store.actionIntents[0]!;
  const approved = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${intent.actionIntentId}/decision`,
    headers: headers(),
    payload: { decision: "APPROVE" },
  });
  expect(approved.json().authorization.status).toBe("issued");
  expect(approved.json().executed).toBe(false);
  const resumed = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${publish.json().objectiveId}/advance`,
    headers: headers(),
  });
  expect(resumed.json().status).toBe("COMPLETED");
  expect(resumed.json().outputs.some((row: { data?: { executed?: boolean } }) => row.data?.executed === false)).toBe(true);
  const consume = await live.app.inject({
    method: "POST",
    url: "/internal/authority/consume",
    headers: headers(),
    payload: { authorizationId: approved.json().authorization.authorizationId },
  });
  expect(consume.statusCode).toBe(200);
  const replay = await live.app.inject({
    method: "POST",
    url: "/internal/authority/consume",
    headers: headers(),
    payload: { authorizationId: approved.json().authorization.authorizationId },
  });
  expect(replay.statusCode).toBe(409);

  const digestA = actionDigest({
    actionClass: "PUBLISH",
    actionType: "PUBLISH_MYBRANDOS_POST",
    target: { resourceType: "mybrandos-post", resourceId: "draft-1" },
    parameters: { contentDigest: "v1", destination: "mybrandos", visibility: "public", contentReference: "draft-1" },
  });
  const digestB = actionDigest({
    actionClass: "PUBLISH",
    actionType: "PUBLISH_MYBRANDOS_POST",
    target: { resourceType: "mybrandos-post", resourceId: "draft-1" },
    parameters: { contentDigest: "v2", destination: "mybrandos", visibility: "public", contentReference: "draft-1" },
  });
  expect(digestA).not.toBe(digestB);

  const optional = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "optional publish", constraints: { orchestrationFixture: "authority-publish-optional" } },
  });
  const optionalIntent = live.store.actionIntents.find((row) => row.objectiveId === optional.json().objectiveId)!;
  const denied = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${optionalIntent.actionIntentId}/decision`,
    headers: headers(),
    payload: { decision: "DENY" },
  });
  expect(denied.json().intent.status).toBe("DENIED");
  const inspected = await live.app.inject({ method: "GET", url: `/v1/objectives/${optional.json().objectiveId}`, headers: headers() });
  expect(inspected.json().status).toBe("PARTIAL");

  const required = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "publish_mybrandos required", constraints: { orchestrationFixture: "authority-publish" } },
  });
  const requiredIntent = live.store.actionIntents.find((row) => row.objectiveId === required.json().objectiveId)!;
  await live.app.inject({ method: "POST", url: `/v1/actions/${requiredIntent.actionIntentId}/decision`, headers: headers(), payload: { decision: "DENY" } });
  const failed = await live.app.inject({ method: "GET", url: `/v1/objectives/${required.json().objectiveId}`, headers: headers() });
  expect(failed.json().status).toBe("FAILED");

  const cancellable = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "publish_mybrandos cancel", constraints: { orchestrationFixture: "authority-publish" } },
  });
  const cancelIntent = live.store.actionIntents.find((row) => row.objectiveId === cancellable.json().objectiveId)!;
  await live.app.inject({ method: "POST", url: `/v1/actions/${cancelIntent.actionIntentId}/decision`, headers: headers(), payload: { decision: "APPROVE" } });
  await live.app.inject({ method: "POST", url: `/v1/objectives/${cancellable.json().objectiveId}/cancel`, headers: headers() });
  const auth = live.store.actionAuthorizations.find((row) => row.actionIntentId === cancelIntent.actionIntentId);
  expect(auth?.status).toBe("invalidated");
});

test("message deploy delete occurrence concurrency and isolation", async () => {
  const live = await start();
  const obj = await live.app.inject({
    method: "POST",
    url: "/v1/objectives",
    headers: headers(),
    payload: { instruction: "authority-create generate campaign copy", constraints: { orchestrationFixture: "authority-create" } },
  });
  await live.app.inject({
    method: "POST",
    url: "/v1/authority/grants",
    headers: headers(),
    payload: {
      allowedActionClasses: ["MESSAGE"],
      allowedActionTypes: ["SEND_ELFCOM_MESSAGE"],
      resourceConstraints: { resourceType: "elfcom-conversation", resourceId: "conv-a" },
      limits: { maxOccurrences: 1 },
    },
  });
  const payload = {
    actionClass: "MESSAGE",
    actionType: "SEND_ELFCOM_MESSAGE",
    target: { resourceType: "elfcom-conversation", resourceId: "conv-a" },
    parameters: { conversationId: "conv-a", messageDigest: "x" },
  };
  const [first, second] = await Promise.all([
    live.app.inject({ method: "POST", url: `/v1/objectives/${obj.json().objectiveId}/actions`, headers: headers(), payload }),
    live.app.inject({ method: "POST", url: `/v1/objectives/${obj.json().objectiveId}/actions`, headers: headers(), payload: { ...payload, target: { resourceType: "elfcom-conversation", resourceId: "conv-a" }, parameters: { conversationId: "conv-a", messageDigest: "x2" } } }),
  ]);
  const outcomes = [first.json().decision?.outcome, second.json().decision?.outcome, first.statusCode, second.statusCode];
  expect(outcomes.filter((row) => row === "AUTHORIZED_BY_GRANT").length).toBe(1);

  const message = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "MESSAGE",
      actionType: "SEND_ELFCOM_MESSAGE",
      target: { resourceType: "elfcom-conversation", resourceId: "conv-a" },
      parameters: { conversationId: "conv-a", messageDigest: "solo" },
    },
  });
  if (message.json().intent?.status === "HUMAN_DECISION_REQUIRED") {
    await live.app.inject({ method: "POST", url: `/v1/actions/${message.json().intent.actionIntentId}/decision`, headers: headers(), payload: { decision: "APPROVE" } });
  }
  const otherConv = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "MESSAGE",
      actionType: "SEND_ELFCOM_MESSAGE",
      target: { resourceType: "elfcom-conversation", resourceId: "conv-b" },
      parameters: { conversationId: "conv-b", messageDigest: "solo" },
    },
  });
  expect(otherConv.json().decision.outcome).toBe("HUMAN_DECISION_REQUIRED");

  const deploy = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "DEPLOY",
      actionType: "DEPLOY_SERVICE",
      target: { resourceType: "railway-service", resourceId: "ecommerceos" },
      parameters: { artifact: "commit-A", environment: "staging", service: "ecommerceos" },
    },
  });
  const deployId = deploy.json().intent.actionIntentId;
  await live.app.inject({ method: "POST", url: `/v1/actions/${deployId}/decision`, headers: headers(), payload: { decision: "APPROVE" } });
  const prod = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "DEPLOY",
      actionType: "DEPLOY_SERVICE",
      target: { resourceType: "railway-service", resourceId: "ecommerceos" },
      parameters: { artifact: "commit-A", environment: "production", service: "ecommerceos" },
    },
  });
  expect(prod.json().decision.outcome).toBe("HUMAN_DECISION_REQUIRED");
  const otherCommit = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "DEPLOY",
      actionType: "DEPLOY_SERVICE",
      target: { resourceType: "railway-service", resourceId: "ecommerceos" },
      parameters: { artifact: "commit-B", environment: "staging", service: "ecommerceos" },
    },
  });
  expect(otherCommit.json().decision.outcome).toBe("HUMAN_DECISION_REQUIRED");

  const del = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "DELETE",
      actionType: "DELETE_ASSET",
      target: { resourceType: "asset", resourceId: "asset-x" },
      parameters: { resourceType: "asset", resourceId: "asset-x" },
    },
  });
  await live.app.inject({ method: "POST", url: `/v1/actions/${del.json().intent.actionIntentId}/decision`, headers: headers(), payload: { decision: "APPROVE" } });
  const otherAsset = await live.app.inject({
    method: "POST",
    url: `/v1/objectives/${obj.json().objectiveId}/actions`,
    headers: headers(),
    payload: {
      actionClass: "DELETE",
      actionType: "DELETE_ASSET",
      target: { resourceType: "asset", resourceId: "asset-y" },
      parameters: { resourceType: "asset", resourceId: "asset-y" },
    },
  });
  expect(otherAsset.json().decision.outcome).toBe("HUMAN_DECISION_REQUIRED");

  const grant = await live.app.inject({ method: "POST", url: "/v1/authority/grants", headers: headers(), payload: { allowedActionClasses: ["CHANGE"] } });
  const crossGet = await live.app.inject({ method: "GET", url: `/v1/authority/grants/${grant.json().grant.grantId}`, headers: headers("actor-b") });
  expect(crossGet.statusCode).toBe(403);
  const crossRevoke = await live.app.inject({ method: "POST", url: `/v1/authority/grants/${grant.json().grant.grantId}/revoke`, headers: headers("actor-b") });
  expect(crossRevoke.statusCode).toBe(403);
  const crossDecision = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${del.json().intent.actionIntentId}/decision`,
    headers: headers("actor-b"),
    payload: { decision: "APPROVE" },
  });
  expect(crossDecision.statusCode).toBe(403);
  const anon = await live.app.inject({ method: "POST", url: "/v1/authority/grants", payload: { allowedActionClasses: ["SPEND"] } });
  expect(anon.statusCode).toBe(401);
  const spoof = await live.app.inject({
    method: "POST",
    url: "/v1/authority/grants",
    headers: { ...headers(), "x-tenant-id": "other" },
    payload: { allowedActionClasses: ["SPEND"] },
  });
  expect(spoof.statusCode).toBe(403);
  const appSpoof = await live.app.inject({
    method: "POST",
    url: "/v1/authority/grants",
    headers: headers(),
    payload: { allowedActionClasses: ["SPEND"], applicationId: "digi-twin" },
  });
  expect(appSpoof.statusCode).toBe(400);
  const noActor = await live.app.inject({
    method: "POST",
    url: `/v1/actions/${del.json().intent.actionIntentId}/decision`,
    headers: { "x-digi-ai-caller": "test", "x-digi-ai-caller-key": "test-secret" },
    payload: { decision: "APPROVE" },
  });
  expect(noActor.statusCode).toBe(401);
  const health = (await live.app.inject({ method: "GET", url: "/health" })).json();
  expect(health.authority.supported).toBe(true);
  expect(health.authority.deterministic).toBe(true);
  expect(health.authority.externalActionExecution.supported).toBe(false);
  expect(health.authority.consequentialAutomaticExecution.enabled).toBe(false);
  expect(health.economics.metering.mode).toBe("observe");
  expect(JSON.stringify(health)).not.toMatch(/TD-A|50000|test-secret|commit-A/);
  expect(JSON.stringify(live.store.actionIntents)).not.toMatch(/contentBase64|sk-|BEGIN PRIVATE/);
  expect(evaluateAuthority.toString()).not.toMatch(/openai|gemini|invoke/);
});

test("hosted authority acceptance fixture is isolated", async () => {
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/internal/authority/acceptance",
    headers: headers("actor-a", "operator", "operator-secret"),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().note).toMatch(/No external action executed/);
  expect(res.json().createOutcome).toBe("AUTHORIZED_AUTOMATICALLY");
  expect(res.json().publishRequiredHuman).toBe(true);
  expect(res.json().executed).toBe(false);
});
