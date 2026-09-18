import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "./types.js";

export class UnboundProvider implements IntelligenceProvider {
  readonly name = "unbound";
  readonly configured = false;

  async invoke(): Promise<ProviderResult> {
    return {
      ok: false,
      provider: this.name,
      error: "unavailable",
      detail: "No AI provider is configured for Digi AI.",
      latencyMs: 0,
    };
  }
}
