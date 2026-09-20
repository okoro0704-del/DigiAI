import { createHash, createHmac } from "node:crypto";
import type { ActorContext, CallerApplication } from "../../contracts/actor.js";
import { DigiAiError } from "../../lib/http.js";

export type DraftSubjectSource = "OPERATOR_BOUND_OWNER" | "TRUST_ID_SESSION";

export type DraftSubject = {
  ownerId: string;
  source: DraftSubjectSource;
};

export type DraftSubjectAttestation = {
  ownerId: string;
  exp: number;
  idempotencyKey: string;
  payloadDigest: string;
  mac: string;
};

const OWNER_RE = /^TD-[A-Z0-9-]+$/;

export function acceptanceOwnerId(): string {
  return (process.env.MYBRANDOS_ACCEPTANCE_OWNER_ID ?? "").trim();
}

export function draftOwnerAllowlist(): string[] {
  const configured = (process.env.MYBRANDOS_DRAFT_OWNER_ALLOWLIST ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const acceptance = acceptanceOwnerId();
  return acceptance && !configured.includes(acceptance) ? [...configured, acceptance] : configured;
}

export function operatorCallerIds(): string[] {
  return (process.env.DIGI_AI_OPERATOR_CALLERS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function draftPayloadDigest(title: string, description = ""): string {
  return createHash("sha256")
    .update(JSON.stringify({ title, description, assetType: "WRITING" }))
    .digest("hex");
}

export function signDraftSubject(secret: string, input: Omit<DraftSubjectAttestation, "mac">): DraftSubjectAttestation {
  const material = `v1|digi-ai|createDraft|${input.ownerId}|${input.idempotencyKey}|${input.exp}|${input.payloadDigest}`;
  return {
    ...input,
    mac: createHmac("sha256", secret).update(material).digest("hex"),
  };
}

export function resolveGovernedDraftSubject(input: {
  actor: ActorContext;
  caller: CallerApplication;
  requestedOwnerId?: string;
}): DraftSubject {
  const requested = input.requestedOwnerId?.trim() ?? "";
  if (requested && (requested.toLowerCase() === "mrfundzman" || !OWNER_RE.test(requested))) {
    throw new DigiAiError(403, "SUBJECT_MISMATCH", "A public slug cannot establish draft ownership.");
  }
  const operator = input.caller.via === "s2s" && operatorCallerIds().includes(input.caller.id);
  const acceptance = acceptanceOwnerId();
  if (operator && acceptance && OWNER_RE.test(acceptance)) {
    if (requested && requested !== acceptance) {
      throw new DigiAiError(403, "SUBJECT_MISMATCH", "Request-body owner cannot select the draft owner.");
    }
    return { ownerId: acceptance, source: "OPERATOR_BOUND_OWNER" };
  }
  const trustId = input.actor.trustId.trim();
  if (OWNER_RE.test(trustId) && draftOwnerAllowlist().includes(trustId) && !trustId.startsWith("TD-SVC")) {
    if (requested && requested !== trustId) {
      throw new DigiAiError(403, "SUBJECT_MISMATCH", "Request-body owner cannot select the draft owner.");
    }
    return { ownerId: trustId, source: "TRUST_ID_SESSION" };
  }
  throw new DigiAiError(403, "SUBJECT_AUTHORITY_REQUIRED", "Real subject authority is not established.");
}
