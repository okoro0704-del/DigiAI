import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { DigiAiMeteringPolicy } from "../src/contracts/credits.js";
import { estimateDigiAiUnits, hasBillableNativeUsage } from "../src/credits/estimate.js";
import { detectOverlappingPolicies, selectMeteringPolicy } from "../src/credits/policy.js";
import { reconcileCredits } from "../src/credits/reconcile.js";
import { assertUnits, DIGI_AI_UNIT_SCALE } from "../src/credits/units.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { LITE_MODEL } from "../src/intelligence/video.js";
import { tinyWavFixture } from "../src/media/audio.js";
import { MemoryDrive } from "../src/media/drive.js";
import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "../src/providers/types.js";
import { TestProvider } from "../src/providers/test.js";
import { MemoryStore } from "../src/store/memory.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WAV = tinyWavFixture();
const WAV_B64 = WAV.toString("base64");
const MP4 = Buffer.from("AAAA", "utf8");
const MP4_B64 = MP4.toString("base64");

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
    openaiApiKey: "",
    geminiApiKey: "",
    economicsMode: "observe",
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

function scripted(name: string, results: ProviderResult[]): IntelligenceProvider & { calls: number } {
  const provider: IntelligenceProvider & { calls: number } = {
    name,
    configured: true,
    calls: 0,
    async invoke(_request: ProviderInvokeRequest) {
      const result = results[Math.min(provider.calls, results.length - 1)]!;
      provider.calls += 1;
      return result;
    },
  };
  return provider;
}

async function start(opts: {
  provider?: IntelligenceProvider;
  providers?: Record<string, IntelligenceProvider>;
  config?: Partial<AppConfig>;
  store?: MemoryStore;
} = {}) {
  const store = opts.store ?? new MemoryStore();
  const app = buildApp(testConfig(opts.config), {
    provider: opts.provider ?? new TestProvider(),
    providers: opts.providers,
    resolver: actors,
    store,
    drive: new MemoryDrive(),
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

async function grant(app: Awaited<ReturnType<typeof start>>["app"], units = 10_000, ownerId = "TD-A", ownerType = "actor") {
  return app.inject({
    method: "POST",
    url: "/internal/credits/grant",
    headers: headers("actor-a", "operator", "operator-secret"),
    payload: { ownerType, ownerId, units, idempotencyKey: `grant-${ownerType}-${ownerId}-${units}`, reasonCode: "test_fixture" },
  });
}

test("1-4 account creation, actor isolation, tenant isolation, append-only grant", async () => {
  const store = new MemoryStore();
  const a = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 500,
    idempotencyKey: "g1",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const b = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-B",
    units: 80,
    idempotencyKey: "g2",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const tenant = await store.grantCredits({
    ownerType: "tenant",
    ownerId: "life-a",
    tenantId: "life-a",
    units: 300,
    idempotencyKey: "g3",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  expect(a.account.accountId).not.toBe(b.account.accountId);
  expect(a.account.accountId).not.toBe(tenant.account.accountId);
  expect((await store.computeCreditBalance(a.account.accountId)).availableUnits).toBe(500);
  expect((await store.computeCreditBalance(b.account.accountId)).availableUnits).toBe(80);
  expect((await store.computeCreditBalance(tenant.account.accountId)).availableUnits).toBe(300);
  expect(store.creditEntries.every((row) => row.kind !== "GRANT" || row.units > 0)).toBe(true);
});

test("5 grant idempotency", async () => {
  const store = new MemoryStore();
  const first = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 200,
    idempotencyKey: "same-grant",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const second = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 200,
    idempotencyKey: "same-grant",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);
  expect((await store.computeCreditBalance(first.account.accountId)).postedUnits).toBe(200);
});

test("6-8 reservation creation, idempotency, concurrent protection", async () => {
  const store = new MemoryStore();
  const grantRow = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 100,
    idempotencyKey: "g",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const first = await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-1",
    estimatedUnits: 80,
    reservedUnits: 80,
    meteringPolicyVersion: "dev-think-1",
    idempotencyKey: "rsv-1",
  });
  const replay = await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-1",
    estimatedUnits: 80,
    reservedUnits: 80,
    meteringPolicyVersion: "dev-think-1",
    idempotencyKey: "rsv-1",
  });
  expect(first.inserted).toBe(true);
  expect(replay.inserted).toBe(false);
  expect(replay.reservation.reservationId).toBe(first.reservation.reservationId);
  await store.releaseReservation({ reservationId: first.reservation.reservationId });
  const [left, right] = await Promise.all([
    store.reserveCredits({
      accountId: grantRow.account.accountId,
      logicalRequestId: "req-a",
      estimatedUnits: 80,
      reservedUnits: 80,
      meteringPolicyVersion: "dev-think-1",
      idempotencyKey: "rsv-a",
    }),
    store.reserveCredits({
      accountId: grantRow.account.accountId,
      logicalRequestId: "req-b",
      estimatedUnits: 80,
      reservedUnits: 80,
      meteringPolicyVersion: "dev-think-1",
      idempotencyKey: "rsv-b",
    }),
  ]);
  expect([left.insufficient, right.insufficient].filter(Boolean).length).toBe(1);
  expect([left.inserted, right.inserted].filter(Boolean).length).toBe(1);
});

