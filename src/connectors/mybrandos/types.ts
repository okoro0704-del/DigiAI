export const MYBRANDOS_CONNECTOR_ID = "mybrandos" as const;
export const MYBRANDOS_SYSTEM = "mybrandos" as const;
export const MYBRANDOS_S2S_AUTHENTICATION = "BEARER_SHARED_SECRET" as const;

export const MYBRANDOS_PUBLIC_READ_SCOPE = "read:public";
export const MYBRANDOS_S2S_READ_SCOPE = "mybrandos:read:published";
export const MYBRANDOS_S2S_DRAFT_SCOPE = "mybrandos:draft:create";
export const MYBRANDOS_S2S_TEST_SENTINEL = "TEST_MYBRANDOS_S2S_SECRET_DO_NOT_LEAK";
export const MYBRANDOS_CONNECTION_ID = "conn_mybrandos_platform_public";
export const MYBRANDOS_DRAFT_CONNECTION_ID = "conn_mybrandos_platform_draft";
export const MYBRANDOS_CREDENTIAL_REF = "cred_mybrandos_s2s";
export const MYBRANDOS_LOGICAL_NAME = "MYBRANDOS_S2S";
export const MYBRANDOS_RAILWAY_ENV_NAME = "DIGI_AI_CONN_MYBRANDOS_S2S";

export type MybrandosVisibilityClass = "PUBLIC" | "TENANT_INTERNAL" | "ACTOR_PRIVATE";

export type MybrandosPublicAssetRef = {
  id: string;
  assetType: string;
  publishedAt: string;
};

export type MybrandosPublicDigitalLife = {
  slug: string;
  publicEnabled: boolean;
  displayName: string;
  publishedAssetCount: number;
  recentPublished: MybrandosPublicAssetRef[];
  retrievedAt: string;
  privacyClass: "PUBLIC";
  source: "mybrandos";
  factKind: "SOURCE_FACT";
};

export type MybrandosReadFailureCode =
  | "MYBRANDOS_UNAVAILABLE"
  | "MYBRANDOS_AUTH_FAILED"
  | "MYBRANDOS_ACCESS_DENIED"
  | "MYBRANDOS_NOT_FOUND"
  | "MYBRANDOS_TIMEOUT"
  | "MYBRANDOS_RATE_LIMITED"
  | "MYBRANDOS_MALFORMED_RESPONSE"
  | "SUBJECT_AUTHORITY_REQUIRED"
  | "SUBJECT_MISMATCH"
  | "SCOPE_INSUFFICIENT"
  | "INVALID_DRAFT_INPUT"
  | "IDEMPOTENCY_CONFLICT";

export const MYBRANDOS_ALLOWED_HTTP_METHODS = ["GET"] as const;
export const MYBRANDOS_WRITE_HTTP_METHODS = ["POST"] as const;

export const MYBRANDOS_REGISTERED_OPERATIONS = [
  {
    operationId: "mybrandos.inspectPublicDigitalLife",
    visibilityClass: "PUBLIC" as MybrandosVisibilityClass,
    requiredIdentity: "service-principal",
    requiredScopes: [MYBRANDOS_S2S_READ_SCOPE],
    sideEffectClass: "READ_ONLY",
    domainInterface: "GET /api/internal/digital-life/:slug",
  },
  {
    operationId: "mybrandos.listPublishedAssets",
    visibilityClass: "PUBLIC" as MybrandosVisibilityClass,
    requiredIdentity: "service-principal",
    requiredScopes: [MYBRANDOS_S2S_READ_SCOPE],
    sideEffectClass: "READ_ONLY",
    domainInterface: "GET /api/internal/digital-life/:slug/assets",
  },
  {
    operationId: "mybrandos.createDraft",
    visibilityClass: "ACTOR_PRIVATE" as MybrandosVisibilityClass,
    requiredIdentity: "service-principal+subject",
    requiredScopes: [MYBRANDOS_S2S_DRAFT_SCOPE],
    sideEffectClass: "REVERSIBLE_WRITE",
    domainInterface: "POST /api/internal/drafts",
  },
] as const;
