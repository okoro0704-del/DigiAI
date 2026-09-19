import { afterEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { PERSISTENCE_STATES } from "../src/contracts/media.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { IdentityResolver } from "../src/identity/resolve.js";
import { persistDriveAcceptanceFixture, DRIVE_ACCEPTANCE_LABEL } from "../src/media/acceptance.js";
import { SovereignDriveMediaBridge } from "../src/media/bridge.js";
import { MemoryDrive, UnboundDrive } from "../src/media/drive.js";
import { DRIVE_ERRORS } from "../src/media/errors.js";
import { createDrive } from "../src/media/factory.js";
import { mediaHold } from "../src/media/hold.js";
import { mintDriveJwt, peekJwtTenant } from "../src/media/jwt.js";
import { holdKey, persistHeldGeneratedMedia } from "../src/media/normalize.js";
import { TestProvider } from "../src/providers/test.js";
import type { IntelligenceProvider, ProviderResult } from "../src/providers/types.js";
import { createProviderPool } from "../src/providers/pool.js";
import { decideRoute } from "../src/routing/policy.js";
import { buildRuntimeRegistry, routeCapability } from "../src/routing/runtime.js";
import { MemoryStore } from "../src/store/memory.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    isProd: false,
    nodeEnv: "test",
    callers: [
      { id: "test", secret: "test-secret" },
      { id: "tenant-a", secret: "a-secret" },
      { id: "tenant-b", secret: "b-secret" },
      { id: "mybrandos", secret: "studio-secret" },
    ],
    operatorCallers: ["test"],
    trustIdApi: "http://trustid.test",
    allowAttestedActor: false,
    openaiApiKey: "",
    geminiApiKey: "",
    aiProvider: "unbound",
    allowFailover: true,
    maxProviderAttempts: 2,
    maxImageInputs: 4,
    maxImageBytes: 4_000_000,
    maxImageOutputs: 4,
    maxTransientBytes: 8_000_000,
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

function scripted(name: string, results: ProviderResult[]): IntelligenceProvider & { calls: number; last?: import("../src/providers/types.js").ProviderInvokeRequest } {
  const provider: IntelligenceProvider & { calls: number; last?: import("../src/providers/types.js").ProviderInvokeRequest } = {
    name,
    configured: true,
    calls: 0,
    async invoke(request) {
      provider.last = request;
      const result = results[Math.min(provider.calls, results.length - 1)]!;
      provider.calls += 1;
      return result;
    },
  };
  return provider;
}

function imageOk(text = "Generated 1 image."): ProviderResult {
  return {
    ok: true,
    provider: "openai",
    model: "gpt-image-1",
    text,
    media: [{ mimeType: "image/png", width: 1024, height: 1024, byteSize: 64, contentBase64: TINY_PNG }],
    usage: { generatedImageCount: 1, imageCount: 1, imageWidth: 1024, imageHeight: 1024, imageBytes: 64 },
    latencyMs: 5,
  };
}

function visionOk(): ProviderResult {
  return {
    ok: true,
    provider: "openai",
    model: "gpt-4o",
    text: "A tiny test square.",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, imageCount: 1 },
    latencyMs: 4,
  };
}

async function start(opts: {
  provider?: IntelligenceProvider;
  providers?: Record<string, IntelligenceProvider>;
  config?: Partial<AppConfig>;
  drive?: MemoryDrive | UnboundDrive;
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

test("1 Drive bridge is unbound unless a Sovereign Drive URL is configured", () => {
  expect(createDrive(testConfig())).toBeInstanceOf(UnboundDrive);
  expect(createDrive(testConfig({ sovereignDriveUrl: "https://sovereign-drive.example" }))).toBeInstanceOf(SovereignDriveMediaBridge);
});

test("2 service authentication requires an actor proof before Drive writes", async () => {
  const drive = new SovereignDriveMediaBridge(testConfig({ sovereignDriveUrl: "https://sovereign-drive.example" }));
  const denied = await drive.writeGenerated({
    actorTrustId: "",
    callerId: "digi-ai",
    mimeType: "image/png",
    bytes: Buffer.from(TINY_PNG, "base64"),
  });
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error).toBe("drive_auth_failed");
});

test("3-6 authorized read, unauthorized read, cross-tenant read, not found", async () => {
  const drive = new MemoryDrive([
    { assetId: "asset-a", tenantId: "life-a", actorTrustId: "TD-A", mimeType: "image/png", bytes: Buffer.from(TINY_PNG, "base64") },
  ]);
  const openai = scripted("openai", [visionOk(), visionOk()]);
  const live = await start({ providers: { openai }, drive });
  const ok = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-a", "tenant-a", "a-secret"),
    payload: {
      message: "Describe this.",
      capability: "VISION",
      entity: { slug: "life-a" },
      images: [{ sourceType: "sovereign_drive", assetId: "asset-a" }],
    },
  });
  expect(ok.statusCode).toBe(200);

  const otherTenant = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-b", "tenant-b", "b-secret"),
    payload: {
      message: "Describe this.",
      capability: "VISION",
      entity: { slug: "life-b" },
      images: [{ sourceType: "sovereign_drive", assetId: "asset-a" }],
    },
  });
  expect(otherTenant.statusCode).toBe(403);
  expect(otherTenant.json().error).toBe("media_access_denied");

  const missing = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Describe this.",
      capability: "VISION",
      images: [{ sourceType: "sovereign_drive", assetId: "missing-asset" }],
    },
  });
  expect(missing.statusCode).toBe(404);
});

