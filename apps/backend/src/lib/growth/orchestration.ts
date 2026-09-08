import { GrowthPhaseStatus, GrowthRunStatus } from "@/generated/prisma/enums";
import { createGrowthAnalysisRun } from "@/lib/growth/dashboard";
import {
  backfillGrowthMetricHistory,
  buildGrowthMetricRows,
  insertGrowthDailyMetricRows,
  loadGrowthMetricBundle,
} from "@/lib/growth/metric-store";
import { computeGrowthMetricsFromBundle } from "@/lib/growth/metrics";
import {
  GROWTH_ACTIVE_RUN_STATUSES,
  GROWTH_COMPUTE_METRICS_PHASE_KEY,
  GROWTH_FIXED_PRE_INTERVIEW_PHASE_KEYS,
  GROWTH_INTEGRATIONS_PHASE_KEY,
  GROWTH_INTERVIEW_QUESTIONS_PHASE_KEY,
  GROWTH_REPORT_PHASE_KEY,
  isGrowthAnalysisTopicPhaseKey,
} from "@/lib/growth/phases";
import { createGrowthRunToken } from "@/lib/growth/run-token";
import { getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, isPrismaUniqueConstraintViolation, retryTransaction } from "@/prisma-client";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { createHash } from "node:crypto";
import { GROWTH_METRIC_IDS, GrowthMetricId, GrowthWatchedMetric } from "./action-item-types";
import { GROWTH_DELIVERY_CHANNELS, selectMissingGrowthDeliveryChannelIds } from "./delivery";
import { postToEve } from "./eve-dispatch";

/**
 * Growth orchestration, workflow-engine edition: the successor of the v1 cron engine (engine.ts).
 * Where the v1 engine was one global periodic tick that walked EVERY run/brief/milestone in the
 * database, every function here is scoped to a single entity (one analysis run, one brief, one
 * branch's milestones) so that ordinary customer-editable workflows can drive each lifecycle by
 * calling the internal/growth-server routes.
 *
 * The idempotency chain is inherited unchanged from the v1 engine (see the comment at the top of
 * engine.ts): CAS claims bump attempts, the agent echoes attempts back, content writes are
 * natural-key upserts, and unique constraints backstop everything. On top of that, every entry
 * point here must additionally be safe for ANY server-scope caller repeating it at ANY time —
 * workflow run tokens authenticate as plain server auth, so the routes cannot trust the caller to
 * be "the" workflow for this entity. Hence: all lookups are tenancy-scoped, and every mutation is
 * a CAS against growth-table state, making hostile or duplicated calls no-ops.
 *
 * Constants and pure DAG helpers are duplicated from engine.ts on purpose: this file is the
 * canonical copy; engine.ts keeps its own until it is deleted in the migration cutover (we may not
 * import from it, since it dies, and we may not edit it, since it is still live until then).
 */

export const GROWTH_PHASE_STUCK_TIMEOUT_MS = 15 * 60_000;
// One automatic retry recovers transient provider/dispatch failures without allowing an expensive
// phase to run three full times. Manual retry still creates fresh phase rows with a fresh budget.
export const GROWTH_PHASE_MAX_ATTEMPTS = 2;
export const GROWTH_MILESTONE_EVALUATION_INTERVAL_MS = 60 * 60_000;

// User-visible copy (never internals — those go to captureError).
const PHASE_STUCK_ERROR_MESSAGE = "The analysis agent stopped responding. Retry the analysis from the dashboard.";
const PHASE_UNDISPATCHABLE_ERROR_MESSAGE = "The analysis agent could not be reached. Retry the analysis from the dashboard.";
const INTERVIEW_MISSING_ERROR_MESSAGE = "The analysis finished in an inconsistent state. Retry the analysis from the dashboard.";
// Stored via the same FAILED+errorMessage path Eve-reported failures use, so it must be user-safe
// text (GrowthAnalysisPhase.errorMessage surfaces directly in the dashboard) and stay well under
// agent-writes.ts's 500-char cap. The real error goes to captureError only.
const COMPUTE_METRICS_FAILED_ERROR_MESSAGE = "Computing metrics failed. Retry the analysis from the dashboard.";
const BRIEF_UNDISPATCHABLE_ERROR_MESSAGE = "The growth agent could not be reached to generate this brief.";

/**
 * The static phase dependency DAG. The compute-metrics phase (backend-executed, see
 * claimAndDispatchPhase) runs as soon as the run starts; the integrations phase is never dispatched
 * at all — for now the tick auto-skips it once compute-metrics is settled (the existing admin route
 * remains in place for the future integration flow); the "immediate"
 * phases run once BOTH the compute-metrics and integrations phases are COMPLETED/SKIPPED
 * (data-analysis reads the ClickHouse metric store that compute-metrics just refreshed, and the
 * analysis phases read the live ad tools the integrations answer just decided about, so dispatching
 * them earlier would analyze stale/missing data or race the user's connect decision); the
 * interview-questions phase runs once every immediate phase is COMPLETED/SKIPPED; the report phase
 * is never dispatched by the ready-phase scan — only the run-transition step dispatches it, after
 * the user completes (or skips) the interview.
 */
export const GROWTH_PHASE_DAG = {
  computeMetricsPhaseKey: GROWTH_COMPUTE_METRICS_PHASE_KEY,
  integrationsPhaseKey: GROWTH_INTEGRATIONS_PHASE_KEY,
  immediatePhaseKeys: GROWTH_FIXED_PRE_INTERVIEW_PHASE_KEYS as readonly string[],
  immediatePhaseKeyPrefix: "analysis:",
  afterImmediatePhaseKey: GROWTH_INTERVIEW_QUESTIONS_PHASE_KEY,
  interviewGatedPhaseKey: GROWTH_REPORT_PHASE_KEY,
} as const;

// ── Pure helpers (unit-tested in orchestration.test.ts with explicit `now`) ──

type PhaseForReadiness = {
  phaseKey: string,
  status: GrowthPhaseStatus,
};

function isImmediatePhaseKey(phaseKey: string): boolean {
  return GROWTH_PHASE_DAG.immediatePhaseKeys.includes(phaseKey) || isGrowthAnalysisTopicPhaseKey(phaseKey);
}

function isPhaseSettled(status: GrowthPhaseStatus): boolean {
  return status === GrowthPhaseStatus.COMPLETED || status === GrowthPhaseStatus.SKIPPED;
}

/**
 * Which of a run's PENDING phases are dispatchable right now, per the static DAG above. The report
 * phase is never returned; it is gated on the interview and dispatched by the transition step.
 */
