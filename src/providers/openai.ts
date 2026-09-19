import { classifyProviderHttpError } from "./errors.js";
import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "./types.js";

type OpenAiChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export class OpenAiProvider implements IntelligenceProvider {
  readonly name = "openai";
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async invoke(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = request.model ?? this.model;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: request.temperature ?? 0.4,
          messages: request.messages,
        }),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { type?: string; code?: string; message?: string };
        } | null;
        const classified = classifyProviderHttpError(res.status, body);
        return {
          ok: false,
          provider: this.name,
          model,
          error: classified.error,
          detail: classified.detail,
          latencyMs,
        };
      }
      const raw = (await res.json()) as OpenAiChatResponse;
      const text = raw.choices?.[0]?.message?.content?.trim();
      if (!text) {
        return {
          ok: false,
          provider: this.name,
          model,
          error: "empty",
          detail: "Provider returned an empty response.",
          latencyMs,
        };
      }
      return {
        ok: true,
        provider: this.name,
        model: raw.model ?? model,
        text,
        usage: {
          inputTokens: raw.usage?.prompt_tokens,
          outputTokens: raw.usage?.completion_tokens,
          totalTokens: raw.usage?.total_tokens,
        },
        finishReason: raw.choices?.[0]?.finish_reason,
        providerRequestId: raw.id ?? res.headers.get("x-request-id") ?? undefined,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const timeout = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        provider: this.name,
        model,
        error: timeout ? "timeout" : "unavailable",
        detail: timeout ? "Provider timed out." : "Provider is unreachable.",
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
