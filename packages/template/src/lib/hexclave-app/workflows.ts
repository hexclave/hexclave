import type {
  WorkflowDivergenceDiagnosticJson,
  WorkflowRunDetailsJson,
  WorkflowRunJson,
  WorkflowSummaryJson,
  WorkflowSyncResultJson,
  WorkflowVersionJson,
} from "@hexclave/shared/dist/interface/workflows";

// SDK-side (camelCase) types + converters for the workflows admin surface.
// The wire types live in @hexclave/shared/dist/interface/workflows; these
// mirror them 1:1 so the dashboard never touches snake_case.

export type AdminWorkflowTrigger =
  | { type: "event", eventType: string }
  | { type: "schedule", cron: string, timezone: string };

export type AdminWorkflow = {
  id: string,
  displayName: string,
  latestVersion: number,
  triggers: AdminWorkflowTrigger[],
  /** Paused workflows create no new runs; their in-flight runs keep going. */
  isPaused: boolean,
  pausedAtMillis: number | null,
  stats: {
    totalRuns: number,
    activeRuns: number,
    sleepingRuns: number,
    failed7d: number,
    runVolume14d: number[],
  },
  createdAtMillis: number,
  lastDeployedAtMillis: number,
};

export type AdminWorkflowRunState = "queued" | "running" | "sleeping" | "completed" | "failed" | "canceled";

export type AdminWorkflowDivergenceDiagnostic = {
  reason: WorkflowDivergenceDiagnosticJson["reason"],
  suspendedStepKey: string | null,
  foundStepKey: string | null,
  consumedStepKeys: string[],
  unconsumedStepKeys: string[],
  details: string,
};

export type AdminWorkflowRun = {
  id: string,
  workflowId: string,
  runKey: string | null,
  state: AdminWorkflowRunState,
  version: number,
  triggerType: string,
  triggerSummary: string,
  currentStepId: string | null,
  stepsRecorded: number,
  errorSummary: string | null,
  failureKind: "user" | "platform" | null,
  lastUpgradeDivergence: AdminWorkflowDivergenceDiagnostic | null,
  createdAtMillis: number,
  completedAtMillis: number | null,
  nextWakeAtMillis: number | null,
};

export type AdminWorkflowStep = {
  stepKey: string,
  stepId: string,
  kind: "run" | "sleep",
  result: unknown,
  resultSizeBytes: number,
  attempts: number,
  executedAtVersion: number,
  elapsedMs: number | null,
  createdAtMillis: number,
};

export type AdminWorkflowStepAttempt = {
  stepKey: string,
  stepId: string,
  /** 0 for the original execution; incremented by each manual retry of the run. */
  retryEpoch: number,
  attempt: number,
  outcome: "succeeded" | "failed",
  error: { name: string, message: string, stack?: string } | null,
  failureKind: "user" | "platform" | null,
  logs: string | null,
  startedAtMillis: number,
  finishedAtMillis: number,
};

export type AdminWorkflowRunDetails = AdminWorkflowRun & {
  triggerPayload: unknown,
  steps: AdminWorkflowStep[],
  stepAttempts: AdminWorkflowStepAttempt[],
};

export type AdminWorkflowVersion = {
  workflowId: string,
  version: number,
  sourceHash: string,
  source: string,
  runtimeEnvVersion: string,
  isLatest: boolean,
  inFlightRuns: number,
  createdAtMillis: number,
};

export type AdminWorkflowSyncResult = {
  workflowId: string,
  version: number,
  created: boolean,
  inFlightRunsOnOlderVersions: number,
};

export type AdminWorkflowUpgradeResult = {
  upgradedCount: number,
  skipped: {
    runId: string,
    runKey: string | null,
    fromVersion: number,
    diagnostic: AdminWorkflowDivergenceDiagnostic,
  }[],
};

export type AdminWorkflowRunsFilter = {
  state?: AdminWorkflowRunState,
  version?: number,
  runKey?: string,
  cursor?: string,
  limit?: number,
  /** Include each run's memoized steps and attempt history. */
  includeState?: boolean,
};