export function selectReadyPhaseKeys(phases: readonly PhaseForReadiness[]): string[] {
  // Backward compatibility, on purpose: runs created before the compute-metrics phase existed have
  // no compute-metrics row at all, and `.every()` over the resulting empty list is vacuously true —
  // so pre-existing in-flight runs dispatch their immediate phases exactly as they did before this
  // gate was introduced. Do NOT "simplify" this into a lookup that fails or blocks when the row is
  // missing; the empty-list-is-settled behavior is the migration story for old runs.
  const allComputeMetricsSettled = phases
    .filter((phase) => phase.phaseKey === GROWTH_PHASE_DAG.computeMetricsPhaseKey)
    .every((phase) => isPhaseSettled(phase.status));
  // Same vacuous-truth back-compat story as compute-metrics above: runs created before the
  // integrations phase existed have no integrations row, `.every()` over the empty list is true,
  // and those runs dispatch exactly as they did before this gate was introduced.
  const allIntegrationsSettled = phases
    .filter((phase) => phase.phaseKey === GROWTH_PHASE_DAG.integrationsPhaseKey)
    .every((phase) => isPhaseSettled(phase.status));
  const allImmediateSettled = phases
    .filter((phase) => isImmediatePhaseKey(phase.phaseKey))
    .every((phase) => isPhaseSettled(phase.status));
  return phases
    .filter((phase) => phase.status === GrowthPhaseStatus.PENDING)
    .filter((phase) => {
      if (phase.phaseKey === GROWTH_PHASE_DAG.computeMetricsPhaseKey) return true;
      // The integrations phase is NEVER dispatchable: like the report phase it is settled
      // out-of-band (auto-settle in the tick, or the runs/[run_id]/integrations admin route), so
      // returning it here would make claimAndDispatchPhase POST a human decision to Eve.
      if (phase.phaseKey === GROWTH_PHASE_DAG.integrationsPhaseKey) return false;
      if (isImmediatePhaseKey(phase.phaseKey)) return allComputeMetricsSettled && allIntegrationsSettled;
      // Note the interview gate stays on the immediates only: an unsettled compute-metrics row
      // cannot release interview-questions early anyway, because the immediates can only settle
      // after compute-metrics did (or the run predates the compute-metrics phase entirely).
      if (phase.phaseKey === GROWTH_PHASE_DAG.afterImmediatePhaseKey) return allImmediateSettled;
      if (phase.phaseKey === GROWTH_PHASE_DAG.interviewGatedPhaseKey) return false;
      throw new HexclaveAssertionError(`Unknown growth phase key "${phase.phaseKey}" — phase rows are only ever created from the registry, so this should be impossible.`, { phase });
    })
    .map((phase) => phase.phaseKey);
}

