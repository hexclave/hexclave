import { createHash } from "crypto";
import type { ClickHouseClient } from "@/lib/clickhouse";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

/**
 * Blue/green rebuild for an aggregate rollup fed by a materialized view.
 *
 * Readers query `<database>.<name>`, which is a plain VIEW over a versioned
 * storage table `<name>__v<hash>`. A definition change creates a new version
 * next to the live one and switches the VIEW only once the new version holds
 * all history, so readers never see an empty or partial rollup and the live
 * version keeps receiving writes until the switch.
 *
 * Exactly-once without deduplication (aggregate rows cannot be deduplicated):
 * - the new materialized view only accepts source rows with
 *   `created_at >= cutoff`, and the backfill only reads `created_at < cutoff`;
 * - the cutoff lies in the future when the view is attached, so no row at or
 *   after it can predate the view (`created_at` is the server insert time);
 * - the backfill fills a staging table that is discarded on retry until it is
 *   marked staged, then moves its partitions into storage. MOVE PARTITION is
 *   atomic and removes the partition from staging, so resuming never moves a
 *   partition twice.
 *
 * Materialized views bind to their target by name, so storage tables are never
 * renamed or exchanged; only the reader VIEW changes. A pre-existing plain
 * table at `<name>` (installations created before this mechanism) is swapped
 * for the VIEW with EXCHANGE TABLES, after its own materialized view is dropped.
 */
export type DerivedRollupSpec = {
  database: string,
  /** Name readers query. */
  name: string,
  /** Materialized view that fed `name` when it was still a plain table. */
  legacyMaterializedView: string,
  /** Source table the materialized view reads; must have `created_at DateTime64` and `_partition_id`. */
  sourceTable: string,
  buildStorageTableSql: (fullTableName: string) => string,
  /**
   * SELECT feeding storage. `source` is the FROM expression; `createdAtFilter`
   * is a boolean SQL expression over the source's `created_at` to AND into WHERE.
   */
  buildSelectSql: (options: { source: string, createdAtFilter: string }) => string,
};

export type DerivedRollupTiming = {
  /** How far in the future the cutoff is placed when the new view is attached. */
  cutoffLeadSeconds: number,
  /** How long past the cutoff to wait before reading history, so in-flight inserts land. */
  cutoffSettleSeconds: number,
};

const DEFAULT_TIMING: DerivedRollupTiming = { cutoffLeadSeconds: 30, cutoffSettleSeconds: 5 };
const STATE_TABLE_NAME = "derived_rollup_rebuild_state";

