import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { ActionClass, ActionParameters, ActionType } from "../contracts/authority.js";
import type { DigiAiActionExecution, ExecutorCapability, FixtureMode } from "../contracts/execution.js";
import { invokeTool, mapToolToExecutor } from "../connectors/service.js";
import type { DigiAiStore } from "../store/types.js";

export type ExecutorContext = {
  executionId: string;
  externalIdempotencyKey: string;
  actionType: ActionType;
  actionClass: ActionClass;
  parameters: ActionParameters;
  target: { resourceType: string; resourceId: string };
  fixtureMode?: FixtureMode;
  resume?: boolean;
  reconcile?: boolean;
  existingExternalReference?: string;
  store?: DigiAiStore;
  actor?: ActorContext;
  caller?: CallerApplication;
  execution?: DigiAiActionExecution;
};

export type ExecutorResult = {
  outcome: "SUCCEEDED" | "FAILED" | "WAITING" | "UNKNOWN_OUTCOME" | "REJECTED_BEFORE_SUBMISSION";
  submitted: boolean;
  invoked: boolean;
  resultReference?: string;
  externalReference?: string;
  evidence?: Record<string, string>;
  failureCode?: "TRANSIENT_BEFORE_SUBMISSION" | "REMOTE_FAILED" | "UNKNOWN_REMOTE_OUTCOME" | "EXECUTOR_REJECTED";
};

export type DigiAiActionExecutor = {
  executorId: string;
  version: string;
  supportedActionTypes: ActionType[];
  supportedActionClasses: ActionClass[];
  capabilities: ExecutorCapability[];
  execute(context: ExecutorContext): Promise<ExecutorResult>;
  resume(context: ExecutorContext): Promise<ExecutorResult>;
  inspect(context: ExecutorContext): Promise<ExecutorResult>;
  reconcile(context: ExecutorContext): Promise<ExecutorResult>;
  cancel(context: ExecutorContext): Promise<ExecutorResult>;
};

export const fixtureStats = {
  invocations: 0,
  effects: new Map<string, number>(),
  lastExternalKey: "",
};

export function resetFixtureStats() {
  fixtureStats.invocations = 0;
  fixtureStats.effects.clear();
  fixtureStats.lastExternalKey = "";
}

function recordEffect(key: string) {
  fixtureStats.effects.set(key, (fixtureStats.effects.get(key) ?? 0) + 1);
}

function nativeResult(context: ExecutorContext, kind: string): ExecutorResult {
  const existing = context.resume || context.existingExternalReference;
  const externalReference = context.existingExternalReference ?? `fixture-op-${context.executionId}`;
  const resultReference = `fixture:${kind}:${context.executionId}`;
  if (existing && context.existingExternalReference) {
    return {
      outcome: "SUCCEEDED",
      submitted: false,
      invoked: true,
      externalReference,
      resultReference,
      evidence: { operation: externalReference, resumed: "true" },
    };
  }
  recordEffect(context.externalIdempotencyKey);
  return {
    outcome: "SUCCEEDED",
    submitted: true,
    invoked: true,
    externalReference,
    resultReference,
    evidence: { operation: externalReference, nativeIdempotency: "true" },
  };
}

function runMode(context: ExecutorContext, kind: string): ExecutorResult {
  fixtureStats.invocations += 1;
  fixtureStats.lastExternalKey = context.externalIdempotencyKey;
  if (fixtureStats.effects.has(context.externalIdempotencyKey) && !context.resume) {
    return {
      outcome: "SUCCEEDED",
      submitted: false,
      invoked: true,
      externalReference: context.existingExternalReference ?? `fixture-op-${context.executionId}`,
      resultReference: `fixture:${kind}:${context.executionId}`,
      evidence: { nativeIdempotency: "true", replayed: "true" },
    };
  }
  const mode = context.fixtureMode ?? "SUCCESS";
  if (context.resume && context.existingExternalReference && mode !== "UNKNOWN_OUTCOME") {
    return {
      outcome: "SUCCEEDED",
      submitted: false,
      invoked: true,
      externalReference: context.existingExternalReference,
      resultReference: `fixture:${kind}:${context.executionId}`,
      evidence: { operation: context.existingExternalReference, resumed: "true" },
    };
  }
  if (mode === "FAIL_BEFORE_SUBMISSION") {
    return { outcome: "REJECTED_BEFORE_SUBMISSION", submitted: false, invoked: true, failureCode: "TRANSIENT_BEFORE_SUBMISSION" };
  }
  if (mode === "REMOTE_FAILURE") {
    return {
      outcome: "FAILED",
      submitted: true,
      invoked: true,
      externalReference: `fixture-op-${context.executionId}`,
      failureCode: "REMOTE_FAILED",
      evidence: { submitted: "true", remote: "failed" },
    };
  }
  if (mode === "WAITING" && !context.resume) {
    recordEffect(context.externalIdempotencyKey);
    return {
      outcome: "WAITING",
      submitted: true,
      invoked: true,
      externalReference: `fixture-op-${context.executionId}`,
      evidence: { submitted: "true", waiting: "true" },
    };
  }
  if (mode === "UNKNOWN_OUTCOME" && !context.resume) {
    recordEffect(context.externalIdempotencyKey);
    return {
      outcome: "UNKNOWN_OUTCOME",
      submitted: true,
      invoked: true,
      externalReference: `fixture-op-${context.executionId}`,
      failureCode: "UNKNOWN_REMOTE_OUTCOME",
      evidence: { submitted: "true", lostResponse: "true" },
    };
  }
  return nativeResult(context, kind);
}