const ONE_DAY_MS = 24 * 60 * 60_000;

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The date one compute-metrics execution writes with: the CURRENT UTC day — unlike the daily
 * rollup, which targets yesterday (the last fully-elapsed day). The rollup records "how day X
 * ended", while this run's snapshot metrics describe "state as of this analysis run", and pinning
 * them to today keeps the stored rows honest about when they were observed. (Flow metrics are
 * re-emitted for the loaders' whole window either way, so the rollup's later yesterday-write
 * supersedes today's partial values via ReplacingMergeTree.)
 */
export function getComputeMetricsDates(now: Date): { targetDate: string } {
  return { targetDate: toUtcDateString(now) };
}

type PhaseForStuckCheck = {
  status: GrowthPhaseStatus,
  dispatchedAt: Date | null,
  heartbeatAt: Date | null,
};

/**
 * A phase is stuck when the agent never picked it up (DISPATCHED with no heartbeat for 15min) or
 * died mid-execution (RUNNING with a stale heartbeat). DISPATCHED-with-heartbeat is impossible per
 * the phase-start route (start sets RUNNING + heartbeat atomically), so it is not considered.
 */
export function isPhaseStuck(phase: PhaseForStuckCheck, now: Date): boolean {
  const cutoffMs = now.getTime() - GROWTH_PHASE_STUCK_TIMEOUT_MS;
  if (phase.status === GrowthPhaseStatus.DISPATCHED) {
    return phase.heartbeatAt == null && phase.dispatchedAt != null && phase.dispatchedAt.getTime() < cutoffMs;
  }
  if (phase.status === GrowthPhaseStatus.RUNNING) {
    return phase.heartbeatAt != null && phase.heartbeatAt.getTime() < cutoffMs;
  }
  return false;
}

/**
 * Resting statuses are the ones the orchestration itself will never move the run out of — only an
 * external event (the user finishing the interview, a retry, a cancellation) can. A workflow
 * driving a run polls tick/wait until the run rests, then stops burning steps.
 */
export function isGrowthAnalysisResting(status: GrowthRunStatus): boolean {
  switch (status) {
    case GrowthRunStatus.AWAITING_INTERVIEW:
    case GrowthRunStatus.COMPLETED:
    case GrowthRunStatus.FAILED:
    case GrowthRunStatus.CANCELLED: {
      return true;
    }
    case GrowthRunStatus.PENDING:
    case GrowthRunStatus.RUNNING:
    case GrowthRunStatus.COMPOSING_REPORT: {
      return false;
    }
  }
}

/**
 * Whether a RUNNING run is blocked ONLY on its pending integrations phase — i.e. the run is waiting
 * for the human's connect-or-skip answer and the orchestration itself cannot move it forward. This
 * feeds the snapshot's `resting` (so the workflow leg cleanly ends instead of long-polling a run
 * that only a human can advance — the runs/[run_id]/integrations route re-fires the activation
 * event to start a fresh leg when the answer lands) and the watchdog's orphaned-run exclusion.
 *
 * "Only blocker" is spelled out defensively: nothing may be in flight (DISPATCHED/RUNNING), nothing
 * may be FAILED (the transition step retries or fails those — the leg must keep driving), and
 * compute-metrics must be settled (before that, the tick still has the compute-metrics execution to
 * do, and the integrations question is not actionable yet — the timeline answers it after metrics).
 * Under the DAG above, a pending integrations phase then gates every other PENDING phase, so
 * nothing is dispatchable either.
 */
export function isGrowthRunAwaitingIntegrations(status: GrowthRunStatus, phases: readonly PhaseForReadiness[]): boolean {
  if (status !== GrowthRunStatus.RUNNING) return false;
  // Runs created before the integrations phase existed have no row and are never "awaiting" it.
  if (!phases.some((phase) => phase.phaseKey === GROWTH_INTEGRATIONS_PHASE_KEY && phase.status === GrowthPhaseStatus.PENDING)) return false;
  const computeMetricsSettled = phases
    .filter((phase) => phase.phaseKey === GROWTH_COMPUTE_METRICS_PHASE_KEY)
    .every((phase) => isPhaseSettled(phase.status));
  if (!computeMetricsSettled) return false;
  return !phases.some((phase) =>
    phase.status === GrowthPhaseStatus.DISPATCHED
    || phase.status === GrowthPhaseStatus.RUNNING
    || phase.status === GrowthPhaseStatus.FAILED);
}

/**
 * Whether the temporary integrations policy can advance this run. Keeping this as a pure helper
 * makes the ordering rule explicit and testable: integrations may only be auto-skipped after the
 * backend has finished computing metrics. The integrations phase and its explicit answer route stay
 * intact so the optional connection flow can be restored without changing the DAG later.
 */
export function shouldAutoSkipGrowthIntegrationsPhase(phases: readonly PhaseForReadiness[]): boolean {
  const hasPendingIntegrations = phases.some((phase) =>
    phase.phaseKey === GROWTH_INTEGRATIONS_PHASE_KEY && phase.status === GrowthPhaseStatus.PENDING,
  );
  if (!hasPendingIntegrations) return false;
  return phases
    .filter((phase) => phase.phaseKey === GROWTH_COMPUTE_METRICS_PHASE_KEY)
    .every((phase) => isPhaseSettled(phase.status));
}

type PhaseForFingerprint = {
  phaseKey: string,
  status: GrowthPhaseStatus,
  attempt: number,
};

/**
 * A deterministic digest of everything the analysis workflow's long-poll cares about. The interview
 * status is included because AWAITING_INTERVIEW → dispatchable-report is triggered by the interview
 * row flipping to completed/skipped without any run/phase row changing yet — without it, a wait
 * would sleep through the exact event it exists to catch.
 */
export function computeGrowthAnalysisFingerprint(
  run: { status: GrowthRunStatus },
  phases: readonly PhaseForFingerprint[],
  interviewStatus: string | null,
): string {
  // Sorted by phaseKey (unique per run) so the fingerprint is independent of query row order.
  const sortedPhases = [...phases]
    .sort((a, b) => a.phaseKey < b.phaseKey ? -1 : a.phaseKey > b.phaseKey ? 1 : 0)
    .map((phase) => [phase.phaseKey, phase.status, phase.attempt] as const);
  return createHash("sha256")
    .update(JSON.stringify([run.status, sortedPhases, interviewStatus ?? "none"]))
    .digest("hex");
}

// ── Analysis run orchestration ───────────────────────────────────────────────

export type GrowthAnalysisSnapshot = {
  state: string,
  resting: boolean,
  fingerprint: string,
  phases: { key: string, status: string, attempt: number }[],
};

type AnalysisRunScope = {
  projectId: string,
  branchId: string,
  runId: string,
};

async function findAnalysisRunWithPhases(scope: AnalysisRunScope) {
  return await globalPrismaClient.growthAnalysisRun.findFirst({
    where: { id: scope.runId, projectId: scope.projectId, branchId: scope.branchId },
    include: {
      phases: { orderBy: { createdAt: "asc" } },
      interview: { select: { id: true, status: true } },
      report: { select: { id: true } },
    },
  });
}

export async function getGrowthAnalysisSnapshot(scope: AnalysisRunScope): Promise<GrowthAnalysisSnapshot | null> {
  const run = await findAnalysisRunWithPhases(scope);
  if (run == null) return null;
  return {
    state: run.status.toLowerCase(),
    // A RUNNING run that is only waiting on the human's integrations answer also rests: the leg
    // ends (releasing its runKey), and the integrations admin route re-fires the activation event
    // to start a fresh leg once the user decides. The fingerprint below already covers the wake-up
    // signal — it hashes every phase's status, so the integrations phase settling changes it and
    // any in-flight wait long-poll resolves immediately.
    resting: isGrowthAnalysisResting(run.status) || isGrowthRunAwaitingIntegrations(run.status, run.phases),
    fingerprint: computeGrowthAnalysisFingerprint(run, run.phases, run.interview?.status ?? null),
    phases: run.phases.map((phase) => ({
      key: phase.phaseKey,
      status: phase.status.toLowerCase(),
      attempt: phase.attempt,
    })),
  };
}

type ClaimablePhase = {
  id: string,
  phaseKey: string,
  status: GrowthPhaseStatus,
  attempt: number,
};

type DispatchableRun = {
  id: string,
  projectId: string,
  branchId: string,
};

/**
 * The one backend-executed phase: claims the compute-metrics phase and refreshes the ClickHouse
 * growth metric store synchronously, inside the tick. This is allowed here — and deliberately NOT
 * in transactional code — because the tick entry points (the growth-server tick route via
 * tickGrowthAnalysisRun, and advanceRunTransitionsForRun's report re-dispatch) are plain
 * route-handler calls that never hold a Postgres transaction open, which is exactly the constraint
 * the metric loaders demand (see the pre-transaction fan-out comment in lib/growth/actions.ts's
 * activation path: metric loads fan out to ClickHouse and the read replica and must not run inside
 * a transaction). The loader fan-out takes on the order of seconds; that is acceptable for one
 * tick, and since a run has exactly one compute-metrics phase row, one tick can execute this at
 * most once.
 *
 * CAS claim semantics mirror claimAndDispatchPhase's PENDING→DISPATCHED claim, but collapse the
 * usual DISPATCHED→RUNNING handshake (agent-writes.ts's start route sets RUNNING + startedAt +
 * heartbeatAt when Eve picks the phase up) into the single claim write: there is no external agent
 * whose pickup DISPATCHED would be waiting on, so the phase goes PENDING→RUNNING directly with
 * dispatchedAt/startedAt/heartbeatAt all set to the claim time. If the process dies mid-execution,
 * the phase is a RUNNING row with a stale heartbeat — precisely what isPhaseStuck reaps — so the
 * existing stuck-reaping and FAILED→PENDING retry machinery apply unchanged.
 *
 * A throw (ClickHouse down, loaders failing) records FAILED like an Eve-reported failure, and after
 * GROWTH_PHASE_MAX_ATTEMPTS such failures the run itself fails. That is intended, not an oversight:
 * data-analysis is meaningless without the metric store it reads, so a run that cannot compute
 * metrics must fail early and loud rather than proceed on stale or missing data.
 */
async function claimAndExecuteComputeMetricsPhase(run: DispatchableRun, phase: ClaimablePhase, now: Date): Promise<{ claimed: boolean }> {
  const claimed = await globalPrismaClient.growthAnalysisPhase.updateMany({
    where: { id: phase.id, status: GrowthPhaseStatus.PENDING },
    data: {
      status: GrowthPhaseStatus.RUNNING,
      dispatchedAt: now,
      startedAt: now,
      heartbeatAt: now,
      attempt: { increment: 1 },
    },
  });
  if (claimed.count === 0) return { claimed: false };
  // Same reasoning as the Eve dispatch path: the CAS guarantees the stored attempt is exactly
  // phase.attempt + 1, and every completion write below re-checks it as the zombie fence.
  const attempt = phase.attempt + 1;
  try {
    // The 2-arg overload throws a HexclaveAssertionError when the tenancy is gone (the run row
    // exists in this project/branch, so that can only happen mid-project-deletion) — it lands in
    // the catch below like any other execution failure.
    const tenancy = await getSoleTenancyFromProjectBranch(run.projectId, run.branchId);
    const executionNow = new Date();
    const { targetDate } = getComputeMetricsDates(executionNow);
    // Internally guarded to the first run ever (cheap existence check), a no-op afterwards.
    await backfillGrowthMetricHistory(tenancy, executionNow);
    const bundle = await loadGrowthMetricBundle(tenancy, executionNow);
    await insertGrowthDailyMetricRows(buildGrowthMetricRows(bundle, targetDate));
    await globalPrismaClient.growthAnalysisPhase.updateMany({
      where: { id: phase.id, status: GrowthPhaseStatus.RUNNING, attempt },
      data: { status: GrowthPhaseStatus.COMPLETED, finishedAt: new Date() },
    });
  } catch (error) {
    captureError("growth-orchestration", new HexclaveAssertionError(`Backend-executed compute-metrics phase failed for growth run ${run.id}`, { cause: error, runId: run.id, attempt }));
    // The stored message is the fixed user-safe constant, never error internals — this column
    // renders in the dashboard (see COMPUTE_METRICS_FAILED_ERROR_MESSAGE above).
    await globalPrismaClient.growthAnalysisPhase.updateMany({
      where: { id: phase.id, status: GrowthPhaseStatus.RUNNING, attempt },
      data: { status: GrowthPhaseStatus.FAILED, finishedAt: new Date(), errorMessage: COMPUTE_METRICS_FAILED_ERROR_MESSAGE },
    });
  }
  return { claimed: true };
}

/**
 * Claims a PENDING phase via CAS (bumping attempt) and POSTs the invocation to Eve. A failed POST
 * resets the phase to PENDING but keeps the incremented attempt, so persistent dispatch failures
 * eventually exhaust the attempt budget instead of retrying forever.
 *
 * The compute-metrics phase is the one exception: it is executed by the backend itself instead of
 * being POSTed to Eve (see claimAndExecuteComputeMetricsPhase).
 */
async function claimAndDispatchPhase(run: DispatchableRun, phase: ClaimablePhase, now: Date): Promise<{ claimed: boolean }> {
  if (phase.status !== GrowthPhaseStatus.PENDING) return { claimed: false };
  if (phase.attempt >= GROWTH_PHASE_MAX_ATTEMPTS) {
    await globalPrismaClient.growthAnalysisPhase.updateMany({
      where: { id: phase.id, status: GrowthPhaseStatus.PENDING },
      data: { status: GrowthPhaseStatus.FAILED, finishedAt: now, errorMessage: PHASE_UNDISPATCHABLE_ERROR_MESSAGE },
    });
    return { claimed: false };
  }
  if (phase.phaseKey === GROWTH_COMPUTE_METRICS_PHASE_KEY) {
    return await claimAndExecuteComputeMetricsPhase(run, phase, now);
  }
  const claimed = await globalPrismaClient.growthAnalysisPhase.updateMany({
    where: { id: phase.id, status: GrowthPhaseStatus.PENDING },
    data: { status: GrowthPhaseStatus.DISPATCHED, dispatchedAt: now, attempt: { increment: 1 } },
  });
  if (claimed.count === 0) return { claimed: false };
  // The CAS above guarantees nobody else incremented between our read and our claim, so the stored
  // attempt is exactly phase.attempt + 1 — this is the value the agent must echo back.
  const attempt = phase.attempt + 1;
  try {
    // The run token is minted AFTER the CAS on purpose: `attempt` is its fencing claim (run-token.ts
    // re-checks it against the live phase row on every call), so a token minted before the claim
    // could name an attempt that a concurrent claimer has already superseded.
    //
    // It travels in the dispatch BODY, never in a header: the hop itself is already authenticated by
    // HEXCLAVE_GROWTH_AGENT_API_SECRET (postToEve sets that Authorization header), and the run token
    // is payload for the session that the hop starts, not a credential for the hop.
    //
    // The 2-arg tenancy overload throws when the tenancy is gone (only possible mid-project-deletion,
    // since the run row exists in this project/branch); that lands in the catch below and resets the
    // phase to PENDING exactly like an unreachable Eve.
    const tenancy = await getSoleTenancyFromProjectBranch(run.projectId, run.branchId);
    const agentToken = await createGrowthRunToken({
      projectId: run.projectId,
      branchId: run.branchId,
      tenancyId: tenancy.id,
      session: { sessionKind: "analysis_phase", phaseId: phase.id, runId: run.id, phaseKey: phase.phaseKey, attempt },
    });
    await postToEve("/runs/analysis-phase", {
      project_id: run.projectId,
      branch_id: run.branchId,
      run_id: run.id,
      phase_key: phase.phaseKey,
      attempt,
      agent_token: agentToken,
    });
  } catch (error) {
    await globalPrismaClient.growthAnalysisPhase.updateMany({
      where: { id: phase.id, status: GrowthPhaseStatus.DISPATCHED },
      data: { status: GrowthPhaseStatus.PENDING, dispatchedAt: null },
    });
    captureError("growth-orchestration", new HexclaveAssertionError(`Failed to dispatch growth phase ${phase.phaseKey} of run ${run.id} to Eve`, { cause: error, runId: run.id, phaseKey: phase.phaseKey, attempt }));
  }
  return { claimed: true };
}

// completedAt intentionally stays null on failure: it marks successful completion only, and
// retryGrowthAnalysis revives failed runs without clearing it, so setting it here would leave a
// stale timestamp on a retried run.
async function failRun(runId: string, errorMessage: string): Promise<void> {
  await globalPrismaClient.growthAnalysisRun.updateMany({
    where: { id: runId, status: { in: [...GROWTH_ACTIVE_RUN_STATUSES] } },
    data: { status: GrowthRunStatus.FAILED, errorMessage },
  });
}

/** Reset (or fail out) this run's phases whose agent invocation went silent. */
async function reapStuckPhasesForRun(run: { phases: { id: string, status: GrowthPhaseStatus, attempt: number, dispatchedAt: Date | null, heartbeatAt: Date | null }[] }, now: Date): Promise<void> {
  for (const phase of run.phases) {
    if (!isPhaseStuck(phase, now)) continue;
    // CAS on (status, heartbeatAt): if a late heartbeat or completion arrived between the scan and
    // this write, the guard fails and the phase is left alone.
    const guard = { id: phase.id, status: phase.status, heartbeatAt: phase.heartbeatAt };
    if (phase.attempt < GROWTH_PHASE_MAX_ATTEMPTS) {
      // eveSessionId is intentionally kept: it's the only pointer to the dead agent session's logs.
      await globalPrismaClient.growthAnalysisPhase.updateMany({
        where: guard,
        data: { status: GrowthPhaseStatus.PENDING, heartbeatAt: null },
      });
    } else {
      await globalPrismaClient.growthAnalysisPhase.updateMany({
        where: guard,
        data: { status: GrowthPhaseStatus.FAILED, finishedAt: now, errorMessage: PHASE_STUCK_ERROR_MESSAGE },
      });
    }
  }
}

type RunForTransitions = NonNullable<Awaited<ReturnType<typeof findAnalysisRunWithPhases>>>;

/** The per-run state machine — failed-phase retries and status transitions, ported from the v1 engine's advanceRunTransitions. */
async function advanceRunTransitionsForRun(run: RunForTransitions, now: Date): Promise<void> {
  const failedPhases = run.phases.filter((phase) => phase.status === GrowthPhaseStatus.FAILED);
  const exhaustedPhase = failedPhases.find((phase) => phase.attempt >= GROWTH_PHASE_MAX_ATTEMPTS);
  if (exhaustedPhase != null) {
    await failRun(run.id, exhaustedPhase.errorMessage ?? PHASE_STUCK_ERROR_MESSAGE);
    return;
  }
  for (const phase of failedPhases) {
    // Explicit agent-reported failures with attempt budget left are retried automatically.
    await globalPrismaClient.growthAnalysisPhase.updateMany({
      where: { id: phase.id, status: GrowthPhaseStatus.FAILED },
      data: { status: GrowthPhaseStatus.PENDING, errorMessage: null, heartbeatAt: null },
    });
  }

  const nonReportPhases = run.phases.filter((phase) => phase.phaseKey !== GROWTH_REPORT_PHASE_KEY);
  if (run.status === GrowthRunStatus.RUNNING && nonReportPhases.every((phase) => isPhaseSettled(phase.status))) {
    if (run.interview == null) {
      // The interview-questions phase completing without an interview row means the agent's
      // question write was skipped — an impossible state we fail loudly rather than wedge on.
      captureError("growth-orchestration", new HexclaveAssertionError(`Growth run ${run.id} completed all pre-interview phases but has no GrowthInterview row`, { runId: run.id }));
      await failRun(run.id, INTERVIEW_MISSING_ERROR_MESSAGE);
    } else {
      await globalPrismaClient.growthAnalysisRun.updateMany({
        where: { id: run.id, status: GrowthRunStatus.RUNNING },
        data: { status: GrowthRunStatus.AWAITING_INTERVIEW },
      });
    }
    return;
  }

  if (run.status === GrowthRunStatus.AWAITING_INTERVIEW && run.interview != null && (run.interview.status === "completed" || run.interview.status === "skipped")) {
    const reportPhase = run.phases.find((phase) => phase.phaseKey === GROWTH_REPORT_PHASE_KEY)
      ?? throwErr(new HexclaveAssertionError(`Growth run ${run.id} has no report phase row — run creation always creates one, so this should be impossible.`, { runId: run.id }));
    await claimAndDispatchPhase(run, reportPhase, now);
    await globalPrismaClient.growthAnalysisRun.updateMany({
      where: { id: run.id, status: GrowthRunStatus.AWAITING_INTERVIEW },
      data: { status: GrowthRunStatus.COMPOSING_REPORT },
    });
    return;
  }

  if (run.status === GrowthRunStatus.COMPOSING_REPORT) {
    const reportPhase = run.phases.find((phase) => phase.phaseKey === GROWTH_REPORT_PHASE_KEY)
      ?? throwErr(new HexclaveAssertionError(`Growth run ${run.id} has no report phase row — run creation always creates one, so this should be impossible.`, { runId: run.id }));
    if (reportPhase.status === GrowthPhaseStatus.COMPLETED) {
      if (run.report == null) {
        // The report-complete route upserts the GrowthReport before completing the phase, so a
        // completed phase without a report row is an impossible state.
        captureError("growth-orchestration", new HexclaveAssertionError(`Growth run ${run.id} has a completed report phase but no GrowthReport row`, { runId: run.id }));
        await failRun(run.id, INTERVIEW_MISSING_ERROR_MESSAGE);
        return;
      }
      await globalPrismaClient.growthAnalysisRun.updateMany({
        where: { id: run.id, status: GrowthRunStatus.COMPOSING_REPORT },
        data: { status: GrowthRunStatus.COMPLETED, completedAt: now },
      });
    } else if (reportPhase.status === GrowthPhaseStatus.PENDING) {
      // The report phase can become PENDING again after a reap, a failed-attempt reset, or a
      // failed POST. The ready-phase scan never touches the report phase, so re-dispatching it
      // here is the only recovery path while the run sits in COMPOSING_REPORT.
      await claimAndDispatchPhase(run, reportPhase, now);
    }
  }
}

/** Dispatch every PENDING phase of this run whose DAG dependencies are settled. */
async function dispatchReadyPhasesForRun(run: RunForTransitions, now: Date): Promise<void> {
  if (run.status !== GrowthRunStatus.PENDING && run.status !== GrowthRunStatus.RUNNING) return;
  const readyPhaseKeys = selectReadyPhaseKeys(run.phases);
  let runMarkedRunning = run.status !== GrowthRunStatus.PENDING;
  for (const phaseKey of readyPhaseKeys) {
    const phase = run.phases.find((candidate) => candidate.phaseKey === phaseKey)
      ?? throwErr(new HexclaveAssertionError("selectReadyPhaseKeys returned a key not present in its input — this should be impossible.", { phaseKey, runId: run.id }));
    const { claimed } = await claimAndDispatchPhase(run, phase, now);
    if (claimed && !runMarkedRunning) {
      await globalPrismaClient.growthAnalysisRun.updateMany({
        where: { id: run.id, status: GrowthRunStatus.PENDING },
        data: { status: GrowthRunStatus.RUNNING },
      });
      runMarkedRunning = true;
    }
  }
}

/**
 * The tick's out-of-band settlement of the integrations phase. For now every pending integrations
 * phase is automatically SKIPPED once compute-metrics is settled, so the analysis proceeds without
 * asking the customer to answer a step whose connection is not wired up yet. The explicit answer
 * route remains available for the future integration flow and for code compatibility.
 *
 * The settle is a CAS updateMany PENDING→settled, so a concurrent tick or a racing admin-route
 * answer harmlessly loses. No column records which rule fired on purpose: the only candidate
 * (errorMessage) renders in the dashboard as an error, and the status alone carries everything the
 * product needs (COMPLETED = the human continued, SKIPPED = user said no).
 */
async function autoSettleIntegrationsPhaseForRun(run: RunForTransitions, now: Date): Promise<boolean> {
  const integrationsPhase = run.phases.find((phase) => phase.phaseKey === GROWTH_INTEGRATIONS_PHASE_KEY);
  if (integrationsPhase == null || integrationsPhase.status !== GrowthPhaseStatus.PENDING) return false;
  if (!shouldAutoSkipGrowthIntegrationsPhase(run.phases)) return false;
  // The CAS makes the return value honest: `count` is 0 when a concurrent tick or the integrations
  // admin route settled the phase first, and the caller only re-dispatches when THIS call is the
  // one that unblocked the DAG.
  const settled = await globalPrismaClient.growthAnalysisPhase.updateMany({
    where: { id: integrationsPhase.id, status: GrowthPhaseStatus.PENDING },
    data: { status: GrowthPhaseStatus.SKIPPED, finishedAt: now },
  });
  return settled.count > 0;
}

/**
 * One orchestration tick for a single analysis run: reap stuck phases, advance the run's state
 * machine, claim + dispatch ready phases, auto-settle the integrations phase, and dispatch once
 * more if that settle unblocked anything (see the comment at the second dispatch). Returns the
 * post-tick snapshot, or null when the run doesn't exist in the given tenancy. Every step is
 * CAS-guarded, so concurrent (or hostile repeated) ticks against the same run are harmless no-ops
 * racing over the same claims.
 */
export async function tickGrowthAnalysisRun(scope: AnalysisRunScope): Promise<GrowthAnalysisSnapshot | null> {
  const run = await findAnalysisRunWithPhases(scope);
  if (run == null) return null;
  const isActive = GROWTH_ACTIVE_RUN_STATUSES.includes(run.status);
  if (isActive) {
    await reapStuckPhasesForRun(run, new Date());
    // Each step re-reads the run so it observes the previous step's writes (a reaped phase must be
    // re-dispatchable within the same tick, like the v1 engine's sequential sub-steps).
    const afterReap = await findAnalysisRunWithPhases(scope);
    if (afterReap != null) {
      await advanceRunTransitionsForRun(afterReap, new Date());
      const afterTransitions = await findAnalysisRunWithPhases(scope);
      if (afterTransitions != null) {
        await dispatchReadyPhasesForRun(afterTransitions, new Date());
        // AFTER dispatch on purpose: compute-metrics executes synchronously inside the dispatch
        // step, so running the auto-settle afterwards lets rules (1)/(2) fire in the very same
        // tick the metrics finished in — otherwise the leg would observe "awaiting integrations",
        // rest, and wedge a run whose answer was already known.
        const afterDispatch = await findAnalysisRunWithPhases(scope);
        if (afterDispatch != null) {
          const integrationsJustSettled = await autoSettleIntegrationsPhaseForRun(afterDispatch, new Date());
          // ...but that ordering means the dispatch above ran while the immediate phases were still
          // DAG-blocked on the integrations phase, so the auto-settle leaves them PENDING with
          // nobody about to pick them up. Dispatching again closes that hole in the same tick.
          // Without it the phases wait for the NEXT tick, which is a whole long-poll window away —
          // the dashboard shows a "Deep analysis / In progress" card whose rows are all still
          // pending, i.e. a column of motionless circles, for minutes.
          if (integrationsJustSettled) {
            const afterAutoSettle = await findAnalysisRunWithPhases(scope);
            if (afterAutoSettle != null) {
              await dispatchReadyPhasesForRun(afterAutoSettle, new Date());
            }
          }
        }
      }
    }
  }
  return await getGrowthAnalysisSnapshot(scope);
}

/**
 * Long-poll: resolves once the run differs from `fingerprint` (or the timeout elapses). A detected
 * change is advanced through the state machine before it is returned. This is load-bearing for
 * phase completions: the canonical workflow may perform more than one poll inside a checkpoint,
 * so returning a changed-but-unadvanced snapshot could leave a fully settled phase set displaying
 * as RUNNING until the next four-minute poll finishes.
 *
 * The tick is safe under concurrent waiters because every mutation it performs is CAS-guarded.
 */
export async function waitForGrowthAnalysisChange(options: AnalysisRunScope & { fingerprint: string, timeoutMs: number, pollIntervalMs?: number }): Promise<GrowthAnalysisSnapshot | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const startMs = performance.now();
  while (true) {
    const snapshot = await getGrowthAnalysisSnapshot(options);
    if (snapshot == null) return null;
    if (snapshot.fingerprint !== options.fingerprint) {
      return await tickGrowthAnalysisRun(options);
    }
    const elapsedMs = performance.now() - startMs;
    if (elapsedMs >= options.timeoutMs) {
      // Tick before giving up, rather than returning the unchanged snapshot. The wait loop above is
      // purely observational — it reads snapshots and never mutates — but phases only leave PENDING
      // inside the tick. So a run that is non-resting with nothing in flight cannot change its own
      // fingerprint, and polling it is guaranteed to be futile no matter how long the timeout is.
      // Ticking here bounds such a stall to a single timeout window instead of deferring it to
      // whenever the caller happens to start another round.
      return await tickGrowthAnalysisRun(options);
    }
    await wait(Math.min(pollIntervalMs, options.timeoutMs - elapsedMs));
  }
}

