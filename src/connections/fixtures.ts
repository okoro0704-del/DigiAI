import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import { FIXTURE_SENTINEL_SECRET } from "../credentials/secret.js";
import type { DigiAiStore } from "../store/types.js";
import { createConnection, parseConnectionCreateBody } from "./service.js";

export const FIXTURE_CONNECTION_SECRET = `${FIXTURE_SENTINEL_SECRET}_CONN`;

export async function seedFixtureConnections(input: {
  store: DigiAiStore;
  config: AppConfig;
  actor: ActorContext;
  caller: CallerApplication;
  otherActor?: ActorContext;
}) {
  const actor = input.actor;
  const caller = input.caller;
  const make = async (body: Record<string, unknown>) =>
    createConnection({ store: input.store, config: input.config, actor, caller, body: parseConnectionCreateBody(body) });

  const tenant = await make({
    ownerType: "TENANT",
    system: "fixture-secured",
    connectorId: "fixture-secured",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:catalog"],
    displayLabel: "Tenant catalog",
    secret: `${FIXTURE_CONNECTION_SECRET}_TENANT`,
    idempotencyKey: "fix-tenant",
  });
  const actorConn = await make({
    ownerType: "ACTOR",
    system: "fixture-secured",
    connectorId: "fixture-secured",
    environment: "STAGING",
    authenticationMode: "BEARER_TOKEN",
    scopes: ["read:catalog"],
    displayLabel: "Actor work account",
    accountAlias: "work",
    secret: `${FIXTURE_CONNECTION_SECRET}_ACTOR`,
    idempotencyKey: "fix-actor",
  });
  const expired = await make({
    ownerType: "ACTOR",
    system: "fixture-secured",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:catalog"],
    displayLabel: "Expired",
    secret: `${FIXTURE_CONNECTION_SECRET}_EXPIRED`,
    expiresAt: "2020-01-01T00:00:00.000Z",
    idempotencyKey: "fix-expired",
  });
  const revoked = await make({
    ownerType: "ACTOR",
    system: "fixture-other",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:catalog"],
    displayLabel: "Revoked",
    secret: `${FIXTURE_CONNECTION_SECRET}_REVOKED`,
    status: "REVOKED",
    idempotencyKey: "fix-revoked",
  });
  const disabled = await make({
    ownerType: "ACTOR",
    system: "fixture-other",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:catalog"],
    displayLabel: "Disabled",
    secret: `${FIXTURE_CONNECTION_SECRET}_DISABLED`,
    status: "DISABLED",
    idempotencyKey: "fix-disabled",
  });
  const staging = await make({
    ownerType: "ACTOR",
    system: "fixture-actions",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["write:publish"],
    displayLabel: "Staging publisher",
    secret: `${FIXTURE_CONNECTION_SECRET}_STAGING`,
    idempotencyKey: "fix-staging",
  });
  const production = await createConnection({
    store: input.store,
    config: input.config,
    actor,
    caller: { id: "operator", via: "s2s" },
    body: parseConnectionCreateBody({
      ownerType: "PLATFORM_SERVICE",
      system: "fixture-actions",
      environment: "PRODUCTION",
      authenticationMode: "S2S_SECRET",
      scopes: ["deployment:staging"],
      displayLabel: "Production-labeled fixture",
      secret: `${FIXTURE_CONNECTION_SECRET}_PROD`,
      idempotencyKey: "fix-prod",
    }),
  });
  const insufficient = await make({
    ownerType: "ACTOR",
    system: "fixture-secured",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:public"],
    displayLabel: "Insufficient scope",
    secret: `${FIXTURE_CONNECTION_SECRET}_SCOPE`,
    idempotencyKey: "fix-scope",
  });
  const ambiguousA = await make({
    ownerType: "ACTOR",
    system: "fixture-ambiguous",
    environment: "STAGING",
    authenticationMode: "OAUTH2",
    scopes: ["read:catalog"],
    displayLabel: "Work",
    accountAlias: "work",
    secret: `${FIXTURE_CONNECTION_SECRET}_AMB_A`,
    idempotencyKey: "fix-amb-a",
  });
  const ambiguousB = await make({
    ownerType: "ACTOR",
    system: "fixture-ambiguous",
    environment: "STAGING",
    authenticationMode: "OAUTH2",
    scopes: ["read:catalog"],
    displayLabel: "Personal",
    accountAlias: "personal",
    secret: `${FIXTURE_CONNECTION_SECRET}_AMB_B`,
    idempotencyKey: "fix-amb-b",
  });
  const rotatable = await make({
    ownerType: "ACTOR",
    system: "fixture-rotate",
    environment: "STAGING",
    authenticationMode: "API_KEY",
    scopes: ["read:catalog"],
    displayLabel: "Rotatable",
    secret: `${FIXTURE_CONNECTION_SECRET}_ROTATE_A`,
    idempotencyKey: "fix-rotate",
  });

  if (input.otherActor) {
    await createConnection({
      store: input.store,
      config: input.config,
      actor: input.otherActor,
      caller: { id: "tenant-b", via: "s2s" },
      body: parseConnectionCreateBody({
        ownerType: "ACTOR",
        system: "fixture-secured",
        environment: "STAGING",
        authenticationMode: "API_KEY",
        scopes: ["read:catalog"],
        displayLabel: "Other actor",
        secret: `${FIXTURE_CONNECTION_SECRET}_OTHER`,
        idempotencyKey: "fix-other",
      }),
    });
  }

  return {
    tenant,
    actor: actorConn,
    expired,
    revoked,
    disabled,
    staging,
    production,
    insufficient,
    ambiguousA,
    ambiguousB,
    rotatable,
  };
}
