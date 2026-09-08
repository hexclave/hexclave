// The two canonical Growth workflow sources. These are ordinary customer
// workflows: Growth seeds them into the tenancy's workflow list (see
// lib/growth/workflows.ts), the customer may read/edit/delete them like any
// other workflow, and Growth NEVER auto-updates an existing definition — it
// only recreates a missing one (the watchdog's ensure pass).
//
// The sources are STATIC strings with no interpolation whatsoever: tenancy
// identity comes from the per-run credentials the workflow engine injects
// (the run token authenticates as ordinary server auth), so the same bytes
// work for every project. Keeping the strings byte-stable is load-bearing —
// edit detection (lib/growth/workflows.ts getGrowthWorkflowStates) is a plain
// string compare of the stored latest version's source against these consts.
//
// Style note: the sources live in template literals, so they must not contain
// backtick characters or "${" sequences. All string building inside the
// workflow code uses concatenation.
//
// Runtime facts these sources rely on (verified against
// lib/workflows/runtime-source.tsx, route-handlers/smart-request.tsx, and
// smart-router.tsx — re-verify when touching either side):
//   - The invocation prelude sets globalThis.__HEXCLAVE_WORKFLOWS_INPUT__,
//     whose credentials field is { apiUrl, projectId, branchId,
//     secretServerKey } (the secretServerKey slot carries the run token).
//   - smart-request reads server auth from the x-stack-project-id,
//     x-stack-branch-id, x-stack-access-type, and x-stack-secret-server-key
//     headers.
//   - The public path of app/api/latest/... routes is /api/v1/... (the
//     smart router maps the version prefix), and credentials.apiUrl is the
//     bare API origin (same value the SDK receives as baseUrl).
//   - event.type inside the runtime is the WIRE type: "schedule" for
//     schedule occurrences and "custom.<name>" for custom events. runKey
//     functions therefore see the "custom." prefix — the watchdog's
//     runKey-derivation helpers below MUST stay in sync with the runKey
//     functions embedded in the sources (asserted in workflow-sources.test.ts).

export const GROWTH_ANALYSIS_WORKFLOW_ID = "growth-analysis";
export const GROWTH_DAILY_BRIEF_WORKFLOW_ID = "growth-daily-brief";

// Unprefixed custom event names (the "custom." wire prefix is added by
// customEvent() in the workflow runtime and by GROWTH_EVENT_TYPES in
// lib/growth/workflows.ts).
export const GROWTH_ANALYSIS_RUN_ACTIVATED_EVENT_NAME = "growth.analysis-run-activated";
export const GROWTH_INTERVIEW_FINISHED_EVENT_NAME = "growth.interview-finished";
export const GROWTH_DAILY_BRIEF_DUE_EVENT_NAME = "growth.daily-brief-due";

/**
 * The runKey of one growth-analysis leg, as derived by the source's runKey
 * function: "<growth run id>:<wire event type>". `wireEventType` must be the
 * full wire type including the "custom." prefix (that is what event.type is
 * at runtime).
 */
export function getGrowthAnalysisLegRunKey(growthRunId: string, wireEventType: string): string {
  return growthRunId + ":" + wireEventType;
}

/** The runKey of one growth-daily-brief day: "brief:<YYYY-MM-DD>". */
export function getGrowthDailyBriefRunKey(dateString: string): string {
  return "brief:" + dateString;
}