test("9-13 insufficient, release, partial, exact, actual>reserved", async () => {
  const store = new MemoryStore();
  const grantRow = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 50,
    idempotencyKey: "g",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const blocked = await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-big",
    estimatedUnits: 80,
    reservedUnits: 80,
    meteringPolicyVersion: "dev-think-1",
  });
  expect(blocked.insufficient).toBe(true);
  const reserved = await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-ok",
    estimatedUnits: 40,
    reservedUnits: 40,
    meteringPolicyVersion: "dev-think-1",
  });
  const released = await store.releaseReservation({ reservationId: reserved.reservation.reservationId });
  expect(released.reservation.status).toBe("released");
  expect((await store.computeCreditBalance(grantRow.account.accountId)).availableUnits).toBe(50);

  const exact = await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-exact",
    estimatedUnits: 40,
    reservedUnits: 40,
    meteringPolicyVersion: "dev-think-1",
  });
  const exactSettle = await store.settleReservation({ reservationId: exact.reservation.reservationId, actualUnits: 40 });
  expect(exactSettle.reservation.consumedUnits).toBe(40);
  expect(exactSettle.reservation.releasedUnits).toBe(0);

  const more = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 20,
    idempotencyKey: "g2",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const partial = await store.reserveCredits({
    accountId: more.account.accountId,
    logicalRequestId: "req-partial",
    estimatedUnits: 20,
    reservedUnits: 20,
    meteringPolicyVersion: "dev-think-1",
  });
  const partialSettle = await store.settleReservation({ reservationId: partial.reservation.reservationId, actualUnits: 8 });
  expect(partialSettle.reservation.consumedUnits).toBe(8);
  expect(partialSettle.reservation.releasedUnits).toBe(12);

  const over = await store.reserveCredits({
    accountId: more.account.accountId,
    logicalRequestId: "req-over",
    estimatedUnits: 10,
    reservedUnits: 10,
    meteringPolicyVersion: "dev-think-1",
  });
  const available = (await store.computeCreditBalance(more.account.accountId)).availableUnits;
  const overSettle = await store.settleReservation({
    reservationId: over.reservation.reservationId,
    actualUnits: 40,
    additionalAvailable: available,
  });
  expect(overSettle.reservation.consumedUnits).toBeLessThanOrEqual(10 + available);
  expect(overSettle.reservation.shortfallUnits).toBeGreaterThan(0);
  expect((await store.computeCreditBalance(more.account.accountId)).availableUnits).toBeGreaterThanOrEqual(0);
});

