import type { AppConfig } from "../../config.js";
import type { DigiAiExternalConnection } from "../../contracts/connections.js";
import { nowIso } from "../../lib/crypto.js";
import type { DigiAiStore } from "../../store/types.js";
import { MYBRANDOS_CONNECTOR_ID, MYBRANDOS_PUBLIC_READ_SCOPE, MYBRANDOS_SYSTEM } from "./types.js";

const CONNECTION_ID = "conn_mybrandos_platform_public";
const CREDENTIAL_REF = "cred_mybrandos_public";

export async function ensureMybrandosPublicConnection(store: DigiAiStore, config: AppConfig): Promise<DigiAiExternalConnection | null> {
  if (!config.mybrandosUrl) return null;
  const existing = await store.getExternalConnection(CONNECTION_ID);
  if (existing) return existing;
  const now = nowIso();
  const environment = config.mybrandosEnvironment;
  await store.putCredentialMetadata({
    credentialRef: CREDENTIAL_REF,
    backendClass: config.isProd ? "railway-platform-service" : "memory-fixture-only",
    logicalName: "MYBRANDOS_PUBLIC",
    generation: 1,
    system: MYBRANDOS_SYSTEM,
    environment,
    authenticationMode: "S2S_SECRET",
    scopes: [MYBRANDOS_PUBLIC_READ_SCOPE],
    ownerType: "PLATFORM_SERVICE",
    applicationId: "digi-ai",
    status: "available",
    refreshSupported: false,
    createdAt: now,
    updatedAt: now,
  });
  const row: DigiAiExternalConnection = {
    connectionId: CONNECTION_ID,
    connectorId: MYBRANDOS_CONNECTOR_ID,
    system: MYBRANDOS_SYSTEM,
    applicationId: "digi-ai",
    ownerType: "PLATFORM_SERVICE",
    environment,
    authenticationMode: "S2S_SECRET",
    credentialRef: CREDENTIAL_REF,
    credentialGeneration: 1,
    status: config.mybrandosUrl ? "ACTIVE" : "PENDING",
    scopes: [MYBRANDOS_PUBLIC_READ_SCOPE],
    displayLabel: "mybrandOS public read",
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: now,
    idempotencyKey: "platform-mybrandos-public-read",
  };
  await store.putExternalConnection(row);
  await store.appendConnectionAudit({
    eventId: `caud_mybrandos_public_${now}`,
    eventType: "CONNECTION_CREATED",
    connectionId: row.connectionId,
    credentialRef: row.credentialRef,
    applicationId: "digi-ai",
    createdAt: now,
  });
  return row;
}