// ── Daily rollup + brief lifecycle ───────────────────────────────────────────

function assertGrowthMetricId(value: string): GrowthMetricId {
  return GROWTH_METRIC_IDS.find((candidate) => candidate === value)
    ?? throwErr(new HexclaveAssertionError(`Unknown growth metric id "${value}" — watched metrics are validated at write time against the registry, so this should be impossible.`, { value }));
}

/**
 * Parses GrowthActionItem.watchedMetrics back into typed form. The column is always written from
 * resolveGrowthWatchedMetrics, so anything else means the row was corrupted.
 */
function parseWatchedMetrics(json: unknown): GrowthWatchedMetric[] {
  if (!Array.isArray(json)) {
    throw new HexclaveAssertionError("GrowthActionItem.watchedMetrics is not an array", { json });
  }
  return json.map((entry) => {
    if (typeof entry !== "object" || entry == null || !("metricId" in entry) || !("windowDays" in entry) || typeof entry.metricId !== "string" || typeof entry.windowDays !== "number") {
      throw new HexclaveAssertionError("GrowthActionItem.watchedMetrics entry has an unexpected shape", { entry });
    }
    return { metricId: assertGrowthMetricId(entry.metricId), windowDays: entry.windowDays };
  });
}

const ROLLUP_DATE_MAX_AGE_DAYS = 3;

