export type TrustIdSessionProof = {
  trustId: string;
  sessionToken?: string;
  trustTier?: number;
  verified?: boolean;
  displayName?: string;
};

export type CallerApplication = {
  id: string;
  via: "s2s" | "first_party";
};

export type ActorContext = {
  trustId: string;
  trustTier?: number;
  verified?: boolean;
  displayName?: string;
  tenantId?: string;
};

export type EntityContext = {
  slug?: string;
  tenantId?: string;
  applicationId?: string;
  appId?: string;
  verticalId?: string;
};

export type RequestContext = {
  requestId: string;
  correlationId: string;
  actor: ActorContext;
  caller: CallerApplication;
  entity: EntityContext;
};

export const FORBIDDEN_AUTH_HEADERS = [
  "x-trust-id",
  "x-userid",
  "x-user-id",
  "x-is-owner",
  "x-admin",
  "x-tenant-id",
] as const;
