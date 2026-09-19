export type VideoJobState = "submitted" | "processing" | "completed" | "failed";

export type HeldVideoJob = {
  operationId: string;
  requestId: string;
  receiptId?: string;
  model: string;
  status: VideoJobState;
  createdAt: number;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Bounded hold for in-flight provider video operations. Not a job platform. */
export class TransientVideoJobHold {
  private readonly items = new Map<string, HeldVideoJob>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  put(key: string, value: Omit<HeldVideoJob, "createdAt"> & { createdAt?: number }) {
    this.sweep();
    this.items.set(key, { ...value, createdAt: value.createdAt ?? Date.now() });
  }

  get(key: string): HeldVideoJob | undefined {
    this.sweep();
    return this.items.get(key);
  }

  mark(key: string, status: VideoJobState, extras?: Partial<HeldVideoJob>) {
    const current = this.get(key);
    if (current) this.items.set(key, { ...current, ...extras, status });
  }

  release(key: string) {
    this.items.delete(key);
  }

  private sweep() {
    const now = Date.now();
    for (const [key, value] of this.items) {
      if (now - value.createdAt > this.ttlMs) this.items.delete(key);
    }
  }
}

export const videoJobHold = new TransientVideoJobHold();

export function videoJobKey(callerId: string, idempotencyKey: string) {
  return `${callerId}:${idempotencyKey}`;
}
