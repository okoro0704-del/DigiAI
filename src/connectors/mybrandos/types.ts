export const MYBRANDOS_CONNECTOR_ID = "mybrandos" as const;
export const MYBRANDOS_SYSTEM = "mybrandos" as const;
export const MYBRANDOS_S2S_AUTHENTICATION = "NOT_ESTABLISHED" as const;

export const MYBRANDOS_PUBLIC_READ_SCOPE = "read:public";

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
  | "MYBRANDOS_MALFORMED_RESPONSE";

export const MYBRANDOS_ALLOWED_HTTP_METHODS = ["GET"] as const;

export const MYBRANDOS_REGISTERED_OPERATIONS = [
  {
    operationId: "mybrandos.inspectPublicDigitalLife",
    visibilityClass: "PUBLIC" as MybrandosVisibilityClass,
    requiredIdentity: "none",
    requiredScopes: [MYBRANDOS_PUBLIC_READ_SCOPE],
    sideEffectClass: "READ_ONLY",
    domainInterface: "GET /api/public/:slug",
  },
  {
    operationId: "mybrandos.listPublishedAssets",
    visibilityClass: "PUBLIC" as MybrandosVisibilityClass,
    requiredIdentity: "none",
    requiredScopes: [MYBRANDOS_PUBLIC_READ_SCOPE],
    sideEffectClass: "READ_ONLY",
    domainInterface: "GET /api/public/:slug/assets",
  },
] as const;
