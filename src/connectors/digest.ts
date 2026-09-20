import { sha256 } from "../lib/crypto.js";

export function toolRequestDigest(input: {
  executionId: string;
  operationId: string;
  actionType: string;
  environment: string;
  target: { resourceType: string; resourceId: string };
  parameters: Record<string, unknown>;
}): string {
  const material = {
    executionId: input.executionId,
    operationId: input.operationId,
    actionType: input.actionType,
    environment: input.environment,
    resourceType: input.target.resourceType,
    resourceId: input.target.resourceId,
    parameters: stable(input.parameters),
  };
  return sha256(JSON.stringify(material));
}

export function toolResponseDigest(value: Record<string, unknown>): string {
  return sha256(JSON.stringify(stable(value)));
}

function stable(value: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = value[key];
      return acc;
    }, {});
}
