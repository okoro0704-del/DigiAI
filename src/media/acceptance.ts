import type { SovereignDrive } from "./drive.js";
import { tinyWavFixture } from "./audio.js";

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

export const AUDIO_DRIVE_ACCEPTANCE_LABEL = "AUDIO_DRIVE_ACCEPTANCE";

export async function persistAudioAcceptanceFixture(input: {
  drive: SovereignDrive;
  actorTrustId: string;
  callerId: string;
  tenantId?: string;
  accessToken?: string;
}) {
  const bytes = tinyWavFixture(0.05);
  const written = await input.drive.writeGenerated({
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    tenantId: input.tenantId,
    accessToken: input.accessToken,
    mimeType: "audio/wav",
    bytes,
    filename: "audio-drive-acceptance.wav",
    mediaType: "audio/wav",
    capability: "TEXT_TO_SPEECH",
    providerId: "none",
    modelId: "fixture",
    sourceAssetIds: [],
    executionRef: AUDIO_DRIVE_ACCEPTANCE_LABEL,
    generated: true,
  });
  if (!written.ok) {
    return {
      ok: false as const,
      label: AUDIO_DRIVE_ACCEPTANCE_LABEL,
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
    label: AUDIO_DRIVE_ACCEPTANCE_LABEL,
    note: "Safe audio fixture through Digi AI media persistence. Not real TTS provider acceptance.",
    canonicalAssetReference: written.reference.assetId,
    system: written.reference.system,
    tenantId: written.reference.tenantId,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    readVerified: read.ok,
  };
}

export const MUSIC_DRIVE_ACCEPTANCE_LABEL = "MUSIC_DRIVE_ACCEPTANCE";

export async function persistMusicAcceptanceFixture(input: {
  drive: SovereignDrive;
  actorTrustId: string;
  callerId: string;
  tenantId?: string;
  accessToken?: string;
}) {
  const bytes = tinyWavFixture(0.05);
  const written = await input.drive.writeGenerated({
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    tenantId: input.tenantId,
    accessToken: input.accessToken,
    mimeType: "audio/wav",
    bytes,
    filename: "music-drive-acceptance.wav",
    mediaType: "audio/wav",
    capability: "MUSIC",
    providerId: "none",
    modelId: "fixture",
    sourceAssetIds: [],
    executionRef: MUSIC_DRIVE_ACCEPTANCE_LABEL,
    generated: true,
    durationSeconds: 0.05,
    sampleRate: 8000,
    channels: 1,
  });
  if (!written.ok) {
    return {
      ok: false as const,
      label: MUSIC_DRIVE_ACCEPTANCE_LABEL,
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
    label: MUSIC_DRIVE_ACCEPTANCE_LABEL,
    note: "Safe music fixture through Digi AI media persistence. Not real music generation.",
    canonicalAssetReference: written.reference.assetId,
    system: written.reference.system,
    tenantId: written.reference.tenantId,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    readVerified: read.ok,
  };
}

/** Minimal ISO BMFF box. Drive fixture only — not real video generation. */
export function tinyMp4Fixture(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65,
  ]);
}

export const VIDEO_DRIVE_ACCEPTANCE_LABEL = "VIDEO_DRIVE_ACCEPTANCE";

export async function persistVideoAcceptanceFixture(input: {
  drive: SovereignDrive;
  actorTrustId: string;
  callerId: string;
  tenantId?: string;
  accessToken?: string;
}) {
  const bytes = tinyMp4Fixture();
  const written = await input.drive.writeGenerated({
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    tenantId: input.tenantId,
    accessToken: input.accessToken,
    mimeType: "video/mp4",
    bytes,
    filename: "video-drive-acceptance.mp4",
    mediaType: "video/mp4",
    capability: "VIDEO",
    providerId: "none",
    modelId: "fixture",
    sourceAssetIds: [],
    executionRef: VIDEO_DRIVE_ACCEPTANCE_LABEL,
    generated: true,
    width: 1280,
    height: 720,
    durationSeconds: 1,
  });
  if (!written.ok) {
    return {
      ok: false as const,
      label: VIDEO_DRIVE_ACCEPTANCE_LABEL,
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
    label: VIDEO_DRIVE_ACCEPTANCE_LABEL,
    note: "Safe video fixture through Digi AI media persistence. Not real video generation.",
    canonicalAssetReference: written.reference.assetId,
    system: written.reference.system,
    tenantId: written.reference.tenantId,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    mimeType: "video/mp4",
    durationSeconds: 1,
    width: 1280,
    height: 720,
    readVerified: read.ok,
  };
}
