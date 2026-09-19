export type HeldMedia = {
  mimeType: string;
  bytes: Buffer;
  filename?: string;
  width?: number;
  height?: number;
  canonicalAssetId?: string;
  createdAt: number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Bounded short-lived hold for persistence retry. Not a media library. */
export class TransientMediaHold {
  private readonly items = new Map<string, HeldMedia>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  put(key: string, value: Omit<HeldMedia, "createdAt" | "canonicalAssetId"> & { canonicalAssetId?: string }) {
    this.sweep();
    this.items.set(key, { ...value, createdAt: Date.now() });
  }

  get(key: string): HeldMedia | undefined {
    this.sweep();
    return this.items.get(key);
  }

  markCanonical(key: string, assetId: string) {
    const current = this.get(key);
    if (current) {
      current.canonicalAssetId = assetId;
      current.bytes = Buffer.alloc(0);
    }
  }

  release(key: string) {
    this.items.delete(key);
  }

  takeBytes(key: string): HeldMedia | undefined {
    const current = this.get(key);
    return current && !current.canonicalAssetId ? current : undefined;
  }

  private sweep() {
    const now = Date.now();
    for (const [key, value] of this.items) {
      if (now - value.createdAt > this.ttlMs) this.items.delete(key);
    }
  }
}

export const mediaHold = new TransientMediaHold();
