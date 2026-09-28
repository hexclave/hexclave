import { teamMembershipCreatedWebhookEvent, teamMembershipDeletedWebhookEvent } from "./crud/team-memberships";
import { teamPermissionCreatedWebhookEvent, teamPermissionDeletedWebhookEvent } from "./crud/team-permissions";
import { teamCreatedWebhookEvent, teamDeletedWebhookEvent, teamUpdatedWebhookEvent } from "./crud/teams";
import { userCreatedWebhookEvent, userDeletedWebhookEvent, userUpdatedWebhookEvent } from "./crud/users";
import { projectPermissionCreatedWebhookEvent, projectPermissionDeletedWebhookEvent } from "./crud/project-permissions";

// Shared contract for Hexclave Workflows (v1). These are the wire types the
// workflows API routes speak (snake_case JSON) plus the platform event
// catalog. The engine, the admin SDK, and the dashboard all import from
// here so the shapes cannot drift.

// ─── Platform event catalog ────────────────────────────────────────────────

/**
 * The v1 platform event catalog IS the webhook catalog: same types, same
 * payload schemas, single source of truth in the crud files. Workflows
 * automatically inherit any future webhook event that gets added here.
 *
 * Note this deliberately includes the two project_permission events that the
 * OpenAPI-focused `webhookEvents` array in webhooks.ts omits — the 12
 * `send*Webhook` exports in the backend are the real catalog.
 */
export const workflowPlatformEvents = [
  userCreatedWebhookEvent,
  userUpdatedWebhookEvent,
  userDeletedWebhookEvent,
  teamCreatedWebhookEvent,
  teamUpdatedWebhookEvent,
  teamDeletedWebhookEvent,
  teamMembershipCreatedWebhookEvent,
  teamMembershipDeletedWebhookEvent,
  teamPermissionCreatedWebhookEvent,
  teamPermissionDeletedWebhookEvent,
  projectPermissionCreatedWebhookEvent,
  projectPermissionDeletedWebhookEvent,
] as const;

export const workflowPlatformEventTypes = workflowPlatformEvents.map((event) => event.type);

// NOTE: there are deliberately no `workflow.run.*` lifecycle events. An earlier
// draft emitted started/completed/failed/canceled and let workflows subscribe to
// them, which made self-amplification trivial: a workflow triggered on
// `workflow.run.completed` re-triggers itself on every completion, with no
// chain-depth cap to stop it. Run state is already fully visible in the
// dashboard and via the runs API, so the trigger bought little and cost a
// footgun. If they ever come back, they need loop protection first.

/**
 * The wire type of custom events is ALWAYS prefixed with this; send() only
 * emits custom events and auto-prefixes. The unprefixed namespace is
 * reserved for platform events forever.
 */
export const WORKFLOW_CUSTOM_EVENT_PREFIX = "custom.";

/** The synthetic trigger type of schedule occurrences. */
export const WORKFLOW_SCHEDULE_TRIGGER_TYPE = "schedule";

// ─── Limits (enforced with explicit errors, never truncation) ──────────────

export const WORKFLOW_SOURCE_MAX_BYTES = 128 * 1024;
export const WORKFLOW_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
export const WORKFLOW_STEP_RESULT_MAX_BYTES = 1024 * 1024;
export const WORKFLOW_RUN_MEMO_MAX_BYTES = 4 * 1024 * 1024;
export const WORKFLOW_RUN_KEY_MAX_LENGTH = 512;

/** 1 initial attempt + 3 retries. */
export const WORKFLOW_STEP_MAX_ATTEMPTS = 4;
/** Backoff before retry N (1-indexed), jittered by the engine. */
export const WORKFLOW_STEP_RETRY_BACKOFF_MS = [10_000, 60_000, 600_000] as const;

/** Workflow ids are user-chosen slugs; the business identity across versions. */
export const WORKFLOW_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ─── Manifest / triggers ───────────────────────────────────────────────────

export type WorkflowConflictBehavior = "skip" | "cancel-existing" | "error";

export type WorkflowTriggerJson =
  | { type: "event", event_type: string }
  | { type: "schedule", cron: string, timezone: string };

/**
 * Extracted from the workflow file by executing its compiled bundle in
 * manifest mode at sync time. Trigger declarations are matched as data by
 * event dispatch; user code is never re-evaluated to answer "what does this
 * workflow subscribe to".
 */
export type WorkflowManifestJson = {
  workflow_id: string,
  triggers: WorkflowTriggerJson[],
  has_run_key: boolean,
  on_conflict: WorkflowConflictBehavior,
  /** Which pinned stdlib packages the source imports (e.g. ["date-fns"]); drives sandbox nodeModules installs. */
  uses_stdlib: string[],
};

// ─── Runs ──────────────────────────────────────────────────────────────────

/**
 * queued -> running <-> sleeping -> completed | failed | canceled.
 * There is deliberately NO paused state: divergent upgrade transfers are
 * skipped (the run keeps executing its pinned version), never halted.
 */
