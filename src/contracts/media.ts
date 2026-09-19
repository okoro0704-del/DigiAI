export const IMAGE_SOURCE_TYPES = ["sovereign_drive", "https", "inline", "transient"] as const;
export type ImageSourceType = (typeof IMAGE_SOURCE_TYPES)[number];

export const IMAGE_OPERATIONS = ["generate", "edit", "analyze"] as const;
export type ImageOperation = (typeof IMAGE_OPERATIONS)[number];

export const PERSISTENCE_STATES = ["transient", "persisting", "canonical", "failed"] as const;
export type PersistenceState = (typeof PERSISTENCE_STATES)[number];

export const SIZE_CLASSES = ["square", "portrait", "landscape"] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** Provider-neutral image input. Callers do not pass provider URLs as the contract. */
export type ImageInputReference = {
  sourceType: ImageSourceType;
  assetId?: string;
  reference?: string;
  mediaType?: "image";
  mimeType?: string;
  width?: number;
  height?: number;
  byteSize?: number;
  provenance?: string;
  accessPolicy?: string;
  filename?: string;
  /** Inline only. Bound at the edge. Never written to the usage ledger. */
  dataBase64?: string;
};

export type ImageConstraints = {
  aspectRatio?: string;
  sizeClass?: SizeClass;
  transparentBackground?: boolean;
  outputFormat?: "png" | "jpeg" | "webp";
  count?: number;
  persistCanonical?: boolean;
};

export const AUDIO_SOURCE_TYPES = IMAGE_SOURCE_TYPES;
export type AudioSourceType = ImageSourceType;

export const SPEECH_OPERATIONS = ["transcribe", "translate", "speak", "converse"] as const;
export type SpeechOperation = (typeof SPEECH_OPERATIONS)[number];
export type MediaOperation = ImageOperation | SpeechOperation;

export const AUDIO_OUTPUT_FORMATS = ["mp3", "wav", "opus", "aac"] as const;
export type AudioOutputFormat = (typeof AUDIO_OUTPUT_FORMATS)[number];

/** Provider-neutral audio input. Callers do not pass provider URLs as the contract. */
export type AudioInputReference = {
  sourceType: AudioSourceType;
  assetId?: string;
  reference?: string;
  mediaType?: "audio";
  mimeType?: string;
  durationSeconds?: number;
  byteSize?: number;
  provenance?: string;
  accessPolicy?: string;
  filename?: string;
  dataBase64?: string;
};

export type MediaProvenance = {
  generated: boolean;
  capability: "IMAGE" | "VISION" | "SPEECH_TO_TEXT" | "TEXT_TO_SPEECH" | "VOICE";
  operation: MediaOperation;
  providerId: string;
  modelId?: string;
  actorTrustId?: string;
  applicationId?: string;
  sourceAssetIds: string[];
  createdAt: string;
  canonicalAssetId?: string;
  voiceProfileId?: string;
  logicalRequestId?: string;
};

export type GeneratedMediaResult = {
  mediaId: string;
  capability: "IMAGE" | "TEXT_TO_SPEECH" | "VOICE";
  operation: MediaOperation;
  provider: string;
  model?: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  byteSize?: number;
  voiceProfileId?: string;
  persistenceState: PersistenceState;
  transientReference?: string;
  canonicalAssetReference?: string;
  provenance: MediaProvenance;
  createdAt: string;
  expiresAt?: string;
  /** Transient delivery only. Stripped from ledger, receipts, and logs. */
  contentBase64?: string;
};

export type CanonicalAssetReference = {
  assetId: string;
  system: "sovereign-drive";
  tenantId?: string;
};

export function isImageSourceType(value: unknown): value is ImageSourceType {
  return typeof value === "string" && (IMAGE_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isImageOperation(value: unknown): value is ImageOperation {
  return typeof value === "string" && (IMAGE_OPERATIONS as readonly string[]).includes(value);
}

export function isSizeClass(value: unknown): value is SizeClass {
  return typeof value === "string" && (SIZE_CLASSES as readonly string[]).includes(value);
}

export function isAudioSourceType(value: unknown): value is AudioSourceType {
  return isImageSourceType(value);
}

export function isSpeechOperation(value: unknown): value is SpeechOperation {
  return typeof value === "string" && (SPEECH_OPERATIONS as readonly string[]).includes(value);
}

export function isAudioOutputFormat(value: unknown): value is AudioOutputFormat {
  return typeof value === "string" && (AUDIO_OUTPUT_FORMATS as readonly string[]).includes(value);
}

export function sanitizeMediaForLedger(media?: GeneratedMediaResult[]): Array<Omit<GeneratedMediaResult, "contentBase64">> | undefined {
  if (!media?.length) return undefined;
  return media.map(({ contentBase64: _omit, ...row }) => row);
}
