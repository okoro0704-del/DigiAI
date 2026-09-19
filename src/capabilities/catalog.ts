import type { CapabilityDefinition, CapabilityId } from "../contracts/capabilities.js";
import type { PrivacyClass } from "../contracts/privacy.js";

const ALL_PRIVACY: PrivacyClass[] = ["PUBLIC", "INTERNAL", "PRIVATE", "HIGHLY_SENSITIVE"];
const STANDARD_PRIVACY: PrivacyClass[] = ["PUBLIC", "INTERNAL", "PRIVATE"];

function define(
  id: CapabilityId,
  input: Partial<Omit<CapabilityDefinition, "id" | "cataloged">> & {
    modalityIn: string[];
    modalityOut: string[];
  },
): CapabilityDefinition {
  return {
    id,
    streaming: false,
    structuredOutput: false,
    toolUse: false,
    latencyClass: "medium",
    costClass: "medium",
    privacyEligible: STANDARD_PRIVACY,
    ...input,
    cataloged: true,
  };
}

export const CAPABILITY_CATALOG: Record<CapabilityId, CapabilityDefinition> = {
  THINK: define("THINK", { modalityIn: ["text"], modalityOut: ["text"], structuredOutput: true, latencyClass: "low", costClass: "low", privacyEligible: ALL_PRIVACY }),
  WRITE: define("WRITE", { modalityIn: ["text"], modalityOut: ["text"], structuredOutput: true, latencyClass: "low", costClass: "low", privacyEligible: ALL_PRIVACY }),
  SUMMARIZE: define("SUMMARIZE", { modalityIn: ["text"], modalityOut: ["text"], latencyClass: "low", costClass: "low", privacyEligible: ALL_PRIVACY }),
  RESEARCH: define("RESEARCH", { modalityIn: ["text"], modalityOut: ["text"], latencyClass: "medium", costClass: "medium", privacyEligible: ALL_PRIVACY }),
  CODE: define("CODE", { modalityIn: ["text"], modalityOut: ["text"], structuredOutput: true, latencyClass: "medium", costClass: "medium", privacyEligible: ALL_PRIVACY }),
  VISION: define("VISION", { modalityIn: ["image", "text"], modalityOut: ["text"], latencyClass: "medium", costClass: "medium" }),
  IMAGE: define("IMAGE", { modalityIn: ["text"], modalityOut: ["image"], latencyClass: "high", costClass: "high" }),
  VIDEO: define("VIDEO", { modalityIn: ["text"], modalityOut: ["video"], latencyClass: "high", costClass: "high" }),
  SPEECH_TO_TEXT: define("SPEECH_TO_TEXT", { modalityIn: ["audio"], modalityOut: ["text"], latencyClass: "medium", costClass: "medium" }),
  TEXT_TO_SPEECH: define("TEXT_TO_SPEECH", { modalityIn: ["text"], modalityOut: ["audio"], latencyClass: "medium", costClass: "medium" }),
  VOICE: define("VOICE", { modalityIn: ["audio", "text"], modalityOut: ["audio", "text"], latencyClass: "medium", costClass: "high" }),
  MUSIC: define("MUSIC", { modalityIn: ["text"], modalityOut: ["audio"], latencyClass: "high", costClass: "high" }),
  TRANSLATE: define("TRANSLATE", { modalityIn: ["text"], modalityOut: ["text"], latencyClass: "low", costClass: "low", privacyEligible: ALL_PRIVACY }),
  EMBED: define("EMBED", { modalityIn: ["text"], modalityOut: ["vector"], latencyClass: "low", costClass: "low" }),
  RETRIEVE: define("RETRIEVE", { modalityIn: ["text"], modalityOut: ["text"], latencyClass: "low", costClass: "low", privacyEligible: ALL_PRIVACY }),
  TOOL_REASON: define("TOOL_REASON", { modalityIn: ["text"], modalityOut: ["text"], toolUse: true, structuredOutput: true, privacyEligible: ALL_PRIVACY }),
};

/** Text capabilities Digi AI can execute today when a text provider is bound. */
export const TEXT_CAPABILITIES: CapabilityId[] = [
  "THINK",
  "WRITE",
  "SUMMARIZE",
  "RESEARCH",
  "CODE",
  "TRANSLATE",
  "RETRIEVE",
];

export function listCapabilities(): CapabilityDefinition[] {
  return Object.values(CAPABILITY_CATALOG);
}

export function getCapability(id: CapabilityId): CapabilityDefinition {
  return CAPABILITY_CATALOG[id];
}
