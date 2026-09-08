import { Prisma } from "@/generated/prisma/client";
import { GrowthPhaseStatus, GrowthRunStatus, WorkflowRunState } from "@/generated/prisma/enums";
import type { Tenancy } from "@/lib/tenancies";
import { cancelWorkflowRuns } from "@/lib/workflows/engine";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { GROWTH_METRIC_CATALOG } from "./metric-catalog";
import { seedDefaultGrowthMilestones } from "./milestones";
import { isGrowthInterviewReleased } from "./interview-release";
import { growthPhaseStatusToStepState } from "./phase-step-state";
import { getGrowthReleaseState } from "./report-release";
import { RELEASED_GROWTH_REPORT_FILTER } from "./report-visibility";
import {
  assertTriggerIsValid,
  getGrowthPhaseDescription,
  getGrowthPhaseDisplayIndex,
  getGrowthPhaseLabel,
  getInitialPhaseKeysForRun,
  GROWTH_COMPUTE_METRICS_PHASE_KEY,
  GROWTH_INTEGRATIONS_PHASE_KEY,
  GROWTH_REPORT_PHASE_KEY,
  GROWTH_ACTIVE_RUN_STATUSES,
  type GrowthRunTrigger,
} from "./phases";
import { GROWTH_ANALYSIS_WORKFLOW_ID } from "./workflow-sources";
import { ensureGrowthWorkflows, getGrowthAnalysisLegRunKeys, getGrowthWorkflowStates, GROWTH_EVENT_TYPES } from "./workflows";

// Shown while the question plan hasn't been generated yet; the copy around it always says "about".
const DEFAULT_ESTIMATED_INTERVIEW_QUESTIONS = 8;

export function requireGrowthAppEnabled(tenancy: Tenancy): void {
  if (tenancy.config.apps.installed["gtm"]?.enabled !== true) {
    throw new StatusError(400, "The Growth app is not enabled for this project.");
  }
}

function runStatusToWire(status: GrowthRunStatus): string {
  return status.toLowerCase();
}

/**
 * The metric labels the dashboard shows under the "Computing metrics" block while the phase runs.
 * Derived from the catalog (never hardcoded) so the sub-list always reflects what the rollup
 * actually computes: the stored (materialized) entries, minus ads — ad metrics live in the separate
 * ad-metrics writer, not the compute-metrics rollup, so listing them here would be a lie.
 */
const COMPUTE_METRICS_DISPLAY_LABELS = GROWTH_METRIC_CATALOG
  .filter((metric) => metric.availability === "stored" && metric.category !== "ads")
  .map((metric) => metric.label);

