import type { AppConfig } from "../config.js";
import { CAPABILITY_IDS } from "../contracts/capabilities.js";
import type { HealthResponse, CapabilityHealth, ProviderHealthRow } from "../contracts/response.js";
import { defaultPrivacyClass } from "../contracts/privacy.js";
import { getCapability } from "../capabilities/catalog.js";
import type { IntelligenceProvider } from "../providers/types.js";
import { ProviderPool } from "../providers/pool.js";
import { providerHealth } from "../providers/router.js";
import type { DigiAiStore } from "../store/types.js";
import { UnboundDrive, type DriveStatus, type SovereignDrive } from "../media/drive.js";
import { activePricingVersions } from "../usage/pricing-catalog.js";
import { decideRoute } from "./policy.js";
import { asPool, buildRuntimeRegistry } from "./runtime.js";

export function buildHealthResponse(
  config: AppConfig,
  provider: IntelligenceProvider | ProviderPool,
  store?: DigiAiStore,
  drive: SovereignDrive = new UnboundDrive(),
): HealthResponse {
  const pool = asPool(provider);
  const registry = buildRuntimeRegistry(config, pool);
  const privacy = defaultPrivacyClass();
  const providers: Record<string, ProviderHealthRow> = {};
  for (const row of registry.providers) {
    providers[row.catalog.id] = {
      configured: row.configured,
      credentialPresent: row.credentialPresent,
      capabilities: [...row.catalog.capabilities],
      runtimeStatus: !row.enabled
        ? "disabled"
        : row.configured
          ? "configured"
          : "unconfigured",
      deploymentType: row.catalog.deploymentType,
      usageReporting: row.catalog.usageReporting,
    };
  }

  const capabilities: Record<string, CapabilityHealth> = {};
  for (const id of CAPABILITY_IDS) {
    const supportedModels = registry.models.filter((model) => model.capabilities.includes(id) && model.status === "enabled");
    const supportedProviders = new Set(supportedModels.map((model) => model.providerId));
    const configuredProviders = registry.providers.filter(
      (row) => row.configured && row.enabled && row.catalog.capabilities.includes(id),
    );
    const decision = decideRoute({
      capability: id,
      privacyClass: getCapability(id).privacyEligible.includes(privacy) ? privacy : (getCapability(id).privacyEligible[0] ?? privacy),
      providers: registry.providers,
      models: registry.models,
      defaultModel: config.defaultModels[id] || config.aiModel,
      providerPriority: config.providerPriority,
    });
    const configured = decision.ok;
    capabilities[id] = {
      supported: supportedModels.length > 0,
      configured,
      runtimeVerified: false,
      status: !supportedModels.length ? "unsupported" : configured ? "configured" : "unconfigured",
      supportedProviders: supportedProviders.size,
      configuredProviders: configuredProviders.length,
      runtimeVerifiedProviders: 0,
    };
  }

  const ledger = store?.ledgerStatus() ?? { durable: false, writable: false, backend: "memory" as const };
  return {
    ok: true,
    service: "digi-ai",
    status: "partial",
    provider: providerHealth(pool.primary()),
    providers,
    capabilities,
    usageLedger: {
      durable: ledger.durable,
      writable: ledger.writable,
      backend: ledger.backend,
    },
    pricingCatalog: {
      loaded: true,
      activeVersions: activePricingVersions().length,
    },
    costAccounting: {
      enabled: true,
    },
    media: mediaHealth(drive),
  };
}

function mediaHealth(drive: SovereignDrive): HealthResponse["media"] {
  const status: DriveStatus = drive.status();
  const readConfigured = Boolean(status.configured ?? status.read);
  const writeConfigured = Boolean(status.configured ?? status.write);
  const readVerified = Boolean(status.runtimeReadVerified);
  const writeVerified = Boolean(status.runtimeWriteVerified);
  let persistence: "available" | "partial" | "unavailable" = "unavailable";
  if (readConfigured && writeConfigured && readVerified && writeVerified) persistence = "available";
  else if (readConfigured || writeConfigured) persistence = "partial";
  return {
    canonicalRead: {
      configured: readConfigured,
      runtimeVerified: readVerified,
    },
    canonicalWrite: {
      configured: writeConfigured,
      runtimeVerified: writeVerified,
    },
    persistence: { status: persistence },
    canonicalPersistence: {
      available: Boolean(status.write),
      status: status.write ? "available" : "unavailable",
    },
  };
}
