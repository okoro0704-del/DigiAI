export const VOCAL_MODES = ["instrumental", "generated_vocal", "auto"] as const;
export type VocalMode = (typeof VOCAL_MODES)[number];

export const MUSIC_OUTPUT_FORMATS = ["mp3", "wav"] as const;
export type MusicOutputFormat = (typeof MUSIC_OUTPUT_FORMATS)[number];

/** Provider-neutral music generation request. Applications do not name models. */
export type MusicGenerationRequest = {
  instruction: string;
  durationSeconds?: number;
  vocalMode?: VocalMode;
  language?: string;
  mood?: string;
  tempoBpm?: number;
  genre?: string;
  structure?: string;
  lyrics?: string;
  outputFormat?: MusicOutputFormat;
  count?: number;
  persistCanonical?: boolean;
  privacyClass?: string;
};

export type MusicTrackMeta = {
  requestedDurationSeconds?: number;
  actualDurationSeconds?: number;
  vocalMode?: VocalMode;
  sampleRate?: number;
  channels?: number;
};

export function isVocalMode(value: unknown): value is VocalMode {
  return typeof value === "string" && (VOCAL_MODES as readonly string[]).includes(value);
}

export function isMusicOutputFormat(value: unknown): value is MusicOutputFormat {
  return typeof value === "string" && (MUSIC_OUTPUT_FORMATS as readonly string[]).includes(value);
}
