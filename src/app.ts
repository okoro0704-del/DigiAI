import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { isCapabilityId } from "./contracts/capabilities.js";
import { isPrivacyClass } from "./contracts/privacy.js";
import { CONTEXT_SOURCES, isContextSourceId, isDigiAiMode, type AskConstraints, type DigiAiAskInput } from "./contracts/request.js";
import { isAudioOutputFormat, isAudioSourceType, isImageOperation, isImageSourceType, isMusicOperation, isSizeClass, isSpeechOperation, isVideoOperation, type AudioInputReference, type ImageInputReference } from "./contracts/media.js";
import { isMusicOutputFormat, isVocalMode } from "./contracts/music.js";
import { isVideoAudioMode, isVideoQuality, isVideoResolution } from "./contracts/video.js";
import { isSpeechTask } from "./contracts/speech.js";
import { persistAudioAcceptanceFixture, persistDriveAcceptanceFixture, persistMusicAcceptanceFixture, persistVideoAcceptanceFixture } from "./media/acceptance.js";
import { authenticateCaller } from "./identity/resolve.js";
import { createDrive } from "./media/factory.js";
import type { SovereignDrive } from "./media/drive.js";
import type { HealthResponse } from "./contracts/response.js";
import { buildHealthResponse } from "./routing/health.js";
import type { TwinBriefInput, TwinOwnerActivity } from "./contracts/twin.js";
import { HttpDigiNewsReader } from "./adapters/diginews.js";
import { HttpDigiPediaReader } from "./adapters/digipedia.js";
import type { DigiNewsReader, DigiPediaReader } from "./adapters/types.js";
import { createTrustIdResolver, resolveRequestIdentity, type IdentityResolver } from "./identity/resolve.js";
import { handleAsk } from "./intelligence/engine.js";
import { handleTwinBrief } from "./intelligence/twin-brief.js";
import { newId } from "./lib/crypto.js";
import { DigiAiError } from "./lib/http.js";
import { createProviders } from "./providers/router.js";
import type { IntelligenceProvider } from "./providers/types.js";
import { createStore } from "./store/index.js";
import type { DigiAiStore } from "./store/types.js";
import type { LedgerQuery } from "./contracts/ledger.js";
import { runEconomicAcceptance } from "./credits/acceptance.js";
import { assertOperatorEconomics, readOwnCreditLedger, readOwnCreditSummary } from "./credits/query.js";
import { reconcileCredits } from "./credits/reconcile.js";
import { runAuthorityAcceptance } from "./authority/acceptance.js";
import {
  consumeAuthorization,
  createGrant,
  decideAction,
  inspectAction,
  inspectGrant,
  parseActionBody,
  parseDecisionBody,
  parseGrantBody,
  proposeAction,
  revokeGrant,
} from "./authority/service.js";
import { runOrchestrationAcceptance } from "./orchestration/acceptance.js";
import { advanceObjective, cancelObjective, createObjective, inspectObjective, parseObjectiveBody } from "./orchestration/engine.js";
import {
  advanceExecution,
  cancelExecution,
  executeAuthorizedAction,
  inspectExecution,
  parseExecuteBody,
  reconcileExecution,
} from "./execution/service.js";
import { isOperatorCaller, readUsageReceipt, readUsageSummary, scopedLedgerQuery } from "./usage/query.js";
import { renderDigiAiPage } from "./ui/page.js";

export type DigiAiAppOptions = {
  provider?: IntelligenceProvider;
  providers?: Record<string, IntelligenceProvider>;
  resolver?: IdentityResolver;
  digipedia?: DigiPediaReader;
  diginews?: DigiNewsReader;
  store?: DigiAiStore;
  drive?: SovereignDrive;
};

const FORBIDDEN_ECONOMIC_FIELDS = [
  "estimatedProviderCost",
  "actualProviderCost",
  "digiAiUnits",
  "pricingVersion",
  "applicationId",
  "callerId",
  "reservedUnits",
  "consumedUnits",
  "releasedUnits",
  "meteringRate",
  "meteringPolicyVersion",
  "grant",
  "adjustment",
  "creditCost",
  "balance",
  "postedUnits",
  "availableUnits",
] as const;