export function computeDerivedRollupVersion(spec: DerivedRollupSpec): string {
  const canonical = JSON.stringify([
    spec.buildStorageTableSql(`${spec.database}.${spec.name}__storage`),
    spec.buildSelectSql({ source: `${spec.database}.${spec.sourceTable}`, createdAtFilter: "1" }),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function getDerivedRollupObjectNames(spec: DerivedRollupSpec, version: string = computeDerivedRollupVersion(spec)) {
  const storage = `${spec.name}__v${version}`;
  return {
    storage,
    materializedView: `${storage}_mv`,
    staging: `${storage}_backfill`,
    legacySwap: `${spec.name}__legacy`,
    prefix: `${spec.name}__`,
  };
}

export function buildCutoffFilterSql(operator: ">=" | "<", cutoff: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(cutoff)) {
    throw new Error(`Invalid rebuild cutoff ${JSON.stringify(cutoff)}`);
  }
  return `created_at ${operator} toDateTime64('${cutoff}', 3, 'UTC')`;
}

type TableRow = { name: string, engine: string, as_select: string };

async function listObjects(client: ClickHouseClient, spec: DerivedRollupSpec): Promise<TableRow[]> {
  const resultSet = await client.query({
    query: `
      SELECT name, engine, as_select
      FROM system.tables
      WHERE database = {database:String}
        AND (name = {name:String} OR startsWith(name, {prefix:String}))
    `,
    query_params: { database: spec.database, name: spec.name, prefix: `${spec.name}__` },
    format: "JSONEachRow",
  });
  return await resultSet.json<TableRow>();
}

async function readStages(client: ClickHouseClient, database: string, storage: string): Promise<Map<string, string>> {
  const resultSet = await client.query({
    query: `
      SELECT stage, toString(cutoff) AS cutoff
      FROM ${database}.${STATE_TABLE_NAME} FINAL
      WHERE storage_table = {storage:String}
    `,
    query_params: { storage },
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ stage: string, cutoff: string }>();
  return new Map(rows.map((row) => [row.stage, row.cutoff]));
}

async function writeStage(client: ClickHouseClient, database: string, storage: string, stage: string, cutoff: string): Promise<void> {
  await client.command({
    query: `
      INSERT INTO ${database}.${STATE_TABLE_NAME} (storage_table, stage, cutoff)
      VALUES ({storage:String}, {stage:String}, toDateTime64({cutoff:String}, 3, 'UTC'))
    `,
    query_params: { storage, stage, cutoff },
  });
}

async function serverNow(client: ClickHouseClient, offsetSeconds: number): Promise<string> {
  const resultSet = await client.query({
    query: "SELECT toString(now64(3, 'UTC') + toIntervalMillisecond({offset:Int64})) AS t",
    query_params: { offset: offsetSeconds * 1000 },
    format: "JSONEachRow",
  });
  const [row] = await resultSet.json<{ t: string }>();
  return row.t;
}

async function partitionsOf(client: ClickHouseClient, database: string, table: string): Promise<string[]> {
  const resultSet = await client.query({
    query: `
      SELECT DISTINCT partition_id
      FROM system.parts
      WHERE database = {database:String} AND table = {table:String} AND active
      ORDER BY partition_id
    `,
    query_params: { database, table },
    format: "JSONEachRow",
  });
  return (await resultSet.json<{ partition_id: string }>()).map((row) => row.partition_id);
}

function readerViewSql(spec: DerivedRollupSpec, viewName: string, storage: string, orReplace: boolean): string {
  return `CREATE ${orReplace ? "OR REPLACE " : ""}VIEW ${spec.database}.${viewName} AS SELECT * FROM ${spec.database}.${storage}`;
}

function readerTargets(row: TableRow | undefined, spec: DerivedRollupSpec, storage: string): boolean {
  if (row?.engine !== "View") return false;
  const match = /\bFROM\s+`?([A-Za-z0-9_]+)`?\.`?([A-Za-z0-9_]+)`?\s*$/.exec(row.as_select.trim());
  return match?.[1] === spec.database && match[2] === storage;
}

async function dropStaleObjects(client: ClickHouseClient, spec: DerivedRollupSpec, keep: ReadonlySet<string>): Promise<void> {
  const stale = (await listObjects(client, spec)).filter((row) => row.name !== spec.name && !keep.has(row.name));
  // Views first so nothing writes into a table while it is being dropped.
  for (const row of stale.filter((r) => r.engine === "MaterializedView" || r.engine === "View")) {
    await client.command({ query: `DROP VIEW IF EXISTS ${spec.database}.${row.name}` });
  }
  for (const row of stale.filter((r) => r.engine !== "MaterializedView" && r.engine !== "View")) {
    await client.command({ query: `DROP TABLE IF EXISTS ${spec.database}.${row.name} SYNC` });
  }
}

async function attachMaterializedView(
  client: ClickHouseClient,
  spec: DerivedRollupSpec,
  names: ReturnType<typeof getDerivedRollupObjectNames>,
  timing: DerivedRollupTiming,
): Promise<string> {
  for (;;) {
    const stages = await readStages(client, spec.database, names.storage);
    const recorded = stages.get("cutoff");
    const exists = (await listObjects(client, spec)).some((row) => row.name === names.materializedView);
    if (recorded !== undefined && exists) return recorded;

    // A recorded cutoff without its view means the process died in between;
    // rows at or after that cutoff may already have been missed, so restart
    // this version from scratch rather than trusting it.
    await client.command({ query: `DROP VIEW IF EXISTS ${spec.database}.${names.materializedView}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${spec.database}.${names.staging} SYNC` });
    await client.command({ query: `DROP TABLE IF EXISTS ${spec.database}.${names.storage} SYNC` });
    await client.command({
      query: `ALTER TABLE ${spec.database}.${STATE_TABLE_NAME} DELETE WHERE storage_table = {storage:String}`,
      query_params: { storage: names.storage },
      clickhouse_settings: { mutations_sync: "2" },
    });

    await client.command({ query: spec.buildStorageTableSql(`${spec.database}.${names.storage}`) });
    const cutoff = await serverNow(client, timing.cutoffLeadSeconds);
    await writeStage(client, spec.database, names.storage, "cutoff", cutoff);
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${spec.database}.${names.materializedView}
        TO ${spec.database}.${names.storage}
        AS ${spec.buildSelectSql({ source: `${spec.database}.${spec.sourceTable}`, createdAtFilter: buildCutoffFilterSql(">=", cutoff) })}
      `,
    });
    if (await serverNow(client, 0) < cutoff) return cutoff;
    // Attaching took longer than the lead time; the same reasoning applies.
    await client.command({ query: `DROP VIEW IF EXISTS ${spec.database}.${names.materializedView}` });
  }
}

async function waitForCutoff(client: ClickHouseClient, cutoff: string, timing: DerivedRollupTiming): Promise<void> {
  for (;;) {
    const settled = await serverNow(client, -timing.cutoffSettleSeconds);
    if (settled >= cutoff) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function backfill(
  client: ClickHouseClient,
  spec: DerivedRollupSpec,
  names: ReturnType<typeof getDerivedRollupObjectNames>,
  cutoff: string,
  timing: DerivedRollupTiming,
): Promise<void> {
  const stages = await readStages(client, spec.database, names.storage);
  if (stages.has("complete")) return;

  if (!stages.has("staged")) {
    await waitForCutoff(client, cutoff, timing);
    await client.command({ query: `DROP TABLE IF EXISTS ${spec.database}.${names.staging} SYNC` });
    await client.command({ query: spec.buildStorageTableSql(`${spec.database}.${names.staging}`) });
    const sourcePartitions = await partitionsOf(client, spec.database, spec.sourceTable);
    console.log(`[Clickhouse] Rebuilding ${spec.database}.${spec.name} from ${sourcePartitions.length} source partition(s)`);
    for (const partition of sourcePartitions) {
      await client.command({
        query: `
          INSERT INTO ${spec.database}.${names.staging}
          ${spec.buildSelectSql({
            source: `(SELECT * FROM ${spec.database}.${spec.sourceTable} WHERE _partition_id = {partition:String})`,
            createdAtFilter: buildCutoffFilterSql("<", cutoff),
          })}
        `,
        query_params: { partition },
        clickhouse_settings: { max_threads: 2, max_insert_threads: "2" },
      });
    }
    await writeStage(client, spec.database, names.storage, "staged", cutoff);
  }

  for (const partition of await partitionsOf(client, spec.database, names.staging)) {
    await client.command({
      query: `ALTER TABLE ${spec.database}.${names.staging} MOVE PARTITION ID {partition:String} TO TABLE ${spec.database}.${names.storage}`,
      query_params: { partition },
    });
  }
  await writeStage(client, spec.database, names.storage, "complete", cutoff);
}

async function switchReaders(
  client: ClickHouseClient,
  spec: DerivedRollupSpec,
  names: ReturnType<typeof getDerivedRollupObjectNames>,
): Promise<void> {
  const reader = (await listObjects(client, spec)).find((row) => row.name === spec.name);
  if (reader === undefined) {
    await client.command({ query: readerViewSql(spec, spec.name, names.storage, false).replace("CREATE VIEW", "CREATE VIEW IF NOT EXISTS") });
  } else if (reader.engine === "View") {
    await client.command({ query: readerViewSql(spec, spec.name, names.storage, true) });
  } else {
    await client.command({ query: readerViewSql(spec, names.legacySwap, names.storage, true) });
    await client.command({ query: `DROP VIEW IF EXISTS ${spec.database}.${spec.legacyMaterializedView}` });
    await client.command({ query: `EXCHANGE TABLES ${spec.database}.${spec.name} AND ${spec.database}.${names.legacySwap}` });
  }
}

/**
 * Brings the rollup to the current definition. Returns true if a rebuild ran.
 * Idempotent and resumable: every step can be retried after a crash.
 */
export async function ensureDerivedRollupCurrent(
  client: ClickHouseClient,
  spec: DerivedRollupSpec,
  timing: DerivedRollupTiming = DEFAULT_TIMING,
): Promise<boolean> {
  const names = getDerivedRollupObjectNames(spec);
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${spec.database}.${STATE_TABLE_NAME} (
        storage_table String,
        stage LowCardinality(String),
        cutoff DateTime64(3, 'UTC'),
        recorded_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE ReplacingMergeTree(recorded_at)
      ORDER BY (storage_table, stage)
    `,
  });

  const objects = await listObjects(client, spec);
  const reader = objects.find((row) => row.name === spec.name);
  const current = readerTargets(reader, spec, names.storage)
    && objects.some((row) => row.name === names.materializedView);
  if (!current) {
    const cutoff = await attachMaterializedView(client, spec, names, timing);
    await backfill(client, spec, names, cutoff, timing);
    await switchReaders(client, spec, names);
  }

  const after = await listObjects(client, spec);
  if (!readerTargets(after.find((row) => row.name === spec.name), spec, names.storage)) {
    throwErr(`[Clickhouse] ${spec.database}.${spec.name} does not read from ${names.storage} after rebuild`);
  }
  await dropStaleObjects(client, spec, new Set([names.storage, names.materializedView]));
  return !current;
}
