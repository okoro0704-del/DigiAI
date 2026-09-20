import type { ActionClass, ActionParameters, ActionType } from "../contracts/authority.js";
import { DigiAiError } from "../lib/http.js";

const REQUIRED: Record<string, Array<keyof ActionParameters>> = {
  PUBLISH_FIXTURE_POST: ["contentDigest", "destination", "visibility"],
  MESSAGE_FIXTURE: ["messageDigest"],
  SPEND_FIXTURE: ["amount", "currency"],
  DEPLOY_FIXTURE: ["artifact", "environment", "service"],
  DELETE_FIXTURE: ["resourceType", "resourceId"],
};

export function validateActionParameters(actionType: ActionType, actionClass: ActionClass, parameters: ActionParameters) {
  const keys = REQUIRED[actionType];
  if (!keys) return;
  for (const key of keys) {
    if (parameters[key] === undefined || parameters[key] === "") {
      throw new DigiAiError(400, "VALIDATION_FAILED", `Action ${actionType} requires ${key}.`);
    }
  }
  if (actionClass === "SPEND" && (typeof parameters.amount !== "number" || !Number.isFinite(parameters.amount))) {
    throw new DigiAiError(400, "VALIDATION_FAILED", "SPEND requires an exact numeric amount.");
  }
}
