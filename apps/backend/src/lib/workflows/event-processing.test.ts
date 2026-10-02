import type { WorkflowManifestJson } from "@hexclave/shared/dist/interface/workflows";
import { describe, expect, it } from "vitest";
import { didAnySkippedWorkflowResume, workflowDefinitionMatchesEvent, workflowEventRetryDelayMs } from "./event-processing";

describe("workflowDefinitionMatchesEvent", () => {
  it("matches schedule events only to the exact workflow and trigger revision", () => {
    const manifest: WorkflowManifestJson = {
      workflow_id: "daily-report",
      triggers: [{ type: "schedule", cron: "0 9 * * *", timezone: "America/Los_Angeles" }],
      on_conflict: "skip",
      has_run_key: false,
      uses_stdlib: [],
    };
    const event = {
      type: "schedule",
      payload: {
        workflow_id: "daily-report",
        cron: "0 9 * * *",
        timezone: "America/Los_Angeles",
      },
    };

    expect(workflowDefinitionMatchesEvent("daily-report", manifest, event)).toBe(true);
    expect(workflowDefinitionMatchesEvent("other-workflow", manifest, event)).toBe(false);
    expect(workflowDefinitionMatchesEvent("daily-report", {
      ...manifest,
      triggers: [{ type: "schedule", cron: "0 10 * * *", timezone: "America/Los_Angeles" }],
    }, event)).toBe(false);
  });

  it("still matches ordinary event triggers by wire type", () => {
    const manifest: WorkflowManifestJson = {
      workflow_id: "invoice",
      triggers: [{ type: "event", event_type: "custom.invoice-ready" }],
      on_conflict: "skip",
      has_run_key: false,
      uses_stdlib: [],
    };
    expect(workflowDefinitionMatchesEvent("invoice", manifest, {
      type: "custom.invoice-ready",
      payload: null,
    })).toBe(true);
  });
});

describe("workflowEventRetryDelayMs", () => {
  it("backs off poison events exponentially and caps at one hour", () => {
    expect([1, 2, 3, 7, 100].map(workflowEventRetryDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      3_600_000,
      3_600_000,
    ]);
  });
});

describe("didAnySkippedWorkflowResume", () => {
  it("keeps an event pending when a skipped workflow resumed before processing commits", () => {
    expect(didAnySkippedWorkflowResume(new Set(["first", "second"]), new Set(["first"]))).toBe(true);
    expect(didAnySkippedWorkflowResume(new Set(["first", "second"]), new Set(["first", "second"]))).toBe(false);
  });
});
