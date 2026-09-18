import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RequestReceipt, UsageRecord } from "../contracts/usage.js";

export interface DigiAiStore {
  recordUsage(row: UsageRecord): Promise<void>;
  recordReceipt(row: RequestReceipt): Promise<void>;
  listUsage(): Promise<UsageRecord[]>;
  listReceipts(): Promise<RequestReceipt[]>;
}

export class MemoryStore implements DigiAiStore {
  readonly usage: UsageRecord[] = [];
  readonly receipts: RequestReceipt[] = [];

  async recordUsage(row: UsageRecord) {
    this.usage.push(row);
  }

  async recordReceipt(row: RequestReceipt) {
    this.receipts.push(row);
  }

  async listUsage() {
    return [...this.usage];
  }

  async listReceipts() {
    return [...this.receipts];
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
}

export function createStore(dataDir?: string): DigiAiStore {
  return dataDir ? new FileBackedStore(dataDir) : new MemoryStore();
}
