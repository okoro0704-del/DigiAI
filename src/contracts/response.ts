import type { ObjectiveCandidate } from "./objectives.js";
import type { ProvenanceItem } from "./provenance.js";
import type { NativeUsage } from "./usage.js";
import type { CapabilityId } from "./capabilities.js";
import type { GeneratedMediaResult } from "./media.js";
import type { VoiceInteractionResult } from "./speech.js";

export type DeploymentType = "cloud" | "self_hosted" | "local" | "internal";

export type UsageSnapshot = {
  usageId: string;
  provider: string;
  model?: string;
  capability?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  nativeUsage?: NativeUsage;
  estimatedProviderCost?: number | null;
  actualProviderCost?: number | null;
  pricingVersion?: string | null;
  currency?: string | null;
  digiAiUnits: null;
  latencyMs: number;
  success: boolean;
};

export type ExecutionMeta = {
  requestId: string;
  correlationId: string;
  provider: string;
  model?: string;
  capability?: string;
  latencyMs: number;
  sourcesUsed: string[];
  finishState: "completed" | "failed" | "provider_unavailable" | "source_unavailable" | "unauthorized" | "unsupported_capability";
};

export type CapabilityHealth = {
  supported: boolean;
  configured: boolean;
  runtimeVerified: boolean;
  status: "unsupported" | "unconfigured" | "configured";
  supportedProviders?: number;
  configuredProviders?: number;
  runtimeVerifiedProviders?: number;
};

export type ProviderHealthRow = {
  configured: boolean;
  credentialPresent: boolean;
  capabilities: CapabilityId[];
  runtimeStatus: "configured" | "unconfigured" | "unavailable" | "disabled";
  deploymentType: DeploymentType;
  usageReporting: boolean;
};

export type DigiAiAskSuccess = {
  ok: true;
  service: "digi-ai";
  answer: string;
  provenance: ProvenanceItem[];
  usage: UsageSnapshot;
  execution: ExecutionMeta;
  receiptId: string;
  media?: GeneratedMediaResult[];
  speech?: VoiceInteractionResult;
  objectiveCandidate?: ObjectiveCandidate;
};

export type DigiAiAskFailure = {
  ok: false;
  service: "digi-ai";
  error: string;
  message: string;
  provenance?: ProvenanceItem[];
  usage?: UsageSnapshot;
  execution?: ExecutionMeta;
  receiptId?: string;
  media?: GeneratedMediaResult[];
  speech?: VoiceInteractionResult;
};

export type DigiAiAskResponse = DigiAiAskSuccess | DigiAiAskFailure;

export type EconomicHealth = {
  usageLedger: {
    durable: boolean;
    writable: boolean;
    backend: "memory" | "postgres" | "file";
  };
  pricingCatalog: {
    loaded: boolean;
    activeVersions: number;
  };
  costAccounting: {
    enabled: boolean;
  };
};

export type HealthResponse = {
  ok: true;
  service: "digi-ai";
  status: "healthy" | "partial";
  provider: "configured" | "unbound";
  providers: Record<string, ProviderHealthRow>;
  capabilities: Record<string, CapabilityHealth>;
  usageLedger: EconomicHealth["usageLedger"];
  pricingCatalog: EconomicHealth["pricingCatalog"];
  costAccounting: EconomicHealth["costAccounting"];
  media: {
    canonicalRead: {
      configured: boolean;
      runtimeVerified: boolean;
    };
    canonicalWrite: {
      configured: boolean;
      runtimeVerified: boolean;
    };
    persistence: {
      status: "available" | "partial" | "unavailable";
    };
    canonicalPersistence: {
      available: boolean;
      status: "available" | "unavailable";
    };
  };
  audio?: {
    canonicalPersistence: {
      available: boolean;
      status: "available" | "unavailable";
    };
  };
  voiceProfiles?: {
    configuredCount: number;
  };
};
