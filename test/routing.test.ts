import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { listCapabilities, getCapability, TEXT_CAPABILITIES } from "../src/capabilities/catalog.js";
import { CAPABILITY_IDS } from "../src/contracts/capabilities.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { DigiNewsReader, DigiPediaReader } from "../src/adapters/types.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { listCatalogModels } from "../src/registry/models.js";
import { PROVIDER_CATALOG, getProviderCatalog } from "../src/registry/providers.js";
import { decideRoute } from "../src/routing/policy.js";
import { buildRuntimeRegistry, routeCapability } from "../src/routing/runtime.js";
import { capabilityFromAskMode } from "../src/routing/resolve-capability.js";
import { TestProvider } from "../src/providers/test.js";
import { UnboundProvider } from "../src/providers/unbound.js";
import type { IntelligenceProvider, ProviderResult } from "../src/providers/types.js";
import { classifyProviderHttpError } from "../src/providers/errors.js";
import { MemoryStore } from "../src/store/memory.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    isProd: false,
    nodeEnv: "test",
    callers: [
      { id: "test", secret: "test-secret" },
      { id: "tenant-a", secret: "a-secret" },
      { id: "tenant-b", secret: "b-secret" },
    ],
    trustIdApi: "http://trustid.test",
    allowAttestedActor: false,
    maxMessageChars: 8000,
    maxSuppliedChars: 12000,
    newsLimit: 8,
    sovereignDriveUrl: "",
    openaiApiKey: "",
    aiProvider: "test",
    enabledProviders: [],
    disabledModels: [],
    ...overrides,
  };
}

const actors: IdentityResolver = {
  async resolveToken(token: string) {
    if (token === "actor-a") return { trustId: "TD-A", displayName: "Actor A" };
    if (token === "actor-b") return { trustId: "TD-B", displayName: "Actor B" };
    return null;
  },
};

const emptySources: { pedia: DigiPediaReader; news: DigiNewsReader } = {
  pedia: { async readPublished() { return { ok: false, error: "not_found", message: "none" }; } },
  news: { async readPublic() { return { ok: false, error: "not_found", message: "none" }; } },
};

const apps: Array<{ close: () => Promise<void> }> = [];

async function start(opts: {
  provider?: IntelligenceProvider;
  config?: Partial<AppConfig>;
} = {}) {
  const store = new MemoryStore();
  const provider = opts.provider ?? new TestProvider();
  const app = buildApp(testConfig(opts.config), {
    provider,
    resolver: actors,
    digipedia: emptySources.pedia,
    diginews: emptySources.news,
    store,
  });
  apps.push(app);
  return { app, store, provider };
}

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

function callerHeaders(token = "actor-a", caller = "test", key = "test-secret") {
  return {
    "x-digi-ai-caller": caller,
    "x-digi-ai-caller-key": key,
    authorization: `Bearer ${token}`,
  };
}

test("capability registry loads the canonical vocabulary", () => {
  const catalog = listCapabilities();
  expect(catalog).toHaveLength(CAPABILITY_IDS.length);
  for (const id of CAPABILITY_IDS) {
    expect(getCapability(id).id).toBe(id);
    expect(getCapability(id).cataloged).toBe(true);
  }
  expect(TEXT_CAPABILITIES).toContain("WRITE");
  expect(TEXT_CAPABILITIES).not.toContain("VIDEO");
});

test("provider registry loads without secrets", () => {
  expect(getProviderCatalog("openai")?.type).toBe("llm");
  expect(getProviderCatalog("openai")?.deploymentType).toBe("cloud");
  expect(PROVIDER_CATALOG.some((row) => row.id === "anthropic")).toBe(true);
  expect(JSON.stringify(PROVIDER_CATALOG)).not.toMatch(/sk-|apiKey|secret/i);
});

test("OpenAI registers supported text capabilities", () => {
  const openai = getProviderCatalog("openai");
  expect(openai?.capabilities).toEqual(expect.arrayContaining(["THINK", "WRITE", "SUMMARIZE", "CODE"]));
  const models = listCatalogModels().filter((row) => row.providerId === "openai");
  expect(models.some((row) => row.id === "gpt-4o-mini" && row.capabilities.includes("WRITE"))).toBe(true);
  expect(models.some((row) => row.id === "gpt-4o" && row.capabilities.includes("VISION"))).toBe(true);
});

test("model registry associates models to providers and capabilities", () => {
  const mini = listCatalogModels().find((row) => row.id === "gpt-4o-mini");
  expect(mini?.providerId).toBe("openai");
  expect(mini?.status).toBe("enabled");
  expect(mini?.pricingRef).toBe("openai:gpt-4o-mini");
});