export function adminWorkflowFromCrud(crud: WorkflowSummaryJson): AdminWorkflow {
  return {
    id: crud.id,
    displayName: crud.display_name,
    latestVersion: crud.latest_version,
    triggers: crud.triggers.map((trigger) => trigger.type === "event"
      ? { type: "event", eventType: trigger.event_type }
      : { type: "schedule", cron: trigger.cron, timezone: trigger.timezone }),
    isPaused: crud.is_paused,
    pausedAtMillis: crud.paused_at_millis,
    stats: {
      totalRuns: crud.stats.total_runs,
      activeRuns: crud.stats.active_runs,
      sleepingRuns: crud.stats.sleeping_runs,
      failed7d: crud.stats.failed_7d,
      runVolume14d: crud.stats.run_volume_14d,
    },
    createdAtMillis: crud.created_at_millis,
    lastDeployedAtMillis: crud.last_deployed_at_millis,
  };
}

function adminDivergenceFromCrud(crud: WorkflowDivergenceDiagnosticJson | null): AdminWorkflowDivergenceDiagnostic | null {
  if (crud == null) return null;
  return {
    reason: crud.reason,
    suspendedStepKey: crud.suspended_step_key,
    foundStepKey: crud.found_step_key,
    consumedStepKeys: crud.consumed_step_keys,
    unconsumedStepKeys: crud.unconsumed_step_keys,
    details: crud.details,
  };
}

export function adminWorkflowRunFromCrud(crud: WorkflowRunJson): AdminWorkflowRun {
  return {
    id: crud.id,
    workflowId: crud.workflow_id,
    runKey: crud.run_key,
    state: crud.state,
    version: crud.version,
    triggerType: crud.trigger_type,
    triggerSummary: crud.trigger_summary,
    currentStepId: crud.current_step_id,
    stepsRecorded: crud.steps_recorded,
    errorSummary: crud.error_summary,
    failureKind: crud.failure_kind,
    lastUpgradeDivergence: adminDivergenceFromCrud(crud.last_upgrade_divergence),
    createdAtMillis: crud.created_at_millis,
    completedAtMillis: crud.completed_at_millis,
    nextWakeAtMillis: crud.next_wake_at_millis,
  };
}

export function isWorkflowRunDetailsJson(crud: WorkflowRunJson): crud is WorkflowRunDetailsJson {
  return "trigger_payload" in crud
    && "steps" in crud
    && Array.isArray(crud.steps)
    && "step_attempts" in crud
    && Array.isArray(crud.step_attempts);
}

export function adminWorkflowRunDetailsFromCrud(crud: WorkflowRunDetailsJson): AdminWorkflowRunDetails {
  return {
    ...adminWorkflowRunFromCrud(crud),
    triggerPayload: crud.trigger_payload,
    steps: crud.steps.map((step) => ({
      stepKey: step.step_key,
      stepId: step.step_id,
      kind: step.kind,
      result: step.result,
      resultSizeBytes: step.result_size_bytes,
      attempts: step.attempts,
      executedAtVersion: step.executed_at_version,
      elapsedMs: step.elapsed_ms,
      createdAtMillis: step.created_at_millis,
    })),
    stepAttempts: crud.step_attempts.map((attempt) => ({
      stepKey: attempt.step_key,
      stepId: attempt.step_id,
      retryEpoch: attempt.retry_epoch,
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      error: attempt.error,
      failureKind: attempt.failure_kind,
      logs: attempt.logs,
      startedAtMillis: attempt.started_at_millis,
      finishedAtMillis: attempt.finished_at_millis,
    })),
  };
}

export function adminWorkflowVersionFromCrud(crud: WorkflowVersionJson): AdminWorkflowVersion {
  return {
    workflowId: crud.workflow_id,
    version: crud.version,
    sourceHash: crud.source_hash,
    source: crud.source,
    runtimeEnvVersion: crud.runtime_env_version,
    isLatest: crud.is_latest,
    inFlightRuns: crud.in_flight_runs,
    createdAtMillis: crud.created_at_millis,
  };
}

export function adminWorkflowSyncResultFromCrud(crud: WorkflowSyncResultJson): AdminWorkflowSyncResult {
  return {
    workflowId: crud.workflow_id,
    version: crud.version,
    created: crud.created,
    inFlightRunsOnOlderVersions: crud.in_flight_runs_on_older_versions,
  };
}
