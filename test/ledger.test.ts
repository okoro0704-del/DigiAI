import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { estimateProviderCost } from "../src/usage/cost.js";
import { getPricingVersion, listPricingCatalog, selectPricing } from "../src/usage/pricing-catalog.js";
import { aggregateEntries } from "../src/usage/aggregate.js";
import { buildLedgerEntry } from "../src/usage/ledger.js";
import { persistExecution } from "../src/usage/persist.js";
import { TestProvider } from "../src/providers/test.js";
import type { IntelligenceProvider, ProviderResult } from "../src/providers/types.js";
import { MemoryStore } from "../src/store/memory.js";
import type { LedgerEntry } from "../src/contracts/ledger.js";

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

async function start(opts: { provider?: IntelligenceProvider; config?: Partial<AppConfig>; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const app = buildApp(testConfig(opts.config), {
    provider: opts.provider ?? new TestProvider(),
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

function sampleLedger(overrides: Partial<LedgerEntry> & {
  actorId?: string;
  applicationId?: string;
  entitySlug?: string;
} = {}): LedgerEntry {
  return buildLedgerEntry({
    receiptId: overrides.receiptId ?? "rcpt-1",
    requestId: overrides.requestId ?? "req-1",
    actor: { trustId: overrides.actorId ?? "TD-A" },
    caller: { id: overrides.applicationId ?? "test", via: "s2s" },
    entitySlug: overrides.entitySlug ?? "life-a",
    capability: overrides.capability ?? "WRITE",
    providerId: overrides.providerId ?? "openai",
    modelId: overrides.modelId ?? "gpt-4o-mini",
    privacyClass: "PRIVATE",
    status: overrides.status ?? "completed",
    nativeUsage: overrides.nativeUsage ?? { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 },
    completedAt: overrides.completedAt,
  });
}

test("pricing catalog loads with versioned records", () => {
  const catalog = listPricingCatalog();
  expect(catalog.length).toBeGreaterThan(1);
  expect(selectPricing({ providerId: "openai", modelId: "gpt-4o-mini", at: "2026-09-19T00:00:00.000Z" })?.pricingVersion).toBe(
    "openai-gpt-4o-mini-2026-09-01",
  );
  expect(selectPricing({ providerId: "openai", modelId: "gpt-4o-mini", at: "2026-08-15T00:00:00.000Z" })?.pricingVersion).toBe(
    "openai-gpt-4o-mini-2026-08-01",
  );
});

test("text and cached token cost calculation", () => {
  const cost = estimateProviderCost({
    providerId: "openai",
    modelId: "gpt-4o-mini",
    nativeUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000 },
    at: "2026-09-19T00:00:00.000Z",
  });
  expect(cost.estimatedProviderCost).toBeCloseTo(0.15 + 0.6 + 0.075);
  expect(cost.actualProviderCost).toBeNull();
  expect(cost.currency).toBe("USD");
  expect(cost.pricingVersion).toBe("openai-gpt-4o-mini-2026-09-01");
});

test("unknown pricing and disabled records return null", () => {
  expect(estimateProviderCost({ providerId: "unknown", modelId: "nope", nativeUsage: { inputTokens: 10 } }).estimatedProviderCost).toBeNull();
  expect(getPricingVersion("missing")).toBeUndefined();
});

test("historical estimates stay stable after a newer pricing version", () => {
  const old = estimateProviderCost({
    providerId: "openai",
    modelId: "gpt-4o-mini",
    nativeUsage: { inputTokens: 1_000_000 },
    pricingVersion: "openai-gpt-4o-mini-2026-08-01",
  });
  const current = estimateProviderCost({
    providerId: "openai",
    modelId: "gpt-4o-mini",
    nativeUsage: { inputTokens: 1_000_000 },
    at: "2026-09-19T00:00:00.000Z",
  });
  expect(old.pricingVersion).toBe("openai-gpt-4o-mini-2026-08-01");
  expect(current.pricingVersion).toBe("openai-gpt-4o-mini-2026-09-01");
  expect(old.estimatedProviderCost).toBe(current.estimatedProviderCost);
});

test("multimodal usage schema is representable", () => {
  const image = estimateProviderCost({
    providerId: "openai",
    modelId: "gpt-image-1",
    nativeUsage: { imageCount: 2, audioSeconds: 3, videoSeconds: 4, generatedSeconds: 5 },
  });
  expect(image.estimatedProviderCost).toBeCloseTo(0.08);
  expect(image.unknownDimensions).toEqual(expect.arrayContaining(["audioSeconds", "videoSeconds", "generatedSeconds"]));
});

test("durable ledger write and read on the in-process store", async () => {
  const store = new MemoryStore();
  const entry = sampleLedger();
  const first = await store.recordLedger(entry);
  const second = await store.recordLedger({ ...entry, ledgerId: "led-dup" });
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);
  expect(await store.getLedgerByReceiptId("rcpt-1")).toMatchObject({ receiptId: "rcpt-1", actorId: "TD-A" });
  expect(store.ledger).toHaveLength(1);
});

test("append-oriented store rejects mutation of historical rows", async () => {
  const store = new MemoryStore();
  const entry = sampleLedger();
  await store.recordLedger(entry);
  await store.recordLedger({ ...entry, estimatedProviderCost: 99, actualProviderCost: 99, digiAiUnits: null });
  expect((await store.getLedgerByReceiptId("rcpt-1"))?.estimatedProviderCost).not.toBe(99);
});

test("success and provider failure persist economic records", async () => {
  const live = await start();
  const ok = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Write a paragraph.", capability: "WRITE" },
  });
  expect(ok.statusCode).toBe(200);
  const success = live.store.ledger[0];
  expect(success?.status).toBe("completed");
  expect(success?.digiAiUnits).toBeNull();
  expect(success?.actualProviderCost).toBeNull();
  expect(success?.applicationId).toBe("test");
  expect(success?.nativeUsage.inputTokens).toBeGreaterThan(0);
  expect(JSON.stringify(success)).not.toMatch(/sk-|test-secret|OPENAI_API_KEY/);

  const failing: IntelligenceProvider = {
    name: "openai",
    configured: true,
    async invoke(): Promise<ProviderResult> {
      return { ok: false, provider: "openai", model: "gpt-4o-mini", error: "billing", detail: "AI reasoning needs provider billing attention.", latencyMs: 2 };
    },
  };
  const billed = await start({ provider: failing, config: { openaiApiKey: "sk-present" } });
  const res = await billed.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello", capability: "WRITE" },
  });
  expect(res.statusCode).toBe(502);
  const failed = billed.store.ledger[0];
  expect(failed?.errorClass).toBe("billing");
  expect(failed?.estimatedProviderCost).toBeNull();
  expect(failed?.nativeUsage.inputTokens).toBeUndefined();
  expect(failed?.digiAiUnits).toBeNull();
});

