import type { AppConfig } from "../config.js";
import { fetchJson } from "../lib/http.js";
import type { DigiPediaPage, DigiPediaReader, SourceFetch } from "./types.js";

export class HttpDigiPediaReader implements DigiPediaReader {
  constructor(private readonly config: AppConfig) {}

  async readPublished(slug: string): Promise<SourceFetch<DigiPediaPage>> {
    const url = `${this.config.digipediaUrl}/u/${encodeURIComponent(slug)}/api/digipedia`;
    const result = await fetchJson<DigiPediaPage>(url, this.config.fetchTimeoutMs);
    if (!result.ok) {
      if (result.status === 404) return { ok: false, error: "not_found", message: "No published DigiPedia page for this entity." };
      return { ok: false, error: "unavailable", message: "DigiPedia is unavailable." };
    }
    if (result.body.entry?.status && result.body.entry.status !== "published" && result.body.entry.status !== "sparse") {
      return { ok: false, error: "not_found", message: "No published DigiPedia page for this entity." };
    }
    return { ok: true, page: result.body };
  }
}
