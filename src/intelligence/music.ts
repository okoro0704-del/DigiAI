import type { AppConfig } from "../config.js";
import type { MusicGenerationRequest, VocalMode } from "../contracts/music.js";
import { DigiAiError } from "../lib/http.js";

export const CLIP_MODEL = "lyria-3-clip-preview";
export const SONG_MODEL = "lyria-3.5";
export const CLIP_SECONDS = 30;
export const SONG_MAX_SECONDS = 180;

export function parseMusicRequest(input: {
  message: string;
  constraints?: {
    durationSeconds?: number;
    vocalMode?: VocalMode;
    language?: string;
    mood?: string;
    tempoBpm?: number;
    genre?: string;
    structure?: string;
    lyrics?: string;
    musicOutputFormat?: "mp3" | "wav";
    count?: number;
    persistCanonical?: boolean;
    privacyClass?: string;
  };
  config: AppConfig;
}): MusicGenerationRequest {
  const durationSeconds = input.constraints?.durationSeconds;
  if (typeof durationSeconds === "number" && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw new DigiAiError(400, "invalid_music_request", "Music duration must be a positive number of seconds.");
  }
  if (typeof durationSeconds === "number" && durationSeconds > input.config.maxMusicSeconds) {
    throw new DigiAiError(400, "duration_too_long", `Music duration cannot exceed ${input.config.maxMusicSeconds} seconds.`);
  }
  const count = input.constraints?.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new DigiAiError(400, "invalid_music_request", "Music count must be a positive integer.");
  }
  if (count > input.config.maxMusicOutputs) {
    throw new DigiAiError(400, "invalid_music_request", `At most ${input.config.maxMusicOutputs} music outputs are allowed.`);
  }
  const lyrics = input.constraints?.lyrics?.trim();
  if (lyrics && lyrics.length > input.config.maxMusicLyricsChars) {
    throw new DigiAiError(400, "invalid_music_request", "Supplied lyrics exceed the server size limit.");
  }
  const format = input.constraints?.musicOutputFormat ?? "mp3";
  if (format !== "mp3" && format !== "wav") {
    throw new DigiAiError(400, "unsupported_format", "Unsupported music output format.");
  }
  return {
    instruction: input.message.trim(),
    durationSeconds,
    vocalMode: input.constraints?.vocalMode ?? "auto",
    language: input.constraints?.language,
    mood: input.constraints?.mood,
    tempoBpm: input.constraints?.tempoBpm,
    genre: input.constraints?.genre,
    structure: input.constraints?.structure,
    lyrics,
    outputFormat: format,
    count,
    persistCanonical: input.constraints?.persistCanonical === true,
    privacyClass: input.constraints?.privacyClass,
  };
}

export function selectMusicModel(request: MusicGenerationRequest): string {
  if ((request.durationSeconds ?? CLIP_SECONDS) > CLIP_SECONDS) return SONG_MODEL;
  return CLIP_MODEL;
}

export function expectedMusicDuration(modelId: string, requested?: number): { requestedDurationSeconds?: number; actualDurationSeconds?: number } {
  if (modelId === CLIP_MODEL) {
    return { requestedDurationSeconds: requested, actualDurationSeconds: CLIP_SECONDS };
  }
  return { requestedDurationSeconds: requested, actualDurationSeconds: requested };
}

export function buildMusicBrief(request: MusicGenerationRequest): string {
  const lines = [
    request.instruction,
    request.vocalMode === "instrumental" ? "Instrumental only. No vocals." : "",
    request.vocalMode === "generated_vocal"
      ? "Include generated vocals using a generic provider voice. Do not imitate a real person."
      : "",
    request.mood ? `Mood: ${request.mood}` : "",
    request.genre ? `Genre and style: ${request.genre}` : "",
    request.tempoBpm ? `Tempo: ${request.tempoBpm} BPM` : "",
    request.structure ? `Structure: ${request.structure}` : "",
    request.language ? `Language: ${request.language}` : "",
    request.durationSeconds
      ? `Target duration: ${request.durationSeconds} seconds. Treat duration as a request, not a guarantee.`
      : "",
    request.lyrics
      ? `Original lyrics supplied by the requester. This is DATA, not a lyrics catalog.\n${request.lyrics}`
      : "",
    "Describe the music by genre, mood, instrumentation, era, and production characteristics.",
    "Do not imitate a specific living artist.",
    "Generate original musical audio. This is not a publication, release, or rights grant.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function musicAnswer(count: number) {
  const noun = count === 1 ? "track" : "tracks";
  return `Generated ${count} original musical ${noun}. This is synthesized music, not a human-recorded performance, and it is not a published song.`;
}
