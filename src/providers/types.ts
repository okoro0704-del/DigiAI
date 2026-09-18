export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ProviderSuccess = {
  ok: true;
  provider: string;
  model?: string;
  text: string;
  usage: ProviderUsage;
  finishReason?: string;
  providerRequestId?: string;
  latencyMs: number;
};

export type ProviderFailure = {
  ok: false;
  provider: string;
  model?: string;
  error: "unavailable" | "timeout" | "provider_error" | "empty";
  detail: string;
  latencyMs: number;
};

export type ProviderResult = ProviderSuccess | ProviderFailure;

export type ProviderMessage = {
  role: "system" | "user";
  content: string;
};

export type ProviderInvokeRequest = {
  messages: ProviderMessage[];
  temperature?: number;
};

export interface IntelligenceProvider {
  readonly name: string;
  readonly configured: boolean;
  invoke(request: ProviderInvokeRequest): Promise<ProviderResult>;
}
