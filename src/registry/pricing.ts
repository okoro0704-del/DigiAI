/**
 * Replaceable pricing metadata. Estimates are never invoice truth.
 * Amounts are USD per 1M tokens unless noted.
 */
export type PricingTable = {
  version: string;
  currency: "USD";
  entries: Record<string, { inputPerMillion?: number; outputPerMillion?: number }>;
};

export const PRICING_TABLE: PricingTable = {
  version: "2026-09-phase2a",
  currency: "USD",
  entries: {
    "openai:gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    "openai:gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  },
};

export function estimateTokenCost(
  pricingRef: string | undefined,
  usage: { inputTokens?: number; outputTokens?: number },
): number | null {
  if (!pricingRef) return null;
  const row = PRICING_TABLE.entries[pricingRef];
  if (!row) return null;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * (row.inputPerMillion ?? 0);
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * (row.outputPerMillion ?? 0);
  const total = input + output;
  return total > 0 ? Number(total.toFixed(8)) : null;
}
