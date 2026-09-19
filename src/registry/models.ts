import type { CapabilityId } from "../contracts/capabilities.js";
import type { DeploymentType } from "../contracts/response.js";
import { TEXT_CAPABILITIES } from "../capabilities/catalog.js";

export type { DeploymentType };

export type ModelRecord = {
  id: string;
  providerId: string;
  capabilities: CapabilityId[];
  modality: string[];
  contextWindow?: number;
  structuredOutput: boolean;
  toolCalling: boolean;
  streaming: boolean;
  status: "enabled" | "disabled";
  pricingRef?: string;
  deploymentType: DeploymentType;
};

export const OPENAI_TEXT_CAPABILITIES: CapabilityId[] = [...TEXT_CAPABILITIES];

export const CATALOG_MODELS: ModelRecord[] = [
  {
    id: "gpt-4o-mini",
    providerId: "openai",
    capabilities: OPENAI_TEXT_CAPABILITIES,
    modality: ["text"],
    contextWindow: 128000,
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    status: "enabled",
    pricingRef: "openai:gpt-4o-mini",
    deploymentType: "cloud",
  },
  {
    id: "gpt-4o",
    providerId: "openai",
    capabilities: [...OPENAI_TEXT_CAPABILITIES, "VISION"],
    modality: ["text", "image"],
    contextWindow: 128000,
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    status: "enabled",
    pricingRef: "openai:gpt-4o",
    deploymentType: "cloud",
  },
  {
    id: "gpt-image-1",
    providerId: "openai",
    capabilities: ["IMAGE"],
    modality: ["image"],
    structuredOutput: false,
    toolCalling: false,
    streaming: false,
    status: "enabled",
    pricingRef: "openai:gpt-image-1",
    deploymentType: "cloud",
  },
  {
    id: "gemini-2.0-flash",
    providerId: "gemini",
    capabilities: OPENAI_TEXT_CAPABILITIES,
    modality: ["text"],
    contextWindow: 1048576,
    structuredOutput: true,
    toolCalling: true,
    streaming: true,
    status: "enabled",
    pricingRef: "gemini:gemini-2.0-flash",
    deploymentType: "cloud",
  },
  {
    id: "test",
    providerId: "test",
    capabilities: OPENAI_TEXT_CAPABILITIES,
    modality: ["text"],
    structuredOutput: true,
    toolCalling: false,
    streaming: false,
    status: "enabled",
    deploymentType: "internal",
  },
];

export function listCatalogModels(): ModelRecord[] {
  return CATALOG_MODELS.map((row) => ({ ...row, capabilities: [...row.capabilities] }));
}