export type WorkflowRunStateJson = "queued" | "running" | "sleeping" | "completed" | "failed" | "canceled";

export const workflowRunActiveStates = ["queued", "running", "sleeping"] as const satisfies readonly WorkflowRunStateJson[];

export type WorkflowRunFailureKindJson = "user" | "platform";

export type WorkflowDivergenceDiagnosticJson = {
  reason:
    // The target version's code requests a step that was never recorded
    // while recorded facts sit unconsumed — the code took a different path.
    | "unknown-step-with-unconsumed-facts"
    // The run is suspended on a sleep the target version's code no longer
    // reaches.
    | "suspended-step-not-reached"
    // The run was mid-invocation for the whole upgrade window; upgrading
    // against a bag that is changing underneath is not judgeable. Safe and
    // reversible: retry the upgrade once the step completes.
    | "run-busy"
    // The probe invocation itself failed (e.g. the target version's module
    // throws at import time against this run's facts).
    | "probe-failed",
  /** Step the run is currently suspended on / executing, if any. */
  suspended_step_key: string | null,
  /** First non-memoized step the target version's code requested, if the probe got that far. */
  found_step_key: string | null,
  /** Recorded step keys the target version's replay consumed before diverging. */
  consumed_step_keys: string[],
  /** Recorded step keys the target version's replay never consumed. */
  unconsumed_step_keys: string[],
  details: string,
};

export type WorkflowRunJson = {
  id: string,
  workflow_id: string,
  run_key: string | null,
  state: WorkflowRunStateJson,
  version: number,
  trigger_type: string,
  /** Short human-readable summary derived from the trigger payload (best-effort). */
  trigger_summary: string,
  current_step_id: string | null,
  steps_recorded: number,
  error_summary: string | null,
  failure_kind: WorkflowRunFailureKindJson | null,
  last_upgrade_divergence: WorkflowDivergenceDiagnosticJson | null,
  created_at_millis: number,
  completed_at_millis: number | null,
  next_wake_at_millis: number | null,
};

export type WorkflowStepResultJson = {
  step_key: string,
  step_id: string,
  kind: "run" | "sleep",
  result: unknown,
  result_size_bytes: number,
  attempts: number,
  executed_at_version: number,
  elapsed_ms: number | null,
  created_at_millis: number,
};

export type WorkflowStepAttemptJson = {
  step_key: string,
  step_id: string,
  /** 0 for the original execution; incremented by each manual retry of the run. */
  retry_epoch: number,
  attempt: number,
  outcome: "succeeded" | "failed",
  error: { name: string, message: string, stack?: string } | null,
  failure_kind: WorkflowRunFailureKindJson | null,
  logs: string | null,
  started_at_millis: number,
  finished_at_millis: number,
};

export type WorkflowRunDetailsJson = WorkflowRunJson & {
  trigger_payload: unknown,
  steps: WorkflowStepResultJson[],
  step_attempts: WorkflowStepAttemptJson[],
};

// ─── Workflows / versions ──────────────────────────────────────────────────

export type WorkflowStatsJson = {
  /** Number of retained runs available in the workflow's run history. */
  total_runs: number,
  active_runs: number,
  sleeping_runs: number,
  failed_7d: number,
  /** Daily run-start counts, oldest first, exactly 14 entries. */
  run_volume_14d: number[],
};

export type WorkflowSummaryJson = {
  id: string,
  display_name: string,
  latest_version: number,
  triggers: WorkflowTriggerJson[],
  /** Paused workflows create no new runs; their in-flight runs keep going. */
  is_paused: boolean,
  paused_at_millis: number | null,
  stats: WorkflowStatsJson,
  created_at_millis: number,
  last_deployed_at_millis: number,
};

export type WorkflowVersionJson = {
  workflow_id: string,
  version: number,
  source: string,
  source_hash: string,
  runtime_env_version: string,
  is_latest: boolean,
  /** Active (queued/running/sleeping) runs pinned to this version. */
  in_flight_runs: number,
  created_at_millis: number,
};

export type WorkflowSyncResultJson = {
  workflow_id: string,
  /** The latest version after the sync. */
  version: number,
  /** False when the source (and runtime env) was unchanged, so no version was minted. */
  created: boolean,
  /** Active runs remaining on versions older than `version`. */
  in_flight_runs_on_older_versions: number,
};

export type WorkflowCancelRunsResultJson = {
  canceled_count: number,
};

export type WorkflowUpgradeRunsResultJson = {
  upgraded_count: number,
  skipped: {
    run_id: string,
    run_key: string | null,
    from_version: number,
    diagnostic: WorkflowDivergenceDiagnosticJson,
  }[],
};

export type WorkflowRunsFilterJson = {
  state?: WorkflowRunStateJson,
  version?: number,
  run_key?: string,
  cursor?: string,
  limit?: number,
  /** Include each run's memoized state bag (steps) in the response. */
  include_state?: boolean,
};
