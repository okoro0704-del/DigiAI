import type { DigiAiStore } from "../store/types.js";
import { newId } from "../lib/crypto.js";

export const ECONOMIC_ACCEPTANCE_OWNER = "digi-ai-econ-acceptance";

export async function runEconomicAcceptance(store: DigiAiStore, authorizedBy: string) {
  const grant = await store.grantCredits({
    ownerType: "tenant",
    ownerId: ECONOMIC_ACCEPTANCE_OWNER,
    tenantId: ECONOMIC_ACCEPTANCE_OWNER,
    units: 10_000,
    idempotencyKey: "econ-acceptance-grant",
    applicationId: authorizedBy,
    authorizedBy,
    reasonCode: "acceptance_fixture",
  });
  const replayGrant = await store.grantCredits({
    ownerType: "tenant",
    ownerId: ECONOMIC_ACCEPTANCE_OWNER,
    tenantId: ECONOMIC_ACCEPTANCE_OWNER,
    units: 10_000,
    idempotencyKey: "econ-acceptance-grant",
    applicationId: authorizedBy,
    authorizedBy,
    reasonCode: "acceptance_fixture",
  });
  const requestId = newId("req");
  const reserve = await store.reserveCredits({
    accountId: grant.account.accountId,
    logicalRequestId: requestId,
    estimatedUnits: 400,
    reservedUnits: 400,
    meteringPolicyVersion: "dev-video-1",
    capability: "VIDEO",
    idempotencyKey: "econ-acceptance-video",
    applicationId: authorizedBy,
    tenantId: ECONOMIC_ACCEPTANCE_OWNER,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const replayReserve = await store.reserveCredits({
    accountId: grant.account.accountId,
    logicalRequestId: requestId,
    estimatedUnits: 400,
    reservedUnits: 400,
    meteringPolicyVersion: "dev-video-1",
    capability: "VIDEO",
    idempotencyKey: "econ-acceptance-video",
    applicationId: authorizedBy,
    tenantId: ECONOMIC_ACCEPTANCE_OWNER,
  });
  const settle = await store.settleReservation({
    reservationId: reserve.reservation.reservationId,
    actualUnits: 100,
    usageReceiptId: "rcpt_acceptance",
  });
  const isolate = await store.grantCredits({
    ownerType: "tenant",
    ownerId: `${ECONOMIC_ACCEPTANCE_OWNER}-b`,
    tenantId: `${ECONOMIC_ACCEPTANCE_OWNER}-b`,
    units: 50,
    idempotencyKey: "econ-acceptance-other",
    applicationId: authorizedBy,
    authorizedBy,
    reasonCode: "acceptance_fixture",
  });
  const otherBalance = await store.computeCreditBalance(isolate.account.accountId);
  const ownBalance = await store.computeCreditBalance(grant.account.accountId);
  return {
    ok: true,
    note: "ECONOMIC ACCEPTANCE. Isolated fixture. Not a retail purchase and not real provider billing.",
    accountId: grant.account.accountId,
    grantInserted: grant.inserted,
    grantIdempotent: !replayGrant.inserted,
    reservationId: reserve.reservation.reservationId,
    reserveInserted: reserve.inserted,
    reserveIdempotent: !replayReserve.inserted,
    consumedUnits: settle.reservation.consumedUnits,
    releasedUnits: settle.reservation.releasedUnits,
    ownAvailable: ownBalance.availableUnits,
    otherAccountAvailable: otherBalance.availableUnits,
    isolated: ownBalance.accountId !== otherBalance.accountId && otherBalance.availableUnits === 50,
  };
}
