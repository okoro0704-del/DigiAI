export const PLATFORM_JOBS_ACTION_INTEGRATION = "BRIDGE_DEFINED" as const;

export const ACTION_JOB_BRIDGE = {
  advancePath: "/v1/action-executions/:executionId/advance",
  reconcilePath: "/internal/action-executions/:executionId/reconcile",
  note: "No Platform Jobs client exists in Digi AI. Durable executionId is the resume key for a future worker.",
};
