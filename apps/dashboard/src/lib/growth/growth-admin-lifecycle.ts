import { getGrowthPhase, type GrowthPhase } from "./growth-status";
import { getGrowthTimelineStepStates, type GrowthTimelineStepId, type GrowthTimelineStepState } from "./growth-timeline";
import type { GrowthStatus } from "./growth-types";

/**
 * Whether the Growth admin workspace may edit the customer-facing content, and if not, what the
 * project is still waiting on.
 *
 * The admin page renders the customer's workspace with every field editable, which only makes sense
 * once the customer has actually received their first report. Reaching the report step is not enough:
 * while that report is held for staff review, the customer still has no workspace, so showing its
 * editable mirror here makes the admin page claim a release that has not happened yet.
 */
export type GrowthAdminEditGate = {
  phase: GrowthPhase,
  /** Findings, notes, actions, stage scores and authored stage pages. */
  contentEditable: boolean,
  /** Null exactly when `contentEditable` is true. Phrased in terms of what the customer is waiting on. */
  blockedReason: string | null,
};

/**
 * Reasons for lifecycle phases that can occur before the first report release. `report-ready` needs
 * an explicit reason because it spans both sides of the release boundary: composing/reviewing the
 * held report and, after publication, waiting for the first daily brief.
 */
const BLOCKED_REASONS = new Map<GrowthPhase, string>([
  ["not-onboarded", "This project hasn't onboarded yet, so there is no research, no metrics and nothing to edit."],
  ["analyzing", "Deep research is still running. The findings, notes and actions it produces don't exist yet."],
  ["analysis-failed", "Deep research failed, so it produced no findings, notes or actions. Re-run it under lifecycle operations."],
  ["interview", "Deep research is done, but the customer hasn't finished the interview — the findings and actions it feeds are not final yet. Review and release the interview first."],
  ["report-ready", "The report is ready for staff review but hasn't been released to the customer yet. Review and publish the report first."],
]);

export function getGrowthAdminEditGate(status: GrowthStatus): GrowthAdminEditGate {
  const phase = getGrowthPhase(status);
  // Release is the durable boundary, unlike the current phase: after a first report is published, a
  // later analysis can put the lifecycle back in the interview/report phases without taking the
  // already-visible customer workspace away from staff.
  if (status.release.state === "released") return { phase, contentEditable: true, blockedReason: null };
  const blockedReason = BLOCKED_REASONS.get(phase)
    ?? "The first report hasn't been released to the customer yet.";
  return { phase, contentEditable: false, blockedReason };
}

/**
 * The customer timeline presents first-run analysis, interview, and report preparation as one
 * continuous operation. Admin pages expose those as separate destinations, so their navigation
 * must unfold that customer-facing state once each staff-visible task has actually finished.
 */
export function getGrowthAdminTimelineStepStates(status: GrowthStatus): Map<GrowthTimelineStepId, GrowthTimelineStepState> {
  const phase = getGrowthPhase(status);
  const states = getGrowthTimelineStepStates(status);

  if (phase === "interview" || phase === "report-ready") {
    states.set("analysis", "done");
    states.set("interview", phase === "interview" ? "current" : "done");
  }
  if (phase === "report-ready") {
    states.set("report", "current");
  }

  for (const [stepId, state] of states) {
    if (state === "hidden") states.set(stepId, "upcoming");
  }
  return states;
}

/** A prepared interview is paused on staff, rather than still being generated. */
export function growthAdminInterviewIsAwaitingApproval(status: GrowthStatus): boolean {
  return status.interview.state === "preparing"
    && getGrowthAdminTimelineStepStates(status).get("interview") === "current";
}

/** A held report is a human wait only once the pipeline has actually reached the report step. */
export function growthAdminReportIsAwaitingRelease(status: GrowthStatus, hasUnpublishedReport: boolean): boolean {
  return status.release.state === "preparing"
    && hasUnpublishedReport
    && getGrowthAdminTimelineStepStates(status).get("report") === "current";
}