test("7-8 MIME validation and size limit on Drive assets", async () => {
  const drive = new MemoryDrive([
    { assetId: "pdf-a", tenantId: "life-a", actorTrustId: "TD-A", mimeType: "application/pdf", bytes: Buffer.from("%PDF") },
    { assetId: "huge-a", tenantId: "life-a", actorTrustId: "TD-A", mimeType: "image/png", bytes: Buffer.alloc(5_000_000) },
  ]);
  const openai = scripted("openai", [visionOk()]);
  const live = await start({ providers: { openai }, drive });
  const mime = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Describe this.",
      capability: "VISION",
      images: [{ sourceType: "sovereign_drive", assetId: "pdf-a" }],
    },
  });
  expect(mime.statusCode).toBe(400);
  expect(mime.json().error).toBe("invalid_media");
  expect(openai.calls).toBe(0);

  const huge = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Describe this.",
      capability: "VISION",
      images: [{ sourceType: "sovereign_drive", assetId: "huge-a" }],
    },
  });
  expect(huge.statusCode).toBe(400);
  expect(huge.json().error).toBe("media_too_large");
});

test("9-14 canonical write returns Drive reference with generated metadata, application, actor, lineage", async () => {
  const openai = scripted("openai", [imageOk()]);
  const drive = new MemoryDrive();
  const seeded = new MemoryDrive([
    { assetId: "asset_original", tenantId: "life-a", actorTrustId: "TD-A", mimeType: "image/png", bytes: Buffer.from(TINY_PNG, "base64") },
  ]);
  const editor = scripted("openai", [imageOk("Edited 1 image.")]);
  const edited = await start({ providers: { openai: editor }, drive: seeded });
  const ok = await edited.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers("actor-a", "mybrandos", "studio-secret"),
    payload: {
      message: "Edit this cover.",
      capability: "IMAGE",
      operation: "edit",
      constraints: { persistCanonical: true },
      images: [{ sourceType: "sovereign_drive", assetId: "asset_original" }],
      entity: { slug: "life-a" },
    },
  });
  expect(ok.statusCode).toBe(200);
  const media = ok.json().media[0];
  expect(media.persistenceState).toBe("canonical");
  expect(media.canonicalAssetReference).toMatch(/^drv_/);
  expect(media.provenance.generated).toBe(true);
  expect(media.provenance.applicationId).toBe("mybrandos");
  expect(media.provenance.actorTrustId).toBe("TD-A");
  expect(media.provenance.sourceAssetIds).toEqual(["asset_original"]);
  expect(seeded.lastWrite?.callerId).toBe("mybrandos");
  expect(seeded.lastWrite?.actorTrustId).toBe("TD-A");
  expect(seeded.lastWrite?.sourceAssetIds).toEqual(["asset_original"]);
  expect(JSON.stringify(seeded.lastWrite)).not.toContain("Edit this cover");
  expect(JSON.stringify(seeded.lastWrite)).not.toContain("studio-secret");
});