export const GROWTH_ANALYSIS_WORKFLOW_SOURCE = `// Growth: analysis runner (managed by the Growth app).
//
// Drives one growth analysis run to its next resting point: it repeatedly
// asks the Growth orchestration API to advance the run (dispatching analysis
// phases to the Growth agent, retrying stuck ones, and transitioning the run
// through its lifecycle), long-polling in between so progress is picked up
// quickly. It exits once the run rests (waiting for your interview answers,
// completed, or failed) and is re-triggered by the next lifecycle event.
//
// You can edit or delete this workflow like any other. If it is deleted,
// Growth recreates the default version automatically (analysis runs cannot
// make progress without it).

import { workflow, customEvent, NonRetriableError } from "@hexclave/workflows";

type GrowthAnalysisEventData = {
  growth_run_id: string,
};

type GrowthAnalysisSnapshot = {
  state: string,
  resting: boolean,
  fingerprint: string,
  phases: { key: string, status: string, attempt: number }[],
};

// Calls the Growth server API with this run's own project credentials (the
// same injected credentials the built-in hexclaveApp uses). Returns null on
// 404 (the analysis run disappeared, e.g. the project was deleted) and
// throws on any other failure so the step's retries kick in.
async function growthApi<T>(path: string, body: unknown): Promise<T | null> {
  // The invocation prelude always defines this global; its shape is the
  // workflow runtime protocol, which is stable for already-synced versions.
  const credentials = (globalThis as any).__HEXCLAVE_WORKFLOWS_INPUT__.credentials;
  if (credentials == null) throw new Error("Workflow credentials missing - growthApi can only be called while the workflow is executing");
  const url = credentials.apiUrl.replace(/\\/+$/, "") + "/api/v1/internal/growth-server/" + path;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stack-access-type": "server",
      "x-stack-project-id": credentials.projectId,
      "x-stack-branch-id": credentials.branchId,
      "x-stack-secret-server-key": credentials.secretServerKey,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error("Growth API " + path + " failed with status " + response.status + ": " + (await response.text()));
  }
  return await response.json();
}

export default workflow<GrowthAnalysisEventData>("growth-analysis", {
  // Two triggers, two legs per analysis run: activation drives the run up to
  // the interview, interview-finished drives the report side afterwards.
  on: [customEvent("growth.analysis-run-activated"), customEvent("growth.interview-finished")],
  // One active leg per (run, trigger type); a duplicate event while a leg is
  // still active is skipped. event.type is the wire type ("custom.growth....").
  runKey: (event) => event.data.growth_run_id + ":" + event.type,
  onConflict: "skip",
}, async (event, step) => {
  const growthRunId = event.data.growth_run_id;
  for (let round = 0; round < 200; round++) {
    // One round = one tick (which actually advances the run) plus one long-poll. Keeping a
    // checkpoint below the platform invocation ceiling matters more than saving a checkpoint every
    // 4 minutes: if this handler is killed before step.run returns, orchestration never gets another
    // tick in which to reap or retry a stuck phase. The step id must be unique per iteration.
    const snapshot = await step.run("advance-" + round, async () => {
      let latest = await growthApi<GrowthAnalysisSnapshot>("analysis/tick", { run_id: growthRunId });
      if (latest != null && !latest.resting) {
        latest = await growthApi<GrowthAnalysisSnapshot>("analysis/wait", {
          run_id: growthRunId,
          fingerprint: latest.fingerprint,
          timeout_ms: 240000,
        });
      }
      return latest;
    }, { timeout: "10m", retries: 3 });
    if (snapshot == null || snapshot.resting) return;
  }
  // 200 rounds of ~4-minute polling is >13h of a run that never rests: the
  // orchestration's own attempt budgets should have failed it long before,
  // so give up loudly instead of looping forever.
  throw new NonRetriableError("Growth analysis run " + growthRunId + " did not reach a resting state within 200 rounds");
});
`;

