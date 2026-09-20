import type { ConnectorCredentialRef, ConnectorEnvironment } from "../contracts/connectors.js";
import { DigiAiError } from "../lib/http.js";

const refs = new Map<string, ConnectorCredentialRef>();

export const SECURE_CREDENTIAL_BACKEND = "NOT_ESTABLISHED" as const;

export function putCredentialRef(row: ConnectorCredentialRef) {
  refs.set(row.credentialRef, row);
}

export function getCredentialRef(credentialRef: string): ConnectorCredentialRef | undefined {
  return refs.get(credentialRef);
}

export function resetCredentialRefs() {
  refs.clear();
}

export function resolveCredential(input: {
  credentialRef?: string;
  tenantId?: string;
  actorId?: string;
  environment: ConnectorEnvironment;
  system: string;
  required: boolean;
}): ConnectorCredentialRef | undefined {
  if (!input.required) return undefined;
  if (!input.credentialRef) throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "A scoped credential is required and none is available.");
  const row = refs.get(input.credentialRef);
  if (!row || row.status !== "available") throw new DigiAiError(409, "CREDENTIAL_UNAVAILABLE", "The credential reference is not available.");
  if (row.tenantId && input.tenantId && row.tenantId !== input.tenantId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That credential reference is not usable by this tenant.");
  }
  if (row.actorId && input.actorId && row.actorId !== input.actorId) {
    throw new DigiAiError(403, "cross_tenant_forbidden", "That credential reference is not usable by this actor.");
  }
  if (row.environment !== input.environment) {
    throw new DigiAiError(403, "ENVIRONMENT_DENIED", "Credential environment does not match the requested environment.");
  }
  if (row.system !== input.system) {
    throw new DigiAiError(403, "CREDENTIAL_UNAVAILABLE", "Credential system does not match the connector.");
  }
  return row;
}

export function publicCredentialRef(row: ConnectorCredentialRef) {
  return {
    credentialRef: row.credentialRef,
    credentialType: row.credentialType,
    system: row.system,
    environment: row.environment,
    status: row.status,
  };
}
