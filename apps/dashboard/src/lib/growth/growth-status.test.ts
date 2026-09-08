import { describe, expect, it } from "vitest";
import { buildGrowthDemoStatus, GROWTH_DEMO_NOW_MILLIS } from "./growth-demo-data";
import { getGrowthPhase, getGrowthStatusPollIntervalMillis, growthWorkspaceIsUnlocked } from "./growth-status";
import type { GrowthStatus } from "./growth-types";

function baseStatus(): GrowthStatus {
  return buildGrowthDemoStatus("steady-state", GROWTH_DEMO_NOW_MILLIS);
}

describe("getGrowthPhase", () => {
  it("gates everything behind onboarding", () => {
    const status = baseStatus();
    status.onboarding = { completed: false, completedAtMillis: null, websiteUrl: null };
    expect(getGrowthPhase(status)).toBe("not-onboarded");
  });

  it("treats a not-yet-dispatched run (analysis state none) as analyzing once onboarded", () => {
    const status = baseStatus();
    status.analysis = { ...status.analysis, state: "none", runId: null, trigger: null, steps: null };
    expect(getGrowthPhase(status)).toBe("analyzing");
  });

  it("is analyzing while the run is in flight", () => {
    const status = baseStatus();
    status.analysis = { ...status.analysis, state: "running", completedAtMillis: null };
    expect(getGrowthPhase(status)).toBe("analyzing");
  });

  it("surfaces a failed analysis even before the interview", () => {
    const status = baseStatus();
    status.analysis = { ...status.analysis, state: "failed", errorMessage: "Something went wrong." };
    expect(getGrowthPhase(status)).toBe("analysis-failed");
  });

  it("moves to the interview once analysis completes and questions are unanswered", () => {
    const status = baseStatus();
    status.interview = { state: "ready", answeredCount: 0, estimatedTotal: 8 };
    expect(getGrowthPhase(status)).toBe("interview");
  });

  it("keeps the interview phase while answers are partially given", () => {
    const status = baseStatus();
    status.interview = { state: "in_progress", answeredCount: 3, estimatedTotal: 8 };
    expect(getGrowthPhase(status)).toBe("interview");
  });

  it("is report-ready after the interview until the first daily brief arrives", () => {
    const status = baseStatus();
    status.latestBrief = null;
    expect(getGrowthPhase(status)).toBe("report-ready");
  });

  it("reaches steady-state once a brief exists", () => {
    expect(getGrowthPhase(baseStatus())).toBe("steady-state");
  });

  // The regression this pins: `analysis.state` is "completed" throughout COMPOSING_REPORT (the phase
  // checklist is done; the report is written by a later phase), so a phase derivation keyed only on
  // the interview + the brief announced a report that did not exist. In a workspace whose first daily
  // brief landed before the report — routine, since the brief cron is independent of the run — that
  // meant "Report" ticked done and the timeline jumped to "Ongoing growth" while the report page
  // still said "No report yet".
  it("stays on the report step while the report is still composing, even after a brief has arrived", () => {
    const status = baseStatus();
    status.latestReport = null;
    expect(status.latestBrief).not.toBe(null);
    expect(getGrowthPhase(status)).toBe("report-ready");
  });
});

describe("getGrowthStatusPollIntervalMillis", () => {
  it("polls through the analysis", () => {
    const status = baseStatus();
    status.analysis = { ...status.analysis, state: "running", completedAtMillis: null };
    expect(getGrowthStatusPollIntervalMillis(status)).toBe(7_000);
  });

  it("polls slowly through the post-interview hold so publication ends the loading state", () => {
    const status = baseStatus();
    status.latestReport = null;
    status.release = { state: "preparing" };
    expect(getGrowthPhase(status)).toBe("report-ready");
    expect(getGrowthStatusPollIntervalMillis(status)).toBe(60_000);
  });

  it("stops once the report exists", () => {
    const status = baseStatus();
    status.latestBrief = null;
    expect(getGrowthPhase(status)).toBe("report-ready");
    expect(getGrowthStatusPollIntervalMillis(status)).toBe(null);
  });

  it("does not poll a settled workspace or one waiting on the human", () => {
    expect(getGrowthStatusPollIntervalMillis(baseStatus())).toBe(null);
    const interviewing = baseStatus();
    interviewing.interview = { state: "ready", answeredCount: 0, estimatedTotal: 8 };
    expect(getGrowthStatusPollIntervalMillis(interviewing)).toBe(null);
  });
});

describe("growthWorkspaceIsUnlocked", () => {
  it("keeps the lifecycle visible after release until the customer opens the report", () => {
    const status = baseStatus();
    expect(status.release.state).toBe("released");
    expect(status.latestReport?.readAtMillis).toBeNull();
    expect(growthWorkspaceIsUnlocked(status)).toBe(false);
  });

  it("unlocks the workspace after the released report is opened", () => {
    const status = baseStatus();
    if (status.latestReport == null) expect.fail("The steady-state fixture must include a report.");
    status.latestReport.readAtMillis = GROWTH_DEMO_NOW_MILLIS;
    expect(growthWorkspaceIsUnlocked(status)).toBe(true);
  });
});
