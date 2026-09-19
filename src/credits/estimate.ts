import type { DigiAiMeteringPolicy, DigiAiUnits } from "../contracts/credits.js";
import type { AskConstraints } from "../contracts/request.js";
import type { NativeUsage } from "../contracts/usage.js";
import { ceilRatio, maxUnits, minUnits } from "./units.js";
import { selectMeteringPolicy } from "./policy.js";

export type UnitEstimateInput = {
  capability: string;
  message?: string;
  constraints?: AskConstraints;
  nativeUsage?: NativeUsage;
  audioSeconds?: number;
  imageCount?: number;
  imageSizeClass?: string;
  at?: string;
  policy?: DigiAiMeteringPolicy | null;
};

export type UnitEstimate = {
  units: DigiAiUnits;
  policyVersion: string | null;
  dimensions: Record<string, DigiAiUnits>;
  reservation: boolean;
};

function rate(policy: DigiAiMeteringPolicy, dimension: string): { units: DigiAiUnits; per: DigiAiUnits } | null {
  const row = policy.meteringDimensions.find((item) => item.dimension === dimension);
  return row ? { units: row.units, per: row.per } : null;
}

function applyRate(policy: DigiAiMeteringPolicy, dimension: string, amount: number): DigiAiUnits {
  const found = rate(policy, dimension);
  if (!found || amount <= 0) return 0;
  return ceilRatio(Math.trunc(amount), found.units, found.per);
}

function estimatedInputTokens(message?: string): number {
  if (!message) return 32;
  return Math.max(1, Math.ceil(message.length / 4));
}

function videoMultiplier(policy: DigiAiMeteringPolicy, constraints?: AskConstraints): DigiAiUnits {
  let factor = 1;
  const quality = constraints?.videoQuality;
  if (quality === "fast") factor *= rate(policy, "qualityFast")?.units ?? 2;
  if (quality === "standard") factor *= rate(policy, "qualityStandard")?.units ?? 4;
  const resolution = constraints?.resolution;
  if (resolution === "1080p") factor *= rate(policy, "resolution1080")?.units ?? 2;
  if (resolution === "4k") factor *= rate(policy, "resolution4k")?.units ?? 4;
  return factor;
}

function imageMultiplier(policy: DigiAiMeteringPolicy, constraints?: AskConstraints, sizeClass?: string): DigiAiUnits {
  const size = sizeClass ?? constraints?.sizeClass;
  if (size === "large") {
    return rate(policy, "hdMultiplier")?.units ?? 2;
  }
  return 1;
}

export function estimateDigiAiUnits(input: UnitEstimateInput): UnitEstimate {
  const policy = input.policy === undefined
    ? selectMeteringPolicy({ capability: input.capability, at: input.at })
    : input.policy;
  if (!policy) {
    return { units: 0, policyVersion: null, dimensions: {}, reservation: false };
  }
  const native = input.nativeUsage ?? {};
  const dimensions: Record<string, DigiAiUnits> = {};
  let units = 0;

  if (input.capability === "IMAGE") {
    const count = input.imageCount ?? native.imageCount ?? native.generatedImageCount ?? input.constraints?.count ?? 1;
    const base = applyRate(policy, "imageCount", count);
    const multiplier = imageMultiplier(policy, input.constraints, input.imageSizeClass);
    units = base * multiplier;
    dimensions.imageCount = count;
    dimensions.multiplier = multiplier;
  } else if (input.capability === "VIDEO") {
    const seconds = native.videoSeconds ?? native.generatedSeconds ?? input.constraints?.durationSeconds ?? 4;
    const count = input.constraints?.count ?? native.videoCount ?? 1;
    const multiplier = videoMultiplier(policy, input.constraints);
    units = applyRate(policy, "videoSeconds", seconds) * multiplier * count;
    dimensions.videoSeconds = seconds;
    dimensions.count = count;
    dimensions.multiplier = multiplier;
  } else if (input.capability === "MUSIC") {
    const count = input.constraints?.count ?? native.trackCount ?? 1;
    const seconds = native.generatedSeconds ?? input.constraints?.durationSeconds ?? 30;
    units = applyRate(policy, "generation", count) + applyRate(policy, "generatedSeconds", seconds * count);
    dimensions.generation = count;
    dimensions.generatedSeconds = seconds * count;
  } else if (input.capability === "SPEECH_TO_TEXT") {
    const seconds = input.audioSeconds ?? native.audioSeconds ?? 1;
    units = applyRate(policy, "audioSeconds", seconds);
    dimensions.audioSeconds = seconds;
  } else if (input.capability === "TEXT_TO_SPEECH") {
    const chars = native.characterCount ?? native.inputCharacters ?? (input.message?.length ?? 1);
    units = applyRate(policy, "characterCount", chars);
    dimensions.characterCount = chars;
  } else if (input.capability === "VOICE") {
    const seconds = input.audioSeconds ?? native.audioSeconds ?? 1;
    const inputTokens = native.inputTokens ?? estimatedInputTokens(input.message);
    const outputTokens = native.outputTokens ?? policy.outputTokenHeadroom;
    const chars = native.characterCount ?? 64;
    units =
      applyRate(policy, "audioSeconds", seconds) +
      applyRate(policy, "inputTokens", inputTokens) +
      applyRate(policy, "outputTokens", outputTokens) +
      applyRate(policy, "characterCount", chars);
    dimensions.audioSeconds = seconds;
    dimensions.inputTokens = inputTokens;
    dimensions.outputTokens = outputTokens;
    dimensions.characterCount = chars;
  } else {
    const inputTokens = native.inputTokens ?? estimatedInputTokens(input.message);
    const outputKnown = typeof native.outputTokens === "number";
    const outputTokens = outputKnown ? native.outputTokens! : policy.outputTokenHeadroom;
    units = applyRate(policy, "inputTokens", inputTokens) + applyRate(policy, "outputTokens", outputTokens);
    dimensions.inputTokens = inputTokens;
    dimensions.outputTokens = outputTokens;
  }

  units = maxUnits(units, policy.minimumCharge);
  if (policy.maximumCharge != null) units = minUnits(units, policy.maximumCharge);
  return {
    units,
    policyVersion: policy.version,
    dimensions,
    reservation: true,
  };
}

export function hasBillableNativeUsage(native?: NativeUsage): boolean {
  if (!native) return false;
  const keys = [
    "inputTokens",
    "outputTokens",
    "imageCount",
    "generatedImageCount",
    "audioSeconds",
    "videoSeconds",
    "generatedSeconds",
    "characterCount",
    "trackCount",
    "videoCount",
    "providerNativeUnitAmount",
  ] as const;
  return keys.some((key) => (native[key] ?? 0) > 0);
}
