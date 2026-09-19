import type { PrivacyClass } from "./privacy.js";

export const CAPABILITY_IDS = [
  "THINK",
  "WRITE",
  "SUMMARIZE",
  "RESEARCH",
  "CODE",
  "VISION",
  "IMAGE",
  "VIDEO",
  "SPEECH_TO_TEXT",
  "TEXT_TO_SPEECH",
  "VOICE",
  "MUSIC",
  "TRANSLATE",
  "EMBED",
  "RETRIEVE",
  "TOOL_REASON",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type LatencyClass = "low" | "medium" | "high";
export type CostClass = "low" | "medium" | "high";

export type CapabilityDefinition = {
  id: CapabilityId;
  modalityIn: string[];
  modalityOut: string[];
  streaming: boolean;
  structuredOutput: boolean;
  toolUse: boolean;
  latencyClass: LatencyClass;
  costClass: CostClass;
  privacyEligible: PrivacyClass[];
  /** Contract exists. Does not mean a provider is configured. */
  cataloged: true;
};

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}
