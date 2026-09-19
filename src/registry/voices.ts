import type { PublicVoiceProfile } from "../contracts/speech.js";

export type VoiceProfileRecord = PublicVoiceProfile & {
  providerId: string;
  providerVoiceId: string;
};

/**
 * Provider-neutral voice profiles. Callers request profileId only.
 * No cloning, biometric identity, or celebrity imitation.
 */
export const VOICE_PROFILES: VoiceProfileRecord[] = [
  {
    profileId: "neutral",
    providerId: "openai",
    providerVoiceId: "alloy",
    languages: ["*"],
    style: "neutral",
    status: "enabled",
  },
  {
    profileId: "warm",
    providerId: "openai",
    providerVoiceId: "nova",
    languages: ["*"],
    style: "warm",
    status: "enabled",
  },
  {
    profileId: "low",
    providerId: "openai",
    providerVoiceId: "onyx",
    languages: ["*"],
    style: "low",
    status: "enabled",
  },
  {
    profileId: "bright",
    providerId: "openai",
    providerVoiceId: "shimmer",
    languages: ["*"],
    style: "bright",
    status: "enabled",
  },
];

export function listPublicVoiceProfiles(): PublicVoiceProfile[] {
  return VOICE_PROFILES.filter((row) => row.status === "enabled").map((row) => ({
    profileId: row.profileId,
    languages: [...row.languages],
    style: row.style,
    status: row.status,
  }));
}

export function getVoiceProfile(profileId?: string): VoiceProfileRecord | undefined {
  const id = (profileId || "neutral").trim().toLowerCase();
  return VOICE_PROFILES.find((row) => row.profileId === id && row.status === "enabled");
}

export function enabledVoiceProfileCount() {
  return VOICE_PROFILES.filter((row) => row.status === "enabled").length;
}
