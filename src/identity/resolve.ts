import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import { FORBIDDEN_AUTH_HEADERS } from "../contracts/actor.js";
import { DigiAiError } from "../lib/http.js";
import { headerValue, secretsEqual } from "../lib/crypto.js";
import { fetchJson } from "../lib/http.js";

export type IdentityResolver = {
  resolveToken(token: string): Promise<ActorContext | null>;
};

function readToken(headers: Record<string, string | string[] | undefined>): string {
  const auth = headerValue(headers.authorization);
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headerValue(headers["x-trustid-session"]);
}

export function rejectSpoofedAuth(
  headers: Record<string, string | string[] | undefined>,
  url: string,
): void {
  for (const name of FORBIDDEN_AUTH_HEADERS) {
    if (headerValue(headers[name])) {
      throw new DigiAiError(403, "client_assertion_rejected", "Client-provided identity headers are not authentication.");
    }
  }
  if (/[?&](owner|admin)=true/i.test(url)) {
    throw new DigiAiError(403, "client_assertion_rejected", "Client-provided authorization flags are not accepted.");
  }
}

export function authenticateCaller(
  config: AppConfig,
  headers: Record<string, string | string[] | undefined>,
): CallerApplication | null {
  const id = headerValue(headers["x-digi-ai-caller"]).toLowerCase();
  const key = headerValue(headers["x-digi-ai-caller-key"]);
  if (!id && !key) return null;
  if (!id || !key) {
    throw new DigiAiError(401, "unauthenticated_caller", "Caller identity is incomplete.");
  }
  const known = config.callers.find((row) => row.id === id);
  if (!known || !secretsEqual(key, known.secret)) {
    throw new DigiAiError(401, "unauthenticated_caller", "Unknown or unauthenticated caller.");
  }
  return { id, via: "s2s" };
}

export function createTrustIdResolver(config: AppConfig): IdentityResolver {
  return {
    async resolveToken(token: string) {
      if (!token || !config.trustIdApi) return null;
      const userinfo = await fetchJson<Record<string, unknown>>(
        `${config.trustIdApi}/oauth/userinfo`,
        config.fetchTimeoutMs,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (userinfo.ok) {
        const mapped = mapTrustId(userinfo.body);
        if (mapped) return mapped;
      }
      const session = await fetchJson<Record<string, unknown>>(
        `${config.trustIdApi}/auth/session`,
        config.fetchTimeoutMs,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      );
      if (session.ok) {
        const identity = (session.body.identity ?? session.body) as Record<string, unknown>;
        return mapTrustId(identity);
      }
      return null;
    },
  };
}

function mapTrustId(raw: Record<string, unknown>): ActorContext | null {
  const trustId = String(raw.trustId ?? raw.sub ?? "").trim();
  if (!trustId) return null;
  const trustLevel = raw.trustLevel as { tier?: number } | undefined;
  return {
    trustId,
    trustTier: Number(trustLevel?.tier ?? raw.trustTier ?? 0) || undefined,
    verified: typeof raw.isVerifiedIdentity === "boolean" ? raw.isVerifiedIdentity : undefined,
    displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
    tenantId: typeof raw.tid === "string" ? raw.tid : typeof raw.tenantId === "string" ? raw.tenantId : undefined,
  };
}

export async function resolveRequestIdentity(input: {
  config: AppConfig;
  headers: Record<string, string | string[] | undefined>;
  url: string;
  attestedTrustId?: string;
  attestedDisplayName?: string;
  resolver: IdentityResolver;
}): Promise<{ caller: CallerApplication; actor: ActorContext }> {
  rejectSpoofedAuth(input.headers, input.url);
  const caller = authenticateCaller(input.config, input.headers);
  const token = readToken(input.headers);

  if (caller) {
    if (token) {
      const actor = await input.resolver.resolveToken(token);
      if (!actor) throw new DigiAiError(401, "invalid_actor", "Trust ID did not accept the forwarded actor proof.");
      return { caller, actor };
    }
    const allowAttest =
      caller.id === "test" || (input.config.allowAttestedActor && !input.config.isProd);
    if (allowAttest && input.attestedTrustId?.trim()) {
      return {
        caller,
        actor: {
          trustId: input.attestedTrustId.trim(),
          displayName: input.attestedDisplayName,
        },
      };
    }
    throw new DigiAiError(401, "invalid_actor", "Caller must forward a Trust ID actor proof.");
  }

  if (token) {
    const actor = await input.resolver.resolveToken(token);
    if (!actor) throw new DigiAiError(401, "invalid_actor", "Sign in with Trust ID to use Digi AI.");
    return { caller: { id: "digi-ai", via: "first_party" }, actor };
  }

  throw new DigiAiError(401, "unauthenticated", "Sign in with Trust ID, or call Digi AI from an authenticated application.");
}
