import type { AppConfig } from "../config.js";
import { createProviderPool, type ProviderPool } from "./pool.js";
import type { IntelligenceProvider } from "./types.js";

export function createProvider(config: AppConfig, override?: IntelligenceProvider): IntelligenceProvider {
  return createProviderPool(config, override).primary();
}

export function createProviders(
  config: AppConfig,
  override?: IntelligenceProvider | Record<string, IntelligenceProvider>,
): ProviderPool {
  return createProviderPool(config, override);
}

export function providerHealth(provider: IntelligenceProvider): "configured" | "unbound" {
  return provider.configured ? "configured" : "unbound";
}
