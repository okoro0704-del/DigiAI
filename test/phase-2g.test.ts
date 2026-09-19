import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { getCapability } from "../src/capabilities/catalog.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { persistMusicAcceptanceFixture, MUSIC_DRIVE_ACCEPTANCE_LABEL } from "../src/media/acceptance.js";
import { tinyWavFixture } from "../src/media/audio.js";
import { MemoryDrive } from "../src/media/drive.js";
import { TestProvider } from "../src/providers/test.js";
import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "../src/providers/types.js";
import { createProviderPool } from "../src/providers/pool.js";
import { listCatalogModels } from "../src/registry/models.js";
import { decideRoute } from "../src/routing/policy.js";
import { buildRuntimeRegistry, routeCapability } from "../src/routing/runtime.js";
import { MemoryStore } from "../src/store/memory.js";
import { estimateProviderCost } from "../src/usage/cost.js";
import { selectPricing } from "../src/usage/pricing-catalog.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WAV = tinyWavFixture(0.05);
const WAV_B64 = WAV.toString("base64");

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
    maxMusicSeconds: 180,
    maxMusicOutputs: 4,
    maxMusicLyricsChars: 2000,
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

function musicOk(text = "Generated original musical audio."): ProviderResult {
  return {
    ok: true,
    provider: "gemini",
    model: "lyria-3-clip-preview",
    text,
    media: [{
      mimeType: "audio/mpeg",
      byteSize: WAV.length,
      contentBase64: WAV_B64,
      durationSeconds: 30,
      requestedDurationSeconds: 30,
      sampleRate: 44100,
      channels: 2,
    }],
    usage: { trackCount: 1, generatedSeconds: 30, inputCharacters: 40, outputBytes: WAV.length, providerNativeUnitAmount: 1 },
    latencyMs: 8,
  };
}

function sttOk(): ProviderResult {
  return {
    ok: true,
    provider: "openai",
    model: "whisper-1",
    text: "hello",
    language: "en",
    usage: { audioSeconds: 1, inputBytes: 64 },
    latencyMs: 3,
  };
}

