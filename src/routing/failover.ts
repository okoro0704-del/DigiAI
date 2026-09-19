import type { ProviderFailure } from "../providers/types.js";

/**
 * Failover policy (inspectable, not LLM-chosen):
 * Eligible: unavailable, timeout, rate_limited, quota, billing, provider_error, empty.
 * Ineligible: auth_failed, invalid_request, safety_refused, privacy denial.
 * Privacy / HIGHLY_SENSITIVE exclusions happen before a provider is eligible;
 * failover never reintroduces an excluded provider.
 * Same-provider retries are not used. Max attempts is config.maxProviderAttempts (default 2).
 */
export const FAILOVER_ELIGIBLE_ERRORS: ReadonlyArray<ProviderFailure["error"]> = [
  "unavailable",
  "timeout",
  "rate_limited",
  "quota",
  "billing",
  "provider_error",
  "empty",
];

/** Failures that must not send the same request to another provider. */
export const FAILOVER_INELIGIBLE_ERRORS: ReadonlyArray<ProviderFailure["error"] | string> = [
  "auth_failed",
  "invalid_request",
  "safety_refused",
];

export function isFailoverEligibleError(error?: string): boolean {
  return Boolean(error && (FAILOVER_ELIGIBLE_ERRORS as readonly string[]).includes(error));
}

export function failoverDeniedReason(input: {
  allowFailover: boolean;
  error?: string;
  attempts: number;
  maxAttempts: number;
  nextEligible: boolean;
}): string | undefined {
  if (!input.error) return undefined;
  if (!input.allowFailover) return "Failover disabled by request or service policy.";
  if (!isFailoverEligibleError(input.error)) {
    if (input.error === "safety_refused") return "Safety refusal is not eligible for silent failover.";
    if (input.error === "auth_failed") return "Authentication/configuration failure is not failover-eligible.";
    if (input.error === "invalid_request") return "Invalid request is not failover-eligible.";
    return `${input.error} is not failover-eligible.`;
  }
  if (input.attempts >= input.maxAttempts) return "Failover attempt limit reached.";
  if (!input.nextEligible) return "No remaining eligible provider under current policy.";
  return undefined;
}
