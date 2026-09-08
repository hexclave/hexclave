import { GrowthPhaseStatus, GrowthRunStatus } from "@/generated/prisma/enums";
import { describe, expect, it } from "vitest";
import { getGrowthAdminStageRunStateFromSnapshot, type GrowthAdminStageRunSnapshot } from "./admin-stage-run";

function snapshot(
  phases: readonly { phaseKey: string, status: GrowthPhaseStatus }[],
  interviewStatus: string | null = null,
): GrowthAdminStageRunSnapshot {
  return { run: { status: GrowthRunStatus.RUNNING, phases, interviewStatus } };
}

const completedPrerequisites: readonly { phaseKey: string, status: GrowthPhaseStatus }[] = [
  { phaseKey: "compute-metrics", status: GrowthPhaseStatus.COMPLETED },
  { phaseKey: "integrations", status: GrowthPhaseStatus.SKIPPED },
  { phaseKey: "website-research", status: GrowthPhaseStatus.COMPLETED },
  { phaseKey: "data-analysis", status: GrowthPhaseStatus.COMPLETED },
  { phaseKey: "analysis:conversion", status: GrowthPhaseStatus.COMPLETED },
  { phaseKey: "interview-questions", status: GrowthPhaseStatus.COMPLETED },
  { phaseKey: "report", status: GrowthPhaseStatus.PENDING },
];

describe("getGrowthAdminStageRunStateFromSnapshot", () => {
  it("makes only Metrics runnable before an analysis run exists", () => {
    const noRun = { run: null };
    expect([
      getGrowthAdminStageRunStateFromSnapshot("set-up", noRun),
      getGrowthAdminStageRunStateFromSnapshot("compute-metrics", noRun),
      getGrowthAdminStageRunStateFromSnapshot("integrations", noRun),
      getGrowthAdminStageRunStateFromSnapshot("analysis", noRun),
      getGrowthAdminStageRunStateFromSnapshot("interview", noRun),
      getGrowthAdminStageRunStateFromSnapshot("report", noRun),
    ].map((value) => ({ stage: value.stage, state: value.state, canRun: value.canRun }))).toMatchInlineSnapshot(`
      [
        {
          "canRun": false,
          "stage": "set-up",
          "state": "complete",
        },
        {
          "canRun": true,
          "stage": "compute-metrics",
          "state": "ready",
        },
        {
          "canRun": false,
          "stage": "integrations",
          "state": "blocked",
        },
        {
          "canRun": false,
          "stage": "analysis",
          "state": "blocked",
        },
        {
          "canRun": false,
          "stage": "interview",
          "state": "blocked",
        },
        {
          "canRun": false,
          "stage": "report",
          "state": "blocked",
        },
      ]
    `);
  });

  it("does not let a later stage bypass Metrics", () => {
    const value = getGrowthAdminStageRunStateFromSnapshot("analysis", snapshot([
      { phaseKey: "compute-metrics", status: GrowthPhaseStatus.RUNNING },
      { phaseKey: "integrations", status: GrowthPhaseStatus.PENDING },
      { phaseKey: "website-research", status: GrowthPhaseStatus.PENDING },
    ]));
    expect(value).toEqual({
      stage: "analysis",
      state: "blocked",
      canRun: false,
      message: "Complete Metrics before running this step.",
    });
  });

  it("makes Deep research ready only after Metrics and Integrations settle", () => {
    expect(getGrowthAdminStageRunStateFromSnapshot("analysis", snapshot([
      { phaseKey: "compute-metrics", status: GrowthPhaseStatus.COMPLETED },
      { phaseKey: "integrations", status: GrowthPhaseStatus.SKIPPED },
      { phaseKey: "website-research", status: GrowthPhaseStatus.PENDING },
      { phaseKey: "data-analysis", status: GrowthPhaseStatus.PENDING },
      { phaseKey: "analysis:conversion", status: GrowthPhaseStatus.PENDING },
    ]))).toEqual({ stage: "analysis", state: "ready", canRun: true, message: "Deep research is ready to run." });
  });

  it("offers a retry for the stage that owns a failed phase", () => {
    expect(getGrowthAdminStageRunStateFromSnapshot("interview", snapshot([
      ...completedPrerequisites.filter((phase) => phase.phaseKey !== "interview-questions"),
      { phaseKey: "interview-questions", status: GrowthPhaseStatus.FAILED },
    ]))).toEqual({
      stage: "interview",
      state: "failed",
      canRun: true,
      message: "Interview generation failed. Retry this step to restart the failed analysis run.",
    });
  });

  it("holds Report on the human interview prerequisite", () => {
    expect(getGrowthAdminStageRunStateFromSnapshot("report", snapshot(completedPrerequisites, "active"))).toEqual({
      stage: "report",
      state: "blocked",
      canRun: false,
      message: "The customer must complete or skip the Interview before the report can run.",
    });
    expect(getGrowthAdminStageRunStateFromSnapshot("report", snapshot(completedPrerequisites, "completed"))).toEqual({
      stage: "report",
      state: "ready",
      canRun: true,
      message: "The report is ready to generate.",
    });
  });

  it("treats phases absent from an older run as settled", () => {
    expect(getGrowthAdminStageRunStateFromSnapshot("compute-metrics", snapshot([]))).toMatchObject({ state: "complete", canRun: false });
    expect(getGrowthAdminStageRunStateFromSnapshot("integrations", snapshot([]))).toMatchObject({ state: "complete", canRun: false });
  });
});
