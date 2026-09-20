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
import { AUTHORITY_POLICY_VERSION } from "../contracts/authority.js";
import { TOOL_CONNECTOR_POLICY_VERSION } from "../contracts/connectors.js";
import { connectorRegistryConfigured } from "../connectors/registry.js";
import { registryConfigured } from "../execution/registry.js";
import { commercialPolicyConfigured, listMeteringPolicies } from "../credits/policy.js";
import { enabledVoiceProfileCount } from "../registry/voices.js";
import { activePricingVersions } from "../usage/pricing-catalog.js";
import { credentialHealth } from "../credentials/factory.js";
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
    const voiceSupported = Boolean(
      capabilities.SPEECH_TO_TEXT?.supported && capabilities.THINK?.supported && capabilities.TEXT_TO_SPEECH?.supported,
    );
    const configured = id === "VOICE"
      ? Boolean(capabilities.SPEECH_TO_TEXT?.configured && capabilities.THINK?.configured && capabilities.TEXT_TO_SPEECH?.configured)
      : decision.ok;
    const supported = id === "VOICE" ? voiceSupported : supportedModels.length > 0;
    capabilities[id] = {
      supported,
      configured,
      runtimeVerified: false,
      status: !supported ? "unsupported" : configured ? "configured" : "unconfigured",
      supportedProviders: id === "VOICE" ? (voiceSupported ? 1 : 0) : supportedProviders.size,
      configuredProviders: id === "VOICE" ? (configured ? 1 : 0) : configuredProviders.length,
      runtimeVerifiedProviders: 0,
    };
  }

  const ledger = store?.ledgerStatus() ?? { durable: false, writable: false, backend: "memory" as const };
  const credits = store?.creditStatus() ?? ledger;
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
    audio: {
      canonicalPersistence: {
        available: Boolean(drive.status().write),
        status: drive.status().write ? "available" : "unavailable",
      },
    },
    voiceProfiles: {
      configuredCount: enabledVoiceProfileCount(),
    },
    music: {
      canonicalPersistence: {
        available: Boolean(drive.status().write),
        status: drive.status().write ? "available" : "unavailable",
      },
    },
    video: {
      canonicalPersistence: {
        available: Boolean(drive.status().write),
        status: drive.status().write ? "available" : "unavailable",
      },
    },
    economics: {
      creditLedger: {
        durable: credits.durable,
        writable: credits.writable,
        backend: credits.backend,
      },
      metering: {
        loaded: listMeteringPolicies().length > 0,
        mode: config.economicsMode,
        commercialPolicyConfigured: commercialPolicyConfigured(),
      },
      reservations: {
        supported: true,
      },
    },
    orchestration: {
      supported: true,
      durable: (store?.orchestrationStatus() ?? ledger).durable,
      backend: (store?.orchestrationStatus() ?? ledger).backend,
      planner: {
        configured: true,
        runtimeVerified: false,
      },
      execution: {
        maxSteps: config.orchestrationMaxSteps,
        maxParallelSteps: config.orchestrationMaxParallelSteps,
      },
      economics: {
        mode: config.economicsMode,
      },
    },
    authority: {
      supported: true,
      deterministic: true,
      durable: (store?.authorityStatus() ?? ledger).durable,
      backend: (store?.authorityStatus() ?? ledger).backend,
      policy: {
        loaded: true,
        version: AUTHORITY_POLICY_VERSION,
      },
      externalActionExecution: {
        supported: false,
      },
      consequentialAutomaticExecution: {
        enabled: false,
      },
    },
    actionExecution: {
      supported: true,
      durable: (store?.actionExecutionStatus() ?? ledger).durable,
      backend: (store?.actionExecutionStatus() ?? ledger).backend,
      registry: { configured: registryConfigured() },
      realExternalExecutors: { enabled: false },
      fixtureExecutors: { available: true },
      authorizationRequired: true,
      unknownOutcomeSupported: true,
      reconciliationSupported: "fixture",
    },
    toolConnectors: {
      supported: true,
      registry: { configured: connectorRegistryConfigured() },
      policy: { loaded: true, version: TOOL_CONNECTOR_POLICY_VERSION },
      credentialBackend: { configured: false },
      realConsequentialWrites: { enabled: false },
      fixtures: { enabled: true },
      unknownOutcome: { supported: true },
      reconciliation: { supported: true },
    },
    credentials: credentialHealth(),
    mybrandosConnector: {
      configured: Boolean(config.mybrandosUrl),
      mode: "read-only",
      authenticated: "not-required-for-public",
      realWritesEnabled: false,
      s2sInbound: false,
    },
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
