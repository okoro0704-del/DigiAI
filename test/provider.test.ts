import { expect, test } from "vitest";
import { createProvider, createProviders } from "../src/providers/router.js";
import { loadConfig } from "../src/config.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { OpenAiProvider } from "../src/providers/openai.js";
import { UnboundProvider } from "../src/providers/unbound.js";
import { TestProvider } from "../src/providers/test.js";

test("router stays provider-neutral", () => {
  const unbound = createProvider({ ...loadConfig(), aiProvider: "unbound", openaiApiKey: "", geminiApiKey: "" });
  expect(unbound).toBeInstanceOf(UnboundProvider);
  const test = createProvider({ ...loadConfig(), aiProvider: "test" });
  expect(test).toBeInstanceOf(TestProvider);
  const missingKey = createProvider({ ...loadConfig(), aiProvider: "openai", openaiApiKey: "", geminiApiKey: "" });
  expect(missingKey).toBeInstanceOf(UnboundProvider);
  const openai = createProvider({ ...loadConfig(), aiProvider: "openai", openaiApiKey: "sk-test", geminiApiKey: "" });
  expect(openai).toBeInstanceOf(OpenAiProvider);
  expect(openai.name).toBe("openai");
  const gemini = createProvider({ ...loadConfig(), aiProvider: "unbound", openaiApiKey: "", geminiApiKey: "AIza-test" });
  expect(gemini).toBeInstanceOf(GeminiProvider);
  const both = createProviders({ ...loadConfig(), openaiApiKey: "sk-test", geminiApiKey: "AIza-test", aiProvider: "unbound" });
  expect(both.get("openai")).toBeInstanceOf(OpenAiProvider);
  expect(both.get("gemini")).toBeInstanceOf(GeminiProvider);
  expect(both.primary().name).toBe("openai");
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
