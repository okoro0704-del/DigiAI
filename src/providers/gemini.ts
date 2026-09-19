import type { IntelligenceProvider, ProviderInvokeRequest, ProviderResult } from "./types.js";

type GeminiGenerateResponse = {
  responseId?: string;
  modelVersion?: string;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { code?: number; status?: string; message?: string };
};

export class GeminiProvider implements IntelligenceProvider {
  readonly name = "gemini";
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async invoke(request: ProviderInvokeRequest): Promise<ProviderResult> {
    if (request.capability === "MUSIC") return this.compose(request);
    const started = Date.now();
    const model = (request.model ?? this.model).replace(/^models\//, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const system = request.messages.filter((row) => row.role === "system").map((row) => row.content).join("\n\n");
    const user = request.messages.filter((row) => row.role === "user").map((row) => row.content).join("\n\n");
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: request.temperature ?? 0.4,
            ...(request.structuredOutput ? { responseMimeType: "application/json" } : {}),
          },
        }),
      });
      const latencyMs = Date.now() - started;
      const raw = (await res.json().catch(() => null)) as GeminiGenerateResponse | null;
      if (!res.ok) {
        return { ok: false, provider: this.name, model, ...classifyGeminiHttpError(res.status, raw), latencyMs };
      }
      if (raw?.promptFeedback?.blockReason || isSafetyFinish(raw?.candidates?.[0]?.finishReason)) {
        return {
          ok: false,
          provider: this.name,
          model,
          error: "safety_refused",
          detail: "The provider refused this request under its safety policy.",
          latencyMs,
        };
      }
      const text = raw?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!text) {
        return { ok: false, provider: this.name, model, error: "empty", detail: "Provider returned an empty response.", latencyMs };
      }
      return {
        ok: true,
        provider: this.name,
        model: raw?.modelVersion ?? model,
        text,
        usage: {
          inputTokens: raw?.usageMetadata?.promptTokenCount,
          outputTokens: raw?.usageMetadata?.candidatesTokenCount,
          totalTokens: raw?.usageMetadata?.totalTokenCount,
          cachedTokens: raw?.usageMetadata?.cachedContentTokenCount,
        },
        finishReason: raw?.candidates?.[0]?.finishReason,
        providerRequestId: raw?.responseId,
        latencyMs,
      };
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        provider: this.name,
        model,
        error: timeout ? "timeout" : "unavailable",
        detail: timeout ? "Provider timed out." : "Provider is unreachable.",
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async compose(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = (request.model ?? "lyria-3-clip-preview").replace(/^models\//, "");
    const brief = request.messages.filter((row) => row.role === "user").map((row) => row.content).join("\n\n").trim();
    if (!brief) {
      return { ok: false, provider: this.name, model, error: "invalid_music_request", detail: "MUSIC requires a creative brief.", latencyMs: 0 };
    }
    const timeoutMs = Math.max(this.timeoutMs, 120_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: brief }] }],
          generationConfig: {
            responseModalities: ["AUDIO", "TEXT"],
            ...(request.outputFormat === "wav" ? { response_format: "wav" } : {}),
          },
        }),
      });
      const latencyMs = Date.now() - started;
      const raw = (await res.json().catch(() => null)) as GeminiGenerateResponse | null;
      if (!res.ok) {
        return { ok: false, provider: this.name, model, ...classifyGeminiHttpError(res.status, raw), latencyMs };
      }
      if (raw?.promptFeedback?.blockReason || isSafetyFinish(raw?.candidates?.[0]?.finishReason)) {
        return {
          ok: false,
          provider: this.name,
          model,
          error: "safety_refused",
          detail: "The provider refused this request under its safety policy.",
          latencyMs,
        };
      }
      const parts = raw?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((part) => part.text ?? "").join("").trim();
      const audio = parts.find((part) => part.inlineData?.data);
      if (!audio?.inlineData?.data) {
        return { ok: false, provider: this.name, model, error: "generation_failed", detail: "The provider did not return generated music audio.", latencyMs };
      }
      const bytes = Buffer.from(audio.inlineData.data, "base64");
      const clip = model.includes("clip");
      return {
        ok: true,
        provider: this.name,
        model: raw?.modelVersion ?? model,
        text: text || "Generated original musical audio. This is synthesized music, not a published song.",
        media: [{
          mimeType: audio.inlineData.mimeType || (request.outputFormat === "wav" ? "audio/wav" : "audio/mpeg"),
          byteSize: bytes.length,
          contentBase64: bytes.toString("base64"),
          durationSeconds: clip ? 30 : request.durationSeconds,
          requestedDurationSeconds: request.durationSeconds,
          sampleRate: 44100,
          channels: 2,
        }],
        usage: {
          trackCount: 1,
          generatedSeconds: clip ? 30 : undefined,
          inputCharacters: brief.length,
          outputBytes: bytes.length,
          providerNativeUnitAmount: 1,
        },
        providerRequestId: raw?.responseId,
        latencyMs,
      };
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        provider: this.name,
        model,
        error: timeout ? "timeout" : "unavailable",
        detail: timeout ? "Provider timed out." : "Provider is unreachable.",
        latencyMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isSafetyFinish(reason?: string) {
  const value = String(reason ?? "").toUpperCase();
  return value === "SAFETY" || value === "BLOCKLIST" || value === "PROHIBITED_CONTENT" || value === "RECITATION";
}

function sanitizeGeminiDetail(detail: string): string {
  return detail
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, "[redacted]")
    .replace(/key[=:]\s*\S+/gi, "key=[redacted]");
}

export function classifyGeminiHttpError(
  status: number,
  body: GeminiGenerateResponse | null,
): { error: Extract<ProviderResult, { ok: false }>["error"]; detail: string } {
  const statusName = String(body?.error?.status ?? "").toUpperCase();
  const message = String(body?.error?.message ?? "").toLowerCase();
  const wrap = (error: Extract<ProviderResult, { ok: false }>["error"], detail: string) => ({
    error,
    detail: sanitizeGeminiDetail(detail),
  });
  if (status === 429 || statusName.includes("RESOURCE_EXHAUSTED") || message.includes("rate")) {
    if (message.includes("quota") || message.includes("billing")) {
      return wrap(message.includes("billing") ? "billing" : "quota", "AI reasoning needs provider billing attention.");
    }
    return wrap("rate_limited", "AI reasoning is temporarily rate limited.");
  }
  if (status === 403 || status === 401 || statusName.includes("UNAUTHENTICATED") || statusName.includes("PERMISSION_DENIED")) {
    return wrap("auth_failed", "AI provider authentication failed.");
  }
  if (message.includes("billing") || message.includes("payment")) {
    return wrap("billing", "AI reasoning needs provider billing attention.");
  }
  if (message.includes("quota")) {
    return wrap("quota", "AI reasoning needs provider billing attention.");
  }
  if (status === 400 || statusName.includes("INVALID_ARGUMENT")) {
    return wrap("invalid_request", "The provider rejected the request as invalid.");
  }
  return wrap("provider_error", "AI reasoning is temporarily unavailable.");
}
