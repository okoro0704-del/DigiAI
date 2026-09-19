export const PRIVACY_CLASSES = ["PUBLIC", "INTERNAL", "PRIVATE", "HIGHLY_SENSITIVE"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

const RANK: Record<PrivacyClass, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  PRIVATE: 2,
  HIGHLY_SENSITIVE: 3,
};

export function isPrivacyClass(value: unknown): value is PrivacyClass {
  return typeof value === "string" && (PRIVACY_CLASSES as readonly string[]).includes(value);
}

export function privacyRank(value: PrivacyClass): number {
  return RANK[value];
}

export function defaultPrivacyClass(): PrivacyClass {
  return "PRIVATE";
}
