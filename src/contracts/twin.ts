import type { EntityContext } from "./actor.js";
import type { ProvenanceItem } from "./provenance.js";
import type { ExecutionMeta, UsageSnapshot } from "./response.js";

export type TwinSignalKind = "fact" | "interpretation";

export type TwinItem = {
  id: string;
  title: string;
  detail?: string;
  timestamp?: string;
  kind: TwinSignalKind;
  sourceSystem: "mybrandos" | "diginews" | "digipedia" | "digi-ai";
  sourceType?: "canonical_publication" | "canonical_entity" | "canonical_asset" | "generated";
  sourceId?: string;
  sourceUrl?: string;
  publisher?: string;
  relation?: "self" | "third_party";
};

export type TwinSectionType =
  | "world"
  | "diginews_by"
  | "diginews_about"
  | "content"
  | "attention"
  | "knowledge";

export type TwinSection = {
  type: TwinSectionType;
  title: string;
  empty?: string;
  items: TwinItem[];
  unavailable?: string;
};

export type TwinOpportunity = {
  idea: string;
  why: string;
  basedOn: string[];
  kind: "interpretation";
};

export type TwinProviderState =
  | "completed"
  | "unbound"
  | "unavailable"
  | "quota"
  | "billing"
  | "rate_limited"
  | "auth_failed"
  | "failed";

export type TwinProviderStatus = {
  state: TwinProviderState;
  provider: string;
  model?: string;
  detail: string;
};

export type TwinOwnerActivity = {
  entitySlug: string;
  displayName?: string;
  publications?: TwinOwnerPublication[];
  draftsCount?: number;
  scheduled?: Array<{ id: string; title: string; scheduledAt?: string }>;
  failed?: Array<{ id: string; title: string; detail?: string }>;
  recentAssets?: Array<{ id: string; title: string; assetType?: string; updatedAt?: string; status?: string }>;
  projects?: Array<{ id: string; title: string; projectType?: string; status?: string; updatedAt?: string }>;
};

export type TwinOwnerPublication = {
  id: string;
  title: string;
  assetType?: string;
  publishedAt?: string;
  href?: string;
  views?: number;
  plays?: number;
  loves?: number;
};

export type TwinBriefInput = {
  entity?: EntityContext;
  ownerContext?: TwinOwnerActivity;
  correlationId?: string;
  actor?: { trustId?: string; displayName?: string };
};

export type TwinBriefSuccess = {
  ok: true;
  service: "digi-ai";
  experience: "digi-twin";
  briefId: string;
  generatedAt: string;
  greeting: string;
  headline: string;
  quiet: boolean;
  actor: { trustId: string; displayName?: string };
  entity: { slug: string; displayName?: string; kind?: string };
  application: { id: string };
  sections: TwinSection[];
  opportunities: TwinOpportunity[];
  take?: string;
  sources: ProvenanceItem[];
  providerStatus: TwinProviderStatus;
  interpretationAvailable: boolean;
  usage: UsageSnapshot;
  execution: ExecutionMeta;
  receiptId: string;
};

export type TwinBriefFailure = {
  ok: false;
  service: "digi-ai";
  experience: "digi-twin";
  error: string;
  message: string;
};

export type TwinBriefResponse = TwinBriefSuccess | TwinBriefFailure;
