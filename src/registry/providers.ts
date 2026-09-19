import type { CapabilityId } from "../contracts/capabilities.js";
import type { PrivacyClass } from "../contracts/privacy.js";
import { TEXT_CAPABILITIES } from "../capabilities/catalog.js";
import type { DeploymentType } from "../contracts/response.js";

export type ProviderType = "llm" | "speech" | "image" | "video" | "music" | "embedding" | "test" | "unbound";

export type ProviderCatalogRecord = {
  id: string;
  type: ProviderType;
  deploymentType: DeploymentType;
  capabilities: CapabilityId[];
  usageReporting: boolean;
  pricingMetadata: boolean;
  /** Highest privacy class this deployment type may receive by default. */
  maxPrivacyClass: PrivacyClass;
};

export const PROVIDER_CATALOG: ProviderCatalogRecord[] = [
  {
    id: "openai",
    type: "llm",
    deploymentType: "cloud",
    capabilities: [...TEXT_CAPABILITIES, "VISION", "EMBED", "SPEECH_TO_TEXT", "TEXT_TO_SPEECH", "IMAGE"],
    usageReporting: true,
    pricingMetadata: true,
    maxPrivacyClass: "PRIVATE",
  },
  {
    id: "anthropic",
    type: "llm",
    deploymentType: "cloud",
    capabilities: [...TEXT_CAPABILITIES, "VISION"],
    usageReporting: true,
    pricingMetadata: true,
    maxPrivacyClass: "PRIVATE",
  },
  {
    id: "gemini",
    type: "llm",
    deploymentType: "cloud",
    capabilities: [...TEXT_CAPABILITIES, "MUSIC"],
    usageReporting: true,
    pricingMetadata: true,
    maxPrivacyClass: "PRIVATE",
  },
  {
    id: "mistral",
    type: "llm",
    deploymentType: "cloud",
    capabilities: [...TEXT_CAPABILITIES],
    usageReporting: true,
    pricingMetadata: true,
    maxPrivacyClass: "PRIVATE",
  },
  {
    id: "xai",
    type: "llm",
    deploymentType: "cloud",
    capabilities: [...TEXT_CAPABILITIES],
    usageReporting: true,
    pricingMetadata: true,
    maxPrivacyClass: "PRIVATE",
  },
  {
    id: "test",
    type: "test",
    deploymentType: "internal",
    capabilities: [...TEXT_CAPABILITIES],
    usageReporting: true,
    pricingMetadata: false,
    maxPrivacyClass: "HIGHLY_SENSITIVE",
  },
  {
    id: "unbound",
    type: "unbound",
    deploymentType: "internal",
    capabilities: [],
    usageReporting: false,
    pricingMetadata: false,
    maxPrivacyClass: "PUBLIC",
  },
];

export function getProviderCatalog(id: string): ProviderCatalogRecord | undefined {
  return PROVIDER_CATALOG.find((row) => row.id === id);
}
