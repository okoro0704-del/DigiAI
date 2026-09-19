import type { NativeUsage } from "../contracts/usage.js";
import { logEvent } from "../lib/log.js";
import { getPricingVersion, selectPricing, type PricingRecord } from "./pricing-catalog.js";

export type CostEstimate = {
  estimatedProviderCost: number | null;
  actualProviderCost: null;
  currency: string | null;
  pricingVersion: string | null;
  unknownDimensions: string[];
};

const NATIVE_TO_DIMENSION: Record<string, PricingRecord["dimensions"][number]["kind"] | undefined> = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cachedTokens: "cached_input_tokens",
  cachedInputTokens: "cached_input_tokens",
  imageCount: "image",
  generatedImageCount: "image",
  audioSeconds: "audio_seconds",
  videoSeconds: "video_seconds",
  generatedSeconds: "generated_seconds",
};

function quantityFor(kind: string, usage: NativeUsage): number {
  if (kind === "input_tokens") return usage.inputTokens ?? 0;
  if (kind === "output_tokens") return usage.outputTokens ?? 0;
  if (kind === "cached_input_tokens") return usage.cachedInputTokens ?? usage.cachedTokens ?? 0;
  if (kind === "image") return usage.generatedImageCount ?? usage.imageCount ?? 0;
  if (kind === "audio_seconds") return usage.audioSeconds ?? 0;
  if (kind === "video_seconds") return usage.videoSeconds ?? 0;
  if (kind === "generated_seconds") return usage.generatedSeconds ?? 0;
  return 0;
}

export function estimateProviderCost(input: {
  providerId: string;
  modelId?: string;
  nativeUsage?: NativeUsage;
  at?: string;
  pricingVersion?: string;
}): CostEstimate {
  const usage = input.nativeUsage ?? {};
  const hasUsage = Object.values(usage).some((value) => typeof value === "number" && value > 0);
  if (!hasUsage) {
    return {
      estimatedProviderCost: null,
      actualProviderCost: null,
      currency: null,
      pricingVersion: null,
      unknownDimensions: [],
    };
  }

  const pricing = input.pricingVersion ? getPricingVersion(input.pricingVersion) : selectPricing(input);
  if (!pricing || pricing.status === "disabled") {
    if (input.providerId !== "test" && input.providerId !== "unbound") {
      logEvent("pricing_lookup_failed", { providerId: input.providerId, modelId: input.modelId });
    }
    return {
      estimatedProviderCost: null,
      actualProviderCost: null,
      currency: null,
      pricingVersion: null,
      unknownDimensions: [],
    };
  }

  const unknownDimensions: string[] = [];
  for (const key of Object.keys(usage)) {
    if (key === "totalTokens" || key === "imageSize" || key === "imageWidth" || key === "imageHeight" || key === "imageBytes") continue;
    if (key === "imageCount" && !pricing.dimensions.some((dim) => dim.kind === "image")) continue;
    const mapped = NATIVE_TO_DIMENSION[key];
    if (!mapped) {
      unknownDimensions.push(key);
      continue;
    }
    if (!pricing.dimensions.some((dim) => dim.kind === mapped) && (usage[key] ?? 0) > 0) {
      unknownDimensions.push(key);
    }
  }
  if (unknownDimensions.length) {
    logEvent("unknown_pricing_dimension", { pricingVersion: pricing.pricingVersion, unknownDimensions });
  }

  let total = 0;
  let priced = false;
  try {
    for (const dim of pricing.dimensions) {
      const qty = quantityFor(dim.kind, usage);
      if (qty <= 0) continue;
      if (typeof dim.perMillion === "number") {
        total += (qty / 1_000_000) * dim.perMillion;
        priced = true;
      } else if (typeof dim.perUnit === "number") {
        total += qty * dim.perUnit;
        priced = true;
      }
    }
  } catch {
    logEvent("cost_calculation_failed", { pricingVersion: pricing.pricingVersion });
    return {
      estimatedProviderCost: null,
      actualProviderCost: null,
      currency: pricing.currency,
      pricingVersion: pricing.pricingVersion,
      unknownDimensions,
    };
  }

  return {
    estimatedProviderCost: priced ? Number(total.toFixed(8)) : null,
    actualProviderCost: null,
    currency: pricing.currency,
    pricingVersion: pricing.pricingVersion,
    unknownDimensions,
  };
}
