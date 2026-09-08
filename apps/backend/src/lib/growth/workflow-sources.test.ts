import { compileWorkflowBundle, validateWorkflowSource } from "@/lib/workflows/compile";
import { describe, expect, test } from "vitest";
import {
  GROWTH_ANALYSIS_RUN_ACTIVATED_EVENT_NAME,
  GROWTH_ANALYSIS_WORKFLOW_ID,
  GROWTH_ANALYSIS_WORKFLOW_SOURCE,
  GROWTH_DAILY_BRIEF_DUE_EVENT_NAME,
  GROWTH_DAILY_BRIEF_WORKFLOW_ID,
  GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE,
  GROWTH_INTERVIEW_FINISHED_EVENT_NAME,
  getGrowthAnalysisLegRunKey,
  getGrowthDailyBriefRunKey,
} from "./workflow-sources";

// The full manifest-extraction path (sandbox execution asserting the actual
// trigger list) requires a live js-execution sandbox and is covered by the
// growth e2e tests; here we cover everything that can be checked headlessly:
// source validation, a real esbuild compile, and byte-level invariants the
// seeding/drift machinery depends on.

const sources = [
  [GROWTH_ANALYSIS_WORKFLOW_ID, GROWTH_ANALYSIS_WORKFLOW_SOURCE],
  [GROWTH_DAILY_BRIEF_WORKFLOW_ID, GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE],
] as const;

describe.each(sources)("canonical growth workflow source %s", (workflowId, source) => {
  test("passes validateWorkflowSource", () => {
    const result = validateWorkflowSource(source);
    if (result.status === "error") throw new Error(`Expected ${workflowId} source to validate, got: ${result.error}`);
  });

  test("compiles to a bundle", async () => {
    const result = await compileWorkflowBundle(source);
    if (result.status === "error") throw new Error(`Expected ${workflowId} source to compile, got: ${result.error}`);
  }, 30_000);

  test("contains no backticks and no template interpolation markers", () => {
    // The sources live inside template literals in workflow-sources.ts; a
    // backtick or "${" would silently change the emitted bytes (or break the
    // file), and byte-stability is what edit detection relies on.
    expect(source).not.toContain("`");
    expect(source).not.toContain("${");
  });

  test("contains no dynamic imports", () => {
    expect(source).not.toMatch(/\b(?:import|require)\s*\(/);
  });

  test("declares the expected workflow id", () => {
    expect(source).toContain(`workflow<`);
    expect(source).toContain(`("${workflowId}", {`);
  });

  test("uses onConflict skip", () => {
    expect(source).toContain('onConflict: "skip"');
  });
});

describe("growth-analysis source", () => {
  test("subscribes to both boundary events", () => {
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE).toContain(`customEvent("${GROWTH_ANALYSIS_RUN_ACTIVATED_EVENT_NAME}")`);
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE).toContain(`customEvent("${GROWTH_INTERVIEW_FINISHED_EVENT_NAME}")`);
  });

  test("runKey expression matches getGrowthAnalysisLegRunKey", () => {
    // The watchdog derives leg runKeys with getGrowthAnalysisLegRunKey; the
    // source must use the exact same shape (run id + ":" + wire event type).
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE).toContain('runKey: (event) => event.data.growth_run_id + ":" + event.type');
    expect(getGrowthAnalysisLegRunKey("run-1", "custom.growth.analysis-run-activated")).toBe("run-1:custom.growth.analysis-run-activated");
    expect(getGrowthAnalysisLegRunKey("run-1", "custom.growth.interview-finished")).toBe("run-1:custom.growth.interview-finished");
  });

  test("uses per-iteration step ids for the advance loop", () => {
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE).toContain('step.run("advance-" + round');
  });

  test("keeps each checkpoint to one four-minute long-poll", () => {
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE.match(/analysis\/wait/g)).toHaveLength(1);
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE).toContain("timeout_ms: 240000");
    expect(GROWTH_ANALYSIS_WORKFLOW_SOURCE).not.toContain("for (let poll = 0; poll < 2; poll++)");
  });
});

describe("growth-daily-brief source", () => {
  test("subscribes to the UTC schedule and the catch-up event", () => {
    expect(GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE).toContain('schedule("10 0 * * *", { timezone: "Etc/UTC" })');
    expect(GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE).toContain(`customEvent("${GROWTH_DAILY_BRIEF_DUE_EVENT_NAME}")`);
  });

  test("runKey expression matches getGrowthDailyBriefRunKey", () => {
    expect(GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE).toContain('runKey: (event) => "brief:" + (event.type === "schedule" ? yesterdayUtcDateString(event.ts) : event.data.date)');
    expect(getGrowthDailyBriefRunKey("2026-08-03")).toBe("brief:2026-08-03");
  });

  test("uses per-iteration step ids for the wait loop", () => {
    expect(GROWTH_DAILY_BRIEF_WORKFLOW_SOURCE).toContain('step.run("wait-brief-" + poll');
  });
});
