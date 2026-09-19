import { createHash } from "node:crypto";
import type { CanonicalAssetReference } from "../contracts/media.js";
import type { DriveErrorClass } from "./errors.js";

export type DriveAuthContext = {
  actorTrustId: string;
  callerId: string;
  tenantId?: string;
  accessToken?: string;
};

export type DriveWriteInput = DriveAuthContext & {
  mimeType: string;
  bytes: Buffer;
  filename?: string;
  mediaType?: string;
  capability?: string;
  providerId?: string;
  modelId?: string;
  sourceAssetIds?: string[];
  executionRef?: string;
  generated?: boolean;
  width?: number;
  height?: number;
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
};

export type DriveAuthResult =
  | { ok: true; tenantId?: string }
  | { ok: false; error: "media_access_denied" | "not_found" | DriveErrorClass; detail: string };

export type DriveReadResult =
  | {
      ok: true;
      assetId: string;
      mimeType: string;
      bytes: Buffer;
      width?: number;
      height?: number;
      filename?: string;
      tenantId?: string;
      hash?: string;
    }
  | { ok: false; error: "media_access_denied" | "not_found" | "unavailable" | DriveErrorClass; detail: string };

export type DriveWriteResult =
  | { ok: true; reference: CanonicalAssetReference; hash?: string; sizeBytes?: number }
  | { ok: false; error: "unavailable" | "persistence_failed" | DriveErrorClass; detail: string };

export type DriveStatus = {
  available: boolean;
  read: boolean;
  write: boolean;
  configured?: boolean;
  runtimeReadVerified?: boolean;
  runtimeWriteVerified?: boolean;
};

/**
 * Canonical media ownership belongs to Sovereign Drive.
 * Digi AI never opens a Drive database. This is the only persistence seam.
 */
export interface SovereignDrive {
  status(): DriveStatus;
  authorizeRead(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult>;
  readAsset(input: DriveAuthContext & { assetId: string }): Promise<DriveReadResult>;
  writeGenerated(input: DriveWriteInput): Promise<DriveWriteResult>;
  createWriteIntent?(input: DriveAuthContext): Promise<DriveAuthResult>;
  persistGeneratedMedia?(input: DriveWriteInput): Promise<DriveWriteResult>;
  resolveCanonicalAsset?(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult>;
  verifyOwnership?(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult>;
}

/** No legitimate Drive write/read contract is bound. */
export class UnboundDrive implements SovereignDrive {
  status(): DriveStatus {
    return { available: false, read: false, write: false, configured: false, runtimeReadVerified: false, runtimeWriteVerified: false };
  }

  async authorizeRead(): Promise<DriveAuthResult> {
    return { ok: false, error: "media_access_denied", detail: "Sovereign Drive is not bound. Canonical asset access is denied." };
  }

  async readAsset(): Promise<DriveReadResult> {
    return { ok: false, error: "unavailable", detail: "Sovereign Drive read contract is not configured." };
  }

  async writeGenerated(): Promise<DriveWriteResult> {
    return { ok: false, error: "unavailable", detail: "Sovereign Drive write contract is required for canonical persistence." };
  }
}

export type MemoryDriveAsset = {
  assetId: string;
  tenantId: string;
  actorTrustId?: string;
  mimeType: string;
  bytes: Buffer;
  filename?: string;
  hash?: string;
  metadata?: Record<string, string>;
};

export type MemoryDriveBehavior = {
  writeError?: DriveErrorClass;
  readError?: DriveErrorClass;
  failNextWrites?: number;
  integrityFail?: boolean;
};

/** Test-only Drive. Not a Digi AI media library. */
export class MemoryDrive implements SovereignDrive {
  writes = 0;
  reads = 0;
  lastWrite?: DriveWriteInput;

  constructor(
    private readonly assets: MemoryDriveAsset[] = [],
    private readonly behavior: MemoryDriveBehavior = {},
  ) {}

  status(): DriveStatus {
    return { available: true, read: true, write: true, configured: true, runtimeReadVerified: true, runtimeWriteVerified: true };
  }

  async authorizeRead(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult> {
    if (this.behavior.readError) return { ok: false, error: this.behavior.readError, detail: this.behavior.readError };
    const asset = this.assets.find((row) => row.assetId === input.assetId);
    if (!asset) return { ok: false, error: "drive_asset_not_found", detail: "Asset was not found." };
    if (input.tenantId && asset.tenantId !== input.tenantId) {
      return { ok: false, error: "drive_access_denied", detail: "Actor is not authorized for that asset." };
    }
    if (asset.actorTrustId && asset.actorTrustId !== input.actorTrustId) {
      return { ok: false, error: "drive_access_denied", detail: "Actor is not authorized for that asset." };
    }
    return { ok: true, tenantId: asset.tenantId };
  }

  async readAsset(input: DriveAuthContext & { assetId: string }): Promise<DriveReadResult> {
    this.reads += 1;
    const auth = await this.authorizeRead(input);
    if (!auth.ok) return auth;
    const asset = this.assets.find((row) => row.assetId === input.assetId)!;
    return {
      ok: true,
      assetId: asset.assetId,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      filename: asset.filename,
      tenantId: asset.tenantId,
      hash: asset.hash,
    };
  }

  async writeGenerated(input: DriveWriteInput): Promise<DriveWriteResult> {
    this.lastWrite = input;
    if (this.behavior.writeError) return { ok: false, error: this.behavior.writeError, detail: this.behavior.writeError };
    if (this.behavior.integrityFail) return { ok: false, error: "drive_integrity_failed", detail: "Drive checksum did not match uploaded bytes." };
    if (this.behavior.failNextWrites && this.behavior.failNextWrites > 0) {
      this.behavior.failNextWrites -= 1;
      return { ok: false, error: "drive_write_failed", detail: "Injected write failure." };
    }
    this.writes += 1;
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const assetId = `drv_${this.assets.length + 1}`;
    this.assets.push({
      assetId,
      tenantId: input.tenantId || input.actorTrustId,
      actorTrustId: input.actorTrustId,
      mimeType: input.mimeType,
      bytes: input.bytes,
      filename: input.filename,
      hash,
      metadata: {
        generated: input.generated === false ? "false" : "true",
        applicationId: input.callerId,
        actorTrustId: input.actorTrustId,
        capability: input.capability ?? "",
        providerId: input.providerId ?? "",
        modelId: input.modelId ?? "",
        sourceAssetIds: (input.sourceAssetIds ?? []).join(","),
        executionRef: input.executionRef ?? "",
        byteSize: String(input.bytes.length),
        width: input.width != null ? String(input.width) : "",
        height: input.height != null ? String(input.height) : "",
      },
    });
    return { ok: true, reference: { assetId, system: "sovereign-drive", tenantId: input.tenantId || input.actorTrustId }, hash, sizeBytes: input.bytes.length };
  }

  async createWriteIntent(input: DriveAuthContext): Promise<DriveAuthResult> {
    if (!input.actorTrustId || !input.callerId) {
      return { ok: false, error: "drive_auth_failed", detail: "Write intent requires an authenticated actor and caller." };
    }
    return { ok: true, tenantId: input.tenantId };
  }

  async persistGeneratedMedia(input: DriveWriteInput): Promise<DriveWriteResult> {
    return this.writeGenerated(input);
  }

  async resolveCanonicalAsset(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult> {
    return this.authorizeRead(input);
  }

  async verifyOwnership(input: DriveAuthContext & { assetId: string }): Promise<DriveAuthResult> {
    return this.authorizeRead(input);
  }
}
