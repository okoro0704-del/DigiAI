import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication, EntityContext } from "../contracts/actor.js";
import { defaultPrivacyClass, isPrivacyClass } from "../contracts/privacy.js";
import type { DigiAiAskInput } from "../contracts/request.js";
import type { DigiAiAskResponse } from "../contracts/response.js";
import type { ProvenanceItem } from "../contracts/provenance.js";
import type { NativeUsage } from "../contracts/usage.js";
import type { DigiNewsReader, DigiPediaReader, NewsPage, DigiPediaPage } from "../adapters/types.js";
import { clip, newId, nowIso } from "../lib/crypto.js";
import { DigiAiError } from "../lib/http.js";
import { requireSlug } from "../lib/slug.js";
import { SYSTEM_POLICY, wrapCanonicalData } from "../lib/policy.js";
import type { IntelligenceProvider } from "../providers/types.js";
import { resolveRequestedCapability } from "../routing/resolve-capability.js";
import { routeCapability } from "../routing/runtime.js";
import { buildLedgerEntry } from "../usage/ledger.js";
import { persistExecution } from "../usage/persist.js";
import { buildRequestReceipt, buildUsageRecord, nativeUsageFromTokens, snapshotFromRecord } from "../usage/receipt.js";
import type { DigiAiStore } from "../store/types.js";
import { proposeObjective } from "./objectives.js";
import { selectSources } from "./sources.js";

export type EngineDeps = {
  config: AppConfig;
  provider: IntelligenceProvider;
  digipedia: DigiPediaReader;
  diginews: DigiNewsReader;
  store: DigiAiStore;
};

export async function handleAsk(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
  body: DigiAiAskInput;
  requestId: string;
}): Promise<DigiAiAskResponse> {
  const { deps, actor, caller, body, requestId } = input;
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
  userParts.push(`RESPONSE MODE: ${mode}`);
  userParts.push(`CAPABILITY: ${capability}`);
  userParts.push("If canonical data is present, ground generated text in it and say when you are interpreting.");

  const usageId = newId("use");
  const receiptId = newId("rcpt");
  const startedAt = nowIso();
  const routed = routeCapability({
    config: deps.config,
    provider: deps.provider,
    capability,
    privacyClass,
  });

  if (!routed.decision.ok) {
    const error = routed.decision.error === "unsupported_capability" ? "unsupported_capability" : "provider_unavailable";
    const recorded = await persistAsk({
      deps,
      actor,
      caller,
      usageId,
      receiptId,
      requestId,
      correlationId,
      entitySlug: entity.slug,
      capability,
      privacyClass,
      providerId: deps.provider.name,
      startedAt,
      latencyMs: 0,
      success: false,
      status: error,
      errorClass: routed.decision.error,
      operation: mode,
      sources,
      routeExplanation: routed.decision.explanation,
      resultStatus: sourceUnavailable ? "source_unavailable" : error,
    });
    return {
      ok: false,
      service: "digi-ai",
      error,
      message: routed.decision.detail,
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

  const providerResult = await deps.provider.invoke({
    model: routed.decision.selected.modelId,
    messages: [
      { role: "system", content: SYSTEM_POLICY },
      { role: "user", content: userParts.join("\n\n") },
    ],
  });

  const nativeUsage = providerResult.ok ? nativeUsageFromTokens(providerResult.usage) : undefined;
  const status = providerResult.ok
    ? "completed"
    : providerResult.error === "unavailable"
      ? "provider_unavailable"
      : "failed";
  const recorded = await persistAsk({
    deps,
    actor,
    caller,
    usageId,
    receiptId,
    requestId,
    correlationId,
    entitySlug: entity.slug,
    capability,
    privacyClass,
    providerId: providerResult.provider,
    modelId: providerResult.ok ? providerResult.model : routed.decision.selected.modelId,
    startedAt,
    latencyMs: providerResult.latencyMs,
    success: providerResult.ok,
    status,
    nativeUsage,
    providerRequestId: providerResult.ok ? providerResult.providerRequestId : undefined,
    errorClass: providerResult.ok ? undefined : providerResult.error,
    operation: mode,
    sources,
    routeExplanation: routed.decision.explanation,
    resultStatus: sourceUnavailable ? "source_unavailable" : status,
  });

  if (!providerResult.ok) {
    return {
      ok: false,
      service: "digi-ai",
      error: status,
      message: providerResult.detail,
      provenance,
      usage: snapshotFromRecord(recorded.usage),
      execution: {
        requestId,
        correlationId,
        provider: providerResult.provider,
        model: routed.decision.selected.modelId,
        capability,
        latencyMs: providerResult.latencyMs,
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
    note: "Generated by Digi AI from the selected context. Not a canonical record.",
  });

  const objectiveCandidate = proposeObjective(message, body.draft?.actionType);

  return {
    ok: true,
    service: "digi-ai",
    answer: providerResult.text,
    provenance,
    usage: snapshotFromRecord(recorded.usage),
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
}) {
  const ledger = buildLedgerEntry({
    receiptId: input.receiptId,
    requestId: input.requestId,
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
  });
  await persistExecution(input.deps.store, { ledger, usage, receipt });
  return { usage, ledger, receipt };
}