export const GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE = `// Growth: daily brief (managed by the Growth app).
//
// Once per UTC day, this workflow rolls up yesterday's growth metrics, asks
// the Growth agent to write the daily brief, waits for the content, wires up
// brief deliveries, and evaluates growth milestones. If the agent never
// produces content, the brief is skipped so the day can't wedge.
//
// You can edit or delete this workflow like any other (e.g. change the
// schedule). If it is deleted, Growth recreates the default version
// automatically (daily briefs stop without it).

import { workflow, schedule, customEvent } from "@hexclave/workflows";

type GrowthDailyBriefDueEventData = {
  date: string,
};

// Calls the Growth server API with this run's own project credentials (the
// same injected credentials the built-in hexclaveApp uses). Returns null on
// 404 and throws on any other failure so the step's retries kick in.
async function growthApi<T>(path: string, body: unknown): Promise<T | null> {
  // The invocation prelude always defines this global; its shape is the
  // workflow runtime protocol, which is stable for already-synced versions.
  const credentials = (globalThis as any).__HEXCLAVE_WORKFLOWS_INPUT__.credentials;
  if (credentials == null) throw new Error("Workflow credentials missing - growthApi can only be called while the workflow is executing");
  const url = credentials.apiUrl.replace(/\\/+$/, "") + "/api/v1/internal/growth-server/" + path;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stack-access-type": "server",
      "x-stack-project-id": credentials.projectId,
      "x-stack-branch-id": credentials.branchId,
      "x-stack-secret-server-key": credentials.secretServerKey,
    },
    body: JSON.stringify(body),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error("Growth API " + path + " failed with status " + response.status + ": " + (await response.text()));
  }
  return await response.json();
}

// The brief covers the last fully-elapsed UTC day relative to the trigger.
function yesterdayUtcDateString(ts: Date): string {
  const yesterday = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate() - 1));
  return yesterday.toISOString().slice(0, 10);
}

export default workflow<GrowthDailyBriefDueEventData>("growth-daily-brief", {
  // The schedule is the normal path; the custom event is the Growth
  // watchdog's catch-up path for days the schedule missed.
  on: [schedule("10 0 * * *", { timezone: "Etc/UTC" }), customEvent("growth.daily-brief-due")],
  // One run per brief day, whichever trigger fires first wins.
  runKey: (event) => "brief:" + (event.type === "schedule" ? yesterdayUtcDateString(event.ts) : event.data.date),
  onConflict: "skip",
}, async (event, step) => {
  const date = event.type === "schedule" ? yesterdayUtcDateString(event.ts) : event.data.date;

  const rollup = await step.run("rollup", async () => {
    return await growthApi<{ brief_id: string, brief_status: string, created: boolean }>("daily/rollup", { date: date });
  }, { retries: 3 });
  if (rollup == null) return;

  let briefStatus = rollup.brief_status;
  if (briefStatus === "generating") {
    await step.run("dispatch-brief", async () => {
      return await growthApi<{ brief_status: string }>("daily/dispatch-brief", { brief_id: rollup.brief_id });
    }, { retries: 3 });

    // Up to 8 long-polls (~32 minutes) for the agent to write the content.
    // Each wait needs its own step id so replays don't reuse an old result.
    for (let poll = 0; poll < 8; poll++) {
      const waited = await step.run("wait-brief-" + poll, async () => {
        return await growthApi<{ brief_status: string }>("daily/wait-brief", { brief_id: rollup.brief_id, timeout_ms: 240000 });
      }, { timeout: "5m", retries: 3 });
      if (waited == null) return;
      briefStatus = waited.brief_status;
      if (briefStatus !== "generating") break;
    }

    if (briefStatus === "generating") {
      // The agent never delivered: skip the brief so the day can't wedge
      // (a raced "ready" write wins the CAS and comes back here instead).
      const skipped = await step.run("skip-brief", async () => {
        return await growthApi<{ brief_status: string }>("daily/skip-brief", { brief_id: rollup.brief_id });
      }, { retries: 3 });
      if (skipped == null) return;
      briefStatus = skipped.brief_status;
    }
  }

  if (briefStatus === "ready") {
    await step.run("wire-deliveries", async () => {
      return await growthApi<{ deliveries: { channel: string, status: string }[] }>("daily/wire-deliveries", { brief_id: rollup.brief_id });
    }, { retries: 3 });
  }

  // Milestones only ever compare against stored rollups, so evaluating right
  // after the rollup keeps their latency at the rollup cadence.
  await step.run("evaluate-milestones", async () => {
    return await growthApi<{ evaluated: number }>("milestones/evaluate", {});
  }, { retries: 3 });
});
`;