function ttsOk(): ProviderResult {
  return {
    ok: true,
    provider: "openai",
    model: "tts-1",
    text: "Generated speech audio.",
    media: [{ mimeType: "audio/mpeg", byteSize: WAV.length, contentBase64: WAV_B64 }],
    usage: { characterCount: 8, outputBytes: WAV.length },
    latencyMs: 4,
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

test("1 MUSIC capability is generate-original-audio, not TTS", () => {
  expect(getCapability("MUSIC").modalityOut).toEqual(["audio"]);
  expect(getCapability("MUSIC").id).not.toBe(getCapability("TEXT_TO_SPEECH").id);
  expect(getCapability("MUSIC").id).not.toBe(getCapability("VOICE").id);
  expect(getCapability("VIDEO").id).toBe("VIDEO");
});

test("2-3 MUSIC provider and model eligibility is Gemini Lyria only", () => {
  const models = listCatalogModels();
  expect(models.find((row) => row.id === "lyria-3-clip-preview")?.capabilities).toEqual(["MUSIC"]);
  expect(models.find((row) => row.id === "lyria-3.5")?.capabilities).toEqual(["MUSIC"]);
  expect(models.find((row) => row.id === "tts-1")?.capabilities).not.toContain("MUSIC");
  const gemini = scripted("gemini", [musicOk()]);
  const openai = scripted("openai", [ttsOk()]);
  const routed = routeCapability({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { gemini, openai }),
    capability: "MUSIC",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok && routed.decision.selected.providerId).toBe("gemini");
  expect(routed.decision.ok && routed.decision.selected.modelId).toBe("lyria-3-clip-preview");
});

test("4 unconfigured Gemini cannot serve MUSIC", async () => {
  const live = await start({ providers: { openai: scripted("openai", [ttsOk()]) } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC" },
  });
  expect(res.statusCode).toBe(503);
  expect(["provider_unavailable", "provider_not_configured"]).toContain(res.json().error);
});

test("5 disabled Lyria models cannot receive MUSIC", () => {
  const gemini = scripted("gemini", [musicOk()]);
  const routed = routeCapability({
    config: testConfig({ disabledModels: ["lyria-3-clip-preview", "lyria-3.5"] }),
    pool: createProviderPool(testConfig(), { gemini }),
    capability: "MUSIC",
    privacyClass: "PRIVATE",
  });
  expect(routed.decision.ok).toBe(false);
});

test("6-11 provider-neutral request, duration, format, instrumental and vocal modes", async () => {
  const gemini = scripted("gemini", [musicOk(), musicOk()]);
  const live = await start({ providers: { gemini } });
  const ok = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Create a 30-second uplifting Afro-fusion instrumental",
      capability: "MUSIC",
      constraints: {
        durationSeconds: 30,
        vocalMode: "instrumental",
        mood: "uplifting",
        genre: "Afro-fusion",
        tempoBpm: 104,
        musicOutputFormat: "mp3",
      },
    },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().execution.provider).toBe("gemini");
  expect(gemini.last?.capability).toBe("MUSIC");
  expect(gemini.last?.messages[0]?.content).toContain("Instrumental only");
  expect(gemini.last?.messages[0]?.content).toContain("Afro-fusion");
  expect(gemini.last?.messages[0]?.content).not.toContain("sound exactly like");

  const long = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a song", capability: "MUSIC", constraints: { durationSeconds: 400 } },
  });
  expect(long.statusCode).toBe(400);
  expect(long.json().error).toBe("duration_too_long");

  const vocal = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Short reggae instrumental with horns",
      capability: "MUSIC",
      constraints: { vocalMode: "generated_vocal", lyrics: "Original hook about sunrise." },
    },
  });
  expect(vocal.statusCode).toBe(200);
  expect(gemini.last?.messages[0]?.content).toContain("generic provider voice");
  expect(gemini.last?.messages[0]?.content).toContain("Original lyrics supplied");
});

test("12-19 output normalization, transient, canonical, persistence failure, Drive, provenance", async () => {
  const gemini = scripted("gemini", [musicOk(), musicOk(), musicOk()]);
  const transientApp = await start({ providers: { gemini } });
  const transient = await transientApp.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC" },
  });
  expect(transient.json().media[0].capability).toBe("MUSIC");
  expect(transient.json().media[0].persistenceState).toBe("transient");
  expect(transient.json().media[0].provenance.generated).toBe(true);
  expect(transient.json().media[0].durationSeconds).toBe(30);
  expect(transient.json().answer).toContain("not a published song");

  const drive = new MemoryDrive();
  const persistApp = await start({ providers: { gemini }, drive });
  const canonical = await persistApp.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC", constraints: { persistCanonical: true } },
  });
  expect(canonical.json().media[0].persistenceState).toBe("canonical");
  expect(canonical.json().media[0].canonicalAssetReference).toMatch(/^drv_/);
  expect(canonical.json().media[0].contentBase64).toBeUndefined();
  expect(drive.writes).toBe(1);
  expect(drive.lastWrite?.capability).toBe("MUSIC");
  expect(drive.lastWrite?.generated).toBe(true);

  const failing = new MemoryDrive([], { writeError: "drive_write_failed" });
  const failApp = await start({ providers: { gemini }, drive: failing });
  const failed = await failApp.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC", constraints: { persistCanonical: true } },
  });
  expect(failed.json().ok).toBe(true);
  expect(failed.json().media[0].persistenceState).toBe("failed");
  expect(failed.json().media[0].canonicalAssetReference).toBeUndefined();
});

