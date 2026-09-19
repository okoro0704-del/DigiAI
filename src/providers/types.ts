export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  imageCount?: number;
  generatedImageCount?: number;
  imageWidth?: number;
  imageHeight?: number;
  imageBytes?: number;
  audioSeconds?: number;
  generatedSeconds?: number;
  characterCount?: number;
  inputBytes?: number;
  outputBytes?: number;
};

export type ProviderMediaOutput = {
  mimeType: string;
  width?: number;
  height?: number;
  byteSize?: number;
  durationSeconds?: number;
  contentBase64?: string;
  providerTempUrl?: string;
  expiresAt?: string;
};

export type ProviderSuccess = {
  ok: true;
  provider: string;
  model?: string;
  text: string;
  usage: ProviderUsage;
  media?: ProviderMediaOutput[];
  finishReason?: string;
  language?: string;
  segments?: Array<{ startSeconds?: number; endSeconds?: number; text: string }>;
  providerRequestId?: string;
  latencyMs: number;
};

export type ProviderFailure = {
  ok: false;
  provider: string;
  model?: string;
  error:
    | "unavailable"
    | "timeout"
    | "provider_error"
    | "empty"
    | "quota"
    | "billing"
    | "rate_limited"
    | "auth_failed"
    | "invalid_request"
    | "safety_refused"
    | "invalid_media"
    | "media_too_large"
    | "media_access_denied"
    | "generation_failed"
    | "persistence_failed"
    | "invalid_audio"
    | "audio_too_large"
    | "audio_too_long"
    | "unsupported_codec"
    | "transcription_failed"
    | "tts_failed"
    | "voice_profile_invalid";
  detail: string;
  latencyMs: number;
};

export type ProviderResult = ProviderSuccess | ProviderFailure;

export type ProviderMessage = {
  role: "system" | "user";
  content: string;
};

export type ProviderImageInput = {
  mimeType: string;
  dataUrl: string;
  filename?: string;
};

export type ProviderInvokeRequest = {
  messages: ProviderMessage[];
  temperature?: number;
  /** Router-selected model. Adapters may ignore unknown ids. */
  model?: string;
  structuredOutput?: boolean;
  capability?: string;
  operation?: "generate" | "edit" | "analyze" | "transcribe" | "translate" | "speak" | "converse";
  images?: ProviderImageInput[];
  imageCount?: number;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp" | "mp3" | "wav" | "opus" | "aac";
  transparentBackground?: boolean;
  audio?: Array<{ mimeType: string; bytes: Buffer; filename?: string }>;
  language?: string;
  speechTask?: "transcribe" | "translate";
  timestamps?: boolean;
  providerVoiceId?: string;
  speakingRate?: number;
};

export interface IntelligenceProvider {
  readonly name: string;
  readonly configured: boolean;
  invoke(request: ProviderInvokeRequest): Promise<ProviderResult>;
}
