import { createHash, randomBytes } from "node:crypto";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { ConnectionEnvironment, OAuthStateRecord } from "../contracts/connections.js";
import { DigiAiError } from "../lib/http.js";
import { newId, nowIso, sha256 } from "../lib/crypto.js";
import type { DigiAiStore } from "../store/types.js";

const STATE_TTL_MS = 10 * 60 * 1000;

export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" as const };
}

export function verifyPkce(verifier: string, challenge: string) {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

export function assertAllowlistedRedirect(redirectUri: string, allowlist: string[]) {
  if (!redirectUri.trim()) throw new DigiAiError(400, "REDIRECT_DENIED", "A registered redirect URI is required.");
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new DigiAiError(400, "REDIRECT_DENIED", "Redirect URI is invalid.");
  }
  const exact = allowlist.some((allowed) => allowed === redirectUri);
  const host = allowlist.some((allowed) => {
    try {
      const row = new URL(allowed);
      return row.origin === parsed.origin && parsed.pathname.startsWith(row.pathname);
    } catch {
      return allowed === parsed.host;
    }
  });
  if (!exact && !host) throw new DigiAiError(403, "REDIRECT_DENIED", "Redirect URI is not registered.");
}

export async function initiateOAuth(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  system: string;
  environment: ConnectionEnvironment;
  redirectUri: string;
  allowlist: string[];
  scopes: string[];
  requirePkce?: boolean;
}): Promise<{ state: string; nonce: string; codeChallenge?: string; codeVerifier?: string; redirectUri: string; expiresAt: string }> {
  assertAllowlistedRedirect(input.redirectUri, input.allowlist);
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(16).toString("hex");
  const pkce = input.requirePkce === false ? undefined : createPkcePair();
  const now = Date.now();
  const record: OAuthStateRecord = {
    stateId: newId("oast"),
    stateHash: sha256(state),
    nonce,
    actorId: input.actor.trustId,
    tenantId: input.actor.tenantId,
    applicationId: input.caller.id,
    system: input.system,
    environment: input.environment,
    redirectUri: input.redirectUri,
    codeChallenge: pkce?.challenge,
    codeChallengeMethod: pkce?.method,
    scopes: [...input.scopes],
    expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
    createdAt: nowIso(),
  };
  await input.store.putOAuthState(record);
  return { state, nonce, codeChallenge: pkce?.challenge, codeVerifier: pkce?.verifier, redirectUri: input.redirectUri, expiresAt: record.expiresAt };
}

export async function validateOAuthCallback(input: {
  store: DigiAiStore;
  actor: ActorContext;
  caller: CallerApplication;
  state: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<OAuthStateRecord> {
  const hash = sha256(input.state);
  const record = await input.store.getOAuthState(hash);
  if (!record || record.consumedAt) throw new DigiAiError(403, "OAUTH_STATE_INVALID", "OAuth state is unknown, expired, or already used.");
  if (record.expiresAt <= nowIso()) throw new DigiAiError(403, "OAUTH_STATE_INVALID", "OAuth state has expired.");
  if (record.actorId !== input.actor.trustId || record.applicationId !== input.caller.id) {
    throw new DigiAiError(403, "OAUTH_STATE_INVALID", "OAuth state is bound to a different identity.");
  }
  if (record.tenantId && input.actor.tenantId && record.tenantId !== input.actor.tenantId) {
    throw new DigiAiError(403, "OAUTH_STATE_INVALID", "OAuth state is bound to a different tenant.");
  }
  if (record.redirectUri !== input.redirectUri) {
    throw new DigiAiError(403, "REDIRECT_DENIED", "OAuth redirect URI does not match the initiated request.");
  }
  if (record.codeChallenge) {
    if (!input.codeVerifier || !verifyPkce(input.codeVerifier, record.codeChallenge)) {
      throw new DigiAiError(403, "OAUTH_PKCE_INVALID", "PKCE verifier does not match the initiated challenge.");
    }
  }
  const consumed = await input.store.consumeOAuthState(hash);
  if (!consumed) throw new DigiAiError(403, "OAUTH_STATE_INVALID", "OAuth state is unknown, expired, or already used.");
  return consumed;
}
