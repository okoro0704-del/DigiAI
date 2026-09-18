import { expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { HttpDigiNewsReader } from "../src/adapters/diginews.js";
import { HttpDigiPediaReader } from "../src/adapters/digipedia.js";

const config = {
  ...loadConfig(),
  fetchTimeoutMs: 12000,
};

test("live DigiPedia read for Mr Fundzman is public published JSON", async () => {
  const reader = new HttpDigiPediaReader(config);
  const result = await reader.readPublished("mrfundzman");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.page.entity.slug).toBe("mrfundzman");
  expect(result.page.entry.title).toContain("Fundzman");
  expect(result.page.canonicalUrl).toContain("/digipedia");
});

test("live DigiNews read for Mr Fundzman is a public projection", async () => {
  const reader = new HttpDigiNewsReader(config);
  const result = await reader.readPublic("mrfundzman", 5);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.page.entity.slug).toBe("mrfundzman");
  expect(Array.isArray(result.page.items)).toBe(true);
});

test("live EcommerceOS business DigiPedia is distinct from Mr Fundzman", async () => {
  const reader = new HttpDigiPediaReader(config);
  const result = await reader.readPublished("mpa-6ppyad");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.page.entity.displayName).toContain("Marketplace Production Store A");
  expect(JSON.stringify(result.page)).not.toContain("Mr Fundzman");
});
