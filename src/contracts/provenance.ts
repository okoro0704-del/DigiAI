/** Provider-independent provenance. Canonical association is not a truth certificate. */
export const INFORMATION_KINDS = ["canonical", "generated", "unverified"] as const;
export type InformationKind = (typeof INFORMATION_KINDS)[number];

export const SOURCE_SYSTEMS = ["digipedia", "diginews", "supplied", "digi-ai"] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export type SourceReference = {
  sourceId: string;
  sourceType: "canonical_publication" | "canonical_entity" | "canonical_asset" | "external" | "supplied";
  publisherEntityId?: string;
  canonicalUrl?: string;
  publicationId?: string;
  title?: string;
  publishedAt?: string;
  available: boolean;
};

export type ProvenanceItem = {
  kind: InformationKind;
  system: SourceSystem;
  owner?: string;
  retrievedAt?: string;
  reference?: SourceReference;
  excerpt?: string;
  note?: string;
};

export function isInformationKind(value: string): value is InformationKind {
  return (INFORMATION_KINDS as readonly string[]).includes(value);
}