/**
 * The rollup accepts only fully-elapsed recent UTC days: [today - 3d, yesterday]. Today would roll
 * up a partial day, and anything older than the workflow's realistic retry horizon is refused so a
 * misconfigured (or hostile) caller cannot backfill briefs for arbitrary history.
 */
export function isGrowthRollupDateWithinWindow(dateString: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const parsedMs = Date.parse(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(parsedMs)) return false;
  // Round-trip check rejects non-canonical inputs like "2026-02-30" (which Date.parse rolls over).
  if (new Date(parsedMs).toISOString().slice(0, 10) !== dateString) return false;
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayMs = 24 * 60 * 60_000;
  return parsedMs >= todayMs - ROLLUP_DATE_MAX_AGE_DAYS * dayMs && parsedMs <= todayMs - dayMs;
}

/**
 * The daily rollup for one branch and one UTC day: upsert the day's metrics, create the day's brief
 * (the unique on (projectId, branchId, date) is the day's idempotency lock), and — only on winning
 * the brief claim — snapshot active action items' watched metrics. Dispatching the brief to Eve is
 * a separate step (dispatchGrowthBrief) so the workflow owns the retry policy for it.
 */
export async function runGrowthDailyRollupForDate(options: { tenancy: Tenancy, date: string }): Promise<{ briefId: string, briefStatus: string, created: boolean }> {
  const projectId = options.tenancy.project.id;
  const branchId = options.tenancy.branchId;
  if (!isGrowthRollupDateWithinWindow(options.date, new Date())) {
    throw new StatusError(400, `Invalid rollup date: must be a UTC day between ${ROLLUP_DATE_MAX_AGE_DAYS} days ago and yesterday, formatted as YYYY-MM-DD.`);
  }
  // GrowthBrief.date / GrowthDailyMetrics.date are `@db.Date` columns; midnight-UTC Dates are the
  // canonical Prisma representation for them.
  const date = new Date(`${options.date}T00:00:00.000Z`);
  const now = new Date();

  const existingBrief = await globalPrismaClient.growthBrief.findUnique({
    where: { projectId_branchId_date: { projectId, branchId, date } },
    select: { id: true, status: true },
  });
  if (existingBrief != null) {
    return { briefId: existingBrief.id, briefStatus: existingBrief.status, created: false };
  }

  // ONE bundle load feeds both the legacy 6-metric Postgres record and the wide ClickHouse rows,
  // so the two stores can never disagree about the same instant.
  const bundle = await loadGrowthMetricBundle(options.tenancy, now);
  const metrics = computeGrowthMetricsFromBundle(bundle);

  // A ClickHouse failure here THROWS on purpose: the wide rows are the agent's primary metric
  // store, so a day that silently skipped them would be a silent data gap. Throwing is safe because
  // nothing has been claimed yet — the GrowthBrief unique-constraint claim happens further down, so
  // the day is not consumed and the workflow retry (plus the watchdog's missed-brief catch-up)
  // re-runs this whole function idempotently.
  await insertGrowthDailyMetricRows(buildGrowthMetricRows(bundle, options.date));

  await globalPrismaClient.growthDailyMetrics.upsert({
    where: { projectId_branchId_date: { projectId, branchId, date } },
    create: { projectId, branchId, date, metrics },
    update: { metrics },
  });

  let brief;
  try {
    brief = await globalPrismaClient.growthBrief.create({
      data: { projectId, branchId, date, status: "generating", summary: "", contentMd: "" },
      select: { id: true, status: true },
    });
  } catch (error) {
    // The unique on (projectId, branchId, date) doubles as the day's idempotency lock — a
    // violation means a concurrent caller claimed the day between our check and our insert.
    if (isPrismaUniqueConstraintViolation(error, "GrowthBrief", ["projectId", "branchId", "date"])) {
      const concurrentBrief = await globalPrismaClient.growthBrief.findUnique({
        where: { projectId_branchId_date: { projectId, branchId, date } },
        select: { id: true, status: true },
      }) ?? throwErr(new HexclaveAssertionError("GrowthBrief vanished right after its unique-violation was observed — briefs are never deleted outside project deletion, so this should be impossible.", { projectId, branchId, date: options.date }));
      return { briefId: concurrentBrief.id, briefStatus: concurrentBrief.status, created: false };
    }
    throw error;
  }

  // Winning the brief claim above makes us the sole writer for this (branch, day), so these
  // "after" snapshots cannot be duplicated by a concurrent caller.
  const activeActionItems = await globalPrismaClient.growthActionItem.findMany({
    where: { projectId, branchId, status: "active" },
    select: { id: true, watchedMetrics: true },
  });
  for (const item of activeActionItems) {
    const watched = parseWatchedMetrics(item.watchedMetrics);
    const snapshotMetrics = Object.fromEntries(watched.map((entry) => [entry.metricId, metrics[entry.metricId]]));
    await globalPrismaClient.growthMetricSnapshot.create({
      data: { actionItemId: item.id, phase: "after", capturedAt: now, metrics: snapshotMetrics },
    });
  }

  return { briefId: brief.id, briefStatus: brief.status, created: true };
}