test("14-16 failed request release, safety refusal, stale reservation", async () => {
  const store = new MemoryStore();
  const grantRow = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 100,
    idempotencyKey: "g",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  const reserved = await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-fail",
    estimatedUnits: 20,
    reservedUnits: 20,
    meteringPolicyVersion: "dev-think-1",
  });
  const released = await store.releaseReservation({ reservationId: reserved.reservation.reservationId, reasonCode: "failed" });
  expect(released.reservation.status).toBe("released");
  expect(hasBillableNativeUsage({})).toBe(false);
  expect(hasBillableNativeUsage({ videoSeconds: 4 })).toBe(true);
  store.creditReservations.push({
    ...reserved.reservation,
    reservationId: "rsv_stale",
    logicalRequestId: "req-stale",
    status: "held",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    providerOperationId: undefined,
  });
  const report = await reconcileCredits(store);
  expect(report.anomalies.some((row) => row.code === "stale_reservation")).toBe(true);
});

test("17-23 adjustment, audit, pagination, unauthorized, cross-tenant, browser grant, browser override", async () => {
  const live = await start();
  await grant(live.app, 400);
  const adjust = await live.app.inject({
    method: "POST",
    url: "/internal/credits/adjustment",
    headers: headers("actor-a", "operator", "operator-secret"),
    payload: { ownerType: "actor", ownerId: "TD-A", units: -40, idempotencyKey: "adj-1", reasonCode: "manual_correction" },
  });
  expect(adjust.statusCode).toBe(200);
  expect(adjust.json().entry.authorizedBy).toBe("operator");
  expect(adjust.json().entry.reasonCode).toBe("manual_correction");
  const page = await live.app.inject({
    method: "GET",
    url: "/v1/credits/ledger?limit=1",
    headers: headers(),
  });
  expect(page.statusCode).toBe(200);
  expect(page.json().entries).toHaveLength(1);
  expect(page.json().nextCursor).toBeTruthy();
  const other = await live.app.inject({
    method: "GET",
    url: `/v1/credits/ledger?accountId=${adjust.json().account.accountId}`,
    headers: headers("actor-b"),
  });
  expect(other.statusCode).toBe(403);
  const browserGrant = await live.app.inject({
    method: "POST",
    url: "/internal/credits/grant",
    headers: { authorization: "Bearer actor-a" },
    payload: { ownerType: "actor", ownerId: "TD-A", units: 999, idempotencyKey: "nope", reasonCode: "self" },
  });
  expect([401, 403]).toContain(browserGrant.statusCode);
  const override = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello", digiAiUnits: 9, meteringRate: 1 },
  });
  expect(override.statusCode).toBe(400);
});

