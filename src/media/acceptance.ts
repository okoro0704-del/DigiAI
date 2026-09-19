import type { SovereignDrive } from "./drive.js";

/** 1x1 PNG. Drive bridge acceptance only — not real AI image generation. */
export const DRIVE_ACCEPTANCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export const DRIVE_ACCEPTANCE_LABEL = "DRIVE_BRIDGE_ACCEPTANCE";

export async function persistDriveAcceptanceFixture(input: {
  drive: SovereignDrive;
  actorTrustId: string;
  callerId: string;
  tenantId?: string;
  accessToken?: string;
}) {
  const written = await input.drive.writeGenerated({
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    tenantId: input.tenantId,
    accessToken: input.accessToken,
    mimeType: "image/png",
    bytes: DRIVE_ACCEPTANCE_PNG,
    filename: "drive-bridge-acceptance.png",
    mediaType: "image/png",
    capability: "IMAGE",
    providerId: "none",
    modelId: "fixture",
    sourceAssetIds: [],
    executionRef: DRIVE_ACCEPTANCE_LABEL,
    generated: true,
    width: 1,
    height: 1,
  });
  if (!written.ok) {
    return {
      ok: false as const,
      label: DRIVE_ACCEPTANCE_LABEL,
      error: written.error,
      detail: written.detail,
    };
  }
  const read = await input.drive.readAsset({
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    tenantId: input.tenantId,
    accessToken: input.accessToken,
    assetId: written.reference.assetId,
  });
  return {
    ok: true as const,
    label: DRIVE_ACCEPTANCE_LABEL,
    note: "Safe fixture through Digi AI media persistence. Not real AI image generation.",
    canonicalAssetReference: written.reference.assetId,
    system: written.reference.system,
    tenantId: written.reference.tenantId,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    readVerified: read.ok,
  };
}
