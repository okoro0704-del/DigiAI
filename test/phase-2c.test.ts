import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { TEXT_CAPABILITIES } from "../src/capabilities/catalog.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { GeminiProvider, classifyGeminiHttpError } from "../src/providers/gemini.js";
import { createProviderPool } from "../src/providers/pool.js";
import { TestProvider } from "../src/providers/test.js";
import { UnboundProvider } from "../src/providers/unbound.js";
import type { IntelligenceProvider, ProviderFailure, ProviderResult } from "../src/providers/types.js";
import { listCatalogModels } from "../src/registry/models.js";
import { getProviderCatalog } from "../src/registry/providers.js";
import { executeWithFailover } from "../src/routing/execute.js";
import { FAILOVER_ELIGIBLE_ERRORS, FAILOVER_INELIGIBLE_ERRORS, isFailoverEligibleError } from "../src/routing/failover.js";
import { decideRoute } from "../src/routing/policy.js";
import { buildRuntimeRegistry, routeCapability } from "../src/routing/runtime.js";
import { MemoryStore } from "../src/store/memory.js";
import { estimateProviderCost } from "../src/usage/cost.js";
import { selectPricing } from "../src/usage/pricing-catalog.js";

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
    openaiApiKey: "",
    geminiApiKey: "",
    aiProvider: "test",
    providerPriority: ["openai", "gemini"],
    allowFailover: true,
    maxProviderAttempts: 2,
    allowRouteOverride: false,
    enabledProviders: [],
    disabledModels: [],
    cloudMaxPrivacy: "PRIVATE",
    sovereignDriveUrl: "",
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

const apps: Array<{ close: () => Promise<void> }> = [];

function scripted(
  name: string,
  results: ProviderResult[],
): IntelligenceProvider & { calls: number } {
  const provider: IntelligenceProvider & { calls: number } = {
    name,
    configured: true,
    calls: 0,
    async invoke(): Promise<ProviderResult> {
      const result = results[Math.min(provider.calls, results.length - 1)]!;
      provider.calls += 1;
      return result;
    },
  };
  return provider;
}

function fail(name: string, error: ProviderFailure["error"], model = name === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini"): ProviderResult {
  return { ok: false, provider: name, model, error, detail: error, latencyMs: 2 };
}

function ok(name: string, text = "ok", extra: Partial<Extract<ProviderResult, { ok: true }>> = {}): ProviderResult {
  const model = name === "gemini" ? "gemini-2.0-flash" : name === "openai" ? "gpt-4o-mini" : name;
  return {
    ok: true,
    provider: name,
    model,
    text,
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedTokens: 2 },
    latencyMs: 4,
    ...extra,
  };
}

