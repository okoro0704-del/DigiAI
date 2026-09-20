import type { CredentialMetadata } from "../contracts/connections.js";
import { DigiAiError } from "../lib/http.js";
import { newId, nowIso } from "../lib/crypto.js";
import type { RotateCredentialInput, SecureCredentialBackend, StoreCredentialInput } from "./backend.js";
import { ResolvedCredentialSecret } from "./secret.js";

type MemoryRow = {
  metadata: CredentialMetadata;
  secret: string;
};

export class MemorySecureCredentialBackend implements SecureCredentialBackend {
  readonly backendClass = "memory-fixture-only" as const;
  readonly fixtureOnly = true;
  readonly supportsDynamicUserVault = true;
  readonly supportsPlatformService = true;
  private readonly rows = new Map<string, MemoryRow>();

  async store(input: StoreCredentialInput): Promise<CredentialMetadata> {
    if (!input.secret) throw new DigiAiError(400, "invalid_request", "A fixture secret is required for the test credential backend.");
    const now = nowIso();
    const credentialRef = input.credentialRef ?? newId("cred");
    const metadata: CredentialMetadata = {
      credentialRef,
      backendClass: this.backendClass,
      logicalName: input.logicalName,
      generation: 1,
      system: input.system,
      environment: input.environment,
      authenticationMode: input.authenticationMode,
      scopes: [...input.scopes],
      ownerType: input.ownerType,
      tenantId: input.tenantId,
      actorId: input.actorId,
      applicationId: input.applicationId,
      status: "available",
      expiresAt: input.expiresAt,
      refreshSupported: Boolean(input.refreshSupported),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(credentialRef, { metadata, secret: input.secret });
    return { ...metadata, scopes: [...metadata.scopes] };
  }

  async resolve(credentialRef: string): Promise<ResolvedCredentialSecret> {
    const row = this.rows.get(credentialRef);
    if (!row) throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
    return this.resolveUsingMetadata(row.metadata);
  }

  async resolveUsingMetadata(metadata: CredentialMetadata): Promise<ResolvedCredentialSecret> {
    const row = this.rows.get(metadata.credentialRef);
    if (!row || row.metadata.status !== "available" || metadata.status !== "available") {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
    }
    if (row.metadata.expiresAt && row.metadata.expiresAt <= nowIso()) {
      row.metadata.status = "expired";
      row.metadata.updatedAt = nowIso();
      throw new DigiAiError(409, "CREDENTIAL_EXPIRED", "The credential has expired.");
    }
    return new ResolvedCredentialSecret(row.secret, row.metadata.credentialRef, row.metadata.generation);
  }

  applyMetadata(row: CredentialMetadata) {
    const existing = this.rows.get(row.credentialRef);
    if (existing) existing.metadata = { ...row, scopes: [...row.scopes] };
  }

  async rotate(input: RotateCredentialInput): Promise<CredentialMetadata> {
    const current = this.rows.get(input.currentRef);
    if (!current || current.metadata.status === "revoked") {
      throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
    }
    if (!input.secret) throw new DigiAiError(400, "invalid_request", "A replacement fixture secret is required.");
    const next = await this.store({
      secret: input.secret,
      logicalName: input.logicalName ?? current.metadata.logicalName,
      system: current.metadata.system,
      environment: current.metadata.environment,
      authenticationMode: current.metadata.authenticationMode,
      scopes: current.metadata.scopes,
      ownerType: current.metadata.ownerType,
      tenantId: current.metadata.tenantId,
      actorId: current.metadata.actorId,
      applicationId: current.metadata.applicationId,
      expiresAt: current.metadata.expiresAt,
      refreshSupported: current.metadata.refreshSupported,
    });
    next.generation = current.metadata.generation + 1;
    next.rotatedFrom = current.metadata.credentialRef;
    this.rows.set(next.credentialRef, { metadata: next, secret: input.secret });
    current.metadata.status = "rotated";
    current.metadata.updatedAt = nowIso();
    return { ...next, scopes: [...next.scopes] };
  }

  async revoke(credentialRef: string): Promise<CredentialMetadata> {
    const row = this.rows.get(credentialRef);
    if (!row) throw new DigiAiError(404, "not_found", "Credential was not found.");
    row.metadata.status = "revoked";
    row.metadata.revokedAt = nowIso();
    row.metadata.updatedAt = row.metadata.revokedAt;
    return { ...row.metadata, scopes: [...row.metadata.scopes] };
  }

  async exists(credentialRef: string): Promise<boolean> {
    return this.rows.has(credentialRef);
  }

  async inspectMetadata(credentialRef: string): Promise<CredentialMetadata | null> {
    const row = this.rows.get(credentialRef);
    return row ? { ...row.metadata, scopes: [...row.metadata.scopes] } : null;
  }

  reset() {
    this.rows.clear();
  }
}
