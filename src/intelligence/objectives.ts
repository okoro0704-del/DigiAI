import type { OSShellObjective, ObjectiveCandidate } from "../contracts/objectives.js";
import { OS_SHELL_OBJECTIVE_TYPES, type OSShellObjectiveType } from "../contracts/objectives.js";

const TARGETS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /\bvideo\b/, target: "video" },
  { pattern: /\bmusic\b|\bsong\b/, target: "music" },
  { pattern: /\bwrit(e|ing)\b|\barticle\b|\bparagraph\b/, target: "writing" },
  { pattern: /\bbook\b/, target: "book" },
  { pattern: /\bcourse\b/, target: "course" },
  { pattern: /\bfile\b|\bdocument\b/, target: "document" },
];

export function proposeObjective(message: string, actionType?: string): ObjectiveCandidate | undefined {
  const text = `${actionType ?? ""} ${message}`.toLowerCase();
  let type: OSShellObjectiveType | undefined;
  if (/\bpublish\b/.test(text)) type = "publish";
  else if (/\b(create|make|new)\b/.test(text)) type = "create";
  else if (/\b(edit|rewrite|revise)\b/.test(text)) type = "edit";
  else if (/\b(share)\b/.test(text)) type = "share";
  else if (/\b(import)\b/.test(text)) type = "import";
  else if (/\b(export)\b/.test(text)) type = "export";
  else if (/\b(preview)\b/.test(text)) type = "preview";
  else if (/\b(open|view|show)\b/.test(text)) type = "view";
  else if (/\bcontinue\b/.test(text)) type = "continue";
  if (!type || !OS_SHELL_OBJECTIVE_TYPES.includes(type)) return undefined;

  const hit = TARGETS.find((row) => row.pattern.test(text));
  const objective: OSShellObjective = {
    type,
    target: hit?.target ?? "this",
    label: `Candidate: ${type}${hit ? ` ${hit.target}` : ""}`,
  };
  return {
    objective,
    executed: false,
    availability: "UNAVAILABLE",
    reason: "Phase 1 returns OS Shell objective candidates only. Digi AI does not execute them.",
  };
}
