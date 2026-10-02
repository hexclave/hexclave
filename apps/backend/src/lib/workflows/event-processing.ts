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

/**
 * Splits a claimed batch into the events no workflow listens to (which only
 * need marking processed) and, per tenancy, the events to dispatch together
 * with the definitions each one matches. Input order is preserved within each
 * tenancy: that is the order the events are dispatched in.
 */
export function partitionClaimedWorkflowEvents<
  Event extends WorkflowEventForMatching & { tenancyId: string },
  Definition extends { workflowId: string, manifest: WorkflowManifestJson },
>(
  events: Event[],
  definitionsByTenancy: Map<string, Definition[]>,
): {
  unmatched: Event[],
  matchedByTenancy: Map<string, { event: Event, matching: Definition[] }[]>,
} {
  const unmatched: Event[] = [];
  const matchedByTenancy = new Map<string, { event: Event, matching: Definition[] }[]>();
  for (const event of events) {
    const definitions = definitionsByTenancy.get(event.tenancyId) ?? [];
    const matching = definitions.filter((definition) => workflowDefinitionMatchesEvent(definition.workflowId, definition.manifest, event));
    if (matching.length === 0) {
      unmatched.push(event);
      continue;
    }
    const entries = matchedByTenancy.get(event.tenancyId) ?? [];
    entries.push({ event, matching });
    matchedByTenancy.set(event.tenancyId, entries);
  }
  return { unmatched, matchedByTenancy };
}
