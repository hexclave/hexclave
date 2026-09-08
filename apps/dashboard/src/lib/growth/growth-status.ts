import type { GrowthStatus } from "./growth-types";

export const GROWTH_PHASES = ["not-onboarded", "analyzing", "analysis-failed", "interview", "report-ready", "steady-state"] as const;
export type GrowthPhase = typeof GROWTH_PHASES[number];

/**
 * Derives which lifecycle panel the overview shows from the status endpoint's snapshot. The order of the
 * checks is the lifecycle itself: onboarding gates everything, a run in flight (or not yet dispatched —
 * `state: "none"` after onboarding means the engine hasn't picked the run up yet, which the user should
 * still read as "analyzing") gates the interview, the interview gates the report, and the report plus
 * the first daily brief are what flip the app into its steady state.
 *
 * The report check is `latestReport`, NOT `analysis.state`, because those answer different questions.
 * `analysis.state` is "completed" from AWAITING_INTERVIEW onwards — the phase checklist is done, but
 * the report is composed by a *later* phase (COMPOSING_REPORT collapses into the same wire value).
 * Two symptoms came from conflating them: the overview announced a ready report the moment the
 * interview was submitted, and — because the steady-state check used to look only at `latestBrief` —
 * a workspace whose first daily brief landed while the report was still being written ticked "Report"
 * done and jumped straight to "Ongoing growth". Both times the report page correctly said "No report
 * yet". Gating on the report's actual existence keeps the timeline and the report page in agreement.
 */
export function getGrowthPhase(status: GrowthStatus): GrowthPhase {
  if (!status.onboarding.completed) return "not-onboarded";
  if (status.analysis.state === "failed") return "analysis-failed";
  if (status.analysis.state === "none" || status.analysis.state === "running") return "analyzing";
  if (status.interview.state !== "completed") return "interview";
  if (status.latestReport == null || status.latestBrief == null) return "report-ready";
  return "steady-state";
}

/** The customer unlocks the workspace by opening the first released report. */
export function growthWorkspaceIsUnlocked(status: GrowthStatus): boolean {
  return status.release.state === "released" && status.latestReport?.readAtMillis != null;
}

/**
 * Poll quickly while backend analysis phases advance, then slowly through the two waits the customer
 * cannot end themselves: their question plan being finalized before the interview opens (the
 * day-long one — see lib/growth/interview-release.ts on the backend), and their report being
 * composed after they answer (minutes). Both resolve without the customer doing anything, so the
 * page has to notice on its own.
 *
 * Slowly, because a day at the analysis cadence is thousands of requests for one state change. An
 * interview that is open and unanswered is user-driven, so it does not poll at all.
 */
export function getGrowthStatusPollIntervalMillis(status: GrowthStatus): number | null {
  if (getGrowthPhase(status) === "analyzing") return 7_000;
  if (status.release.state === "preparing" && (status.interview.state === "preparing" || status.interview.state === "completed")) return 60_000;
  return null;
}
