import type { GeneratedMediaResult, MediaOperation, PersistenceState } from "../contracts/media.js";
import { sanitizeMediaForLedger } from "../contracts/media.js";
import { newId, nowIso } from "../lib/crypto.js";
import type { SovereignDrive } from "./drive.js";
import { mediaHold } from "./hold.js";
import type { ProviderMediaOutput } from "../providers/types.js";

export async function normalizeGeneratedMedia(input: {
  outputs: ProviderMediaOutput[];
  providerId: string;
  modelId?: string;
  operation: MediaOperation;
  actorTrustId: string;
  applicationId: string;
  sourceAssetIds: string[];
  persistCanonical: boolean;
  drive: SovereignDrive;
  tenantId?: string;
  accessToken?: string;
  executionRef?: string;
  idempotencyKey?: string;
  maxTransientBytes: number;
  capability?: GeneratedMediaResult["capability"];
  voiceProfileId?: string;
  logicalRequestId?: string;
}): Promise<GeneratedMediaResult[]> {
  const createdAt = nowIso();
  const results: GeneratedMediaResult[] = [];
  for (const output of input.outputs) {
    const mediaId = newId("media");
    let persistenceState: PersistenceState = "transient";
    let canonicalAssetReference: string | undefined;
    let contentBase64 = output.contentBase64;
    if (contentBase64 && Buffer.byteLength(contentBase64, "base64") > input.maxTransientBytes) {
      contentBase64 = undefined;
    }
    if (input.persistCanonical && input.idempotencyKey) {
      const held = mediaHold.get(holdKey(input.applicationId, input.idempotencyKey));
      if (held?.canonicalAssetId) {
        persistenceState = "canonical";
        canonicalAssetReference = held.canonicalAssetId;
        contentBase64 = undefined;
        results.push(mediaResult(input, output, mediaId, persistenceState, canonicalAssetReference, createdAt, contentBase64));
        continue;
      }
    }
    if (input.persistCanonical && output.contentBase64) {
      persistenceState = "persisting";
      const bytes = Buffer.from(output.contentBase64, "base64");
      const filename = filenameFor(output.mimeType);
      if (input.idempotencyKey) {
        mediaHold.put(holdKey(input.applicationId, input.idempotencyKey), {
          mimeType: output.mimeType,
          bytes,
          filename,
          width: output.width,
          height: output.height,
        });
      }
      const written = await input.drive.writeGenerated({
        actorTrustId: input.actorTrustId,
        callerId: input.applicationId,
        tenantId: input.tenantId,
        accessToken: input.accessToken,
        mimeType: output.mimeType,
        bytes,
        filename,
        mediaType: output.mimeType,
        capability: input.capability ?? "IMAGE",
        providerId: input.providerId,
        modelId: input.modelId,
        sourceAssetIds: input.sourceAssetIds,
        executionRef: input.executionRef,
        generated: true,
        width: output.width,
        height: output.height,
      });
      if (written.ok) {
        persistenceState = "canonical";
        canonicalAssetReference = written.reference.assetId;
        contentBase64 = undefined;
        if (input.idempotencyKey) {
          mediaHold.markCanonical(holdKey(input.applicationId, input.idempotencyKey), written.reference.assetId);
        }
      } else {
        persistenceState = "failed";
      }
    } else if (input.persistCanonical) {
      persistenceState = "failed";
    }
    results.push(mediaResult(input, output, mediaId, persistenceState, canonicalAssetReference, createdAt, contentBase64));
  }
  return results;
}

export async function persistHeldGeneratedMedia(input: {
  drive: SovereignDrive;
  callerId: string;
  idempotencyKey: string;
  actorTrustId: string;
  tenantId?: string;
  accessToken?: string;
  providerId?: string;
  modelId?: string;
  sourceAssetIds?: string[];
  executionRef?: string;
  capability?: string;
}): Promise<{ persistenceState: PersistenceState; canonicalAssetReference?: string; error?: string }> {
  const key = holdKey(input.callerId, input.idempotencyKey);
  const held = mediaHold.get(key);
  if (held?.canonicalAssetId) {
    return { persistenceState: "canonical", canonicalAssetReference: held.canonicalAssetId };
  }
  if (!held?.bytes.length) {
    return { persistenceState: "failed", error: "drive_write_failed" };
  }
  const written = await input.drive.writeGenerated({
    actorTrustId: input.actorTrustId,
    callerId: input.callerId,
    tenantId: input.tenantId,
    accessToken: input.accessToken,
    mimeType: held.mimeType,
    bytes: held.bytes,
    filename: held.filename || filenameFor(held.mimeType),
    mediaType: held.mimeType,
    capability: input.capability ?? (held.mimeType.startsWith("audio/") ? "TEXT_TO_SPEECH" : "IMAGE"),
    providerId: input.providerId,
    modelId: input.modelId,
    sourceAssetIds: input.sourceAssetIds,
    executionRef: input.executionRef,
    generated: true,
    width: held.width,
    height: held.height,
  });
  if (!written.ok) return { persistenceState: "failed", error: written.error };
  mediaHold.markCanonical(key, written.reference.assetId);
  return { persistenceState: "canonical", canonicalAssetReference: written.reference.assetId };
}

function mediaResult(
  input: {
    providerId: string;
    modelId?: string;
    operation: MediaOperation;
    actorTrustId: string;
    applicationId: string;
    sourceAssetIds: string[];
    capability?: GeneratedMediaResult["capability"];
    voiceProfileId?: string;
    logicalRequestId?: string;
  },
  output: ProviderMediaOutput,
  mediaId: string,
  persistenceState: PersistenceState,
  canonicalAssetReference: string | undefined,
  createdAt: string,
  contentBase64?: string,
): GeneratedMediaResult {
  const capability = input.capability ?? "IMAGE";
  return {
    mediaId,
    capability,
    operation: input.operation,
    provider: input.providerId,
    model: input.modelId,
    mimeType: output.mimeType,
    width: output.width,
    height: output.height,
    durationSeconds: output.durationSeconds,
    byteSize: output.byteSize,
    voiceProfileId: input.voiceProfileId,
    persistenceState,
    transientReference: persistenceState === "canonical" ? undefined : mediaId,
    canonicalAssetReference,
    provenance: {
      generated: true,
      capability,
      operation: input.operation,
      providerId: input.providerId,
      modelId: input.modelId,
      actorTrustId: input.actorTrustId,
      applicationId: input.applicationId,
      sourceAssetIds: input.sourceAssetIds,
      createdAt,
      canonicalAssetId: canonicalAssetReference,
      voiceProfileId: input.voiceProfileId,
      logicalRequestId: input.logicalRequestId,
    },
    createdAt,
    expiresAt: output.expiresAt,
    contentBase64,
  };
}

function filenameFor(mimeType: string) {
  if (mimeType.startsWith("audio/")) {
    if (mimeType.includes("wav")) return "generated.wav";
    if (mimeType.includes("ogg") || mimeType.includes("opus")) return "generated.ogg";
    if (mimeType.includes("aac") || mimeType.includes("mp4")) return "generated.aac";
    return "generated.mp3";
  }
  return "generated.png";
}

export function holdKey(callerId: string, idempotencyKey: string) {
  return `${callerId}:${idempotencyKey}`;
}

export function mediaWithoutBytes(media?: GeneratedMediaResult[]) {
  return sanitizeMediaForLedger(media);
}
