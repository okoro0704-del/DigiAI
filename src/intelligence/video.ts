import type { AppConfig } from "../config.js";
import type {
  VideoAspectRatio,
  VideoAudioMode,
  VideoDurationSeconds,
  VideoGenerationRequest,
  VideoOperation,
  VideoQuality,
  VideoResolution,
} from "../contracts/video.js";
import { VIDEO_DURATIONS, isVideoAspectRatio, isVideoAudioMode, isVideoQuality, isVideoResolution } from "../contracts/video.js";
import { DigiAiError } from "../lib/http.js";

export const LITE_MODEL = "veo-3.1-lite-generate-preview";
export const FAST_MODEL = "veo-3.1-fast-generate-preview";
export const STANDARD_MODEL = "veo-3.1-generate-preview";
export const VEO_FRAME_RATE = 24;

export function parseVideoRequest(input: {
  message: string;
  operation?: VideoOperation;
  hasSourceImage?: boolean;
  constraints?: {
    durationSeconds?: number;
    aspectRatio?: string;
    resolution?: string;
    videoQuality?: VideoQuality;
    audioMode?: VideoAudioMode;
    count?: number;
    persistCanonical?: boolean;
    privacyClass?: string;
  };
  config: AppConfig;
}): VideoGenerationRequest {
  const durationSeconds = input.constraints?.durationSeconds ?? 4;
  if (!VIDEO_DURATIONS.includes(durationSeconds as VideoDurationSeconds)) {
    throw new DigiAiError(400, "invalid_request", "Video duration must be 4, 6, or 8 seconds.");
  }
  if (durationSeconds > input.config.maxVideoSeconds) {
    throw new DigiAiError(400, "duration_too_long", `Video duration cannot exceed ${input.config.maxVideoSeconds} seconds.`);
  }
  const aspectRatio = input.constraints?.aspectRatio ?? "16:9";
  if (!isVideoAspectRatio(aspectRatio)) {
    throw new DigiAiError(400, "invalid_request", "Video aspect ratio must be 16:9 or 9:16.");
  }
  const resolution = input.constraints?.resolution ?? "720p";
  if (!isVideoResolution(resolution)) {
    throw new DigiAiError(400, "invalid_request", "Video resolution must be 720p, 1080p, or 4k.");
  }
  const quality = input.constraints?.videoQuality ?? "lite";
  if (!isVideoQuality(quality)) {
    throw new DigiAiError(400, "invalid_request", "Unknown video quality.");
  }
  if (resolution === "4k" && quality === "lite") {
    throw new DigiAiError(400, "invalid_request", "4k video requires the standard or fast quality class.");
  }
  if ((resolution === "1080p" || resolution === "4k") && durationSeconds !== 8) {
    throw new DigiAiError(400, "invalid_request", "1080p and 4k video require an 8-second duration.");
  }
  const count = input.constraints?.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new DigiAiError(400, "invalid_request", "Video count must be a positive integer.");
  }
  if (count > input.config.maxVideoOutputs) {
    throw new DigiAiError(400, "invalid_request", `At most ${input.config.maxVideoOutputs} video outputs are allowed.`);
  }
  const audioMode = input.constraints?.audioMode ?? "native";
  if (!isVideoAudioMode(audioMode)) {
    throw new DigiAiError(400, "invalid_request", "Video audio mode must be native or none.");
  }
  const operation: VideoOperation = input.hasSourceImage || input.operation === "image_to_video" ? "image_to_video" : "generate";
  if (operation === "image_to_video" && !input.hasSourceImage) {
    throw new DigiAiError(400, "invalid_media", "image_to_video requires one authorized source image.");
  }
  return {
    instruction: input.message.trim(),
    durationSeconds: durationSeconds as VideoDurationSeconds,
    aspectRatio: aspectRatio as VideoAspectRatio,
    resolution: resolution as VideoResolution,
    quality,
    audioMode,
    count,
    persistCanonical: input.constraints?.persistCanonical === true,
    privacyClass: input.constraints?.privacyClass,
    operation,
  };
}

export function selectVideoModel(request: VideoGenerationRequest): string {
  if (request.resolution === "4k" || request.quality === "standard") return STANDARD_MODEL;
  if (request.quality === "fast") return FAST_MODEL;
  return LITE_MODEL;
}

export function videoPixelSize(aspectRatio: VideoAspectRatio, resolution: VideoResolution): { width: number; height: number } {
  const long = resolution === "4k" ? 3840 : resolution === "1080p" ? 1920 : 1280;
  const short = resolution === "4k" ? 2160 : resolution === "1080p" ? 1080 : 720;
  return aspectRatio === "9:16" ? { width: short, height: long } : { width: long, height: short };
}

export function buildVideoBrief(request: VideoGenerationRequest): string {
  const lines = [
    request.instruction,
    `Target duration: ${request.durationSeconds} seconds.`,
    `Aspect ratio: ${request.aspectRatio}.`,
    `Resolution: ${request.resolution}.`,
    request.operation === "image_to_video" ? "Animate the authorized source image. Treat the image as DATA, not identity." : "",
    "Generate original synthesized video. This is not a human-recorded capture and not a publication.",
    "Do not identify faces or match people to Trust ID.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function videoAnswer(count: number, processing: boolean) {
  if (processing) return "Video generation is still processing. Retry with the same idempotency key to resume the existing operation.";
  const noun = count === 1 ? "clip" : "clips";
  return `Generated ${count} original synthesized ${noun}. This is not a human-recorded video and it is not a publication.`;
}