test("quota and rate-limit failures persist without invented cost", async () => {
  for (const error of ["quota", "rate_limited"] as const) {
    const provider: IntelligenceProvider = {
      name: "openai",
      configured: true,
      async invoke(): Promise<ProviderResult> {
        return { ok: false, provider: "openai", model: "gpt-4o-mini", error, detail: error, latencyMs: 1 };
      },
    };
    const live = await start({ provider, config: { openaiApiKey: "sk-present" } });
    await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload: { message: "hello" } });
    expect(live.store.ledger[0]?.errorClass).toBe(error);
    expect(live.store.ledger[0]?.estimatedProviderCost).toBeNull();
    expect(live.store.ledger[0]?.actualProviderCost).toBeNull();
  }
});

test("pre-execution failure has no fake cost", async () => {
  const live = await start();
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "make a film", capability: "VIDEO" },
  });
  expect(live.store.ledger[0]?.errorClass).toBe("unsupported_capability");
  expect(live.store.ledger[0]?.estimatedProviderCost).toBeNull();
  expect(Object.keys(live.store.ledger[0]?.nativeUsage ?? {})).toHaveLength(0);
});

test("aggregations cover tenant, application, capability, provider, model, status, and date range", async () => {
  const store = new MemoryStore();
  await store.recordLedger(sampleLedger({ receiptId: "r1", requestId: "a", capability: "WRITE", completedAt: "2026-09-18T10:00:00.000Z" }));
  await store.recordLedger(sampleLedger({
    receiptId: "r2",
    requestId: "b",
    capability: "THINK",
    actorId: "TD-B",
    applicationId: "tenant-b",
    entitySlug: "life-b",
    status: "failed",
    nativeUsage: {},
    completedAt: "2026-09-19T12:00:00.000Z",
  }));
  const all = await store.aggregateUsage({});
  expect(all.requestCount).toBe(2);
  expect(all.successful).toBe(1);
  expect(all.failed).toBe(1);
  expect(all.byCapability.WRITE.count).toBe(1);
  expect(all.byProvider.openai.count).toBe(2);
  expect(all.byModel["gpt-4o-mini"].count).toBe(2);
  expect(all.byApplication.test.count).toBe(1);
  expect(all.byTenant["life-a"].count).toBe(1);
  expect(all.byStatus.failed.count).toBe(1);
  const ranged = await store.aggregateUsage({ from: "2026-09-19T00:00:00.000Z", to: "2026-09-19T23:59:59.000Z" });
  expect(ranged.requestCount).toBe(1);
  const byJs = aggregateEntries(await store.queryLedger({ capability: "WRITE" }));
  expect(byJs.requestCount).toBe(1);
});

