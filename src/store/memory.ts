import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerEntry, LedgerQuery, LedgerStatus } from "../contracts/ledger.js";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";
import { aggregateEntries, matchesLedgerQuery } from "../usage/aggregate.js";
import type { DigiAiStore } from "./types.js";

export type { DigiAiStore } from "./types.js";

export class MemoryStore implements DigiAiStore {
  readonly usage: UsageRecord[] = [];
  readonly receipts: RequestReceipt[] = [];
  readonly ledger: LedgerEntry[] = [];
  private writable = true;

  setWritable(value: boolean) {
    this.writable = value;
  }

  async recordUsage(row: UsageRecord) {
    if (!this.writable) throw new Error("usage_ledger_unavailable");
    if (row.receiptId && this.usage.some((existing) => existing.receiptId === row.receiptId)) return;
    if (this.usage.some((existing) => existing.usageId === row.usageId)) return;
    this.usage.push(row);
  }

  async recordReceipt(row: RequestReceipt) {
    if (!this.writable) throw new Error("usage_ledger_unavailable");
    if (this.receipts.some((existing) => existing.receiptId === row.receiptId)) return;
    this.receipts.push(row);
  }

  async listUsage() {
    return [...this.usage];
  }

  async listReceipts() {
    return [...this.receipts];
  }

  async recordLedger(entry: LedgerEntry) {
    if (!this.writable) throw new Error("usage_ledger_unavailable");
    const duplicate =
      this.ledger.some((row) => row.receiptId === entry.receiptId) ||
      Boolean(
        entry.attemptIndex != null &&
          this.ledger.some((row) => row.requestId === entry.requestId && row.attemptIndex === entry.attemptIndex && row.kind === "usage"),
      ) ||
      Boolean(entry.providerRequestId && this.ledger.some((row) => row.providerRequestId === entry.providerRequestId));
    if (duplicate) return { inserted: false };
    this.ledger.push(entry);
    return { inserted: true };
  }

  async getLedgerByReceiptId(receiptId: string) {
    return this.ledger.find((row) => row.receiptId === receiptId) ?? null;
  }

  async queryLedger(query: LedgerQuery) {
    return this.ledger.filter((row) => matchesLedgerQuery(row, query));
  }

  async aggregateUsage(query: LedgerQuery) {
    return aggregateEntries(await this.queryLedger(query));
  }

  ledgerStatus(): LedgerStatus {
    return { durable: false, writable: this.writable, backend: "memory" };
  }
}

export class FileBackedStore extends MemoryStore {
  constructor(private readonly dir: string) {
    super();
  }

  private async write(file: string, row: unknown) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, file), `${JSON.stringify(row)}\n`, "utf8");
  }

  override async recordUsage(row: UsageRecord) {
    await super.recordUsage(row);
    await this.write("usage.jsonl", row);
  }

  override async recordReceipt(row: RequestReceipt) {
    await super.recordReceipt(row);
    await this.write("receipts.jsonl", row);
  }

  override async recordLedger(entry: LedgerEntry) {
    const result = await super.recordLedger(entry);
    if (result.inserted) await this.write("ledger.jsonl", entry);
    return result;
  }

  override ledgerStatus(): LedgerStatus {
    return { durable: true, writable: true, backend: "file" };
  }
}

export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}
