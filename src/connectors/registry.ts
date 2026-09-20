import type { ActionType } from "../contracts/authority.js";
import type {
  ConnectorEnvironment,
  DigiAiToolConnector,
  DigiAiToolOperation,
  SanitizedToolCatalogRow,
} from "../contracts/connectors.js";
import { DigiAiError } from "../lib/http.js";

const NOW = "2026-01-01T00:00:00.000Z";

function connector(partial: DigiAiToolConnector): DigiAiToolConnector {
  return partial;
}

function schema(required: string[], extra: Omit<DigiAiToolOperation["inputSchema"], "required"> = {}): DigiAiToolOperation["inputSchema"] {
  return { ...extra, required };
}

const catalogConnector = connector({
  connectorId: "fixture-catalog",
  connectorType: "INTERNAL_SERVICE",
  version: "fixture-1",
  displayName: "Fixture Catalog",
  system: "fixture-catalog",
  environment: "FIXTURE",
  status: "CONFIGURED",
  supportedOperations: ["fixture.lookup", "fixture.inspect"],
  authenticationMode: "none",
  capabilities: ["READ_ONLY"],
  idempotencySupport: "SUPPORTED",
  reconciliationSupport: "SUPPORTED",
  cancellationSupport: "UNSUPPORTED",
  healthState: "fixture",
  requiresCredential: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const actionsConnector = connector({
  connectorId: "fixture-actions",
  connectorType: "INTERNAL_SERVICE",
  version: "fixture-1",
  displayName: "Fixture Actions",
  system: "fixture-actions",
  environment: "STAGING",
  status: "CONFIGURED",
  supportedOperations: ["fixture.publish", "fixture.message", "fixture.spend", "fixture.deploy", "fixture.delete"],
  authenticationMode: "none",
  capabilities: ["FIXTURE_WRITE"],
  idempotencySupport: "REQUIRED",
  reconciliationSupport: "SUPPORTED",
  cancellationSupport: "UNSUPPORTED",
  healthState: "fixture",
  requiresCredential: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const disabledConnector = connector({
  connectorId: "fixture-disabled",
  connectorType: "HTTP_API",
  version: "fixture-1",
  displayName: "Disabled Fixture",
  system: "fixture-disabled",
  environment: "STAGING",
  status: "DISABLED",
  supportedOperations: ["fixture.disabled"],
  authenticationMode: "opaque-ref",
  capabilities: [],
  idempotencySupport: "UNSUPPORTED",
  reconciliationSupport: "UNSUPPORTED",
  cancellationSupport: "UNSUPPORTED",
  healthState: "fixture",
  requiresCredential: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const securedConnector = connector({
  connectorId: "fixture-secured",
  connectorType: "S2S_API",
  version: "fixture-1",
  displayName: "Secured Fixture",
  system: "fixture-secured",
  environment: "STAGING",
  status: "CONFIGURED",
  supportedOperations: ["fixture.secured"],
  authenticationMode: "opaque-ref",
  capabilities: ["CREDENTIAL"],
  idempotencySupport: "REQUIRED",
  reconciliationSupport: "UNSUPPORTED",
  cancellationSupport: "UNSUPPORTED",
  healthState: "fixture",
  requiresCredential: true,
  createdAt: NOW,
  updatedAt: NOW,
});

function liveMybrandosEnvironment(): ConnectorEnvironment {
  const explicit = (process.env.MYBRANDOS_ENVIRONMENT || "").trim().toUpperCase();
  if (explicit === "PRODUCTION" || explicit === "STAGING") return explicit;
  return process.env.NODE_ENV === "production" ? "PRODUCTION" : "STAGING";
}

function liveMybrandosConfigured(): boolean {
  const url = (process.env.MYBRANDOS_URL || "https://mybrandos-production.up.railway.app").trim();
  return Boolean(url);
}

const mybrandosConnector = connector({
  connectorId: "mybrandos",
  connectorType: "INTERNAL_SERVICE",
  version: "3g1-s2s-1",
  displayName: "mybrandOS",
  system: "mybrandos",
  environment: liveMybrandosEnvironment(),
  status: liveMybrandosConfigured() ? "CONFIGURED" : "UNAVAILABLE",
  supportedOperations: ["mybrandos.inspectPublicDigitalLife", "mybrandos.listPublishedAssets", "mybrandos.createDraft"],
  authenticationMode: "opaque-ref",
  capabilities: ["READ_ONLY", "PUBLIC", "REVERSIBLE_WRITE"],
  idempotencySupport: "REQUIRED",
  reconciliationSupport: "SUPPORTED",
  cancellationSupport: "UNSUPPORTED",
  healthState: "unknown",
  requiresCredential: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const CONNECTORS: Record<string, DigiAiToolConnector> = {
  "fixture-catalog": catalogConnector,
  "fixture-actions": actionsConnector,
  "fixture-disabled": disabledConnector,
  "fixture-secured": securedConnector,
  mybrandos: mybrandosConnector,
};

const OPERATIONS: Record<string, DigiAiToolOperation> = {
  "fixture.lookup": {
    operationId: "fixture.lookup",
    connectorId: "fixture-catalog",
    operationName: "lookup",
    actionTypes: [],
    inputSchema: schema(["item"]),
    outputSchema: schema(["item", "text"]),
    riskClass: "low",
    sideEffectClass: "READ_ONLY",
    idempotencyMode: "SUPPORTED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "WAITING" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.inspect": {
    operationId: "fixture.inspect",
    connectorId: "fixture-catalog",
    operationName: "inspect",
    actionTypes: [],
    inputSchema: schema(["item"]),
    outputSchema: schema(["item"]),
    riskClass: "low",
    sideEffectClass: "READ_ONLY",
    idempotencyMode: "SUPPORTED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "WAITING" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.publish": {
    operationId: "fixture.publish",
    connectorId: "fixture-actions",
    operationName: "publish",
    actionTypes: ["PUBLISH_FIXTURE_POST"],
    inputSchema: schema(["contentDigest", "destination", "visibility"]),
    outputSchema: schema(["reference", "operation"]),
    riskClass: "high",
    sideEffectClass: "CONSEQUENTIAL_WRITE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.message": {
    operationId: "fixture.message",
    connectorId: "fixture-actions",
    operationName: "message",
    actionTypes: ["MESSAGE_FIXTURE"],
    inputSchema: schema(["messageDigest"]),
    outputSchema: schema(["reference", "operation"]),
    riskClass: "high",
    sideEffectClass: "CONSEQUENTIAL_WRITE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.spend": {
    operationId: "fixture.spend",
    connectorId: "fixture-actions",
    operationName: "spend",
    actionTypes: ["SPEND_FIXTURE"],
    inputSchema: schema(["amount", "currency"], { numbers: ["amount"] }),
    outputSchema: schema(["reference", "operation"]),
    riskClass: "high",
    sideEffectClass: "CONSEQUENTIAL_WRITE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.deploy": {
    operationId: "fixture.deploy",
    connectorId: "fixture-actions",
    operationName: "deploy",
    actionTypes: ["DEPLOY_FIXTURE"],
    inputSchema: schema(["artifact", "environment", "service"], { enums: { environment: ["staging", "STAGING", "fixture", "FIXTURE"] } }),
    outputSchema: schema(["reference", "operation"]),
    riskClass: "high",
    sideEffectClass: "CONSEQUENTIAL_WRITE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.delete": {
    operationId: "fixture.delete",
    connectorId: "fixture-actions",
    operationName: "delete",
    actionTypes: ["DELETE_FIXTURE"],
    inputSchema: schema(["resourceType", "resourceId"]),
    outputSchema: schema(["reference", "operation"]),
    riskClass: "high",
    sideEffectClass: "DESTRUCTIVE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: false,
  },
  "fixture.disabled": {
    operationId: "fixture.disabled",
    connectorId: "fixture-disabled",
    operationName: "disabled",
    actionTypes: [],
    inputSchema: schema(["item"]),
    outputSchema: schema(["item"]),
    riskClass: "high",
    sideEffectClass: "CONSEQUENTIAL_WRITE",
    idempotencyMode: "UNSUPPORTED",
    reconciliationMode: "UNSUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: false,
    version: "1",
    requiresCredential: true,
  },
  "fixture.secured": {
    operationId: "fixture.secured",
    connectorId: "fixture-secured",
    operationName: "secured",
    actionTypes: [],
    inputSchema: schema(["item"]),
    outputSchema: schema(["reference"]),
    riskClass: "high",
    sideEffectClass: "CONSEQUENTIAL_WRITE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "UNSUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 1000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: true,
  },
  "mybrandos.inspectPublicDigitalLife": {
    operationId: "mybrandos.inspectPublicDigitalLife",
    connectorId: "mybrandos",
    operationName: "inspectPublicDigitalLife",
    actionTypes: ["INSPECT_MYBRANDOS_PUBLIC"],
    inputSchema: schema(["slug"]),
    outputSchema: schema(["slug", "publicEnabled", "displayName", "publishedAssetCount", "retrievedAt", "privacyClass", "source", "factKind"]),
    riskClass: "low",
    sideEffectClass: "READ_ONLY",
    idempotencyMode: "SUPPORTED",
    reconciliationMode: "UNSUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 8000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: true,
  },
  "mybrandos.listPublishedAssets": {
    operationId: "mybrandos.listPublishedAssets",
    connectorId: "mybrandos",
    operationName: "listPublishedAssets",
    actionTypes: ["LIST_MYBRANDOS_PUBLIC_ASSETS"],
    inputSchema: schema(["slug"]),
    outputSchema: schema(["slug", "publishedAssetCount", "retrievedAt", "privacyClass", "source", "factKind"]),
    riskClass: "low",
    sideEffectClass: "READ_ONLY",
    idempotencyMode: "SUPPORTED",
    reconciliationMode: "UNSUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 8000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: true,
  },
  "mybrandos.createDraft": {
    operationId: "mybrandos.createDraft",
    connectorId: "mybrandos",
    operationName: "createDraft",
    actionTypes: ["CREATE_MYBRANDOS_DRAFT"],
    inputSchema: schema(["title"]),
    outputSchema: schema(["draftId", "state", "ownerRef", "createdAt", "idempotencyKeyRef", "contentDigest", "source"]),
    riskClass: "high",
    sideEffectClass: "REVERSIBLE_WRITE",
    idempotencyMode: "REQUIRED",
    reconciliationMode: "SUPPORTED",
    cancellationMode: "UNSUPPORTED",
    timeoutPolicy: { beforeSubmissionMs: 8000, afterSubmission: "UNKNOWN_OUTCOME" },
    enabled: true,
    version: "1",
    requiresCredential: true,
  },
};

export function getConnector(connectorId: string): DigiAiToolConnector | undefined {
  const row = CONNECTORS[connectorId];
  if (!row) return undefined;
  if (connectorId !== "mybrandos") return row;
  return {
    ...row,
    environment: liveMybrandosEnvironment(),
    status: liveMybrandosConfigured() ? "CONFIGURED" : "UNAVAILABLE",
  };
}

export function getOperation(operationId: string): DigiAiToolOperation | undefined {
  return OPERATIONS[operationId];
}

export function resolveByActionType(actionType: ActionType, environment?: ConnectorEnvironment): { connector: DigiAiToolConnector; operation: DigiAiToolOperation } {
  const operation = Object.values(OPERATIONS).find((row) => row.actionTypes.includes(actionType));
  if (!operation) throw new DigiAiError(404, "ACTION_TYPE_MISMATCH", "No registered connector operation exists for that action type.");
  const connector = getConnector(operation.connectorId);
  if (!connector) throw new DigiAiError(404, "CONNECTOR_DISABLED", "Connector was not found.");
  if (environment === "PRODUCTION" && connector.environment !== "PRODUCTION") {
    throw new DigiAiError(403, "ENVIRONMENT_DENIED", "A staging connector cannot be used for production.");
  }
  return { connector, operation };
}

export function registeredOperations(): DigiAiToolOperation[] {
  return Object.values(OPERATIONS);
}

export function connectorRegistryConfigured(): boolean {
  return Object.keys(CONNECTORS).length > 0;
}

export function sanitizedCatalog(): SanitizedToolCatalogRow[] {
  return Object.values(OPERATIONS).map((row) => ({
    operationId: row.operationId,
    operationName: row.operationName,
    description: `${row.sideEffectClass} ${row.connectorId === "mybrandos" ? "mybrandOS" : "fixture"} operation ${row.operationName}`,
    connectorId: row.connectorId,
    sideEffectClass: row.sideEffectClass,
    available: row.enabled && getConnector(row.connectorId)?.status === "CONFIGURED",
    inputShape: row.inputSchema.required,
  }));
}
