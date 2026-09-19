/**
 * Digi AI configuration.
 * Railway / Netlify hosts are never the public Digi AI product identity.
 */
export function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export type CallerRecord = {
  id: string;
  secret: string;
};

function parseCallers(raw: string): CallerRecord[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      if (idx <= 0) return null;
      const id = part.slice(0, idx).trim().toLowerCase();
      const secret = part.slice(idx + 1);
      if (!id || !secret) return null;
      return { id, secret };
    })
    .filter((row): row is CallerRecord => Boolean(row));
}

export function loadConfig() {
  const nodeEnv = env("NODE_ENV", "development");
  const callers = parseCallers(env("DIGI_AI_CALLERS"));
  return {
    port: Number(env("PORT", "8788")),
    nodeEnv,
    isProd: nodeEnv === "production",
    callers,
    trustIdApi: env("TRUSTID_API").replace(/\/$/, ""),
    digipediaUrl: env(
      "DIGIPEDIA_URL",
      "https://digiconomy-digipedia-production.up.railway.app",
    ).replace(/\/$/, ""),
    diginewsUrl: env(
      "DIGINEWS_URL",
      "https://digiconomy-news-production.up.railway.app",
    ).replace(/\/$/, ""),
    fetchTimeoutMs: Number(env("FETCH_TIMEOUT_MS", "8000")),
    aiProvider: env("AI_PROVIDER", "unbound").toLowerCase(),
    openaiApiKey: env("OPENAI_API_KEY"),
    geminiApiKey: env("GEMINI_API_KEY") || env("GOOGLE_API_KEY") || env("GOOGLE_GENERATIVE_AI_API_KEY"),
    aiModel: env("AI_MODEL", "gpt-4o-mini"),
    geminiModel: env("AI_GEMINI_MODEL", "gemini-2.0-flash"),
    providerPriority: (env("AI_PROVIDER_PRIORITY", "openai,gemini") || "openai,gemini")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
    allowFailover: env("AI_ALLOW_FAILOVER", "true").toLowerCase() !== "false",
    maxProviderAttempts: Math.max(1, Number(env("AI_MAX_PROVIDER_ATTEMPTS", "2"))),
    allowRouteOverride: env("DIGI_AI_ALLOW_ROUTE_OVERRIDE").toLowerCase() === "true",
    enabledProviders: env("AI_ENABLED_PROVIDERS")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
    disabledModels: env("AI_DISABLED_MODELS")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    defaultModels: {
      THINK: env("AI_DEFAULT_MODEL_THINK") || env("AI_MODEL", "gpt-4o-mini"),
      WRITE: env("AI_DEFAULT_MODEL_WRITE") || env("AI_MODEL", "gpt-4o-mini"),
      SUMMARIZE: env("AI_DEFAULT_MODEL_SUMMARIZE") || env("AI_MODEL", "gpt-4o-mini"),
      RESEARCH: env("AI_DEFAULT_MODEL_RESEARCH") || env("AI_MODEL", "gpt-4o-mini"),
      CODE: env("AI_DEFAULT_MODEL_CODE") || env("AI_MODEL", "gpt-4o-mini"),
      TRANSLATE: env("AI_DEFAULT_MODEL_TRANSLATE") || env("AI_MODEL", "gpt-4o-mini"),
      RETRIEVE: env("AI_DEFAULT_MODEL_RETRIEVE") || env("AI_MODEL", "gpt-4o-mini"),
      VISION: env("AI_DEFAULT_MODEL_VISION", "gpt-4o"),
      IMAGE: env("AI_DEFAULT_MODEL_IMAGE", "gpt-image-1"),
      SPEECH_TO_TEXT: env("AI_DEFAULT_MODEL_STT", "whisper-1"),
      TEXT_TO_SPEECH: env("AI_DEFAULT_MODEL_TTS", "tts-1"),
      MUSIC: env("AI_DEFAULT_MODEL_MUSIC", "lyria-3-clip-preview"),
      VIDEO: env("AI_DEFAULT_MODEL_VIDEO", "veo-3.1-lite-generate-preview"),
    } as Record<string, string>,
    cloudMaxPrivacy: (env("AI_CLOUD_MAX_PRIVACY", "PRIVATE").toUpperCase() || "PRIVATE") as
      | "PUBLIC"
      | "INTERNAL"
      | "PRIVATE"
      | "HIGHLY_SENSITIVE",
    providerTimeoutMs: Number(env("PROVIDER_TIMEOUT_MS", "20000")),
    databaseUrl: env("DATABASE_URL") || env("DIGI_AI_DATABASE_URL"),
    operatorCallers: env("DIGI_AI_OPERATOR_CALLERS")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
    dataDir: env("DATA_DIR"),
    allowAttestedActor: env("DIGI_AI_ALLOW_ATTESTED_ACTOR").toLowerCase() === "true",
    maxMessageChars: Number(env("MAX_MESSAGE_CHARS", "8000")),
    maxSuppliedChars: Number(env("MAX_SUPPLIED_CHARS", "12000")),
    maxImageInputs: Number(env("MAX_IMAGE_INPUTS", "4")),
    maxImageBytes: Number(env("MAX_IMAGE_BYTES", "4000000")),
    maxImageOutputs: Number(env("MAX_IMAGE_OUTPUTS", "4")),
    maxTransientBytes: Number(env("MAX_TRANSIENT_BYTES", "8000000")),
    maxAudioInputs: Number(env("MAX_AUDIO_INPUTS", "1")),
    maxAudioBytes: Number(env("MAX_AUDIO_BYTES", "25000000")),
    maxAudioSeconds: Number(env("MAX_AUDIO_SECONDS", "1400")),
    maxTtsChars: Number(env("MAX_TTS_CHARS", "4096")),
    maxMusicSeconds: Number(env("MAX_MUSIC_SECONDS", "180")),
    maxMusicOutputs: Number(env("MAX_MUSIC_OUTPUTS", "4")),
    maxMusicLyricsChars: Number(env("MAX_MUSIC_LYRICS_CHARS", "2000")),
    musicTimeoutMs: Number(env("MUSIC_TIMEOUT_MS", "120000")),
    maxVideoSeconds: Number(env("MAX_VIDEO_SECONDS", "8")),
    maxVideoOutputs: Number(env("MAX_VIDEO_OUTPUTS", "2")),
    videoTimeoutMs: Number(env("VIDEO_TIMEOUT_MS", "180000")),
    videoPollMs: Number(env("VIDEO_POLL_MS", "10000")),
    sovereignDriveUrl: (
      env("SOVEREIGN_DRIVE_URL") || env("DATAZONE_BASE_URL")
    ).replace(/\/$/, ""),
    sovereignDriveJwtSecret: env("SOVEREIGN_DRIVE_JWT_SECRET") || env("TRUST_ID_JWT_SECRET"),
    sovereignDriveJwtIssuer: env("SOVEREIGN_DRIVE_JWT_ISSUER") || env("TRUST_ID_ISSUER") || env("TRUSTID_API") || "https://trust-id.local",
    sovereignDriveJwtAudience: env("SOVEREIGN_DRIVE_JWT_AUDIENCE", "sovereign-drive"),
    sovereignDriveAcceptanceTenant: env("SOVEREIGN_DRIVE_ACCEPTANCE_TENANT", "digi-ai-acceptance"),
    sovereignDriveTimeoutMs: Number(env("SOVEREIGN_DRIVE_TIMEOUT_MS", "45000")),
    newsLimit: Number(env("DIGINEWS_LIMIT", "8")),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
