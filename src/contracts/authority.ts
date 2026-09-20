export const ACTION_CLASSES = [
  "KNOW",
  "THINK",
  "CREATE",
  "CHANGE",
  "PUBLISH",
  "MESSAGE",
  "SPEND",
  "DEPLOY",
  "DELETE",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const CONSEQUENTIAL_CLASSES: ActionClass[] = ["CHANGE", "PUBLISH", "MESSAGE", "SPEND", "DEPLOY", "DELETE"];
export const AUTOMATIC_CLASSES: ActionClass[] = ["KNOW", "THINK", "CREATE"];

export const ACTION_TYPES = [
  "GENERATE_CAMPAIGN_COPY",
  "PUBLISH_MYBRANDOS_POST",
  "SEND_ELFCOM_MESSAGE",
  "UPDATE_PRODUCT_PRICE",
  "TRANSFER_FINPROVE_VALUE",
  "DEPLOY_SERVICE",
  "DELETE_ASSET",
  "PUBLISH_FIXTURE_POST",
  "MESSAGE_FIXTURE",
  "SPEND_FIXTURE",
  "DEPLOY_FIXTURE",
  "DELETE_FIXTURE",
  "INSPECT_MYBRANDOS_PUBLIC",
  "LIST_MYBRANDOS_PUBLIC_ASSETS",
  "CREATE_MYBRANDOS_DRAFT",
  "PUBLISH_MYBRANDOS_DRAFT",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_INTENT_STATUSES = ["PROPOSED", "EVALUATED", "AUTHORIZED", "HUMAN_DECISION_REQUIRED", "DENIED"] as const;
export type ActionIntentStatus = (typeof ACTION_INTENT_STATUSES)[number];

export const AUTHORITY_OUTCOMES = [
  "AUTHORIZED_AUTOMATICALLY",
  "AUTHORIZED_BY_GRANT",
  "HUMAN_DECISION_REQUIRED",
  "DENIED",
  "EXPIRED",
  "REVOKED",
  "INVALID",
] as const;
export type AuthorityOutcome = (typeof AUTHORITY_OUTCOMES)[number];

export const AUTHORITY_REASONS = [
  "AUTO_CLASS_ALLOWED",
  "VALID_OBJECTIVE_GRANT",
  "VALID_BOUNDED_GRANT",
  "HUMAN_APPROVED_EXACT_ACTION",
  "ACTION_REQUIRES_HUMAN",
  "GRANT_EXPIRED",
  "GRANT_REVOKED",
  "TARGET_OUT_OF_SCOPE",
  "VALUE_LIMIT_EXCEEDED",
  "OCCURRENCE_LIMIT_EXCEEDED",
  "ENVIRONMENT_NOT_ALLOWED",
  "ARTIFACT_NOT_ALLOWED",
  "CURRENCY_MISMATCH",
  "ACTION_DIGEST_CHANGED",
  "ACTOR_MISMATCH",
  "TENANT_MISMATCH",
  "APPLICATION_MISMATCH",
  "OBJECTIVE_OUT_OF_SCOPE",
  "AUTHORIZATION_CONSUMED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_INVALIDATED",
  "MALFORMED_GRANT",
  "AUTHORITY_UNPROVEN",
] as const;
export type AuthorityReason = (typeof AUTHORITY_REASONS)[number];

export const GRANT_STATUSES = ["active", "revoked", "expired"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const AUTHORIZATION_STATUSES = ["issued", "claimed", "consumed", "expired", "invalidated"] as const;
export type AuthorizationStatus = (typeof AUTHORIZATION_STATUSES)[number];

export const HUMAN_DECISION_VALUES = ["APPROVE", "DENY"] as const;
export type HumanDecisionValue = (typeof HUMAN_DECISION_VALUES)[number];

export const DECISION_SCOPES = ["THIS_ACTION", "OBJECTIVE", "BOUNDED_GRANT"] as const;
export type DecisionScope = (typeof DECISION_SCOPES)[number];

export const AUTHORITY_AUDIT_EVENTS = [
  "ACTION_PROPOSED",
  "AUTHORITY_EVALUATED",
  "HUMAN_DECISION_REQUESTED",
  "HUMAN_APPROVED",
  "HUMAN_DENIED",
  "GRANT_CREATED",
  "GRANT_REVOKED",
  "AUTHORIZATION_ISSUED",
  "AUTHORIZATION_CONSUMED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_INVALIDATED",
] as const;
export type AuthorityAuditEventType = (typeof AUTHORITY_AUDIT_EVENTS)[number];

export type ActionTarget = {
  resourceType: string;
  resourceId: string;
  tenantId?: string;
};

export type ActionParameters = {
  contentReference?: string;
  contentDigest?: string;
  destination?: string;
  visibility?: string;
  recipient?: string;
  conversationId?: string;
  messageDigest?: string;
  messagePreview?: string;
  amount?: number;
  currency?: string;
  valueAsset?: string;
  artifact?: string;
  environment?: string;
  service?: string;
  resourceType?: string;
  resourceId?: string;
};

export type AuthorityLimits = {
  maxOccurrences?: number;
  maxValue?: number;
  currency?: string;
  valueAsset?: string;
  environment?: string;
  artifact?: string;
};

export type AuthorityScope = {
  actorId?: string;
  tenantId?: string;
  applicationId?: string;
  objectiveId?: string;
  actionClasses?: ActionClass[];
  actionTypes?: ActionType[];
  resourceType?: string;
  resourceId?: string;
};

export type DigiAiActionIntent = {
  actionIntentId: string;
  objectiveId?: string;
  planId?: string;
  stepId?: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  actionClass: ActionClass;
  additionalClasses?: ActionClass[];
  actionType: ActionType;
  target: ActionTarget;
  scope: AuthorityScope;
  parameters: ActionParameters;
  parametersDigest: string;
  riskContext?: string;
  status: ActionIntentStatus;
  evaluationOutcome?: AuthorityOutcome;
  evaluationReason?: AuthorityReason;
  authorityPolicyId: string;
  authorityPolicyVersion: string;
  decisionRequestId?: string;
  authorizationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type DigiAiAuthorityGrant = {
  grantId: string;
  grantorActorId: string;
  tenantId?: string;
  delegate: "digi-ai";
  scope: AuthorityScope;
  allowedActionClasses: ActionClass[];
  allowedActionTypes?: ActionType[];
  resourceConstraints?: { resourceType?: string; resourceId?: string };
  objectiveConstraint?: string;
  applicationConstraint?: string;
  limits: AuthorityLimits;
  effectiveFrom: string;
  expiresAt?: string;
  status: GrantStatus;
  consumedOccurrences: number;
  policyId: string;
  policyVersion: string;
  createdAt: string;
  revokedAt?: string;
};

export type DigiAiHumanDecision = {
  decisionId: string;
  actionIntentId: string;
  actorId: string;
  tenantId?: string;
  decision: HumanDecisionValue;
  scope: DecisionScope;
  actionDigest: string;
  expiresAt?: string;
  limits?: AuthorityLimits;
  createdAt: string;
};

export type DigiAiHumanDecisionRequest = {
  decisionRequestId: string;
  actionIntentId: string;
  summary: string;
  actionClass: ActionClass;
  actionType: ActionType;
  targetSummary: string;
  materialParameters: ActionParameters;
  reasonCode: AuthorityReason;
  expiresAt?: string;
  createdAt: string;
};

export type DigiAiActionAuthorization = {
  authorizationId: string;
  actionIntentId: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  actionDigest: string;
  authoritySource: "automatic" | "grant" | "human_decision";
  authoritySourceId?: string;
  policyId: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt?: string;
  status: AuthorizationStatus;
  consumedAt?: string;
  claimedByExecutionId?: string;
  claimedAt?: string;
};

export type AuthorityAuditEvent = {
  eventId: string;
  eventType: AuthorityAuditEventType;
  actionIntentId?: string;
  grantId?: string;
  authorizationId?: string;
  actorId?: string;
  tenantId?: string;
  outcome?: AuthorityOutcome;
  reasonCode?: AuthorityReason;
  policyVersion?: string;
  createdAt: string;
};

export type AuthorityDecision = {
  outcome: AuthorityOutcome;
  reasonCode: AuthorityReason;
  policyId: string;
  policyVersion: string;
  grantId?: string;
  decisionId?: string;
  strongestClass: ActionClass;
  explanation: string;
};

export const AUTHORITY_POLICY_ID = "digi-ai-authority-1";
export const AUTHORITY_POLICY_VERSION = "authority-policy-1";

export function isActionClass(value: unknown): value is ActionClass {
  return typeof value === "string" && (ACTION_CLASSES as readonly string[]).includes(value);
}

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}
