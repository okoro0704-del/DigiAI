import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication, EntityContext } from "../contracts/actor.js";
import { defaultPrivacyClass, isPrivacyClass } from "../contracts/privacy.js";
import type { DigiAiAskInput } from "../contracts/request.js";
import type { DigiAiAskResponse } from "../contracts/response.js";
import type { ProvenanceItem } from "../contracts/provenance.js";
import type { GeneratedMediaResult, ImageOperation } from "../contracts/media.js";
import { sanitizeMediaForLedger } from "../contracts/media.js";
import type { NativeUsage } from "../contracts/usage.js";
import type { DigiNewsReader, DigiPediaReader, NewsPage, DigiPediaPage } from "../adapters/types.js";
import { clip, newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import { requireSlug } from "../lib/slug.js";
import { SYSTEM_POLICY, wrapCanonicalData } from "../lib/policy.js";
import { UnboundDrive, type SovereignDrive } from "../media/drive.js";
import { peekJwtTenant } from "../media/jwt.js";
import { assertImageInputLimits, mapSizeClass, parseImageConstraints } from "../media/limits.js";
import { normalizeGeneratedMedia, persistHeldGeneratedMedia } from "../media/normalize.js";
import { clearResolvedImages, imageDataBlock, resolveImageInputs } from "../media/resolve.js";
import { ProviderPool } from "../providers/pool.js";
import type { IntelligenceProvider } from "../providers/types.js";
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
  const operation = resolveOperation(capability, body.operation);
  const images = body.images ?? [];
  if (images.length) assertImageInputLimits(images, deps.config);
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
  const allowFailover = capability !== "IMAGE" && body.constraints?.allowFailover !== false && deps.config.allowFailover;
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

  const privacyRoute = routeCapability({
    config: deps.config,
    pool,
    capability,
    privacyClass,
    forceProvider,
  });
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
  status: "completed" | "failed" | "provider_unavailable" | "unsupported_capability";
  errorClass?: string;
  nativeUsage?: NativeUsage;
  providerRequestId?: string;
  operation: string;
  sources: string[];
  routeExplanation?: string;
  resultStatus: "completed" | "failed" | "unauthorized" | "provider_unavailable" | "source_unavailable" | "unsupported_capability";
  idempotencyKey?: string;
  resultSnapshot?: { answer?: string; media?: unknown; finishState?: string; canonicalAssetReference?: string };
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

function resolveOperation(capability: string, requested?: ImageOperation): ImageOperation | undefined {
  if (capability === "VISION") return "analyze";
  if (capability === "IMAGE") {
    if (requested === "analyze") {
      throw new DigiAiError(400, "invalid_request", "IMAGE cannot run as VISION analysis.");
    }
    return requested === "edit" ? "edit" : "generate";
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
  };
}
