import { DigiAiError } from "./http.js";

export function requireSlug(slug: string | undefined, label: string): string {
  const value = slug?.trim().toLowerCase();
  if (!value) throw new DigiAiError(400, "entity_required", `${label} retrieval requires an entity slug.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new DigiAiError(400, "invalid_entity", "Entity slug is invalid.");
  }
  return value;
}
