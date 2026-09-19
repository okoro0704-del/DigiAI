import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { getCapability } from "../src/capabilities/catalog.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { persistVideoAcceptanceFixture, tinyMp4Fixture, VIDEO_DRIVE_ACCEPTANCE_LABEL } from "../src/media/acceptance.js";
import { MemoryDrive } from "../src/media/drive.js";
import { TestProvider } from "../src/providers/test.js";
import { buildVeoPredictBody, parseVeoOperation } from "../src/providers/gemini.js";
import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "../src/providers/types.js";
import { createProviderPool } from "../src/providers/pool.js";
import { listCatalogModels } from "../src/registry/models.js";
import { getProviderCatalog } from "../src/registry/providers.js";
import { decideRoute } from "../src/routing/policy.js";
import { buildRuntimeRegistry, routeCapability } from "../src/routing/runtime.js";
import { MemoryStore } from "../src/store/memory.js";
import { estimateProviderCost } from "../src/usage/cost.js";
import { selectPricing } from "../src/usage/pricing-catalog.js";
import { LITE_MODEL, STANDARD_MODEL, parseVideoRequest, selectVideoModel, videoPixelSize } from "../src/intelligence/video.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP4 = tinyMp4Fixture();
const MP4_B64 = MP4.toString("base64");

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
    operatorCallers: ["test"],
    trustIdApi: "http://trustid.test",
    allowAttestedActor: false,
    openaiApiKey: "",
    geminiApiKey: "",
    aiProvider: "unbound",
    allowFailover: true,
    maxProviderAttempts: 2,
    maxTransientBytes: 8_000_000,
    maxVideoSeconds: 8,
    maxVideoOutputs: 2,
    videoTimeoutMs: 50,
    videoPollMs: 1,
    sovereignDriveUrl: "",
    sovereignDriveJwtSecret: "",
    ...overrides,
  };
}

const actors: IdentityResolver = {
  async resolveToken(token: string) {
    if (token === "actor-a") return { trustId: "TD-A", displayName: "Actor A", tenantId: "life-a" };
    if (token === "actor-b") return { trustId: "TD-B", displayName: "Actor B", tenantId: "life-b" };
    return null;
  },
};

const apps: Array<{ close: () => Promise<void> }> = [];

function scripted(name: string, results: ProviderResult[]): IntelligenceProvider & { calls: number; last?: ProviderInvokeRequest; seen: ProviderInvokeRequest[] } {
  const provider: IntelligenceProvider & { calls: number; last?: ProviderInvokeRequest; seen: ProviderInvokeRequest[] } = {
    name,
    configured: true,
    calls: 0,
    seen: [],
    async invoke(request) {
      provider.last = request;
      provider.seen.push(request);
      const result = results[Math.min(provider.calls, results.length - 1)]!;
      provider.calls += 1;
      return result;
    },
  };
  return provider;
}

function videoOk(operationId = "operations/video-1"): ProviderResult {
  return {
    ok: true,
    provider: "gemini",
    model: LITE_MODEL,
    text: "Generated original synthesized video.",
    media: [{
      mimeType: "video/mp4",
      byteSize: MP4.length,
      contentBase64: MP4_B64,
      durationSeconds: 4,
      requestedDurationSeconds: 4,
      width: 1280,
      height: 720,
      frameRate: 24,
      audioPresent: true,
    }],
    usage: { videoCount: 1, videoSeconds: 4, generatedSeconds: 4, outputBytes: MP4.length, providerNativeUnitAmount: 4 },
    providerRequestId: operationId,
    jobStatus: "completed",
    latencyMs: 12,
  };
}

function videoProcessing(): ProviderResult {
  return {
    ok: true,
    provider: "gemini",
    model: LITE_MODEL,
    text: "Video generation is still processing.",
    media: [],
    usage: {},
    providerRequestId: "operations/video-1",
    jobStatus: "processing",
    latencyMs: 8,
  };
}

function thinkOk(text = "ok"): ProviderResult {
  return {
    ok: true,
    provider: "openai",
    model: "gpt-4o-mini",
    text,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    latencyMs: 2,
  };
}

