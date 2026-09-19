import type { AppConfig } from "../config.js";
import type { ImageConstraints, ImageInputReference, SizeClass } from "../contracts/media.js";
import { DigiAiError } from "../lib/http.js";

export const DEFAULT_IMAGE_LIMITS = {
  maxImageInputs: 4,
  maxImageBytes: 4_000_000,
  maxImageOutputs: 4,
  maxTransientBytes: 8_000_000,
};

export function mediaLimits(config: AppConfig) {
  return {
    maxImageInputs: config.maxImageInputs,
    maxImageBytes: config.maxImageBytes,
    maxImageOutputs: config.maxImageOutputs,
    maxTransientBytes: config.maxTransientBytes,
  };
}

export function assertImageInputLimits(images: ImageInputReference[], config: AppConfig) {
  const limits = mediaLimits(config);
  if (images.length > limits.maxImageInputs) {
    throw new DigiAiError(400, "media_too_large", `At most ${limits.maxImageInputs} input images are allowed.`);
  }
  for (const image of images) {
    if (typeof image.byteSize === "number" && image.byteSize > limits.maxImageBytes) {
      throw new DigiAiError(400, "media_too_large", "An input image exceeds the server size limit.");
    }
    if (image.dataBase64) {
      const bytes = Buffer.byteLength(image.dataBase64, "base64");
      if (bytes > limits.maxImageBytes) {
        throw new DigiAiError(400, "media_too_large", "An input image exceeds the server size limit.");
      }
    }
  }
}

export function assertOutputCount(count: number | undefined, config: AppConfig) {
  const limits = mediaLimits(config);
  const value = count ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new DigiAiError(400, "invalid_request", "Image output count must be a positive integer.");
  }
  if (value > limits.maxImageOutputs) {
    throw new DigiAiError(400, "media_too_large", `At most ${limits.maxImageOutputs} generated images are allowed.`);
  }
  return value;
}

export function mapSizeClass(sizeClass?: SizeClass, aspectRatio?: string): "1024x1024" | "1024x1536" | "1536x1024" {
  if (sizeClass === "portrait" || aspectRatio === "2:3" || aspectRatio === "9:16") return "1024x1536";
  if (sizeClass === "landscape" || aspectRatio === "3:2" || aspectRatio === "16:9") return "1536x1024";
  return "1024x1024";
}

export function parseImageConstraints(raw: ImageConstraints | undefined, config: AppConfig): Required<Pick<ImageConstraints, "count">> & ImageConstraints {
  const count = assertOutputCount(raw?.count, config);
  return {
    ...raw,
    count,
    sizeClass: raw?.sizeClass ?? "square",
    outputFormat: raw?.outputFormat ?? "png",
  };
}
