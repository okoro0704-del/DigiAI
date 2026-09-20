import type { AuthenticationMode, ConnectionEnvironment, ConnectionOwnerType, CredentialMetadata } from "../contracts/connections.js";
import type { ResolvedCredentialSecret } from "./secret.js";

export type SecureCredentialBackendClass = "railway-platform-service" | "memory-fixture-only";

export type StoreCredentialInput = {
  credentialRef?: string;
  secret?: string;
  logicalName?: string;
  system: string;
  environment: ConnectionEnvironment;
  authenticationMode: AuthenticationMode;
  scopes: string[];
  ownerType: ConnectionOwnerType;
  tenantId?: string;
  actorId?: string;
  applicationId?: string;
  expiresAt?: string;
  refreshSupported?: boolean;
};

export type RotateCredentialInput = {
  currentRef: string;
  secret?: string;
  logicalName?: string;
};

export interface SecureCredentialBackend {
  readonly backendClass: SecureCredentialBackendClass;
  readonly fixtureOnly: boolean;
  readonly supportsDynamicUserVault: boolean;
  readonly supportsPlatformService: boolean;
  store(input: StoreCredentialInput): Promise<CredentialMetadata>;
  resolve(credentialRef: string): Promise<ResolvedCredentialSecret>;
  resolveUsingMetadata(metadata: CredentialMetadata): Promise<ResolvedCredentialSecret>;
  rotate(input: RotateCredentialInput): Promise<CredentialMetadata>;
  revoke(credentialRef: string): Promise<CredentialMetadata>;
  exists(credentialRef: string): Promise<boolean>;
  inspectMetadata(credentialRef: string): Promise<CredentialMetadata | null>;
  applyMetadata(row: CredentialMetadata): void;
}

export const DYNAMIC_USER_OAUTH_VAULT = "NOT_YET_SUPPORTED" as const;
