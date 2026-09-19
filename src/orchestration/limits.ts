import type { AppConfig } from "../config.js";

export function orchestrationLimits(config: AppConfig) {
  return {
    maxSteps: config.orchestrationMaxSteps,
    maxDepth: config.orchestrationMaxDepth,
    maxParallelSteps: config.orchestrationMaxParallelSteps,
    maxPlanningAttempts: config.orchestrationMaxPlanningAttempts,
    maxStepAttempts: config.orchestrationMaxStepAttempts,
    maxInstructionChars: config.orchestrationMaxInstructionChars,
    maxDesiredOutputs: config.orchestrationMaxDesiredOutputs,
  };
}
