import type { AppConfig } from "../config.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAiProvider } from "./openai.js";
import { TestProvider } from "./test.js";
import type { IntelligenceProvider } from "./types.js";
import { UnboundProvider } from "./unbound.js";

export class ProviderPool {
  constructor(readonly adapters: Record<string, IntelligenceProvider>) {}

  get(id: string): IntelligenceProvider | undefined {
    return this.adapters[id];
  }

  names(): string[] {
    return Object.keys(this.adapters);
  }

  primary(): IntelligenceProvider {
    return (
      this.adapters.openai ??
      this.adapters.gemini ??
      this.adapters.test ??
      this.adapters.unbound ??
      Object.values(this.adapters)[0] ??
      new UnboundProvider()
    );
  }
}

export function createProviderPool(
  config: AppConfig,
  override?: IntelligenceProvider | Record<string, IntelligenceProvider>,
): ProviderPool {
  if (isAdapter(override)) {
    return new ProviderPool({ [override.name]: override });
  }
  if (override && typeof override === "object") {
    return new ProviderPool({ ...override });
  }
  if (config.aiProvider === "test") return new ProviderPool({ test: new TestProvider() });

  const adapters: Record<string, IntelligenceProvider> = {};
  if (config.openaiApiKey) {
    adapters.openai = new OpenAiProvider(config.openaiApiKey, config.aiModel, config.providerTimeoutMs);
  }
  if (config.geminiApiKey) {
    adapters.gemini = new GeminiProvider(config.geminiApiKey, config.geminiModel, config.providerTimeoutMs);
  }
  if (!Object.keys(adapters).length) adapters.unbound = new UnboundProvider();
  return new ProviderPool(adapters);
}

function isAdapter(value: unknown): value is IntelligenceProvider {
  return Boolean(
    value &&
      typeof value === "object" &&
      "invoke" in value &&
      typeof (value as IntelligenceProvider).invoke === "function" &&
      typeof (value as IntelligenceProvider).name === "string",
  );
}
