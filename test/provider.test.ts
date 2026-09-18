import { expect, test } from "vitest";
import { createProvider } from "../src/providers/router.js";
import { loadConfig } from "../src/config.js";
import { OpenAiProvider } from "../src/providers/openai.js";
import { UnboundProvider } from "../src/providers/unbound.js";
import { TestProvider } from "../src/providers/test.js";

test("router stays provider-neutral", () => {
  const unbound = createProvider({ ...loadConfig(), aiProvider: "unbound", openaiApiKey: "" });
  expect(unbound).toBeInstanceOf(UnboundProvider);
  const test = createProvider({ ...loadConfig(), aiProvider: "test" });
  expect(test).toBeInstanceOf(TestProvider);
  const missingKey = createProvider({ ...loadConfig(), aiProvider: "openai", openaiApiKey: "" });
  expect(missingKey).toBeInstanceOf(UnboundProvider);
  const openai = createProvider({ ...loadConfig(), aiProvider: "openai", openaiApiKey: "sk-test" });
  expect(openai).toBeInstanceOf(OpenAiProvider);
  expect(openai.name).toBe("openai");
});

test("test provider normalizes usage", async () => {
  const provider = new TestProvider();
  const result = await provider.invoke({
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "hello" },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.provider).toBe("test");
  expect(result.usage.totalTokens).toBeGreaterThan(0);
});
