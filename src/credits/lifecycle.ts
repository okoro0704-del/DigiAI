import type { AppConfig } from "../config.js";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import type { CreditReceiptSnapshot, CreditReservation, EconomicsMode } from "../contracts/credits.js";
import type { AskConstraints } from "../contracts/request.js";
import type { NativeUsage } from "../contracts/usage.js";
import { DigiAiError } from "../lib/http.js";
import type { DigiAiStore } from "../store/types.js";
import { selectCreditOwner } from "./account.js";
import { estimateDigiAiUnits, hasBillableNativeUsage, type UnitEstimate, type UnitEstimateInput } from "./estimate.js";
import { accountingEnabled, enforcementEnabled } from "./mode.js";
import { commercialPolicyConfigured, selectMeteringPolicy } from "./policy.js";

export type EconomySession = {
  mode: EconomicsMode;
  snapshot(): CreditReceiptSnapshot;
  reserve(input: UnitEstimateInput): Promise<CreditReceiptSnapshot>;
  markProcessing(providerOperationId: string): Promise<void>;
  settle(input: { nativeUsage?: NativeUsage; usageReceiptId?: string; outcome: "completed" | "failed" | "refused" | "processing" }): Promise<CreditReceiptSnapshot>;
  release(reasonCode?: string): Promise<CreditReceiptSnapshot>;
};

export function emptyCreditSnapshot(mode: EconomicsMode): CreditReceiptSnapshot {
  return {
    estimatedDigiAiUnits: null,
    reservedDigiAiUnits: null,
    consumedDigiAiUnits: null,
    releasedDigiAiUnits: null,
    meteringPolicyVersion: null,
    mode,
    commercialPolicyConfigured: commercialPolicyConfigured(),
  };
}

