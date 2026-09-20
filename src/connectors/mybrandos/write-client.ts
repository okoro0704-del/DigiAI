import { DigiAiError } from "../../lib/http.js";
import { assertSafeRedirect, isPrivateInfrastructureHost } from "../network.js";
import { signDraftSubject, type DraftSubjectAttestation } from "./subject.js";
import type { MybrandosClientConfig } from "./client.js";
import type { MybrandosReadFailureCode } from "./types.js";

export type MybrandosDraftEvidence = {
  draftId: string;
  state: "DRAFT";
  visibility: "private";
  ownerRef: string;
  createdAt: string;
  idempotencyKeyRef: string;
  contentDigest: string;
  source: "mybrandos";
  published: false;
  scheduled: false;
  distributed: false;
};

export type MybrandosWriteResult =
  | { ok: true; status: number; body: MybrandosDraftEvidence; attempts: 1; submitted: true }
  | { ok: false; status: number; code: MybrandosReadFailureCode; attempts: 1; submitted: boolean };

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

function mapStatus(status: number): MybrandosReadFailureCode {
  if (status === 404) return "MYBRANDOS_NOT_FOUND";
  if (status === 401) return "MYBRANDOS_AUTH_FAILED";
  if (status === 403) return "MYBRANDOS_ACCESS_DENIED";
  if (status === 409) return "IDEMPOTENCY_CONFLICT";
  if (status === 400) return "INVALID_DRAFT_INPUT";
  if (status === 429) return "MYBRANDOS_RATE_LIMITED";
  if (status === 0) return "MYBRANDOS_UNAVAILABLE";
  return "MYBRANDOS_UNAVAILABLE";
}

function parseEvidence(raw: Record<string, unknown>, ownerId: string): MybrandosDraftEvidence {
  if (typeof raw.draftId !== "string" || !raw.draftId) {
    throw new DigiAiError(502, "MALFORMED_RESPONSE", "mybrandOS draft id is missing.");
  }
  if (raw.state !== "DRAFT" || raw.visibility !== "private" || raw.published === true || raw.source !== "mybrandos") {
    throw new DigiAiError(502, "MALFORMED_RESPONSE", "mybrandOS did not return a private draft.");
  }
  if (typeof raw.ownerRef === "string" && raw.ownerRef !== ownerId) {
    throw new DigiAiError(502, "MALFORMED_RESPONSE", "mybrandOS returned a different owner.");
  }
  return {
    draftId: raw.draftId,
    state: "DRAFT",
    visibility: "private",
    ownerRef: ownerId,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    idempotencyKeyRef: typeof raw.idempotencyKeyRef === "string" ? raw.idempotencyKeyRef : "",
    contentDigest: typeof raw.contentDigest === "string" ? raw.contentDigest : "",
    source: "mybrandos",
    published: false,
    scheduled: false,
    distributed: false,
  };
}