test("capability request routes to an eligible model", () => {
  const routed = routeCapability({
    config: testConfig(),
    provider: new TestProvider(),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(true);
  if (!routed.decision.ok) return;
  expect(routed.decision.selected.providerId).toBe("test");
  expect(routed.decision.selected.modelId).toBe("test");
  expect(routed.decision.explanation).toContain("capability=WRITE");
});

test("unsupported capability fails cleanly", async () => {
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders(),
    payload: { message: "Call a tool.", capability: "TOOL_REASON" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("unsupported_capability");
  expect(res.json().ok).toBe(false);
  const usage = await live.store.listUsage();
  expect(usage[0]?.success).toBe(false);
  expect(usage[0]?.digiAiUnits).toBeNull();
  expect(usage[0]?.errorClass).toBe("unsupported_capability");
});

test("disabled provider is excluded", () => {
  const routed = routeCapability({
    config: testConfig({ enabledProviders: ["anthropic"] }),
    provider: new TestProvider(),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(false);
  if (routed.decision.ok) return;
  expect(routed.decision.excluded.some((row) => row.reason.includes("disabled"))).toBe(true);
});

test("unconfigured provider is excluded", () => {
  const routed = routeCapability({
    config: testConfig({ aiProvider: "openai", openaiApiKey: "" }),
    provider: new UnboundProvider(),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(false);
  if (routed.decision.ok) return;
  expect(routed.decision.error).toBe("provider_not_configured");
});

test("configured provider is eligible", () => {
  const registry = buildRuntimeRegistry(testConfig(), new TestProvider());
  const test = registry.providers.find((row) => row.catalog.id === "test");
  expect(test?.configured).toBe(true);
  expect(test?.enabled).toBe(true);
  expect(test?.credentialPresent).toBe(true);
  const openai = registry.providers.find((row) => row.catalog.id === "openai");
  expect(openai?.configured).toBe(false);
});

test("provider billing, quota, and rate-limit failures are normalized", () => {
  expect(classifyProviderHttpError(402, { error: { type: "billing" } }).error).toBe("billing");
  expect(classifyProviderHttpError(400, { error: { type: "insufficient_quota" } }).error).toBe("quota");
  expect(classifyProviderHttpError(429, { error: { code: "rate_limit_exceeded" } }).error).toBe("rate_limited");
});

test("route decision is explainable internally", () => {
  const decision = decideRoute({
    capability: "WRITE",
    privacyClass: "PRIVATE",
    providers: buildRuntimeRegistry(testConfig(), new TestProvider()).providers,
    models: buildRuntimeRegistry(testConfig(), new TestProvider()).models,
    defaultModel: "test",
  });
  expect(decision.explanation).toMatch(/selected=test\/test/);
  expect(decision.excluded.length).toBeGreaterThan(0);
});

test("/v1/ask remains compatible and maps modes to capabilities", async () => {
  expect(capabilityFromAskMode("ask")).toBe("THINK");
  expect(capabilityFromAskMode("draft")).toBe("WRITE");
  expect(capabilityFromAskMode("summarize")).toBe("SUMMARIZE");
  expect(capabilityFromAskMode("retrieve")).toBe("RETRIEVE");
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders(),
    payload: { message: "Write a one paragraph introduction.", mode: "draft" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(true);
  expect(res.json().usage.capability).toBe("WRITE");
  expect(res.json().execution.capability).toBe("WRITE");
  expect(res.json().usage.digiAiUnits).toBeNull();
});

test("capability can be requested without naming a provider", async () => {
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders(),
    payload: { message: "Write a one paragraph introduction.", capability: "WRITE" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().usage.provider).toBe("test");
  expect(res.json().usage.model).toBe("test");
  expect(JSON.stringify(res.json())).not.toMatch(/openai/i);
});

test("usage receipt is written on success with native usage and no Digi AI units", async () => {
  const live = await start();
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders(),
    payload: { message: "hello", capability: "THINK" },
  });
  const usage = (await live.store.listUsage())[0];
  const receipt = (await live.store.listReceipts())[0];
  expect(usage?.success).toBe(true);
  expect(usage?.nativeUsage?.totalTokens).toBeGreaterThan(0);
  expect(usage?.digiAiUnits).toBeNull();
  expect(usage?.providerId).toBe("test");
  expect(usage?.modelId).toBe("test");
  expect(usage?.capability).toBe("THINK");
  expect(JSON.stringify(usage)).not.toMatch(/sk-|test-secret|OPENAI_API_KEY/);
  expect(receipt?.capability).toBe("THINK");
  expect(receipt?.routeExplanation).toContain("WRITE".replace("WRITE", "THINK"));
});

test("usage receipt is written on provider failure", async () => {
  const failing: IntelligenceProvider = {
    name: "openai",
    configured: true,
    async invoke(): Promise<ProviderResult> {
      return { ok: false, provider: "openai", model: "gpt-4o-mini", error: "quota", detail: "AI reasoning needs provider billing attention.", latencyMs: 3 };
    },
  };
  const live = await start({
    provider: failing,
    config: { aiProvider: "openai", openaiApiKey: "sk-present-not-logged", enabledProviders: [] },
  });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders(),
    payload: { message: "hello", capability: "WRITE" },
  });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toBe("failed");
  const usage = (await live.store.listUsage())[0];
  expect(usage?.success).toBe(false);
  expect(usage?.errorClass).toBe("quota");
  expect(usage?.providerId).toBe("openai");
  expect(usage?.modelId).toBe("gpt-4o-mini");
  expect(usage?.digiAiUnits).toBeNull();
  expect(JSON.stringify(usage)).not.toContain("sk-present-not-logged");
});

test("browser provider and model overrides are rejected", async () => {
  const live = await start();
  const provider = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders(),
    payload: { message: "hello", provider: "openai", model: "gpt-4o" },
  });
  expect(provider.statusCode).toBe(400);
  expect(provider.json().error).toBe("invalid_request");
  const twin = await live.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: callerHeaders(),
    payload: { provider: "openai", ownerContext: { entitySlug: "store-a" } },
  });
  expect(twin.statusCode).toBe(400);
});

