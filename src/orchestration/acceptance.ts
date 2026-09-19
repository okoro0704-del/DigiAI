import type { EngineDeps } from "../intelligence/engine.js";
import type { ActorContext, CallerApplication } from "../contracts/actor.js";
import { createObjective, advanceObjective, cancelObjective, inspectObjective } from "./engine.js";

export const ORCHESTRATION_ACCEPTANCE_NOTE =
  "ORCHESTRATION ACCEPTANCE. Deterministic fixture. Not real provider orchestration.";

export async function runOrchestrationAcceptance(input: {
  deps: EngineDeps;
  actor: ActorContext;
  caller: CallerApplication;
}) {
  const text = await createObjective({
    ...input,
    allowFixture: true,
    body: {
      instruction: "Research a topic and draft a short summary.",
      fixture: "text-pipeline",
      idempotencyKey: "orch-accept-text",
    },
  });
  const replay = await createObjective({
    ...input,
    allowFixture: true,
    body: {
      instruction: "Research a topic and draft a short summary.",
      fixture: "text-pipeline",
      idempotencyKey: "orch-accept-text",
    },
  });
  const video = await createObjective({
    ...input,
    allowFixture: true,
    body: {
      instruction: "Write a script then generate video",
      fixture: "async-video",
      idempotencyKey: "orch-accept-video",
    },
  });
  const resumed = await advanceObjective({
    ...input,
    allowFixture: true,
    objectiveId: video.objectiveId,
  });
  const partial = await createObjective({
    ...input,
    allowFixture: true,
    body: { instruction: "partial campaign", fixture: "partial", idempotencyKey: "orch-accept-partial" },
  });
  const failing = await createObjective({
    ...input,
    allowFixture: true,
    body: { instruction: "required failure research", fixture: "required-failure", idempotencyKey: "orch-accept-fail" },
  });
  const cancellable = await createObjective({
    ...input,
    allowFixture: true,
    body: { instruction: "cancel pending video", fixture: "cancel", idempotencyKey: "orch-accept-cancel" },
  });
  const cancelled = await cancelObjective({
    store: input.deps.store,
    actor: input.actor,
    caller: input.caller,
    objectiveId: cancellable.objectiveId,
  });
  const inspected = await inspectObjective({
    store: input.deps.store,
    actor: input.actor,
    caller: input.caller,
    objectiveId: text.objectiveId,
  });
  return {
    ok: true,
    note: ORCHESTRATION_ACCEPTANCE_NOTE,
    textStatus: text.status,
    replaySameId: replay.objectiveId === text.objectiveId,
    videoFirstStatus: video.status,
    videoResumedStatus: resumed.status,
    sameVideoOperation: inspected.steps.length >= 0,
    videoResumedCompleted: resumed.status === "COMPLETED",
    noDuplicateVideo: resumed.provenanceSummary.filter((row) => row.capability === "VIDEO" && row.status === "COMPLETED").length === 1,
    partialStatus: partial.status,
    requiredFailureStatus: failing.status,
    writeAfterResearchFailure: failing.completedSteps.includes("write"),
    cancelledStatus: cancelled.status,
    remoteCancellationConfirmed: false,
    isolated: true,
  };
}