test("15-18 persistence states are explicit and honest", async () => {
  expect(PERSISTENCE_STATES).toEqual(["transient", "persisting", "canonical", "failed"]);
  const openai = scripted("openai", [imageOk(), imageOk(), imageOk()]);
  const transient = await start({ providers: { openai } });
  const t = await transient.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a mark.", capability: "IMAGE" },
  });
  expect(t.json().media[0].persistenceState).toBe("transient");

  const drive = new MemoryDrive();
  const saved = await start({ providers: { openai }, drive });
  const c = await saved.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a mark.", capability: "IMAGE", constraints: { persistCanonical: true } },
  });
  expect(c.json().media[0].persistenceState).toBe("canonical");
  expect(c.statusCode).toBe(200);

  const failed = await start({ providers: { openai }, drive: new MemoryDrive([], { writeError: "drive_write_failed" }) });
  const f = await failed.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a mark.", capability: "IMAGE", constraints: { persistCanonical: true } },
  });
  expect(f.statusCode).toBe(200);
  expect(f.json().ok).toBe(true);
  expect(f.json().media[0].persistenceState).toBe("failed");
  expect(f.json().media[0].canonicalAssetReference).toBeUndefined();
});

test("19-22 write timeout, auth failure, quota, and integrity stay persistence failures", async () => {
  for (const error of ["drive_timeout", "drive_auth_failed", "drive_quota", "drive_integrity_failed"] as const) {
    const openai = scripted("openai", [imageOk()]);
    const drive = new MemoryDrive([], error === "drive_integrity_failed" ? { integrityFail: true } : { writeError: error });
    const live = await start({ providers: { openai }, drive });
    const res = await live.app.inject({
      method: "POST",
      url: "/v1/ask",
      headers: headers(),
      payload: { message: "Make a mark.", capability: "IMAGE", constraints: { persistCanonical: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().media[0].persistenceState).toBe("failed");
    expect(DRIVE_ERRORS).toContain(error);
  }
});

test("23-25 idempotent persistence retries without regeneration or duplicate assets", async () => {
  const openai = scripted("openai", [imageOk()]);
  const drive = new MemoryDrive([], { failNextWrites: 1 });
  const live = await start({ providers: { openai }, drive });
  const payload = { message: "Make a mark.", capability: "IMAGE", constraints: { persistCanonical: true }, idempotencyKey: "persist-1" };
  const first = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload });
  expect(first.json().media[0].persistenceState).toBe("failed");
  expect(openai.calls).toBe(1);
  expect(drive.writes).toBe(0);

  const second = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload });
  expect(second.statusCode).toBe(200);
  expect(second.json().receiptId).toBe(first.json().receiptId);
  expect(second.json().media[0].persistenceState).toBe("canonical");
  expect(second.json().media[0].canonicalAssetReference).toMatch(/^drv_/);
  expect(openai.calls).toBe(1);
  expect(drive.writes).toBe(1);

  const third = await live.app.inject({ method: "POST", url: "/v1/ask", headers: headers(), payload });
  expect(third.json().media[0].canonicalAssetReference).toBe(second.json().media[0].canonicalAssetReference);
  expect(drive.writes).toBe(1);
  expect(openai.calls).toBe(1);
});

test("26-28 receipt links canonical asset; ledger has no bytes; Drive metadata has no prompt or secrets", async () => {
  const openai = scripted("openai", [imageOk()]);
  const drive = new MemoryDrive();
  const live = await start({
    providers: { openai },
    drive,
    config: { openaiApiKey: "sk-present-not-logged" },
  });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "secret prompt body", capability: "IMAGE", constraints: { persistCanonical: true } },
  });
  const assetId = res.json().media[0].canonicalAssetReference;
  expect(live.store.receipts[0]?.resultSnapshot?.canonicalAssetReference).toBe(assetId);
  const dumped = JSON.stringify({ ledger: live.store.ledger, receipts: live.store.receipts, write: drive.lastWrite });
  expect(dumped).not.toContain(TINY_PNG);
  expect(dumped).not.toContain("sk-present-not-logged");
  expect(dumped).not.toContain("test-secret");
  expect(JSON.stringify(drive.lastWrite?.bytes && { skip: true })).not.toContain("secret prompt body");
  expect(JSON.stringify(drive.lastWrite)).not.toContain("secret prompt body");
});