test("24-27 policy version, effective dates, overlap, integer precision", () => {
  const policy = selectMeteringPolicy({ capability: "THINK" });
  expect(policy?.version).toBe("dev-think-1");
  expect(policy?.commercial).toBe(false);
  expect(selectMeteringPolicy({ capability: "THINK", at: "2020-01-01T00:00:00.000Z" })).toBeNull();
  const overlap = detectOverlappingPolicies([
    {
      policyId: "a",
      version: "c1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      status: "commercial",
      commercial: true,
      capability: "THINK",
      meteringDimensions: [],
      minimumCharge: 1,
      outputTokenHeadroom: 1,
      reservationTtlSeconds: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      policyId: "b",
      version: "c2",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      status: "commercial",
      commercial: true,
      capability: "THINK",
      meteringDimensions: [],
      minimumCharge: 1,
      outputTokenHeadroom: 1,
      reservationTtlSeconds: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ] as DigiAiMeteringPolicy[]);
  expect(overlap).toContain("THINK:c1+c2");
  expect(DIGI_AI_UNIT_SCALE).toBe(1_000_000);
  expect(assertUnits(12)).toBe(12);
  expect(() => assertUnits(1.25)).toThrow();
});

test("28 THINK metering reserve and settle", async () => {
  const live = await start();
  await grant(live.app, 5_000);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Explain Digi AI units.", mode: "reason" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().usage.digiAiUnits).toBeNull();
  expect(res.json().economics.estimatedDigiAiUnits).toBeGreaterThan(0);
  expect(res.json().economics.consumedDigiAiUnits).toBeGreaterThan(0);
  expect(res.json().economics.meteringPolicyVersion).toBe("dev-think-1");
  expect(live.store.creditReservations).toHaveLength(1);
  expect(live.store.creditReservations[0]?.status).toBe("settled");
});

test("29 IMAGE metering", async () => {
  const image = scripted("openai", [{
    ok: true,
    provider: "openai",
    model: "gpt-image-1",
    text: "image",
    media: [{ mimeType: "image/png", byteSize: 64, contentBase64: TINY_PNG, width: 1024, height: 1024 }],
    usage: { generatedImageCount: 1, imageCount: 1, imageWidth: 1024, imageHeight: 1024 },
    latencyMs: 5,
  }]);
  const live = await start({ providers: { openai: image }, config: { openaiApiKey: "sk-test", defaultModels: { ...loadConfig().defaultModels, IMAGE: "gpt-image-1" } } });
  await grant(live.app, 5_000);
  const estimate = estimateDigiAiUnits({ capability: "IMAGE", constraints: { count: 1 } });
  expect(estimate.units).toBe(100);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "draw a square", capability: "IMAGE", constraints: { count: 1 } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().economics.consumedDigiAiUnits).toBe(100);
  expect(res.json().usage.estimatedProviderCost).not.toBe(res.json().economics.consumedDigiAiUnits);
});

test("30 speech/audio metering", async () => {
  const tts = scripted("openai", [{
    ok: true,
    provider: "openai",
    model: "tts-1",
    text: "spoken",
    media: [{ mimeType: "audio/wav", byteSize: WAV.length, contentBase64: WAV_B64 }],
    usage: { characterCount: 200 },
    latencyMs: 4,
  }]);
  const live = await start({ providers: { openai: tts }, config: { openaiApiKey: "sk-test" } });
  await grant(live.app, 5_000);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "hello from Digi AI speech path", capability: "TEXT_TO_SPEECH" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().economics.consumedDigiAiUnits).toBeGreaterThan(0);
  expect(res.json().usage.digiAiUnits).toBeNull();
});

test("31 MUSIC metering", async () => {
  const music = scripted("gemini", [{
    ok: true,
    provider: "gemini",
    model: "lyria-3-clip-preview",
    text: "track",
    media: [{ mimeType: "audio/mpeg", byteSize: 32, contentBase64: WAV_B64, durationSeconds: 30 }],
    usage: { trackCount: 1, generatedSeconds: 30, providerNativeUnitAmount: 1 },
    latencyMs: 6,
  }]);
  const live = await start({ providers: { gemini: music }, config: { geminiApiKey: "AIza-test" } });
  await grant(live.app, 5_000);
  const estimate = estimateDigiAiUnits({ capability: "MUSIC", constraints: { durationSeconds: 30, count: 1 } });
  expect(estimate.units).toBe(80);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "calm instrumental clip", capability: "MUSIC", constraints: { durationSeconds: 30 } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().economics.consumedDigiAiUnits).toBeGreaterThan(0);
});