function rejectClientRouteOverride(body: Record<string, unknown>) {
  if (
    "provider" in body ||
    "model" in body ||
    "providerId" in body ||
    "modelId" in body ||
    "failoverTo" in body ||
    "forceProvider" in body ||
    "preferredProvider" in body ||
    "voice" in body ||
    "voiceId" in body ||
    "providerVoiceId" in body ||
    "openaiVoice" in body ||
    "cloneVoice" in body ||
    "voiceClone" in body ||
    "voiceprint" in body ||
    "voiceMatch" in body ||
    "biometricVoice" in body ||
    "cloneFromAudio" in body ||
    "artist" in body ||
    "artistName" in body ||
    "soundLike" in body ||
    "imitateArtist" in body
  ) {
    throw new DigiAiError(400, "invalid_request", "Provider and model selection is reserved to Digi AI.");
  }
  for (const field of FORBIDDEN_ECONOMIC_FIELDS) {
    if (field in body) {
      throw new DigiAiError(400, "invalid_request", "Cost and commercial fields are reserved to Digi AI.");
    }
  }
}

function parseAskBody(raw: unknown, maxMessage: number, maxSupplied: number): DigiAiAskInput {
  if (!raw || typeof raw !== "object") throw new DigiAiError(400, "invalid_request", "JSON body is required.");
  const body = raw as Record<string, unknown>;
  rejectClientRouteOverride(body);
  if (typeof body.message !== "string") throw new DigiAiError(400, "invalid_request", "A request message is required.");
  if (body.message.length > maxMessage) throw new DigiAiError(400, "invalid_request", "Request is too large.");
  if (body.capability !== undefined && !isCapabilityId(body.capability)) {
    throw new DigiAiError(400, "invalid_request", "Unknown capability.");
  }
  const sources = Array.isArray(body.sources)
    ? body.sources.filter(isContextSourceId)
    : undefined;
  if (Array.isArray(body.sources) && body.sources.some((value) => !CONTEXT_SOURCES.includes(value as never) && typeof value === "string")) {
    const unknown = body.sources.find((value) => typeof value === "string" && !isContextSourceId(value));
    if (unknown) throw new DigiAiError(400, "invalid_request", "Unknown context source.");
  }
  const entity = body.entity && typeof body.entity === "object" ? (body.entity as DigiAiAskInput["entity"]) : undefined;
  const supplied = body.suppliedContext && typeof body.suppliedContext === "object"
    ? (body.suppliedContext as DigiAiAskInput["suppliedContext"])
    : undefined;
  if (supplied?.text && supplied.text.length > maxSupplied) {
    throw new DigiAiError(400, "invalid_request", "Supplied context is too large.");
  }
  const actor = body.actor && typeof body.actor === "object" ? (body.actor as DigiAiAskInput["actor"]) : undefined;
  const draft = body.draft && typeof body.draft === "object" ? (body.draft as DigiAiAskInput["draft"]) : undefined;
  const constraints = parseConstraints(body.constraints);
  if (body.operation !== undefined && !isImageOperation(body.operation) && !isSpeechOperation(body.operation) && !isMusicOperation(body.operation) && !isVideoOperation(body.operation)) {
    throw new DigiAiError(400, "invalid_request", "Unknown media operation.");
  }
  if (body.sourceVideo !== undefined || (body as Record<string, unknown>).videoToVideo !== undefined) {
    throw new DigiAiError(400, "invalid_request", "Source-video editing is not supported.");
  }
  return {
    message: body.message,
    mode: isDigiAiMode(body.mode) ? body.mode : undefined,
    capability: isCapabilityId(body.capability) ? body.capability : undefined,
    constraints,
    sources,
    entity,
    suppliedContext: supplied,
    draft,
    correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    operation: isImageOperation(body.operation) || isSpeechOperation(body.operation) || isMusicOperation(body.operation) || isVideoOperation(body.operation) ? body.operation : undefined,
    images: parseImages(body.images ?? body.media),
    audio: parseAudio(body.audio),
    actor,
  };
}

