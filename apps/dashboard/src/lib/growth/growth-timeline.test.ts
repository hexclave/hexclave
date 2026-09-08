import { describe, expect, it } from "vitest";
import { buildGrowthDemoStatus, GROWTH_DEMO_NOW_MILLIS } from "./growth-demo-data";
import { GROWTH_PHASES } from "./growth-status";
import { getGrowthTimelineStepStates, GROWTH_TIMELINE_STEP_IDS } from "./growth-timeline";
import type { GrowthStatus } from "./growth-types";

// One case per demo phase fixture: the demo toolbar walks all six phases, so each must derive a
// sensible timeline (at most one expanded step, done above, upcoming below).
describe("getGrowthTimelineStepStates", () => {
  it("marks set-up current before onboarding, with both phase-backed steps previewed", () => {
    const states = getGrowthTimelineStepStates(buildGrowthDemoStatus("not-onboarded", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "current"],
      ["compute-metrics", "upcoming"],
      ["integrations", "upcoming"],
      ["analysis", "upcoming"],
      ["interview", "upcoming"],
      ["report", "upcoming"],
    ]);
  });

  it("makes computing metrics the current step while it runs, holding the analysis back", () => {
    const base = buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS);
    const status: GrowthStatus = {
      ...base,
      analysis: {
        ...base.analysis,
        computeMetrics: { state: "running", metricLabels: ["Daily active users"] },
        integrations: { state: "pending" },
      },
      release: { state: "not_ready" },
    };
    const states = getGrowthTimelineStepStates(status);
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "current"],
      ["integrations", "upcoming"],
      ["analysis", "upcoming"],
      ["interview", "upcoming"],
      ["report", "upcoming"],
    ]);
  });

  it("makes integrations the current step while the run waits on the human", () => {
    const base = buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS);
    const status: GrowthStatus = {
      ...base,
      analysis: {
        ...base.analysis,
        computeMetrics: { state: "done", metricLabels: ["Daily active users"] },
        integrations: { state: "waiting" },
      },
    };
    const states = getGrowthTimelineStepStates(status);
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "current"],
      ["analysis", "upcoming"],
      ["interview", "upcoming"],
      ["report", "upcoming"],
    ]);
  });

  it("hands the current step to the analysis once both early steps settle", () => {
    const base = buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS);
    const status: GrowthStatus = {
      ...base,
      analysis: {
        ...base.analysis,
        computeMetrics: { state: "done", metricLabels: ["Daily active users"] },
        integrations: { state: "skipped" },
      },
    };
    const states = getGrowthTimelineStepStates(status);
    expect(states.get("compute-metrics")).toBe("done");
    expect(states.get("integrations")).toBe("done");
    expect(states.get("analysis")).toBe("current");
  });

  it("hides both phase-backed steps for runs that predate them (null wire blocks)", () => {
    const base = buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS);
    const status: GrowthStatus = {
      ...base,
      analysis: { ...base.analysis, computeMetrics: null, integrations: null },
    };
    const states = getGrowthTimelineStepStates(status);
    expect(states.get("compute-metrics")).toBe("hidden");
    expect(states.get("integrations")).toBe("hidden");
    // The pre-deploy timeline is unchanged: the analysis stays the expanded step.
    expect(states.get("analysis")).toBe("current");
  });

  it("surfaces a failed metrics computation on its own step", () => {
    const base = buildGrowthDemoStatus("analysis-failed", GROWTH_DEMO_NOW_MILLIS);
    const status: GrowthStatus = {
      ...base,
      analysis: { ...base.analysis, computeMetrics: { state: "failed", metricLabels: ["Daily active users"] } },
    };
    const states = getGrowthTimelineStepStates(status);
    expect(states.get("compute-metrics")).toBe("failed");
    // The analysis step keeps its own failed state: it owns the retry affordance.
    expect(states.get("analysis")).toBe("failed");
  });

  it("marks analysis failed (and later steps upcoming) when the run failed", () => {
    const states = getGrowthTimelineStepStates(buildGrowthDemoStatus("analysis-failed", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "failed"],
      ["interview", "upcoming"],
      ["report", "upcoming"],
    ]);
  });

  it("keeps deep analysis current and folds the generated interview into it", () => {
    const states = getGrowthTimelineStepStates(buildGrowthDemoStatus("interview", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "current"],
      ["interview", "hidden"],
      ["report", "upcoming"],
    ]);
  });

  it("keeps deep analysis current after the interview until the report is published", () => {
    const states = getGrowthTimelineStepStates(buildGrowthDemoStatus("report-ready", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "current"],
      ["interview", "hidden"],
      ["report", "upcoming"],
    ]);
  });

  it("makes report the final current step until the customer opens it", () => {
    const states = getGrowthTimelineStepStates(buildGrowthDemoStatus("steady-state", GROWTH_DEMO_NOW_MILLIS));
    expect([...states.entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "done"],
      ["interview", "done"],
      ["report", "current"],
    ]);
  });

  it("marks the finite onboarding timeline complete after the report is opened", () => {
    const status = buildGrowthDemoStatus("steady-state", GROWTH_DEMO_NOW_MILLIS);
    if (status.latestReport == null) expect.fail("The steady-state fixture must include a report.");
    status.latestReport.readAtMillis = GROWTH_DEMO_NOW_MILLIS;
    expect([...getGrowthTimelineStepStates(status).entries()]).toEqual([
      ["set-up", "done"],
      ["compute-metrics", "done"],
      ["integrations", "done"],
      ["analysis", "done"],
      ["interview", "done"],
      ["report", "done"],
    ]);
  });

  it("always yields at most one expanded (current or failed) step per phase, over every step id", () => {
    for (const phase of GROWTH_PHASES) {
      const states = getGrowthTimelineStepStates(buildGrowthDemoStatus(phase, GROWTH_DEMO_NOW_MILLIS));
      expect([...states.keys()]).toEqual([...GROWTH_TIMELINE_STEP_IDS]);
      const expanded = [...states.values()].filter((state) => state === "current");
      expect(expanded.length).toBeLessThanOrEqual(1);
    }
  });
});
