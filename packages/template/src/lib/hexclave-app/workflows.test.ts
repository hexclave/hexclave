import type { WorkflowSummaryJson, WorkflowVersionJson } from "@hexclave/shared/dist/interface/workflows";
import { describe, expect, it } from "vitest";
import { adminWorkflowFromCrud, adminWorkflowVersionFromCrud } from "./workflows";

describe("adminWorkflowFromCrud", () => {
  it("preserves the retained total run count separately from in-flight counts", () => {
    const workflow: WorkflowSummaryJson = {
      id: "daily-report",
      display_name: "Daily report",
      latest_version: 3,
      triggers: [{ type: "schedule", cron: "0 9 * * *", timezone: "UTC" }],
      is_paused: false,
      paused_at_millis: null,
      stats: {
        total_runs: 12,
        active_runs: 2,
        sleeping_runs: 1,
        failed_7d: 3,
        run_volume_14d: Array.from({ length: 14 }, () => 0),
      },
      created_at_millis: 1000,
      last_deployed_at_millis: 2000,
    };

    expect(adminWorkflowFromCrud(workflow).stats).toMatchObject({
      totalRuns: 12,
      activeRuns: 2,
      sleepingRuns: 1,
    });
  });
});

describe("adminWorkflowVersionFromCrud", () => {
  it("preserves the deployment source hash", () => {
    const version: WorkflowVersionJson = {
      workflow_id: "daily-report",
      version: 3,
      source: "export default 1",
      source_hash: "0123456789abcdef",
      runtime_env_version: "v1",
      is_latest: true,
      in_flight_runs: 2,
      created_at_millis: 1234,
    };

    expect(adminWorkflowVersionFromCrud(version)).toMatchObject({
      workflowId: "daily-report",
      version: 3,
      sourceHash: "0123456789abcdef",
    });
  });
});