function parseConstraints(raw: unknown): AskConstraints | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  if (body.privacyClass !== undefined && !isPrivacyClass(body.privacyClass)) {
    throw new DigiAiError(400, "invalid_request", "Unknown privacy class.");
  }
  if (body.failoverTo !== undefined || body.preferredProvider !== undefined) {
    throw new DigiAiError(400, "invalid_request", "Provider selection is reserved to Digi AI.");
  }
  if (
    body.voice !== undefined ||
    body.voiceId !== undefined ||
    body.providerVoiceId !== undefined ||
    body.cloneVoice !== undefined ||
    body.voiceprint !== undefined ||
    body.voiceMatch !== undefined ||
    body.biometricVoice !== undefined ||
    body.artist !== undefined ||
    body.artistName !== undefined ||
    body.soundLike !== undefined ||
    body.imitateArtist !== undefined
  ) {
    throw new DigiAiError(400, "invalid_request", "Provider voice identifiers and artist-imitation fields are reserved or unsupported.");
  }
  return {
    structuredOutput: body.structuredOutput === true,
    privacyClass: isPrivacyClass(body.privacyClass) ? body.privacyClass : undefined,
    maxLatency: typeof body.maxLatency === "string" ? body.maxLatency : undefined,
    allowFailover: typeof body.allowFailover === "boolean" ? body.allowFailover : undefined,
    forceProvider: typeof body.forceProvider === "string" ? body.forceProvider.toLowerCase() : undefined,
    aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
    sizeClass: isSizeClass(body.sizeClass) ? body.sizeClass : undefined,
    transparentBackground: body.transparentBackground === true,
    outputFormat: body.outputFormat === "png" || body.outputFormat === "jpeg" || body.outputFormat === "webp" ? body.outputFormat : undefined,
    count: typeof body.count === "number" ? body.count : undefined,
    persistCanonical: body.persistCanonical === true,
    voiceProfileId: typeof body.voiceProfileId === "string" ? body.voiceProfileId : undefined,
    language: typeof body.language === "string" ? body.language : undefined,
    speechTask: isSpeechTask(body.speechTask) ? body.speechTask : undefined,
    timestamps: body.timestamps === true,
    speakingRate: typeof body.speakingRate === "number" ? body.speakingRate : undefined,
    audioOutputFormat: isAudioOutputFormat(body.audioOutputFormat) ? body.audioOutputFormat : undefined,
    durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : undefined,
    vocalMode: isVocalMode(body.vocalMode) ? body.vocalMode : undefined,
    mood: typeof body.mood === "string" ? body.mood : undefined,
    tempoBpm: typeof body.tempoBpm === "number" ? body.tempoBpm : undefined,
    genre: typeof body.genre === "string" ? body.genre : undefined,
    structure: typeof body.structure === "string" ? body.structure : undefined,
    lyrics: typeof body.lyrics === "string" ? body.lyrics : undefined,
    musicOutputFormat: isMusicOutputFormat(body.musicOutputFormat) ? body.musicOutputFormat : undefined,
    resolution: isVideoResolution(body.resolution) ? body.resolution : undefined,
    videoQuality: isVideoQuality(body.videoQuality) ? body.videoQuality : undefined,
    audioMode: isVideoAudioMode(body.audioMode) ? body.audioMode : undefined,
  };
}

