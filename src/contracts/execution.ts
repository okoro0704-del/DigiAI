import type { ActionClass, ActionParameters, ActionTarget, ActionType } from "./authority.js";

export const ACTION_SCHEMA_VERSION = "action-execution-1";

export const EXECUTION_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN_OUTCOME",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const EXECUTION_FAILURE_CODES = [
  "VALIDATION_FAILED",
  "AUTHORITY_INVALID",
  "EXECUTOR_NOT_FOUND",
  "EXECUTOR_REJECTED",
  "TRANSIENT_BEFORE_SUBMISSION",
  "SUBMITTED_WAITING",
  "REMOTE_FAILED",
  "UNKNOWN_REMOTE_OUTCOME",
  "CANCELLED_BEFORE_SUBMISSION",
  "PARAMETER_MISMATCH",
] as const;
export type ExecutionFailureCode = (typeof EXECUTION_FAILURE_CODES)[number];

export const FIXTURE_MODES = [
  "SUCCESS",
  "FAIL_BEFORE_SUBMISSION",
  "REMOTE_FAILURE",
  "WAITING",
  "UNKNOWN_OUTCOME",
] as const;
export type FixtureMode = (typeof FIXTURE_MODES)[number];

export const EXECUTOR_CAPABILITIES = ["NATIVE_IDEMPOTENCY", "RECONCILIATION", "NEITHER"] as const;
export type ExecutorCapability = (typeof EXECUTOR_CAPABILITIES)[number];

export const EXECUTION_AUDIT_EVENTS = [
  "EXECUTION_REQUESTED",
  "AUTHORIZATION_CLAIMED",
  "EXECUTOR_RESOLVED",
  "EXECUTION_STARTED",
  "EXECUTION_WAITING",
  "EXECUTION_SUCCEEDED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "EXECUTION_UNKNOWN",
  "EXECUTION_RECONCILED",
] as const;
export type ExecutionAuditEventType = (typeof EXECUTION_AUDIT_EVENTS)[number];

export type DigiAiActionExecutionRequest = {
  executionRequestId: string;
  actionIntentId: string;
  authorizationId: string;
  objectiveId?: string;
  planId?: string;
  stepId?: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  actionClass: ActionClass;
  actionType: ActionType;
  target: ActionTarget;
  parameters: ActionParameters;
  parametersDigest: string;
  idempotencyKey: string;
  createdAt: string;
};

export type DigiAiActionExecution = {
  executionId: string;
  executionRequestId: string;
  actionIntentId: string;
  authorizationId: string;
  objectiveId?: string;
  stepId?: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  executorId: string;
  executorVersion: string;
  actionClass: ActionClass;
  actionType: ActionType;
  target: ActionTarget;
  parameters: ActionParameters;
  parametersDigest: string;
  actionSchemaVersion: string;
  status: ExecutionStatus;
  attemptCount: number;
  failureCode?: ExecutionFailureCode;
  resultReference?: string;
  externalReference?: string;
  externalIdempotencyKey: string;
  fixtureMode?: FixtureMode;
  submittedAt?: string;
  startedAt?: string;
  completedAt?: string;
  receiptId?: string;
  toolInvocationId?: string;
  connectorId?: string;
  operationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type DigiAiActionExecutionReceipt = {
  receiptId: string;
  executionId: string;
  actionIntentId: string;
  authorizationId: string;
  executorId: string;
  executorVersion: string;
  actionClass: ActionClass;
  actionType: ActionType;
  targetDigest: string;
  parametersDigest: string;
  status: "SUCCEEDED" | "FAILED" | "WAITING" | "UNKNOWN_OUTCOME";
  externalReference?: string;
  resultReference?: string;
  evidence?: Record<string, string>;
  submittedAt?: string;
  resolvedAt?: string;
  createdAt: string;
};

export type DigiAiActionResult = {
  executionId: string;
  status: ExecutionStatus;
  reference?: string;
  output?: Record<string, string>;
  evidence?: Record<string, string>;
  failureCode?: ExecutionFailureCode;
  receiptId?: string;
};

export type ExecutionAuditEvent = {
  eventId: string;
  eventType: ExecutionAuditEventType;
  executionId: string;
  actionIntentId?: string;
  authorizationId?: string;
  actorId?: string;
  tenantId?: string;
  status?: ExecutionStatus;
  createdAt: string;
};

export const FIXTURE_ACTION_TYPES: ActionType[] = [
  "PUBLISH_FIXTURE_POST",
  "MESSAGE_FIXTURE",
  "SPEND_FIXTURE",
  "DEPLOY_FIXTURE",
  "DELETE_FIXTURE",
];

export function isFixtureActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (FIXTURE_ACTION_TYPES as string[]).includes(value);
}

export function isFixtureMode(value: unknown): value is FixtureMode {
  return typeof value === "string" && (FIXTURE_MODES as readonly string[]).includes(value);
}