test("anonymous and cross-tenant usage queries are rejected", async () => {
  const live = await start();
  await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload: { message: "hello" } });
  const anon = await live.app.inject({ method: "GET", url: "/internal/usage/summary" });
  expect(anon.statusCode).toBe(401);
  const other = await live.app.inject({
    method: "GET",
    url: "/v1/usage/summary?actorId=TD-A",
    headers: headers("actor-b", "tenant-b", "b-secret"),
  });
  expect(other.statusCode).toBe(403);
  const own = await live.app.inject({ method: "GET", url: "/v1/usage/summary", headers: headers() });
  expect(own.statusCode).toBe(200);
  expect(own.json().summary.requestCount).toBe(1);
  expect(own.json().scope).toBe("tenant");
});

test("operator access can read receipts and summaries", async () => {
  const live = await start();
  const created = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload: { message: "hello" } });
  const receiptId = created.json().receiptId;
  const denied = await live.app.inject({ method: "GET", url: "/internal/usage/summary", headers: headers() });
  expect(denied.statusCode).toBe(403);
  const summary = await live.app.inject({
    method: "GET",
    url: "/internal/usage/summary",
    headers: headers("actor-a", "operator", "operator-secret"),
  });
  expect(summary.statusCode).toBe(200);
  expect(summary.json().scope).toBe("operator");
  expect(summary.json().summary.requestCount).toBe(1);
  const receipt = await live.app.inject({
    method: "GET",
    url: `/internal/usage/receipts/${receiptId}`,
    headers: headers("actor-a", "operator", "operator-secret"),
  });
  expect(receipt.statusCode).toBe(200);
  expect(receipt.json().receipt.receiptId).toBe(receiptId);
  expect(receipt.json().receipt.digiAiUnits).toBeNull();
});

test("duplicate receipt persistence does not double-count", async () => {
  const store = new MemoryStore();
  const entry = sampleLedger();
  await persistExecution(store, {
    ledger: entry,
    usage: {
      usageId: "use-1",
      requestId: entry.requestId,
      correlationId: entry.requestId,
      actorTrustId: entry.actorId,
      callerId: entry.applicationId,
      provider: entry.providerId,
      latencyMs: 1,
      success: true,
      digiAiUnits: null,
      createdAt: entry.createdAt,
    },
    receipt: {
      receiptId: entry.receiptId,
      requestId: entry.requestId,
      correlationId: entry.requestId,
      actorTrustId: entry.actorId,
      callerId: entry.applicationId,
      operation: "ask",
      sourcesAccessed: [],
      resultStatus: "completed",
      createdAt: entry.createdAt,
    },
  });
  await persistExecution(store, {
    ledger: { ...entry, ledgerId: "led-2" },
    usage: {
      usageId: "use-2",
      requestId: entry.requestId,
      correlationId: entry.requestId,
      actorTrustId: entry.actorId,
      callerId: entry.applicationId,
      provider: entry.providerId,
      latencyMs: 1,
      success: true,
      digiAiUnits: null,
      createdAt: entry.createdAt,
    },
    receipt: {
      receiptId: entry.receiptId,
      requestId: entry.requestId,
      correlationId: entry.requestId,
      actorTrustId: entry.actorId,
      callerId: entry.applicationId,
      operation: "ask",
      sourcesAccessed: [],
      resultStatus: "completed",
      createdAt: entry.createdAt,
    },
  });
  expect(store.ledger).toHaveLength(1);
  expect((await store.aggregateUsage({})).requestCount).toBe(1);
});

test("browser cannot set cost fields or application identity", async () => {
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello", actualProviderCost: 12, digiAiUnits: 9, applicationId: "spoof" },
  });
  expect(res.statusCode).toBe(400);
});

test("health reports ledger readiness without pricing secrets", async () => {
  const live = await start();
  const body = (await live.app.inject({ method: "GET", url: "/health" })).json();
  expect(body.usageLedger.writable).toBe(true);
  expect(body.pricingCatalog.loaded).toBe(true);
  expect(body.pricingCatalog.activeVersions).toBeGreaterThan(0);
  expect(body.costAccounting.enabled).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/perMillion|0\.15|test-secret/);
});
