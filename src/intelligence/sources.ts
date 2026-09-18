import type { ContextSourceId } from "../contracts/request.js";

export function selectSources(input: {
  message: string;
  requested?: ContextSourceId[];
  hasSupplied: boolean;
}): ContextSourceId[] {
  if (input.requested && input.requested.length > 0) {
    return [...new Set(input.requested)];
  }
  const text = input.message.toLowerCase();
  const sources = new Set<ContextSourceId>();
  const knowledge =
    /\b(what is known|who am i|about me|my digipedia|who is|what do you know)\b/.test(text);
  const news =
    /\b(published recently|have i published|diginews|recent (posts|publications|news)|what have i published)\b/.test(
      text,
    );
  const rewrite = /\b(rewrite|continue|outline|metadata|draft|summarize this|edit this)\b/.test(text);
  if (knowledge) sources.add("digipedia");
  if (news) sources.add("diginews");
  if (input.hasSupplied && (rewrite || sources.size === 0)) sources.add("supplied");
  return [...sources];
}
