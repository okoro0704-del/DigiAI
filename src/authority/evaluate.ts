import type {
  ActionClass,
  AuthorityDecision,
  DigiAiActionIntent,
  DigiAiAuthorityGrant,
  DigiAiHumanDecision,
} from "../contracts/authority.js";
import { AUTHORITY_POLICY_ID, AUTHORITY_POLICY_VERSION } from "../contracts/authority.js";
import { isAutomaticClass, loadAuthorityPolicy, strongestClass } from "./policy.js";

export function evaluateAuthority(input: {
  intent: DigiAiActionIntent;
  grants: DigiAiAuthorityGrant[];
  decisions: DigiAiHumanDecision[];
  now?: string;
}): AuthorityDecision {
  const policy = loadAuthorityPolicy();
  const now = input.now ?? new Date().toISOString();
  const classes = [input.intent.actionClass, ...(input.intent.additionalClasses ?? [])];
  const strongest = strongestClass(classes);
  const base = {
    policyId: policy.policyId,
    policyVersion: policy.version,
    strongestClass: strongest,
  };

  if (!input.intent.actorId || !input.intent.actionType || !input.intent.target?.resourceType || !input.intent.target.resourceId) {
    return { ...base, outcome: "INVALID", reasonCode: "MALFORMED_GRANT", explanation: "Action intent is missing required identity or target fields." };
  }

  const denial = input.decisions.find(
    (row) => row.actionIntentId === input.intent.actionIntentId && row.decision === "DENY" && row.actionDigest === input.intent.parametersDigest,
  );
  if (denial) {
    return { ...base, outcome: "DENIED", reasonCode: "AUTHORITY_UNPROVEN", decisionId: denial.decisionId, explanation: "The legitimate authority denied this exact action." };
  }

  const approval = matchingApproval(input.intent, input.decisions, now);
  if (approval === "digest_changed") {
    return { ...base, outcome: "DENIED", reasonCode: "ACTION_DIGEST_CHANGED", explanation: "A previous approval does not cover the current action digest." };
  }
  if (approval) {
    return {
      ...base,
      outcome: "AUTHORIZED_BY_GRANT",
      reasonCode: "HUMAN_APPROVED_EXACT_ACTION",
      decisionId: approval.decisionId,
      explanation: "A legitimate human decision approved this exact action digest.",
    };
  }

  if (isAutomaticClass(strongest) && classes.every((row) => isAutomaticClass(row))) {
    return { ...base, outcome: "AUTHORIZED_AUTOMATICALLY", reasonCode: "AUTO_CLASS_ALLOWED", explanation: `${strongest} may execute automatically when access is already authorized.` };
  }

  const grantResult = matchingGrant(input.intent, input.grants, now);
  if (grantResult.kind === "authorized") {
    return {
      ...base,
      outcome: "AUTHORIZED_BY_GRANT",
      reasonCode: grantResult.grant.objectiveConstraint ? "VALID_OBJECTIVE_GRANT" : "VALID_BOUNDED_GRANT",
      grantId: grantResult.grant.grantId,
      explanation: "A bounded authority grant covers this action.",
    };
  }
  if (grantResult.kind === "expired") {
    return { ...base, outcome: "EXPIRED", reasonCode: "GRANT_EXPIRED", grantId: grantResult.grant.grantId, explanation: "The covering grant has expired." };
  }
  if (grantResult.kind === "revoked") {
    return { ...base, outcome: "REVOKED", reasonCode: "GRANT_REVOKED", grantId: grantResult.grant.grantId, explanation: "The covering grant has been revoked." };
  }
  if (grantResult.kind === "mismatch") {
    return { ...base, outcome: grantResult.outcome, reasonCode: grantResult.reason, grantId: grantResult.grant?.grantId, explanation: grantResult.explanation };
  }

  return {
    ...base,
    outcome: "HUMAN_DECISION_REQUIRED",
    reasonCode: "ACTION_REQUIRES_HUMAN",
    explanation: `${strongest} is a consequential action and no proven authority exists.`,
  };
}

function matchingApproval(intent: DigiAiActionIntent, decisions: DigiAiHumanDecision[], now: string) {
  const related = decisions.filter((row) => row.actionIntentId === intent.actionIntentId && row.decision === "APPROVE");
  const exact = related.find((row) => row.actionDigest === intent.parametersDigest && (!row.expiresAt || row.expiresAt > now));
  if (exact) return exact;
  if (related.length) return "digest_changed" as const;
  return undefined;
}

