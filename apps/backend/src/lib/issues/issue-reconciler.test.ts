import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { describe, expect, it } from "vitest";
import { buildIssueRebuildQuery, completeBatchRebuildOptions, groupingProvenanceForReconciliation, ISSUE_RECONCILER_CANDIDATE_BATCHES_SQL } from "./issue-reconciler";

describe("issue reconciliation boundaries", () => {
  it("selects the oldest unapplied batches first when the candidate cap is hit", () => {
    expect(ISSUE_RECONCILER_CANDIDATE_BATCHES_SQL).toContain("ORDER BY min(event_at) ASC");
  });

  it("uses the discovery window only to select batches, then rebuilds the complete batch", () => {
    const options = completeBatchRebuildOptions({
      projectId: "project-1",
      branchId: "main",
      batchIds: ["batch-1"],
      from: new Date("2026-08-06T12:00:00Z"),
      to: new Date("2026-08-06T13:00:00Z"),
    });

    expect(options).toEqual({ projectId: "project-1", branchId: "main", batchIds: ["batch-1"] });
    expect(options).not.toHaveProperty("from");
    expect(options).not.toHaveProperty("to");
  });

  it("repairs legacy empty provenance from its durable owner hash and config", () => {
    expect(groupingProvenanceForReconciliation({
      issue_hash: "owner-hash",
      grouping_config: "hexclave-js:2026-08-01",
      grouping_provenance: "[]",
      selected_issue_variant: "app",
    })).toEqual([{
      hash: "owner-hash",
      role: "primary",
      config_id: "hexclave-js:2026-08-01",
      variant: "app",
      fingerprint: { type: "default", source: "degraded", tokens: [], resolved_tokens: [] },
    }]);
  });

  it("executes the occurrence rebuild query without aggregate alias collisions", async () => {
    const result = await getSharedClickhouseAdminClient().query({
      query: buildIssueRebuildQuery(""),
      query_params: {
        projectId: "issue-reconciler-query-regression",
        branchId: "main",
        batchIds: ["issue-reconciler-query-regression"],
      },
      format: "JSONEachRow",
    });

    await expect(result.json()).resolves.toEqual([]);
  });
});
