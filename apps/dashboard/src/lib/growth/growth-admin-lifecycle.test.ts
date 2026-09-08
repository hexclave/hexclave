import { describe, expect, it } from "vitest";
import { getGrowthAdminEditGate, getGrowthAdminTimelineStepStates, growthAdminInterviewIsAwaitingApproval, growthAdminReportIsAwaitingRelease } from "./growth-admin-lifecycle";
import { buildGrowthDemoStatus, GROWTH_DEMO_NOW_MILLIS } from "./growth-demo-data";
import { GROWTH_PHASES, getGrowthPhase } from "./growth-status";
import type { GrowthStatus } from "./growth-types";

function baseStatus(): GrowthStatus {
  return buildGrowthDemoStatus("steady-state", GROWTH_DEMO_NOW_MILLIS);
}

describe("getGrowthAdminEditGate", () => {
  it("blocks editing before onboarding", () => {
    const status = baseStatus();
    status.onboarding = { completed: false, completedAtMillis: null, websiteUrl: null };
    status.release = { state: "not_ready" };
    const gate = getGrowthAdminEditGate(status);
    expect(gate.phase).toBe("not-onboarded");
    expect(gate.contentEditable).toBe(false);
    expect(gate.blockedReason).not.toBe(null);
  });

  it("blocks editing while deep research runs", () => {
    const status = baseStatus();
    status.analysis = { ...status.analysis, state: "running", completedAtMillis: null };
    status.release = { state: "preparing" };
    expect(getGrowthAdminEditGate(status).contentEditable).toBe(false);
  });

  it("blocks editing when deep research failed", () => {
    const status = baseStatus();
    status.analysis = { ...status.analysis, state: "failed", errorMessage: "Something went wrong." };
    status.release = { state: "not_ready" };
    expect(getGrowthAdminEditGate(status).contentEditable).toBe(false);
  });

  // Before the first release, the admin page hides the whole customer workspace throughout every
  // incomplete interview state, not only while the customer is actively answering questions.
  it("blocks the workspace for every incomplete interview state", () => {
    for (const state of ["not_ready", "preparing", "ready", "in_progress"] as const) {
      const status = baseStatus();
      status.interview = { state, answeredCount: state === "in_progress" ? 3 : 0, estimatedTotal: 8 };
      status.release = { state: state === "not_ready" ? "not_ready" : "preparing" };
      const gate = getGrowthAdminEditGate(status);
      expect(gate.phase).toBe("interview");
      expect(gate.contentEditable).toBe(false);
    }
  });

  it("keeps the workspace hidden while the first report awaits publication", () => {
    const awaitingPublication = baseStatus();
    awaitingPublication.latestReport = null;
    awaitingPublication.latestBrief = null;
    awaitingPublication.release = { state: "preparing" };

    expect(getGrowthPhase(awaitingPublication)).toBe("report-ready");
    expect(getGrowthAdminEditGate(awaitingPublication)).toEqual({
      phase: "report-ready",
      contentEditable: false,
      blockedReason: "The report is ready for staff review but hasn't been released to the customer yet. Review and publish the report first.",
    });
  });

  it("shows the workspace as soon as the first report is published, before the first brief", () => {
    const published = baseStatus();
    published.latestBrief = null;

    expect(getGrowthPhase(published)).toBe("report-ready");
    expect(getGrowthAdminEditGate(published)).toEqual({ phase: "report-ready", contentEditable: true, blockedReason: null });
    expect(getGrowthAdminEditGate(baseStatus())).toEqual({ phase: "steady-state", contentEditable: true, blockedReason: null });
  });

  it("keeps an already-released workspace visible during a later interview", () => {
    const status = baseStatus();
    status.interview = { state: "in_progress", answeredCount: 3, estimatedTotal: 8 };

    expect(getGrowthPhase(status)).toBe("interview");
    expect(getGrowthAdminEditGate(status)).toEqual({ phase: "interview", contentEditable: true, blockedReason: null });
  });

  // A phase added later must not silently fall through to "editable, no explanation": either it gets
  // a reason (blocked) or it is deliberately editable. This asserts the two stay in lockstep.
  it("gives every blocked phase a reason, and every editable phase none", () => {
    const gates = GROWTH_PHASES.map((phase) => {
      const status = baseStatus();
      switch (phase) {
        case "not-onboarded": {
          status.onboarding = { completed: false, completedAtMillis: null, websiteUrl: null };
          status.release = { state: "not_ready" };
          break;
        }
        case "analyzing": {
          status.analysis = { ...status.analysis, state: "running", completedAtMillis: null };
          status.release = { state: "preparing" };
          break;
        }
        case "analysis-failed": {
          status.analysis = { ...status.analysis, state: "failed", errorMessage: "Something went wrong." };
          status.release = { state: "not_ready" };
          break;
        }
        case "interview": {
          status.interview = { state: "ready", answeredCount: 0, estimatedTotal: 8 };
          status.release = { state: "preparing" };
          break;
        }
        case "report-ready": {
          status.latestReport = null;
          status.latestBrief = null;
          status.release = { state: "preparing" };
          break;
        }
        case "steady-state": {
          break;
        }
      }
      expect(getGrowthPhase(status)).toBe(phase);
      return getGrowthAdminEditGate(status);
    });
    for (const gate of gates) {
      expect(gate.contentEditable).toBe(gate.blockedReason == null);
    }
  });
});

describe("getGrowthAdminTimelineStepStates", () => {
  it("unfolds the customer analysis operation into the admin interview step", () => {
    const states = getGrowthAdminTimelineStepStates(buildGrowthDemoStatus("interview", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "done"],
      ["interview", "current"],
      ["report", "upcoming"],
    ]);
  });

  it("shows report as current after research and interview finish", () => {
    const states = getGrowthAdminTimelineStepStates(buildGrowthDemoStatus("report-ready", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "done"],
      ["interview", "done"],
      ["report", "current"],
    ]);
  });
});

describe("growthAdminInterviewIsAwaitingApproval", () => {
  it("distinguishes an interview held for staff approval from interview generation", () => {
    const interview = buildGrowthDemoStatus("interview", GROWTH_DEMO_NOW_MILLIS);
    interview.interview = { ...interview.interview, state: "preparing" };

    expect(growthAdminInterviewIsAwaitingApproval(interview)).toBe(true);
    expect(growthAdminInterviewIsAwaitingApproval(buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS))).toBe(false);
  });
});

describe("growthAdminReportIsAwaitingRelease", () => {
  it("distinguishes a composed held report from report generation", () => {
    const reportReady = buildGrowthDemoStatus("report-ready", GROWTH_DEMO_NOW_MILLIS);
    expect(growthAdminReportIsAwaitingRelease(reportReady, false)).toBe(false);
    expect(growthAdminReportIsAwaitingRelease(reportReady, true)).toBe(true);
  });

  it("does not call an older unpublished report the current wait after onboarding completes", () => {
    expect(growthAdminReportIsAwaitingRelease(buildGrowthDemoStatus("steady-state", GROWTH_DEMO_NOW_MILLIS), true)).toBe(false);
  });
});
