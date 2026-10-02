import { WORKFLOW_SCHEDULE_TRIGGER_TYPE, type WorkflowManifestJson } from "@hexclave/shared/dist/interface/workflows";

export type WorkflowEventForMatching = {
  type: string,
  payload: unknown,
};

export function workflowDefinitionMatchesEvent(
  workflowId: string,
  manifest: WorkflowManifestJson,
  event: WorkflowEventForMatching,
): boolean {
  if (event.type === WORKFLOW_SCHEDULE_TRIGGER_TYPE) {
    // Schedule occurrences belong to the exact trigger deployment that
    // materialized them. A queued occurrence from an old cron expression
    // must not dispatch a replacement schedule for the same workflow.
    if (event.payload == null || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
    const payload = event.payload;
    if (!("workflow_id" in payload) || !("cron" in payload) || !("timezone" in payload)) return false;
    return payload.workflow_id === workflowId
      && typeof payload.cron === "string"
      && typeof payload.timezone === "string"
      && manifest.triggers.some((trigger) =>
        trigger.type === "schedule"
        && trigger.cron === payload.cron
        && trigger.timezone === payload.timezone
      );
  }
  return manifest.triggers.some((trigger) => trigger.type === "event" && trigger.event_type === event.type);
}

export function workflowEventRetryDelayMs(nextAttempt: number): number {
  // One minute, doubling through one hour. Capping the exponent avoids
  // numeric growth even if a permanently broken event survives for years.
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(Math.max(nextAttempt - 1, 0), 6));
}

export function didAnySkippedWorkflowResume(
  skippedPausedWorkflowIds: ReadonlySet<string>,
  currentPausedWorkflowIds: ReadonlySet<string>,
): boolean {
  for (const workflowId of skippedPausedWorkflowIds) {
    if (!currentPausedWorkflowIds.has(workflowId)) return true;
  }
  return false;
}
