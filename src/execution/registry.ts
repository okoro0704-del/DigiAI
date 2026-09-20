import type { ActionType } from "../contracts/authority.js";
import { fixtureDelete, fixtureDeployer, fixtureMessenger, fixturePublisher, fixtureValue, type DigiAiActionExecutor } from "./executors.js";

const REGISTRY: Record<string, DigiAiActionExecutor> = {
  PUBLISH_FIXTURE_POST: fixturePublisher,
  MESSAGE_FIXTURE: fixtureMessenger,
  SPEND_FIXTURE: fixtureValue,
  DEPLOY_FIXTURE: fixtureDeployer,
  DELETE_FIXTURE: fixtureDelete,
};

export function resolveExecutor(actionType: ActionType): DigiAiActionExecutor | undefined {
  return REGISTRY[actionType];
}

export function registeredActionTypes(): string[] {
  return Object.keys(REGISTRY);
}

export function registryConfigured(): boolean {
  return registeredActionTypes().length > 0;
}