type BriefScope = {
  projectId: string,
  branchId: string,
  briefId: string,
};

async function findBriefOrThrow(scope: BriefScope) {
  return await globalPrismaClient.growthBrief.findFirst({
    where: { id: scope.briefId, projectId: scope.projectId, branchId: scope.branchId },
  }) ?? throwErr(new StatusError(404, "Brief not found."));
}

/**
 * Asks Eve to generate the brief's content. Only a "generating" brief is dispatched; any other
 * status returns as-is so repeated calls are no-ops. Unlike phase dispatch there is no attempt
 * budget here — the workflow decides whether to retry or skip (via skipGrowthBrief) on 502.
 */
export async function dispatchGrowthBrief(scope: BriefScope): Promise<{ briefStatus: string }> {
  const brief = await findBriefOrThrow(scope);
  if (brief.status !== "generating") {
    return { briefStatus: brief.status };
  }
  try {
    // Same rules as the phase dispatch above: the token goes in the BODY (the hop is separately
    // authenticated by the shared secret), and it is minted here rather than inside postToEve because
    // only this function knows the anchor the session is allowed to speak for. A brief token's live
    // check is `GrowthBrief.status === "generating"`, which the guard above has just established.
    const tenancy = await getSoleTenancyFromProjectBranch(scope.projectId, scope.branchId);
    const agentToken = await createGrowthRunToken({
      projectId: scope.projectId,
      branchId: scope.branchId,
      tenancyId: tenancy.id,
      session: { sessionKind: "daily_brief", briefId: brief.id },
    });
    await postToEve("/runs/daily-brief", {
      project_id: scope.projectId,
      branch_id: scope.branchId,
      brief_id: brief.id,
      date: brief.date.toISOString().slice(0, 10),
      agent_token: agentToken,
    });
  } catch (error) {
    captureError("growth-orchestration", new HexclaveAssertionError(`Failed to dispatch growth daily brief ${brief.id} to Eve`, { cause: error, briefId: brief.id, projectId: scope.projectId, branchId: scope.branchId }));
    throw new StatusError(502, BRIEF_UNDISPATCHABLE_ERROR_MESSAGE);
  }
  return { briefStatus: brief.status };
}

