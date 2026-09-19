import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication, EntityContext } from "../contracts/actor.js";
import type { CapabilityId } from "../contracts/capabilities.js";
import { defaultPrivacyClass, isPrivacyClass } from "../contracts/privacy.js";
import type { DigiAiAskInput } from "../contracts/request.js";
import type { DigiAiAskResponse } from "../contracts/response.js";
import type { ProvenanceItem } from "../contracts/provenance.js";
import type { GeneratedMediaResult, ImageOperation, MediaOperation } from "../contracts/media.js";
import { sanitizeMediaForLedger } from "../contracts/media.js";
import type { VoiceInteractionResult } from "../contracts/speech.js";
import type { NativeUsage } from "../contracts/usage.js";
import type { DigiNewsReader, DigiPediaReader, NewsPage, DigiPediaPage } from "../adapters/types.js";
import { clip, newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import { requireSlug } from "../lib/slug.js";
import { SYSTEM_POLICY, wrapCanonicalData } from "../lib/policy.js";
import { UnboundDrive, type SovereignDrive } from "../media/drive.js";
import { peekJwtTenant } from "../media/jwt.js";
import { assertAudioInputLimits } from "../media/audio.js";
import { assertImageInputLimits, mapSizeClass, parseImageConstraints } from "../media/limits.js";
import { normalizeGeneratedMedia, persistHeldGeneratedMedia } from "../media/normalize.js";
import { clearResolvedImages, imageDataBlock, resolveImageInputs } from "../media/resolve.js";
import {
  clearSpeechAudio,
  resolveSpeechAudio,
  runSpeechToText,
  runTextToSpeech,
  speechUsage,
  transcriptAsData,
  voiceResult,
} from "./speech.js";
import { buildMusicBrief, expectedMusicDuration, musicAnswer, parseMusicRequest, selectMusicModel } from "./music.js";
import { buildVideoBrief, parseVideoRequest, selectVideoModel, videoAnswer, videoPixelSize, VEO_FRAME_RATE } from "./video.js";
import { videoJobHold, videoJobKey } from "../media/video-jobs.js";
import type { VideoOperation } from "../contracts/video.js";
import { ProviderPool } from "../providers/pool.js";
import type { IntelligenceProvider, ProviderResult } from "../providers/types.js";
import { executeWithFailover } from "../routing/execute.js";
import { resolveRequestedCapability } from "../routing/resolve-capability.js";
import { routeCapability } from "../routing/runtime.js";
import { buildLedgerEntry, usageFromLedger } from "../usage/ledger.js";
import { persistExecution } from "../usage/persist.js";
import { buildRequestReceipt, buildUsageRecord, nativeUsageFromTokens, snapshotFromRecord } from "../usage/receipt.js";
import type { DigiAiStore } from "../store/types.js";
import { proposeObjective } from "./objectives.js";
import { selectSources } from "./sources.js";

export type EngineDeps = {
  config: AppConfig;
  provider: IntelligenceProvider;
  pool?: ProviderPool;
  digipedia: DigiPediaReader;
  diginews: DigiNewsReader;
  store: DigiAiStore;
  drive?: SovereignDrive;
};

export async function handleAsk(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
  body: DigiAiAskInput;
  requestId: string;
  accessToken?: string;
}): Promise<DigiAiAskResponse> {
  const { deps, actor, caller, body, requestId } = input;
  const accessToken = input.accessToken;
  const correlationId = body.correlationId?.trim() || requestId;
  const message = (body.message ?? "").trim();
  if (!message) throw new DigiAiError(400, "invalid_request", "A request message is required.");
  if (message.length > deps.config.maxMessageChars) {
    throw new DigiAiError(400, "invalid_request", "Request is too large.");
  }
  const supplied = body.suppliedContext?.text?.trim() ?? "";
  if (supplied.length > deps.config.maxSuppliedChars) {
    throw new DigiAiError(400, "invalid_request", "Supplied context is too large.");
  }

  const entity: EntityContext = body.entity ?? {};
  const sources = selectSources({
    message,
    requested: body.sources,
    hasSupplied: Boolean(supplied),
  });

  const provenance: ProvenanceItem[] = [];
  const userParts: string[] = [`USER REQUEST:\n${message}`];
  let sourceUnavailable = false;

  if (sources.includes("supplied") && supplied) {
    provenance.push({
      kind: "unverified",
      system: "supplied",
      owner: caller.id,
      retrievedAt: nowIso(),
      excerpt: clip(supplied, 280),
      note: "Caller-authorized supplied context. Not a canonical Digiconomy record.",
    });
    userParts.push(wrapCanonicalData("supplied", supplied));
  }

  if (sources.includes("digipedia")) {
    const slug = requireSlug(entity.slug, "DigiPedia");
    const result = await deps.digipedia.readPublished(slug);
    if (!result.ok) {
      sourceUnavailable = result.error === "unavailable";
      provenance.push({
        kind: "unverified",
        system: "digipedia",
        retrievedAt: nowIso(),
        note: result.message,
      });
      userParts.push(`DIGIPEDIA STATUS: ${result.message}`);
    } else {
      appendDigiPedia(result.page, provenance, userParts);
    }
  }

  if (sources.includes("diginews")) {
    const slug = requireSlug(entity.slug, "DigiNews");
    const result = await deps.diginews.readPublic(slug, deps.config.newsLimit);
    if (!result.ok) {
      sourceUnavailable = sourceUnavailable || result.error === "unavailable";
      provenance.push({
        kind: "unverified",
        system: "diginews",
        retrievedAt: nowIso(),
        note: result.message,
      });
      userParts.push(`DIGINEWS STATUS: ${result.message}`);
    } else {
      appendNews(result.page, provenance, userParts);
    }
  }

  if (body.draft?.actionType) {
    userParts.push(
      [
        "DRAFT ASSIST (caller-authorized studio fields):",
        `Action: ${body.draft.actionType}`,
        body.draft.projectTitle ? `Project: ${body.draft.projectTitle}` : "",
        body.draft.projectType ? `Type: ${body.draft.projectType}` : "",
        body.draft.projectDescription ? `Description: ${body.draft.projectDescription}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const mode = body.mode ?? "ask";
  const capability = resolveRequestedCapability({ capability: body.capability, mode });
  const privacyClass = isPrivacyClass(body.constraints?.privacyClass)
    ? body.constraints.privacyClass
    : defaultPrivacyClass();
  const operation = resolveOperation(capability, body.operation ?? body.constraints?.speechTask);
  const images = body.images ?? [];
  const audio = body.audio ?? [];
  if (images.length) assertImageInputLimits(images, deps.config);
  if (audio.length) assertAudioInputLimits(audio, deps.config);
  if (capability === "VISION" && !images.length) {
    throw new DigiAiError(400, "invalid_media", "VISION requires at least one authorized image.");
  }
  if (capability === "IMAGE" && operation === "edit" && !images.length) {
    throw new DigiAiError(400, "invalid_media", "IMAGE edit requires at least one authorized source image.");
  }
  const imageConstraints = capability === "IMAGE" ? parseImageConstraints(body.constraints, deps.config) : undefined;
  userParts.push(`RESPONSE MODE: ${mode}`);
  userParts.push(`CAPABILITY: ${capability}`);
  if (operation) userParts.push(`OPERATION: ${operation}`);
  userParts.push("If canonical data is present, ground generated text in it and say when you are interpreting.");

  const startedAt = nowIso();
  const drive = deps.drive ?? new UnboundDrive();
  const tenantId = actor.tenantId ?? peekJwtTenant(accessToken) ?? (deps.config.isProd ? undefined : entity.slug);
  const pool = deps.pool ?? new ProviderPool({ [deps.provider.name]: deps.provider });
  const allowFailover =
    capability !== "IMAGE" &&
    capability !== "SPEECH_TO_TEXT" &&
    capability !== "TEXT_TO_SPEECH" &&
    capability !== "VOICE" &&
    capability !== "MUSIC" &&
    capability !== "VIDEO" &&
    body.constraints?.allowFailover !== false &&
    deps.config.allowFailover;
  const forceProvider =
    (deps.config.allowRouteOverride || (!deps.config.isProd && caller.id === "test")) &&
    body.constraints?.forceProvider
      ? body.constraints.forceProvider
      : undefined;

  if (body.idempotencyKey) {
    const replayed = await replayIdempotent({
      deps,
      callerId: caller.id,
      idempotencyKey: body.idempotencyKey,
      persistCanonical: body.constraints?.persistCanonical === true,
      actorTrustId: actor.trustId,
      tenantId,
      accessToken,
      drive,
    });
    if (replayed) return replayed;
  }

  const privacyChecks = capability === "VOICE"
    ? (["SPEECH_TO_TEXT", "THINK", "TEXT_TO_SPEECH"] as const).map((id) =>
        routeCapability({ config: deps.config, pool, capability: id, privacyClass, forceProvider }),
      )
    : [routeCapability({ config: deps.config, pool, capability, privacyClass, forceProvider })];
  const privacyRoute = privacyChecks.find((row) => !row.decision.ok)?.decision.ok === false
    ? privacyChecks.find((row) => !row.decision.ok)!
    : privacyChecks[0]!;
  if (!privacyRoute.decision.ok) {
    const error = privacyRoute.decision.error === "unsupported_capability" ? "unsupported_capability" : "provider_unavailable";
    const receiptId = newId("rcpt");
    const recorded = await persistAsk({
      deps,
      actor,
      caller,
      usageId: newId("use"),
      receiptId,
      requestId,
      attemptIndex: 1,
      correlationId,
      entitySlug: entity.slug,
      capability,
      privacyClass,
      providerId: deps.provider.name,
      startedAt,
      latencyMs: 0,
      success: false,
      status: error,
      errorClass: privacyRoute.decision.error,
      operation: operation ?? mode,
      sources,
      routeExplanation: privacyRoute.decision.explanation,
      resultStatus: sourceUnavailable ? "source_unavailable" : error,
      idempotencyKey: body.idempotencyKey,
    });
    return {
      ok: false,
      service: "digi-ai",
      error,
      message: privacyRoute.decision.detail,
      provenance,
      usage: snapshotFromRecord(recorded.usage),
      execution: {
        requestId,
        correlationId,
        provider: deps.provider.name,
        capability,
        latencyMs: 0,
        sourcesUsed: sources,
        finishState: sourceUnavailable ? "source_unavailable" : error,
      },
      receiptId,
    };
  }

  if (capability === "VIDEO") {
    return handleVideoAsk({
      deps,
      actor,
      caller,
      body,
      requestId,
      accessToken,
      correlationId,
      capability,
      privacyClass,
      operation: (operation === "image_to_video" ? "image_to_video" : "generate") as VideoOperation,
      sources,
      provenance,
      sourceUnavailable,
      startedAt,
      drive,
      tenantId,
      pool,
      forceProvider,
    });
  }

  if (capability === "MUSIC") {
    return handleMusicAsk({
      deps,
      actor,
      caller,
      body,
      requestId,
      accessToken,
      correlationId,
      capability,
      privacyClass,
      operation: "compose",
      sources,
      provenance,
      sourceUnavailable,
      startedAt,
      drive,
      tenantId,
      pool,
      forceProvider,
    });
  }

  if (capability === "SPEECH_TO_TEXT" || capability === "TEXT_TO_SPEECH" || capability === "VOICE") {
    return handleSpeechAsk({
      deps,
      actor,
      caller,
      body,
      requestId,
      accessToken,
      correlationId,
      capability,
      privacyClass,
      operation: operation ?? (capability === "TEXT_TO_SPEECH" ? "speak" : capability === "VOICE" ? "converse" : "transcribe"),
      sources,
      provenance,
      userParts,
      sourceUnavailable,
      startedAt,
      drive,
      tenantId,
      pool,
      forceProvider,
      allowFailover,
    });
  }

  const resolvedImages = images.length
    ? await resolveImageInputs({
        images,
        config: deps.config,
        drive,
        actorTrustId: actor.trustId,
        callerId: caller.id,
        tenantId,
        accessToken,
      })
    : [];
  if (resolvedImages.length) {
    userParts.push(wrapCanonicalData("image-metadata", imageDataBlock(resolvedImages)));
  }

  const executed = await executeWithFailover({
    config: deps.config,
    pool,
    capability,
    privacyClass,
    allowFailover,
    forceProvider,
    request: {
      messages: [
        { role: "system", content: SYSTEM_POLICY },
        { role: "user", content: userParts.join("\n\n") },
      ],
      structuredOutput: body.constraints?.structuredOutput === true,
      capability,
      operation,
      images: resolvedImages.map((image) => ({
        mimeType: image.mimeType,
        dataUrl: image.dataUrl,
        filename: image.filename,
      })),
      imageCount: imageConstraints?.count,
      size: mapSizeClass(imageConstraints?.sizeClass, imageConstraints?.aspectRatio),
      outputFormat: imageConstraints?.outputFormat,
      transparentBackground: imageConstraints?.transparentBackground,
    },
  });
  clearResolvedImages(resolvedImages);

  if (!executed.decision.ok) {
    const error = executed.decision.error === "unsupported_capability" ? "unsupported_capability" : "provider_unavailable";
    const receiptId = newId("rcpt");
    const recorded = await persistAsk({
      deps,
      actor,
      caller,
      usageId: newId("use"),
      receiptId,
      requestId,
      attemptIndex: 1,
      correlationId,
      entitySlug: entity.slug,
      capability,
      privacyClass,
      providerId: deps.provider.name,
      startedAt,
      latencyMs: 0,
      success: false,
      status: error,
      errorClass: executed.decision.error,
      operation: operation ?? mode,
      sources,
      routeExplanation: executed.explanation,
      resultStatus: sourceUnavailable ? "source_unavailable" : error,
      idempotencyKey: body.idempotencyKey,
    });
    return {
      ok: false,
      service: "digi-ai",
      error,
      message: executed.decision.detail,
      provenance,
      usage: snapshotFromRecord(recorded.usage),
      execution: {
        requestId,
        correlationId,
        provider: deps.provider.name,
        capability,
        latencyMs: 0,
        sourcesUsed: sources,
        finishState: sourceUnavailable ? "source_unavailable" : error,
      },
      receiptId,
    };
  }

  let media: GeneratedMediaResult[] | undefined;
  const finalPreview = executed.final;
  if (finalPreview?.ok && capability === "IMAGE" && finalPreview.media?.length) {
    media = await normalizeGeneratedMedia({
      outputs: finalPreview.media,
      providerId: finalPreview.provider,
      modelId: finalPreview.model,
      operation: operation === "edit" ? "edit" : "generate",
      actorTrustId: actor.trustId,
      applicationId: caller.id,
      sourceAssetIds: resolvedImages.map((image) => image.assetId).filter((id): id is string => Boolean(id)),
      persistCanonical: body.constraints?.persistCanonical === true,
      drive,
      tenantId,
      accessToken,
      executionRef: requestId,
      idempotencyKey: body.idempotencyKey,
      maxTransientBytes: deps.config.maxTransientBytes,
    });
  }

  let recorded: Awaited<ReturnType<typeof persistAsk>> | undefined;
  for (const attempt of executed.attempts) {
    const providerResult = attempt.result;
    const nativeUsage = providerResult.ok
      ? nativeUsageFromTokens(providerResult.usage)
      : undefined;
    const status = providerResult.ok
      ? "completed"
      : providerResult.error === "unavailable"
        ? "provider_unavailable"
        : "failed";
    recorded = await persistAsk({
      deps,
      actor,
      caller,
      usageId: newId("use"),
      receiptId: newId("rcpt"),
      requestId,
      attemptIndex: attempt.attemptIndex,
      correlationId,
      entitySlug: entity.slug,
      capability,
      privacyClass,
      providerId: attempt.providerId,
      modelId: providerResult.ok ? providerResult.model : attempt.modelId,
      startedAt,
      latencyMs: providerResult.latencyMs,
      success: providerResult.ok,
      status,
      nativeUsage,
      providerRequestId: providerResult.ok ? providerResult.providerRequestId : undefined,
      errorClass: providerResult.ok ? undefined : providerResult.error,
      operation: operation ?? mode,
      sources,
      routeExplanation: `${executed.explanation}; attempt ${attempt.attemptIndex} ${attempt.providerId}/${attempt.modelId} ${providerResult.ok ? "ok" : providerResult.error}${attempt.failoverReason ? `; ${attempt.failoverReason}` : ""}`,
      resultStatus: sourceUnavailable ? "source_unavailable" : status,
      idempotencyKey: body.idempotencyKey,
      resultSnapshot: attempt.result.ok
        ? {
            answer: attempt.result.text,
            media: sanitizeMediaForLedger(media),
            finishState: "completed",
            canonicalAssetReference: media?.find((row) => row.canonicalAssetReference)?.canonicalAssetReference,
          }
        : undefined,
    });
  }

  const providerResult = executed.final;
  const last = recorded ?? await persistAsk({
    deps,
    actor,
    caller,
    usageId: newId("use"),
    receiptId: newId("rcpt"),
    requestId,
    attemptIndex: 1,
    correlationId,
    entitySlug: entity.slug,
    capability,
    privacyClass,
    providerId: deps.provider.name,
    startedAt,
    latencyMs: 0,
    success: false,
    status: "provider_unavailable",
    errorClass: "provider_unavailable",
    operation: mode,
    sources,
    routeExplanation: executed.explanation,
    resultStatus: sourceUnavailable ? "source_unavailable" : "provider_unavailable",
  });
  const receiptId = last.receiptId;

  if (!providerResult || !providerResult.ok) {
    const status = !providerResult || providerResult.error === "unavailable" ? "provider_unavailable" : "failed";
    return {
      ok: false,
      service: "digi-ai",
      error: status,
      message: providerResult && !providerResult.ok ? providerResult.detail : executed.decision.ok ? "No eligible provider completed the request." : "Provider unavailable.",
      provenance,
      usage: snapshotFromRecord(last.usage),
      execution: {
        requestId,
        correlationId,
        provider: providerResult?.provider ?? deps.provider.name,
        model: executed.decision.ok ? executed.decision.selected.modelId : undefined,
        capability,
        latencyMs: providerResult?.latencyMs ?? 0,
        sourcesUsed: sources,
        finishState: sourceUnavailable ? "source_unavailable" : status,
      },
      receiptId,
    };
  }

  provenance.unshift({
    kind: "generated",
    system: "digi-ai",
    retrievedAt: nowIso(),
    note: capability === "IMAGE"
      ? "Generated imagery. Not original captured media. Transient output is not a Sovereign Drive asset."
      : "Generated by Digi AI from the selected context. Not a canonical record.",
  });

  const objectiveCandidate = proposeObjective(message, body.draft?.actionType);

  return {
    ok: true,
    service: "digi-ai",
    answer: providerResult.text,
    provenance,
    usage: snapshotFromRecord(last.usage),
    execution: {
      requestId,
      correlationId,
      provider: providerResult.provider,
      model: providerResult.model,
      capability,
      latencyMs: providerResult.latencyMs,
      sourcesUsed: sources,
      finishState: "completed",
    },
    receiptId,
    media,
    objectiveCandidate,
  };
}

function appendDigiPedia(page: DigiPediaPage, provenance: ProvenanceItem[], userParts: string[]) {
  const sections = page.entry.sections
    .slice()
    .sort((a, b) => a.heading.localeCompare(b.heading))
    .map((section) => `${section.heading}\n${section.body}`)
    .join("\n\n");
  const text = clip([page.entry.title, page.entry.summary, sections].filter(Boolean).join("\n\n"), 6000);
  provenance.push({
    kind: "canonical",
    system: "digipedia",
    owner: "digipedia",
    retrievedAt: nowIso(),
    reference: {
      sourceId: page.entry.entryId,
      sourceType: "canonical_entity",
      publisherEntityId: page.entity.entityId,
      canonicalUrl: page.canonicalUrl,
      title: page.entry.title,
      available: true,
    },
    excerpt: clip(page.entry.summary || text, 280),
    note: page.entry.status === "sparse" ? "Published sparse DigiPedia projection." : "Published DigiPedia entry.",
  });
  for (const ref of page.entry.sourceReferences ?? []) {
    provenance.push({
      kind: "canonical",
      system: "digipedia",
      owner: "digipedia",
      retrievedAt: nowIso(),
      reference: ref,
    });
  }
  userParts.push(wrapCanonicalData("digipedia", `Entity ${page.entity.displayName} (${page.entity.slug})\n${text}`));
}

function appendNews(page: NewsPage, provenance: ProvenanceItem[], userParts: string[]) {
  const lines = page.items.map((item) => {
    provenance.push({
      kind: "canonical",
      system: "diginews",
      owner: "diginews",
      retrievedAt: nowIso(),
      reference: {
        ...item.source,
        canonicalUrl: item.canonicalUrl,
        publicationId: item.publicationId,
        title: item.title ?? item.source.title,
        publishedAt: item.publishedAt,
        available: true,
      },
      excerpt: clip(item.summary || item.title || "", 220),
      note: `Public DigiNews projection. Publisher: ${item.publisher.displayName}.`,
    });
    return `- ${item.publishedAt} · ${item.title ?? "(untitled)"} · ${item.publisher.displayName} · ${item.canonicalUrl}`;
  });
  const body =
    lines.length > 0
      ? `Recent public publications for ${page.entity.displayName}:\n${lines.join("\n")}`
      : `No public publications are currently projectable for ${page.entity.displayName}.`;
  userParts.push(wrapCanonicalData("diginews", body));
}

async function handleSpeechAsk(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
  body: DigiAiAskInput;
  requestId: string;
  accessToken?: string;
  correlationId: string;
  capability: CapabilityId;
  privacyClass: string;
  operation: MediaOperation;
  sources: string[];
  provenance: ProvenanceItem[];
  userParts: string[];
  sourceUnavailable: boolean;
  startedAt: string;
  drive: SovereignDrive;
  tenantId?: string;
  pool: ProviderPool;
  forceProvider?: string;
  allowFailover: boolean;
}): Promise<DigiAiAskResponse> {
  const ctx = {
    config: input.deps.config,
    pool: input.pool,
    drive: input.drive,
    actor: input.actor,
    caller: input.caller,
    body: input.body,
    requestId: input.requestId,
    accessToken: input.accessToken,
    tenantId: input.tenantId,
    privacyClass: input.privacyClass as import("../contracts/privacy.js").PrivacyClass,
    forceProvider: input.forceProvider,
    allowFailover: input.allowFailover,
  };
  const persistStage = async (
    capability: string,
    attemptIndex: number,
    plan: { final: ProviderResult | null; explanation: string },
    extras?: { media?: GeneratedMediaResult[]; speech?: VoiceInteractionResult; idempotency?: boolean; logicalCompleted?: boolean },
  ) => {
    const providerResult = plan.final;
    const status = !providerResult
      ? "provider_unavailable"
      : providerResult.ok
        ? "completed"
        : providerResult.error === "unavailable"
          ? "provider_unavailable"
          : "failed";
    return persistAsk({
      deps: input.deps,
      actor: input.actor,
      caller: input.caller,
      usageId: newId("use"),
      receiptId: newId("rcpt"),
      requestId: input.requestId,
      attemptIndex,
      correlationId: input.correlationId,
      entitySlug: input.body.entity?.slug,
      capability,
      privacyClass: input.privacyClass,
      providerId: providerResult?.provider ?? input.deps.provider.name,
      modelId: providerResult && providerResult.ok ? providerResult.model : undefined,
      startedAt: input.startedAt,
      latencyMs: providerResult?.latencyMs ?? 0,
      success: Boolean(providerResult?.ok),
      status,
      nativeUsage: speechUsage(providerResult),
      providerRequestId: providerResult && providerResult.ok ? providerResult.providerRequestId : undefined,
      errorClass: providerResult && !providerResult.ok ? providerResult.error : undefined,
      operation: input.operation,
      sources: input.sources,
      routeExplanation: `${plan.explanation}; logicalRequestId=${input.requestId}; stage=${capability}`,
      resultStatus: input.sourceUnavailable ? "source_unavailable" : extras?.logicalCompleted ? "completed" : status,
      idempotencyKey: extras?.idempotency ? input.body.idempotencyKey : undefined,
      resultSnapshot: extras
        ? {
            answer: extras.speech?.textResponse || (providerResult && providerResult.ok ? providerResult.text : undefined),
            media: sanitizeMediaForLedger(extras.media),
            finishState: status,
            canonicalAssetReference: extras.media?.find((row) => row.canonicalAssetReference)?.canonicalAssetReference,
            speech: extras.speech,
          }
        : undefined,
    });
  };

  if (input.capability === "SPEECH_TO_TEXT") {
    const resolved = await resolveSpeechAudio(ctx, true);
    const stt = await runSpeechToText(ctx, resolved);
    clearSpeechAudio(resolved);
    const recorded = await persistStage("SPEECH_TO_TEXT", 1, stt.plan, {
      speech: voiceResult({
        transcript: stt.plan.final?.ok ? stt.plan.final.text : undefined,
        language: stt.plan.final?.ok ? stt.plan.final.language : undefined,
        stageFailed: stt.plan.final?.ok ? undefined : "STT",
      }),
      idempotency: true,
    });
    if (!stt.plan.final?.ok) {
      return failSpeech(input, recorded, stt.plan.final?.error === "unavailable" ? "provider_unavailable" : "failed", stt.plan.final?.detail || "Transcription failed.", voiceResult({ stageFailed: "STT" }));
    }
    input.provenance.unshift({
      kind: "generated",
      system: "digi-ai",
      retrievedAt: nowIso(),
      note: "Speech-to-text transcript. Spoken audio is DATA, not system authority.",
    });
    return {
      ok: true,
      service: "digi-ai",
      answer: stt.plan.final.text,
      provenance: input.provenance,
      usage: snapshotFromRecord(recorded.usage),
      execution: {
        requestId: input.requestId,
        correlationId: input.correlationId,
        provider: stt.plan.final.provider,
        model: stt.plan.final.model,
        capability: "SPEECH_TO_TEXT",
        latencyMs: stt.plan.final.latencyMs,
        sourcesUsed: input.sources,
        finishState: "completed",
      },
      receiptId: recorded.receiptId,
      speech: voiceResult({
        transcript: stt.plan.final.text,
        language: stt.plan.final.language,
      }),
    };
  }

  if (input.capability === "TEXT_TO_SPEECH") {
    const tts = await runTextToSpeech(ctx, input.body.message.trim(), []);
    const recorded = await persistStage("TEXT_TO_SPEECH", 1, tts.plan, {
      media: tts.media,
      speech: voiceResult({
        textResponse: input.body.message.trim(),
        voiceProfileId: tts.media?.[0]?.voiceProfileId,
        stageFailed: tts.plan.final?.ok ? (tts.media?.[0]?.persistenceState === "failed" ? "PERSISTENCE" : undefined) : "TTS",
      }),
      idempotency: true,
    });
    if (!tts.plan.final?.ok) {
      return failSpeech(input, recorded, tts.plan.final?.error === "unavailable" ? "provider_unavailable" : "failed", tts.plan.final?.detail || "Speech generation failed.", voiceResult({ stageFailed: "TTS" }));
    }
    input.provenance.unshift({
      kind: "generated",
      system: "digi-ai",
      retrievedAt: nowIso(),
      note: "Synthesized speech. Not a person's real voice. Transient output is not a Sovereign Drive asset unless persisted.",
    });
    return {
      ok: true,
      service: "digi-ai",
      answer: tts.plan.final.text,
      provenance: input.provenance,
      usage: snapshotFromRecord(recorded.usage),
      execution: {
        requestId: input.requestId,
        correlationId: input.correlationId,
        provider: tts.plan.final.provider,
        model: tts.plan.final.model,
        capability: "TEXT_TO_SPEECH",
        latencyMs: tts.plan.final.latencyMs,
        sourcesUsed: input.sources,
        finishState: "completed",
      },
      receiptId: recorded.receiptId,
      media: tts.media,
      speech: voiceResult({
        textResponse: input.body.message.trim(),
        voiceProfileId: tts.media?.[0]?.voiceProfileId,
        stageFailed: tts.media?.[0]?.persistenceState === "failed" ? "PERSISTENCE" : undefined,
      }),
    };
  }

  const resolved = await resolveSpeechAudio(ctx, true);
  const stt = await runSpeechToText(ctx, resolved);
  if (!stt.plan.final?.ok) {
    clearSpeechAudio(resolved);
    const recorded = await persistStage("SPEECH_TO_TEXT", 1, stt.plan, {
      speech: voiceResult({ stageFailed: "STT" }),
      idempotency: true,
    });
    return failSpeech(input, recorded, "failed", stt.plan.final?.detail || "Transcription failed.", voiceResult({ stageFailed: "STT" }));
  }
  await persistStage("SPEECH_TO_TEXT", 1, stt.plan);
  const transcript = stt.plan.final.text;
  input.userParts.push(transcriptAsData(transcript, resolved));
  clearSpeechAudio(resolved);
  const think = await executeWithFailover({
    config: input.deps.config,
    pool: input.pool,
    capability: "THINK",
    privacyClass: ctx.privacyClass,
    allowFailover: input.deps.config.allowFailover && input.body.constraints?.allowFailover !== false,
    forceProvider: input.forceProvider,
    request: {
      messages: [
        { role: "system", content: SYSTEM_POLICY },
        { role: "user", content: input.userParts.join("\n\n") },
      ],
      capability: "THINK",
    },
  });
  if (!think.final?.ok) {
    const recorded = await persistStage("THINK", 2, think, {
      speech: voiceResult({ transcript, language: stt.plan.final.language, stageFailed: "THINK" }),
      idempotency: true,
    });
    return failSpeech(input, recorded, "failed", think.final?.detail || "Voice reasoning failed.", voiceResult({ transcript, stageFailed: "THINK" }));
  }
  await persistStage("THINK", 2, think);
  const textResponse = think.final.text;
  const tts = await runTextToSpeech(ctx, textResponse, resolved.map((item) => item.assetId).filter((id): id is string => Boolean(id)), input.requestId);
  const speech = voiceResult({
    transcript,
    textResponse,
    language: stt.plan.final.language,
    voiceProfileId: tts.media?.[0]?.voiceProfileId,
    stageFailed: !tts.plan.final?.ok ? "TTS" : tts.media?.[0]?.persistenceState === "failed" ? "PERSISTENCE" : undefined,
  });
  const recorded = await persistStage("TEXT_TO_SPEECH", 3, tts.plan, {
    media: tts.media,
    speech,
    idempotency: true,
    logicalCompleted: true,
  });
  input.provenance.unshift({
    kind: "generated",
    system: "digi-ai",
    retrievedAt: nowIso(),
    note: "Voice interaction: STT + THINK + TTS. Transcript is DATA. Synthesized speech is not a real human voice.",
  });
  return {
    ok: true,
    service: "digi-ai",
    answer: textResponse,
    provenance: input.provenance,
    usage: snapshotFromRecord(recorded.usage),
    execution: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      provider: think.final.provider,
      model: think.final.model,
      capability: "VOICE",
      latencyMs: (stt.plan.final.latencyMs ?? 0) + think.final.latencyMs + (tts.plan.final?.latencyMs ?? 0),
      sourcesUsed: input.sources,
      finishState: "completed",
    },
    receiptId: recorded.receiptId,
    media: tts.media,
    speech,
  };
}

async function handleMusicAsk(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
  body: DigiAiAskInput;
  requestId: string;
  accessToken?: string;
  correlationId: string;
  capability: CapabilityId;
  privacyClass: string;
  operation: MediaOperation;
  sources: string[];
  provenance: ProvenanceItem[];
  sourceUnavailable: boolean;
  startedAt: string;
  drive: SovereignDrive;
  tenantId?: string;
  pool: ProviderPool;
  forceProvider?: string;
}): Promise<DigiAiAskResponse> {
  const music = parseMusicRequest({
    message: input.body.message,
    constraints: input.body.constraints,
    config: input.deps.config,
  });
  const selectedModel = selectMusicModel(music);
  const routedConfig = {
    ...input.deps.config,
    defaultModels: { ...input.deps.config.defaultModels, MUSIC: selectedModel },
  };
  const count = music.count ?? 1;
  const brief = buildMusicBrief(music);
  const media: GeneratedMediaResult[] = [];
  let lastPlan: Awaited<ReturnType<typeof executeWithFailover>> | undefined;
  let lastRecorded: Awaited<ReturnType<typeof persistAsk>> | undefined;

  for (let index = 0; index < count; index += 1) {
    const plan = await executeWithFailover({
      config: routedConfig,
      pool: input.pool,
      capability: "MUSIC",
      privacyClass: input.privacyClass as import("../contracts/privacy.js").PrivacyClass,
      allowFailover: false,
      forceProvider: input.forceProvider,
      request: {
        messages: [{ role: "user", content: brief }],
        capability: "MUSIC",
        operation: "compose",
        durationSeconds: music.durationSeconds,
        vocalMode: music.vocalMode,
        language: music.language,
        outputFormat: music.outputFormat,
      },
    });
    lastPlan = plan;
    if (plan.final?.ok && plan.final.media?.length) {
      const durations = expectedMusicDuration(plan.final.model ?? selectedModel, music.durationSeconds);
      const outputs = plan.final.media.map((row) => ({
        ...row,
        durationSeconds: row.durationSeconds ?? durations.actualDurationSeconds,
        requestedDurationSeconds: durations.requestedDurationSeconds,
        sampleRate: row.sampleRate ?? 44100,
        channels: row.channels ?? 2,
      }));
      const normalized = await normalizeGeneratedMedia({
        outputs,
        providerId: plan.final.provider,
        modelId: plan.final.model,
        operation: "compose",
        actorTrustId: input.actor.trustId,
        applicationId: input.caller.id,
        sourceAssetIds: [],
        persistCanonical: music.persistCanonical === true,
        drive: input.drive,
        tenantId: input.tenantId,
        accessToken: input.accessToken,
        executionRef: input.requestId,
        idempotencyKey: index === 0 ? input.body.idempotencyKey : undefined,
        maxTransientBytes: input.deps.config.maxTransientBytes,
        capability: "MUSIC",
        logicalRequestId: input.requestId,
      });
      media.push(...normalized);
    }
    const native = plan.final?.ok
      ? nativeUsageFromTokens({
          ...plan.final.usage,
          trackCount: 1,
          generatedSeconds: plan.final.media?.[0]?.durationSeconds ?? plan.final.usage.generatedSeconds,
          generatedAudioMinutes: plan.final.media?.[0]?.durationSeconds
            ? Number((plan.final.media[0]!.durationSeconds! / 60).toFixed(4))
            : undefined,
          inputCharacters: brief.length,
          providerNativeUnitAmount: 1,
        })
      : undefined;
    lastRecorded = await persistAsk({
      deps: input.deps,
      actor: input.actor,
      caller: input.caller,
      usageId: newId("use"),
      receiptId: newId("rcpt"),
      requestId: input.requestId,
      attemptIndex: index + 1,
      correlationId: input.correlationId,
      entitySlug: input.body.entity?.slug,
      capability: "MUSIC",
      privacyClass: input.privacyClass,
      providerId: plan.final?.provider ?? input.deps.provider.name,
      modelId: plan.final && plan.final.ok ? plan.final.model : selectedModel,
      startedAt: input.startedAt,
      latencyMs: plan.final?.latencyMs ?? 0,
      success: Boolean(plan.final?.ok),
      status: !plan.final ? "provider_unavailable" : plan.final.ok ? "completed" : "failed",
      nativeUsage: native,
      providerRequestId: plan.final?.ok ? plan.final.providerRequestId : undefined,
      errorClass: plan.final && !plan.final.ok ? plan.final.error : undefined,
      operation: "compose",
      sources: input.sources,
      routeExplanation: `${plan.explanation}; logicalRequestId=${input.requestId}; track=${index + 1}/${count}`,
      resultStatus: input.sourceUnavailable ? "source_unavailable" : plan.final?.ok || media.length ? "completed" : "failed",
      idempotencyKey: index === count - 1 ? input.body.idempotencyKey : undefined,
      resultSnapshot: {
        answer: musicAnswer(media.length || count),
        media: sanitizeMediaForLedger(media),
        finishState: plan.final?.ok ? "completed" : "failed",
        canonicalAssetReference: media.find((row) => row.canonicalAssetReference)?.canonicalAssetReference,
      },
    });
    if (!plan.final?.ok && !media.length) {
      return {
        ok: false,
        service: "digi-ai",
        error: plan.final?.error === "unavailable" ? "provider_unavailable" : plan.final?.error === "safety_refused" ? "safety_refused" : "failed",
        message: plan.final?.detail || "Music generation failed.",
        provenance: input.provenance,
        usage: snapshotFromRecord(lastRecorded.usage),
        execution: {
          requestId: input.requestId,
          correlationId: input.correlationId,
          provider: lastRecorded.usage.provider,
          model: lastRecorded.usage.model,
          capability: "MUSIC",
          latencyMs: lastRecorded.usage.latencyMs,
          sourcesUsed: input.sources,
          finishState: "failed",
        },
        receiptId: lastRecorded.receiptId,
      };
    }
  }

  input.provenance.unshift({
    kind: "generated",
    system: "digi-ai",
    retrievedAt: nowIso(),
    note: "Generated musical audio. Synthesized, not human-recorded, and not a published song.",
  });
  const recorded = lastRecorded!;
  return {
    ok: true,
    service: "digi-ai",
    answer: musicAnswer(media.length),
    provenance: input.provenance,
    usage: snapshotFromRecord(recorded.usage),
    execution: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      provider: lastPlan?.final?.ok ? lastPlan.final.provider : recorded.usage.provider,
      model: lastPlan?.final?.ok ? lastPlan.final.model : recorded.usage.model,
      capability: "MUSIC",
      latencyMs: recorded.usage.latencyMs,
      sourcesUsed: input.sources,
      finishState: "completed",
    },
    receiptId: recorded.receiptId,
    media,
  };
}

async function handleVideoAsk(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
  body: DigiAiAskInput;
  requestId: string;
  accessToken?: string;
  correlationId: string;
  capability: CapabilityId;
  privacyClass: string;
  operation: VideoOperation;
  sources: string[];
  provenance: ProvenanceItem[];
  sourceUnavailable: boolean;
  startedAt: string;
  drive: SovereignDrive;
  tenantId?: string;
  pool: ProviderPool;
  forceProvider?: string;
}): Promise<DigiAiAskResponse> {
  const images = input.body.images ?? [];
  if (images.length > 1) {
    throw new DigiAiError(400, "invalid_media", "VIDEO image_to_video accepts at most one authorized source image.");
  }
  const resolvedImages = images.length
    ? await resolveImageInputs({
        images,
        config: input.deps.config,
        drive: input.drive,
        actorTrustId: input.actor.trustId,
        callerId: input.caller.id,
        tenantId: input.tenantId,
        accessToken: input.accessToken,
      })
    : [];
  const video = parseVideoRequest({
    message: input.body.message,
    operation: input.operation,
    hasSourceImage: resolvedImages.length > 0,
    constraints: input.body.constraints,
    config: input.deps.config,
  });
  const selectedModel = selectVideoModel(video);
  const routedConfig = {
    ...input.deps.config,
    defaultModels: { ...input.deps.config.defaultModels, VIDEO: selectedModel },
  };
  const count = video.count;
  const brief = buildVideoBrief(video);
  const pixels = videoPixelSize(video.aspectRatio, video.resolution);
  const media: GeneratedMediaResult[] = [];
  let lastPlan: Awaited<ReturnType<typeof executeWithFailover>> | undefined;
  let lastRecorded: Awaited<ReturnType<typeof persistAsk>> | undefined;
  const holdKeyValue = input.body.idempotencyKey ? videoJobKey(input.caller.id, input.body.idempotencyKey) : undefined;
  let heldJob = holdKeyValue ? videoJobHold.get(holdKeyValue) : undefined;
  if (!heldJob?.operationId && input.body.idempotencyKey) {
    const existing = await input.deps.store.findReceiptByIdempotency?.(input.caller.id, input.body.idempotencyKey);
    const snapshot = existing?.resultSnapshot as { providerOperationId?: string } | undefined;
    if (existing?.resultStatus === "processing" && snapshot?.providerOperationId) {
      heldJob = {
        operationId: snapshot.providerOperationId,
        requestId: existing.requestId,
        receiptId: existing.receiptId,
        model: selectedModel,
        status: "processing",
        createdAt: Date.now(),
      };
    }
  }

  for (let index = 0; index < count; index += 1) {
    const plan = await executeWithFailover({
      config: routedConfig,
      pool: input.pool,
      capability: "VIDEO",
      privacyClass: input.privacyClass as import("../contracts/privacy.js").PrivacyClass,
      allowFailover: false,
      forceProvider: input.forceProvider,
      request: {
        messages: [{ role: "user", content: brief }],
        capability: "VIDEO",
        operation: video.operation,
        durationSeconds: video.durationSeconds,
        aspectRatio: video.aspectRatio,
        resolution: video.resolution,
        providerOperationId: index === 0 ? heldJob?.operationId : undefined,
        pollIntervalMs: input.deps.config.videoPollMs,
        timeoutMs: input.deps.config.videoTimeoutMs,
        images: resolvedImages.map((image) => ({
          mimeType: image.mimeType,
          dataUrl: image.dataUrl,
          filename: image.filename,
        })),
      },
    });
    lastPlan = plan;
    if (plan.final?.ok && plan.final.providerRequestId && holdKeyValue) {
      videoJobHold.put(holdKeyValue, {
        operationId: plan.final.providerRequestId,
        requestId: input.requestId,
        model: selectedModel,
        status: plan.final.jobStatus === "completed" ? "completed" : "processing",
      });
    }
    if (plan.final?.ok && plan.final.jobStatus === "processing") {
      lastRecorded = await persistAsk({
        deps: input.deps,
        actor: input.actor,
        caller: input.caller,
        usageId: newId("use"),
        receiptId: newId("rcpt"),
        requestId: input.requestId,
        attemptIndex: index + 1,
        correlationId: input.correlationId,
        entitySlug: input.body.entity?.slug,
        capability: "VIDEO",
        privacyClass: input.privacyClass,
        providerId: plan.final.provider,
        modelId: plan.final.model ?? selectedModel,
        startedAt: input.startedAt,
        latencyMs: plan.final.latencyMs,
        success: false,
        status: "processing",
        providerRequestId: plan.final.providerRequestId,
        operation: video.operation,
        sources: input.sources,
        routeExplanation: `${plan.explanation}; logicalRequestId=${input.requestId}; processing operation=${plan.final.providerRequestId}`,
        resultStatus: "processing",
        resultSnapshot: {
          answer: videoAnswer(0, true),
          media: [],
          finishState: "processing",
          providerOperationId: plan.final.providerRequestId,
        },
      });
      clearResolvedImages(resolvedImages);
      return {
        ok: true,
        service: "digi-ai",
        answer: videoAnswer(0, true),
        provenance: input.provenance,
        usage: snapshotFromRecord(lastRecorded.usage),
        execution: {
          requestId: input.requestId,
          correlationId: input.correlationId,
          provider: plan.final.provider,
          model: plan.final.model ?? selectedModel,
          capability: "VIDEO",
          latencyMs: plan.final.latencyMs,
          sourcesUsed: input.sources,
          finishState: "processing",
        },
        receiptId: lastRecorded.receiptId,
        media: [],
      };
    }
    if (plan.final?.ok && plan.final.media?.length) {
      const outputs = plan.final.media.map((row) => ({
        ...row,
        durationSeconds: row.durationSeconds ?? video.durationSeconds,
        requestedDurationSeconds: video.durationSeconds,
        width: row.width ?? pixels.width,
        height: row.height ?? pixels.height,
        frameRate: row.frameRate ?? VEO_FRAME_RATE,
        audioPresent: row.audioPresent ?? true,
      }));
      const normalized = await normalizeGeneratedMedia({
        outputs,
        providerId: plan.final.provider,
        modelId: plan.final.model,
        operation: video.operation,
        actorTrustId: input.actor.trustId,
        applicationId: input.caller.id,
        sourceAssetIds: resolvedImages.map((image) => image.assetId).filter((id): id is string => Boolean(id)),
        persistCanonical: video.persistCanonical === true,
        drive: input.drive,
        tenantId: input.tenantId,
        accessToken: input.accessToken,
        executionRef: input.requestId,
        idempotencyKey: index === 0 ? input.body.idempotencyKey : undefined,
        maxTransientBytes: input.deps.config.maxTransientBytes,
        capability: "VIDEO",
        logicalRequestId: input.requestId,
      });
      media.push(...normalized);
    }
    const native = plan.final?.ok && plan.final.jobStatus !== "processing"
      ? nativeUsageFromTokens({
          ...plan.final.usage,
          videoCount: 1,
          videoSeconds: plan.final.media?.[0]?.durationSeconds ?? video.durationSeconds,
          generatedSeconds: plan.final.media?.[0]?.durationSeconds ?? video.durationSeconds,
          outputBytes: plan.final.media?.[0]?.byteSize,
          providerNativeUnitAmount: plan.final.media?.[0]?.durationSeconds ?? video.durationSeconds,
        })
      : undefined;
    lastRecorded = await persistAsk({
      deps: input.deps,
      actor: input.actor,
      caller: input.caller,
      usageId: newId("use"),
      receiptId: newId("rcpt"),
      requestId: input.requestId,
      attemptIndex: index + 1,
      correlationId: input.correlationId,
      entitySlug: input.body.entity?.slug,
      capability: "VIDEO",
      privacyClass: input.privacyClass,
      providerId: plan.final?.provider ?? input.deps.provider.name,
      modelId: plan.final && plan.final.ok ? plan.final.model : selectedModel,
      startedAt: input.startedAt,
      latencyMs: plan.final?.latencyMs ?? 0,
      success: Boolean(plan.final?.ok && media.length),
      status: !plan.final ? "provider_unavailable" : plan.final.ok && media.length ? "completed" : "failed",
      nativeUsage: native,
      providerRequestId: plan.final?.ok ? plan.final.providerRequestId : undefined,
      errorClass: plan.final && !plan.final.ok ? plan.final.error : undefined,
      operation: video.operation,
      sources: input.sources,
      routeExplanation: `${plan.explanation}; logicalRequestId=${input.requestId}; clip=${index + 1}/${count}`,
      resultStatus: input.sourceUnavailable ? "source_unavailable" : plan.final?.ok && media.length ? "completed" : "failed",
      idempotencyKey: index === count - 1 ? input.body.idempotencyKey : undefined,
      resultSnapshot: {
        answer: videoAnswer(media.length || count, false),
        media: sanitizeMediaForLedger(media),
        finishState: plan.final?.ok && media.length ? "completed" : "failed",
        canonicalAssetReference: media.find((row) => row.canonicalAssetReference)?.canonicalAssetReference,
        providerOperationId: plan.final?.ok ? plan.final.providerRequestId : undefined,
      },
    });
    if (!plan.final?.ok && !media.length) {
      clearResolvedImages(resolvedImages);
      return {
        ok: false,
        service: "digi-ai",
        error: plan.final?.error === "unavailable" ? "provider_unavailable" : plan.final?.error === "safety_refused" ? "safety_refused" : "failed",
        message: plan.final?.detail || "Video generation failed.",
        provenance: input.provenance,
        usage: snapshotFromRecord(lastRecorded.usage),
        execution: {
          requestId: input.requestId,
          correlationId: input.correlationId,
          provider: lastRecorded.usage.provider,
          model: lastRecorded.usage.model,
          capability: "VIDEO",
          latencyMs: lastRecorded.usage.latencyMs,
          sourcesUsed: input.sources,
          finishState: "failed",
        },
        receiptId: lastRecorded.receiptId,
      };
    }
  }

  clearResolvedImages(resolvedImages);
  input.provenance.unshift({
    kind: "generated",
    system: "digi-ai",
    retrievedAt: nowIso(),
    note: "Generated synthesized video. Not a human-recorded capture and not a publication.",
  });
  const recorded = lastRecorded!;
  return {
    ok: true,
    service: "digi-ai",
    answer: videoAnswer(media.length, false),
    provenance: input.provenance,
    usage: snapshotFromRecord(recorded.usage),
    execution: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      provider: lastPlan?.final?.ok ? lastPlan.final.provider : recorded.usage.provider,
      model: lastPlan?.final?.ok ? lastPlan.final.model : recorded.usage.model,
      capability: "VIDEO",
      latencyMs: recorded.usage.latencyMs,
      sourcesUsed: input.sources,
      finishState: "completed",
    },
    receiptId: recorded.receiptId,
    media,
  };
}

function failSpeech(
  input: { requestId: string; correlationId: string; capability: string; sources: string[]; provenance: ProvenanceItem[]; deps: EngineDeps },
  recorded: { usage: import("../contracts/usage.js").UsageRecord; receiptId: string },
  error: string,
  message: string,
  speech?: VoiceInteractionResult,
): DigiAiAskResponse {
  return {
    ok: false,
    service: "digi-ai",
    error,
    message,
    provenance: input.provenance,
    usage: snapshotFromRecord(recorded.usage),
    execution: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      provider: recorded.usage.provider,
      capability: input.capability,
      latencyMs: recorded.usage.latencyMs,
      sourcesUsed: input.sources,
      finishState: error === "provider_unavailable" ? "provider_unavailable" : "failed",
    },
    receiptId: recorded.receiptId,
    speech,
  };
}

async function persistAsk(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
  usageId: string;
  receiptId: string;
  requestId: string;
  attemptIndex?: number;
  correlationId: string;
  entitySlug?: string;
  capability: string;
  privacyClass: string;
  providerId: string;
  modelId?: string;
  startedAt?: string;
  latencyMs: number;
  success: boolean;
  status: "completed" | "failed" | "provider_unavailable" | "unsupported_capability" | "processing";
  errorClass?: string;
  nativeUsage?: NativeUsage;
  providerRequestId?: string;
  operation: string;
  sources: string[];
  routeExplanation?: string;
  resultStatus: "completed" | "failed" | "unauthorized" | "provider_unavailable" | "source_unavailable" | "unsupported_capability" | "processing";
  idempotencyKey?: string;
  resultSnapshot?: { answer?: string; media?: unknown; finishState?: string; canonicalAssetReference?: string; speech?: VoiceInteractionResult; providerOperationId?: string };
}) {
  const ledger = buildLedgerEntry({
    receiptId: input.receiptId,
    requestId: input.requestId,
    attemptIndex: input.attemptIndex,
    actor: input.actor,
    caller: input.caller,
    entitySlug: input.entitySlug,
    capability: input.capability,
    providerId: input.providerId,
    modelId: input.modelId,
    privacyClass: input.privacyClass,
    startedAt: input.startedAt,
    status: input.status,
    errorClass: input.errorClass,
    nativeUsage: input.nativeUsage,
    routeExplanation: input.routeExplanation,
    providerRequestId: input.providerRequestId,
  });
  const usage = buildUsageRecord({
    usageId: input.usageId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorTrustId: input.actor.trustId,
    callerId: input.caller.id,
    entitySlug: input.entitySlug,
    tenantId: ledger.tenantId,
    receiptId: input.receiptId,
    capability: input.capability,
    privacyClass: input.privacyClass,
    providerId: input.providerId,
    modelId: input.modelId,
    startedAt: input.startedAt,
    latencyMs: input.latencyMs,
    success: input.success,
    status: input.status,
    nativeUsage: input.nativeUsage,
    providerRequestId: input.providerRequestId,
    errorClass: input.errorClass,
  });
  const receipt = buildRequestReceipt({
    receiptId: input.receiptId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorTrustId: input.actor.trustId,
    callerId: input.caller.id,
    entitySlug: input.entitySlug,
    tenantId: ledger.tenantId,
    operation: input.operation,
    sourcesAccessed: input.sources,
    provider: input.providerId,
    model: input.modelId,
    capability: input.capability,
    routeExplanation: input.routeExplanation,
    resultStatus: input.resultStatus,
    usageId: input.usageId,
    idempotencyKey: input.idempotencyKey,
    resultSnapshot: input.resultSnapshot,
  });
  await persistExecution(input.deps.store, { ledger, usage, receipt });
  return { usage, ledger, receipt, receiptId: input.receiptId };
}

function resolveOperation(capability: string, requested?: MediaOperation): MediaOperation | undefined {
  if (capability === "VISION") return "analyze";
  if (capability === "IMAGE") {
    if (requested === "analyze") {
      throw new DigiAiError(400, "invalid_request", "IMAGE cannot run as VISION analysis.");
    }
    return requested === "edit" ? "edit" : "generate";
  }
  if (capability === "SPEECH_TO_TEXT") return requested === "translate" ? "translate" : "transcribe";
  if (capability === "TEXT_TO_SPEECH") return "speak";
  if (capability === "VOICE") return "converse";
  if (capability === "MUSIC") return "compose";
  if (capability === "VIDEO") {
    if (requested && requested !== "generate" && requested !== "image_to_video") {
      throw new DigiAiError(400, "invalid_request", "Unsupported VIDEO operation.");
    }
    return requested === "image_to_video" ? "image_to_video" : "generate";
  }
  return requested;
}

async function replayIdempotent(input: {
  deps: EngineDeps;
  callerId: string;
  idempotencyKey: string;
  persistCanonical: boolean;
  actorTrustId: string;
  tenantId?: string;
  accessToken?: string;
  drive: SovereignDrive;
}): Promise<DigiAiAskResponse | null> {
  const existing = await input.deps.store.findReceiptByIdempotency?.(input.callerId, input.idempotencyKey);
  if (!existing || existing.resultStatus !== "completed" || !existing.resultSnapshot) return null;
  let media = Array.isArray(existing.resultSnapshot.media)
    ? (existing.resultSnapshot.media as GeneratedMediaResult[])
    : undefined;
  if (input.persistCanonical && media?.some((row) => row.persistenceState !== "canonical")) {
    const retried = await persistHeldGeneratedMedia({
      drive: input.drive,
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      actorTrustId: input.actorTrustId,
      tenantId: input.tenantId,
      accessToken: input.accessToken,
      providerId: existing.provider,
      modelId: existing.model,
      sourceAssetIds: media.flatMap((row) => row.provenance.sourceAssetIds),
      executionRef: existing.requestId,
      capability: existing.capability,
    });
    media = media.map((row) =>
      retried.persistenceState === "canonical" && retried.canonicalAssetReference
        ? {
            ...row,
            persistenceState: "canonical",
            canonicalAssetReference: retried.canonicalAssetReference,
            contentBase64: undefined,
            transientReference: undefined,
            provenance: { ...row.provenance, canonicalAssetId: retried.canonicalAssetReference },
          }
        : row,
    );
    const snapshot = {
      ...existing.resultSnapshot,
      media: sanitizeMediaForLedger(media),
      canonicalAssetReference: retried.canonicalAssetReference,
    };
    existing.resultSnapshot = snapshot;
    await input.deps.store.updateReceiptSnapshot?.(existing.receiptId, snapshot);
  }
  const ledger = await input.deps.store.getLedgerByReceiptId(existing.receiptId);
  const usage = ledger
    ? snapshotFromRecord(usageFromLedger(ledger, { usageId: existing.usageId, callerId: input.callerId, correlationId: existing.correlationId }))
    : {
        usageId: existing.usageId ?? existing.receiptId,
        provider: existing.provider ?? "unknown",
        capability: existing.capability,
        digiAiUnits: null,
        latencyMs: 0,
        success: true,
      };
  return {
    ok: true,
    service: "digi-ai",
    answer: existing.resultSnapshot.answer || "Reused previous Digi AI result.",
    provenance: [],
    usage,
    execution: {
      requestId: existing.requestId,
      correlationId: existing.correlationId,
      provider: existing.provider ?? usage.provider,
      model: existing.model,
      capability: existing.capability,
      latencyMs: usage.latencyMs,
      sourcesUsed: existing.sourcesAccessed,
      finishState: "completed",
    },
    receiptId: existing.receiptId,
    media,
    speech: existing.resultSnapshot.speech as VoiceInteractionResult | undefined,
  };
}