test("29-31 HIGHLY_SENSITIVE provider policy is not bypassed by Drive access", async () => {
  const drive = new MemoryDrive([
    { assetId: "asset-a", tenantId: "life-a", actorTrustId: "TD-A", mimeType: "image/png", bytes: Buffer.from(TINY_PNG, "base64") },
  ]);
  const authorized = await drive.authorizeRead({
    actorTrustId: "TD-A",
    callerId: "test",
    tenantId: "life-a",
    assetId: "asset-a",
  });
  expect(authorized.ok).toBe(true);

  const openai = scripted("openai", [visionOk()]);
  const live = await start({ providers: { openai }, drive });
  const res = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Describe this.",
      capability: "VISION",
      constraints: { privacyClass: "HIGHLY_SENSITIVE" },
      images: [{ sourceType: "sovereign_drive", assetId: "asset-a" }],
    },
  });
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
  expect(openai.calls).toBe(0);
  expect(drive.reads).toBe(0);
  const routed = routeCapability({
    config: testConfig(),
    pool: createProviderPool(testConfig(), { openai }),
    capability: "VISION",
    privacyClass: "HIGHLY_SENSITIVE",
  });
  expect(routed.decision.ok).toBe(false);
});

test("32-37 existing IMAGE, VISION, text, Gemini, ledger, and Twin regressions remain green", async () => {
  const openai = scripted("openai", [imageOk(), visionOk()]);
  const live = await start({ providers: { openai } });
  const image = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a mark.", capability: "IMAGE" },
  });
  expect(image.json().media[0].persistenceState).toBe("transient");
  const vision = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Describe.",
      capability: "VISION",
      images: [{ sourceType: "inline", mimeType: "image/png", dataBase64: TINY_PNG }],
    },
  });
  expect(vision.statusCode).toBe(200);

  const text = await start({ provider: new TestProvider() });
  const write = await text.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Write a one paragraph introduction.", mode: "draft" },
  });
  expect(write.json().usage.capability).toBe("WRITE");

  const twin = await text.app.inject({
    method: "POST",
    url: "/v1/twin/brief",
    headers: headers(),
    payload: { ownerContext: { entitySlug: "life-a", displayName: "Actor A", publications: [{ id: "1", title: "Note" }] } },
  });
  expect(twin.json().usage.capability).toBe("THINK");

  const decision = decideRoute({
    capability: "WRITE",
    privacyClass: "PRIVATE",
    providers: buildRuntimeRegistry(
      testConfig({ providerPriority: ["openai", "gemini"] }),
      createProviderPool(testConfig(), {
        openai: scripted("openai", [{ ok: true, provider: "openai", model: "gpt-4o-mini", text: "a", usage: {}, latencyMs: 1 }]),
        gemini: scripted("gemini", [{ ok: true, provider: "gemini", model: "gemini-2.0-flash", text: "b", usage: {}, latencyMs: 1 }]),
      }),
    ).providers,
    models: buildRuntimeRegistry(testConfig(), createProviderPool(testConfig(), { openai: scripted("openai", []) })).models,
    providerPriority: ["openai", "gemini"],
  });
  expect(decision.ok && decision.selected.providerId).toBe("openai");
  expect(live.store.ledger[0]?.digiAiUnits).toBeNull();
});

test("38 health reports media bridge state without credentials", async () => {
  const unbound = await start({ providers: { openai: scripted("openai", [imageOk()]) } });
  const empty = (await unbound.app.inject({ method: "GET", url: "/health" })).json();
  expect(empty.media.canonicalRead.configured).toBe(false);
  expect(empty.media.canonicalWrite.configured).toBe(false);
  expect(empty.media.persistence.status).toBe("unavailable");
  expect(empty.media.canonicalPersistence.status).toBe("unavailable");

  const bound = await start({
    providers: { openai: scripted("openai", [imageOk()]) },
    drive: new MemoryDrive(),
  });
  const ready = (await bound.app.inject({ method: "GET", url: "/health" })).json();
  expect(ready.media.canonicalRead.configured).toBe(true);
  expect(ready.media.canonicalWrite.configured).toBe(true);
  expect(ready.media.canonicalRead.runtimeVerified).toBe(true);
  expect(ready.media.canonicalWrite.runtimeVerified).toBe(true);
  expect(ready.media.persistence.status).toBe("available");
  expect(JSON.stringify(ready)).not.toMatch(/sk-|test-secret|jwt|data:image/);
});

