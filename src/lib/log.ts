import { redactText, redactValue } from "../credentials/redact.js";

export function logEvent(code: string, detail: Record<string, unknown> = {}) {
  const safe = redactValue({ ...detail }) as Record<string, unknown>;
  for (const key of Object.keys(safe)) {
    const value = String(safe[key] ?? "");
    if (/sk-|api[_-]?key|secret|bearer |sig=|data:image|base64|TEST_SECRET_DO_NOT_LEAK/i.test(`${key}=${value}`)) {
      safe[key] = "[redacted]";
    } else if (typeof safe[key] === "string") {
      safe[key] = redactText(value);
    }
  }
  console.error(JSON.stringify({ service: "digi-ai", event: code, ...safe }));
}
