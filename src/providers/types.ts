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
};

export type ProviderMediaOutput = {
  mimeType: string;
  width?: number;
  height?: number;
  byteSize?: number;
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
    | "persistence_failed";
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
  operation?: "generate" | "edit" | "analyze";
  images?: ProviderImageInput[];
  imageCount?: number;
  size?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  transparentBackground?: boolean;
};

export interface IntelligenceProvider {
  readonly name: string;
  readonly configured: boolean;
  invoke(request: ProviderInvokeRequest): Promise<ProviderResult>;
}
