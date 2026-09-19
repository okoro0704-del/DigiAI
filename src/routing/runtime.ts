import type { AppConfig } from "../config.js";
import { TEXT_CAPABILITIES } from "../capabilities/catalog.js";
import type { CapabilityId } from "../contracts/capabilities.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import { privacyRank } from "../contracts/privacy.js";
import { listCatalogModels, type ModelRecord } from "../registry/models.js";
import { getProviderCatalog, PROVIDER_CATALOG, type ProviderCatalogRecord } from "../registry/providers.js";
import type { IntelligenceProvider } from "../providers/types.js";
import { ProviderPool } from "../providers/pool.js";
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
    id: bound.name === "openai" ? "gpt-4o-mini" : bound.name === "gemini" ? "gemini-2.0-flash" : bound.name,
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

export function asPool(bound: IntelligenceProvider | ProviderPool): ProviderPool {
  return bound instanceof ProviderPool ? bound : new ProviderPool({ [bound.name]: bound });
}

export function buildRuntimeRegistry(config: AppConfig, bound: IntelligenceProvider | ProviderPool): RuntimeRegistry {
  const pool = asPool(bound);
  const restrict = config.enabledProviders.length > 0;
  const extra = pool.names().filter((name) => !PROVIDER_CATALOG.some((row) => row.id === name));
  const catalogs = extra.length
    ? [...PROVIDER_CATALOG, ...extra.map((name) => synthesizeCatalog(pool.get(name)!))]
    : PROVIDER_CATALOG;

  const providers: RuntimeProvider[] = catalogs.map((catalog) => {
    const adapter = pool.get(catalog.id);
    const present = Boolean(adapter && adapter.configured && catalog.id !== "unbound");
    const enabled = restrict ? config.enabledProviders.includes(catalog.id) : catalog.id !== "unbound";
    return {
      catalog,
      configured: present,
      enabled,
      credentialPresent: present,
      adapterName: adapter?.name ?? catalog.id,
      maxPrivacyClass: cloudCappedPrivacy(catalog, config),
    };
  });

  const models = listCatalogModels().map((model) => ({
    ...model,
    capabilities: [...model.capabilities],
    status: config.disabledModels.includes(model.id) ? ("disabled" as const) : model.status,
  }));

  for (const name of pool.names()) {
    if (!models.some((model) => model.providerId === name)) {
      const adapter = pool.get(name);
      if (adapter) models.push(synthesizeModel(adapter, synthesizeCatalog(adapter)));
    }
  }

  return { providers, models };
}

export function routeCapability(input: {
  config: AppConfig;
  provider?: IntelligenceProvider;
  pool?: ProviderPool;
  capability: CapabilityId;
  privacyClass: PrivacyClass;
  forceProvider?: string;
}): { registry: RuntimeRegistry; decision: RouteDecision } {
  const bound = input.pool ?? input.provider;
  if (!bound) throw new Error("routeCapability requires a provider pool.");
  const registry = buildRuntimeRegistry(input.config, bound);
  const decision = decideRoute({
    capability: input.capability,
    privacyClass: input.privacyClass,
    providers: registry.providers,
    models: registry.models,
    defaultModel: input.config.defaultModels[input.capability] || input.config.aiModel,
    providerPriority: input.config.providerPriority,
    forceProvider: input.forceProvider,
  });
  return { registry, decision };
}
