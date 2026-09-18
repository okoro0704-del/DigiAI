export class DigiAiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DigiAiError";
    this.status = status;
    this.code = code;
  }
}

export async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<{ ok: true; status: number; body: T; headers: Headers } | { ok: false; status: number; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "DigiAI/0.1",
        ...(init.headers ?? {}),
      },
      redirect: "manual",
    });
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) {
      return { ok: false, status: res.status, error: "non_json" };
    }
    const body = (await res.json()) as T;
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, error: "http_error" };
    }
    return { ok: true, status: res.status, body, headers: res.headers };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, status: 0, error: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
