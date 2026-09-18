import type { ObjectiveCandidate } from "./objectives.js";
import type { ProvenanceItem } from "./provenance.js";

export type UsageSnapshot = {
  usageId: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  success: boolean;
};

export type ExecutionMeta = {
  requestId: string;
  correlationId: string;
  provider: string;
  model?: string;
  latencyMs: number;
  sourcesUsed: string[];
  finishState: "completed" | "failed" | "provider_unavailable" | "source_unavailable" | "unauthorized";
};

export type DigiAiAskSuccess = {
  ok: true;
  service: "digi-ai";
  answer: string;
  provenance: ProvenanceItem[];
  usage: UsageSnapshot;
  execution: ExecutionMeta;
  receiptId: string;
  objectiveCandidate?: ObjectiveCandidate;
};

export type DigiAiAskFailure = {
  ok: false;
  service: "digi-ai";
  error: string;
  message: string;
  provenance?: ProvenanceItem[];
  usage?: UsageSnapshot;
  execution?: ExecutionMeta;
  receiptId?: string;
};

export type DigiAiAskResponse = DigiAiAskSuccess | DigiAiAskFailure;

export type HealthResponse = {
  ok: true;
  service: "digi-ai";
  provider: "configured" | "unbound";
};
