export type PricingDimensionKind =
  | "input_tokens"
  | "output_tokens"
  | "cached_input_tokens"
  | "image"
  | "audio_seconds"
  | "video_seconds"
  | "generated_seconds"
  | "characters"
  | "generation";

export type PricingDimension = {
  kind: PricingDimensionKind;
  unit: "token" | "image" | "second" | "character" | "generation";
  perMillion?: number;
  perUnit?: number;
};

export type PricingRecord = {
  providerId: string;
  modelId: string;
  pricingVersion: string;
  effectiveFrom: string;
  effectiveTo?: string;
  currency: string;
  status: "active" | "disabled" | "superseded";
  dimensions: PricingDimension[];
};

/** Versioned catalog. Historical rows stay so estimates are not silently rewritten. */
export const PRICING_CATALOG: PricingRecord[] = [
  {
    providerId: "openai",
    modelId: "gpt-4o-mini",
    pricingVersion: "openai-gpt-4o-mini-2026-08-01",
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveTo: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "superseded",
    dimensions: [
      { kind: "input_tokens", unit: "token", perMillion: 0.15 },
      { kind: "output_tokens", unit: "token", perMillion: 0.6 },
      { kind: "cached_input_tokens", unit: "token", perMillion: 0.075 },
    ],
  },
  {
    providerId: "openai",
    modelId: "gpt-4o-mini",
    pricingVersion: "openai-gpt-4o-mini-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [
      { kind: "input_tokens", unit: "token", perMillion: 0.15 },
      { kind: "output_tokens", unit: "token", perMillion: 0.6 },
      { kind: "cached_input_tokens", unit: "token", perMillion: 0.075 },
    ],
  },
  {
    providerId: "openai",
    modelId: "gpt-4o",
    pricingVersion: "openai-gpt-4o-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [
      { kind: "input_tokens", unit: "token", perMillion: 2.5 },
      { kind: "output_tokens", unit: "token", perMillion: 10 },
      { kind: "cached_input_tokens", unit: "token", perMillion: 1.25 },
    ],
  },
  {
    providerId: "openai",
    modelId: "gpt-image-1",
    pricingVersion: "openai-gpt-image-1-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "image", unit: "image", perUnit: 0.04 }],
  },
  {
    providerId: "openai",
    modelId: "whisper-1",
    pricingVersion: "openai-whisper-1-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "audio_seconds", unit: "second", perUnit: 0.0001 }],
  },
  {
    providerId: "openai",
    modelId: "tts-1",
    pricingVersion: "openai-tts-1-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "characters", unit: "character", perMillion: 15 }],
  },
  {
    providerId: "gemini",
    modelId: "lyria-3-clip-preview",
    pricingVersion: "gemini-lyria-3-clip-preview-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "generation", unit: "generation", perUnit: 0.04 }],
  },
  {
    providerId: "gemini",
    modelId: "lyria-3.5",
    pricingVersion: "gemini-lyria-3.5-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "generation", unit: "generation", perUnit: 0.08 }],
  },
  {
    providerId: "gemini",
    modelId: "veo-3.1-lite-generate-preview",
    pricingVersion: "gemini-veo-3.1-lite-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "video_seconds", unit: "second", perUnit: 0.05 }],
  },
  {
    providerId: "gemini",
    modelId: "veo-3.1-fast-generate-preview",
    pricingVersion: "gemini-veo-3.1-fast-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "video_seconds", unit: "second", perUnit: 0.1 }],
  },
  {
    providerId: "gemini",
    modelId: "veo-3.1-generate-preview",
    pricingVersion: "gemini-veo-3.1-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [{ kind: "video_seconds", unit: "second", perUnit: 0.4 }],
  },
  {
    providerId: "gemini",
    modelId: "gemini-2.0-flash",
    pricingVersion: "gemini-2.0-flash-2026-09-01",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    status: "active",
    dimensions: [
      { kind: "input_tokens", unit: "token", perMillion: 0.1 },
      { kind: "output_tokens", unit: "token", perMillion: 0.4 },
      { kind: "cached_input_tokens", unit: "token", perMillion: 0.025 },
    ],
  },
];

export function listPricingCatalog(): PricingRecord[] {
  return PRICING_CATALOG.map((row) => ({ ...row, dimensions: row.dimensions.map((dim) => ({ ...dim })) }));
}

export function activePricingVersions(at = new Date().toISOString()): PricingRecord[] {
  return PRICING_CATALOG.filter((row) => row.status === "active" && inEffect(row, at));
}

export function selectPricing(input: {
  providerId: string;
  modelId?: string;
  at?: string;
}): PricingRecord | undefined {
  const at = input.at ?? new Date().toISOString();
  const matches = PRICING_CATALOG.filter(
    (row) =>
      row.providerId === input.providerId &&
      row.modelId === input.modelId &&
      row.status !== "disabled" &&
      inEffect(row, at),
  ).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return matches.find((row) => row.status === "active") ?? matches[0];
}

export function getPricingVersion(version: string): PricingRecord | undefined {
  return PRICING_CATALOG.find((row) => row.pricingVersion === version);
}

function inEffect(row: PricingRecord, at: string): boolean {
  if (row.effectiveFrom > at) return false;
  if (row.effectiveTo && row.effectiveTo <= at) return false;
  return true;
}
