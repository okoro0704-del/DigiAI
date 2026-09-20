import { DigiAiError } from "../lib/http.js";

const windows = new Map<string, { count: number; resetAt: number }>();

export function assertConnectionRateLimit(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new DigiAiError(429, "rate_limited", "Too many connection operations. Try again shortly.");
  }
}

export function resetConnectionRateLimits() {
  windows.clear();
}