/**
 * Long-poll: resolves once the brief leaves "generating" (the agent upserted content → "ready", or
 * something marked it skipped/failed), or the timeout elapses. Returns the latest status either way.
 */
export async function waitForGrowthBriefStatusChange(options: BriefScope & { timeoutMs: number, pollIntervalMs?: number }): Promise<{ briefStatus: string }> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const startMs = performance.now();
  while (true) {
    const brief = await findBriefOrThrow(options);
    if (brief.status !== "generating") return { briefStatus: brief.status };
    const elapsedMs = performance.now() - startMs;
    if (elapsedMs >= options.timeoutMs) return { briefStatus: brief.status };
    await wait(Math.min(pollIntervalMs, options.timeoutMs - elapsedMs));
  }
}

/**
 * Gives up on a brief that never got content (e.g. Eve was unreachable, or the wait timed out for
 * good). CAS generating → skipped: if the agent's "ready" write raced us and won, the skip is a
 * no-op and the brief stays readable.
 */
export async function skipGrowthBrief(scope: BriefScope): Promise<{ briefStatus: string }> {
  await findBriefOrThrow(scope);
  await globalPrismaClient.growthBrief.updateMany({
    where: { id: scope.briefId, projectId: scope.projectId, branchId: scope.branchId, status: "generating" },
    data: { status: "skipped" },
  });
  const brief = await findBriefOrThrow(scope);
  return { briefStatus: brief.status };
}

