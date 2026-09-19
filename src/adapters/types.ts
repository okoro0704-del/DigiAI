import type { SourceReference } from "../contracts/provenance.js";

export type DigiPediaSection = {
  sectionId: string;
  heading: string;
  body: string;
  sourceReferences?: SourceReference[];
};

export type DigiPediaPage = {
  entity: {
    entityId: string;
    slug: string;
    kind: string;
    displayName: string;
    osId: string | null;
    verticalId: string | null;
  };
  entry: {
    entryId: string;
    entityId: string;
    title: string;
    summary: string;
    sections: DigiPediaSection[];
    sourceReferences: SourceReference[];
    status: "published" | "sparse";
  };
  canonicalUrl: string;
};

export type NewsItem = {
  publicationId: string;
  publishedAt: string;
  type: string;
  title: string | null;
  summary: string | null;
  canonicalUrl: string;
  publisher: { entityId: string; displayName: string; href: string | null };
  subjects: Array<{ entityId: string; displayName: string }>;
  relation?: "self" | "third_party";
  source: SourceReference;
};

export type NewsPage = {
  entity: {
    entityId: string;
    slug: string;
    kind: string;
    displayName: string;
    osId: string | null;
    verticalId: string | null;
  };
  items: NewsItem[];
  itemCount: number;
  canonicalUrl: string;
};

export type SourceFetch<T> =
  | { ok: true; page: T }
  | { ok: false; error: "not_found" | "unavailable"; message: string };

export interface DigiPediaReader {
  readPublished(slug: string): Promise<SourceFetch<DigiPediaPage>>;
}

export interface DigiNewsReader {
  readPublic(slug: string, limit: number): Promise<SourceFetch<NewsPage>>;
}