test("HTTP Drive bridge maps auth, not-found, and write responses", async () => {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push(`${init?.method || "GET"} ${String(url)}`);
    const path = String(url);
    if (path.endsWith("/v1/storage/asset/missing")) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (path.includes("/v1/storage/asset/asset-a/content")) {
      return new Response(Buffer.from(TINY_PNG, "base64"), {
        status: 200,
        headers: { "content-type": "image/png", "x-content-hash": "abc" },
      });
    }
    if (path.includes("/v1/storage/asset/asset-a")) {
      return new Response(JSON.stringify({ assetId: "asset-a", url: "https://drive.example/signed" }), { status: 200 });
    }
    if (path.endsWith("/v1/storage/upload")) {
      return new Response(JSON.stringify({ assetId: "drv-live", tenantId: "life-a", hash: undefined, sizeBytes: 67 }), { status: 201 });
    }
    return new Response(JSON.stringify({ error: "no" }), { status: 401 });
  };
  const drive = new SovereignDriveMediaBridge(
    testConfig({ sovereignDriveUrl: "https://sovereign-drive.example", sovereignDriveJwtSecret: "test-jwt" }),
    { fetchFn },
  );
  const token = mintDriveJwt({
    secret: "test-jwt",
    issuer: "https://trust-id.local",
    audience: "sovereign-drive",
    userId: "TD-A",
    tenantId: "life-a",
  });
  expect(peekJwtTenant(token)).toBe("life-a");
  const read = await drive.readAsset({
    actorTrustId: "TD-A",
    callerId: "digi-ai",
    tenantId: "life-a",
    accessToken: token,
    assetId: "asset-a",
  });
  expect(read.ok).toBe(true);
  const missing = await drive.authorizeRead({
    actorTrustId: "TD-A",
    callerId: "digi-ai",
    tenantId: "life-a",
    accessToken: token,
    assetId: "missing",
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error).toBe("drive_asset_not_found");
  const written = await drive.writeGenerated({
    actorTrustId: "TD-A",
    callerId: "mybrandos",
    tenantId: "life-a",
    accessToken: token,
    mimeType: "image/png",
    bytes: Buffer.from(TINY_PNG, "base64"),
    generated: true,
  });
  expect(written.ok).toBe(true);
  if (written.ok) expect(written.reference.assetId).toBe("drv-live");
  expect(calls.some((row) => row.includes("/content"))).toBe(true);
});

test("Drive bridge acceptance fixture is labeled and is not AI generation", async () => {
  const drive = new MemoryDrive();
  const result = await persistDriveAcceptanceFixture({
    drive,
    actorTrustId: "TD-A",
    callerId: "test",
    tenantId: "life-a",
  });
  expect(result.ok).toBe(true);
  expect(result.label).toBe(DRIVE_ACCEPTANCE_LABEL);
  if (result.ok) {
    expect(result.canonicalAssetReference).toMatch(/^drv_/);
    expect(result.note).toContain("Not real AI image generation");
  }
  const live = await start({ drive });
  const res = await live.app.inject({
    method: "POST",
    url: "/internal/media/drive-acceptance",
    headers: headers(),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().label).toBe(DRIVE_ACCEPTANCE_LABEL);
  expect(res.json().note).toContain("Not real AI image generation");
});

test("possessing an assetId is not authorization and UnboundDrive cannot mint canonical assets", async () => {
  const vision = scripted("openai", [visionOk()]);
  const live = await start({ providers: { openai: vision } });
  const stolen = await live.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: {
      message: "Describe.",
      capability: "VISION",
      images: [{ sourceType: "sovereign_drive", assetId: "somebody-elses-asset" }],
    },
  });
  expect(stolen.statusCode).toBe(403);
  const images = scripted("openai", [imageOk()]);
  const persistApp = await start({ providers: { openai: images } });
  const persist = await persistApp.app.inject({
    method: "POST",
    url: "/v1/ask",
    headers: headers(),
    payload: { message: "Make a mark.", capability: "IMAGE", constraints: { persistCanonical: true } },
  });
  expect(persist.json().ok).toBe(true);
  expect(persist.json().media[0].persistenceState).toBe("failed");
  expect(persist.json().media[0].canonicalAssetReference).toBeUndefined();
});

test("held media retry does not invent a second asset id", async () => {
  const drive = new MemoryDrive();
  mediaHold.put(holdKey("test", "held-1"), {
    mimeType: "image/png",
    bytes: Buffer.from(TINY_PNG, "base64"),
  });
  const first = await persistHeldGeneratedMedia({
    drive,
    callerId: "test",
    idempotencyKey: "held-1",
    actorTrustId: "TD-A",
    tenantId: "life-a",
  });
  const second = await persistHeldGeneratedMedia({
    drive,
    callerId: "test",
    idempotencyKey: "held-1",
    actorTrustId: "TD-A",
    tenantId: "life-a",
  });
  expect(first.canonicalAssetReference).toBe(second.canonicalAssetReference);
  expect(drive.writes).toBe(1);
});