test("20-26 usage receipt, seconds, trackCount, native units, pricing, estimate, actual null", async () => {
  const gemini = scripted("gemini", [musicOk()]);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC" },
  });
  expect(res.json().usage.nativeUsage.trackCount).toBe(1);
  expect(res.json().usage.nativeUsage.generatedSeconds).toBe(30);
  expect(res.json().usage.nativeUsage.providerNativeUnitAmount).toBe(1);
  expect(res.json().usage.providerNativeUnits).toEqual({ type: "generation", amount: 1 });
  expect(res.json().usage.digiAiUnits).toBeNull();
  expect(res.json().usage.pricingVersion).toBe("gemini-lyria-3-clip-preview-2026-09-01");
  expect(res.json().usage.estimatedProviderCost).toBe(0.04);
  expect(res.json().usage.actualProviderCost).toBeNull();
  expect(selectPricing({ providerId: "gemini", modelId: "lyria-3.5" })?.dimensions[0]?.perUnit).toBe(0.08);
  expect(estimateProviderCost({ providerId: "gemini", modelId: "lyria-3-clip-preview", nativeUsage: { trackCount: 1 } }).actualProviderCost).toBeNull();
});

test("27 multiple outputs remain one logical request", async () => {
  const gemini = scripted("gemini", [musicOk(), musicOk(), musicOk()]);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC", constraints: { count: 3 } },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().media).toHaveLength(3);
  expect(gemini.calls).toBe(3);
  const summary = await live.store.aggregateUsage({});
  expect(summary.requestCount).toBe(1);
  expect(summary.attemptCount).toBe(3);
  expect(live.store.ledger.every((row) => row.requestId === res.json().execution.requestId)).toBe(true);
});

test("28-29 MUSIC generation and persistence are idempotent", async () => {
  const gemini = scripted("gemini", [musicOk()]);
  const drive = new MemoryDrive();
  const live = await start({ providers: { gemini }, drive });
  const first = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC", constraints: { persistCanonical: true }, idempotencyKey: "music-1" },
  });
  const replay = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC", constraints: { persistCanonical: true }, idempotencyKey: "music-1" },
  });
  expect(first.json().receiptId).toBe(replay.json().receiptId);
  expect(gemini.calls).toBe(1);
  expect(drive.writes).toBe(1);
});

test("30 HIGHLY_SENSITIVE music briefs cannot use an ineligible cloud provider", async () => {
  const gemini = scripted("gemini", [musicOk()]);
  const blocked = routeCapability({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { gemini }),
    capability: "MUSIC",
    privacyClass: "HIGHLY_SENSITIVE",
  });
  expect(blocked.decision.ok).toBe(false);
  const live = await start({ providers: { gemini } });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Private score", capability: "MUSIC", constraints: { privacyClass: "HIGHLY_SENSITIVE" } },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("unsupported_capability");
  expect(gemini.calls).toBe(0);
});

test("31-32 browser cannot force provider and safety refusal does not fail over to OpenAI", async () => {
  const gemini = scripted("gemini", [{
    ok: false,
    provider: "gemini",
    model: "lyria-3-clip-preview",
    error: "safety_refused",
    detail: "The provider refused this request under its safety policy.",
    latencyMs: 2,
  }]);
  const openai = scripted("openai", [ttsOk(), musicOk()]);
  const live = await start({ providers: { gemini, openai } });
  const forced = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-a", "tenant-a", "a-secret"),
    payload: { message: "Make music", capability: "MUSIC", provider: "openai", model: "tts-1" },
  });
  expect(forced.statusCode).toBe(400);
  const safety = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make music", capability: "MUSIC" },
  });
  expect(safety.json().error).toBe("safety_refused");
  expect(gemini.calls).toBe(1);
  expect(openai.calls).toBe(0);
});

test("33-34 no audio bytes or secrets in ledger", async () => {
  const gemini = scripted("gemini", [musicOk()]);
  const live = await start({ providers: { gemini }, config: { geminiApiKey: "AIza-not-logged" } });
  await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Create a short cinematic intro", capability: "MUSIC" },
  });
  const dumped = JSON.stringify({ ledger: live.store.ledger, receipts: live.store.receipts, usage: live.store.usage });
  expect(dumped).not.toContain(WAV_B64);
  expect(dumped).not.toContain("AIza-not-logged");
  expect(dumped).not.toContain("test-secret");
});

