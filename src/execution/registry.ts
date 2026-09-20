import type { ActionType } from "../contracts/authority.js";
import { isFixtureActionType } from "../contracts/execution.js";
import { fixtureDelete, fixtureDeployer, fixtureMessenger, fixturePublisher, fixtureValue, mybrandosPublicReader, type DigiAiActionExecutor } from "./executors.js";

const REGISTRY: Record<string, DigiAiActionExecutor> = {
  PUBLISH_FIXTURE_POST: fixturePublisher,
  MESSAGE_FIXTURE: fixtureMessenger,
  SPEND_FIXTURE: fixtureValue,
  DEPLOY_FIXTURE: fixtureDeployer,
  DELETE_FIXTURE: fixtureDelete,
  INSPECT_MYBRANDOS_PUBLIC: mybrandosPublicReader,
  LIST_MYBRANDOS_PUBLIC_ASSETS: mybrandosPublicReader,
};

export function resolveExecutor(actionType: ActionType): DigiAiActionExecutor | undefined {
  return REGISTRY[actionType];
}

export function registeredActionTypes(): string[] {
  return Object.keys(REGISTRY).filter((row) => isFixtureActionType(row));
}

export function registryConfigured(): boolean {
  return registeredActionTypes().length > 0;
}
