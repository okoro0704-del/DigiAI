import type { AppConfig } from "../config.js";
import { fetchJson } from "../lib/http.js";
import type { DigiNewsReader, NewsItem, NewsPage, SourceFetch } from "./types.js";

export function normalizeNewsPage(page: NewsPage): NewsPage {
  const entityId = page.entity?.entityId;
  const items = (page.items ?? []).map((item) => normalizeNewsItem(item, entityId));
  return { ...page, items, itemCount: page.itemCount ?? items.length };
}

function normalizeNewsItem(item: NewsItem, entityId?: string): NewsItem {
  const publisherId = item.publisher?.entityId;
  const relation = item.relation ?? (publisherId && entityId && publisherId === entityId ? "self" : "third_party");
  return { ...item, relation };
}

export class HttpDigiNewsReader implements DigiNewsReader {
  constructor(private readonly config: AppConfig) {}

  async readPublic(slug: string, limit: number): Promise<SourceFetch<NewsPage>> {
    const url = `${this.config.diginewsUrl}/u/${encodeURIComponent(slug)}/api/news?limit=${limit}`;
    const result = await fetchJson<NewsPage>(url, this.config.fetchTimeoutMs);
    if (!result.ok) {
      if (result.status === 404) return { ok: false, error: "not_found", message: "No public DigiNews for this entity." };
      return { ok: false, error: "unavailable", message: "DigiNews is unavailable." };
    }
    return { ok: true, page: normalizeNewsPage(result.body) };
  }
}
