import { getClickhouseAdminClient, type ClickHouseClient } from "@/lib/clickhouse";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildCutoffFilterSql,
  computeDerivedRollupVersion,
  ensureDerivedRollupCurrent,
  getDerivedRollupObjectNames,
  type DerivedRollupSpec,
} from "./clickhouse-derived-rebuild";
import {
  buildIssueOccurrenceRollupCreateTableSql,
  buildIssueOccurrenceRollupMvSql,
  buildIssueOccurrenceRollupSpec,
  buildTelemetryCreateTableSql,
} from "./clickhouse-migrations";

const FAST_TIMING = { cutoffLeadSeconds: 2, cutoffSettleSeconds: 1 };

describe("derived rollup versioning", () => {
  const spec = buildIssueOccurrenceRollupSpec("analytics_internal");

  test("version is stable and changes with either the storage layout or the SELECT", () => {
    const version = computeDerivedRollupVersion(spec);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(computeDerivedRollupVersion(spec)).toBe(version);
    expect(computeDerivedRollupVersion({
      ...spec,
      buildStorageTableSql: (name) => spec.buildStorageTableSql(name).replace("INTERVAL 90", "INTERVAL 30"),
    })).not.toBe(version);
    expect(computeDerivedRollupVersion({
      ...spec,
      buildSelectSql: (options) => spec.buildSelectSql(options).replace("toStartOfHour", "toStartOfDay"),
    })).not.toBe(version);
  });

  test("all rebuild objects share the reader's prefix and never collide with it", () => {
    const names = getDerivedRollupObjectNames(spec, "abc");
    expect(names).toEqual({
      storage: "issue_occurrence_rollup__vabc",
      materializedView: "issue_occurrence_rollup__vabc_mv",
      staging: "issue_occurrence_rollup__vabc_backfill",
      legacySwap: "issue_occurrence_rollup__legacy",
      prefix: "issue_occurrence_rollup__",
    });
  });

  test("cutoff filters reject anything but a ClickHouse DateTime64(3) literal", () => {
    expect(buildCutoffFilterSql(">=", "2026-01-02 03:04:05.678")).toBe("created_at >= toDateTime64('2026-01-02 03:04:05.678', 3, 'UTC')");
    expect(() => buildCutoffFilterSql("<", "2026-01-02' OR 1 --")).toThrow(/Invalid rebuild cutoff/);
  });
});

describe("ensureDerivedRollupCurrent (integration)", () => {
  const database = `derived_rebuild_test_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;
  let inserted = 0;

  beforeAll(async () => {
    client = getClickhouseAdminClient();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: buildTelemetryCreateTableSql(`${database}.events`) });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  const insertErrors = async (count: number) => {
    const rows = Array.from({ length: count }, (_, i) => `('$error', now64(3), '{}', 'p', 'b', 'u${i % 3}', 'api', 'production', 'hash-${i % 2}')`);
    await client.command({
      query: `INSERT INTO ${database}.events (event_type, event_at, data, project_id, branch_id, user_id, service_name, deployment_environment_name, issue_hash) VALUES ${rows.join(", ")}`,
    });
    inserted += count;
  };

  const readerTotals = async () => {
    const resultSet = await client.query({
      query: `SELECT sum(occurrences) AS occurrences, uniqMerge(users_state) AS users FROM ${database}.issue_occurrence_rollup WHERE project_id = 'p'`,
      format: "JSONEachRow",
    });
    const [row] = await resultSet.json<{ occurrences: string, users: string }>();
    return { occurrences: Number(row.occurrences), users: Number(row.users) };
  };

  const objects = async () => {
    const resultSet = await client.query({
      query: "SELECT name, engine FROM system.tables WHERE database = {database:String} AND startsWith(name, 'issue_occurrence_rollup') ORDER BY name",
      query_params: { database },
      format: "JSONEachRow",
    });
    return await resultSet.json<{ name: string, engine: string }>();
  };

  // Keeps ingesting while the rebuild runs, and checks that readers never see
  // fewer occurrences than had been counted before the rebuild started.
  const rebuildUnderLoad = async (spec: DerivedRollupSpec) => {
    const floor = (await readerTotals()).occurrences;
    let done = false;
    let minimumSeen = Number.POSITIVE_INFINITY;
    const load = (async () => {
      while (!done) {
        await insertErrors(5);
        minimumSeen = Math.min(minimumSeen, (await readerTotals()).occurrences);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    const rebuilt = await ensureDerivedRollupCurrent(client, spec, FAST_TIMING);
    done = true;
    await load;
    expect(minimumSeen).toBeGreaterThanOrEqual(floor);
    return rebuilt;
  };

  test("adopts a legacy table without double counting, while ingest keeps running", async () => {
    await client.command({ query: buildIssueOccurrenceRollupCreateTableSql(database) });
    await client.command({ query: buildIssueOccurrenceRollupMvSql(database) });
    await insertErrors(12);
    expect((await readerTotals()).occurrences).toBe(12);

    expect(await rebuildUnderLoad(buildIssueOccurrenceRollupSpec(database))).toBe(true);
    await insertErrors(4);

    expect(await readerTotals()).toEqual({ occurrences: inserted, users: 3 });
    const names = getDerivedRollupObjectNames(buildIssueOccurrenceRollupSpec(database));
    expect(await objects()).toEqual([
      { name: "issue_occurrence_rollup", engine: "View" },
      { name: names.storage, engine: "AggregatingMergeTree" },
      { name: names.materializedView, engine: "MaterializedView" },
    ]);
  });

  test("is a no-op when already current", async () => {
    const before = await objects();
    expect(await ensureDerivedRollupCurrent(client, buildIssueOccurrenceRollupSpec(database), FAST_TIMING)).toBe(false);
    expect(await objects()).toEqual(before);
  });

  test("rebuilds a changed definition next to the live one and switches without gaps or duplicates", async () => {
    const base = buildIssueOccurrenceRollupSpec(database);
    const changed: DerivedRollupSpec = {
      ...base,
      buildSelectSql: (options) => base.buildSelectSql(options).replace("toStartOfHour(event_at)", "toStartOfDay(event_at)"),
    };
    expect(await rebuildUnderLoad(changed)).toBe(true);
    await insertErrors(3);

    expect(await readerTotals()).toEqual({ occurrences: inserted, users: 3 });
    const names = getDerivedRollupObjectNames(changed);
    expect(await objects()).toEqual([
      { name: "issue_occurrence_rollup", engine: "View" },
      { name: names.storage, engine: "AggregatingMergeTree" },
      { name: names.materializedView, engine: "MaterializedView" },
    ]);
  });

  test("restarts a version whose cutoff was recorded but whose view never attached", async () => {
    const base = buildIssueOccurrenceRollupSpec(database);
    const next: DerivedRollupSpec = {
      ...base,
      buildStorageTableSql: (name) => base.buildStorageTableSql(name).replace("INTERVAL 90", "INTERVAL 91"),
    };
    const names = getDerivedRollupObjectNames(next);
    // A process that died between recording the cutoff and attaching the view
    // leaves a storage table that missed every row since that cutoff.
    await client.command({ query: next.buildStorageTableSql(`${database}.${names.storage}`) });
    await client.command({
      query: `INSERT INTO ${database}.derived_rollup_rebuild_state (storage_table, stage, cutoff) VALUES ({storage:String}, 'cutoff', now64(3) - INTERVAL 1 HOUR)`,
      query_params: { storage: names.storage },
    });

    expect(await rebuildUnderLoad(next)).toBe(true);
    expect(await readerTotals()).toEqual({ occurrences: inserted, users: 3 });
  });
});
