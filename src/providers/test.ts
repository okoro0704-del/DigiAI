import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "./types.js";

export class TestProvider implements IntelligenceProvider {
  readonly name = "test";
  readonly configured = true;
  readonly calls: ProviderInvokeRequest[] = [];

  constructor(private readonly responder?: (request: ProviderInvokeRequest) => string) {}

  async invoke(request: ProviderInvokeRequest): Promise<ProviderResult> {
    this.calls.push(request);
    const started = Date.now();
    const user = request.messages.find((m) => m.role === "user")?.content ?? "";
    const text = this.responder
      ? this.responder(request)
      : `Digi AI test response. Request: ${user.slice(0, 180)}`;
    return {
      ok: true,
      provider: this.name,
      model: "test",
      text,
      usage: {
        inputTokens: Math.ceil(user.length / 4),
        outputTokens: Math.ceil(text.length / 4),
        totalTokens: Math.ceil((user.length + text.length) / 4),
      },
      finishReason: "stop",
      providerRequestId: "test-req",
      latencyMs: Date.now() - started,
    };
  }
}
