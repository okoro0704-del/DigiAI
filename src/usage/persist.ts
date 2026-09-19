import type { LedgerEntry } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { logEvent } from "../lib/log.js";
import type { DigiAiStore } from "../store/types.js";

export class LedgerPersistError extends Error {
  constructor(message = "Usage ledger could not record this execution.") {
    super(message);
    this.name = "LedgerPersistError";
  }
}

export async function persistExecution(
  store: DigiAiStore,
  input: { ledger: LedgerEntry; usage: UsageRecord; receipt: RequestReceipt },
): Promise<{ inserted: boolean; ledger: LedgerEntry }> {
  try {
    const written = await store.recordLedger(input.ledger);
    await store.recordUsage({
      ...input.usage,
      receiptId: input.ledger.receiptId,
      applicationId: input.ledger.applicationId,
      tenantId: input.ledger.tenantId,
      pricingVersion: input.ledger.pricingVersion,
      currency: input.ledger.currency,
      estimatedProviderCost: input.ledger.estimatedProviderCost,
      actualProviderCost: input.ledger.actualProviderCost,
      digiAiUnits: null,
    });
    await store.recordReceipt(input.receipt);
    return { inserted: written.inserted, ledger: input.ledger };
  } catch (err) {
    logEvent("ledger_write_failed", { receiptId: input.ledger.receiptId, requestId: input.ledger.requestId });
    throw new LedgerPersistError(err instanceof Error ? err.message : "ledger_write_failed");
  }
}
