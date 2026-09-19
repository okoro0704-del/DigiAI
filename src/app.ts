import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { isCapabilityId } from "./contracts/capabilities.js";
import { isPrivacyClass } from "./contracts/privacy.js";
import { CONTEXT_SOURCES, isContextSourceId, isDigiAiMode, type AskConstraints, type DigiAiAskInput } from "./contracts/request.js";
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
import { createProvider } from "./providers/router.js";
import type { IntelligenceProvider } from "./providers/types.js";
import { createStore, type DigiAiStore } from "./store/memory.js";
import { renderDigiAiPage } from "./ui/page.js";

export type DigiAiAppOptions = {
  provider?: IntelligenceProvider;
  resolver?: IdentityResolver;
  digipedia?: DigiPediaReader;
  diginews?: DigiNewsReader;
  store?: DigiAiStore;
};

function rejectClientRouteOverride(body: Record<string, unknown>) {
  if ("provider" in body || "model" in body || "providerId" in body || "modelId" in body) {
    throw new DigiAiError(400, "invalid_request", "Provider and model selection is reserved to Digi AI.");
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
    actor,
  };
}

function parseConstraints(raw: unknown): AskConstraints | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  if (body.privacyClass !== undefined && !isPrivacyClass(body.privacyClass)) {
    throw new DigiAiError(400, "invalid_request", "Unknown privacy class.");
  }
  return {
    structuredOutput: body.structuredOutput === true,
    privacyClass: isPrivacyClass(body.privacyClass) ? body.privacyClass : undefined,
    maxLatency: typeof body.maxLatency === "string" ? body.maxLatency : undefined,
  };
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
  const provider = createProvider(config, options.provider);
  const store = options.store ?? createStore(config.dataDir);
  const deps = {
    config,
    provider,
    digipedia: options.digipedia ?? new HttpDigiPediaReader(config),
    diginews: options.diginews ?? new HttpDigiNewsReader(config),
    store,
  };
  const resolver = options.resolver ?? createTrustIdResolver(config);

  app.get("/health", async (): Promise<HealthResponse> => buildHealthResponse(config, provider));

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

  const rejectWrite = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).send({ ok: false, service: "digi-ai", error: "method_not_allowed", message: "Not allowed." });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    app.route({ method, url: "/", handler: rejectWrite });
  }

  return Object.assign(app, { store, provider });
}
