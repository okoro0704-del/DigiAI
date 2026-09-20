import type { DigiAiToolOperation } from "../contracts/connectors.js";
import { DigiAiError } from "../lib/http.js";

const MAX = 256;

export function validateToolInput(operation: DigiAiToolOperation, input: Record<string, unknown>) {
  const allowed = new Set([...operation.inputSchema.required, ...(operation.inputSchema.numbers ?? []), ...Object.keys(operation.inputSchema.enums ?? {})]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key) && !operation.inputSchema.required.includes(key)) {
      if (!operation.inputSchema.required.includes(key) && !(operation.inputSchema.numbers ?? []).includes(key) && !((operation.inputSchema.enums ?? {})[key])) {
        const known = new Set([...operation.inputSchema.required, ...(operation.inputSchema.numbers ?? []), ...Object.keys(operation.inputSchema.enums ?? {}), "contentReference", "recipient", "conversationId", "valueAsset", "service"]);
        if (!known.has(key)) throw new DigiAiError(400, "VALIDATION_ERROR", `Unknown field ${key} is not accepted for ${operation.operationId}.`);
      }
    }
  }
  for (const key of operation.inputSchema.required) {
    const value = input[key];
    if (value === undefined || value === "") throw new DigiAiError(400, "VALIDATION_ERROR", `${operation.operationId} requires ${key}.`);
    if (typeof value === "string" && value.length > MAX) throw new DigiAiError(400, "VALIDATION_ERROR", `${key} exceeds the allowed size.`);
  }
  for (const key of operation.inputSchema.numbers ?? []) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) {
      throw new DigiAiError(400, "VALIDATION_ERROR", `${key} must be a finite number.`);
    }
  }
  for (const [key, values] of Object.entries(operation.inputSchema.enums ?? {})) {
    if (input[key] !== undefined && !values.includes(String(input[key]))) {
      throw new DigiAiError(403, "ENVIRONMENT_DENIED", `${key} is not allowed for this connector.`);
    }
  }
}

export function validateToolOutput(operation: DigiAiToolOperation, output: Record<string, unknown> | undefined, status: string) {
  if (status !== "SUCCEEDED") return;
  if (!output) throw new DigiAiError(502, "MALFORMED_RESPONSE", "Connector returned success without a structured payload.");
  for (const key of operation.outputSchema.required) {
    if (output[key] === undefined || output[key] === "") {
      throw new DigiAiError(502, "MALFORMED_RESPONSE", `Connector output is missing ${key}.`);
    }
  }
}

export function minimizedInput(operation: DigiAiToolOperation, parameters: Record<string, unknown>): Record<string, unknown> {
  const keys = new Set([...operation.inputSchema.required, ...(operation.inputSchema.numbers ?? []), ...Object.keys(operation.inputSchema.enums ?? {}), "contentReference", "recipient", "conversationId", "valueAsset"]);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (parameters[key] !== undefined) out[key] = parameters[key];
  }
  return out;
}