export async function getGrowthStatusBody(tenancy: Tenancy) {
  const projectId = tenancy.project.id;
  const branchId = tenancy.branchId;

  const [onboarding, latestRun, latestReport, latestBrief, proposedActionCount, activeActionCount] = await Promise.all([
    globalPrismaClient.growthOnboarding.findUnique({ where: { projectId_branchId: { projectId, branchId } } }),
    globalPrismaClient.growthAnalysisRun.findFirst({
      where: { projectId, branchId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        phases: { orderBy: { createdAt: "asc" } },
        interview: { include: { questions: { select: { answeredAt: true } } } },
      },
    }),
    // Released only: a GrowthReport row exists from the moment the report phase finishes, but the
    // customer must not learn of it until staff release it. This one filter is what holds the whole
    // workspace back. Requiring the staff publisher also keeps reports auto-published by older
    // builds behind the new review gate.
    globalPrismaClient.growthReport.findFirst({
      where: { projectId, branchId, ...RELEASED_GROWTH_REPORT_FILTER },
      // Ordered by createdAt, NOT publishedAt, so this agrees with getGrowthReportBody's "latest".
      // The two would only diverge if staff published an older report after a newer one, but they
      // feed the same screen — the timeline reads this, the report page reads that — and a
      // disagreement there means a "Read the report" link opening a different report than the one
      // it just described. createdAt is also the date the UI puts on the report.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { run: { select: { trigger: true } } },
    }),
    // Only "ready" briefs count: a just-claimed "generating" row must not flip the dashboard into its
    // steady state before there is anything to read.
    globalPrismaClient.growthBrief.findFirst({
      where: { projectId, branchId, status: "ready" },
      orderBy: [{ date: "desc" }],
    }),
    globalPrismaClient.growthActionItem.count({ where: { projectId, branchId, status: "proposed" } }),
    globalPrismaClient.growthActionItem.count({ where: { projectId, branchId, status: "active" } }),
  ]);

  // A cancelled run is treated like no run at all: the user (or an operator) abandoned it, so the
  // dashboard should offer a fresh start instead of a stuck lifecycle.
  const run = latestRun == null || latestRun.status === GrowthRunStatus.CANCELLED ? null : latestRun;

  const analysisState = run == null
    ? "none"
    : run.status === GrowthRunStatus.FAILED
      ? "failed"
      : run.status === GrowthRunStatus.PENDING || run.status === GrowthRunStatus.RUNNING
        ? "running"
        : "completed";

  const steps = run == null ? null : run.phases
    .filter((phase) => phase.phaseKey !== GROWTH_REPORT_PHASE_KEY && phase.phaseKey !== GROWTH_COMPUTE_METRICS_PHASE_KEY && phase.phaseKey !== GROWTH_INTEGRATIONS_PHASE_KEY)
    .sort((a, b) => getGrowthPhaseDisplayIndex(a.phaseKey) - getGrowthPhaseDisplayIndex(b.phaseKey))
    .map((phase) => ({
      id: phase.phaseKey,
      label: getGrowthPhaseLabel(phase.phaseKey),
      description: getGrowthPhaseDescription(phase.phaseKey),
      state: growthPhaseStatusToStepState(phase.status),
    }));

  const computeMetricsPhase = run?.phases.find((phase) => phase.phaseKey === GROWTH_COMPUTE_METRICS_PHASE_KEY) ?? null;
  const computeMetrics = computeMetricsPhase == null ? null : {
    state: growthPhaseStatusToStepState(computeMetricsPhase.status),
    metric_labels: COMPUTE_METRICS_DISPLAY_LABELS,
  };
  const integrationsPhase = run?.phases.find((phase) => phase.phaseKey === GROWTH_INTEGRATIONS_PHASE_KEY) ?? null;
  let integrations = null;
  if (integrationsPhase != null) {
    const computeMetricsSettled = computeMetricsPhase != null
      && (computeMetricsPhase.status === GrowthPhaseStatus.COMPLETED || computeMetricsPhase.status === GrowthPhaseStatus.SKIPPED);
    // "pending" = upcoming (metrics not settled yet), "waiting" = actively awaiting the human.
    const state = integrationsPhase.status === GrowthPhaseStatus.COMPLETED
      ? "connected"
      : integrationsPhase.status === GrowthPhaseStatus.SKIPPED
        ? "skipped"
        : integrationsPhase.status === GrowthPhaseStatus.PENDING
          ? (computeMetricsSettled ? "waiting" : "pending")
          : throwErr(new HexclaveAssertionError(`Growth integrations phase of run ${run?.id} is in status ${integrationsPhase.status} — the phase is never dispatched, so only PENDING/COMPLETED/SKIPPED should be possible.`, { runId: run?.id, status: integrationsPhase.status }));
    integrations = { state, connection_ready: false };
  }

  const interview = run?.interview ?? null;
  const answeredCount = interview == null ? 0 : interview.questions.filter((question) => question.answeredAt != null).length;
  const interviewState = run == null || analysisState === "running" || analysisState === "failed" || interview == null
    ? "not_ready"
    : interview.status === "completed" || interview.status === "skipped"
      ? "completed"
      : !isGrowthInterviewReleased(interview)
        ? "preparing"
        : answeredCount > 0
          ? "in_progress"
          : "ready";

  const releaseState = getGrowthReleaseState({
    released: latestReport != null,
    deepAnalysisStarted: steps?.some((step) => step.state === "running" || step.state === "done") ?? false,
    analysisFailed: analysisState === "failed",
  });

  const workflowStates = await getGrowthWorkflowStates(tenancy);
  const orchestrationWorkflows = [];
  for (const workflowState of workflowStates) {
    const activeWorkflowRun = workflowState.workflowId === GROWTH_ANALYSIS_WORKFLOW_ID && run != null
      ? await globalPrismaClient.workflowRun.findFirst({
        where: {
          tenancyId: tenancy.id,
          workflowId: workflowState.workflowId,
          runKey: { in: getGrowthAnalysisLegRunKeys(run.id) },
          state: { in: [WorkflowRunState.QUEUED, WorkflowRunState.RUNNING, WorkflowRunState.SLEEPING] },
        },
        select: { state: true },
      })
      : null;
    const lastFailedRun = await globalPrismaClient.workflowRun.findFirst({
      where: { tenancyId: tenancy.id, workflowId: workflowState.workflowId, state: WorkflowRunState.FAILED },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { errorSummary: true },
    });
    orchestrationWorkflows.push({
      workflow_id: workflowState.workflowId,
      exists: workflowState.exists,
      edited: workflowState.edited,
      active_workflow_run_state: activeWorkflowRun == null ? null : activeWorkflowRun.state.toLowerCase(),
      last_failed_run_summary: lastFailedRun == null ? null : lastFailedRun.errorSummary,
    });
  }

  return {
    onboarding: {
      completed: onboarding != null,
      completed_at_millis: onboarding == null ? null : onboarding.completedAt.getTime(),
      website_url: onboarding == null ? null : onboarding.websiteUrl,
    },
    analysis: {
      state: analysisState,
      run_id: run == null ? null : run.id,
      trigger: run == null ? null : assertTriggerIsValid(run.trigger),
      started_at_millis: run == null ? null : run.createdAt.getTime(),
      completed_at_millis: run?.completedAt == null ? null : run.completedAt.getTime(),
      steps,
      compute_metrics: computeMetrics,
      integrations,
      error_message: run == null ? null : run.errorMessage,
    },
    interview: {
      state: interviewState,
      answered_count: answeredCount,
      estimated_total: interview == null || interview.questions.length === 0 ? DEFAULT_ESTIMATED_INTERVIEW_QUESTIONS : interview.questions.length,
    },
    latest_report: latestReport == null ? null : {
      id: latestReport.id,
      created_at_millis: latestReport.createdAt.getTime(),
      read_at_millis: latestReport.readAt == null ? null : latestReport.readAt.getTime(),
      trigger: assertTriggerIsValid(latestReport.run.trigger),
      milestone_label: null,
    },
    latest_brief: latestBrief == null || releaseState !== "released" ? null : {
      id: latestBrief.id,
      date: latestBrief.date.toISOString().slice(0, 10),
      created_at_millis: latestBrief.createdAt.getTime(),
    },
    counts: {
      suggested_actions: proposedActionCount,
      active_actions: activeActionCount,
      enabled_tasks: 0,
    },
    orchestration: {
      workflows: orchestrationWorkflows,
    },
    release: {
      state: releaseState,
    },
  };
}

