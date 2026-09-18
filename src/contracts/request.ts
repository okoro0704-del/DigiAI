import type { EntityContext } from "./actor.js";

export const DIGI_AI_MODES = ["ask", "summarize", "reason", "draft", "retrieve", "plan"] as const;
export type DigiAiMode = (typeof DIGI_AI_MODES)[number];

export const CONTEXT_SOURCES = ["supplied", "digipedia", "diginews"] as const;
export type ContextSourceId = (typeof CONTEXT_SOURCES)[number];

export type SuppliedContext = {
  text?: string;
  label?: string;
};

export type DraftAssist = {
  actionType?: string;
  projectTitle?: string;
  projectType?: string;
  projectDescription?: string;
  blockType?: string;
};

export type DigiAiAskInput = {
  message: string;
  mode?: DigiAiMode;
  sources?: ContextSourceId[];
  entity?: EntityContext;
  suppliedContext?: SuppliedContext;
  draft?: DraftAssist;
  correlationId?: string;
  /** Test/S2S attested actor only after caller authentication. Never a public auth mechanism. */
  actor?: { trustId?: string; displayName?: string };
};

export function isDigiAiMode(value: unknown): value is DigiAiMode {
  return typeof value === "string" && (DIGI_AI_MODES as readonly string[]).includes(value);
}

export function isContextSourceId(value: unknown): value is ContextSourceId {
  return typeof value === "string" && (CONTEXT_SOURCES as readonly string[]).includes(value);
}
