import type { AppConfig } from "../config.js";
import { fetchJson } from "../lib/http.js";
import type { DigiNewsReader, NewsPage, SourceFetch } from "./types.js";

export class HttpDigiNewsReader implements DigiNewsReader {
  constructor(private readonly config: AppConfig) {}

  async readPublic(slug: string, limit: number): Promise<SourceFetch<NewsPage>> {
    const url = `${this.config.diginewsUrl}/u/${encodeURIComponent(slug)}/api/news?limit=${limit}`;
    const result = await fetchJson<NewsPage>(url, this.config.fetchTimeoutMs);
    if (!result.ok) {
      if (result.status === 404) return { ok: false, error: "not_found", message: "No public DigiNews for this entity." };
      return { ok: false, error: "unavailable", message: "DigiNews is unavailable." };
    }
    return { ok: true, page: result.body };
  }
}
