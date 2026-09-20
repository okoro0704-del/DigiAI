import type { CredentialMetadata } from "../contracts/connections.js";
import { DigiAiError } from "../lib/http.js";
import { newId, nowIso } from "../lib/crypto.js";
import type { RotateCredentialInput, SecureCredentialBackend, StoreCredentialInput } from "./backend.js";
import { ResolvedCredentialSecret } from "./secret.js";

function envNameFor(logicalName: string, generation = 1): string {
  const base = `DIGI_AI_CONN_${logicalName.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
  return generation <= 1 ? base : `${base}_G${generation}`;
}

export class RailwayPlatformServiceBackend implements SecureCredentialBackend {
  readonly backendClass = "railway-platform-service" as const;
  readonly fixtureOnly = false;
  readonly supportsDynamicUserVault = false;
  readonly supportsPlatformService = true;
  private readonly metadata = new Map<string, CredentialMetadata>();

  applyMetadata(row: CredentialMetadata) {
    this.metadata.set(row.credentialRef, { ...row, scopes: [...row.scopes] });
  }

  hydrate(rows: CredentialMetadata[]) {
    this.metadata.clear();
    for (const row of rows) this.applyMetadata(row);
  }

  async store(input: StoreCredentialInput): Promise<CredentialMetadata> {
    if (input.ownerType !== "PLATFORM_SERVICE") {
      throw new DigiAiError(409, "DYNAMIC_USER_VAULT_UNSUPPORTED", "Railway environment variables are not a multi-tenant secret vault.");
    }
    if (input.secret) {
      throw new DigiAiError(400, "invalid_request", "Production platform secrets must be provided through Railway environment variables, not the API.");
    }
    const logicalName = input.logicalName?.trim();
    if (!logicalName) throw new DigiAiError(400, "invalid_request", "A logical Railway credential name is required.");
    const envName = envNameFor(logicalName, 1);
    if (!process.env[envName]?.trim()) {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The platform credential environment variable is not configured.");
    }
    const now = nowIso();
    const metadata: CredentialMetadata = {
      credentialRef: input.credentialRef ?? newId("cred"),
      backendClass: this.backendClass,
      logicalName,
      envName,
      generation: 1,
      system: input.system,
      environment: input.environment,
      authenticationMode: input.authenticationMode,
      scopes: [...input.scopes],
      ownerType: "PLATFORM_SERVICE",
      tenantId: input.tenantId,
      actorId: input.actorId,
      applicationId: input.applicationId,
      status: "available",
      expiresAt: input.expiresAt,
      refreshSupported: false,
      createdAt: now,
      updatedAt: now,
    };
    this.metadata.set(metadata.credentialRef, metadata);
    return { ...metadata, scopes: [...metadata.scopes] };
  }

  async resolve(credentialRef: string): Promise<ResolvedCredentialSecret> {
    const row = this.metadata.get(credentialRef);
    if (!row) throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
    return this.resolveUsingMetadata(row);
  }

  async resolveUsingMetadata(metadata: CredentialMetadata): Promise<ResolvedCredentialSecret> {
    if (metadata.status !== "available") {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
    }
    if (metadata.expiresAt && metadata.expiresAt <= nowIso()) {
      throw new DigiAiError(409, "CREDENTIAL_EXPIRED", "The credential has expired.");
    }
    const value = metadata.envName ? process.env[metadata.envName] : undefined;
    if (!value?.trim()) {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The platform credential environment variable is not configured.");
    }
    return new ResolvedCredentialSecret(value, metadata.credentialRef, metadata.generation);
  }

  async rotate(input: RotateCredentialInput): Promise<CredentialMetadata> {
    const current = this.metadata.get(input.currentRef);
    if (!current || current.status === "revoked") {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
    }
    if (input.secret) {
      throw new DigiAiError(400, "invalid_request", "Replacement platform secrets must be set in Railway before rotation.");
    }
    const logicalName = input.logicalName ?? current.logicalName;
    if (!logicalName) throw new DigiAiError(400, "invalid_request", "A logical Railway credential name is required.");
    const generation = current.generation + 1;
    const envName = envNameFor(logicalName, generation);
    if (!process.env[envName]?.trim()) {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The rotated platform credential environment variable is not configured.");
    }
    const next: CredentialMetadata = {
      ...current,
      credentialRef: newId("cred"),
      logicalName,
      envName,
      generation,
      status: "available",
      rotatedFrom: current.credentialRef,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.metadata.set(next.credentialRef, next);
    current.status = "rotated";
    current.updatedAt = nowIso();
    return { ...next, scopes: [...next.scopes] };
  }

  async revoke(credentialRef: string): Promise<CredentialMetadata> {
    const row = this.metadata.get(credentialRef);
    if (!row) throw new DigiAiError(404, "not_found", "Credential was not found.");
    row.status = "revoked";
    row.revokedAt = nowIso();
    row.updatedAt = row.revokedAt;
    return { ...row, scopes: [...row.scopes] };
  }

  async exists(credentialRef: string): Promise<boolean> {
    return this.metadata.has(credentialRef);
  }

  async inspectMetadata(credentialRef: string): Promise<CredentialMetadata | null> {
    const row = this.metadata.get(credentialRef);
    return row ? { ...row, scopes: [...row.scopes] } : null;
  }
}
