import type { CanonicalAssetReference } from "../contracts/media.js";

export type DriveAuthResult =
  | { ok: true; tenantId?: string }
  | { ok: false; error: "media_access_denied" | "not_found"; detail: string };

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
    }
  | { ok: false; error: "media_access_denied" | "not_found" | "unavailable"; detail: string };

export type DriveWriteResult =
  | { ok: true; reference: CanonicalAssetReference }
  | { ok: false; error: "unavailable" | "persistence_failed"; detail: string };

export type DriveStatus = {
  available: boolean;
  read: boolean;
  write: boolean;
};

/**
 * Canonical media ownership belongs to Sovereign Drive.
 * Digi AI never opens a Drive database. This is the only persistence seam.
 */
export interface SovereignDrive {
  status(): DriveStatus;
  authorizeRead(input: {
    actorTrustId: string;
    callerId: string;
    tenantId?: string;
    assetId: string;
  }): Promise<DriveAuthResult>;
  readAsset(input: {
    actorTrustId: string;
    callerId: string;
    tenantId?: string;
    assetId: string;
  }): Promise<DriveReadResult>;
  writeGenerated(input: {
    actorTrustId: string;
    callerId: string;
    tenantId?: string;
    mimeType: string;
    bytes: Buffer;
    filename?: string;
  }): Promise<DriveWriteResult>;
}

/** No legitimate Drive write/read contract is bound in this phase. */
export class UnboundDrive implements SovereignDrive {
  status(): DriveStatus {
    return { available: false, read: false, write: false };
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
};

/** Test-only Drive. Not a Digi AI media library. */
export class MemoryDrive implements SovereignDrive {
  constructor(private readonly assets: MemoryDriveAsset[] = []) {}

  status(): DriveStatus {
    return { available: true, read: true, write: true };
  }

  async authorizeRead(input: { actorTrustId: string; callerId: string; tenantId?: string; assetId: string }): Promise<DriveAuthResult> {
    const asset = this.assets.find((row) => row.assetId === input.assetId);
    if (!asset) return { ok: false, error: "not_found", detail: "Asset was not found." };
    if (input.tenantId && asset.tenantId !== input.tenantId) {
      return { ok: false, error: "media_access_denied", detail: "Actor is not authorized for that asset." };
    }
    if (asset.actorTrustId && asset.actorTrustId !== input.actorTrustId) {
      return { ok: false, error: "media_access_denied", detail: "Actor is not authorized for that asset." };
    }
    return { ok: true, tenantId: asset.tenantId };
  }

  async readAsset(input: { actorTrustId: string; callerId: string; tenantId?: string; assetId: string }): Promise<DriveReadResult> {
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
    };
  }

  async writeGenerated(input: {
    actorTrustId: string;
    callerId: string;
    tenantId?: string;
    mimeType: string;
    bytes: Buffer;
    filename?: string;
  }): Promise<DriveWriteResult> {
    const assetId = `drv_${this.assets.length + 1}`;
    this.assets.push({
      assetId,
      tenantId: input.tenantId || input.actorTrustId,
      actorTrustId: input.actorTrustId,
      mimeType: input.mimeType,
      bytes: input.bytes,
      filename: input.filename,
    });
    return { ok: true, reference: { assetId, system: "sovereign-drive", tenantId: input.tenantId || input.actorTrustId } };
  }
}