async function start(opts: {
  provider?: IntelligenceProvider;
  providers?: Record<string, IntelligenceProvider>;
  config?: Partial<AppConfig>;
} = {}) {
  const store = new MemoryStore();
  const app = buildApp(testConfig(opts.config), {
    provider: opts.provider,
    providers: opts.providers,
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

test("1 Gemini adapter registers", () => {
  const pool = createProviderPool(testConfig({ aiProvider: "unbound", geminiApiKey: "AIza-test-key", openaiApiKey: "" }));
  expect(pool.get("gemini")).toBeInstanceOf(GeminiProvider);
  expect(pool.get("gemini")?.configured).toBe(true);
  expect(pool.primary().name).toBe("gemini");
});

test("2 Gemini model registers", () => {
  const model = listCatalogModels().find((row) => row.id === "gemini-2.0-flash");
  expect(model?.providerId).toBe("gemini");
  expect(model?.status).toBe("enabled");
  expect(model?.modality).toEqual(["text"]);
  expect(model?.structuredOutput).toBe(true);
  expect(model?.pricingRef).toBe("gemini:gemini-2.0-flash");
});

test("3 Gemini capabilities map to text only", () => {
  const gemini = getProviderCatalog("gemini");
  expect(gemini?.capabilities).toEqual([...TEXT_CAPABILITIES]);
  expect(gemini?.capabilities).not.toContain("IMAGE");
  expect(gemini?.capabilities).not.toContain("VIDEO");
  expect(gemini?.capabilities).not.toContain("VOICE");
  expect(gemini?.capabilities).not.toContain("MUSIC");
  expect(gemini?.capabilities).not.toContain("SPEECH_TO_TEXT");
  expect(gemini?.capabilities).not.toContain("TEXT_TO_SPEECH");
});

test("4 Gemini unconfigured state stays healthy and excluded", () => {
  const registry = buildRuntimeRegistry(testConfig({ geminiApiKey: "" }), new UnboundProvider());
  const gemini = registry.providers.find((row) => row.catalog.id === "gemini");
  expect(gemini?.configured).toBe(false);
  expect(gemini?.credentialPresent).toBe(false);
  expect(gemini?.enabled).toBe(true);
  const routed = routeCapability({
    config: testConfig(),
    provider: new UnboundProvider(),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(false);
  if (routed.decision.ok) return;
  expect(routed.decision.excluded.some((row) => row.providerId === "gemini" && row.reason.includes("not configured"))).toBe(true);
});

test("5 Gemini configured state is eligible", () => {
  const gemini = scripted("gemini", [ok("gemini")]);
  const registry = buildRuntimeRegistry(testConfig({ geminiApiKey: "present" }), gemini);
  expect(registry.providers.find((row) => row.catalog.id === "gemini")?.configured).toBe(true);
  const routed = routeCapability({
    config: testConfig({ providerPriority: ["gemini", "openai"] }),
    provider: gemini,
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(true);
  if (!routed.decision.ok) return;
  expect(routed.decision.selected.providerId).toBe("gemini");
});

test("6 disabled Gemini is excluded", () => {
  const routed = routeCapability({
    config: testConfig({ enabledProviders: ["openai"] }),
    pool: createProviderPool(testConfig(), {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(true);
  if (!routed.decision.ok) return;
  expect(routed.decision.selected.providerId).toBe("openai");
  expect(routed.decision.excluded.some((row) => row.providerId === "gemini" && row.reason.includes("disabled"))).toBe(true);
  expect(routed.decision.eligible.some((row) => row.providerId === "gemini")).toBe(false);
});

test("7 WRITE has multiple eligible real providers", () => {
  const routed = routeCapability({
    config: testConfig({ providerPriority: ["openai", "gemini"] }),
    pool: createProviderPool(testConfig(), {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(true);
  if (!routed.decision.ok) return;
  expect(routed.decision.eligible.map((row) => row.providerId)).toEqual(expect.arrayContaining(["openai", "gemini"]));
});

test("8 primary provider is selected deterministically", () => {
  const first = routeCapability({
    config: testConfig({ providerPriority: ["openai", "gemini"] }),
    pool: createProviderPool(testConfig(), {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  const second = routeCapability({
    config: testConfig({ providerPriority: ["gemini", "openai"] }),
    pool: createProviderPool(testConfig(), {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(first.decision.ok && first.decision.selected.providerId).toBe("openai");
  expect(second.decision.ok && second.decision.selected.providerId).toBe("gemini");
});

test("9 secondary is not used on success", async () => {
  const openai = scripted("openai", [ok("openai", "primary")]);
  const gemini = scripted("gemini", [ok("gemini", "secondary")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(executed.final?.ok && executed.final.text).toBe("primary");
  expect(openai.calls).toBe(1);
  expect(gemini.calls).toBe(0);
  expect(executed.attempts).toHaveLength(1);
});

test("10 failover disabled does not call secondary", async () => {
  const openai = scripted("openai", [fail("openai", "billing")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const executed = await executeWithFailover({
    config: testConfig({ allowFailover: false }),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: false,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(openai.calls).toBe(1);
  expect(gemini.calls).toBe(0);
  expect(executed.attempts[0]?.failoverReason).toMatch(/disabled/i);
});

test("11 eligible provider failure selects secondary", async () => {
  const openai = scripted("openai", [fail("openai", "billing")]);
  const gemini = scripted("gemini", [ok("gemini", "failover")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(executed.final?.ok && executed.final.text).toBe("failover");
  expect(openai.calls).toBe(1);
  expect(gemini.calls).toBe(1);
  expect(executed.explanation).toMatch(/failover openai billing → gemini/);
});

test("12 ineligible failure does not fail over", async () => {
  for (const error of FAILOVER_INELIGIBLE_ERRORS as ProviderFailure["error"][]) {
    const openai = scripted("openai", [fail("openai", error)]);
    const gemini = scripted("gemini", [ok("gemini")]);
    const executed = await executeWithFailover({
      config: testConfig(),
      pool: createProviderPool(testConfig(), { openai, gemini }),
      capability: "WRITE",
      privacyClass: "PRIVATE",
      allowFailover: true,
      request: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(gemini.calls, error).toBe(0);
    expect(executed.attempts).toHaveLength(1);
  }
});

test("13 privacy class can block Gemini independently", () => {
  const routed = routeCapability({
    config: testConfig({ cloudMaxPrivacy: "INTERNAL" }),
    pool: createProviderPool(testConfig(), {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(false);
  if (routed.decision.ok) return;
  expect(routed.decision.excluded.some((row) => row.providerId === "gemini")).toBe(true);
});

test("14 HIGHLY_SENSITIVE cannot silently fail over to Gemini", async () => {
  const openai = scripted("openai", [fail("openai", "billing")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "HIGHLY_SENSITIVE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "secret" }] },
  });
  expect(executed.decision.ok).toBe(false);
  expect(openai.calls).toBe(0);
  expect(gemini.calls).toBe(0);
  expect(executed.decision.ok === false && executed.decision.excluded.some((row) => /HIGHLY_SENSITIVE/.test(row.reason))).toBe(true);
});

test("15 safety refusal does not silently fail over", async () => {
  const openai = scripted("openai", [fail("openai", "safety_refused")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(gemini.calls).toBe(0);
  expect(executed.attempts[0]?.failoverReason).toMatch(/Safety refusal/);
});

test("16 billing failover only when policy permits", async () => {
  expect(isFailoverEligibleError("billing")).toBe(true);
  const openai = scripted("openai", [fail("openai", "billing")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const denied = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: false,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(gemini.calls).toBe(0);
  const allowed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(gemini.calls).toBe(1);
  expect(allowed.final?.ok).toBe(true);
  expect(denied.final?.ok).toBe(false);
});

test("17 rate-limit failover follows policy", async () => {
  expect(FAILOVER_ELIGIBLE_ERRORS).toContain("rate_limited");
  const openai = scripted("openai", [fail("openai", "rate_limited")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(executed.final?.ok).toBe(true);
  expect(gemini.calls).toBe(1);
});

test("18 timeout failover follows policy", async () => {
  const openai = scripted("openai", [fail("openai", "timeout")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(executed.final?.ok).toBe(true);
  expect(executed.attempts.map((row) => row.providerId)).toEqual(["openai", "gemini"]);
});

test("19-23 route attempt history, ledger, costs, and no double-count", async () => {
  const openai = scripted("openai", [fail("openai", "quota")]);
  const gemini = scripted("gemini", [ok("gemini", "done", {
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, cachedTokens: 3 },
  })]);
  const live = await start({
    providers: { openai, gemini },
    config: { providerPriority: ["openai", "gemini"], allowFailover: true },
  });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Write a short line.", capability: "WRITE" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().execution.provider).toBe("gemini");
  expect(res.json().answer).toBe("done");
  expect(live.store.ledger).toHaveLength(2);
  expect(live.store.ledger[0]?.providerId).toBe("openai");
  expect(live.store.ledger[0]?.errorClass).toBe("quota");
  expect(live.store.ledger[0]?.attemptIndex).toBe(1);
  expect(live.store.ledger[0]?.estimatedProviderCost).toBeNull();
  expect(live.store.ledger[1]?.providerId).toBe("gemini");
  expect(live.store.ledger[1]?.status).toBe("completed");
  expect(live.store.ledger[1]?.attemptIndex).toBe(2);
  expect(live.store.ledger[1]?.nativeUsage.cachedTokens).toBe(3);
  expect(live.store.ledger[1]?.pricingVersion).toBe("gemini-2.0-flash-2026-09-01");
  expect(live.store.ledger[1]?.estimatedProviderCost).toBeGreaterThan(0);
  expect(live.store.ledger[1]?.actualProviderCost).toBeNull();
  const summary = await live.store.aggregateUsage({});
  expect(summary.requestCount).toBe(1);
  expect(summary.attemptCount).toBe(2);
  expect(summary.successful).toBe(1);
  expect(live.store.ledger[0]?.requestId).toBe(live.store.ledger[1]?.requestId);
});

test("24-27 Gemini native usage, pricing version, estimate, actual remains null", () => {
  const pricing = selectPricing({ providerId: "gemini", modelId: "gemini-2.0-flash", at: "2026-09-19T00:00:00.000Z" });
  expect(pricing?.pricingVersion).toBe("gemini-2.0-flash-2026-09-01");
  const cost = estimateProviderCost({
    providerId: "gemini",
    modelId: "gemini-2.0-flash",
    nativeUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 },
    at: "2026-09-19T00:00:00.000Z",
  });
  expect(cost.estimatedProviderCost).toBeCloseTo(0.1 + 0.4 + 0.025);
  expect(cost.actualProviderCost).toBeNull();
  expect(cost.pricingVersion).toBe("gemini-2.0-flash-2026-09-01");
  expect(estimateProviderCost({
    providerId: "gemini",
    modelId: "unknown-gemini",
    nativeUsage: { inputTokens: 10 },
  }).estimatedProviderCost).toBeNull();
});

test("28 /v1/ask remains provider-neutral", async () => {
  const live = await start({
    providers: {
      openai: scripted("openai", [ok("openai", "from-openai")]),
      gemini: scripted("gemini", [ok("gemini", "from-gemini")]),
    },
    config: { providerPriority: ["openai", "gemini"] },
  });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Write a one paragraph introduction.", mode: "draft" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().usage.capability).toBe("WRITE");
  expect(res.json().answer).toBe("from-openai");
  expect(res.json().service).toBe("digi-ai");
});

test("29-30 Digi Twin factual path and provider-neutral interpretation", async () => {
  const factual = await start({ provider: new UnboundProvider() });
  const quiet = await factual.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: headers(),
    payload: { ownerContext: { entitySlug: "life-a", displayName: "Actor A" } },
  });
  expect(quiet.statusCode).toBe(200);
  expect(quiet.json().interpretationAvailable).toBe(false);
  expect(quiet.json().providerStatus.state).toBe("unbound");

  const openai = scripted("openai", [fail("openai", "timeout")]);
  const gemini = scripted("gemini", [ok("gemini", JSON.stringify({ take: "Keep publishing.", opportunities: [] }))]);
  const live = await start({
    providers: { openai, gemini },
    config: { allowFailover: true, providerPriority: ["openai", "gemini"] },
  });
  const brief = await live.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: headers(),
    payload: { ownerContext: { entitySlug: "life-a", displayName: "Actor A", publications: [{ id: "1", title: "Note" }] } },
  });
  expect(brief.statusCode).toBe(200);
  expect(brief.json().usage.capability).toBe("THINK");
  expect(brief.json().providerStatus.provider).toBe("gemini");
  expect(brief.json().sections.find((row: { type: string }) => row.type === "content").items[0].title).toBe("Note");
  expect(live.store.ledger.map((row) => row.providerId)).toEqual(["openai", "gemini"]);
});

test("31 browser cannot force a provider or failover target", async () => {
  const live = await start({
    providers: {
      openai: scripted("openai", [ok("openai", "primary")]),
      gemini: scripted("gemini", [ok("gemini", "forced")]),
    },
  });
  for (const payload of [
    { message: "hello", provider: "gemini" },
    { message: "hello", forceProvider: "gemini" },
    { message: "hello", failoverTo: "gemini" },
    { message: "hello", constraints: { failoverTo: "gemini" } },
    { message: "hello", constraints: { preferredProvider: "gemini" } },
  ]) {
    const res = await live.app.inject({
      method: "POST",
      url: "/v1/ask",
      headers: headers("actor-a", "tenant-a", "a-secret"),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  }
  const ignored = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-a", "tenant-a", "a-secret"),
    payload: { message: "hello", constraints: { forceProvider: "gemini" } },
  });
  expect(ignored.statusCode).toBe(200);
  expect(ignored.json().execution.provider).toBe("openai");
});

test("32-33 secrets are absent from health and ledger", async () => {
  const live = await start({
    providers: {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    },
    config: { openaiApiKey: "sk-present-not-logged", geminiApiKey: "AIza-present-not-logged" },
  });
  const health = (await live.app.inject({ method: "GET", url: "/health" })).json();
  expect(health.providers.openai.credentialPresent).toBe(true);
  expect(health.providers.gemini.credentialPresent).toBe(true);
  expect(health.capabilities.WRITE.supportedProviders).toBeGreaterThanOrEqual(2);
  expect(health.capabilities.WRITE.configuredProviders).toBeGreaterThanOrEqual(2);
  expect(health.capabilities.WRITE.runtimeVerified).toBe(false);
  expect(JSON.stringify(health)).not.toMatch(/sk-present|AIza-present|test-secret|GEMINI_API_KEY=/);
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello", capability: "WRITE" },
  });
  expect(JSON.stringify(live.store.ledger)).not.toMatch(/sk-present|AIza-present|test-secret/);
});

test("34 bounded retry and failover behavior", async () => {
  const openai = scripted("openai", [fail("openai", "timeout")]);
  const gemini = scripted("gemini", [fail("gemini", "timeout")]);
  const executed = await executeWithFailover({
    config: testConfig({ maxProviderAttempts: 2 }),
    pool: createProviderPool(testConfig(), { openai, gemini }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(openai.calls).toBe(1);
  expect(gemini.calls).toBe(1);
  expect(executed.attempts).toHaveLength(2);
});

test("35 route explainability includes eligible providers and priority", () => {
  const decision = decideRoute({
    capability: "WRITE",
    privacyClass: "PRIVATE",
    providers: buildRuntimeRegistry(
      testConfig({ providerPriority: ["openai", "gemini"] }),
      createProviderPool(testConfig(), {
        openai: scripted("openai", [ok("openai")]),
        gemini: scripted("gemini", [ok("gemini")]),
      }),
    ).providers,
    models: listCatalogModels(),
    providerPriority: ["openai", "gemini"],
  });
  expect(decision.ok).toBe(true);
  expect(decision.explanation).toContain("capability=WRITE");
  expect(decision.explanation).toContain("priority=openai>gemini");
  expect(decision.explanation).toContain("selected=openai/");
  expect(decision.explanation).toContain("eligible=");
});

test("unconfigured Gemini never receives invoke", async () => {
  const openai = scripted("openai", [fail("openai", "billing")]);
  const executed = await executeWithFailover({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai }),
    capability: "WRITE",
    privacyClass: "PRIVATE",
    allowFailover: true,
    request: { messages: [{ role: "user", content: "hello" }] },
  });
  expect(executed.attempts.map((row) => row.providerId)).toEqual(["openai"]);
  expect(executed.final?.ok).toBe(false);
});

test("operator test constraint can force Gemini in non-prod", async () => {
  const live = await start({
    providers: {
      openai: scripted("openai", [ok("openai", "primary")]),
      gemini: scripted("gemini", [ok("gemini", "forced")]),
    },
    config: { allowRouteOverride: false, isProd: false },
  });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello", constraints: { forceProvider: "gemini" } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().execution.provider).toBe("gemini");
});

test("request allowFailover=false is honored for /v1/ask", async () => {
  const openai = scripted("openai", [fail("openai", "billing")]);
  const gemini = scripted("gemini", [ok("gemini")]);
  const live = await start({
    providers: { openai, gemini },
    config: { allowFailover: true },
  });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello", constraints: { allowFailover: false } },
  });
  expect(res.statusCode).toBe(502);
  expect(gemini.calls).toBe(0);
  expect(live.store.ledger).toHaveLength(1);
});

test("Gemini adapter normalizes generateContent and safety blocks", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.systemInstruction.parts[0].text).toContain("policy");
    expect(body.contents[0].parts[0].text).toBe("hello");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    return new Response(JSON.stringify({
      responseId: "g-1",
      modelVersion: "gemini-2.0-flash",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "summary" }] } }],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 5,
        totalTokenCount: 16,
        cachedContentTokenCount: 2,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const gemini = new GeminiProvider("AIza-secret-value", "gemini-2.0-flash", 2000);
    const result = await gemini.invoke({
      structuredOutput: true,
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "hello" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("summary");
    expect(result.usage.cachedTokens).toBe(2);
    expect(result.providerRequestId).toBe("g-1");
    expect(JSON.stringify(result)).not.toContain("AIza-secret-value");
  } finally {
    globalThis.fetch = original;
  }

  expect(classifyGeminiHttpError(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }).error).toBe("quota");
  expect(classifyGeminiHttpError(400, { error: { status: "INVALID_ARGUMENT", message: "bad" } }).error).toBe("invalid_request");
  expect(classifyGeminiHttpError(401, { error: { status: "UNAUTHENTICATED", message: "key=AIza12345678" } }).detail).not.toMatch(/AIza12345678/);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })) as typeof fetch;
  try {
    const blocked = await new GeminiProvider("k", "gemini-2.0-flash", 1000).invoke({
      messages: [{ role: "user", content: "no" }],
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toBe("safety_refused");
  } finally {
    globalThis.fetch = original;
  }
});

test("cross-tenant routing context stays isolated", async () => {
  const live = await start({
    providers: {
      openai: scripted("openai", [ok("openai")]),
      gemini: scripted("gemini", [ok("gemini")]),
    },
  });
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-a", "tenant-a", "a-secret"),
    payload: { message: "hello", entity: { slug: "life-a" } },
  });
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-b", "tenant-b", "b-secret"),
    payload: { message: "hello", entity: { slug: "life-b" } },
  });
  expect(live.store.ledger[0]?.tenantId).toBe("life-a");
  expect(live.store.ledger[1]?.tenantId).toBe("life-b");
  expect(live.store.ledger[0]?.applicationId).toBe("tenant-a");
  expect(live.store.ledger[1]?.applicationId).toBe("tenant-b");
});
