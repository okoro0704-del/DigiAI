import { FIXTURE_SENTINEL_SECRET } from "./secret.js";

const SENSITIVE_KEY = /^(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|private[_-]?key|authorization|authorizationheader|secret|credential|bearer)$/i;
const SENSITIVE_TEXT = /sk-[A-Za-z0-9_-]+|api[_-]?key|secret|bearer\s+[A-Za-z0-9._-]+|TEST_MYBRANDOS_S2S_SECRET_DO_NOT_LEAK(?:_[A-Za-z0-9_-]+)?|TEST_SECRET_DO_NOT_LEAK_[A-Za-z0-9_-]+/i;

const extraSentinels = new Set<string>([FIXTURE_SENTINEL_SECRET]);

export function registerSecretSentinel(value: string) {
  if (value.trim()) extraSentinels.add(value.trim());
}

export function resetSecretSentinels() {
  extraSentinels.clear();
  extraSentinels.add(FIXTURE_SENTINEL_SECRET);
}

export function redactText(value: string): string {
  let next = value;
  for (const sentinel of extraSentinels) {
    if (sentinel && next.includes(sentinel)) next = next.split(sentinel).join("[redacted]");
  }
  return next.replace(SENSITIVE_TEXT, "[redacted]");
}

export function redactValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(nested);
    }
    return out;
  }
  return String(value);
}

export function containsSecret(value: unknown, sentinel = FIXTURE_SENTINEL_SECRET): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.includes(sentinel);
  try {
    return JSON.stringify(value).includes(sentinel);
  } catch {
    return String(value).includes(sentinel);
  }
}

export function sanitizePublicMessage(message: string): string {
  const redacted = redactText(message);
  return redacted === message && !SENSITIVE_TEXT.test(message) ? message : redacted.includes("[redacted]") ? redacted : "Digi AI could not complete that request.";
}
