export const CONNECTION_SCHEMA_VERSION = "connection-1";

export const CONNECTION_OWNER_TYPES = ["TENANT", "ACTOR", "APPLICATION", "PLATFORM_SERVICE"] as const;
export type ConnectionOwnerType = (typeof CONNECTION_OWNER_TYPES)[number];

export const CONNECTION_ENVIRONMENTS = ["DEVELOPMENT", "TEST", "STAGING", "PRODUCTION"] as const;
export type ConnectionEnvironment = (typeof CONNECTION_ENVIRONMENTS)[number];

export const AUTHENTICATION_MODES = ["API_KEY", "BEARER_TOKEN", "OAUTH2", "S2S_SECRET"] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

export const CONNECTION_STATUSES = [
  "PENDING",
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
  "DISABLED",
  "INVALID",
  "REAUTH_REQUIRED",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_AUDIT_EVENTS = [
  "CONNECTION_CREATED",
  "CONNECTION_VALIDATED",
  "CONNECTION_DISABLED",
  "CONNECTION_ENABLED",
  "CONNECTION_REVOKED",
  "CONNECTION_EXPIRED",
  "CONNECTION_SELECTION_REQUIRED",
  "CONNECTION_SELECTION_BOUND",
  "CREDENTIAL_STORED",
  "CREDENTIAL_ROTATION_REQUESTED",
  "CREDENTIAL_ROTATED",
  "CREDENTIAL_REVOKED",
  "CREDENTIAL_RESOLUTION_ALLOWED",
  "CREDENTIAL_RESOLUTION_DENIED",
  "OAUTH_INITIATED",
  "OAUTH_CALLBACK_REJECTED",
  "OAUTH_CALLBACK_ACCEPTED",
] as const;
export type ConnectionAuditEventType = (typeof CONNECTION_AUDIT_EVENTS)[number];

export type DigiAiExternalConnection = {
  connectionId: string;
  connectorId?: string;
  system: string;
  tenantId?: string;
  actorId?: string;
  applicationId?: string;
  ownerType: ConnectionOwnerType;
  environment: ConnectionEnvironment;
  authenticationMode: AuthenticationMode;
  credentialRef: string;
  credentialGeneration: number;
  status: ConnectionStatus;
  scopes: string[];
  displayLabel: string;
  accountAlias?: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  disabledAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
};

export type CredentialMetadata = {
  credentialRef: string;
  backendClass: "railway-platform-service" | "memory-fixture-only";
  logicalName?: string;
  envName?: string;
  generation: number;
  system: string;
  environment: ConnectionEnvironment;
  authenticationMode: AuthenticationMode;
  scopes: string[];
  ownerType: ConnectionOwnerType;
  tenantId?: string;
  actorId?: string;
  applicationId?: string;
  status: "available" | "revoked" | "rotated" | "expired";
  expiresAt?: string;
  refreshSupported: boolean;
  createdAt: string;
  updatedAt: string;
  rotatedFrom?: string;
  revokedAt?: string;
};

export type ConnectionAuditEvent = {
  eventId: string;
  eventType: ConnectionAuditEventType;
  connectionId?: string;
  credentialRef?: string;
  actorId?: string;
  tenantId?: string;
  applicationId?: string;
  operationId?: string;
  reasonCode?: string;
  createdAt: string;
};

export type DigiAiConnectionSelection = {
  selectionId: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  system: string;
  environment: ConnectionEnvironment;
  eligibleConnectionIds: string[];
  chosenConnectionId: string;
  objectiveId?: string;
  executionId?: string;
  expiresAt: string;
  createdAt: string;
  consumedAt?: string;
};

export type OAuthStateRecord = {
  stateId: string;
  stateHash: string;
  nonce: string;
  actorId: string;
  tenantId?: string;
  applicationId: string;
  system: string;
  environment: ConnectionEnvironment;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  scopes: string[];
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
};

export type SafeConnectionView = {
  connectionId: string;
  system: string;
  connectorId?: string;
  status: ConnectionStatus;
  environment: ConnectionEnvironment;
  ownerType: ConnectionOwnerType;
  displayLabel: string;
  accountAlias?: string;
  scopeSummary: string[];
  authenticationMode: AuthenticationMode;
  expiresAt?: string;
  lastValidatedAt?: string;
};

export function isConnectionOwnerType(value: unknown): value is ConnectionOwnerType {
  return typeof value === "string" && (CONNECTION_OWNER_TYPES as readonly string[]).includes(value);
}

export function isConnectionEnvironment(value: unknown): value is ConnectionEnvironment {
  return typeof value === "string" && (CONNECTION_ENVIRONMENTS as readonly string[]).includes(value);
}

export function isAuthenticationMode(value: unknown): value is AuthenticationMode {
  return typeof value === "string" && (AUTHENTICATION_MODES as readonly string[]).includes(value);
}

export function toSafeConnectionView(row: DigiAiExternalConnection): SafeConnectionView {
  return {
    connectionId: row.connectionId,
    system: row.system,
    connectorId: row.connectorId,
    status: row.status,
    environment: row.environment,
    ownerType: row.ownerType,
    displayLabel: row.displayLabel,
    accountAlias: row.accountAlias,
    scopeSummary: [...row.scopes],
    authenticationMode: row.authenticationMode,
    expiresAt: row.expiresAt,
    lastValidatedAt: row.lastValidatedAt,
  };
}