function imageOk(): ProviderResult {
  return {
    ok: true,
    provider: "openai",
    model: "gpt-image-1",
    text: "Generated 1 image.",
    media: [{ mimeType: "image/png", width: 1024, height: 1024, byteSize: 64, contentBase64: TINY_PNG }],
    usage: { generatedImageCount: 1, imageCount: 1 },
    latencyMs: 5,
  };
}

function musicOk(): ProviderResult {
  return {
    ok: true,
    provider: "gemini",
    model: "lyria-3-clip-preview",
    text: "Generated original musical audio.",
    media: [{ mimeType: "audio/mpeg", byteSize: 32, contentBase64: Buffer.alloc(32).toString("base64"), durationSeconds: 30 }],
    usage: { trackCount: 1, generatedSeconds: 30 },
    latencyMs: 4,
  };
}

async function start(opts: {
  provider?: IntelligenceProvider;
  providers?: Record<string, IntelligenceProvider>;
  config?: Partial<AppConfig>;
  drive?: MemoryDrive;
} = {}) {
  const store = new MemoryStore();
  const app = buildApp(testConfig(opts.config), {
    provider: opts.provider,
    providers: opts.providers,
    resolver: actors,
    store,
    drive: opts.drive,
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

test("VIDEO is a first-class capability distinct from IMAGE and MUSIC", () => {
  expect(getCapability("VIDEO").modalityOut).toEqual(["video"]);
  expect(getCapability("VIDEO").id).not.toBe(getCapability("IMAGE").id);
  expect(getCapability("VIDEO").id).not.toBe(getCapability("MUSIC").id);
});

test("VIDEO provider and model eligibility is Gemini Veo only", () => {
  expect(getProviderCatalog("gemini")?.capabilities).toContain("VIDEO");
  expect(getProviderCatalog("openai")?.capabilities).not.toContain("VIDEO");
  const models = listCatalogModels().filter((row) => row.capabilities.includes("VIDEO"));
  expect(models.map((row) => row.id).sort()).toEqual([
    "veo-3.1-fast-generate-preview",
    "veo-3.1-generate-preview",
    "veo-3.1-lite-generate-preview",
  ].sort());
});

test("unconfigured Gemini cannot serve VIDEO", async () => {
  const live = await start();
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A simple abstract blue sphere slowly rotating against a neutral background.", capability: "VIDEO" },
  });
  expect([400, 503]).toContain(res.statusCode);
  expect(res.json().error).toBe("provider_unavailable");
});

test("disabled Veo models cannot receive VIDEO", () => {
  const registry = buildRuntimeRegistry(testConfig({ disabledModels: [LITE_MODEL, "veo-3.1-fast-generate-preview", STANDARD_MODEL] }), new TestProvider());
  const decision = decideRoute({
    capability: "VIDEO",
    privacyClass: "PUBLIC",
    providers: registry.providers,
    models: registry.models,
    defaultModel: LITE_MODEL,
    providerPriority: ["gemini"],
  });
  expect(decision.ok).toBe(false);
});

test("provider-neutral request, duration, aspect, resolution, and image-to-video", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "A simple abstract blue sphere slowly rotating against a neutral background.",
      capability: "VIDEO",
      constraints: { durationSeconds: 4, aspectRatio: "16:9", resolution: "720p" },
    },
  });
  expect(res.statusCode).toBe(200);
  expect(gemini.last?.capability).toBe("VIDEO");
  expect(gemini.last?.model).toBe(LITE_MODEL);
  expect(gemini.last?.durationSeconds).toBe(4);
  expect(gemini.last?.aspectRatio).toBe("16:9");
  const body = res.json();
  expect(body.media[0].capability).toBe("VIDEO");
  expect(body.media[0].mimeType).toBe("video/mp4");
  expect(body.media[0].durationSeconds).toBe(4);
  expect(body.media[0].frameRate).toBe(24);
  expect(body.media[0].audioPresent).toBe(true);
  expect(body.media[0].persistenceState).toBe("transient");
  expect(body.answer).toMatch(/synthesized/i);
  expect(body.answer).toMatch(/not a human-recorded/i);
  expect(body.answer).toMatch(/not a publication/i);
});

