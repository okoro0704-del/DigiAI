import type { DigiAiExternalConnection } from "../contracts/connections.js";

export function evaluateConnectionLifecycle(row: DigiAiExternalConnection, now: string): DigiAiExternalConnection {
  if (row.status === "REVOKED" || row.revokedAt) {
    return { ...row, status: "REVOKED", scopes: [...row.scopes] };
  }
  if (row.status === "DISABLED" || row.disabledAt) {
    return { ...row, status: "DISABLED", scopes: [...row.scopes] };
  }
  if (row.expiresAt && row.expiresAt <= now) {
    return { ...row, status: "EXPIRED", scopes: [...row.scopes] };
  }
  if (row.status === "INVALID" || row.status === "REAUTH_REQUIRED" || row.status === "PENDING") {
    return { ...row, scopes: [...row.scopes] };
  }
  return { ...row, scopes: [...row.scopes] };
}

export function requiredScopesForOperation(operationId: string): string[] {
  if (operationId === "mybrandos.createDraft") return ["mybrandos:draft:create"];
  if (operationId.startsWith("mybrandos.")) return ["mybrandos:read:published"];
  if (operationId === "fixture.secured" || operationId === "fixture.connected") return ["read:catalog"];
  if (operationId.endsWith("publish")) return ["write:publish"];
  if (operationId.endsWith("message")) return ["message:send"];
  if (operationId.endsWith("spend")) return ["spend:value"];
  if (operationId.endsWith("deploy")) return ["deployment:staging"];
  if (operationId.endsWith("delete")) return ["write:delete"];
  return [];
}
