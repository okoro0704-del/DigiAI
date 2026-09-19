import { isCapabilityId, type CapabilityId } from "../contracts/capabilities.js";
import type { DigiAiMode } from "../contracts/request.js";

/**
 * /v1/ask modes map to capabilities. Callers do not name providers.
 * ask/reason/plan → THINK
 * draft → WRITE
 * summarize → SUMMARIZE
 * retrieve → RETRIEVE
 */
export function capabilityFromAskMode(mode?: DigiAiMode): CapabilityId {
  if (mode === "draft") return "WRITE";
  if (mode === "summarize") return "SUMMARIZE";
  if (mode === "retrieve") return "RETRIEVE";
  return "THINK";
}

export function resolveRequestedCapability(input: {
  capability?: unknown;
  mode?: DigiAiMode;
  twin?: boolean;
}): CapabilityId {
  if (isCapabilityId(input.capability)) return input.capability;
  if (input.twin) return "THINK";
  return capabilityFromAskMode(input.mode);
}
