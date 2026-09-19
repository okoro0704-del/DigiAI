import type { DigiAiExecutionStep, DigiAiObjective, StepOutput } from "../contracts/orchestration.js";
import { clip } from "../lib/crypto.js";

export function resolveStepMessage(input: {
  objective: DigiAiObjective;
  step: DigiAiExecutionStep;
  steps: DigiAiExecutionStep[];
}): string {
  const parts: string[] = [];
  for (const binding of input.step.inputBindings) {
    if (binding.from === "objective.instruction") {
      parts.push(clip(input.objective.instruction, 1200));
      continue;
    }
    const source = input.steps.find((row) => row.output?.name === binding.from || row.stepKey === binding.from);
    if (source?.output?.text) parts.push(clip(source.output.text, 800));
  }
  return parts.filter(Boolean).join("\n\n") || clip(input.objective.instruction, 1200);
}

export function outputHasBytes(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.contentBase64 || record.bytes || record.imageBytes || record.videoBytes);
}
