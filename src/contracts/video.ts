export const VIDEO_OPERATIONS = ["generate", "image_to_video"] as const;
export type VideoOperation = (typeof VIDEO_OPERATIONS)[number];

export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

export const VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const VIDEO_DURATIONS = [4, 6, 8] as const;
export type VideoDurationSeconds = (typeof VIDEO_DURATIONS)[number];

export const VIDEO_QUALITIES = ["lite", "fast", "standard"] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

export const VIDEO_AUDIO_MODES = ["native", "none"] as const;
export type VideoAudioMode = (typeof VIDEO_AUDIO_MODES)[number];

/** Provider-neutral video generation request. Applications do not name models. */
export type VideoGenerationRequest = {
  instruction: string;
  durationSeconds: VideoDurationSeconds;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  quality: VideoQuality;
  audioMode: VideoAudioMode;
  count: number;
  persistCanonical?: boolean;
  privacyClass?: string;
  operation: VideoOperation;
};

export function isVideoOperation(value: unknown): value is VideoOperation {
  return typeof value === "string" && (VIDEO_OPERATIONS as readonly string[]).includes(value);
}

export function isVideoAspectRatio(value: unknown): value is VideoAspectRatio {
  return typeof value === "string" && (VIDEO_ASPECT_RATIOS as readonly string[]).includes(value);
}

export function isVideoResolution(value: unknown): value is VideoResolution {
  return typeof value === "string" && (VIDEO_RESOLUTIONS as readonly string[]).includes(value);
}

export function isVideoQuality(value: unknown): value is VideoQuality {
  return typeof value === "string" && (VIDEO_QUALITIES as readonly string[]).includes(value);
}

export function isVideoAudioMode(value: unknown): value is VideoAudioMode {
  return typeof value === "string" && (VIDEO_AUDIO_MODES as readonly string[]).includes(value);
}
