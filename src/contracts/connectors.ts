import type { ActionType } from "./authority.js";

export const TOOL_CONNECTOR_POLICY_ID = "digi-ai-tool-connector-1";
export const TOOL_CONNECTOR_POLICY_VERSION = "tool-connector-policy-1";
export const TOOL_SCHEMA_VERSION = "tool-invocation-1";

export const CONNECTOR_TYPES = ["INTERNAL_SERVICE", "HTTP_API", "OAUTH_API", "S2S_API"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const CONNECTOR_STATUSES = ["CONFIGURED", "UNAVAILABLE", "DISABLED", "DEGRADED"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const CONNECTOR_ENVIRONMENTS = ["FIXTURE", "STAGING", "PRODUCTION"] as const;
export type ConnectorEnvironment = (typeof CONNECTOR_ENVIRONMENTS)[number];

export const SIDE_EFFECT_CLASSES = ["READ_ONLY", "REVERSIBLE_WRITE", "CONSEQUENTIAL_WRITE", "DESTRUCTIVE"] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

export const IDEMPOTENCY_MODES = ["REQUIRED", "SUPPORTED", "UNSUPPORTED"] as const;
export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

export const RECONCILIATION_MODES = ["SUPPORTED", "UNSUPPORTED"] as const;
export type ReconciliationMode = (typeof RECONCILIATION_MODES)[number];

export const CANCELLATION_MODES = ["SUPPORTED", "UNSUPPORTED", "BEST_EFFORT"] as const;
export type CancellationMode = (typeof CANCELLATION_MODES)[number];

export const TOOL_INVOCATION_STATUSES = [
  "PENDING",
  "SUBMITTING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN_OUTCOME",
  "CANCELLED",
] as const;
export type ToolInvocationStatus = (typeof TOOL_INVOCATION_STATUSES)[number];

export const TOOL_FAILURE_CODES = [
  "VALIDATION_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "CREDENTIAL_UNAVAILABLE",
  "CONNECTOR_DISABLED",
  "OPERATION_DISABLED",
  "ENVIRONMENT_DENIED",
  "ACTION_TYPE_MISMATCH",
  "TARGET_MISMATCH",
  "PARAMETER_MISMATCH",
  "RATE_LIMITED",
  "TEMPORARY_UNAVAILABLE",
  "TIMEOUT_BEFORE_SUBMISSION",
  "TIMEOUT_UNKNOWN_SUBMISSION",
  "PROVIDER_REJECTED",
  "MALFORMED_RESPONSE",
  "RECONCILIATION_UNSUPPORTED",
  "NETWORK_DESTINATION_DENIED",
] as const;
export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];

export const TOOL_AUDIT_EVENTS = [
  "TOOL_INVOCATION_REQUESTED",
  "CONNECTOR_RESOLVED",
  "CREDENTIAL_RESOLVED",
  "TOOL_SUBMISSION_STARTED",
  "TOOL_SUBMITTED",
  "TOOL_WAITING",
  "TOOL_SUCCEEDED",
  "TOOL_FAILED",
  "TOOL_UNKNOWN_OUTCOME",
  "TOOL_RECONCILED",
  "TOOL_CANCEL_REQUESTED",
  "TOOL_CANCEL_CONFIRMED",
] as const;
export type ToolAuditEventType = (typeof TOOL_AUDIT_EVENTS)[number];

export type ConnectorCredentialRef = {
  credentialRef: string;
  credentialType: "opaque";
  system: string;
  tenantId?: string;
  actorId?: string;
  environment: ConnectorEnvironment;
  status: "available" | "unavailable" | "revoked";
  createdAt: string;
};

export type DigiAiToolConnector = {
  connectorId: string;
  connectorType: ConnectorType;
  version: string;
  displayName: string;
  system: string;
  environment: ConnectorEnvironment;
  status: ConnectorStatus;
  supportedOperations: string[];
  authenticationMode: "none" | "opaque-ref";
  credentialRef?: string;
  capabilities: string[];
  idempotencySupport: IdempotencyMode;
  reconciliationSupport: ReconciliationMode;
  cancellationSupport: CancellationMode;
  healthState: "unknown" | "fixture";
  requiresCredential: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ToolFieldSchema = {
  required: string[];
  enums?: Record<string, string[]>;
  numbers?: string[];
};

export type DigiAiToolOperation = {
  operationId: string;
  connectorId: string;
  operationName: string;
  actionTypes: ActionType[];
  inputSchema: ToolFieldSchema;
  outputSchema: ToolFieldSchema;
  riskClass: "low" | "high";
  sideEffectClass: SideEffectClass;
  idempotencyMode: IdempotencyMode;
  reconciliationMode: ReconciliationMode;
  cancellationMode: CancellationMode;
  timeoutPolicy: { beforeSubmissionMs: number; afterSubmission: "UNKNOWN_OUTCOME" | "WAITING" };
  enabled: boolean;
  version: string;
  requiresCredential: boolean;
};

export type DigiAiToolInvocationRequest = {
  toolInvocationId: string;
  executionId: string;
  connectorId: string;
  operationId: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  objectiveId?: string;
  actionIntentId: string;
  actionAuthorizationId: string;
  requestDigest: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  createdAt: string;
};

export type DigiAiToolInvocation = DigiAiToolInvocationRequest & {
  status: ToolInvocationStatus;
  externalOperationRef?: string;
  resultReference?: string;
  responseDigest?: string;
  evidence?: Record<string, string>;
  retryability?: "safe" | "unsafe" | "unknown";
  failureCode?: ToolFailureCode;
  retryAfter?: string;
  submittedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type DigiAiToolInvocationResult = {
  toolInvocationId: string;
  status: ToolInvocationStatus;
  externalOperationRef?: string;
  resultReference?: string;
  responseDigest?: string;
  evidence?: Record<string, string>;
  retryability?: "safe" | "unsafe" | "unknown";
  submittedAt?: string;
  completedAt?: string;
  failureCode?: ToolFailureCode;
  retryAfter?: string;
};

export type ToolAuditEvent = {
  eventId: string;
  eventType: ToolAuditEventType;
  toolInvocationId: string;
  executionId?: string;
  connectorId?: string;
  operationId?: string;
  actorId?: string;
  tenantId?: string;
  status?: ToolInvocationStatus;
  createdAt: string;
};

export type ToolConnectorPolicy = {
  policyId: string;
  version: string;
  status: "active";
  fixtureMode: true;
  liveMode: false;
  allowedConnectorTypes: ConnectorType[];
  realConsequentialWrites: false;
  realDestructive: false;
  fixturesEnabled: true;
  requireIdempotencyForConsequential: boolean;
};

export type SanitizedToolCatalogRow = {
  operationId: string;
  operationName: string;
  description: string;
  connectorId: string;
  sideEffectClass: SideEffectClass;
  available: boolean;
  inputShape: string[];
};
