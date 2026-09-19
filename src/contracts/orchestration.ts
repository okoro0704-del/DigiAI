import type { ActionClass, ActionParameters, ActionTarget, ActionType } from "./authority.js";
import type { CapabilityId } from "./capabilities.js";
import type { PrivacyClass } from "./privacy.js";

export const OBJECTIVE_STATUSES = [
  "PLANNING",
  "PLANNED",
  "RUNNING",
  "WAITING",
  "WAITING_FOR_HUMAN",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export const STEP_STATUSES = ["PENDING", "RUNNING", "WAITING", "WAITING_FOR_HUMAN", "COMPLETED", "FAILED", "CANCELLED", "SKIPPED"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const OUTPUT_KINDS = ["TEXT", "STRUCTURED_DATA", "MEDIA", "ASSET_REFERENCE"] as const;
export type ObjectiveOutputKind = (typeof OUTPUT_KINDS)[number];

export type StepExecutionClass = "AUTOMATIC" | "HUMAN_DECISION_REQUIRED";

export type OrchestrationFixture =
  | "text-pipeline"
  | "parallel"
  | "media"
  | "async-video"
  | "partial"
  | "required-failure"
  | "injection"
  | "cycle"
  | "cancel"
  | "authority-create"
  | "authority-publish"
  | "authority-publish-optional";

export type BindingSource = {
  from: string;
  as: string;
};

export type OutputBinding = {
  name: string;
  type: ObjectiveOutputKind;
};

export type StepOutput = {
  name: string;
  kind: ObjectiveOutputKind;
  text?: string;
  data?: Record<string, unknown>;
  mediaReference?: string;
  mimeType?: string;
  generated: boolean;
  retrieved: boolean;
  stepId: string;
  capability: string;
  provider?: string;
  model?: string;
  usageReceiptId?: string;
};

export type DigiAiExecutionStep = {
  stepId: string;
  stepKey: string;
  objectiveId: string;
  planId: string;
  capability: CapabilityId | "ACTION";
  governedAction?: {
    actionClass: ActionClass;
    additionalClasses?: ActionClass[];
    actionType: ActionType;
    target: ActionTarget;
    parameters: ActionParameters;
  };
  actionIntentId?: string;
  authorizationId?: string;
  dependencies: string[];
  inputBindings: BindingSource[];
  outputBindings: OutputBinding[];
  privacyClass: PrivacyClass;
  required: boolean;
  executionClass: StepExecutionClass;
  status: StepStatus;
  attemptCount: number;
  maxAttempts: number;
  estimatedDigiAiUnits?: number;
  reservationId?: string;
  logicalRequestId?: string;
  usageReceiptId?: string;
  providerOperationId?: string;
  output?: StepOutput;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type DigiAiExecutionPlan = {
  planId: string;
  objectiveId: string;
  plannerVersion: string;
  planSchemaVersion: string;
  status: "validated" | "rejected";
  stepKeys: string[];
  createdAt: string;
};

export type DigiAiObjective = {
  objectiveId: string;
  logicalRequestId: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  instruction: string;
  privacyClass: PrivacyClass;
  status: ObjectiveStatus;
  desiredOutputs?: string[];
  idempotencyKey?: string;
  fixture: boolean;
  fixtureName?: OrchestrationFixture;
  cancelRequested: boolean;
  remoteCancellationConfirmed: false;
  estimatedDigiAiUnits?: number;
  createdAt: string;
  updatedAt: string;
};

export type DigiAiObjectiveResult = {
  objectiveId: string;
  status: ObjectiveStatus;
  outputs: StepOutput[];
  completedSteps: string[];
  failedSteps: string[];
  provenanceSummary: Array<{
    stepKey: string;
    capability: string;
    status: StepStatus;
    usageReceiptId?: string;
    provider?: string;
    model?: string;
    generated?: boolean;
    retrieved?: boolean;
    mediaReference?: string;
  }>;
  economicSummary: {
    estimatedDigiAiUnits: number | null;
    mode: string;
    reservations: number;
    note: string;
  };
  createdAt: string;
  completedAt?: string;
};

export const PLANNER_VERSION = "det-planner-1";
export const PLAN_SCHEMA_VERSION = "orchestration-plan-1";
export const RESERVED_BINDING_NAMES = [
  "objectiveId",
  "actorId",
  "tenantId",
  "applicationId",
  "status",
  "provider",
  "model",
  "grant",
  "balance",
];
