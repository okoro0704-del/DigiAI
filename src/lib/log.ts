export function logEvent(code: string, detail: Record<string, unknown> = {}) {
  const safe = { ...detail };
  for (const key of Object.keys(safe)) {
    const value = String(safe[key] ?? "");
    if (/sk-|api[_-]?key|secret|bearer |sig=|data:image|base64/i.test(`${key}=${value}`)) {
      safe[key] = "[redacted]";
    }
  }
  console.error(JSON.stringify({ service: "digi-ai", event: code, ...safe }));
}
