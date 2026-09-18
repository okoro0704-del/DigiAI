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
    aiModel: env("AI_MODEL", "gpt-4o-mini"),
    providerTimeoutMs: Number(env("PROVIDER_TIMEOUT_MS", "20000")),
    dataDir: env("DATA_DIR"),
    allowAttestedActor: env("DIGI_AI_ALLOW_ATTESTED_ACTOR").toLowerCase() === "true",
    maxMessageChars: Number(env("MAX_MESSAGE_CHARS", "8000")),
    maxSuppliedChars: Number(env("MAX_SUPPLIED_CHARS", "12000")),
    newsLimit: Number(env("DIGINEWS_LIMIT", "8")),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
