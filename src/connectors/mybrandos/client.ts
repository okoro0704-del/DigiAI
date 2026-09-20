import { nowIso } from "../../lib/crypto.js";
import { DigiAiError } from "../../lib/http.js";
import { requireSlug } from "../../lib/slug.js";
import { assertSafeRedirect, isPrivateInfrastructureHost } from "../network.js";
import type { MybrandosPublicAssetRef, MybrandosPublicDigitalLife, MybrandosReadFailureCode } from "./types.js";

export type MybrandosClientConfig = {
  baseUrl: string;
  timeoutMs: number;
  environment: "STAGING" | "PRODUCTION";
};

export type MybrandosClientResult =
  | { ok: true; status: number; body: MybrandosPublicDigitalLife; attempts: number }
  | { ok: false; status: number; code: MybrandosReadFailureCode; attempts: number };

const MAX_RECENT = 8;
const MAX_ATTEMPTS = 2;

function registeredHost(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new DigiAiError(409, "MYBRANDOS_UNAVAILABLE", "mybrandOS base URL is not configured.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "mybrandOS connector host must use https.");
  }
  if (isPrivateInfrastructureHost(parsed.hostname) && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "mybrandOS connector host is not allowed.");
  }
  return parsed.host;
}

function internalPath(baseUrl: string, slug: string, suffix = ""): string {
  const root = baseUrl.replace(/\/$/, "");
  return `${root}/api/internal/digital-life/${slug}${suffix}`;
}

function fail(status: number, code: MybrandosReadFailureCode, attempts: number): MybrandosClientResult {
  return { ok: false, status, code, attempts };
}

function mapStatus(status: number): MybrandosReadFailureCode {
  if (status === 404) return "MYBRANDOS_NOT_FOUND";
  if (status === 401) return "MYBRANDOS_AUTH_FAILED";
  if (status === 403) return "MYBRANDOS_ACCESS_DENIED";
  if (status === 429) return "MYBRANDOS_RATE_LIMITED";
  if (status === 0) return "MYBRANDOS_UNAVAILABLE";
  return "MYBRANDOS_UNAVAILABLE";
}

function retryableTransport(status: number, error?: string): boolean {
  if (status === 401 || status === 403) return false;
  return error === "timeout" || error === "unreachable";
}

function minimizeExperience(raw: Record<string, unknown>, slug: string): MybrandosPublicDigitalLife {
  const identity = raw.identity && typeof raw.identity === "object" ? (raw.identity as Record<string, unknown>) : {};
  const assets = Array.isArray(raw.publishedAssets)
    ? raw.publishedAssets
    : Array.isArray(raw.recentPublished)
      ? raw.recentPublished
      : [];
  const recentPublished: MybrandosPublicAssetRef[] = [];
  for (const row of assets.slice(0, MAX_RECENT)) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) throw new DigiAiError(502, "MALFORMED_RESPONSE", "mybrandOS asset is missing a public id.");
    recentPublished.push({
      id: item.id,
      assetType: typeof item.assetType === "string" ? item.assetType : "UNKNOWN",
      publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : "",
    });
  }
  if (typeof raw.slug === "string" && raw.slug && raw.slug !== slug) {
    throw new DigiAiError(502, "MALFORMED_RESPONSE", "mybrandOS returned a different public slug.");
  }
  const count = typeof raw.publishedAssetCount === "number" ? raw.publishedAssetCount : assets.length;
  return {
    slug,
    publicEnabled: raw.publicEnabled !== false,
    displayName: typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : typeof identity.displayName === "string" && identity.displayName.trim()
        ? identity.displayName.trim()
        : slug,
    publishedAssetCount: count,
    recentPublished,
    retrievedAt: nowIso(),
    privacyClass: "PUBLIC",
    source: "mybrandos",
    factKind: "SOURCE_FACT",
  };
}

function minimizeAssetList(raw: Record<string, unknown>, slug: string): MybrandosPublicDigitalLife {
  const assets = Array.isArray(raw.assets) ? raw.assets : Array.isArray(raw.recentPublished) ? raw.recentPublished : [];
  return minimizeExperience({
    slug,
    publicEnabled: true,
    displayName: typeof raw.displayName === "string" ? raw.displayName : slug,
    publishedAssetCount: typeof raw.publishedAssetCount === "number" ? raw.publishedAssetCount : assets.length,
    recentPublished: assets,
  }, slug);
}

async function getJson(input: {
  url: string;
  registered: string;
  timeoutMs: number;
  serviceSecret: string;
}): Promise<{ status: number; body?: Record<string, unknown>; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch(input.url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: {
        accept: "application/json",
        "user-agent": "DigiAI/0.1",
        authorization: `Bearer ${input.serviceSecret}`,
      },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const dest = new URL(location, input.url);
      assertSafeRedirect(input.registered, dest.host);
      throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "Authenticated mybrandOS redirects must stay on the registered host.");
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) {
      return { status: res.status, error: "non_json" };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof DigiAiError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: 0, error: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export async function requestMybrandosAuthenticated(input: {
  config: MybrandosClientConfig;
  slug: string;
  operation: "inspectPublicDigitalLife" | "listPublishedAssets";
  serviceSecret: string;
}): Promise<MybrandosClientResult> {
  if (!input.serviceSecret) {
    return fail(401, "MYBRANDOS_AUTH_FAILED", 0);
  }
  const slug = requireSlug(input.slug, "mybrandOS");
  const host = registeredHost(input.config.baseUrl);
  const path = input.operation === "listPublishedAssets"
    ? internalPath(input.config.baseUrl, slug, "/assets")
    : internalPath(input.config.baseUrl, slug);
  let attempts = 0;
  let last: { status: number; body?: Record<string, unknown>; error?: string } = { status: 0, error: "unreachable" };
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    last = await getJson({
      url: path,
      registered: host,
      timeoutMs: input.config.timeoutMs,
      serviceSecret: input.serviceSecret,
    });
    if (retryableTransport(last.status, last.error)) {
      if (attempts < MAX_ATTEMPTS) continue;
      return fail(0, last.error === "timeout" ? "MYBRANDOS_TIMEOUT" : "MYBRANDOS_UNAVAILABLE", attempts);
    }
    break;
  }
  if (last.status === 200 && last.body) {
    try {
      const body = input.operation === "listPublishedAssets" ? minimizeAssetList(last.body, slug) : minimizeExperience(last.body, slug);
      if (!body.publicEnabled && input.operation === "inspectPublicDigitalLife") {
        return fail(404, "MYBRANDOS_NOT_FOUND", attempts);
      }
      return { ok: true, status: 200, body, attempts };
    } catch (err) {
      if (err instanceof DigiAiError && err.code === "MALFORMED_RESPONSE") return fail(502, "MYBRANDOS_MALFORMED_RESPONSE", attempts);
      throw err;
    }
  }
  if (last.error === "non_json") return fail(last.status || 502, "MYBRANDOS_MALFORMED_RESPONSE", attempts);
  return fail(last.status, mapStatus(last.status), attempts);
}

/** @deprecated Use requestMybrandosAuthenticated. Public fallback is forbidden for governed S2S reads. */
export async function requestMybrandosPublic(): Promise<MybrandosClientResult> {
  return fail(401, "MYBRANDOS_AUTH_FAILED", 0);
}

export const mybrandosReadRetryPolicy = {
  maxAttempts: MAX_ATTEMPTS,
  retryOn: ["timeout", "unreachable"],
  neverRetry: [401, 403, "invalid-credential", "scope-denied"],
  methods: ["GET"],
};