function parseImages(raw: unknown): ImageInputReference[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new DigiAiError(400, "invalid_media", "images must be an array.");
  return raw.map((row) => {
    if (!row || typeof row !== "object") throw new DigiAiError(400, "invalid_media", "Each image must be an object.");
    const image = row as Record<string, unknown>;
    if (!isImageSourceType(image.sourceType)) {
      throw new DigiAiError(400, "invalid_media", "Unknown image source type.");
    }
    return {
      sourceType: image.sourceType,
      assetId: typeof image.assetId === "string" ? image.assetId : undefined,
      reference: typeof image.reference === "string" ? image.reference : undefined,
      mediaType: "image",
      mimeType: typeof image.mimeType === "string" ? image.mimeType : undefined,
      width: typeof image.width === "number" ? image.width : undefined,
      height: typeof image.height === "number" ? image.height : undefined,
      byteSize: typeof image.byteSize === "number" ? image.byteSize : undefined,
      provenance: typeof image.provenance === "string" ? image.provenance : undefined,
      accessPolicy: typeof image.accessPolicy === "string" ? image.accessPolicy : undefined,
      filename: typeof image.filename === "string" ? image.filename : undefined,
      dataBase64: typeof image.dataBase64 === "string" ? image.dataBase64 : undefined,
    };
  });
}

function parseAudio(raw: unknown): AudioInputReference[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new DigiAiError(400, "invalid_audio", "audio must be an array.");
  return raw.map((row) => {
    if (!row || typeof row !== "object") throw new DigiAiError(400, "invalid_audio", "Each audio item must be an object.");
    const item = row as Record<string, unknown>;
    if (!isAudioSourceType(item.sourceType)) {
      throw new DigiAiError(400, "invalid_audio", "Unknown audio source type.");
    }
    return {
      sourceType: item.sourceType,
      assetId: typeof item.assetId === "string" ? item.assetId : undefined,
      reference: typeof item.reference === "string" ? item.reference : undefined,
      mediaType: "audio",
      mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      durationSeconds: typeof item.durationSeconds === "number" ? item.durationSeconds : undefined,
      byteSize: typeof item.byteSize === "number" ? item.byteSize : undefined,
      provenance: typeof item.provenance === "string" ? item.provenance : undefined,
      accessPolicy: typeof item.accessPolicy === "string" ? item.accessPolicy : undefined,
      filename: typeof item.filename === "string" ? item.filename : undefined,
      dataBase64: typeof item.dataBase64 === "string" ? item.dataBase64 : undefined,
    };
  });
}

function parseTwinBriefBody(raw: unknown): TwinBriefInput {
  if (!raw || typeof raw !== "object") throw new DigiAiError(400, "invalid_request", "JSON body is required.");
  const body = raw as Record<string, unknown>;
  rejectClientRouteOverride(body);
  const entity = body.entity && typeof body.entity === "object" ? (body.entity as TwinBriefInput["entity"]) : undefined;
  const ownerContext =
    body.ownerContext && typeof body.ownerContext === "object"
      ? (body.ownerContext as TwinOwnerActivity)
      : undefined;
  const actor = body.actor && typeof body.actor === "object" ? (body.actor as TwinBriefInput["actor"]) : undefined;
  return {
    entity,
    ownerContext,
    correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
    actor,
  };
}

