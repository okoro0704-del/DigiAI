/**
 * OS Shell objective candidate — copied shape from OS SHELL packages/contract.
 * Digi AI wraps/references this language. It does not execute objectives.
 */
export const OS_SHELL_OBJECTIVE_TYPES = [
  "create",
  "open",
  "view",
  "edit",
  "share",
  "import",
  "export",
  "publish",
  "preview",
  "continue",
] as const;

export type OSShellObjectiveType = (typeof OS_SHELL_OBJECTIVE_TYPES)[number];

export interface OSShellObjective {
  type: OSShellObjectiveType;
  target?: string;
  label?: string;
}

export type ObjectiveCandidate = {
  objective: OSShellObjective;
  executed: false;
  availability: "UNAVAILABLE";
  reason: string;
};
