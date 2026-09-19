import type { DigiAiMeteringPolicy } from "../contracts/credits.js";
import { nowIso } from "../lib/crypto.js";

const CREATED = "2026-09-19T00:00:00.000Z";

function textPolicy(capability: string): DigiAiMeteringPolicy {
  return {
    policyId: `dev-${capability.toLowerCase()}-2026-09`,
    version: `dev-${capability.toLowerCase()}-1`,
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability,
    meteringDimensions: [
      { dimension: "inputTokens", units: 1, per: 100 },
      { dimension: "outputTokens", units: 1, per: 50 },
    ],
    minimumCharge: 1,
    outputTokenHeadroom: 2048,
    reservationTtlSeconds: 1800,
    createdAt: CREATED,
  };
}

/**
 * TEST/DEVELOPMENT metering only. Not commercial Digi AI economics.
 * Values exist so reservation/settlement can be exercised.
 */
export const METERING_POLICIES: DigiAiMeteringPolicy[] = [
  textPolicy("THINK"),
  textPolicy("WRITE"),
  textPolicy("SUMMARIZE"),
  textPolicy("RESEARCH"),
  textPolicy("CODE"),
  textPolicy("TRANSLATE"),
  textPolicy("RETRIEVE"),
  textPolicy("TOOL_REASON"),
  textPolicy("EMBED"),
  textPolicy("VISION"),
  {
    policyId: "dev-image-2026-09",
    version: "dev-image-1",
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability: "IMAGE",
    meteringDimensions: [
      { dimension: "imageCount", units: 100, per: 1 },
      { dimension: "hdMultiplier", units: 2, per: 1 },
    ],
    minimumCharge: 100,
    outputTokenHeadroom: 0,
    reservationTtlSeconds: 1800,
    createdAt: CREATED,
  },
  {
    policyId: "dev-stt-2026-09",
    version: "dev-stt-1",
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability: "SPEECH_TO_TEXT",
    meteringDimensions: [{ dimension: "audioSeconds", units: 10, per: 1 }],
    minimumCharge: 10,
    outputTokenHeadroom: 0,
    reservationTtlSeconds: 1800,
    createdAt: CREATED,
  },
  {
    policyId: "dev-tts-2026-09",
    version: "dev-tts-1",
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability: "TEXT_TO_SPEECH",
    meteringDimensions: [{ dimension: "characterCount", units: 1, per: 100 }],
    minimumCharge: 1,
    outputTokenHeadroom: 0,
    reservationTtlSeconds: 1800,
    createdAt: CREATED,
  },
  {
    policyId: "dev-voice-2026-09",
    version: "dev-voice-1",
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability: "VOICE",
    meteringDimensions: [
      { dimension: "audioSeconds", units: 10, per: 1 },
      { dimension: "inputTokens", units: 1, per: 100 },
      { dimension: "outputTokens", units: 1, per: 50 },
      { dimension: "characterCount", units: 1, per: 100 },
    ],
    minimumCharge: 11,
    outputTokenHeadroom: 2048,
    reservationTtlSeconds: 1800,
    createdAt: CREATED,
  },
  {
    policyId: "dev-music-2026-09",
    version: "dev-music-1",
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability: "MUSIC",
    meteringDimensions: [
      { dimension: "generation", units: 50, per: 1 },
      { dimension: "generatedSeconds", units: 1, per: 1 },
    ],
    minimumCharge: 50,
    outputTokenHeadroom: 0,
    reservationTtlSeconds: 1800,
    createdAt: CREATED,
  },
  {
    policyId: "dev-video-2026-09",
    version: "dev-video-1",
    effectiveFrom: CREATED,
    status: "development",
    commercial: false,
    capability: "VIDEO",
    meteringDimensions: [
      { dimension: "videoSeconds", units: 25, per: 1 },
      { dimension: "qualityFast", units: 2, per: 1 },
      { dimension: "qualityStandard", units: 4, per: 1 },
      { dimension: "resolution1080", units: 2, per: 1 },
      { dimension: "resolution4k", units: 4, per: 1 },
    ],
    minimumCharge: 100,
    outputTokenHeadroom: 0,
    reservationTtlSeconds: 7200,
    createdAt: CREATED,
  },
];

export function listMeteringPolicies(): DigiAiMeteringPolicy[] {
  return METERING_POLICIES.map((row) => ({ ...row, meteringDimensions: [...row.meteringDimensions] }));
}

export function commercialPolicyConfigured(at = nowIso()): boolean {
  return METERING_POLICIES.some(
    (row) =>
      row.commercial &&
      row.status === "commercial" &&
      row.effectiveFrom <= at &&
      (!row.effectiveTo || row.effectiveTo > at),
  );
}

export function selectMeteringPolicy(input: {
  capability: string;
  at?: string;
  catalog?: DigiAiMeteringPolicy[];
}): DigiAiMeteringPolicy | null {
  const at = input.at ?? nowIso();
  const catalog = input.catalog ?? METERING_POLICIES;
  const matches = catalog.filter(
    (row) =>
      row.capability === input.capability &&
      row.status !== "disabled" &&
      row.status !== "superseded" &&
      row.effectiveFrom <= at &&
      (!row.effectiveTo || row.effectiveTo > at),
  );
  if (!matches.length) return null;
  matches.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.version.localeCompare(a.version));
  return matches[0] ?? null;
}

export function detectOverlappingPolicies(catalog: DigiAiMeteringPolicy[] = METERING_POLICIES): string[] {
  const production = catalog.filter((row) => row.commercial && (row.status === "commercial" || row.status === "development"));
  const hits: string[] = [];
  for (let i = 0; i < production.length; i += 1) {
    for (let j = i + 1; j < production.length; j += 1) {
      const a = production[i]!;
      const b = production[j]!;
      if (a.capability !== b.capability) continue;
      const aEnd = a.effectiveTo ?? "9999-12-31T00:00:00.000Z";
      const bEnd = b.effectiveTo ?? "9999-12-31T00:00:00.000Z";
      if (a.effectiveFrom < bEnd && b.effectiveFrom < aEnd) {
        hits.push(`${a.capability}:${a.version}+${b.version}`);
      }
    }
  }
  return hits;
}