function matchingGrant(intent: DigiAiActionIntent, grants: DigiAiAuthorityGrant[], now: string) {
  let closest: { kind: "expired" | "revoked"; grant: DigiAiAuthorityGrant } | { kind: "mismatch"; outcome: AuthorityDecision["outcome"]; reason: AuthorityDecision["reasonCode"]; explanation: string; grant?: DigiAiAuthorityGrant } | undefined;
  for (const grant of grants) {
    if (grant.delegate !== "digi-ai") continue;
    if (grant.scope.actorId && grant.scope.actorId !== intent.actorId) continue;
    if (grant.grantorActorId !== intent.actorId && grant.scope.actorId !== intent.actorId) continue;
    if (grant.tenantId && intent.tenantId && grant.tenantId !== intent.tenantId) continue;
    if (grant.applicationConstraint && grant.applicationConstraint !== intent.applicationId) continue;
    if (grant.objectiveConstraint && grant.objectiveConstraint !== intent.objectiveId) continue;
    if (grant.allowedActionClasses.length && !grant.allowedActionClasses.includes(intent.actionClass) && !grant.allowedActionClasses.includes(strongestClass([intent.actionClass, ...(intent.additionalClasses ?? [])]))) {
      continue;
    }
    if (grant.allowedActionTypes?.length && !grant.allowedActionTypes.includes(intent.actionType)) continue;
    const resource = grant.resourceConstraints ?? { resourceType: grant.scope.resourceType, resourceId: grant.scope.resourceId };
    if (resource.resourceType && resource.resourceType !== intent.target.resourceType) continue;
    if (resource.resourceId && resource.resourceId !== intent.target.resourceId) continue;
    if (grant.limits.environment && grant.limits.environment !== intent.parameters.environment) {
      closest = { kind: "mismatch", outcome: "DENIED", reason: "ENVIRONMENT_NOT_ALLOWED", explanation: "Grant environment does not match.", grant };
      continue;
    }
    if (grant.limits.artifact && grant.limits.artifact !== intent.parameters.artifact) {
      closest = { kind: "mismatch", outcome: "DENIED", reason: "ARTIFACT_NOT_ALLOWED", explanation: "Grant artifact does not match.", grant };
      continue;
    }
    if (grant.limits.currency && intent.parameters.currency && grant.limits.currency !== intent.parameters.currency) {
      closest = { kind: "mismatch", outcome: "DENIED", reason: "CURRENCY_MISMATCH", explanation: "Grant currency does not match. Currency is never converted.", grant };
      continue;
    }
    if (grant.limits.valueAsset && intent.parameters.valueAsset && grant.limits.valueAsset !== intent.parameters.valueAsset) {
      closest = { kind: "mismatch", outcome: "DENIED", reason: "CURRENCY_MISMATCH", explanation: "Grant value asset does not match.", grant };
      continue;
    }
    if (grant.limits.maxValue != null && intent.parameters.amount != null && intent.parameters.amount > grant.limits.maxValue) {
      closest = { kind: "mismatch", outcome: "DENIED", reason: "VALUE_LIMIT_EXCEEDED", explanation: "Requested value exceeds the grant limit.", grant };
      continue;
    }
    if (grant.limits.maxOccurrences != null && grant.consumedOccurrences >= grant.limits.maxOccurrences) {
      closest = { kind: "mismatch", outcome: "DENIED", reason: "OCCURRENCE_LIMIT_EXCEEDED", explanation: "Grant occurrence limit has been consumed.", grant };
      continue;
    }
    if (grant.status === "revoked" || grant.revokedAt) {
      closest = { kind: "revoked", grant };
      continue;
    }
    if ((grant.expiresAt && grant.expiresAt <= now) || grant.status === "expired" || grant.effectiveFrom > now) {
      closest = { kind: "expired", grant };
      continue;
    }
    return { kind: "authorized" as const, grant };
  }
  return closest ?? { kind: "none" as const };
}

export function policyIdentity() {
  return { policyId: AUTHORITY_POLICY_ID, policyVersion: AUTHORITY_POLICY_VERSION };
}
