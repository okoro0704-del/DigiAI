import type { AppConfig } from "../../config.js";
import type { CredentialMetadata, DigiAiExternalConnection } from "../../contracts/connections.js";
import { currentSecureCredentialBackend } from "../../credentials/factory.js";
import { registerSecretSentinel } from "../../credentials/redact.js";
import { RailwayPlatformServiceBackend } from "../../credentials/railway.js";
import { nowIso } from "../../lib/crypto.js";
import type { DigiAiStore } from "../../store/types.js";
import {
  MYBRANDOS_CONNECTION_ID,
  MYBRANDOS_CONNECTOR_ID,
  MYBRANDOS_CREDENTIAL_REF,
  MYBRANDOS_DRAFT_CONNECTION_ID,
  MYBRANDOS_LOGICAL_NAME,
  MYBRANDOS_RAILWAY_ENV_NAME,
  MYBRANDOS_S2S_DRAFT_SCOPE,
  MYBRANDOS_S2S_READ_SCOPE,
  MYBRANDOS_S2S_TEST_SENTINEL,
  MYBRANDOS_SYSTEM,
} from "./types.js";

function fixtureSecret(): string {
  return (process.env[MYBRANDOS_RAILWAY_ENV_NAME] ?? "").trim() || MYBRANDOS_S2S_TEST_SENTINEL;
}

async function ensureCredential(store: DigiAiStore, config: AppConfig, environment: "STAGING" | "PRODUCTION") {
  const now = nowIso();
  const backend = currentSecureCredentialBackend();
  if (!config.isProd) {
    const secret = fixtureSecret();
    registerSecretSentinel(secret);
    const stored = await backend.store({
      credentialRef: MYBRANDOS_CREDENTIAL_REF,
      secret,
      logicalName: MYBRANDOS_LOGICAL_NAME,
      system: MYBRANDOS_SYSTEM,
      environment,
      authenticationMode: "S2S_SECRET",
      scopes: [MYBRANDOS_S2S_READ_SCOPE, MYBRANDOS_S2S_DRAFT_SCOPE],
      ownerType: "PLATFORM_SERVICE",
      applicationId: "digi-ai",
    });
    await store.putCredentialMetadata(stored);
    return stored;
  }
  const metadata: CredentialMetadata = {
    credentialRef: MYBRANDOS_CREDENTIAL_REF,
    backendClass: "railway-platform-service",
    logicalName: MYBRANDOS_LOGICAL_NAME,
    envName: MYBRANDOS_RAILWAY_ENV_NAME,
    generation: 1,
    system: MYBRANDOS_SYSTEM,
    environment,
    authenticationMode: "S2S_SECRET",
    scopes: [MYBRANDOS_S2S_READ_SCOPE, MYBRANDOS_S2S_DRAFT_SCOPE],
    ownerType: "PLATFORM_SERVICE",
    applicationId: "digi-ai",
    status: "available",
    refreshSupported: false,
    createdAt: now,
    updatedAt: now,
  };
  await store.putCredentialMetadata(metadata);
  if (backend instanceof RailwayPlatformServiceBackend) backend.applyMetadata(metadata);
  return metadata;
}

export async function ensureMybrandosPublicConnection(store: DigiAiStore, config: AppConfig): Promise<DigiAiExternalConnection | null> {
  if (!config.mybrandosUrl) return null;
  const now = nowIso();
  const environment = config.mybrandosEnvironment;
  await ensureCredential(store, config, environment);
  const row: DigiAiExternalConnection = {
    connectionId: MYBRANDOS_CONNECTION_ID,
    connectorId: MYBRANDOS_CONNECTOR_ID,
    system: MYBRANDOS_SYSTEM,
    applicationId: "digi-ai",
    ownerType: "PLATFORM_SERVICE",
    environment,
    authenticationMode: "S2S_SECRET",
    credentialRef: MYBRANDOS_CREDENTIAL_REF,
    credentialGeneration: 1,
    status: config.mybrandosUrl ? "ACTIVE" : "PENDING",
    scopes: [MYBRANDOS_S2S_READ_SCOPE],
    displayLabel: "mybrandOS S2S published read",
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: now,
    idempotencyKey: "platform-mybrandos-s2s-published-read",
  };
  const existing = await store.getExternalConnection(MYBRANDOS_CONNECTION_ID);
  if (existing) {
    row.createdAt = existing.createdAt;
    row.idempotencyKey = existing.idempotencyKey || row.idempotencyKey;
  }
  await store.putExternalConnection(row);
  if (!existing) {
    await store.appendConnectionAudit({
      eventId: `caud_mybrandos_s2s_${now}`,
      eventType: "CONNECTION_CREATED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      applicationId: "digi-ai",
      createdAt: now,
    });
  }
  return row;
}

export async function ensureMybrandosDraftConnection(store: DigiAiStore, config: AppConfig): Promise<DigiAiExternalConnection | null> {
  if (!config.mybrandosUrl) return null;
  const now = nowIso();
  const environment = config.mybrandosEnvironment;
  await ensureCredential(store, config, environment);
  const row: DigiAiExternalConnection = {
    connectionId: MYBRANDOS_DRAFT_CONNECTION_ID,
    connectorId: MYBRANDOS_CONNECTOR_ID,
    system: MYBRANDOS_SYSTEM,
    applicationId: "digi-ai",
    ownerType: "PLATFORM_SERVICE",
    environment,
    authenticationMode: "S2S_SECRET",
    credentialRef: MYBRANDOS_CREDENTIAL_REF,
    credentialGeneration: 1,
    status: config.mybrandosUrl ? "ACTIVE" : "PENDING",
    scopes: [MYBRANDOS_S2S_DRAFT_SCOPE],
    displayLabel: "mybrandOS S2S create draft",
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: now,
    idempotencyKey: "platform-mybrandos-s2s-create-draft",
  };
  const existing = await store.getExternalConnection(MYBRANDOS_DRAFT_CONNECTION_ID);
  if (existing) {
    row.createdAt = existing.createdAt;
    row.idempotencyKey = existing.idempotencyKey || row.idempotencyKey;
  }
  await store.putExternalConnection(row);
  if (!existing) {
    await store.appendConnectionAudit({
      eventId: `caud_mybrandos_draft_${now}`,
      eventType: "CONNECTION_CREATED",
      connectionId: row.connectionId,
      credentialRef: row.credentialRef,
      applicationId: "digi-ai",
      createdAt: now,
    });
  }
  return row;
}
