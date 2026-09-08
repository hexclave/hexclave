import { GrowthPhaseStatus, GrowthRunStatus } from "@/generated/prisma/enums";
import type { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { repairGrowthProject, type GrowthRepairResult } from "./admin-recovery";
import { retryGrowthAnalysis, startGrowthManualRun } from "./dashboard";
import {
  GROWTH_COMPUTE_METRICS_PHASE_KEY,
  GROWTH_FIXED_PRE_INTERVIEW_PHASE_KEYS,
  GROWTH_INTEGRATIONS_PHASE_KEY,
  GROWTH_INTERVIEW_QUESTIONS_PHASE_KEY,
  GROWTH_REPORT_PHASE_KEY,
  isGrowthAnalysisTopicPhaseKey,
} from "./phases";

export const GROWTH_ADMIN_STAGE_IDS = ["set-up", "compute-metrics", "integrations", "analysis", "interview", "report"] as const;
export type GrowthAdminStageId = typeof GROWTH_ADMIN_STAGE_IDS[number];

export const GROWTH_ADMIN_STAGE_RUN_STATES = ["ready", "running", "complete", "blocked", "failed"] as const;
export type GrowthAdminStageRunStateName = typeof GROWTH_ADMIN_STAGE_RUN_STATES[number];

export type GrowthAdminStageRunState = {
  readonly stage: GrowthAdminStageId,
  readonly state: GrowthAdminStageRunStateName,
  readonly canRun: boolean,
  readonly message: string,
};

type StagePhase = {
  readonly phaseKey: string,
  readonly status: GrowthPhaseStatus,
};

export type GrowthAdminStageRunSnapshot = {
  readonly run: null | {
    readonly status: GrowthRunStatus,
    readonly phases: readonly StagePhase[],
    readonly interviewStatus: string | null,
  },
};

type PhaseGroupState = "ready" | "running" | "complete" | "failed";

function phaseGroupState(phases: readonly StagePhase[], matches: (phaseKey: string) => boolean): PhaseGroupState {
  const matching = phases.filter((phase) => matches(phase.phaseKey));
  // Old in-flight runs can predate newly introduced phases. Missing phases are treated as already
  // settled, matching orchestration.ts's vacuous-truth compatibility rule, so an admin action never
  // strands a run that the pipeline itself is willing to advance.
  if (matching.length === 0) return "complete";
  if (matching.some((phase) => phase.status === GrowthPhaseStatus.FAILED)) return "failed";
  if (matching.some((phase) => phase.status === GrowthPhaseStatus.DISPATCHED || phase.status === GrowthPhaseStatus.RUNNING)) return "running";
  if (matching.every((phase) => phase.status === GrowthPhaseStatus.COMPLETED || phase.status === GrowthPhaseStatus.SKIPPED)) return "complete";
  return "ready";
}

function state(stage: GrowthAdminStageId, value: GrowthAdminStageRunStateName, message: string): GrowthAdminStageRunState {
  return { stage, state: value, canRun: value === "ready" || value === "failed", message };
}

function metricsState(snapshot: GrowthAdminStageRunSnapshot): PhaseGroupState | "not-started" {
  if (snapshot.run == null) return "not-started";
  return phaseGroupState(snapshot.run.phases, (phaseKey) => phaseKey === GROWTH_COMPUTE_METRICS_PHASE_KEY);
}

function integrationsState(snapshot: GrowthAdminStageRunSnapshot): PhaseGroupState | "not-started" {
  if (snapshot.run == null) return "not-started";
  return phaseGroupState(snapshot.run.phases, (phaseKey) => phaseKey === GROWTH_INTEGRATIONS_PHASE_KEY);
}

function analysisState(snapshot: GrowthAdminStageRunSnapshot): PhaseGroupState | "not-started" {
  if (snapshot.run == null) return "not-started";
  return phaseGroupState(snapshot.run.phases, (phaseKey) => GROWTH_FIXED_PRE_INTERVIEW_PHASE_KEYS.some((candidate) => candidate === phaseKey) || isGrowthAnalysisTopicPhaseKey(phaseKey));
}

function interviewState(snapshot: GrowthAdminStageRunSnapshot): PhaseGroupState | "not-started" {
  if (snapshot.run == null) return "not-started";
  return phaseGroupState(snapshot.run.phases, (phaseKey) => phaseKey === GROWTH_INTERVIEW_QUESTIONS_PHASE_KEY);
}

function reportState(snapshot: GrowthAdminStageRunSnapshot): PhaseGroupState | "not-started" {
  if (snapshot.run == null) return "not-started";
  return phaseGroupState(snapshot.run.phases, (phaseKey) => phaseKey === GROWTH_REPORT_PHASE_KEY);
}

/**
 * The stage gate used by both GET and POST. POST checks it again immediately before doing work, so
 * a stale admin tab cannot bypass a prerequisite that changed after the page loaded.
 */
export function getGrowthAdminStageRunStateFromSnapshot(stageId: GrowthAdminStageId, snapshot: GrowthAdminStageRunSnapshot): GrowthAdminStageRunState {
  if (stageId === "set-up") {
    return state(stageId, "complete", "Set up is complete. Growth Admin only lists projects that have finished onboarding.");
  }

  const metrics = metricsState(snapshot);
  if (stageId === "compute-metrics") {
    if (metrics === "not-started") return state(stageId, "ready", "Start a new analysis run and compute its metrics.");
    if (metrics === "failed") return state(stageId, "failed", "Metric computation failed. Retry this step to restart the failed analysis run.");
    if (metrics === "running") return state(stageId, "running", "Metric computation is running.");
    if (metrics === "complete") return state(stageId, "complete", "Metric computation is complete.");
    return state(stageId, "ready", "Metric computation is ready to run.");
  }

  if (metrics !== "complete") {
    return state(stageId, "blocked", metrics === "failed" ? "Retry Metrics before running this step." : "Complete Metrics before running this step.");
  }

  const integrations = integrationsState(snapshot);
  if (stageId === "integrations") {
    if (integrations === "failed") return state(stageId, "failed", "The integrations step failed. Retry it to restart the failed analysis run.");
    if (integrations === "running") return state(stageId, "running", "The integrations step is running.");
    if (integrations === "complete") return state(stageId, "complete", "The integrations step is complete.");
    return state(stageId, "ready", "The integrations step is ready. The current policy will continue with product data only.");
  }

  if (integrations !== "complete") {
    return state(stageId, "blocked", integrations === "failed" ? "Retry Integrations before running this step." : "Complete Integrations before running this step.");
  }

  const analysis = analysisState(snapshot);
  if (stageId === "analysis") {
    if (analysis === "failed") return state(stageId, "failed", "Deep research failed. Retry this step to restart the failed analysis run.");
    if (analysis === "running") return state(stageId, "running", "Deep research is running.");
    if (analysis === "complete") return state(stageId, "complete", "Deep research is complete.");
    return state(stageId, "ready", "Deep research is ready to run.");
  }

  if (analysis !== "complete") {
    return state(stageId, "blocked", analysis === "failed" ? "Retry Deep research before running this step." : "Complete Deep research before running this step.");
  }

  const interview = interviewState(snapshot);
  if (stageId === "interview") {
    if (interview === "failed") return state(stageId, "failed", "Interview generation failed. Retry this step to restart the failed analysis run.");
    if (interview === "running") return state(stageId, "running", "Interview questions are being generated.");
    if (interview === "complete") return state(stageId, "complete", "Interview questions are generated. Review and release them below.");
    return state(stageId, "ready", "Interview questions are ready to generate.");
  }

  if (interview !== "complete") {
    return state(stageId, "blocked", interview === "failed" ? "Retry Interview before running this step." : "Generate the Interview before running this step.");
  }

  const report = reportState(snapshot);
  if (report === "failed") return state(stageId, "failed", "Report generation failed. Retry this step to restart the failed analysis run.");
  if (report === "running") return state(stageId, "running", "The report is being generated.");
  if (report === "complete") return state(stageId, "complete", "The report is generated. Review and release it below.");
  const interviewAnswered = snapshot.run?.interviewStatus === "completed" || snapshot.run?.interviewStatus === "skipped";
  if (!interviewAnswered) return state(stageId, "blocked", "The customer must complete or skip the Interview before the report can run.");
  return state(stageId, "ready", "The report is ready to generate.");
}

async function loadGrowthAdminStageRunSnapshot(tenancy: Tenancy): Promise<GrowthAdminStageRunSnapshot> {
  const latestRun = await globalPrismaClient.growthAnalysisRun.findFirst({
    where: { projectId: tenancy.project.id, branchId: tenancy.branchId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      status: true,
      phases: { select: { phaseKey: true, status: true } },
      interview: { select: { status: true } },
    },
  });
  // A cancelled run is deliberately equivalent to no run, matching getGrowthStatusBody. Metrics is
  // then the only runnable stage and starts a fresh manual run; later stages remain prerequisite-gated.
  if (latestRun == null || latestRun.status === GrowthRunStatus.CANCELLED) return { run: null };
  return {
    run: {
      status: latestRun.status,
      phases: latestRun.phases,
      interviewStatus: latestRun.interview?.status ?? null,
    },
  };
}

export async function getGrowthAdminStageRunState(tenancy: Tenancy, stageId: GrowthAdminStageId): Promise<GrowthAdminStageRunState> {
  return getGrowthAdminStageRunStateFromSnapshot(stageId, await loadGrowthAdminStageRunSnapshot(tenancy));
}

export type GrowthAdminStageRunResult = GrowthAdminStageRunState & GrowthRepairResult;

export async function runGrowthAdminStage(tenancy: Tenancy, stageId: GrowthAdminStageId): Promise<GrowthAdminStageRunResult> {
  const beforeSnapshot = await loadGrowthAdminStageRunSnapshot(tenancy);
  const before = getGrowthAdminStageRunStateFromSnapshot(stageId, beforeSnapshot);
  if (!before.canRun) return { ...before, didWork: false, legStarted: null };

  if (before.state === "failed") {
    await retryGrowthAnalysis({ tenancy });
  } else if (stageId === "compute-metrics" && beforeSnapshot.run == null) {
    await startGrowthManualRun({ tenancy });
  }

  const repair = await repairGrowthProject(tenancy);
  const after = await getGrowthAdminStageRunState(tenancy, stageId);
  return { ...after, ...repair };
}
