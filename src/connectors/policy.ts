import {
  TOOL_CONNECTOR_POLICY_ID,
  TOOL_CONNECTOR_POLICY_VERSION,
  type ConnectorEnvironment,
  type SideEffectClass,
  type ToolConnectorPolicy,
} from "../contracts/connectors.js";
import { DigiAiError } from "../lib/http.js";

export const DEFAULT_TOOL_CONNECTOR_POLICY: ToolConnectorPolicy = {
  policyId: TOOL_CONNECTOR_POLICY_ID,
  version: TOOL_CONNECTOR_POLICY_VERSION,
  status: "active",
  fixtureMode: true,
  liveMode: false,
  allowedConnectorTypes: ["INTERNAL_SERVICE", "HTTP_API", "OAUTH_API", "S2S_API"],
  realConsequentialWrites: false,
  realDestructive: false,
  fixturesEnabled: true,
  requireIdempotencyForConsequential: true,
};

export function loadToolConnectorPolicy(): ToolConnectorPolicy {
  return DEFAULT_TOOL_CONNECTOR_POLICY;
}

export function assertOperationAllowed(input: {
  sideEffectClass: SideEffectClass;
  environment: ConnectorEnvironment;
  live?: boolean;
  operationId?: string;
}) {
  const policy = loadToolConnectorPolicy();
  const createDraft = input.operationId === "mybrandos.createDraft" && input.sideEffectClass === "REVERSIBLE_WRITE";
  const publishDraft = input.operationId === "mybrandos.publishDraft" && input.sideEffectClass === "CONSEQUENTIAL_WRITE";
  const governedWrite = createDraft || publishDraft;
  if (input.live || input.environment === "PRODUCTION") {
    if (!governedWrite && (input.sideEffectClass === "CONSEQUENTIAL_WRITE" || input.sideEffectClass === "DESTRUCTIVE" || input.sideEffectClass === "REVERSIBLE_WRITE")) {
      throw new DigiAiError(403, "ENVIRONMENT_DENIED", "Real consequential connector writes are disabled.");
    }
  }
  if (!governedWrite && !policy.realConsequentialWrites && input.environment === "PRODUCTION" && input.sideEffectClass !== "READ_ONLY") {
    throw new DigiAiError(403, "ENVIRONMENT_DENIED", "Production mutations are not enabled in Phase 3E.");
  }
  if (!policy.realDestructive && input.sideEffectClass === "DESTRUCTIVE" && input.environment === "PRODUCTION") {
    throw new DigiAiError(403, "ENVIRONMENT_DENIED", "Destructive connector operations are disabled.");
  }
}