test("invalid duration, aspect, resolution, and count are rejected before provider execution", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const live = await start({ providers: { gemini } });
  const duration = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "clip", capability: "VIDEO", constraints: { durationSeconds: 12 } },
  });
  const aspect = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "clip", capability: "VIDEO", constraints: { aspectRatio: "1:1" } },
  });
  const count = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "clip", capability: "VIDEO", constraints: { count: 100 } },
  });
  expect(duration.statusCode).toBe(400);
  expect(aspect.statusCode).toBe(400);
  expect(count.statusCode).toBe(400);
  expect(gemini.calls).toBe(0);
});

test("4k lite combination and source-video operations are rejected", async () => {
  expect(() => parseVideoRequest({
    message: "clip",
    constraints: { resolution: "4k", videoQuality: "lite", durationSeconds: 8 },
    config: testConfig(),
  })).toThrow(/4k/i);
  expect(selectVideoModel({
    instruction: "x",
    durationSeconds: 8,
    aspectRatio: "16:9",
    resolution: "4k",
    quality: "standard",
    audioMode: "native",
    count: 1,
    operation: "generate",
  })).toBe(STANDARD_MODEL);
  expect(videoPixelSize("9:16", "720p")).toEqual({ width: 720, height: 1280 });
  const live = await start({ providers: { gemini: scripted("gemini", [videoOk()]) } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "clip", capability: "VIDEO", operation: "extend" },
  });
  expect(res.statusCode).toBe(400);
});

test("canonical persist, Drive write, provenance, and persistence failure", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const drive = new MemoryDrive();
  const live = await start({ providers: { gemini }, drive });
  const ok = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", constraints: { persistCanonical: true } },
  });
  expect(ok.json().media[0].persistenceState).toBe("canonical");
  expect(ok.json().media[0].canonicalAssetReference).toBeTruthy();
  expect(ok.json().media[0].provenance.generated).toBe(true);
  expect(ok.json().media[0].provenance.capability).toBe("VIDEO");
  expect(drive.lastWrite?.mimeType).toBe("video/mp4");
  expect(drive.lastWrite?.durationSeconds).toBe(4);
  expect(drive.writes).toBe(1);
  const failing = new MemoryDrive([], { writeError: "drive_write_failed" });
  const gemini2 = scripted("gemini", [videoOk()]);
  const live2 = await start({ providers: { gemini: gemini2 }, drive: failing });
  const failed = await live2.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", constraints: { persistCanonical: true } },
  });
  expect(failed.json().media[0].persistenceState).toBe("failed");
  expect(failed.json().media[0].canonicalAssetReference).toBeUndefined();
});

test("usage receipt, videoSeconds, videoCount, operation id, pricing, estimate, actual null", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO" },
  });
  const usage = res.json().usage;
  expect(usage.capability).toBe("VIDEO");
  expect(usage.nativeUsage.videoSeconds).toBe(4);
  expect(usage.nativeUsage.videoCount).toBe(1);
  expect(usage.providerNativeUnits).toEqual({ type: "video_seconds", amount: 4 });
  expect(usage.pricingVersion).toBe("gemini-veo-3.1-lite-2026-09-01");
  expect(usage.estimatedProviderCost).toBeCloseTo(0.2);
  expect(usage.actualProviderCost).toBeNull();
  expect(usage.digiAiUnits).toBeNull();
  expect(live.store.ledger[0]?.providerRequestId).toBe("operations/video-1");
  expect(JSON.stringify(live.store.ledger[0])).not.toContain(MP4_B64);
  expect(selectPricing({ providerId: "gemini", modelId: LITE_MODEL })?.dimensions[0]?.perUnit).toBe(0.05);
  expect(estimateProviderCost({ providerId: "gemini", modelId: LITE_MODEL, nativeUsage: { videoSeconds: 4 } }).actualProviderCost).toBeNull();
});