export async function createGrowthAnalysisRun(options: {
  tenancyId: string,
  projectId: string,
  branchId: string,
  trigger: GrowthRunTrigger,
  milestoneEventId?: string,
}): Promise<{ runId: string }> {
  try {
    return await retryTransaction(globalPrismaClient, async (tx) => {
      const run = await tx.growthAnalysisRun.create({
        data: {
          projectId: options.projectId,
          branchId: options.branchId,
          trigger: options.trigger,
          milestoneEventId: options.milestoneEventId,
          phases: {
            create: getInitialPhaseKeysForRun().map((phaseKey) => ({ phaseKey })),
          },
        },
        select: { id: true },
      });
      await enqueueWorkflowEvent(tx, {
        tenancy: { id: options.tenancyId },
        type: GROWTH_EVENT_TYPES.analysisRunActivated,
        payload: { growth_run_id: run.id, trigger: options.trigger },
      });
      return { runId: run.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new StatusError(409, "An analysis run is already in progress for this project.");
    }
    throw error;
  }
}

export async function completeGrowthOnboardingAndStartRun(options: {
  tenancy: Tenancy,
  websiteUrl: string,
  companySummary: string | null,
  additionalNotes: string | null,
}): Promise<{ runId: string }> {
  try {
    await ensureGrowthWorkflows(options.tenancy);
  } catch (error) {
    captureError("growth-workflow-seeding", new HexclaveAssertionError(`Failed to seed growth workflows during onboarding for project ${options.tenancy.project.id} branch ${options.tenancy.branchId}`, { cause: error, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId }));
  }
  try {
    await retryTransaction(globalPrismaClient, async (tx) => {
      await tx.growthOnboarding.create({
        data: {
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
          websiteUrl: options.websiteUrl,
          companySummary: options.companySummary,
          additionalNotes: options.additionalNotes,
        },
      });
      await seedDefaultGrowthMilestones(tx, { projectId: options.tenancy.project.id, branchId: options.tenancy.branchId });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new StatusError(400, "Growth onboarding has already been completed for this project.");
    }
    throw error;
  }
  return await createGrowthAnalysisRun({ tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, trigger: "initial" });
}

export async function restartGrowthOnboarding(options: { tenancy: Tenancy }): Promise<{ cancelledRunIds: string[] }> {
  const projectId = options.tenancy.project.id;
  const branchId = options.tenancy.branchId;
  const onboarding = await globalPrismaClient.growthOnboarding.findUnique({
    where: { projectId_branchId: { projectId, branchId } },
    select: { id: true },
  });
  if (onboarding == null) {
    throw new StatusError(400, "Growth onboarding has not been completed for this project.");
  }

  const cancelledRunIds = await retryTransaction(globalPrismaClient, async (tx) => {
    const claim = await tx.growthOnboarding.updateMany({
      where: { id: onboarding.id },
      data: { updatedAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new StatusError(409, "Growth onboarding restart conflicted with another restart. Try again.");
    }

    const cancelledRuns = await tx.growthAnalysisRun.updateManyAndReturn({
      where: { projectId, branchId, status: { in: [...GROWTH_ACTIVE_RUN_STATUSES] } },
      data: { status: GrowthRunStatus.CANCELLED, completedAt: new Date() },
      select: { id: true },
    });
    for (const { id: runId } of cancelledRuns) {
      for (const type of [GROWTH_EVENT_TYPES.analysisRunActivated, GROWTH_EVENT_TYPES.interviewFinished]) {
        await tx.workflowEvent.updateMany({
          where: {
            tenancyId: options.tenancy.id,
            type,
            processedAt: null,
            payload: { path: ["growth_run_id"], equals: runId },
          },
          data: { processedAt: new Date() },
        });
      }
    }
    await tx.growthOnboarding.deleteMany({ where: { id: onboarding.id } });
    return cancelledRuns.map((run) => run.id);
  });
  for (const runId of cancelledRunIds) {
    for (const runKey of getGrowthAnalysisLegRunKeys(runId)) {
      try {
        await cancelWorkflowRuns(options.tenancy, { workflowId: GROWTH_ANALYSIS_WORKFLOW_ID, runKey });
      } catch (error) {
        captureError("growth-onboarding-restart", new HexclaveAssertionError(`Failed to cancel growth analysis workflow leg "${runKey}" of run ${runId} after restarting onboarding for project ${projectId} branch ${branchId}`, { cause: error, projectId, branchId, runId, runKey }));
      }
    }
  }

  return { cancelledRunIds };
}

export async function startGrowthManualRun(options: { tenancy: Tenancy }): Promise<{ runId: string }> {
  const onboarding = await globalPrismaClient.growthOnboarding.findUnique({
    where: { projectId_branchId: { projectId: options.tenancy.project.id, branchId: options.tenancy.branchId } },
    select: { id: true },
  });
  if (onboarding == null) {
    throw new StatusError(400, "Complete growth onboarding before starting an analysis run.");
  }
  return await createGrowthAnalysisRun({ tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, trigger: "manual" });
}

export async function retryGrowthAnalysis(options: { tenancy: Tenancy }): Promise<{ runId: string }> {
  const latestRun = await globalPrismaClient.growthAnalysisRun.findFirst({
    where: { projectId: options.tenancy.project.id, branchId: options.tenancy.branchId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, trigger: true },
  });
  if (latestRun == null || latestRun.status !== GrowthRunStatus.FAILED) {
    throw new StatusError(400, "There is no failed analysis run to retry.");
  }
  try {
    await retryTransaction(globalPrismaClient, async (tx) => {
      const revived = await tx.growthAnalysisRun.updateMany({
        where: { id: latestRun.id, status: GrowthRunStatus.FAILED },
        data: { status: GrowthRunStatus.PENDING, errorMessage: null },
      });
      if (revived.count !== 1) {
        throw new StatusError(409, "This analysis run is already being retried.");
      }

      const failedPhases = await tx.growthAnalysisPhase.findMany({
        where: { runId: latestRun.id, status: GrowthPhaseStatus.FAILED },
        select: { id: true, phaseKey: true },
      });
      if (failedPhases.length > 0) {
        await tx.growthAnalysisPhase.deleteMany({
          where: { id: { in: failedPhases.map((phase) => phase.id) }, status: GrowthPhaseStatus.FAILED },
        });
        await tx.growthAnalysisPhase.createMany({
          data: failedPhases.map((phase) => ({ runId: latestRun.id, phaseKey: phase.phaseKey })),
        });
      }
      await enqueueWorkflowEvent(tx, {
        tenancy: { id: options.tenancy.id },
        type: GROWTH_EVENT_TYPES.analysisRunActivated,
        payload: { growth_run_id: latestRun.id, trigger: assertTriggerIsValid(latestRun.trigger) },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new StatusError(409, "Another analysis run is already in progress for this project.");
    }
    throw error;
  }
  return { runId: latestRun.id };
}

export async function resolveGrowthRunIntegrations(options: {
  tenancy: Tenancy,
  runId: string,
  action: "skip" | "continue",
}) {
  const projectId = options.tenancy.project.id;
  const branchId = options.tenancy.branchId;
  const run = await globalPrismaClient.growthAnalysisRun.findFirst({
    where: { id: options.runId, projectId, branchId },
    include: { phases: { where: { phaseKey: GROWTH_INTEGRATIONS_PHASE_KEY }, select: { id: true, status: true } } },
  });
  if (run == null) {
    throw new StatusError(404, "Analysis run not found.");
  }
  const integrationsPhase = run.phases.at(0) ?? null;
  if (integrationsPhase == null) {
    // Runs created before the integrations phase existed never ask the question.
    throw new StatusError(400, "This analysis run has no integrations step.");
  }
  await retryTransaction(globalPrismaClient, async (tx) => {
    const settled = await tx.growthAnalysisPhase.updateMany({
      where: { id: integrationsPhase.id, status: GrowthPhaseStatus.PENDING },
      data: {
        status: options.action === "skip" ? GrowthPhaseStatus.SKIPPED : GrowthPhaseStatus.COMPLETED,
        finishedAt: new Date(),
      },
    });
    if (settled.count === 0) {
      throw new StatusError(409, "The integrations step has already been answered.");
    }
    await enqueueWorkflowEvent(tx, {
      tenancy: { id: options.tenancy.id },
      type: GROWTH_EVENT_TYPES.analysisRunActivated,
      payload: { growth_run_id: run.id, trigger: assertTriggerIsValid(run.trigger) },
    });
  });
  return await getGrowthRunBody({ projectId, branchId, runId: options.runId });
}

export async function getGrowthRunBody(options: { projectId: string, branchId: string, runId: string }) {
  const run = await globalPrismaClient.growthAnalysisRun.findFirst({
    where: { id: options.runId, projectId: options.projectId, branchId: options.branchId },
    include: { phases: { orderBy: { createdAt: "asc" } } },
  });
  if (run == null) {
    throw new StatusError(404, "Analysis run not found.");
  }
  return {
    id: run.id,
    status: runStatusToWire(run.status),
    trigger: assertTriggerIsValid(run.trigger),
    created_at_millis: run.createdAt.getTime(),
    completed_at_millis: run.completedAt == null ? null : run.completedAt.getTime(),
    error_message: run.errorMessage,
    phases: run.phases.map((phase) => ({
      phase_key: phase.phaseKey,
      status: phase.status.toLowerCase(),
      attempt: phase.attempt,
      started_at_millis: phase.startedAt == null ? null : phase.startedAt.getTime(),
      finished_at_millis: phase.finishedAt == null ? null : phase.finishedAt.getTime(),
      error_message: phase.errorMessage,
    })),
  };
}