function makeFixture(id: string, actionType: ActionType, actionClass: ActionClass, kind: string, extra: ExecutorCapability[] = []): DigiAiActionExecutor {
  return {
    executorId: id,
    version: "fixture-1",
    supportedActionTypes: [actionType],
    supportedActionClasses: [actionClass],
    capabilities: extra.length ? extra : ["NATIVE_IDEMPOTENCY", "RECONCILIATION"],
    async execute(context) {
      if (context.store && context.actor && context.caller && context.execution) {
        fixtureStats.invocations += 1;
        fixtureStats.lastExternalKey = context.externalIdempotencyKey;
        const result = await invokeTool({
          store: context.store,
          execution: context.execution,
          actor: context.actor,
          caller: context.caller,
          selectionId: context.execution.connectionSelectionId,
        });
        const mapped = mapToolToExecutor(result);
        if (mapped.submitted) recordEffect(context.externalIdempotencyKey);
        return mapped;
      }
      return runMode(context, kind);
    },
    async resume(context) {
      if (context.store && context.actor && context.caller && context.execution) {
        fixtureStats.invocations += 1;
        const result = await invokeTool({
          store: context.store,
          execution: context.execution,
          actor: context.actor,
          caller: context.caller,
          resume: true,
          selectionId: context.execution.connectionSelectionId,
        });
        return mapToolToExecutor(result);
      }
      return runMode({ ...context, resume: true }, kind);
    },
    async inspect(context) {
      if (context.existingExternalReference) {
        return {
          outcome: "SUCCEEDED",
          submitted: true,
          invoked: false,
          externalReference: context.existingExternalReference,
          resultReference: `fixture:${kind}:${context.executionId}`,
          evidence: { inspected: context.existingExternalReference },
        };
      }
      return { outcome: "UNKNOWN_OUTCOME", submitted: false, invoked: false, failureCode: "UNKNOWN_REMOTE_OUTCOME" };
    },
    async reconcile(context) {
      if (context.store && context.actor && context.caller && context.execution) {
        const result = await invokeTool({
          store: context.store,
          execution: context.execution,
          actor: context.actor,
          caller: context.caller,
          reconcile: true,
        });
        return mapToolToExecutor(result);
      }
      if (!context.existingExternalReference) {
        return { outcome: "UNKNOWN_OUTCOME", submitted: true, invoked: false, failureCode: "UNKNOWN_REMOTE_OUTCOME" };
      }
      return {
        outcome: "SUCCEEDED",
        submitted: false,
        invoked: false,
        externalReference: context.existingExternalReference,
        resultReference: `fixture:${kind}:${context.executionId}`,
        evidence: { reconciled: context.existingExternalReference },
      };
    },
    async cancel() {
      return { outcome: "FAILED", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
    },
  };
}

export const fixturePublisher = makeFixture("fixture-publisher", "PUBLISH_FIXTURE_POST", "PUBLISH", "publication");
export const fixtureMessenger = makeFixture("fixture-messenger", "MESSAGE_FIXTURE", "MESSAGE", "message");
export const fixtureValue = makeFixture("fixture-value", "SPEND_FIXTURE", "SPEND", "value");
export const fixtureDeployer = makeFixture("fixture-deployer", "DEPLOY_FIXTURE", "DEPLOY", "deployment");
export const fixtureDelete = makeFixture("fixture-delete", "DELETE_FIXTURE", "DELETE", "deletion");

export const mybrandosDraftWriter: DigiAiActionExecutor = {
  executorId: "mybrandos-draft-writer",
  version: "3h-create-1",
  supportedActionTypes: ["CREATE_MYBRANDOS_DRAFT"],
  supportedActionClasses: ["CREATE"],
  capabilities: ["NATIVE_IDEMPOTENCY"],
  async execute(context) {
    if (!context.store || !context.actor || !context.caller || !context.execution) {
      return { outcome: "REJECTED_BEFORE_SUBMISSION", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
    }
    const result = await invokeTool({
      store: context.store,
      execution: context.execution,
      actor: context.actor,
      caller: context.caller,
      selectionId: context.execution.connectionSelectionId,
    });
    return mapToolToExecutor(result);
  },
  async resume(context) {
    if (!context.store || !context.actor || !context.caller || !context.execution) {
      return { outcome: "REJECTED_BEFORE_SUBMISSION", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
    }
    const result = await invokeTool({
      store: context.store,
      execution: context.execution,
      actor: context.actor,
      caller: context.caller,
      reconcile: true,
      selectionId: context.execution.connectionSelectionId,
    });
    return mapToolToExecutor(result);
  },
  async inspect(context) {
    if (context.existingExternalReference) {
      return {
        outcome: "SUCCEEDED",
        submitted: true,
        invoked: false,
        externalReference: context.existingExternalReference,
        resultReference: context.execution?.resultReference,
        evidence: { inspected: context.existingExternalReference, system: "mybrandos" },
      };
    }
    return { outcome: "UNKNOWN_OUTCOME", submitted: false, invoked: false, failureCode: "UNKNOWN_REMOTE_OUTCOME" };
  },
  async reconcile(context) {
    if (!context.store || !context.actor || !context.caller || !context.execution) {
      return { outcome: "UNKNOWN_OUTCOME", submitted: false, invoked: false, failureCode: "UNKNOWN_REMOTE_OUTCOME" };
    }
    const result = await invokeTool({
      store: context.store,
      execution: context.execution,
      actor: context.actor,
      caller: context.caller,
      reconcile: true,
      selectionId: context.execution.connectionSelectionId,
    });
    return mapToolToExecutor(result);
  },
  async cancel() {
    return { outcome: "FAILED", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
  },
};

export const mybrandosPublicReader: DigiAiActionExecutor = {
  executorId: "mybrandos-public-reader",
  version: "3g-read-1",
  supportedActionTypes: ["INSPECT_MYBRANDOS_PUBLIC", "LIST_MYBRANDOS_PUBLIC_ASSETS"],
  supportedActionClasses: ["KNOW"],
  capabilities: ["NATIVE_IDEMPOTENCY"],
  async execute(context) {
    if (!context.store || !context.actor || !context.caller || !context.execution) {
      return { outcome: "REJECTED_BEFORE_SUBMISSION", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
    }
    const result = await invokeTool({
      store: context.store,
      execution: context.execution,
      actor: context.actor,
      caller: context.caller,
      selectionId: context.execution.connectionSelectionId,
    });
    return mapToolToExecutor(result);
  },
  async resume(context) {
    if (!context.store || !context.actor || !context.caller || !context.execution) {
      return { outcome: "REJECTED_BEFORE_SUBMISSION", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
    }
    const result = await invokeTool({
      store: context.store,
      execution: context.execution,
      actor: context.actor,
      caller: context.caller,
      resume: true,
      selectionId: context.execution.connectionSelectionId,
    });
    return mapToolToExecutor(result);
  },
  async inspect(context) {
    if (context.existingExternalReference) {
      return {
        outcome: "SUCCEEDED",
        submitted: true,
        invoked: false,
        externalReference: context.existingExternalReference,
        resultReference: context.execution?.resultReference,
        evidence: { inspected: context.existingExternalReference, system: "mybrandos" },
      };
    }
    return { outcome: "UNKNOWN_OUTCOME", submitted: false, invoked: false, failureCode: "UNKNOWN_REMOTE_OUTCOME" };
  },
  async reconcile() {
    return { outcome: "UNKNOWN_OUTCOME", submitted: false, invoked: false, failureCode: "UNKNOWN_REMOTE_OUTCOME" };
  },
  async cancel() {
    return { outcome: "FAILED", submitted: false, invoked: false, failureCode: "EXECUTOR_REJECTED" };
  },
};