test("multiple outputs remain one logical request", async () => {
  const gemini = scripted("gemini", [videoOk("operations/video-a"), videoOk("operations/video-b")]);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", constraints: { count: 2 } },
  });
  expect(res.json().media).toHaveLength(2);
  expect(gemini.calls).toBe(2);
  const summary = await live.store.aggregateUsage({});
  expect(summary.requestCount).toBe(1);
  expect(summary.attemptCount).toBe(2);
});

test("async processing resume does not submit a second provider job", async () => {
  const gemini = scripted("gemini", [videoProcessing(), videoOk()]);
  const live = await start({ providers: { gemini } });
  const first = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", idempotencyKey: "video-async-1" },
  });
  expect(first.json().execution.finishState).toBe("processing");
  expect(first.json().media).toEqual([]);
  const replay = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", idempotencyKey: "video-async-1" },
  });
  expect(replay.json().ok).toBe(true);
  expect(replay.json().media[0].capability).toBe("VIDEO");
  expect(gemini.calls).toBe(2);
  expect(gemini.seen[1]?.providerOperationId).toBe("operations/video-1");
});

test("completed replay and persistence retry do not regenerate", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const drive = new MemoryDrive([], { failNextWrites: 1 });
  const live = await start({ providers: { gemini }, drive });
  const first = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", constraints: { persistCanonical: true }, idempotencyKey: "video-1" },
  });
  expect(first.json().media[0].persistenceState).toBe("failed");
  const retry = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "A rotating blue sphere.", capability: "VIDEO", constraints: { persistCanonical: true }, idempotencyKey: "video-1" },
  });
  expect(retry.json().receiptId).toBe(first.json().receiptId);
  expect(retry.json().media[0].persistenceState).toBe("canonical");
  expect(gemini.calls).toBe(1);
  expect(drive.writes).toBe(1);
});

test("HIGHLY_SENSITIVE video cannot use cloud Gemini", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const blocked = routeCapability({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { gemini }),
    capability: "VIDEO",
    privacyClass: "HIGHLY_SENSITIVE",
  });
  expect(blocked.decision.ok).toBe(false);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "secret", capability: "VIDEO", constraints: { privacyClass: "HIGHLY_SENSITIVE" } },
  });
  expect(res.statusCode).toBe(400);
  expect(gemini.calls).toBe(0);
});

test("browser override rejected and safety refusal does not fail over", async () => {
  const gemini = scripted("gemini", [{
    ok: false,
    provider: "gemini",
    model: LITE_MODEL,
    error: "safety_refused",
    detail: "The provider refused this request under its safety policy.",
    latencyMs: 2,
  }]);
  const openai = scripted("openai", [thinkOk(), imageOk()]);
  const live = await start({ providers: { gemini, openai } });
  const forced = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-a", "tenant-a", "a-secret"),
    payload: { message: "clip", capability: "VIDEO", provider: "openai", model: "sora-2" },
  });
  expect(forced.statusCode).toBe(400);
  const safety = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "clip", capability: "VIDEO" },
  });
  expect(safety.json().error).toBe("safety_refused");
  expect(openai.calls).toBe(0);
});

test("source image requires Drive authorization and preserves lineage", async () => {
  const gemini = scripted("gemini", [videoOk()]);
  const drive = new MemoryDrive([{
    assetId: "drv_private",
    tenantId: "life-b",
    actorTrustId: "TD-B",
    mimeType: "image/png",
    bytes: Buffer.from(TINY_PNG, "base64"),
    hash: "abc",
  }]);
  const live = await start({ providers: { gemini }, drive });
  const denied = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Animate this.",
      capability: "VIDEO",
      operation: "image_to_video",
      images: [{ sourceType: "sovereign_drive", assetId: "drv_private" }],
    },
  });
  expect(denied.statusCode).toBe(403);
  expect(gemini.calls).toBe(0);
  const allowedDrive = new MemoryDrive([{
    assetId: "drv_ok",
    tenantId: "life-a",
    actorTrustId: "TD-A",
    mimeType: "image/png",
    bytes: Buffer.from(TINY_PNG, "base64"),
    hash: "abc",
  }]);
  const gemini2 = scripted("gemini", [videoOk()]);
  const live2 = await start({ providers: { gemini: gemini2 }, drive: allowedDrive });
  const ok = await live2.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Animate this.",
      capability: "VIDEO",
      images: [{ sourceType: "sovereign_drive", assetId: "drv_ok" }],
      constraints: { persistCanonical: true },
    },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().media[0].provenance.sourceAssetIds).toContain("drv_ok");
  expect(ok.json().media[0].canonicalAssetReference).not.toBe("drv_ok");
  expect(gemini2.last?.operation).toBe("image_to_video");
});