export function buildApp(config: AppConfig, options: DigiAiAppOptions = {}) {
  const app = Fastify({ logger: false });
  const pool = createProviders(config, options.providers ?? options.provider);
  const provider = options.provider ?? pool.primary();
  const store = options.store ?? createStore(config);
  const deps = {
    config,
    provider,
    pool,
    digipedia: options.digipedia ?? new HttpDigiPediaReader(config),
    diginews: options.diginews ?? new HttpDigiNewsReader(config),
    store,
    drive: options.drive ?? createDrive(config),
  };
  const resolver = options.resolver ?? createTrustIdResolver(config);

  app.get("/health", async (): Promise<HealthResponse> => buildHealthResponse(config, pool, store, deps.drive));

  const sendError = (reply: FastifyReply, err: unknown, extra: Record<string, unknown> = {}) => {
    if (err instanceof DigiAiError) {
      return reply.code(err.status).send({ ok: false, service: "digi-ai", error: err.code, message: err.message, ...extra });
    }
    return reply.code(500).send({ ok: false, service: "digi-ai", error: "internal_error", message: "Digi AI could not complete that request.", ...extra });
  };

  const handleUsageSummary = async (req: FastifyRequest, reply: FastifyReply, operatorOnly: boolean) => {
    try {
      const identity = await resolveRequestIdentity({
        config,
        headers: req.headers,
        url: req.url,
        resolver,
      });
      const operator = isOperatorCaller(config, identity.caller);
      if (operatorOnly && !operator) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for that usage query.");
      }
      const requested = parseUsageQuery(req.query);
      const query = scopedLedgerQuery({
        caller: identity.caller,
        actor: identity.actor,
        requested,
        operator,
      });
      const summary = await readUsageSummary(store, query);
      return reply.send({
        ok: true,
        service: "digi-ai",
        scope: operator ? "operator" : "tenant",
        query,
        summary,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  };

  app.get("/internal/usage/summary", async (req, reply) => handleUsageSummary(req, reply, true));
  app.get("/v1/usage/summary", async (req, reply) => handleUsageSummary(req, reply, false));

  app.get("/v1/credits/summary", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const query = (req.query ?? {}) as Record<string, unknown>;
      const summary = await readOwnCreditSummary({
        store,
        config,
        actor: identity.actor,
        caller: identity.caller,
        entitySlug: typeof query.entitySlug === "string" ? query.entitySlug : undefined,
      });
      return reply.send({ ok: true, service: "digi-ai", summary });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/credits/ledger", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const query = (req.query ?? {}) as Record<string, unknown>;
      const page = await readOwnCreditLedger({
        store,
        actor: identity.actor,
        caller: identity.caller,
        entitySlug: typeof query.entitySlug === "string" ? query.entitySlug : undefined,
        operator: isOperatorCaller(config, identity.caller),
        query: {
          accountId: typeof query.accountId === "string" ? query.accountId : "",
          after: typeof query.after === "string" ? query.after : undefined,
          limit: typeof query.limit === "string" ? Number(query.limit) : undefined,
        },
      });
      return reply.send({ ok: true, service: "digi-ai", ...page });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/credits/grant", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      assertOperatorEconomics(config, identity.caller);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.ownerType !== "string" || typeof body.ownerId !== "string" || typeof body.idempotencyKey !== "string") {
        throw new DigiAiError(400, "invalid_request", "ownerType, ownerId, and idempotencyKey are required.");
      }
      const result = await store.grantCredits({
        ownerType: body.ownerType === "tenant" ? "tenant" : "actor",
        ownerId: String(body.ownerId),
        tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
        units: Number(body.units),
        idempotencyKey: String(body.idempotencyKey),
        applicationId: identity.caller.id,
        actorId: identity.actor.trustId,
        authorizedBy: identity.caller.id,
        reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : "operator_grant",
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/credits/adjustment", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      assertOperatorEconomics(config, identity.caller);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.idempotencyKey !== "string") {
        throw new DigiAiError(400, "invalid_request", "idempotencyKey is required.");
      }
      const result = await store.adjustCredits({
        accountId: typeof body.accountId === "string" ? body.accountId : undefined,
        ownerType: body.ownerType === "tenant" ? "tenant" : body.ownerType === "actor" ? "actor" : undefined,
        ownerId: typeof body.ownerId === "string" ? body.ownerId : undefined,
        tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
        units: Number(body.units),
        idempotencyKey: String(body.idempotencyKey),
        applicationId: identity.caller.id,
        actorId: identity.actor.trustId,
        authorizedBy: identity.caller.id,
        reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : "operator_adjustment",
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/internal/credits/reconcile", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      assertOperatorEconomics(config, identity.caller);
      return reply.send({ ok: true, service: "digi-ai", report: await reconcileCredits(store) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/credits/acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = authenticateCaller(config, req.headers);
      if (!caller) throw new DigiAiError(401, "unauthenticated_caller", "Caller identity is required.");
      if (config.isProd && !isOperatorCaller(config, caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for economic acceptance.");
      }
      const result = await runEconomicAcceptance(store, caller.id);
      return reply.send({ service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/objectives", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const body = parseObjectiveBody(req.body, config);
      const operator = isOperatorCaller(config, identity.caller);
      const result = await createObjective({
        deps,
        actor: identity.actor,
        caller: identity.caller,
        body,
        accessToken: readAccessToken(req.headers),
        allowFixture: !config.isProd || operator,
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/objectives/:objectiveId", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const objectiveId = String((req.params as { objectiveId?: string }).objectiveId || "");
      const result = await inspectObjective({
        store,
        actor: identity.actor,
        caller: identity.caller,
        objectiveId,
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/objectives/:objectiveId/cancel", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const objectiveId = String((req.params as { objectiveId?: string }).objectiveId || "");
      const result = await cancelObjective({
        store,
        actor: identity.actor,
        caller: identity.caller,
        objectiveId,
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/objectives/:objectiveId/advance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const objectiveId = String((req.params as { objectiveId?: string }).objectiveId || "");
      const operator = isOperatorCaller(config, identity.caller);
      const result = await advanceObjective({
        deps,
        actor: identity.actor,
        caller: identity.caller,
        objectiveId,
        accessToken: readAccessToken(req.headers),
        allowFixture: !config.isProd || operator,
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/objectives/:objectiveId/actions", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const objectiveId = String((req.params as { objectiveId?: string }).objectiveId || "");
      const body = parseActionBody(req.body);
      const result = await proposeAction({
        store,
        actor: identity.actor,
        caller: identity.caller,
        body: { ...body, objectiveId },
      });
      return reply.send({ ok: true, service: "digi-ai", executed: false, ...result, intent: result.intent });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/actions/:actionIntentId", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const result = await inspectAction({
        store,
        actor: identity.actor,
        caller: identity.caller,
        actionIntentId: String((req.params as { actionIntentId?: string }).actionIntentId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", executed: false, ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/actions/:actionIntentId/decision", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const body = parseDecisionBody(req.body);
      const result = await decideAction({
        store,
        actor: identity.actor,
        caller: identity.caller,
        actionIntentId: String((req.params as { actionIntentId?: string }).actionIntentId || ""),
        ...body,
      });
      return reply.send({ ok: true, service: "digi-ai", executed: false, ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/authority/grants", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const body = parseGrantBody(req.body);
      const grant = await createGrant({ store, actor: identity.actor, caller: identity.caller, ...body });
      return reply.send({ ok: true, service: "digi-ai", grant });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/authority/grants/:grantId", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const grant = await inspectGrant({
        store,
        actor: identity.actor,
        caller: identity.caller,
        grantId: String((req.params as { grantId?: string }).grantId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", grant });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/authority/grants/:grantId/revoke", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const grant = await revokeGrant({
        store,
        actor: identity.actor,
        caller: identity.caller,
        grantId: String((req.params as { grantId?: string }).grantId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", grant });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/actions/:actionIntentId/execute", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const operator = isOperatorCaller(config, identity.caller);
      const allowFixture = !config.isProd || operator;
      const body = parseExecuteBody(req.body, allowFixture);
      const result = await executeAuthorizedAction({
        store,
        actor: identity.actor,
        caller: identity.caller,
        actionIntentId: String((req.params as { actionIntentId?: string }).actionIntentId || ""),
        allowFixture,
        ...body,
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/v1/action-executions/:executionId", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const result = await inspectExecution({
        store,
        actor: identity.actor,
        caller: identity.caller,
        executionId: String((req.params as { executionId?: string }).executionId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/action-executions/:executionId/advance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const result = await advanceExecution({
        store,
        actor: identity.actor,
        caller: identity.caller,
        executionId: String((req.params as { executionId?: string }).executionId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/v1/action-executions/:executionId/cancel", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const result = await cancelExecution({
        store,
        actor: identity.actor,
        caller: identity.caller,
        executionId: String((req.params as { executionId?: string }).executionId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/action-executions/:executionId/reconcile", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      if (config.isProd && !isOperatorCaller(config, identity.caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required to reconcile action executions.");
      }
      const result = await reconcileExecution({
        store,
        actor: identity.actor,
        caller: identity.caller,
        executionId: String((req.params as { executionId?: string }).executionId || ""),
      });
      return reply.send({ ok: true, service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/authority/consume", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      const body = (req.body ?? {}) as { authorizationId?: string };
      if (!body.authorizationId) throw new DigiAiError(400, "invalid_request", "authorizationId is required.");
      const authorization = await consumeAuthorization({
        store,
        actor: identity.actor,
        caller: identity.caller,
        authorizationId: body.authorizationId,
      });
      return reply.send({ ok: true, service: "digi-ai", executed: false, authorization });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/authority/acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      if (config.isProd && !isOperatorCaller(config, identity.caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for authority acceptance.");
      }
      const result = await runAuthorityAcceptance({ store, actor: identity.actor, caller: identity.caller });
      return reply.send({ service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/objectives/acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({ config, headers: req.headers, url: req.url, resolver });
      if (config.isProd && !isOperatorCaller(config, identity.caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for orchestration acceptance.");
      }
      const result = await runOrchestrationAcceptance({
        deps,
        actor: identity.actor,
        caller: identity.caller,
      });
      return reply.send({ service: "digi-ai", ...result });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/internal/usage/receipts/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const identity = await resolveRequestIdentity({
        config,
        headers: req.headers,
        url: req.url,
        resolver,
      });
      const operator = isOperatorCaller(config, identity.caller);
      const id = String((req.params as { id?: string }).id || "");
      const row = await readUsageReceipt(store, id, {
        operator,
        callerId: identity.caller.id,
        actorId: identity.actor.trustId,
      });
      if (!row) {
        return reply.code(404).send({ ok: false, service: "digi-ai", error: "not_found", message: "Usage receipt not found." });
      }
      return reply.send({ ok: true, service: "digi-ai", receipt: sanitizeLedger(row) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    reply.type("text/html; charset=utf-8");
    return renderDigiAiPage();
  });

  app.post("/v1/ask", async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = newId("req");
    try {
      const body = parseAskBody(req.body, config.maxMessageChars, config.maxSuppliedChars);
      if (!body.idempotencyKey && typeof req.headers["idempotency-key"] === "string") {
        body.idempotencyKey = req.headers["idempotency-key"];
      }
      const identity = await resolveRequestIdentity({
        config,
        headers: req.headers,
        url: req.url,
        attestedTrustId: body.actor?.trustId,
        attestedDisplayName: body.actor?.displayName,
        resolver,
      });
      const result = await handleAsk({
        deps,
        actor: identity.actor,
        caller: identity.caller,
        body,
        requestId,
        accessToken: readAccessToken(req.headers),
      });
      const status = result.ok
        ? 200
        : result.error === "unsupported_capability"
          ? 400
          : result.error === "provider_unavailable"
            ? 503
            : 502;
      return reply.code(status).send(result);
    } catch (err) {
      if (err instanceof DigiAiError) {
        return reply.code(err.status).send({
          ok: false,
          service: "digi-ai",
          error: err.code,
          message: err.message,
        });
      }
      return reply.code(500).send({
        ok: false,
        service: "digi-ai",
        error: "internal_error",
        message: "Digi AI could not complete that request.",
      });
    }
  });

  app.post("/v1/twin/brief", async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = newId("req");
    try {
      const body = parseTwinBriefBody(req.body);
      const identity = await resolveRequestIdentity({
        config,
        headers: req.headers,
        url: req.url,
        attestedTrustId: body.actor?.trustId,
        attestedDisplayName: body.actor?.displayName,
        resolver,
      });
      const result = await handleTwinBrief({
        deps,
        actor: identity.actor,
        caller: identity.caller,
        body,
        requestId,
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof DigiAiError) {
        return reply.code(err.status).send({
          ok: false,
          service: "digi-ai",
          experience: "digi-twin",
          error: err.code,
          message: err.message,
        });
      }
      return reply.code(500).send({
        ok: false,
        service: "digi-ai",
        experience: "digi-twin",
        error: "internal_error",
        message: "Digi AI could not complete that briefing.",
      });
    }
  });

  app.post("/internal/media/drive-acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = authenticateCaller(config, req.headers);
      if (!caller) throw new DigiAiError(401, "unauthenticated_caller", "Caller identity is required.");
      if (config.isProd && !isOperatorCaller(config, caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for Drive bridge acceptance.");
      }
      const result = await persistDriveAcceptanceFixture({
        drive: deps.drive,
        actorTrustId: caller.id,
        callerId: caller.id,
        tenantId: config.sovereignDriveAcceptanceTenant,
      });
      return reply.code(result.ok ? 200 : 502).send({
        service: "digi-ai",
        note: "DRIVE BRIDGE ACCEPTANCE. Not real AI image generation.",
        ...result,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/media/music-acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = authenticateCaller(config, req.headers);
      if (!caller) throw new DigiAiError(401, "unauthenticated_caller", "Caller identity is required.");
      if (config.isProd && !isOperatorCaller(config, caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for music Drive acceptance.");
      }
      const result = await persistMusicAcceptanceFixture({
        drive: deps.drive,
        actorTrustId: caller.id,
        callerId: caller.id,
        tenantId: config.sovereignDriveAcceptanceTenant,
      });
      return reply.code(result.ok ? 200 : 502).send({
        service: "digi-ai",
        ...result,
        note: "MUSIC DRIVE ACCEPTANCE. Safe fixture through Digi AI media persistence. Not real music generation.",
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/media/video-acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = authenticateCaller(config, req.headers);
      if (!caller) throw new DigiAiError(401, "unauthenticated_caller", "Caller identity is required.");
      if (config.isProd && !isOperatorCaller(config, caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for video Drive acceptance.");
      }
      const result = await persistVideoAcceptanceFixture({
        drive: deps.drive,
        actorTrustId: caller.id,
        callerId: caller.id,
        tenantId: config.sovereignDriveAcceptanceTenant,
      });
      return reply.code(result.ok ? 200 : 502).send({
        service: "digi-ai",
        ...result,
        note: "VIDEO DRIVE ACCEPTANCE. Safe fixture through Digi AI media persistence. Not real video generation.",
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/internal/media/audio-acceptance", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const caller = authenticateCaller(config, req.headers);
      if (!caller) throw new DigiAiError(401, "unauthenticated_caller", "Caller identity is required.");
      if (config.isProd && !isOperatorCaller(config, caller)) {
        throw new DigiAiError(403, "operator_required", "Operator access is required for audio Drive acceptance.");
      }
      const result = await persistAudioAcceptanceFixture({
        drive: deps.drive,
        actorTrustId: caller.id,
        callerId: caller.id,
        tenantId: config.sovereignDriveAcceptanceTenant,
      });
      return reply.code(result.ok ? 200 : 502).send({
        service: "digi-ai",
        ...result,
        note: "AUDIO DRIVE ACCEPTANCE. Safe fixture through Digi AI media persistence. Not real TTS provider acceptance.",
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  const rejectWrite = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).send({ ok: false, service: "digi-ai", error: "method_not_allowed", message: "Not allowed." });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    app.route({ method, url: "/", handler: rejectWrite });
  }

  return Object.assign(app, { store, provider });
}

function parseUsageQuery(raw: unknown): LedgerQuery {
  const query = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const read = (name: string) => typeof query[name] === "string" ? String(query[name]) : undefined;
  return {
    from: read("from"),
    to: read("to"),
    actorId: read("actorId"),
    tenantId: read("tenantId"),
    applicationId: read("applicationId"),
    capability: read("capability"),
    providerId: read("providerId") || read("provider"),
    modelId: read("modelId") || read("model"),
    status: read("status"),
  };
}

function sanitizeLedger(row: import("./contracts/ledger.js").LedgerEntry) {
  return {
    ...row,
    digiAiUnits: null,
  };
}

function readAccessToken(headers: FastifyRequest["headers"]): string | undefined {
  const auth = headers.authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (value && value.toLowerCase().startsWith("bearer ")) return value.slice(7).trim();
  return undefined;
}
