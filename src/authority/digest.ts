import type { ActionClass, ActionParameters, ActionTarget, ActionType } from "../contracts/authority.js";
import { sha256 } from "../lib/crypto.js";

const MATERIAL: Record<ActionClass, Array<keyof ActionParameters | "resourceType" | "resourceId">> = {
  KNOW: ["resourceType", "resourceId"],
  THINK: ["resourceType", "resourceId"],
  CREATE: ["contentReference", "contentDigest"],
  CHANGE: ["resourceType", "resourceId", "contentDigest"],
  PUBLISH: ["contentReference", "contentDigest", "destination", "visibility"],
  MESSAGE: ["recipient", "conversationId", "messageDigest"],
  SPEND: ["recipient", "amount", "currency", "valueAsset"],
  DEPLOY: ["artifact", "environment", "service"],
  DELETE: ["resourceType", "resourceId"],
};

export function actionDigest(input: {
  actionClass: ActionClass;
  actionType: ActionType;
  target: ActionTarget;
  parameters: ActionParameters;
}): string {
  const keys = MATERIAL[input.actionClass];
  const material: Record<string, unknown> = {
    actionClass: input.actionClass,
    actionType: input.actionType,
    resourceType: input.target.resourceType,
    resourceId: input.target.resourceId,
    tenantId: input.target.tenantId ?? "",
  };
  for (const key of keys) {
    if (key === "resourceType" || key === "resourceId") continue;
    const value = input.parameters[key];
    if (value !== undefined) material[key] = value;
  }
  return sha256(stableJson(material));
}

export function publicParameters(actionClass: ActionClass, parameters: ActionParameters): ActionParameters {
  const keys = MATERIAL[actionClass];
  const out: ActionParameters = {};
  for (const key of keys) {
    if (key === "resourceType" || key === "resourceId") continue;
    const value = parameters[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  if (parameters.messagePreview) out.messagePreview = parameters.messagePreview.slice(0, 160);
  return out;
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = value[key];
        return acc;
      }, {}),
  );
}