test("anonymous VIDEO and malformed source are rejected", async () => {
  const live = await start({ providers: { gemini: scripted("gemini", [videoOk()]) } });
  const anon = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    payload: { message: "clip", capability: "VIDEO" },
  });
  expect(anon.statusCode).toBe(401);
  const malformed = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "clip", capability: "VIDEO", images: [{ sourceType: "inline" }] },
  });
  expect(malformed.statusCode).toBe(400);
});

test("Veo request mapping and operation parsing", () => {
  const body = buildVeoPredictBody({
    messages: [{ role: "user", content: "sphere" }],
    durationSeconds: 4,
    aspectRatio: "9:16",
    resolution: "720p",
    images: [{ mimeType: "image/png", dataUrl: `data:image/png;base64,${TINY_PNG}` }],
  }, "sphere");
  expect(body.instances[0].prompt).toBe("sphere");
  expect(body.instances[0].image?.bytesBase64Encoded).toBe(TINY_PNG);
  expect(body.parameters.aspectRatio).toBe("9:16");
  expect(parseVeoOperation({ done: false }).kind).toBe("processing");
  expect(parseVeoOperation({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1 } } }).kind).toBe("safety");
  expect(parseVeoOperation({ done: true, response: { generateVideoResponse: { generatedSamples: [{}] } } }).kind).toBe("error");
  expect(parseVeoOperation({
    done: true,
    response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://example.test/v.mp4" } }] } },
  }).kind).toBe("ready");
});

test("VIDEO Drive acceptance is labeled and is not real generation", async () => {
  const drive = new MemoryDrive();
  const result = await persistVideoAcceptanceFixture({
    drive,
    actorTrustId: "TD-A",
    callerId: "test",
    tenantId: "life-a",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.label).toBe(VIDEO_DRIVE_ACCEPTANCE_LABEL);
    expect(result.readVerified).toBe(true);
    expect(result.note).toMatch(/Not real video generation/);
    expect(result.mimeType).toBe("video/mp4");
  }
  const live = await start({ drive });
  const res = await live.app.inject({ method: "POST", url: "/internal/media/video-acceptance", headers: headers(), payload: {} });
  expect(res.statusCode).toBe(200);
  expect(res.json().label).toBe(VIDEO_DRIVE_ACCEPTANCE_LABEL);
  expect(res.json().note).toMatch(/VIDEO DRIVE ACCEPTANCE/);
});

test("health VIDEO state and regressions stay green", async () => {
  const live = await start({
    providers: {
      gemini: scripted("gemini", [videoOk(), musicOk()]),
      openai: scripted("openai", [thinkOk(), imageOk()]),
    },
  });
  const health = await live.app.inject({ method: "GET", url: "/health" });
  expect(health.json().capabilities.VIDEO.supported).toBe(true);
  expect(health.json().capabilities.VIDEO.runtimeVerified).toBe(false);
  expect(health.json().video.canonicalPersistence).toBeTruthy();
  expect(JSON.stringify(health.json())).not.toMatch(/AIza|sk-/);
  const text = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload: { message: "hello" } });
  expect(text.statusCode).toBe(200);
  const image = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload: { message: "draw", capability: "IMAGE" } });
  expect(image.json().media[0].capability).toBe("IMAGE");
  const music = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload: { message: "score", capability: "MUSIC" } });
  expect(music.json().media[0].capability).toBe("MUSIC");
});