test("32-36 VIDEO estimate, reserve, processing retain, replay, complete", async () => {
  const video = scripted("gemini", [
    {
      ok: true,
      provider: "gemini",
      model: LITE_MODEL,
      text: "processing",
      media: [],
      usage: {},
      providerRequestId: "operations/video-1",
      jobStatus: "processing",
      latencyMs: 8,
    },
    {
      ok: true,
      provider: "gemini",
      model: LITE_MODEL,
      text: "done",
      media: [{ mimeType: "video/mp4", byteSize: 4, contentBase64: MP4_B64, durationSeconds: 4, width: 1280, height: 720, frameRate: 24, audioPresent: true }],
      usage: { videoCount: 1, videoSeconds: 4, generatedSeconds: 4, providerNativeUnitAmount: 4 },
      providerRequestId: "operations/video-1",
      jobStatus: "completed",
      latencyMs: 12,
    },
  ]);
  const live = await start({ providers: { gemini: video }, config: { geminiApiKey: "AIza-test" } });
  await grant(live.app, 5_000);
  expect(estimateDigiAiUnits({ capability: "VIDEO", constraints: { durationSeconds: 4 } }).units).toBe(100);
  const first = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "a lantern in rain", capability: "VIDEO", idempotencyKey: "video-1", constraints: { durationSeconds: 4 } },
  });
  expect(first.statusCode).toBe(200);
  expect(first.json().execution.finishState).toBe("processing");
  expect(live.store.creditReservations).toHaveLength(1);
  expect(live.store.creditReservations[0]?.status).toBe("held");
  const replay = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "a lantern in rain", capability: "VIDEO", idempotencyKey: "video-1", constraints: { durationSeconds: 4 } },
  });
  expect(replay.statusCode).toBe(200);
  expect(live.store.creditReservations).toHaveLength(1);
  expect(replay.json().execution.finishState).toBe("completed");
  expect(live.store.creditReservations[0]?.status).toBe("settled");
  expect(replay.json().economics.consumedDigiAiUnits).toBe(100);
});

test("37 VIDEO failure releases when no billable generation", async () => {
  const video = scripted("gemini", [{
    ok: false,
    provider: "gemini",
    error: "provider_error",
    detail: "veo failed",
    retryable: false,
    latencyMs: 3,
  }]);
  const live = await start({ providers: { gemini: video }, config: { geminiApiKey: "AIza-test" } });
  await grant(live.app, 5_000);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "a lantern", capability: "VIDEO", constraints: { durationSeconds: 4 } },
  });
  expect(res.json().ok).toBe(false);
  expect(live.store.creditReservations[0]?.status).toBe("released");
  expect(live.store.creditReservations[0]?.releasedUnits).toBeGreaterThan(0);
});

test("38-39 failover does not double-charge; attempts stay independent", async () => {
  const openai = scripted("openai", [{
    ok: false,
    provider: "openai",
    error: "quota",
    detail: "quota",
    retryable: true,
    latencyMs: 2,
  }]);
  const gemini = scripted("gemini", [{
    ok: true,
    provider: "gemini",
    model: "gemini-2.0-flash",
    text: "recovered",
    usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    latencyMs: 4,
  }]);
  const live = await start({
    providers: { openai, gemini },
    config: { openaiApiKey: "sk-test", geminiApiKey: "AIza-test", allowFailover: true, maxProviderAttempts: 2 },
  });
  await grant(live.app, 5_000);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "failover economy", mode: "reason" },
  });
  expect(res.statusCode).toBe(200);
  expect(live.store.ledger.filter((row) => row.kind === "usage").length).toBe(2);
  expect(live.store.creditReservations).toHaveLength(1);
  expect(live.store.creditEntries.filter((row) => row.kind === "CONSUME")).toHaveLength(1);
});

test("40 Drive persistence does not add AI units", async () => {
  const live = await start();
  const before = live.store.creditEntries.length;
  const accept = await live.app.inject({
    method: "POST",
    url: "/internal/media/drive-acceptance",
    headers: headers("actor-a", "operator", "operator-secret"),
  });
  expect([200, 502]).toContain(accept.statusCode);
  expect(live.store.creditEntries.length).toBe(before);
});

test("41-42 provider cost remains separate and actualProviderCost stays null", async () => {
  const live = await start();
  await grant(live.app, 5_000);
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "keep layers separate" },
  });
  expect(res.json().usage.actualProviderCost).toBeNull();
  expect(res.json().usage.digiAiUnits).toBeNull();
  expect(res.json().economics.consumedDigiAiUnits).not.toBe(res.json().usage.estimatedProviderCost);
});

