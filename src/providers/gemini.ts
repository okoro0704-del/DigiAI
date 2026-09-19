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
    if (request.capability === "VIDEO") return this.generateVideo(request);
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

  private async generateVideo(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = (request.model ?? "veo-3.1-lite-generate-preview").replace(/^models\//, "");
    const prompt = request.messages.filter((row) => row.role === "user").map((row) => row.content).join("\n\n").trim();
    if (!prompt && !request.providerOperationId) {
      return { ok: false, provider: this.name, model, error: "invalid_video_request", detail: "VIDEO requires a creative brief.", latencyMs: 0 };
    }
    const timeoutMs = Math.max(this.timeoutMs, request.timeoutMs ?? 180_000);
    const pollMs = Math.max(1, request.pollIntervalMs ?? 10_000);
    let operationName = request.providerOperationId?.replace(/^\/+/, "");
    try {
      if (!operationName) {
        const submitted = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(buildVeoPredictBody(request, prompt)),
        });
        const raw = (await submitted.json().catch(() => null)) as VeoOperationResponse | null;
        if (!submitted.ok) {
          return { ok: false, provider: this.name, model, ...classifyGeminiHttpError(submitted.status, raw), latencyMs: Date.now() - started };
        }
        if (raw?.error?.message && /safety|blocked|rai|prohibited/i.test(raw.error.message)) {
          return { ok: false, provider: this.name, model, error: "safety_refused", detail: "The provider refused this request under its safety policy.", latencyMs: Date.now() - started };
        }
        operationName = raw?.name;
        if (!operationName) {
          return { ok: false, provider: this.name, model, error: "generation_failed", detail: "The provider did not return a video operation.", latencyMs: Date.now() - started };
        }
      }
      const deadline = started + timeoutMs;
      while (Date.now() < deadline) {
        const polled = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName.replace(/^\/+/, "")}`, {
          headers: { "x-goog-api-key": this.apiKey },
        });
        const raw = (await polled.json().catch(() => null)) as VeoOperationResponse | null;
        if (!polled.ok) {
          return { ok: false, provider: this.name, model, ...classifyGeminiHttpError(polled.status, raw), latencyMs: Date.now() - started, };
        }
        const parsed = parseVeoOperation(raw);
        if (parsed.kind === "processing") {
          await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        if (parsed.kind === "safety") {
          return { ok: false, provider: this.name, model, error: "safety_refused", detail: "The provider refused this request under its safety policy.", latencyMs: Date.now() - started, };
        }
        if (parsed.kind === "error") {
          return { ok: false, provider: this.name, model, error: parsed.error, detail: parsed.detail, latencyMs: Date.now() - started };
        }
        const bytes = parsed.bytes ?? (parsed.uri ? await downloadVeoVideo(parsed.uri, this.apiKey) : undefined);
        if (!bytes?.length) {
          return { ok: false, provider: this.name, model, error: "generation_failed", detail: "The provider did not return generated video.", latencyMs: Date.now() - started };
        }
        const duration = request.durationSeconds ?? 4;
        const size = videoSizeFromRequest(request);
        return {
          ok: true,
          provider: this.name,
          model,
          text: "Generated original synthesized video. This is not a human-recorded capture and not a publication.",
          media: [{
            mimeType: parsed.mimeType || "video/mp4",
            byteSize: bytes.length,
            contentBase64: bytes.toString("base64"),
            durationSeconds: duration,
            requestedDurationSeconds: request.durationSeconds,
            width: size.width,
            height: size.height,
            frameRate: 24,
            audioPresent: true,
          }],
          usage: {
            videoCount: 1,
            videoSeconds: duration,
            generatedSeconds: duration,
            outputBytes: bytes.length,
            providerNativeUnitAmount: duration,
          },
          providerRequestId: operationName,
          jobStatus: "completed",
          latencyMs: Date.now() - started,
        };
      }
      return {
        ok: true,
        provider: this.name,
        model,
        text: "Video generation is still processing.",
        media: [],
        usage: {},
        providerRequestId: operationName,
        jobStatus: "processing",
        latencyMs: Date.now() - started,
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
    }
  }
}

export function buildVeoPredictBody(request: ProviderInvokeRequest, prompt: string) {
  const image = request.images?.[0];
  const bytes = image?.dataUrl.includes(",") ? image.dataUrl.split(",")[1] : undefined;
  return {
    instances: [{
      prompt,
      ...(bytes ? { image: { bytesBase64Encoded: bytes, mimeType: image?.mimeType || "image/png" } } : {}),
    }],
    parameters: {
      aspectRatio: request.aspectRatio === "9:16" ? "9:16" : "16:9",
      resolution: request.resolution === "1080p" || request.resolution === "4k" ? request.resolution : "720p",
      durationSeconds: request.durationSeconds ?? 4,
      sampleCount: 1,
    },
  };
}

type VeoOperationResponse = {
  name?: string;
  done?: boolean;
  error?: { code?: number; status?: string; message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; bytesBase64Encoded?: string; mimeType?: string } }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
};

export function parseVeoOperation(raw: VeoOperationResponse | null):
  | { kind: "processing" }
  | { kind: "safety" }
  | { kind: "error"; error: Extract<ProviderResult, { ok: false }>["error"]; detail: string }
  | { kind: "ready"; uri?: string; bytes?: Buffer; mimeType?: string } {
  if (!raw) return { kind: "error", error: "provider_error", detail: "The provider returned an empty operation." };
  if (raw.error?.message) {
    const message = raw.error.message.toLowerCase();
    if (message.includes("safety") || message.includes("blocked") || message.includes("rai") || message.includes("prohibited")) {
      return { kind: "safety" };
    }
    const classified = classifyGeminiHttpError(raw.error.code ?? 500, raw);
    return { kind: "error", error: classified.error, detail: classified.detail };
  }
  if (!raw.done) return { kind: "processing" };
  const response = raw.response?.generateVideoResponse;
  if ((response?.raiMediaFilteredCount ?? 0) > 0 || response?.raiMediaFilteredReasons?.length) {
    return { kind: "safety" };
  }
  const video = response?.generatedSamples?.[0]?.video;
  if (!video?.uri && !video?.bytesBase64Encoded) {
    return { kind: "error", error: "generation_failed", detail: "The provider did not return generated video." };
  }
  return {
    kind: "ready",
    uri: video.uri,
    bytes: video.bytesBase64Encoded ? Buffer.from(video.bytesBase64Encoded, "base64") : undefined,
    mimeType: video.mimeType || "video/mp4",
  };
}

function videoSizeFromRequest(request: ProviderInvokeRequest): { width: number; height: number } {
  const long = request.resolution === "4k" ? 3840 : request.resolution === "1080p" ? 1920 : 1280;
  const short = request.resolution === "4k" ? 2160 : request.resolution === "1080p" ? 1080 : 720;
  return request.aspectRatio === "9:16" ? { width: short, height: long } : { width: long, height: short };
}

async function downloadVeoVideo(uri: string, apiKey: string): Promise<Buffer | undefined> {
  const res = await fetch(uri, { headers: { "x-goog-api-key": apiKey }, redirect: "follow" });
  if (!res.ok) return undefined;
  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  body: { error?: { code?: number; status?: string; message?: string } } | null,
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