export function createEconomySession(input: {
  store: DigiAiStore;
  config: AppConfig;
  actor: ActorContext;
  caller: CallerApplication;
  entitySlug?: string;
  requestId: string;
  idempotencyKey?: string;
  capability: string;
  constraints?: AskConstraints;
  message?: string;
}): EconomySession {
  const mode = input.config.economicsMode;
  const owner = selectCreditOwner({ actor: input.actor, caller: input.caller, entitySlug: input.entitySlug });
  let estimate: UnitEstimate | null = null;
  let reservation: CreditReservation | null = null;
  let last = emptyCreditSnapshot(mode);

  const snap = (patch: Partial<CreditReceiptSnapshot> = {}): CreditReceiptSnapshot => {
    last = {
      ...last,
      estimatedDigiAiUnits: estimate?.units ?? last.estimatedDigiAiUnits,
      reservedDigiAiUnits: reservation?.reservedUnits ?? last.reservedDigiAiUnits,
      consumedDigiAiUnits: reservation?.consumedUnits ?? last.consumedDigiAiUnits,
      releasedDigiAiUnits: reservation?.releasedUnits ?? last.releasedDigiAiUnits,
      meteringPolicyVersion: estimate?.policyVersion ?? reservation?.meteringPolicyVersion ?? last.meteringPolicyVersion,
      reservationId: reservation?.reservationId || last.reservationId,
      accountId: reservation?.accountId ?? last.accountId,
      shortfallUnits: reservation?.shortfallUnits ?? last.shortfallUnits,
      mode,
      commercialPolicyConfigured: commercialPolicyConfigured(),
      ...patch,
    };
    return last;
  };

  const failClosed = (err: unknown): never => {
    if (enforcementEnabled(input.config)) {
      throw new DigiAiError(503, "credit_ledger_unavailable", "Digi AI economics storage is unavailable.");
    }
    throw err;
  };

  return {
    mode,
    snapshot: () => last,
    async reserve(estimateInput) {
      if (!accountingEnabled(input.config)) return snap();
      const policy = selectMeteringPolicy({ capability: estimateInput.capability || input.capability });
      estimate = estimateDigiAiUnits({
        ...estimateInput,
        capability: estimateInput.capability || input.capability,
        message: estimateInput.message ?? input.message,
        constraints: estimateInput.constraints ?? input.constraints,
        policy,
      });
      snap({ estimatedDigiAiUnits: estimate.units, meteringPolicyVersion: estimate.policyVersion });
      if (!estimate.reservation || !estimate.policyVersion) return last;
      try {
        const status = input.store.creditStatus();
        if (!status.writable) {
          if (enforcementEnabled(input.config)) {
            throw new DigiAiError(503, "credit_ledger_unavailable", "Digi AI economics storage is unavailable.");
          }
          return last;
        }
        const account = await input.store.ensureCreditAccount(owner);
        const existing = input.idempotencyKey
          ? await input.store.getReservationByIdempotency(account.accountId, input.idempotencyKey)
          : await input.store.getReservationByRequest(account.accountId, input.requestId);
        if (existing) {
          reservation = existing;
          return snap();
        }
        const ttl = (policy?.reservationTtlSeconds ?? 1800) * 1000;
        const expiresAt = new Date(Date.now() + ttl).toISOString();
        const result = await input.store.reserveCredits({
          accountId: account.accountId,
          logicalRequestId: input.requestId,
          estimatedUnits: estimate.units,
          reservedUnits: estimate.units,
          meteringPolicyVersion: estimate.policyVersion,
          capability: input.capability,
          idempotencyKey: input.idempotencyKey,
          applicationId: owner.applicationId,
          actorId: owner.actorId,
          tenantId: owner.tenantId,
          expiresAt,
          observeOnly: false,
        });
        if (result.insufficient) {
          if (enforcementEnabled(input.config)) {
            throw new DigiAiError(402, "insufficient_units", "This account does not have enough Digi AI Units available.");
          }
          return snap();
        }
        reservation = result.reservation;
        return snap();
      } catch (err) {
        if (err instanceof DigiAiError) throw err;
        if (enforcementEnabled(input.config)) return failClosed(err);
        return last;
      }
    },
    async markProcessing(providerOperationId) {
      if (!reservation?.reservationId) return;
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      reservation = (await input.store.updateReservationHold(reservation.reservationId, { providerOperationId, expiresAt })) ?? reservation;
      snap();
    },
    async settle(result) {
      if (!accountingEnabled(input.config) || !reservation?.reservationId) {
        if (estimate) snap({ estimatedDigiAiUnits: estimate.units });
        return last;
      }
      if (result.outcome === "processing") {
        if (reservation.providerOperationId || result.usageReceiptId) {
          await this.markProcessing(reservation.providerOperationId ?? result.usageReceiptId ?? "");
        }
        return snap();
      }
      try {
        const billable = hasBillableNativeUsage(result.nativeUsage);
        const actual = result.outcome === "completed" || billable
          ? estimateDigiAiUnits({
              capability: input.capability,
              message: input.message,
              constraints: input.constraints,
              nativeUsage: result.nativeUsage,
              policy: selectMeteringPolicy({ capability: input.capability }),
            }).units
          : 0;
        if (actual === 0 && result.outcome !== "completed") {
          const released = await input.store.releaseReservation({ reservationId: reservation.reservationId, reasonCode: result.outcome });
          reservation = released.reservation;
          return snap({ releasedDigiAiUnits: reservation.releasedUnits, consumedDigiAiUnits: 0 });
        }
        const balance = await input.store.computeCreditBalance(reservation.accountId);
        const extra = clampAvailableExtra(balance.availableUnits, reservation.reservedUnits);
        const settled = await input.store.settleReservation({
          reservationId: reservation.reservationId,
          actualUnits: actual,
          usageReceiptId: result.usageReceiptId,
          additionalAvailable: extra,
        });
        reservation = settled.reservation;
        return snap();
      } catch (err) {
        if (err instanceof DigiAiError && enforcementEnabled(input.config)) throw err;
        return last;
      }
    },
    async release(reasonCode = "abort") {
      if (!reservation?.reservationId) return last;
      if (reservation.status === "settled" || reservation.status === "released") return snap();
      const released = await input.store.releaseReservation({ reservationId: reservation.reservationId, reasonCode });
      reservation = released.reservation;
      return snap();
    },
  };
}

function clampAvailableExtra(available: number, reserved: number): number {
  return available;
  void reserved;
}

export function attachEconomics(
  response: import("../contracts/response.js").DigiAiAskResponse,
  snapshot: CreditReceiptSnapshot,
): import("../contracts/response.js").DigiAiAskResponse {
  return { ...response, economics: snapshot };
}
