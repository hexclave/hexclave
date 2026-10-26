import type { WorkflowManifestJson } from "@hexclave/shared/dist/interface/workflows";
import { describe, expect, it } from "vitest";
import { partitionClaimedWorkflowEvents, workflowDefinitionMatchesEvent, workflowEventRetryDelayMs } from "./event-processing";

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

describe("partitionClaimedWorkflowEvents", () => {
  const manifestFor = (eventType: string): WorkflowManifestJson => ({
    workflow_id: "ignored",
    triggers: [{ type: "event", event_type: eventType }],
    on_conflict: "skip",
    has_run_key: false,
    uses_stdlib: [],
  });

  it("separates events nothing listens to and keeps each tenancy's dispatch order", () => {
    const definitionsByTenancy = new Map([
      ["tenancy-a", [
        { workflowId: "welcome", manifest: manifestFor("user.created") },
        { workflowId: "audit", manifest: manifestFor("user.created") },
      ]],
      ["tenancy-b", [{ workflowId: "cleanup", manifest: manifestFor("user.deleted") }]],
    ]);
    const events = [
      { tenancyId: "tenancy-a", id: "a1", type: "user.created", payload: {} },
      { tenancyId: "tenancy-b", id: "b1", type: "user.created", payload: {} },
      { tenancyId: "tenancy-c", id: "c1", type: "user.created", payload: {} },
      { tenancyId: "tenancy-a", id: "a2", type: "user.updated", payload: {} },
      { tenancyId: "tenancy-a", id: "a3", type: "user.created", payload: {} },
      { tenancyId: "tenancy-b", id: "b2", type: "user.deleted", payload: {} },
    ];

    const { unmatched, matchedByTenancy } = partitionClaimedWorkflowEvents(events, definitionsByTenancy);

    expect(unmatched.map((event) => event.id)).toEqual(["b1", "c1", "a2"]);
    expect([...matchedByTenancy.keys()]).toEqual(["tenancy-a", "tenancy-b"]);
    expect(matchedByTenancy.get("tenancy-a")?.map((entry) => [entry.event.id, entry.matching.map((definition) => definition.workflowId)])).toEqual([
      ["a1", ["welcome", "audit"]],
      ["a3", ["welcome", "audit"]],
    ]);
    expect(matchedByTenancy.get("tenancy-b")?.map((entry) => entry.event.id)).toEqual(["b2"]);
  });
});
