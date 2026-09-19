import type { GeneratedMediaResult, ImageOperation, PersistenceState } from "../contracts/media.js";
import { sanitizeMediaForLedger } from "../contracts/media.js";
import { newId, nowIso } from "../lib/crypto.js";
import type { SovereignDrive } from "./drive.js";
import type { ProviderMediaOutput } from "../providers/types.js";

export async function normalizeGeneratedMedia(input: {
  outputs: ProviderMediaOutput[];
  providerId: string;
  modelId?: string;
  operation: ImageOperation;
  actorTrustId: string;
  applicationId: string;
  sourceAssetIds: string[];
  persistCanonical: boolean;
  drive: SovereignDrive;
  tenantId?: string;
  maxTransientBytes: number;
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
    if (input.persistCanonical && output.contentBase64) {
      const written = await input.drive.writeGenerated({
        actorTrustId: input.actorTrustId,
        callerId: input.applicationId,
        tenantId: input.tenantId,
        mimeType: output.mimeType,
        bytes: Buffer.from(output.contentBase64, "base64"),
      });
      if (written.ok) {
        persistenceState = "canonical";
        canonicalAssetReference = written.reference.assetId;
        contentBase64 = undefined;
      } else {
        persistenceState = "failed";
      }
    } else if (input.persistCanonical) {
      persistenceState = "failed";
    }
    results.push({
      mediaId,
      capability: "IMAGE",
      operation: input.operation,
      provider: input.providerId,
      model: input.modelId,
      mimeType: output.mimeType,
      width: output.width,
      height: output.height,
      byteSize: output.byteSize,
      persistenceState,
      transientReference: persistenceState === "canonical" ? undefined : mediaId,
      canonicalAssetReference,
      provenance: {
        generated: true,
        capability: "IMAGE",
        operation: input.operation,
        providerId: input.providerId,
        modelId: input.modelId,
        actorTrustId: input.actorTrustId,
        applicationId: input.applicationId,
        sourceAssetIds: input.sourceAssetIds,
        createdAt,
        canonicalAssetId: canonicalAssetReference,
      },
      createdAt,
      expiresAt: output.expiresAt,
      contentBase64,
    });
  }
  return results;
}

export function mediaWithoutBytes(media?: GeneratedMediaResult[]) {
  return sanitizeMediaForLedger(media);
}
