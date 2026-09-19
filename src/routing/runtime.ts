import type { AppConfig } from "../config.js";
import { TEXT_CAPABILITIES } from "../capabilities/catalog.js";
import type { CapabilityId } from "../contracts/capabilities.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import { privacyRank } from "../contracts/privacy.js";
import { listCatalogModels, type ModelRecord } from "../registry/models.js";
import { getProviderCatalog, PROVIDER_CATALOG, type ProviderCatalogRecord } from "../registry/providers.js";
import type { IntelligenceProvider } from "../providers/types.js";
import { decideRoute, type RouteDecision, type RuntimeProvider } from "./policy.js";

export type RuntimeRegistry = {
  providers: RuntimeProvider[];
  models: ModelRecord[];
};

function cloudCappedPrivacy(catalog: ProviderCatalogRecord, config: AppConfig): PrivacyClass {
  if (catalog.deploymentType !== "cloud") return catalog.maxPrivacyClass;
  return privacyRank(config.cloudMaxPrivacy) < privacyRank(catalog.maxPrivacyClass)
    ? config.cloudMaxPrivacy
    : catalog.maxPrivacyClass;
}

function synthesizeCatalog(bound: IntelligenceProvider): ProviderCatalogRecord {
  return (
    getProviderCatalog(bound.name) ?? {
      id: bound.name,
      type: bound.name === "unbound" ? "unbound" : "test",
      deploymentType: "internal",
      capabilities: [...TEXT_CAPABILITIES],
      usageReporting: true,
      pricingMetadata: false,
      maxPrivacyClass: "HIGHLY_SENSITIVE",
    }
  );
}

function synthesizeModel(bound: IntelligenceProvider, catalog: ProviderCatalogRecord): ModelRecord {
  return {
    id: bound.name === "openai" ? "gpt-4o-mini" : bound.name,
    providerId: catalog.id,
    capabilities: catalog.capabilities.length ? catalog.capabilities : [...TEXT_CAPABILITIES],
    modality: ["text"],
    structuredOutput: true,
    toolCalling: false,
    streaming: false,
    status: "enabled",
    deploymentType: catalog.deploymentType,
  };
}

export function buildRuntimeRegistry(config: AppConfig, bound: IntelligenceProvider): RuntimeRegistry {
  const restrict = config.enabledProviders.length > 0;
  const catalogs = PROVIDER_CATALOG.some((row) => row.id === bound.name)
    ? PROVIDER_CATALOG
    : [...PROVIDER_CATALOG, synthesizeCatalog(bound)];

  const providers: RuntimeProvider[] = catalogs.map((catalog) => {
    const isBound = bound.name === catalog.id;
    const credentialPresent = isBound && bound.configured && catalog.id !== "unbound";
    const configured = isBound && bound.configured && catalog.id !== "unbound";
    const enabled = restrict ? config.enabledProviders.includes(catalog.id) && isBound : isBound;
    return {
      catalog,
      configured,
      enabled,
      credentialPresent,
      adapterName: isBound ? bound.name : catalog.id,
      maxPrivacyClass: cloudCappedPrivacy(catalog, config),
    };
  });

  const models = listCatalogModels().map((model) => ({
    ...model,
    capabilities: [...model.capabilities],
    status: config.disabledModels.includes(model.id) ? ("disabled" as const) : model.status,
  }));

  if (!models.some((model) => model.providerId === bound.name)) {
    models.push(synthesizeModel(bound, synthesizeCatalog(bound)));
  }

  return { providers, models };
}

export function routeCapability(input: {
  config: AppConfig;
  provider: IntelligenceProvider;
  capability: CapabilityId;
  privacyClass: PrivacyClass;
}): { registry: RuntimeRegistry; decision: RouteDecision } {
  const registry = buildRuntimeRegistry(input.config, input.provider);
  const decision = decideRoute({
    capability: input.capability,
    privacyClass: input.privacyClass,
    providers: registry.providers,
    models: registry.models,
    defaultModel: input.config.defaultModels[input.capability] || input.config.aiModel,
  });
  return { registry, decision };
}
