import type { AppConfig } from "../config.js";
import type { CapabilityId } from "../contracts/capabilities.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "../providers/types.js";
import type { ProviderPool } from "../providers/pool.js";
import { failoverDeniedReason, isFailoverEligibleError } from "./failover.js";
import type { BudgetSafetyHook, EligibleRoute, RouteDecision } from "./policy.js";
import { routeCapability } from "./runtime.js";

export type RouteAttempt = {
  attemptIndex: number;
  providerId: string;
  modelId: string;
  result: ProviderResult;
  failoverAllowed?: boolean;
  failoverReason?: string;
};

export type ExecutionPlan = {
  decision: RouteDecision;
  attempts: RouteAttempt[];
  final: ProviderResult | null;
  explanation: string;
  ordered: EligibleRoute[];
};

export function uniqueProviderRoutes(eligible: EligibleRoute[]): EligibleRoute[] {
  const seen = new Set<string>();
  const ordered: EligibleRoute[] = [];
  for (const row of eligible) {
    if (seen.has(row.providerId)) continue;
    seen.add(row.providerId);
    ordered.push(row);
  }
  return ordered;
}

export async function executeWithFailover(input: {
  config: AppConfig;
  pool: ProviderPool;
  capability: CapabilityId;
  privacyClass: PrivacyClass;
  allowFailover: boolean;
  forceProvider?: string;
  request: ProviderInvokeRequest;
  /** Reserved. Callers may attach future cost gates; this phase does not invent limits. */
  budget?: BudgetSafetyHook;
}): Promise<ExecutionPlan> {
  const routed = routeCapability({
    config: input.config,
    pool: input.pool,
    capability: input.capability,
    privacyClass: input.privacyClass,
    forceProvider: input.forceProvider,
  });
  const decision = routed.decision;
  if (!decision.ok) {
    return { decision, attempts: [], final: null, explanation: decision.explanation, ordered: [] };
  }

  let ordered = uniqueProviderRoutes(decision.eligible);
  if (input.forceProvider) {
    ordered = ordered.filter((row) => row.providerId === input.forceProvider);
  }
  const allowFailover = input.capability === "IMAGE" ? false : input.allowFailover;
  const maxAttempts = input.capability === "IMAGE" ? 1 : Math.max(1, input.config.maxProviderAttempts);
  const attempts: RouteAttempt[] = [];
  let explanation = decision.explanation;

  for (const route of ordered) {
    if (attempts.length >= maxAttempts) {
      explanation += `; stopped: attempt limit ${maxAttempts}`;
      break;
    }
    if (attempts.length > 0) {
      const previous = attempts[attempts.length - 1]!;
      const previousError = previous.result.ok ? undefined : previous.result.error;
      const denied = failoverDeniedReason({
        allowFailover,
        error: previousError,
        attempts: attempts.length,
        maxAttempts,
        nextEligible: true,
      });
      if (denied) {
        previous.failoverAllowed = false;
        previous.failoverReason = denied;
        explanation += `; failover denied: ${denied}`;
        break;
      }
      previous.failoverAllowed = true;
      previous.failoverReason = `Failover permitted for ${previousError}; next=${route.providerId}/${route.modelId}`;
      explanation += `; failover ${previous.providerId} ${previousError} → ${route.providerId}/${route.modelId}`;
    }

    const adapter = input.pool.get(route.providerId);
    const result = adapter
      ? await adapter.invoke({ ...input.request, model: route.modelId })
      : ({
          ok: false,
          provider: route.providerId,
          model: route.modelId,
          error: "unavailable",
          detail: "Selected provider adapter is not bound.",
          latencyMs: 0,
        } satisfies ProviderResult);
    attempts.push({ attemptIndex: attempts.length + 1, providerId: route.providerId, modelId: route.modelId, result });
    if (result.ok) {
      explanation += `; completed=${route.providerId}/${route.modelId}`;
      break;
    }
    if (!isFailoverEligibleError(result.error) || !allowFailover) {
      const denied = failoverDeniedReason({
        allowFailover,
        error: result.error,
        attempts: attempts.length,
        maxAttempts,
        nextEligible: ordered.length > attempts.length,
      });
      attempts[attempts.length - 1]!.failoverAllowed = false;
      attempts[attempts.length - 1]!.failoverReason = denied;
      explanation += `; stop: ${denied}`;
      break;
    }
  }

  return {
    decision,
    attempts,
    final: attempts.at(-1)?.result ?? null,
    explanation,
    ordered,
  };
}

export function boundProvider(pool: ProviderPool): IntelligenceProvider {
  return pool.primary();
}
