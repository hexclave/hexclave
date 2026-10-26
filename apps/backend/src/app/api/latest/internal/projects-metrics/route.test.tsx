import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyProjectMetricsRows, getProjectTotalUsersQuery } from "./route";

type UserRowVersion = {
  project_id: string,
  branch_id?: string,
  id: string,
  signed_up_at: string,
  is_anonymous: 0 | 1,
  sync_is_deleted: 0 | 1,
  sync_sequence_id: number,
};

describe("project total users query", () => {
  const client = getClickhouseAdminClient();
  const table = `analytics_internal.projects_metrics_test_${randomUUID().replaceAll("-", "")}`;
  const projectA = randomUUID();
  const projectAnonOnly = randomUUID();
  const projectC = randomUUID();
  const projectNotRequested = randomUUID();
  const ids = Object.fromEntries(
    ["plain", "anonymous", "updated", "deleted", "recreated", "upgradedAcrossPartitions", "staleRealCopy",
      "downgraded", "outOfOrder", "otherBranch", "anonOnly", "upgradedThenDeleted", "cPlain", "notRequested"]
      .map((name) => [name, randomUUID()]),
  );

  // Each version is inserted on its own with merges stopped, so every version lives in a separate part
  // and the query has to deduplicate them itself rather than relying on background merges.
  const versions: UserRowVersion[] = [
    { project_id: projectA, id: ids.plain, signed_up_at: "2026-09-10", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 1 },
    { project_id: projectA, id: ids.anonymous, signed_up_at: "2026-09-10", is_anonymous: 1, sync_is_deleted: 0, sync_sequence_id: 2 },
    ...[3, 4, 5].map((seq) => ({ project_id: projectA, id: ids.updated, signed_up_at: "2026-08-01", is_anonymous: 0 as const, sync_is_deleted: 0 as const, sync_sequence_id: seq })),
    { project_id: projectA, id: ids.deleted, signed_up_at: "2026-08-01", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 6 },
    { project_id: projectA, id: ids.deleted, signed_up_at: "2026-08-01", is_anonymous: 0, sync_is_deleted: 1, sync_sequence_id: 7 },
    { project_id: projectA, id: ids.recreated, signed_up_at: "2026-08-01", is_anonymous: 0, sync_is_deleted: 1, sync_sequence_id: 8 },
    { project_id: projectA, id: ids.recreated, signed_up_at: "2026-08-01", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 9 },
    // Anonymous -> real upgrades reset signed_up_at, so the newer version lands in a different monthly partition.
    { project_id: projectA, id: ids.upgradedAcrossPartitions, signed_up_at: "2025-01-15", is_anonymous: 1, sync_is_deleted: 0, sync_sequence_id: 10 },
    { project_id: projectA, id: ids.upgradedAcrossPartitions, signed_up_at: "2026-09-15", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 11 },
    // Sync can skip the intermediate anonymous version, leaving a stale real copy in the old partition.
    { project_id: projectA, id: ids.staleRealCopy, signed_up_at: "2025-02-15", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 12 },
    { project_id: projectA, id: ids.staleRealCopy, signed_up_at: "2026-09-15", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 13 },
    { project_id: projectA, id: ids.downgraded, signed_up_at: "2025-03-15", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 14 },
    { project_id: projectA, id: ids.downgraded, signed_up_at: "2025-03-15", is_anonymous: 1, sync_is_deleted: 0, sync_sequence_id: 15 },
    // The newer (deleted) version is inserted before the older one; the higher sequence id must still win.
    { project_id: projectA, id: ids.outOfOrder, signed_up_at: "2026-07-01", is_anonymous: 0, sync_is_deleted: 1, sync_sequence_id: 17 },
    { project_id: projectA, id: ids.outOfOrder, signed_up_at: "2026-07-01", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 16 },
    { project_id: projectA, branch_id: "other-branch", id: ids.otherBranch, signed_up_at: "2026-09-10", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 18 },
    { project_id: projectAnonOnly, id: ids.anonOnly, signed_up_at: "2026-09-10", is_anonymous: 1, sync_is_deleted: 0, sync_sequence_id: 19 },
    { project_id: projectC, id: ids.upgradedThenDeleted, signed_up_at: "2025-01-15", is_anonymous: 1, sync_is_deleted: 0, sync_sequence_id: 20 },
    { project_id: projectC, id: ids.upgradedThenDeleted, signed_up_at: "2026-09-15", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 21 },
    { project_id: projectC, id: ids.upgradedThenDeleted, signed_up_at: "2026-09-15", is_anonymous: 0, sync_is_deleted: 1, sync_sequence_id: 22 },
    { project_id: projectC, id: ids.cPlain, signed_up_at: "2024-06-01", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 23 },
    { project_id: projectNotRequested, id: ids.notRequested, signed_up_at: "2026-09-10", is_anonymous: 0, sync_is_deleted: 0, sync_sequence_id: 24 },
  ];

  const queryParams = {
    projectIds: [projectA, projectAnonOnly, projectC],
    branchId: "main",
  };

  async function queryTotals(query: string) {
    const result = await client.query({ query, query_params: queryParams, format: "JSONEachRow" });
    const rows = await result.json<{ projectId: string, totalUsers: string | number }>();
    return Object.fromEntries(rows.map((row) => [row.projectId, Number(row.totalUsers)]));
  }

  beforeAll(async () => {
    await client.command({ query: `CREATE TABLE ${table} AS analytics_internal.users` });
    await client.command({ query: `SYSTEM STOP MERGES ${table}` });
    for (const version of versions) {
      await client.insert({
        table,
        values: [{ branch_id: "main", ...version, signed_up_at: `${version.signed_up_at} 12:00:00.000` }],
        format: "JSONEachRow",
      });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
    await client.close();
  });

  it("keeps every row version in its own part", async () => {
    const result = await client.query({
      query: `SELECT count() AS parts FROM system.parts WHERE active AND concat(database, '.', table) = {table:String}`,
      query_params: { table },
      format: "JSONEachRow",
    });
    const [{ parts }] = await result.json<{ parts: string | number }>();
    expect(Number(parts)).toBe(versions.length);
  });

  it("counts each user's latest version: non-anonymous, not deleted, requested project and branch only", async () => {
    expect(await queryTotals(getProjectTotalUsersQuery(table))).toEqual({
      // plain, updated, recreated, upgradedAcrossPartitions, staleRealCopy
      [projectA]: 5,
      // cPlain; upgradedThenDeleted is excluded
      [projectC]: 1,
    });
  });

  it("matches the FINAL-based query it replaced", async () => {
    const finalTotals = await queryTotals(`
      SELECT project_id AS projectId, count() AS totalUsers
      FROM ${table} FINAL
      WHERE project_id IN {projectIds:Array(String)}
        AND branch_id = {branchId:String}
        AND sync_is_deleted = 0
        AND is_anonymous = 0
      GROUP BY project_id
    `);
    expect(await queryTotals(getProjectTotalUsersQuery(table))).toEqual(finalTotals);
  });
});

describe("internal projects metrics helpers", () => {
  it("applies total user and daily signup rows through a Map and skips unknown projects", () => {
    const byProject = new Map([
      ["project-a", {
        total_users: 0,
        daily_signups: [
          { date: "2026-05-01", activity: 0 },
          { date: "2026-05-02", activity: 0 },
        ],
      }],
      ["__proto__", {
        total_users: 0,
        daily_signups: [
          { date: "2026-05-01", activity: 0 },
          { date: "2026-05-02", activity: 0 },
        ],
      }],
    ]);

    applyProjectMetricsRows(
      byProject,
      [
        { projectId: "project-a", totalUsers: 12 },
        { projectId: "__proto__", totalUsers: 7 },
        { projectId: "missing-project", totalUsers: 99 },
      ],
      [
        { projectId: "project-a", day: "2026-05-01", signups: 2 },
        { projectId: "__proto__", day: "2026-05-02", signups: 5 },
        { projectId: "missing-project", day: "2026-05-01", signups: 99 },
      ],
    );

    expect(Object.fromEntries(byProject)).toMatchInlineSnapshot(`
      {
        "__proto__": {
          "daily_signups": [
            {
              "activity": 0,
              "date": "2026-05-01",
            },
            {
              "activity": 5,
              "date": "2026-05-02",
            },
          ],
          "total_users": 7,
        },
        "project-a": {
          "daily_signups": [
            {
              "activity": 2,
              "date": "2026-05-01",
            },
            {
              "activity": 0,
              "date": "2026-05-02",
            },
          ],
          "total_users": 12,
        },
      }
    `);
  });
});
