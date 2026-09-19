export const SPEECH_TASKS = ["transcribe", "translate"] as const;
export type SpeechTask = (typeof SPEECH_TASKS)[number];

export type SpeechSegment = {
  startSeconds?: number;
  endSeconds?: number;
  text: string;
};

export type SpeechToTextResult = {
  transcript: string;
  language?: string;
  segments?: SpeechSegment[];
  durationSeconds?: number;
};

export type VoiceStage = "STT" | "THINK" | "TTS" | "PERSISTENCE";

export type VoiceInteractionResult = {
  transcript?: string;
  textResponse?: string;
  voiceProfileId?: string;
  language?: string;
  stageFailed?: VoiceStage;
};

export type PublicVoiceProfile = {
  profileId: string;
  languages: string[];
  style: string;
  status: "enabled" | "disabled";
};

export function isSpeechTask(value: unknown): value is SpeechTask {
  return typeof value === "string" && (SPEECH_TASKS as readonly string[]).includes(value);
}
