import type { CreditReconciliationReport, ReconciliationAnomaly } from "../contracts/credits.js";
import { nowIso } from "../lib/crypto.js";
import type { DigiAiStore } from "../store/types.js";
import { detectOverlappingPolicies } from "./policy.js";

export async function reconcileCredits(store: DigiAiStore): Promise<CreditReconciliationReport> {
  const anomalies: ReconciliationAnomaly[] = [];
  const [accounts, reservations, receipts] = await Promise.all([
    store.listCreditAccounts(),
    store.listCreditReservations(),
    store.listReceipts(),
  ]);

  for (const account of accounts) {
    const balance = await store.computeCreditBalance(account.accountId);
    if (balance.availableUnits < 0) {
      anomalies.push({
        code: "negative_available",
        message: "Available units dropped below zero.",
        accountId: account.accountId,
      });
    }
    const page = await store.listCreditEntries({ accountId: account.accountId, limit: 50 });
    const seen = new Set<string>();
    for (const entry of page.entries) {
      const key = `${entry.kind}:${entry.idempotencyKey ?? entry.entryId}`;
      if (entry.idempotencyKey && seen.has(key)) {
        anomalies.push({
          code: "duplicate_economic_event",
          message: "Duplicate credit ledger idempotency key.",
          accountId: account.accountId,
        });
      }
      seen.add(key);
    }
  }

  const now = Date.now();
  for (const reservation of reservations) {
    if ((reservation.status === "held" || reservation.status === "observe") && reservation.expiresAt && Date.parse(reservation.expiresAt) < now && !reservation.providerOperationId) {
      anomalies.push({
        code: "stale_reservation",
        message: "Reservation expired without a known provider operation.",
        reservationId: reservation.reservationId,
        logicalRequestId: reservation.logicalRequestId,
        accountId: reservation.accountId,
      });
    }
    if (reservation.status === "settled" && reservation.consumedUnits > 0 && !reservation.logicalRequestId) {
      anomalies.push({
        code: "policy_mismatch",
        message: "Settled reservation is missing a logical request id.",
        reservationId: reservation.reservationId,
        accountId: reservation.accountId,
      });
    }
  }

  const settledRequests = new Set(
    reservations.filter((row) => row.status === "settled" || row.status === "shortfall").map((row) => row.logicalRequestId),
  );
  const reservedRequests = new Set(reservations.map((row) => row.logicalRequestId));

  for (const receipt of receipts) {
    if (!receipt.capability || receipt.resultStatus === "unauthorized") continue;
    const reserved = reservedRequests.has(receipt.requestId);
    const settled = settledRequests.has(receipt.requestId);
    if (receipt.resultStatus === "completed" && reserved && !settled) {
      anomalies.push({
        code: "missing_settlement",
        message: "Usage receipt completed without credit settlement.",
        logicalRequestId: receipt.requestId,
        usageReceiptId: receipt.receiptId,
      });
    }
  }

  for (const reservation of reservations) {
    if (reservation.status !== "settled" && reservation.status !== "shortfall") continue;
    const match = receipts.some((row) => row.requestId === reservation.logicalRequestId || row.receiptId === reservation.logicalRequestId);
    if (!match) {
      anomalies.push({
        code: "settlement_without_usage",
        message: "Credit settlement has no matching usage receipt.",
        reservationId: reservation.reservationId,
        logicalRequestId: reservation.logicalRequestId,
        accountId: reservation.accountId,
      });
    }
  }

  return {
    generatedAt: nowIso(),
    anomalies,
    overlappingPolicies: detectOverlappingPolicies(),
  };
}
