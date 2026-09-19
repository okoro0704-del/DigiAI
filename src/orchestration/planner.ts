import { isCapabilityId, type CapabilityId } from "../contracts/capabilities.js";
import type { BindingSource, OrchestrationFixture, OutputBinding } from "../contracts/orchestration.js";
import type { DigiAiExecutionStep } from "../contracts/orchestration.js";
import { PLAN_SCHEMA_VERSION, PLANNER_VERSION } from "../contracts/orchestration.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import { DigiAiError } from "../lib/http.js";

export type PlannedStep = {
  stepKey: string;
  capability: CapabilityId | "ACTION";
  dependencies: string[];
  inputBindings: BindingSource[];
  outputBindings: OutputBinding[];
  required: boolean;
  privacyClass?: PrivacyClass;
  provider?: string;
  model?: string;
  governedAction?: DigiAiExecutionStep["governedAction"];
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
  if (/\bauthority-create\b|\bgenerate_campaign_copy\b/.test(text)) return "authority-create";
  if (/\bauthority-publish-optional\b|\boptional publish\b/.test(text)) return "authority-publish-optional";
  if (/\bauthority-publish\b|\bpublish_mybrandos\b/.test(text)) return "authority-publish";
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
  if (fixture === "authority-create") {
    return [
      {
        stepKey: "create",
        capability: "ACTION",
        dependencies: [],
        inputBindings: textIn("objective.instruction"),
        outputBindings: textOut("campaignCopy"),
        required: true,
        governedAction: {
          actionClass: "CREATE",
          actionType: "GENERATE_CAMPAIGN_COPY",
          target: { resourceType: "campaign", resourceId: "campaign-copy" },
          parameters: { contentReference: "campaign-copy" },
        },
      },
    ];
  }
  if (fixture === "authority-publish" || fixture === "authority-publish-optional") {
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
        stepKey: "publish",
        capability: "ACTION",
        dependencies: ["write"],
        inputBindings: textIn("campaignCopy"),
        outputBindings: textOut("publishAuthorization"),
        required: fixture === "authority-publish",
        governedAction: {
          actionClass: "PUBLISH",
          actionType: "PUBLISH_MYBRANDOS_POST",
          target: { resourceType: "mybrandos-post", resourceId: "draft-1" },
          parameters: { contentReference: "draft-1", contentDigest: "digest-v1", destination: "mybrandos", visibility: "public" },
        },
      },
    ];
  }
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
  if (step.capability !== "ACTION" && !isCapabilityId(step.capability)) {
    throw new DigiAiError(400, "invalid_plan", `Unknown capability ${String(step.capability)}.`);
  }
  if (step.provider || step.model) {
    throw new DigiAiError(400, "invalid_plan", "Planner output cannot select a provider or model.");
  }
}
