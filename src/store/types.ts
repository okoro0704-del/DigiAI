import type { LedgerEntry, LedgerQuery, LedgerStatus, UsageAggregate } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";

export interface DigiAiStore {
  recordUsage(row: UsageRecord): Promise<void>;
  recordReceipt(row: RequestReceipt): Promise<void>;
  listUsage(): Promise<UsageRecord[]>;
  listReceipts(): Promise<RequestReceipt[]>;
  recordLedger(entry: LedgerEntry): Promise<{ inserted: boolean }>;
  getLedgerByReceiptId(receiptId: string): Promise<LedgerEntry | null>;
  queryLedger(query: LedgerQuery): Promise<LedgerEntry[]>;
  aggregateUsage(query: LedgerQuery): Promise<UsageAggregate>;
  ledgerStatus(): LedgerStatus;
  findReceiptByIdempotency?(callerId: string, idempotencyKey: string): Promise<RequestReceipt | null>;
  updateReceiptSnapshot?(receiptId: string, resultSnapshot: RequestReceipt["resultSnapshot"]): Promise<void>;
  ready?(): Promise<void>;
}