/**
 * Creates a GrowthDelivery row (and invokes the channel) for every registered channel this "ready"
 * brief is missing one for. The unique on (briefId, channel) makes row creation the claim, so a
 * channel with real side effects (email, ...) can never double-send — hostile repetition included.
 */
export async function wireGrowthBriefDeliveries(options: { tenancy: Tenancy, briefId: string }): Promise<{ deliveries: { channel: string, status: string }[] }> {
  const scope = { projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, briefId: options.briefId };
  const brief = await findBriefOrThrow(scope);
  if (brief.status !== "ready") {
    throw new StatusError(400, "The brief is not ready for delivery.");
  }
  const existingDeliveries = await globalPrismaClient.growthDelivery.findMany({
    where: { briefId: brief.id },
    select: { channel: true },
  });
  const now = new Date();
  for (const channelId of selectMissingGrowthDeliveryChannelIds(existingDeliveries.map((delivery) => delivery.channel))) {
    const channel = GROWTH_DELIVERY_CHANNELS.get(channelId)
      ?? throwErr(new HexclaveAssertionError("selectMissingGrowthDeliveryChannelIds returned a channel id not present in the registry — this should be impossible.", { channelId }));
    let delivery;
    try {
      delivery = await globalPrismaClient.growthDelivery.create({
        data: { briefId: brief.id, channel: channelId },
        select: { id: true },
      });
    } catch (error) {
      if (isPrismaUniqueConstraintViolation(error, "GrowthDelivery", ["briefId", "channel"])) continue;
      throw error;
    }
    try {
      await channel.deliver({ brief, tenancy: options.tenancy });
      await globalPrismaClient.growthDelivery.update({
        where: { id: delivery.id },
        data: { status: "delivered", deliveredAt: now },
      });
    } catch (error) {
      // "failed" is terminal for this (brief, channel) — the row exists, so no caller retries it.
      // Retry semantics can be added per-channel later; for now a failed push is logged loudly
      // and the brief stays readable in the dashboard regardless.
      await globalPrismaClient.growthDelivery.update({
        where: { id: delivery.id },
        data: { status: "failed" },
      });
      captureError("growth-orchestration", new HexclaveAssertionError(`Growth brief delivery via channel ${channelId} failed for brief ${brief.id}`, { cause: error, briefId: brief.id, channelId }));
    }
  }
  const finalDeliveries = await globalPrismaClient.growthDelivery.findMany({
    where: { briefId: brief.id },
    orderBy: { createdAt: "asc" },
    select: { channel: true, status: true },
  });
  return { deliveries: finalDeliveries.map((delivery) => ({ channel: delivery.channel, status: delivery.status })) };
}

// ── Milestones ───────────────────────────────────────────────────────────────

/**
 * Evaluates this branch's armed milestones against the latest daily rollup. Bumping
 * lastEvaluatedAt is also the CAS claim (≤ 1 evaluation per milestone per hour, even under
 * concurrent callers), and values come exclusively from stored GrowthDailyMetrics — never computed
 * live — so milestone latency is deliberately as coarse as the rollup cadence.
 */
export async function evaluateGrowthMilestones(options: { tenancyId: string, projectId: string, branchId: string }): Promise<{ evaluated: number, crossed: { milestoneId: string, runId: string | null }[] }> {
  const now = new Date();
  const candidates = await globalPrismaClient.growthMilestone.findMany({
    where: {
      projectId: options.projectId,
      branchId: options.branchId,
      status: "armed",
      OR: [
        { lastEvaluatedAt: null },
        { lastEvaluatedAt: { lte: new Date(now.getTime() - GROWTH_MILESTONE_EVALUATION_INTERVAL_MS) } },
      ],
    },
  });
  let evaluated = 0;
  const crossed: { milestoneId: string, runId: string | null }[] = [];
  for (const milestone of candidates) {
    try {
      const claimed = await globalPrismaClient.growthMilestone.updateMany({
        where: { id: milestone.id, status: "armed", lastEvaluatedAt: milestone.lastEvaluatedAt },
        data: { lastEvaluatedAt: now },
      });
      if (claimed.count === 0) continue;
      evaluated++;

      const latestRollup = await globalPrismaClient.growthDailyMetrics.findFirst({
        where: { projectId: milestone.projectId, branchId: milestone.branchId },
        orderBy: { date: "desc" },
      });
      // No rollup yet: don't compute metrics live — the daily rollup lands within a day and
      // milestone latency is allowed to be that coarse.
      if (latestRollup == null) continue;
      const metricsJson = latestRollup.metrics;
      if (typeof metricsJson !== "object" || metricsJson == null || Array.isArray(metricsJson)) {
        throw new HexclaveAssertionError("GrowthDailyMetrics.metrics is not an object", { latestRollupId: latestRollup.id });
      }
      const metricId = assertGrowthMetricId(milestone.metricId);
      const value = (metricsJson as Record<string, unknown>)[metricId]; // Json object narrowing — validated to a plain object above, and the value's type is checked right below
      if (typeof value !== "number") {
        throw new HexclaveAssertionError(`GrowthDailyMetrics.metrics is missing a numeric value for metric ${metricId} — the rollup always writes all registry metrics, so this should be impossible.`, { latestRollupId: latestRollup.id, metricId });
      }
      if (milestone.comparator !== "gte") {
        throw new HexclaveAssertionError(`Unknown growth milestone comparator "${milestone.comparator}" — only "gte" exists in v1 and writes are validated, so this should be impossible.`, { milestoneId: milestone.id });
      }
      if (value < milestone.threshold) continue;

      const event = await retryTransaction(globalPrismaClient, async (tx) => {
        const createdEvent = await tx.growthMilestoneEvent.create({
          data: { milestoneId: milestone.id, metricValue: value, reachedAt: now },
        });
        await tx.growthMilestone.update({
          where: { id: milestone.id },
          data: { status: "reached" },
        });
        return createdEvent;
      });
      let crossedRunId: string | null = null;
      try {
        const { runId } = await createGrowthAnalysisRun({
          tenancyId: options.tenancyId,
          projectId: milestone.projectId,
          branchId: milestone.branchId,
          trigger: "milestone",
          milestoneEventId: event.id,
        });
        await globalPrismaClient.growthMilestoneEvent.update({ where: { id: event.id }, data: { analysisRunId: runId } });
        crossedRunId = runId;
      } catch (error) {
        // Another run is already active — the milestone event stands as history with a null
        // analysisRunId; the active run's report will cover the same ground anyway.
        if (!(StatusError.isStatusError(error) && error.statusCode === 409)) throw error;
      }
      crossed.push({ milestoneId: milestone.id, runId: crossedRunId });
    } catch (error) {
      // One broken milestone must not block the rest of the branch's evaluations; the claim above
      // already consumed this milestone's hourly slot, so this cannot hot-loop.
      captureError("growth-orchestration", new HexclaveAssertionError(`Growth milestone evaluation failed for milestone ${milestone.id}`, { cause: error, milestoneId: milestone.id }));
    }
  }
  return { evaluated, crossed };
}
