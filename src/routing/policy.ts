import type { CapabilityId } from "../contracts/capabilities.js";
import { getCapability } from "../capabilities/catalog.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import { privacyRank } from "../contracts/privacy.js";
import type { ModelRecord } from "../registry/models.js";
import type { ProviderCatalogRecord } from "../registry/providers.js";

export type EligibleRoute = {
  providerId: string;
  modelId: string;
  adapterName: string;
};

export type RouteExclusion = {
  providerId?: string;
  modelId?: string;
  reason: string;
};

export type RouteDecision =
  | {
      ok: true;
      capability: CapabilityId;
      selected: EligibleRoute;
      eligible: EligibleRoute[];
      excluded: RouteExclusion[];
      explanation: string;
    }
  | {
      ok: false;
      capability: CapabilityId;
      error: "unsupported_capability" | "provider_not_configured" | "provider_unavailable";
      eligible: EligibleRoute[];
      excluded: RouteExclusion[];
      explanation: string;
      detail: string;
    };

export type RuntimeProvider = {
  catalog: ProviderCatalogRecord;
  configured: boolean;
  enabled: boolean;
  credentialPresent: boolean;
  adapterName: string;
  maxPrivacyClass: PrivacyClass;
};

export function decideRoute(input: {
  capability: CapabilityId;
  privacyClass: PrivacyClass;
  providers: RuntimeProvider[];
  models: ModelRecord[];
  defaultModel?: string;
}): RouteDecision {
  const definition = getCapability(input.capability);
  const excluded: RouteExclusion[] = [];
  const eligible: EligibleRoute[] = [];

  const implementable = input.models.some((model) => model.capabilities.includes(input.capability) && model.status === "enabled");
  if (!implementable) {
    return {
      ok: false,
      capability: input.capability,
      error: "unsupported_capability",
      eligible,
      excluded: [{ reason: `${input.capability} has no enabled model adapter in this phase.` }],
      explanation: `${input.capability} is cataloged but not implementable.`,
      detail: `${input.capability} is not available on any configured provider.`,
    };
  }

  if (!definition.privacyEligible.includes(input.privacyClass)) {
    return {
      ok: false,
      capability: input.capability,
      error: "unsupported_capability",
      eligible,
      excluded: [{ reason: `${input.capability} is not eligible for ${input.privacyClass}.` }],
      explanation: `Capability privacy policy rejected ${input.privacyClass}.`,
      detail: `${input.capability} cannot run under ${input.privacyClass}.`,
    };
  }

  for (const provider of input.providers) {
    if (!provider.enabled) {
      excluded.push({ providerId: provider.catalog.id, reason: "Provider is disabled." });
      continue;
    }
    if (!provider.configured || !provider.credentialPresent) {
      excluded.push({ providerId: provider.catalog.id, reason: "Provider is not configured." });
      continue;
    }
    if (privacyRank(input.privacyClass) > privacyRank(provider.maxPrivacyClass)) {
      excluded.push({
        providerId: provider.catalog.id,
        reason: `Privacy ${input.privacyClass} exceeds provider max ${provider.maxPrivacyClass}. Silent failover is forbidden.`,
      });
      continue;
    }
    if (!provider.catalog.capabilities.includes(input.capability)) {
      excluded.push({ providerId: provider.catalog.id, reason: "Provider catalog does not list this capability." });
      continue;
    }

    const models = input.models.filter((model) => model.providerId === provider.catalog.id);
    for (const model of models) {
      if (model.status === "disabled") {
        excluded.push({ providerId: provider.catalog.id, modelId: model.id, reason: "Model is disabled." });
        continue;
      }
      if (!model.capabilities.includes(input.capability)) {
        excluded.push({ providerId: provider.catalog.id, modelId: model.id, reason: "Model does not support this capability." });
        continue;
      }
      eligible.push({
        providerId: provider.catalog.id,
        modelId: model.id,
        adapterName: provider.adapterName,
      });
    }
  }

  if (!eligible.length) {
    const configured = input.providers.some((row) => row.configured && row.enabled && row.credentialPresent);
    return {
      ok: false,
      capability: input.capability,
      error: configured ? "provider_unavailable" : "provider_not_configured",
      eligible,
      excluded,
      explanation: `No eligible route for ${input.capability}.`,
      detail: configured
        ? `No eligible provider/model for ${input.capability} under current policy.`
        : `No configured provider can serve ${input.capability}.`,
    };
  }

  const preferred = input.defaultModel
    ? eligible.find((row) => row.modelId === input.defaultModel)
    : undefined;
  const selected = preferred ?? eligible[0]!;
  return {
    ok: true,
    capability: input.capability,
    selected,
    eligible,
    excluded,
    explanation: [
      `capability=${input.capability}`,
      `selected=${selected.providerId}/${selected.modelId}`,
      `eligible=${eligible.map((row) => `${row.providerId}/${row.modelId}`).join(",") || "none"}`,
      `excluded=${excluded.map((row) => `${row.providerId ?? "?"}${row.modelId ? "/" + row.modelId : ""}:${row.reason}`).join(" | ") || "none"}`,
    ].join("; "),
  };
}