test("cross-tenant usage records stay isolated", async () => {
  const live = await start();
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders("actor-a", "tenant-a", "a-secret"),
    payload: { message: "hello", entity: { slug: "life-a", tenantId: "ignored-client-tenant" } },
  });
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: callerHeaders("actor-b", "tenant-b", "b-secret"),
    payload: { message: "hello", entity: { slug: "life-b", tenantId: "ignored-client-tenant" } },
  });
  const usage = await live.store.listUsage();
  expect(usage).toHaveLength(2);
  expect(usage[0]?.tenantId).toBe("life-a");
  expect(usage[0]?.applicationId).toBe("tenant-a");
  expect(usage[0]?.actorTrustId).toBe("TD-A");
  expect(usage[1]?.tenantId).toBe("life-b");
  expect(usage[1]?.applicationId).toBe("tenant-b");
  expect(usage[1]?.actorTrustId).toBe("TD-B");
  expect(usage[0]?.actorTrustId).not.toBe(usage[1]?.actorTrustId);
});

test("privacy eligibility prevents silent cloud failover", () => {
  const openaiBound: IntelligenceProvider = {
    name: "openai",
    configured: true,
    async invoke(): Promise<ProviderResult> {
      return { ok: true, provider: "openai", model: "gpt-4o-mini", text: "no", usage: {}, latencyMs: 1 };
    },
  };
  const routed = routeCapability({
    config: testConfig({ aiProvider: "openai", openaiApiKey: "sk-test", cloudMaxPrivacy: "PRIVATE" }),
    provider: openaiBound,
    capability: "WRITE",
    privacyClass: "HIGHLY_SENSITIVE",
  });
  expect(routed.decision.ok).toBe(false);
  if (routed.decision.ok) return;
  expect(routed.decision.excluded.some((row) => /Privacy HIGHLY_SENSITIVE/.test(row.reason))).toBe(true);
  expect(routed.decision.eligible).toEqual([]);
});

test("health lists capability readiness without secrets", async () => {
  const live = await start({
    provider: new TestProvider(),
  });
  const res = await live.app.inject({ method: "GET", url: "/health" });
  const body = res.json();
  expect(body.capabilities.WRITE.supported).toBe(true);
  expect(body.capabilities.WRITE.configured).toBe(true);
  expect(body.capabilities.WRITE.runtimeVerified).toBe(false);
  expect(body.capabilities.VIDEO.status).toBe("unconfigured");
  expect(body.capabilities.TOOL_REASON.status).toBe("unsupported");
  expect(body.providers.test.configured).toBe(true);
  expect(body.providers.openai.configured).toBe(false);
  expect(JSON.stringify(body)).not.toMatch(/sk-|test-secret|OPENAI_API_KEY=/);
});

test("Twin interpretation still routes through the capability router", async () => {
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: callerHeaders(),
    payload: { ownerContext: { entitySlug: "life-a", displayName: "Actor A", publications: [{ id: "1", title: "Note" }] } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(true);
  expect(res.json().usage.capability).toBe("THINK");
  expect(res.json().usage.digiAiUnits).toBeNull();
  expect((await live.store.listReceipts())[0]?.capability).toBe("THINK");
});

test("factual Twin brief still works without a provider", async () => {
  const live = await start({ provider: new UnboundProvider() });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: callerHeaders(),
    payload: { ownerContext: { entitySlug: "life-a", displayName: "Actor A", publications: [{ id: "1", title: "Note" }] } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().interpretationAvailable).toBe(false);
  expect(res.json().providerStatus.state).toBe("unbound");
  expect(res.json().sections.find((s: { type: string }) => s.type === "content").items[0].title).toBe("Note");
  expect((await live.store.listUsage())[0]?.digiAiUnits).toBeNull();
});
