export type UsageRecord = {
  usageId: string;
  requestId: string;
  correlationId: string;
  actorTrustId: string;
  callerId: string;
  entitySlug?: string;
  tenantId?: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  success: boolean;
  createdAt: string;
};

export type RequestReceipt = {
  receiptId: string;
  requestId: string;
  correlationId: string;
  actorTrustId: string;
  callerId: string;
  entitySlug?: string;
  tenantId?: string;
  operation: string;
  sourcesAccessed: string[];
  provider?: string;
  model?: string;
  resultStatus: "completed" | "failed" | "unauthorized" | "provider_unavailable" | "source_unavailable";
  usageId?: string;
  createdAt: string;
};
