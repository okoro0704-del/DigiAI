import type { AppConfig } from "../config.js";
import { OpenAiProvider } from "./openai.js";
import type { IntelligenceProvider } from "./types.js";
import { TestProvider } from "./test.js";
import { UnboundProvider } from "./unbound.js";

export function createProvider(config: AppConfig, override?: IntelligenceProvider): IntelligenceProvider {
  if (override) return override;
  if (config.aiProvider === "test") return new TestProvider();
  if (config.aiProvider === "openai" && config.openaiApiKey) {
    return new OpenAiProvider(config.openaiApiKey, config.aiModel, config.providerTimeoutMs);
  }
  if (config.aiProvider === "openai") return new UnboundProvider();
  return new UnboundProvider();
}

export function providerHealth(provider: IntelligenceProvider): "configured" | "unbound" {
  return provider.configured ? "configured" : "unbound";
}