async function requestJson(input: {
  url: string;
  registered: string;
  timeoutMs: number;
  serviceSecret: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ status: number; body?: Record<string, unknown>; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch(input.url, {
      method: input.method,
      signal: controller.signal,
      redirect: "manual",
      headers: {
        accept: "application/json",
        "user-agent": "DigiAI/0.1",
        authorization: `Bearer ${input.serviceSecret}`,
        ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
        ...input.headers,
      },
      body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const dest = new URL(location, input.url);
      assertSafeRedirect(input.registered, dest.host);
      throw new DigiAiError(403, "NETWORK_DESTINATION_DENIED", "Authenticated mybrandOS redirects must stay on the registered host.");
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return { status: res.status, error: "non_json" };
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof DigiAiError) throw err;
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: 0, error: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export function attestDraftSubject(input: {
  secret: string;
  ownerId: string;
  idempotencyKey: string;
  payloadDigest: string;
  ttlMs?: number;
}): DraftSubjectAttestation {
  return signDraftSubject(input.secret, {
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
    payloadDigest: input.payloadDigest,
    exp: Date.now() + (input.ttlMs ?? 120_000),
  });
}

export async function requestMybrandosCreateDraft(input: {
  config: MybrandosClientConfig;
  serviceSecret: string;
  ownerId: string;
  title: string;
  description?: string;
  idempotencyKey: string;
  payloadDigest: string;
}): Promise<MybrandosWriteResult> {
  if (!input.serviceSecret) return { ok: false, status: 401, code: "MYBRANDOS_AUTH_FAILED", attempts: 1, submitted: false };
  const host = registeredHost(input.config.baseUrl);
  const subjectContext = attestDraftSubject({
    secret: input.serviceSecret,
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
    payloadDigest: input.payloadDigest,
  });
  const last = await requestJson({
    url: `${input.config.baseUrl.replace(/\/$/, "")}/api/internal/drafts`,
    registered: host,
    timeoutMs: input.config.timeoutMs,
    serviceSecret: input.serviceSecret,
    method: "POST",
    headers: { "idempotency-key": input.idempotencyKey },
    body: {
      subjectContext,
      draftInput: { title: input.title, description: input.description ?? "" },
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (last.error === "timeout") return { ok: false, status: 0, code: "MYBRANDOS_TIMEOUT", attempts: 1, submitted: true };
  if (last.error === "unreachable") return { ok: false, status: 0, code: "MYBRANDOS_UNAVAILABLE", attempts: 1, submitted: false };
  if ((last.status === 200 || last.status === 201) && last.body) {
    try {
      return { ok: true, status: last.status, body: parseEvidence(last.body, input.ownerId), attempts: 1, submitted: true };
    } catch {
      return { ok: false, status: 502, code: "MYBRANDOS_MALFORMED_RESPONSE", attempts: 1, submitted: true };
    }
  }
  if (last.error === "non_json") return { ok: false, status: last.status || 502, code: "MYBRANDOS_MALFORMED_RESPONSE", attempts: 1, submitted: last.status >= 200 };
  return { ok: false, status: last.status, code: mapStatus(last.status), attempts: 1, submitted: last.status >= 500 };
}

export async function reconcileMybrandosDraft(input: {
  config: MybrandosClientConfig;
  serviceSecret: string;
  ownerId: string;
  idempotencyKey: string;
  payloadDigest: string;
}): Promise<MybrandosWriteResult> {
  if (!input.serviceSecret) return { ok: false, status: 401, code: "MYBRANDOS_AUTH_FAILED", attempts: 1, submitted: false };
  const host = registeredHost(input.config.baseUrl);
  const subjectContext = attestDraftSubject({
    secret: input.serviceSecret,
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
    payloadDigest: input.payloadDigest,
  });
  const last = await requestJson({
    url: `${input.config.baseUrl.replace(/\/$/, "")}/api/internal/drafts/${encodeURIComponent(input.idempotencyKey)}`,
    registered: host,
    timeoutMs: input.config.timeoutMs,
    serviceSecret: input.serviceSecret,
    method: "GET",
    headers: { "x-digi-ai-subject-context": JSON.stringify(subjectContext) },
  });
  if (last.error === "timeout" || last.error === "unreachable") {
    return { ok: false, status: 0, code: last.error === "timeout" ? "MYBRANDOS_TIMEOUT" : "MYBRANDOS_UNAVAILABLE", attempts: 1, submitted: false };
  }
  if (last.status === 200 && last.body) {
    try {
      return { ok: true, status: 200, body: parseEvidence(last.body, input.ownerId), attempts: 1, submitted: true };
    } catch {
      return { ok: false, status: 502, code: "MYBRANDOS_MALFORMED_RESPONSE", attempts: 1, submitted: false };
    }
  }
  if (last.status === 404) return { ok: false, status: 404, code: "MYBRANDOS_NOT_FOUND", attempts: 1, submitted: false };
  return { ok: false, status: last.status, code: mapStatus(last.status), attempts: 1, submitted: false };
}

export const mybrandosWriteRetryPolicy = {
  maxAttempts: 1,
  blindWriteRetry: false,
  reconcileInstead: true,
};
