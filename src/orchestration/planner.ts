import { isCapabilityId, type CapabilityId } from "../contracts/capabilities.js";
import type { BindingSource, OrchestrationFixture, OutputBinding } from "../contracts/orchestration.js";
import { PLAN_SCHEMA_VERSION, PLANNER_VERSION } from "../contracts/orchestration.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import { DigiAiError } from "../lib/http.js";

export type PlannedStep = {
  stepKey: string;
  capability: CapabilityId;
  dependencies: string[];
  inputBindings: BindingSource[];
  outputBindings: OutputBinding[];
  required: boolean;
  privacyClass?: PrivacyClass;
  provider?: string;
  model?: string;
};

export type PlannedGraph = {
  plannerVersion: string;
  planSchemaVersion: string;
  fixture?: OrchestrationFixture;
  steps: PlannedStep[];
};

function textIn(from: string): BindingSource[] {
  return [{ from, as: "message" }];
}

function textOut(name: string): OutputBinding[] {
  return [{ name, type: "TEXT" }];
}

function mediaOut(name: string, type: "MEDIA" | "ASSET_REFERENCE" = "MEDIA"): OutputBinding[] {
  return [{ name, type }];
}

export function planObjective(input: {
  instruction: string;
  desiredOutputs?: string[];
  fixture?: OrchestrationFixture;
  privacyClass: PrivacyClass;
}): PlannedGraph {
  const fixture = input.fixture ?? inferFixture(input.instruction, input.desiredOutputs);
  const steps = graphFor(fixture);
  return {
    plannerVersion: PLANNER_VERSION,
    planSchemaVersion: PLAN_SCHEMA_VERSION,
    fixture,
    steps,
  };
}

function inferFixture(instruction: string, desired?: string[]): OrchestrationFixture {
  const text = `${instruction} ${(desired ?? []).join(" ")}`.toLowerCase();
  if (/\bcycle\b/.test(text)) return "cycle";
  if (/\bsend_money\b|\bignore all rules\b/.test(text)) return "injection";
  if (/\bpartial\b/.test(text)) return "partial";
  if (/\brequired failure\b|\bresearch fails\b/.test(text)) return "required-failure";
  if (/\bcancel\b/.test(text)) return "cancel";
  if (/\bvideo\b/.test(text)) return "async-video";
  if (/\bimage\b|\bhero\b/.test(text)) return "media";
  if (/\bparallel\b|\bwrite_a\b|\bwrite_b\b/.test(text)) return "parallel";
  if (/\bresearch\b/.test(text)) return "text-pipeline";
  return "text-pipeline";
}

function graphFor(fixture: OrchestrationFixture): PlannedStep[] {
  if (fixture === "cycle") {
    return [
      {
        stepKey: "a",
        capability: "THINK",
        dependencies: ["b"],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("aNotes"),
        required: true,
      },
      {
        stepKey: "b",
        capability: "WRITE",
        dependencies: ["a"],
        inputBindings: textIn("aNotes"),
        outputBindings: textOut("bNotes"),
        required: true,
      },
    ];
  }
  if (fixture === "parallel") {
    return [
      {
        stepKey: "think",
        capability: "THINK",
        dependencies: [],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("brief"),
        required: true,
      },
      {
        stepKey: "write_a",
        capability: "WRITE",
        dependencies: ["think"],
        inputBindings: textIn("brief"),
        outputBindings: textOut("writeA"),
        required: true,
      },
      {
        stepKey: "write_b",
        capability: "WRITE",
        dependencies: ["think"],
        inputBindings: textIn("brief"),
        outputBindings: textOut("writeB"),
        required: true,
      },
    ];
  }
  if (fixture === "media") {
    return [
      {
        stepKey: "write",
        capability: "WRITE",
        dependencies: [],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("campaignCopy"),
        required: true,
      },
      {
        stepKey: "image",
        capability: "IMAGE",
        dependencies: ["write"],
        inputBindings: textIn("campaignCopy"),
        outputBindings: mediaOut("heroImage"),
        required: true,
      },
    ];
  }
  if (fixture === "async-video" || fixture === "cancel") {
    return [
      {
        stepKey: "write",
        capability: "WRITE",
        dependencies: [],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("script"),
        required: true,
      },
      {
        stepKey: "video",
        capability: "VIDEO",
        dependencies: ["write"],
        inputBindings: textIn("script"),
        outputBindings: mediaOut("launchVideo"),
        required: true,
      },
    ];
  }
  if (fixture === "partial") {
    return [
      {
        stepKey: "write",
        capability: "WRITE",
        dependencies: [],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("campaignCopy"),
        required: true,
      },
      {
        stepKey: "image",
        capability: "IMAGE",
        dependencies: ["write"],
        inputBindings: textIn("campaignCopy"),
        outputBindings: mediaOut("heroImage"),
        required: true,
      },
      {
        stepKey: "video",
        capability: "VIDEO",
        dependencies: ["write"],
        inputBindings: textIn("campaignCopy"),
        outputBindings: mediaOut("launchVideo"),
        required: false,
      },
    ];
  }
  if (fixture === "required-failure") {
    return [
      {
        stepKey: "research",
        capability: "RESEARCH",
        dependencies: [],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("researchNotes"),
        required: true,
      },
      {
        stepKey: "write",
        capability: "WRITE",
        dependencies: ["research"],
        inputBindings: textIn("researchNotes"),
        outputBindings: textOut("summary"),
        required: true,
      },
    ];
  }
  return [
    {
      stepKey: "research",
      capability: "RESEARCH",
      dependencies: [],
      inputBindings: textIn("objective.instruction"),
      outputBindings: textOut("researchNotes"),
      required: true,
    },
    {
      stepKey: "write",
      capability: "WRITE",
      dependencies: ["research"],
      inputBindings: textIn("researchNotes"),
      outputBindings: textOut("summary"),
      required: true,
    },
  ];
}

export function assertCapabilityOnly(step: PlannedStep) {
  if (!isCapabilityId(step.capability)) {
    throw new DigiAiError(400, "invalid_plan", `Unknown capability ${String(step.capability)}.`);
  }
  if (step.provider || step.model) {
    throw new DigiAiError(400, "invalid_plan", "Planner output cannot select a provider or model.");
  }
}