test("43-44 prompt/media absent from credit ledger; health sanitized", async () => {
  const live = await start();
  await grant(live.app, 5_000);
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "secret prompt body must not be stored in credits" },
  });
  expect(JSON.stringify(live.store.creditEntries)).not.toMatch(/secret prompt body/);
  const health = (await live.app.inject({ method: "GET", url: "/health" })).json();
  expect(health.economics.creditLedger.writable).toBe(true);
  expect(health.economics.metering.loaded).toBe(true);
  expect(health.economics.metering.mode).toBe("observe");
  expect(health.economics.metering.commercialPolicyConfigured).toBe(false);
  expect(health.economics.reservations.supported).toBe(true);
  expect(JSON.stringify(health)).not.toMatch(/TD-A|secret prompt|operator-secret|sk-/);
});

test("45 observe does not block without commercial balances", async () => {
  const live = await start({ config: { economicsMode: "observe" } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "existing consumer continues" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().economics.mode).toBe("observe");
});

test("46 enforce insufficient balance blocks before provider", async () => {
  const provider = new TestProvider();
  const live = await start({ provider, config: { economicsMode: "enforce" } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "should not execute" },
  });
  expect(res.statusCode).toBe(402);
  expect(provider.calls).toHaveLength(0);
});

test("47 DB unavailable is safe in enforcement", async () => {
  const store = new MemoryStore();
  store.setWritable(false);
  const provider = new TestProvider();
  const live = await start({ store, provider, config: { economicsMode: "enforce" } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "wallet down" },
  });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toBe("credit_ledger_unavailable");
  expect(provider.calls).toHaveLength(0);
});

test("48-49 reconciliation missing settlement and stale reservation", async () => {
  const store = new MemoryStore();
  const grantRow = await store.grantCredits({
    ownerType: "actor",
    ownerId: "TD-A",
    units: 20,
    idempotencyKey: "g",
    authorizedBy: "operator",
    reasonCode: "test_fixture",
  });
  await store.reserveCredits({
    accountId: grantRow.account.accountId,
    logicalRequestId: "req-missing",
    estimatedUnits: 10,
    reservedUnits: 10,
    meteringPolicyVersion: "dev-think-1",
  });
  await store.recordReceipt({
    receiptId: "rcpt-missing",
    requestId: "req-missing",
    correlationId: "req-missing",
    actorTrustId: "TD-A",
    callerId: "test",
    operation: "ask",
    sourcesAccessed: [],
    capability: "THINK",
    resultStatus: "completed",
    createdAt: new Date().toISOString(),
  });
  const report = await reconcileCredits(store);
  expect(report.anomalies.some((row) => row.code === "missing_settlement")).toBe(true);
});

test("50 operator grant and own summary do not expose provider cost", async () => {
  const live = await start();
  await grant(live.app, 250);
  const summary = await live.app.inject({
    method: "GET",
    url: "/v1/credits/summary",
    headers: headers(),
  });
  expect(summary.statusCode).toBe(200);
  expect(summary.json().summary.availableUnits).toBe(250);
  expect(summary.json().summary.commercialPolicyConfigured).toBe(false);
  expect(JSON.stringify(summary.json())).not.toMatch(/estimatedProviderCost|actualProviderCost|margin/);
});

test("acceptance fixture is isolated and idempotent", async () => {
  const live = await start();
  const first = await live.app.inject({
    method: "POST",
    url: "/internal/credits/acceptance",
    headers: headers("actor-a", "operator", "operator-secret"),
  });
  const second = await live.app.inject({
    method: "POST",
    url: "/internal/credits/acceptance",
    headers: headers("actor-a", "operator", "operator-secret"),
  });
  expect(first.statusCode).toBe(200);
  expect(first.json().grantIdempotent).toBe(true);
  expect(first.json().reserveIdempotent).toBe(true);
  expect(first.json().isolated).toBe(true);
  expect(second.json().grantInserted).toBe(false);
});
