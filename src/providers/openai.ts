import { classifyProviderHttpError } from "./errors.js";
import type { IntelligenceProvider, ProviderInvokeRequest, ProviderMediaOutput, ProviderResult } from "./types.js";

type OpenAiChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type OpenAiImageResponse = {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
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
    if (request.capability === "IMAGE") {
      return request.operation === "edit" ? this.editImage(request) : this.generateImage(request);
    }
    if (request.capability === "SPEECH_TO_TEXT") return this.transcribe(request);
    if (request.capability === "TEXT_TO_SPEECH") return this.speak(request);
    return this.chat(request);
  }

  private async chat(request: ProviderInvokeRequest): Promise<ProviderResult> {
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
          messages: visionMessages(request),
        }),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return this.fail(model, res, latencyMs);
      }
      const raw = (await res.json()) as OpenAiChatResponse;
      const text = raw.choices?.[0]?.message?.content?.trim();
      if (!text) {
        return { ok: false, provider: this.name, model, error: "empty", detail: "Provider returned an empty response.", latencyMs };
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
          imageCount: request.images?.length,
        },
        finishReason: raw.choices?.[0]?.finish_reason,
        providerRequestId: raw.id ?? res.headers.get("x-request-id") ?? undefined,
        latencyMs,
      };
    } catch (err) {
      return this.catchError(request.model ?? this.model, started, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async generateImage(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = request.model ?? "gpt-image-1";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const prompt = request.messages.filter((row) => row.role === "user").map((row) => row.content).join("\n\n");
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt,
          n: request.imageCount ?? 1,
          size: request.size ?? "1024x1024",
          quality: "low",
          output_format: request.outputFormat ?? "png",
          ...(request.transparentBackground ? { background: "transparent" } : {}),
        }),
      });
      return await this.readImageResponse(res, model, started);
    } catch (err) {
      return this.catchError(model, started, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async editImage(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = request.model ?? "gpt-image-1";
    const source = request.images?.[0];
    if (!source) {
      return { ok: false, provider: this.name, model, error: "invalid_media", detail: "Image edit requires an authorized source image.", latencyMs: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const prompt = request.messages.filter((row) => row.role === "user").map((row) => row.content).join("\n\n");
    try {
      const bytes = dataUrlToBuffer(source.dataUrl);
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("n", String(request.imageCount ?? 1));
      form.set("size", request.size ?? "1024x1024");
      form.set("image", new Blob([new Uint8Array(bytes)], { type: source.mimeType }), source.filename || "source.png");
      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
      return await this.readImageResponse(res, model, started);
    } catch (err) {
      return this.catchError(model, started, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readImageResponse(res: Response, model: string, started: number): Promise<ProviderResult> {
    const latencyMs = Date.now() - started;
    if (!res.ok) return this.fail(model, res, latencyMs);
    const raw = (await res.json()) as OpenAiImageResponse;
    const media = (raw.data ?? [])
      .map((row) => toMediaOutput(row))
      .filter((row): row is ProviderMediaOutput => Boolean(row));
    if (!media.length) {
      return { ok: false, provider: this.name, model, error: "generation_failed", detail: "The provider did not return an image.", latencyMs };
    }
    const [width, height] = parseSize(media[0]);
    return {
      ok: true,
      provider: this.name,
      model,
      text: `Generated ${media.length} image${media.length === 1 ? "" : "s"}.`,
      media,
      usage: {
        inputTokens: raw.usage?.input_tokens,
        outputTokens: raw.usage?.output_tokens,
        totalTokens: raw.usage?.total_tokens,
        generatedImageCount: media.length,
        imageCount: media.length,
        imageWidth: width,
        imageHeight: height,
        imageBytes: media[0]?.byteSize,
      },
      providerRequestId: res.headers.get("x-request-id") ?? undefined,
      latencyMs,
    };
  }

  private async transcribe(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = request.model ?? "whisper-1";
    const audio = request.audio?.[0];
    if (!audio?.bytes.length) {
      return { ok: false, provider: this.name, model, error: "invalid_audio", detail: "SPEECH_TO_TEXT requires authorized audio.", latencyMs: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }), audio.filename || "audio.wav");
      form.set("model", model);
      form.set("response_format", request.timestamps ? "verbose_json" : "json");
      if (request.language && request.speechTask !== "translate") form.set("language", request.language);
      const endpoint =
        request.speechTask === "translate"
          ? "https://api.openai.com/v1/audio/translations"
          : "https://api.openai.com/v1/audio/transcriptions";
      const res = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) return this.fail(model, res, latencyMs);
      const raw = (await res.json()) as {
        text?: string;
        language?: string;
        duration?: number;
        segments?: Array<{ start?: number; end?: number; text?: string }>;
      };
      const text = raw.text?.trim();
      if (!text) {
        return { ok: false, provider: this.name, model, error: "transcription_failed", detail: "The provider did not return a transcript.", latencyMs };
      }
      const duration = typeof raw.duration === "number" ? raw.duration : undefined;
      return {
        ok: true,
        provider: this.name,
        model,
        text,
        usage: {
          audioSeconds: duration,
          inputBytes: audio.bytes.length,
        },
        language: raw.language,
        segments: raw.segments
          ?.filter((row) => typeof row.text === "string" && row.text.trim())
          .map((row) => ({
            startSeconds: row.start,
            endSeconds: row.end,
            text: String(row.text).trim(),
          })),
        providerRequestId: res.headers.get("x-request-id") ?? undefined,
        latencyMs,
      };
    } catch (err) {
      return this.catchError(model, started, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async speak(request: ProviderInvokeRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = request.model ?? "tts-1";
    const text = request.messages.filter((row) => row.role === "user").map((row) => row.content).join("\n\n").trim();
    if (!text) {
      return { ok: false, provider: this.name, model, error: "tts_failed", detail: "TEXT_TO_SPEECH requires text to speak.", latencyMs: 0 };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const format = request.outputFormat && request.outputFormat !== "png" && request.outputFormat !== "jpeg" && request.outputFormat !== "webp"
      ? request.outputFormat
      : "mp3";
    try {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          voice: request.providerVoiceId || "alloy",
          response_format: format,
          speed: request.speakingRate ?? 1,
        }),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) return this.fail(model, res, latencyMs);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) {
        return { ok: false, provider: this.name, model, error: "tts_failed", detail: "The provider did not return speech audio.", latencyMs };
      }
      return {
        ok: true,
        provider: this.name,
        model,
        text: "Generated speech audio. This is synthesized speech, not a person's real voice.",
        media: [{
          mimeType: audioMime(format),
          byteSize: bytes.length,
          contentBase64: bytes.toString("base64"),
        }],
        usage: {
          characterCount: text.length,
          outputBytes: bytes.length,
        },
        providerRequestId: res.headers.get("x-request-id") ?? undefined,
        latencyMs,
      };
    } catch (err) {
      return this.catchError(model, started, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fail(model: string, res: Response, latencyMs: number): Promise<ProviderResult> {
    const body = (await res.json().catch(() => null)) as { error?: { type?: string; code?: string; message?: string } } | null;
    const classified = classifyProviderHttpError(res.status, body);
    return { ok: false, provider: this.name, model, error: classified.error, detail: classified.detail, latencyMs };
  }

  private catchError(model: string, started: number, err: unknown): ProviderResult {
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

function visionMessages(request: ProviderInvokeRequest) {
  if (!request.images?.length) return request.messages;
  return request.messages.map((message) => {
    if (message.role !== "user") return message;
    return {
      role: "user" as const,
      content: [
        { type: "text", text: message.content },
        ...request.images!.map((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl },
        })),
      ],
    };
  });
}

function toMediaOutput(row: { b64_json?: string; url?: string }): ProviderMediaOutput | null {
  if (row.b64_json) {
    const byteSize = Buffer.byteLength(row.b64_json, "base64");
    return { mimeType: "image/png", byteSize, contentBase64: row.b64_json };
  }
  if (row.url) {
    return { mimeType: "image/png", providerTempUrl: row.url, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  }
  return null;
}

function parseSize(media?: ProviderMediaOutput): [number | undefined, number | undefined] {
  return [media?.width, media?.height];
}

function audioMime(format: string) {
  if (format === "wav") return "audio/wav";
  if (format === "opus") return "audio/ogg";
  if (format === "aac") return "audio/aac";
  return "audio/mpeg";
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  const encoded = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(encoded, "base64");
}
