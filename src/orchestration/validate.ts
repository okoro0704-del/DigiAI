import { isCapabilityId } from "../contracts/capabilities.js";
import { RESERVED_BINDING_NAMES } from "../contracts/orchestration.js";
import { DigiAiError } from "../lib/http.js";
import type { PlannedGraph, PlannedStep } from "./planner.js";

const BINDING_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export function validatePlan(graph: PlannedGraph, bounds: { maxSteps: number; maxDepth: number }): PlannedStep[] {
  if (!graph.steps.length) throw new DigiAiError(400, "invalid_plan", "Execution plan has no steps.");
  if (graph.steps.length > bounds.maxSteps) {
    throw new DigiAiError(400, "invalid_plan", `Plan exceeds maxSteps (${bounds.maxSteps}).`);
  }
  const keys = new Set<string>();
  for (const step of graph.steps) {
    if (keys.has(step.stepKey)) throw new DigiAiError(400, "invalid_plan", `Duplicate step ${step.stepKey}.`);
    keys.add(step.stepKey);
    if (step.capability === "ACTION") {
      if (!step.governedAction) throw new DigiAiError(400, "invalid_plan", "ACTION steps require a governed action.");
    } else if (!isCapabilityId(step.capability)) {
      throw new DigiAiError(400, "invalid_plan", `Unknown capability ${String(step.capability)}.`);
    }
    if (step.provider || step.model) {
      throw new DigiAiError(400, "invalid_plan", "Planner output cannot select a provider or model.");
    }
    if (step.dependencies.includes(step.stepKey)) {
      throw new DigiAiError(400, "invalid_plan", `Step ${step.stepKey} depends on itself.`);
    }
    for (const dep of step.dependencies) {
      if (!keys.has(dep) && !graph.steps.some((row) => row.stepKey === dep)) {
        throw new DigiAiError(400, "invalid_plan", `Unknown dependency ${dep}.`);
      }
    }
    for (const binding of step.outputBindings) {
      if (!BINDING_NAME.test(binding.name) || RESERVED_BINDING_NAMES.includes(binding.name)) {
        throw new DigiAiError(400, "invalid_plan", `Invalid output binding ${binding.name}.`);
      }
    }
  }
  for (const step of graph.steps) {
    for (const dep of step.dependencies) {
      if (!graph.steps.some((row) => row.stepKey === dep)) {
        throw new DigiAiError(400, "invalid_plan", `Unknown dependency ${dep}.`);
      }
    }
  }
  if (hasCycle(graph.steps)) throw new DigiAiError(400, "invalid_plan", "Execution plans must be acyclic.");
  const depth = graphDepth(graph.steps);
  if (depth > bounds.maxDepth) throw new DigiAiError(400, "invalid_plan", `Plan exceeds maxDepth (${bounds.maxDepth}).`);
  return graph.steps;
}

export function hasCycle(steps: PlannedStep[]): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(steps.map((row) => [row.stepKey, row]));
  const walk = (key: string): boolean => {
    if (visited.has(key)) return false;
    if (visiting.has(key)) return true;
    visiting.add(key);
    for (const dep of byKey.get(key)?.dependencies ?? []) {
      if (walk(dep)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return steps.some((step) => walk(step.stepKey));
}

export function graphDepth(steps: PlannedStep[]): number {
  const byKey = new Map(steps.map((row) => [row.stepKey, row]));
  const memo = new Map<string, number>();
  const depthOf = (key: string, stack: Set<string>): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (stack.has(key)) return Number.POSITIVE_INFINITY;
    stack.add(key);
    const step = byKey.get(key);
    const next = step?.dependencies.length
      ? 1 + Math.max(...step.dependencies.map((dep) => depthOf(dep, stack)))
      : 1;
    stack.delete(key);
    memo.set(key, next);
    return next;
  };
  return Math.max(...steps.map((step) => depthOf(step.stepKey, new Set())));
}

export function readySteps<T extends { stepKey: string; dependencies: string[]; status: string }>(steps: T[]): T[] {
  const done = new Set(steps.filter((row) => row.status === "COMPLETED").map((row) => row.stepKey));
  return steps.filter(
    (row) =>
      row.status === "PENDING" &&
      row.dependencies.every((dep) => done.has(dep)),
  );
}