test("35-37 STT, TTS, and VOICE regression", async () => {
  const openai = scripted("openai", [sttOk(), ttsOk(), sttOk(), thinkOk("heard"), ttsOk()]);
  const live = await start({ providers: { openai } });
  const stt = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Transcribe.", capability: "SPEECH_TO_TEXT", audio: [{ sourceType: "inline", mimeType: "audio/wav", dataBase64: WAV_B64 }] },
  });
  expect(stt.statusCode).toBe(200);
  const tts = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Speak now.", capability: "TEXT_TO_SPEECH" },
  });
  expect(tts.statusCode).toBe(200);
  const voice = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Converse.", capability: "VOICE", audio: [{ sourceType: "inline", mimeType: "audio/wav", dataBase64: WAV_B64 }] },
  });
  expect(voice.statusCode).toBe(200);
  expect(voice.json().speech.transcript).toBe("hello");
});

test("38-41 Drive, IMAGE, text routing, and Twin regression", async () => {
  const drive = new MemoryDrive();
  const fixture = await persistMusicAcceptanceFixture({ drive, actorTrustId: "TD-A", callerId: "test", tenantId: "life-a" });
  expect(fixture.ok).toBe(true);
  expect(fixture.label).toBe(MUSIC_DRIVE_ACCEPTANCE_LABEL);

  const openai = scripted("openai", [imageOk()]);
  const live = await start({ providers: { openai, gemini: scripted("gemini", [thinkOk()]) }, drive });
  const image = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a mark.", capability: "IMAGE" },
  });
  expect(image.statusCode).toBe(200);

  const decision = decideRoute({
    capability: "WRITE",
    privacyClass: "PRIVATE",
    providers: buildRuntimeRegistry(
      testConfig({ providerPriority: ["openai", "gemini"] }),
      createProviderPool(testConfig(), {
        openai: scripted("openai", [thinkOk("a")]),
        gemini: scripted("gemini", [thinkOk("b")]),
      }),
    ).providers,
    models: listCatalogModels(),
    providerPriority: ["openai", "gemini"],
  });
  expect(decision.ok && decision.selected.providerId).toBe("openai");

  const twin = await start({ provider: new TestProvider() });
  const brief = await twin.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: headers(),
    payload: { ownerContext: { entitySlug: "life-a", displayName: "Actor A", publications: [{ id: "1", title: "Note" }] } },
  });
  expect(brief.statusCode).toBe(200);
  expect(brief.json().usage.capability).toBe("THINK");
});

test("42 health MUSIC state and no raw credentials", async () => {
  const live = await start({ providers: { gemini: scripted("gemini", [musicOk()]) } });
  const body = (await live.app.inject({ method: "GET", url: "/health" })).json();
  expect(body.capabilities.MUSIC.supported).toBe(true);
  expect(body.capabilities.MUSIC.configured).toBe(true);
  expect(body.capabilities.MUSIC.runtimeVerified).toBe(false);
  expect(body.capabilities.VIDEO.supported).toBe(false);
  expect(body.music.canonicalPersistence.status).toBe("unavailable");
  expect(JSON.stringify(body)).not.toMatch(/AIza|test-secret|sk-/);
});

test("anonymous MUSIC is denied and artist-imitation fields are rejected", async () => {
  const live = await start({ providers: { gemini: scripted("gemini", [musicOk()]) } });
  const anon = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    payload: { message: "Make music", capability: "MUSIC" },
  });
  expect(anon.statusCode).toBe(401);
  const imitate = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make music", capability: "MUSIC", soundLike: "a famous singer" },
  });
  expect(imitate.statusCode).toBe(400);
});

test("MUSIC Drive acceptance is labeled and is not real generation", async () => {
  const live = await start({ drive: new MemoryDrive() });
  const res = await live.app.inject({
    method: "POST",
    url: "/internal/media/music-acceptance",
    headers: headers(),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().label).toBe(MUSIC_DRIVE_ACCEPTANCE_LABEL);
  expect(res.json().note).toContain("MUSIC DRIVE ACCEPTANCE");
  expect(res.json().note).toContain("Not real music generation");
});
