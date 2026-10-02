import { createHash } from "crypto";
import { getClickhouseAdminClient, type ClickHouseClient } from "@/lib/clickhouse";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

export async function runClickhouseMigrations() {
  const start = performance.now();
  console.log("[Clickhouse] Running Clickhouse migrations...");
  const client = getClickhouseAdminClient();
  const clickhouseExternalPassword = getEnvVariable("STACK_CLICKHOUSE_EXTERNAL_PASSWORD");

  // Setup — database, user, sync metadata
  await client.command({ query: EXTERNAL_ANALYTICS_DB_SQL });
  await Promise.all([
    client.command({
      query: "CREATE USER IF NOT EXISTS limited_user IDENTIFIED WITH sha256_password BY {clickhouseExternalPassword:String}",
      query_params: { clickhouseExternalPassword },
    }),
    client.command({ query: SYNC_METADATA_TABLE_SQL }),
  ]);

  // Removing an app's schema definitions only keeps fresh installations clean. Drop the
  // retired Growth views first, then their backing tables, so existing installations converge
  // to the same schema without relying on dependencies or CASCADE behavior.
  await Promise.all([
    client.command({ query: "DROP VIEW IF EXISTS default.growth_daily_metrics" }),
    client.command({ query: "DROP VIEW IF EXISTS default.growth_daily_ad_metrics" }),
  ]);
  await Promise.all([
    client.command({ query: "DROP TABLE IF EXISTS analytics_internal.growth_daily_metrics" }),
    client.command({ query: "DROP TABLE IF EXISTS analytics_internal.growth_daily_ad_metrics" }),
  ]);

  const spansSubsystemFingerprint = computeSpansSubsystemFingerprint();
  await resetSpansSubsystemIfFingerprintChanged(client, spansSubsystemFingerprint);

  // Apply the same fail-closed validation to the derived issue rollup and its
  // materialized view only — never to the non-derivable telemetry columns.
  const issuesSubsystemFingerprint = computeIssuesSubsystemFingerprint();
  await resetIssuesSubsystemIfFingerprintChanged(client, issuesSubsystemFingerprint);

  // Create all tables in parallel
  await Promise.all([
    client.command({ query: TELEMETRY_TABLE_BASE_SQL }),
    client.command({ query: SPAN_EVENTS_TABLE_BASE_SQL }),
    client.command({ query: USERS_TABLE_BASE_SQL }),
    client.command({ query: CONTACT_CHANNELS_TABLE_BASE_SQL }),
    client.command({ query: TEAMS_TABLE_BASE_SQL }),
    client.command({ query: TEAM_MEMBER_PROFILES_TABLE_BASE_SQL }),
    client.command({ query: TEAM_PERMISSIONS_TABLE_BASE_SQL }),
    client.command({ query: TEAM_INVITATIONS_TABLE_BASE_SQL }),
    client.command({ query: EMAIL_OUTBOXES_TABLE_BASE_SQL }),

    client.command({ query: PROJECT_PERMISSIONS_TABLE_BASE_SQL }),
    client.command({ query: NOTIFICATION_PREFERENCES_TABLE_BASE_SQL }),
    client.command({ query: REFRESH_TOKENS_TABLE_BASE_SQL }),
    client.command({ query: CONNECTED_ACCOUNTS_TABLE_BASE_SQL }),
    client.command({ query: CLICKMAP_EVENTS_TABLE_SQL }),
    client.command({ query: SPANS_TABLE_BASE_SQL }),
    client.command({ query: PAGE_VIEWS_TABLE_SQL }),
    client.command({ query: SPAN_LINKS_TABLE_SQL }),
    client.command({ query: SPAN_WRITES_TABLE_SQL }),
    client.command({ query: TRACE_ROOTS_TABLE_SQL }),
    client.command({ query: TRACE_SERVICES_TABLE_SQL }),
    client.command({ query: ISSUE_OCCURRENCE_ROLLUP_TABLE_SQL }),
    client.command({ query: OTEL_METRICS_TABLE_BASE_SQL }),
  ]);

  await client.command({ query: CLICKMAP_EVENTS_ADD_DEAD_COLUMN_SQL });

  // Existing databases may predate columns that the base schemas above now
  // declare, and `CREATE TABLE IF NOT EXISTS` will not add them. These ALTERs
  // must run before the dependent materialized views and `default.*` views,
  // which name every column explicitly and would otherwise fail to create and
  // take the whole boot down with them.
  await Promise.all([
    client.command({ query: TELEMETRY_SCHEMA_UPGRADE_SQL }),
    client.command({ query: SPAN_EVENTS_SCHEMA_UPGRADE_SQL }),
    client.command({ query: SPANS_SCHEMA_UPGRADE_SQL }),
    client.command({ query: PAGE_VIEWS_SCHEMA_UPGRADE_SQL }),
    client.command({ query: SPAN_LINKS_SCHEMA_UPGRADE_SQL }),
    client.command({ query: TRACE_ROOTS_SCHEMA_UPGRADE_SQL }),
    client.command({ query: TRACE_SERVICES_SCHEMA_UPGRADE_SQL }),
    client.command({ query: OTEL_METRICS_SCHEMA_UPGRADE_SQL }),
  ]);

  // The public batch id is also the ClickHouse insert idempotency key. A
  // single wire batch may target events, logs, and spans independently, so
  // every physical destination must remember enough recent insert tokens for
  // a retry to finish only the destination that previously failed.
  await Promise.all(TELEMETRY_INSERT_TABLES.map((table) => client.command({
    query: buildTelemetryInsertDeduplicationSettingSql(table),
  })));

  await Promise.all([
    // events and clickmap_events predate this migration and hold production
    // data with no retention policy. Retroactively applying the 90-day TTL
    // here would irreversibly delete everything older than the window on the
    // first boot after deploy, and a rollback could not bring it back. Held
    // back until retention is decided as its own change; the tables new in
    // this migration keep the TTL from their CREATE statements because they
    // start empty.
    ensureTableTtl(client, { database: "analytics_internal", table: "span_events", ttlDays: TELEMETRY_TTL_DAYS }),
    ensureTableTtl(client, { database: "analytics_internal", table: "spans", ttlDays: TELEMETRY_TTL_DAYS }),
    ensureTableTtl(client, { database: "analytics_internal", table: "page_views", ttlDays: TELEMETRY_TTL_DAYS, timestampColumn: "started_at" }),
    ensureTableTtl(client, { database: "analytics_internal", table: "span_links", ttlDays: TELEMETRY_TTL_DAYS }),
    ensureTableTtl(client, { database: "analytics_internal", table: "trace_roots", ttlDays: TELEMETRY_TTL_DAYS }),
    ensureTableTtl(client, { database: "analytics_internal", table: "trace_services", ttlDays: TELEMETRY_TTL_DAYS }),
    ensureTableTtl(client, { database: "analytics_internal", table: "metrics", ttlDays: TELEMETRY_TTL_DAYS }),
    ensureTableTtl(client, { database: "analytics_internal", table: "span_writes", ttlDays: SPAN_WRITES_TTL_DAYS }),
    ensureSkipIndex(client, {
      database: "analytics_internal",
      table: "events",
      indexName: EVENTS_EVENT_TYPE_INDEX_NAME,
      indexDefinitionSql: EVENTS_EVENT_TYPE_INDEX_DEFINITION_SQL,
      materializeHistoricalParts: false,
    }),
    ensureSkipIndex(client, {
      database: "analytics_internal",
      table: "events",
      indexName: LOGS_ISSUE_HASH_INDEX_NAME,
      indexDefinitionSql: LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL,
      materializeHistoricalParts: false,
    }),
  ]);

  // Clickmap materialized view depends on the events table existing; create after the ALTER above
  // so the view sees the replay columns. IF NOT EXISTS makes this idempotent across reboots.
  await client.command({ query: CLICKMAP_EVENTS_MV_SQL });
  await client.command({ query: CLICKMAP_EVENTS_MV_UPGRADE_SQL });
  await Promise.all([
    client.command({ query: PAGE_VIEWS_MV_SQL }),
    client.command({ query: TRACE_ROOTS_MV_SQL }),
    client.command({ query: TRACE_SERVICES_MV_SQL }),
    client.command({ query: SPAN_WRITES_MV_SQL }),
    client.command({ query: ISSUE_OCCURRENCE_ROLLUP_MV_SQL }),
  ]);

  // Only after the materialized views above are attached, so no span written
  // during the backfill can slip through unrecorded.
  // Each helper reads historical spans. Run them sequentially so a large
  // installation never starts two source-table backfills competing for the
  // same disk and merge bandwidth.
  await backfillDerivedSpanTable(client, { table: "page_views", selectSql: PAGE_VIEWS_SOURCE_SELECT_SQL, targetColumns: PAGE_VIEWS_COLUMNS });
  await backfillDerivedSpanTable(client, { table: "trace_roots", selectSql: TRACE_ROOTS_SOURCE_SELECT_SQL, targetColumns: TRACE_ROOTS_COLUMNS });
  await backfillDerivedSpanTable(client, { table: "trace_services", selectSql: TRACE_SERVICES_SOURCE_SELECT_SQL, targetColumns: TRACE_SERVICES_COLUMNS });

  await Promise.all([
    client.command({ query: EVENTS_VIEW_SQL }),
    client.command({ query: LOGS_VIEW_SQL }),
    client.command({ query: ERRORS_VIEW_SQL }),
    client.command({ query: SPAN_EVENTS_VIEW_SQL }),
    client.command({ query: USERS_VIEW_SQL }),
    client.command({ query: CONTACT_CHANNELS_VIEW_SQL }),
    client.command({ query: TEAMS_VIEW_SQL }),
    client.command({ query: TEAM_MEMBER_PROFILES_VIEW_SQL }),
    client.command({ query: TEAM_PERMISSIONS_VIEW_SQL }),
    client.command({ query: TEAM_INVITATIONS_VIEW_SQL }),
    client.command({ query: EMAIL_OUTBOXES_VIEW_SQL }),

    client.command({ query: PROJECT_PERMISSIONS_VIEW_SQL }),
    client.command({ query: NOTIFICATION_PREFERENCES_VIEW_SQL }),
    client.command({ query: REFRESH_TOKENS_VIEW_SQL }),
    client.command({ query: CONNECTED_ACCOUNTS_VIEW_SQL }),
    client.command({ query: SPANS_VIEW_SQL }),
    client.command({ query: PAGE_VIEWS_VIEW_SQL }),
    client.command({ query: SPAN_LINKS_VIEW_SQL }),
    client.command({ query: TRACE_ROOTS_VIEW_SQL }),
    client.command({ query: TRACE_SERVICES_VIEW_SQL }),
  ]);


  // Add column comments to all views so DESCRIBE TABLE returns useful descriptions.
  // Comments are lost on CREATE OR REPLACE VIEW, so we re-apply them every migration run.
  // The AI query builder treats these comments as authoritative schema metadata,
  // so a partial application is incompatible with the backend version being deployed.
  // One ALTER per view keeps each view's metadata update atomic and avoids
  // contending on the same metadata lock with one command per column.
  for (const sql of COLUMN_COMMENT_SQL) {
    await client.command({ query: sql });
  }

  // Row policies in parallel
  const tables = [
    "events", "logs", "errors", "span_events", "users", "contact_channels", "teams", "team_member_profiles",
    "team_permissions", "team_invitations", "email_outboxes",
    "project_permissions", "notification_preferences", "refresh_tokens", "connected_accounts",
    "spans", "page_views", "span_links", "trace_roots", "trace_services",
  ];
  await Promise.all(tables.map(table =>
    client.command({
      query: `CREATE ROW POLICY IF NOT EXISTS ${table}_project_isolation ON default.${table} FOR SELECT USING project_id = getSetting('SQL_project_id') AND branch_id = getSetting('SQL_branch_id') TO limited_user`,
    })
  ));

  // Grants
  await client.command({ query: "REVOKE ALL PRIVILEGES ON *.* FROM limited_user;" });
  await client.command({ query: "REVOKE ALL FROM limited_user;" });
  await Promise.all(tables.map(table =>
    client.command({ query: `GRANT SELECT ON default.${table} TO limited_user;` })
  ));

  await Promise.all([
    writeSpansSubsystemFingerprint(client, spansSubsystemFingerprint),
    writeIssuesSubsystemFingerprint(client, issuesSubsystemFingerprint),
  ]);

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`[Clickhouse] Clickhouse migrations complete (${elapsed}s)`);
  await client.close();
}

async function clickhouseTableExists(
  client: ClickHouseClient,
  options: { database: string, table: string },
): Promise<boolean> {
  const resultSet = await client.query({
    query: "SELECT count() AS count FROM system.tables WHERE database = {database:String} AND name = {table:String}",
    query_params: { database: options.database, table: options.table },
    format: "JSONEachRow",
  });
  const [row] = await resultSet.json<{ count: string }>();
  return Number(row.count) !== 0;
}

const SPANS_SUBSYSTEM_FINGERPRINT_TABLE = "analytics_internal.spans_schema_fingerprint";

const SPANS_SUBSYSTEM_MATERIALIZED_VIEWS = ["trace_roots_mv", "trace_services_mv", "span_writes_mv"] as const;
const SPANS_SUBSYSTEM_TABLES = ["derived_span_backfill_state", "trace_roots", "trace_services", "span_writes", "span_links", "span_events", "spans"] as const;

/**
 * Everything whose change requires an explicit online migration: the physical
 * layout of every table plus the exact text of every materialized view.
 */
export function computeSpansSubsystemFingerprint(): string {
  const canonical = JSON.stringify([
    SPANS_TABLE_BASE_SQL,
    SPAN_EVENTS_TABLE_BASE_SQL,
    SPAN_LINKS_TABLE_SQL,
    TRACE_ROOTS_TABLE_SQL,
    TRACE_SERVICES_TABLE_SQL,
    SPAN_WRITES_TABLE_SQL,
    TRACE_ROOTS_MV_SQL,
    TRACE_SERVICES_MV_SQL,
    SPAN_WRITES_MV_SQL,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export type FingerprintGuardDecision =
  | { kind: "current" }
  | { kind: "fresh" }
  | { kind: "resume" }
  | { kind: "mismatch", stored: string | "absent", expected: string, detail: string };

export type FingerprintLiveObject = {
  name: string,
  columns?: readonly { name: string, type: string }[],
  asSelect?: string,
};

export type FingerprintExpectedObject = {
  name: string,
  columns?: readonly { name: string, type: string }[],
  asSelect?: string,
};

function normalizeClickhouseType(type: string): string {
  return type.toLowerCase().replace(/[\s'"`]/g, "");
}

function normalizeClickhouseSql(sql: string): string {
  const normalized = sql.toLowerCase().replace(/[`"]/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
  return normalized.replace(/\(([a-z0-9_.]+\s*(?:=|!=|<>)\s*[^()]+)\)/g, (match, predicate: string) => {
    return /\b(?:and|or)\b/.test(predicate) ? match : predicate;
  });
}

function getSqlSourceTable(sql: string): string | undefined {
  return /\bfrom\s+([a-z0-9_.]+)/.exec(normalizeClickhouseSql(sql))?.[1];
}

function getSqlWhereFragments(sql: string): readonly string[] {
  const normalized = normalizeClickhouseSql(sql);
  const whereStart = normalized.indexOf(" where ");
  if (whereStart === -1) return [];

  const afterWhere = normalized.slice(whereStart + " where ".length);
  const clauseBoundaries = [" group by ", " order by ", " limit "]
    .map((boundary) => afterWhere.indexOf(boundary))
    .filter((index) => index !== -1);
  const whereClause = afterWhere.slice(0, clauseBoundaries.length === 0 ? undefined : Math.min(...clauseBoundaries));
  return whereClause
    .split(/\s+and\s+/)
    .map((fragment) => fragment.replace(/^\(+/, "").replace(/\)+$/, "").trim());
}

export function decideFingerprintGuard(input: {
  stored: string | undefined,
  expected: string,
  liveObjects: readonly FingerprintLiveObject[],
  expectedObjects: readonly FingerprintExpectedObject[],
}): FingerprintGuardDecision {
  if (input.stored === input.expected) return { kind: "current" };
  if (input.stored !== undefined) {
    return {
      kind: "mismatch",
      stored: input.stored,
      expected: input.expected,
      detail: "stored fingerprint differs from the expected fingerprint",
    };
  }
  if (input.liveObjects.length === 0) return { kind: "fresh" };

  const expectedByName = new Map(input.expectedObjects.map((object) => [object.name, object]));
  for (const liveObject of input.liveObjects) {
    const expectedObject = expectedByName.get(liveObject.name);
    if (expectedObject === undefined) continue;

    if (expectedObject.columns !== undefined) {
      if (liveObject.columns === undefined) {
        return {
          kind: "mismatch",
          stored: "absent",
          expected: input.expected,
          detail: `${liveObject.name} has no readable column definition`,
        };
      }
      const liveColumnsByName = new Map(liveObject.columns.map((column) => [column.name, column.type]));
      for (const expectedColumn of expectedObject.columns) {
        const liveType = liveColumnsByName.get(expectedColumn.name);
        if (liveType === undefined) {
          return {
            kind: "mismatch",
            stored: "absent",
            expected: input.expected,
            detail: `${liveObject.name} is missing expected column ${expectedColumn.name}`,
          };
        }
        if (normalizeClickhouseType(liveType) !== normalizeClickhouseType(expectedColumn.type)) {
          return {
            kind: "mismatch",
            stored: "absent",
            expected: input.expected,
            detail: `${liveObject.name}.${expectedColumn.name} has type ${liveType}, expected ${expectedColumn.type}`,
          };
        }
      }
    }

    if (expectedObject.asSelect !== undefined) {
      if (liveObject.asSelect === undefined) {
        return {
          kind: "mismatch",
          stored: "absent",
          expected: input.expected,
          detail: `${liveObject.name} has no readable SELECT definition`,
        };
      }
      const liveSql = normalizeClickhouseSql(liveObject.asSelect);
      const expectedSql = normalizeClickhouseSql(expectedObject.asSelect);
      const expectedSourceTable = getSqlSourceTable(expectedObject.asSelect);
      const liveSourceTable = getSqlSourceTable(liveObject.asSelect);
      if (expectedSourceTable === undefined || liveSourceTable !== expectedSourceTable) {
        return {
          kind: "mismatch",
          stored: "absent",
          expected: input.expected,
          detail: `${liveObject.name} does not read from the expected source table`,
        };
      }
      const missingPredicate = getSqlWhereFragments(expectedObject.asSelect)
        .find((fragment) => !liveSql.includes(fragment));
      if (missingPredicate !== undefined) {
        return {
          kind: "mismatch",
          stored: "absent",
          expected: input.expected,
          detail: `${liveObject.name} is missing expected predicate ${missingPredicate}`,
        };
      }
      if (liveSql !== expectedSql) {
        return {
          kind: "mismatch",
          stored: "absent",
          expected: input.expected,
          detail: `${liveObject.name} SELECT definition differs from the expected migration`,
        };
      }
    }
  }

  return { kind: "resume" };
}

async function readFingerprintLiveTable(
  client: ClickHouseClient,
  table: string,
): Promise<FingerprintLiveObject> {
  const resultSet = await client.query({
    query: "SELECT name, type FROM system.columns WHERE database = 'analytics_internal' AND table = {table:String}",
    query_params: { table },
    format: "JSONEachRow",
  });
  return {
    name: table,
    columns: await resultSet.json<{ name: string, type: string }>(),
  };
}

async function readFingerprintLiveMaterializedView(
  client: ClickHouseClient,
  table: string,
): Promise<FingerprintLiveObject> {
  const resultSet = await client.query({
    query: "SELECT as_select FROM system.tables WHERE database = 'analytics_internal' AND name = {table:String}",
    query_params: { table },
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ as_select: string }>();
  return {
    name: table,
    asSelect: rows.at(0)?.as_select ?? throwErr(`Materialized view ${table} disappeared while validating its fingerprint`),
  };
}

async function resetSubsystemIfFingerprintChanged(
  client: ClickHouseClient,
  options: {
    label: string,
    fingerprintTable: string,
    materializedViews: readonly string[],
    tables: readonly string[],
    fingerprint: string,
    expectedObjects: readonly FingerprintExpectedObject[],
  },
): Promise<boolean> {
  await client.command({
    query: `
CREATE TABLE IF NOT EXISTS ${options.fingerprintTable} (
  fingerprint String,
  applied_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(applied_at) ORDER BY tuple()
`,
  });

  const resultSet = await client.query({
    query: `SELECT fingerprint FROM ${options.fingerprintTable} FINAL LIMIT 1`,
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ fingerprint: string }>();
  const stored = rows.at(0)?.fingerprint;
  const liveObjects: FingerprintLiveObject[] = [];
  if (stored === undefined) {
    const expectedByName = new Map(options.expectedObjects.map((object) => [object.name, object]));
    const liveTables = await Promise.all(options.tables.map(async (table) => {
      if (!await clickhouseTableExists(client, { database: "analytics_internal", table })) return null;
      if (expectedByName.get(table)?.columns === undefined) return { name: table };
      return await readFingerprintLiveTable(client, table);
    }));
    const liveMaterializedViews = await Promise.all(options.materializedViews.map(async (table) => {
      if (!await clickhouseTableExists(client, { database: "analytics_internal", table })) return null;
      return await readFingerprintLiveMaterializedView(client, table);
    }));
    for (const liveObject of [...liveTables, ...liveMaterializedViews]) {
      if (liveObject !== null) liveObjects.push(liveObject);
    }
  }

  const decision = decideFingerprintGuard({
    stored,
    expected: options.fingerprint,
    liveObjects,
    expectedObjects: options.expectedObjects,
  });
  switch (decision.kind) {
    case "current": {
      return false;
    }
    case "fresh": {
      return false;
    }
    case "resume": {
      return false;
    }
    case "mismatch": {
      throw new Error(
        `[Clickhouse] ${options.label} schema fingerprint changed (stored ${decision.stored}, current ${decision.expected}). ${decision.detail}. `
        + "Automatic DROP/rebuild is disabled because it destroys telemetry. Apply an explicit online schema migration and seed the fingerprint only after validating the live definitions.",
      );
    }
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

async function writeSubsystemFingerprint(client: ClickHouseClient, fingerprintTable: string, fingerprint: string): Promise<void> {
  await client.command({
    query: `INSERT INTO ${fingerprintTable} (fingerprint) VALUES ({fingerprint:String})`,
    query_params: { fingerprint },
  });
}

function getMaterializedViewSelectBody(createSql: string): string {
  const marker = "\nAS\n";
  const selectStart = createSql.indexOf(marker);
  if (selectStart === -1) {
    throw new Error("Canonical materialized view SQL has no AS SELECT body");
  }
  return createSql.slice(selectStart + marker.length);
}

function getSpansFingerprintExpectedObjects(): readonly FingerprintExpectedObject[] {
  return [
    { name: "spans", columns: SPANS_COLUMNS },
    { name: "span_events", columns: SPAN_EVENTS_COLUMNS },
    { name: "span_links", columns: SPAN_LINKS_COLUMNS },
    { name: "trace_roots", columns: TRACE_ROOTS_COLUMNS },
    { name: "trace_services", columns: TRACE_SERVICES_COLUMNS },
    {
      name: "span_writes",
      columns: [
        { name: "project_id", type: "String" },
        { name: "created_at", type: "DateTime64(3, 'UTC')" },
      ],
    },
    { name: "derived_span_backfill_state" },
    { name: "trace_roots_mv", asSelect: TRACE_ROOTS_SOURCE_SELECT_SQL },
    { name: "trace_services_mv", asSelect: TRACE_SERVICES_SOURCE_SELECT_SQL },
    { name: "span_writes_mv", asSelect: getMaterializedViewSelectBody(buildSpanWritesMvSql("analytics_internal")) },
  ];
}

export async function resetSpansSubsystemIfFingerprintChanged(
  client: ClickHouseClient,
  fingerprint: string,
): Promise<boolean> {
  return await resetSubsystemIfFingerprintChanged(client, {
    label: "Spans",
    fingerprintTable: SPANS_SUBSYSTEM_FINGERPRINT_TABLE,
    materializedViews: SPANS_SUBSYSTEM_MATERIALIZED_VIEWS,
    tables: SPANS_SUBSYSTEM_TABLES,
    fingerprint,
    expectedObjects: getSpansFingerprintExpectedObjects(),
  });
}

export async function writeSpansSubsystemFingerprint(client: ClickHouseClient, fingerprint: string): Promise<void> {
  await writeSubsystemFingerprint(client, SPANS_SUBSYSTEM_FINGERPRINT_TABLE, fingerprint);
}

const ISSUES_SUBSYSTEM_FINGERPRINT_TABLE = "analytics_internal.issues_schema_fingerprint";
const ISSUES_SUBSYSTEM_MATERIALIZED_VIEWS = ["issue_occurrence_rollup_mv"] as const;
const ISSUES_SUBSYSTEM_TABLES = ["issue_occurrence_rollup"] as const;

export function computeIssuesSubsystemFingerprint(
  rollupTableSql: string = ISSUE_OCCURRENCE_ROLLUP_TABLE_SQL,
  rollupMvSql: string = ISSUE_OCCURRENCE_ROLLUP_MV_SQL,
): string {
  const canonical = JSON.stringify([rollupTableSql, rollupMvSql]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function getIssuesFingerprintExpectedObjects(): readonly FingerprintExpectedObject[] {
  return [
    {
      name: "issue_occurrence_rollup",
      columns: [
        { name: "project_id", type: "String" },
        { name: "branch_id", type: "String" },
        { name: "issue_hash", type: "String" },
        { name: "bucket_start", type: "DateTime('UTC')" },
        { name: "service_name", type: "LowCardinality(String)" },
        { name: "deployment_environment_name", type: "LowCardinality(String)" },
        { name: "occurrences", type: "SimpleAggregateFunction(sum, UInt64)" },
        { name: "users_state", type: "AggregateFunction(uniq, Nullable(String))" },
        { name: "first_seen", type: "SimpleAggregateFunction(min, DateTime64(3,'UTC'))" },
        { name: "last_seen", type: "SimpleAggregateFunction(max, DateTime64(3,'UTC'))" },
      ],
    },
    {
      name: "issue_occurrence_rollup_mv",
      asSelect: getMaterializedViewSelectBody(buildIssueOccurrenceRollupMvSql("analytics_internal")),
    },
  ];
}

export async function resetIssuesSubsystemIfFingerprintChanged(
  client: ClickHouseClient,
  fingerprint: string,
): Promise<boolean> {
  return await resetSubsystemIfFingerprintChanged(client, {
    label: "Issues",
    fingerprintTable: ISSUES_SUBSYSTEM_FINGERPRINT_TABLE,
    materializedViews: ISSUES_SUBSYSTEM_MATERIALIZED_VIEWS,
    tables: ISSUES_SUBSYSTEM_TABLES,
    fingerprint,
    expectedObjects: getIssuesFingerprintExpectedObjects(),
  });
}

export async function writeIssuesSubsystemFingerprint(client: ClickHouseClient, fingerprint: string): Promise<void> {
  await writeSubsystemFingerprint(client, ISSUES_SUBSYSTEM_FINGERPRINT_TABLE, fingerprint);
}

/**
 * Fills a derived read model with the spans that predate its materialized view.
 *
 * This replaces `POPULATE`, which drops any row inserted while it runs — a
 * silent, unrecoverable hole in the read model. Attaching the materialized view
 * first and then copying history means the two overlap instead of leaving a gap,
 * and the overlap is harmless: both targets are ReplacingMergeTrees keyed by the
 * span's identity, so a row written twice at the same `version` collapses.
 *
 * Work is split along the source table's physical month partitions and
 * checkpointed after each successful insert.
 * A destination-emptiness guard is not safe: because the MV is attached first,
 * one concurrent span can make the target non-empty and cause all history to
 * be skipped forever. Month-sized inserts scan each source partition once and
 * bound memory, I/O, retry cost, and the number of new parts even when the
 * source is around a terabyte.
 */
export async function backfillDerivedSpanTable(
  client: ClickHouseClient,
  options: { table: string, selectSql: string, targetColumns: readonly ClickhouseColumn[], database?: string },
): Promise<void> {
  const database = options.database ?? "analytics_internal";
  const stateTable = `${database}.derived_span_backfill_state`;
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${stateTable} (
        target_table String,
        source_partition String,
        completed_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE ReplacingMergeTree(completed_at)
      ORDER BY (target_table, source_partition)
    `,
  });

  const completionResultSet = await client.query({
    query: `
      SELECT count() AS count
      FROM ${stateTable} FINAL
      WHERE target_table = {targetTable:String}
        AND source_partition = '__complete__'
    `,
    query_params: { targetTable: options.table },
    format: "JSONEachRow",
  });
  const completionRows = await completionResultSet.json<{ count: string }>();
  if (Number(completionRows.at(0)?.count ?? throwErr(`Backfill completion probe for ${database}.${options.table} returned no row`)) !== 0) return;

  // Query physical partition metadata rather than SELECT DISTINCT over a TB of
  // source rows. The INSERT predicate uses the same partition expression as
  // spans, so ClickHouse reads each part exactly once across the backfill.
  const resultSet = await client.query({
    query: `
      SELECT DISTINCT partition AS source_partition
      FROM system.parts
      WHERE database = {database:String}
        AND table = 'spans'
        AND active
        AND partition NOT IN (
        SELECT source_partition
        FROM ${stateTable} FINAL
        WHERE target_table = {targetTable:String}
      )
      ORDER BY source_partition
    `,
    query_params: { database, targetTable: options.table },
    format: "JSONEachRow",
  });
  const partitions = await resultSet.json<{ source_partition: string }>();
  if (partitions.length > 0) {
    console.log(`[Clickhouse] Backfilling ${database}.${options.table} from existing spans in ${partitions.length} partition-sized batch(es)`);
  }
  const columnList = options.targetColumns.map((column) => column.name).join(", ");
  const selectSql = options.selectSql.trim().replace(/;$/, "");
  const sourceTableCandidates = [`${database}.spans`, "analytics_internal.spans"];
  for (const { source_partition: sourcePartition } of partitions) {
    const sourceTable = sourceTableCandidates.find((candidate) => selectSql.includes(`FROM ${candidate}`))
      ?? throwErr(`Derived backfill SELECT for ${database}.${options.table} must read the spans table directly`);
    const partitionedSelectSql = selectSql.replace(
      `FROM ${sourceTable}`,
      `FROM (SELECT * FROM ${sourceTable} WHERE _partition_id = {sourcePartition:String})`,
    );
    await client.command({
      query: `
        INSERT INTO ${database}.${options.table} (${columnList})
        ${partitionedSelectSql}
      `,
      query_params: { sourcePartition },
      clickhouse_settings: { max_threads: 2, max_insert_threads: "2" },
    });
    await client.command({
      query: `
        INSERT INTO ${stateTable} (target_table, source_partition)
        VALUES ({targetTable:String}, {sourcePartition:String})
      `,
      query_params: { targetTable: options.table, sourcePartition },
    });
  }
  await client.command({
    query: `
      INSERT INTO ${stateTable} (target_table, source_partition)
      VALUES ({targetTable:String}, '__complete__')
    `,
    query_params: { targetTable: options.table },
  });
}

/**
 * Applies the retention TTL to a table that predates the TTL clause in its
 * CREATE statement. Guarded on the table's current metadata and applied with
 * `materialize_ttl_after_modify = 0`: changing metadata must not implicitly
 * enqueue an all-parts rewrite against a production-sized table. Existing
 * parts pick up the TTL during normal merges; operators can materialize closed
 * partitions separately under an explicit I/O budget.
 *
 * The probe matches ClickHouse's normalized form of the expression
 * (`INTERVAL n DAY` is stored as `toIntervalDay(n)`), so changing the retention
 * constant later re-triggers exactly one MODIFY TTL.
 */
export async function ensureTableTtl(
  client: ClickHouseClient,
  options: { database: string, table: string, ttlDays: number, timestampColumn?: "created_at" | "event_at" | "started_at" },
): Promise<void> {
  const timestampColumn = options.timestampColumn ?? "created_at";
  const resultSet = await client.query({
    query: "SELECT engine_full FROM system.tables WHERE database = {database:String} AND name = {table:String}",
    query_params: { database: options.database, table: options.table },
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ engine_full: string }>();
  const engineFull = rows[0]?.engine_full ?? throwErr(`ensureTableTtl: table ${options.database}.${options.table} does not exist; it must be created before its TTL is ensured`);
  if (engineFull.includes(`toDateTime(${timestampColumn}) + toIntervalDay(${options.ttlDays})`)) return;

  console.log(`[Clickhouse] Applying ${options.ttlDays}-day TTL to ${options.database}.${options.table}`);
  await client.command({
    query: `ALTER TABLE ${options.database}.${options.table} MODIFY TTL ${buildRetentionTtlSql(options.ttlDays, timestampColumn)}`,
    clickhouse_settings: { materialize_ttl_after_modify: 0 },
  });
}

export async function ensureSkipIndex(
  client: ClickHouseClient,
  options: { database: string, table: string, indexName: string, indexDefinitionSql: string, materializeHistoricalParts: boolean },
): Promise<void> {
  if (options.materializeHistoricalParts) {
    throw new Error(
      `[Clickhouse] Refusing to materialize skip index ${options.database}.${options.table}.${options.indexName} over all historical parts during startup; `
      + "materialize closed partitions separately under an explicit I/O budget and checkpoint each completed partition.",
    );
  }
  const resultSet = await client.query({
    query: "SELECT name FROM system.data_skipping_indices WHERE database = {database:String} AND table = {table:String} AND name = {indexName:String}",
    query_params: { database: options.database, table: options.table, indexName: options.indexName },
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ name: string }>();
  if (rows.length > 0) return;

  console.log(`[Clickhouse] Adding skip index ${options.indexName} to ${options.database}.${options.table}`);
  await client.command({
    query: `ALTER TABLE ${options.database}.${options.table} ADD INDEX IF NOT EXISTS ${options.indexName} ${options.indexDefinitionSql}`,
  });
}

export type ClickhouseColumn = {
  name: string,
  type: string,
  default?: string,
};

// Retention caps are enforced ClickHouse-side via TTL, keyed on `created_at`
// (ingestion time) so re-upserted telemetry never expires earlier than its last
// write.
export const TELEMETRY_TTL_DAYS = 90;
export const SPAN_WRITES_TTL_DAYS = 400;
export const TELEMETRY_INSERT_DEDUPLICATION_WINDOW = 10_000;
export const TELEMETRY_INSERT_TABLES = ["events", "spans", "span_events", "span_links", "metrics"] as const;

export function buildTelemetryInsertDeduplicationSettingSql(
  table: typeof TELEMETRY_INSERT_TABLES[number],
): string {
  return `ALTER TABLE analytics_internal.${table} MODIFY SETTING non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`;
}

function buildRetentionTtlSql(ttlDays: number, timestampColumn: "created_at" | "event_at" | "started_at" = "created_at"): string {
  return `toDateTime(${timestampColumn}) + INTERVAL ${ttlDays} DAY DELETE`;
}

function buildColumnDefinition(column: ClickhouseColumn): string {
  return `${column.name} ${column.type}${column.default == null ? "" : ` DEFAULT ${column.default}`}`;
}

function buildCreateTableSql(table: string, columns: readonly ClickhouseColumn[], engineClause: string, extraDeclarations: readonly string[] = []): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
    ${[...columns.map(buildColumnDefinition), ...extraDeclarations].join(",\n    ")}
)
${engineClause};
`;
}

export function buildColumnUpgradeSql(table: string, columns: readonly ClickhouseColumn[]): string {
  const actions = columns.map((column, index) => {
    const position = index === 0 ? "FIRST" : `AFTER ${columns[index - 1].name}`;
    return `ADD COLUMN IF NOT EXISTS ${buildColumnDefinition(column)} ${position}`;
  });
  return `
ALTER TABLE ${table}
  ${actions.join(",\n  ")};
`;
}

/**
 * The column list for a `default.*` view. Views must never be `SELECT *`: two
 * deployments can reach the same logical schema with different physical column
 * orders, and `SELECT *` would then hand customers differently-shaped result
 * sets for the same query. It matters even more for the UNION ALL views, where
 * ClickHouse lines branches up by POSITION rather than by name — a `SELECT *`
 * branch can silently pair with the wrong same-typed column of another branch.
 */
export function selectColumnNames(columns: readonly ClickhouseColumn[], exclude: readonly string[] = []): string[] {
  const remaining = new Set(exclude);
  const names = columns.filter((column) => !remaining.delete(column.name)).map((column) => column.name);
  if (remaining.size > 0) {
    throw new Error(`Cannot exclude unknown analytics column(s) from a view: ${[...remaining].join(", ")}`);
  }
  return names;
}

function buildViewSelectList(columns: readonly ClickhouseColumn[], exclude: readonly string[] = []): string {
  return selectColumnNames(columns, exclude).join(",\n  ");
}

/**
 * Projects a derived read model's columns out of its source table's declaration
 * so the two cannot drift apart. A mismatched type between a materialized view's
 * SELECT and its target table is rejected at INSERT time (i.e. it breaks
 * ingestion, not deployment), which is exactly the kind of failure that should
 * be impossible to write rather than caught in review.
 */
function pickColumns(columns: readonly ClickhouseColumn[], names: readonly string[]): ClickhouseColumn[] {
  const byName = new Map(columns.map((column) => [column.name, column]));
  return names.map((name) => byName.get(name) ?? throwErr(`Unknown source column for derived analytics table: ${name}`));
}

// `created_at` (the ingestion timestamp) is deliberately LAST: it is the only
// column that existed before the telemetry columns were introduced and did
// not have a successor, so keeping it last means a pre-telemetry database
// upgraded via buildColumnUpgradeSql lands on exactly the same physical order as
// a freshly created one.
// `as const` (here and on the other telemetry column lists) keeps the column
// names as literal types so insert-row builders can be checked against
// `EventColumnName` and friends at compile time — see
// analytics-telemetry-writers.test.ts and spans.test.ts.
//
// `message` is the human-readable text of an occurrence: the ingest-time error
// grouper promotes it out of the `$error` payload server-side (for `$log` rows
// the message lives in the OTLP `body` column instead). `level` is the
// severity of `$log`/`$error` rows. Rows that carry neither leave both at
// their empty defaults. `producer` says
// WHO wrote the row ('sdk' = the customer's app via the Hexclave SDK,
// 'hexclave-backend' = Hexclave's own backend writing on the project's behalf:
// system events like $token-refresh, backend logs, span milestones). `runtime`
// says WHERE the producing code ran ('browser'/'server' for SDK rows, stamped
// by the batch route from the auth type; 'system' for everything Hexclave
// writes itself).
export const EVENTS_COLUMNS = [
  { name: "event_type", type: "LowCardinality(String)" },
  { name: "event_at", type: "DateTime64(3, 'UTC')" },
  { name: "message", type: "String", default: "''" },
  { name: "level", type: "LowCardinality(String)", default: "''" },
  { name: "data", type: "JSON" },
  { name: "producer", type: "LowCardinality(String)", default: "'hexclave-backend'" },
  { name: "runtime", type: "LowCardinality(String)", default: "'system'" },
  { name: "project_id", type: "String" },
  { name: "branch_id", type: "String" },
  { name: "user_id", type: "Nullable(String)" },
  { name: "team_id", type: "Nullable(String)" },
  { name: "refresh_token_id", type: "Nullable(String)" },
  { name: "session_replay_id", type: "Nullable(String)" },
  { name: "session_replay_segment_id", type: "Nullable(String)" },
  { name: "trace_id", type: "Nullable(String)" },
  { name: "span_id", type: "Nullable(String)" },
  { name: "page_view_span_id", type: "Nullable(String)" },
  { name: "service_namespace", type: "LowCardinality(Nullable(String))" },
  { name: "service_name", type: "LowCardinality(Nullable(String))" },
  { name: "service_version", type: "Nullable(String)" },
  { name: "service_instance_id", type: "Nullable(String)" },
  { name: "deployment_environment_name", type: "LowCardinality(Nullable(String))" },
  { name: "resource_attributes", type: "String", default: "'{}'" },
  { name: "created_at", type: "DateTime64(3, 'UTC')", default: "now64(3)" },
] as const satisfies readonly ClickhouseColumn[];

export type EventColumnName = (typeof EVENTS_COLUMNS)[number]["name"];

export const EVENTS_EVENT_TYPE_INDEX_NAME = "idx_event_type";
export const EVENTS_EVENT_TYPE_INDEX_DEFINITION_SQL = "event_type TYPE set(0) GRANULARITY 4";

// Error-grouping columns, written by the ingest-time grouper for `$error` rows
// only. Physically present on every `logs` row (a `$log` line just leaves them
// at their defaults) because logs and error occurrences deliberately share one
// table — see LOGS_COLUMNS.
//
// EVERY column here is defaulted, and that is load-bearing twice over:
//   1. buildColumnUpgradeSql can then ADD them to a table holding millions of
//      rows without a rewrite, and pre-grouping rows read back as ''/[]/0
//      rather than NULL — so `issue_hash != ''` is the one and only "is this
//      occurrence grouped" test, with no nullability branch anywhere.
//   2. The insert-row builder may omit them entirely for non-$error rows.
//
// `error_frames` is the parsed `ParsedFrame[]` serialized as a JSON string in
// its OWN column rather than a sub-field of `data`. `data` is ClickHouse type
// `JSON`, which materializes a physical subcolumn per distinct path, and it is
// also the customer's 64 KB payload budget. Frames would add roughly 10 keys ×
// up to 50 frames per error to that dynamic-subcolumn set, blowing past
// `max_dynamic_paths` and degrading reads of the whole `logs` table for every
// customer — including ones who never enabled error capture. A plain `String`
// costs exactly one column and is only ever read back whole.
export const ERROR_GROUPING_COLUMNS = [
  { name: "occurrence_id", type: "String", default: "''" },
  { name: "batch_id", type: "String", default: "''" },
  { name: "issue_hash", type: "String", default: "''" },
  { name: "issue_hashes", type: "Array(String)", default: "[]" },
  { name: "issue_grouping_config", type: "LowCardinality(String)", default: "''" },
  { name: "issue_variant", type: "LowCardinality(String)", default: "''" },
  // Ordered primary/secondary hash decisions. This is a String rather than a
  // dynamic JSON path so fingerprint tokens cannot expand ClickHouse's shared
  // dynamic-column namespace. Historical rows read back as an empty array.
  { name: "issue_grouping_provenance", type: "String", default: "'[]'" },
  { name: "grouping_degraded", type: "UInt8", default: "0" },
  { name: "error_type", type: "LowCardinality(String)", default: "''" },
  { name: "error_culprit", type: "String", default: "''" },
  { name: "error_frames", type: "String", default: "''" },
] as const satisfies readonly ClickhouseColumn[];

export const ERROR_GROUPING_COLUMN_NAMES = ERROR_GROUPING_COLUMNS.map((column) => column.name);

/**
 * The canonical bounded ErrorEnvelope is stored as one JSON string rather than
 * as dynamic ClickHouse JSON subcolumns. Error envelopes contain user-defined
 * context keys and nested exception/breadcrumb arrays; promoting those keys
 * into ClickHouse's dynamic-path namespace would make unrelated tenants change
 * the physical shape of the shared logs table. The typed read contract parses
 * this projection after the ClickHouse query and applies the public scrubber.
 */
export const ERROR_ENVELOPE_COLUMNS = [
  { name: "error_envelope", type: "String", default: "'{}'" },
] as const satisfies readonly ClickhouseColumn[];

export const ERROR_ENVELOPE_COLUMN_NAMES = ERROR_ENVELOPE_COLUMNS.map((column) => column.name);

// Logs and error occurrences share one log-shaped physical table. The log
// shape is OTel-first: `body`, `attributes`, and the raw OTLP fields carry the
// LogRecord; `data` remains the structured application/error payload needed by
// issue details, and `message` (an EVENTS_COLUMNS field) carries the
// server-promoted human-readable text of `$error` occurrences.
//
// Appended AFTER `created_at` (the last EVENTS_COLUMNS entry) rather than
// slotted in beside the other error-ish fields: this keeps the OTel columns
// in the same relative order on fresh tables and tables grown by
// buildColumnUpgradeSql.
export const OTEL_LOG_COLUMNS = [
  { name: "time_unix_nano", type: "String", default: "''" },
  { name: "observed_time_unix_nano", type: "String", default: "''" },
  { name: "severity_number", type: "UInt8", default: "0" },
  { name: "severity_text", type: "LowCardinality(String)", default: "''" },
  { name: "otel_event_name", type: "String", default: "''" },
  { name: "body", type: "String", default: "''" },
  { name: "attributes", type: "String", default: "'{}'" },
  { name: "dropped_attributes", type: "UInt64", default: "0" },
  { name: "trace_flags", type: "UInt32", default: "0" },
  { name: "resource_dropped_attributes", type: "UInt64", default: "0" },
  { name: "resource_schema_url", type: "String", default: "''" },
  { name: "scope_name", type: "LowCardinality(Nullable(String))", default: "NULL" },
  { name: "scope_version", type: "Nullable(String)", default: "NULL" },
  { name: "scope_attributes", type: "String", default: "'{}'" },
  { name: "scope_dropped_attributes", type: "UInt64", default: "0" },
  { name: "scope_schema_url", type: "String", default: "''" },
] as const satisfies readonly ClickhouseColumn[];

export const LOGS_COLUMNS = [...EVENTS_COLUMNS, ...ERROR_GROUPING_COLUMNS, ...ERROR_ENVELOPE_COLUMNS, ...OTEL_LOG_COLUMNS] as const satisfies readonly ClickhouseColumn[];
export type LogColumnName = (typeof LOGS_COLUMNS)[number]["name"];

export const LOGS_ISSUE_HASH_INDEX_NAME = "idx_issue_hash";
export const LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL = "issue_hash TYPE bloom_filter(0.01) GRANULARITY 4";

export const TELEMETRY_COLUMNS = LOGS_COLUMNS;

export type TelemetryColumnName = (typeof TELEMETRY_COLUMNS)[number]["name"];

export function buildTelemetryCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, TELEMETRY_COLUMNS, `
ENGINE MergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (project_id, branch_id, event_at)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}`, [
    `INDEX ${EVENTS_EVENT_TYPE_INDEX_NAME} ${EVENTS_EVENT_TYPE_INDEX_DEFINITION_SQL}`,
    `INDEX ${LOGS_ISSUE_HASH_INDEX_NAME} ${LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL}`,
  ]);
}

const TELEMETRY_TABLE_BASE_SQL = buildTelemetryCreateTableSql("analytics_internal.events");
const TELEMETRY_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.events", TELEMETRY_COLUMNS);

export const SPAN_EVENTS_COLUMNS = [
  ...EVENTS_COLUMNS,
  { name: "event_ordinal", type: "UInt32", default: "0" },
  { name: "time_unix_nano", type: "UInt64", default: "0" },
  { name: "attributes", type: "String", default: "'{}'" },
  { name: "dropped_attributes", type: "UInt32", default: "0" },
] as const satisfies readonly ClickhouseColumn[];
export type SpanEventColumnName = (typeof SPAN_EVENTS_COLUMNS)[number]["name"];
export function buildSpanEventsCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, SPAN_EVENTS_COLUMNS, `
ENGINE ReplacingMergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (project_id, branch_id, ifNull(trace_id, ''), ifNull(span_id, ''), event_ordinal, event_at, event_type)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}`);
}
const SPAN_EVENTS_TABLE_BASE_SQL = buildSpanEventsCreateTableSql("analytics_internal.span_events");
const SPAN_EVENTS_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.span_events", SPAN_EVENTS_COLUMNS);

// Reads the physical events table directly. New log/error/OTel columns land
// through ADD COLUMN IF NOT EXISTS with constant defaults, so existing rows
// keep their data and read the new fields as empty. A type-widening
// MODIFY COLUMN is deliberately never issued: on a production-sized table that
// rewrites every part.
// `message` is excluded: it is the log/error occurrence text (exposed via
// default.logs / default.errors) and this view's pre-existing contract never
// had it. Every product-event row here would read ''.
// `$page-view` is a SPAN (see default.spans) — never project spans into this
// view or the traces UI shows the same fact twice (event diamond + span bar).
// Metrics that need page views query spans directly.
const EVENTS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.events
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(EVENTS_COLUMNS, ["message"])}
FROM analytics_internal.events
WHERE event_type NOT IN ('$log', '$error');
`;

export const LOGS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.logs
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(LOGS_COLUMNS, [...ERROR_GROUPING_COLUMN_NAMES, ...ERROR_ENVELOPE_COLUMN_NAMES])}
FROM analytics_internal.events
WHERE event_type = '$log';
`;

// The full log shape INCLUDING the grouping columns: this is the view issue
// triage reads, and `issue_hash` is the join key between a ClickHouse
// occurrence and its Postgres Issue record.
export const ERRORS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.errors
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(LOGS_COLUMNS)}
FROM analytics_internal.events
WHERE event_type = '$error';
`;

// Windowed statistics per (issue, hour): the ClickHouse half of the split
// counter authority. Postgres owns LIFETIME counters (maintained only by ledger
// deltas); this table owns everything window-scoped — last 24h/7d/30d counts,
// unique users, sparklines. The two are never mixed, because they cannot be:
// this table retains 90 days and `timesSeen`/`firstSeenAt` are all-time.
//
// Builders take the database name so the migration test can exercise the real
// table and materialized view against a throwaway database.
//
// 1. THE TTL IS KEYED ON `bucket_start`, AND THERE IS DELIBERATELY NO
//    `created_at` COLUMN. Every other table here expires on ingestion time,
//    which is right for rows that are written once. These rows are not: an
//    AggregatingMergeTree merges every insert sharing the issue key, and
//    `created_at` would be a plain non-key column on the merged result. Cohorts
//    inserted at different times for the same key therefore cannot expire
//    independently — whichever `created_at` survived the merge either keeps the
//    whole aggregate alive past retention or drops still-live data early.
//    `bucket_start` is IN the sorting key, so it is stable under merges and
//    expiry is well-defined.
// 2. `service_name` / `deployment_environment_name` PRECEDE `issue_hash` IN THE
//    ORDER BY. Reads are overwhelmingly service- and environment-filtered; with
//    issue_hash first, a service-filtered scan prunes nothing because the key
//    prefix it can seek on ends before the columns being filtered.
// 3. `users_state` is an `AggregateFunction(uniq, ...)` state, not a count.
//    Unique users across several hashes (a merged issue) or several hours must
//    be `uniqMerge`d, never summed — summing double-counts anyone active in
//    more than one bucket.
export function buildIssueOccurrenceRollupCreateTableSql(database: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${database}.issue_occurrence_rollup (
    project_id String, branch_id String, issue_hash String,
    bucket_start DateTime('UTC'),
    service_name LowCardinality(String), deployment_environment_name LowCardinality(String),
    occurrences SimpleAggregateFunction(sum, UInt64),
    users_state AggregateFunction(uniq, Nullable(String)),
    first_seen SimpleAggregateFunction(min, DateTime64(3,'UTC')),
    last_seen  SimpleAggregateFunction(max, DateTime64(3,'UTC'))
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (project_id, branch_id, service_name, deployment_environment_name, issue_hash, bucket_start)
TTL toDateTime(bucket_start) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE;
`;
}

// The SELECT is shared with nothing — there is NO BACKFILL, on purpose.
//
// The obvious move is to generalize `backfillDerivedSpanTable` and point it at
// this table. Do not. That helper guards on "destination is empty", which is
// sound for the ReplacingMergeTree it was written for (a row copied twice
// collapses) and unsound here. The materialized view is attached before any
// backfill could run, so the moment ingest is live the first insert either
// makes the destination non-empty — silently skipping ALL history, with no
// error and no second chance — or lands concurrently with the
// `INSERT … SELECT`, double-counting occurrences into an aggregate that has no
// way to detect or undo it. Both failures are permanent and invisible in the
// numbers. This table starts empty and fills forward; pre-grouping rows carry
// `issue_hash = ''`, are excluded by the WHERE below, and age out on the TTL.
//
// `coalesce(…, '')` on the two service columns is NOT cosmetic. They are
// `LowCardinality(Nullable(String))` on `telemetry` while the rollup columns
// are non-null, and a type mismatch in a materialized view is rejected at
// INSERT time against the SOURCE table. Getting this wrong does not break the
// rollup; it breaks every `analytics_internal.events` insert, i.e. all
// telemetry ingestion for every project.
//
// Column ORDER must match the CREATE TABLE above exactly: a `TO table`
// materialized view pairs its SELECT with the target positionally.
export function buildIssueOccurrenceRollupMvSql(database: string): string {
  return `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.issue_occurrence_rollup_mv
TO ${database}.issue_occurrence_rollup
AS
SELECT
  project_id,
  branch_id,
  issue_hash,
  toStartOfHour(event_at) AS bucket_start,
  coalesce(service_name, '') AS service_name,
  coalesce(deployment_environment_name, '') AS deployment_environment_name,
  count() AS occurrences,
  uniqState(user_id) AS users_state,
  min(event_at) AS first_seen,
  max(event_at) AS last_seen
FROM ${database}.events
WHERE event_type = '$error' AND issue_hash != ''
GROUP BY project_id, branch_id, issue_hash, bucket_start, service_name, deployment_environment_name;
`;
}

const ISSUE_OCCURRENCE_ROLLUP_TABLE_SQL = buildIssueOccurrenceRollupCreateTableSql("analytics_internal");
const ISSUE_OCCURRENCE_ROLLUP_MV_SQL = buildIssueOccurrenceRollupMvSql("analytics_internal");

// FINAL for the same reason as default.spans/span_links: the SDK re-exports a
// long-lived span at end after its open-marker snapshot, so events present at
// snapshot time are inserted twice (under different insert-dedup tokens).
// The ReplacingMergeTree collapses them by key only at background-merge time;
// without FINAL the public projection would show duplicate events until then.
export const SPAN_EVENTS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.span_events
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(SPAN_EVENTS_COLUMNS)}
FROM analytics_internal.span_events FINAL;
`;

const USERS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.users (
    project_id String,
    branch_id String,
    id UUID,
    display_name Nullable(String),
    profile_image_url Nullable(String),
    primary_email Nullable(String),
    primary_email_verified UInt8,
    signed_up_at DateTime64(3, 'UTC'),
    client_metadata String,
    client_read_only_metadata String,
    server_metadata String,
    is_anonymous UInt8,
    restricted_by_admin UInt8,
    restricted_by_admin_reason Nullable(String),
    restricted_by_admin_private_details Nullable(String),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(signed_up_at)
ORDER BY (project_id, branch_id, id);
`;

const USERS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.users 
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  display_name,
  profile_image_url,
  primary_email,
  primary_email_verified,
  signed_up_at,
  client_metadata,
  client_read_only_metadata,
  server_metadata,
  is_anonymous,
  restricted_by_admin,
  restricted_by_admin_reason,
  restricted_by_admin_private_details
FROM analytics_internal.users
FINAL
WHERE sync_is_deleted = 0;
`;

const SYNC_METADATA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal._stack_sync_metadata (
    tenancy_id UUID,
    mapping_name String,
    last_synced_sequence_id Int64,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(updated_at)
ORDER BY (tenancy_id, mapping_name);
`;

// Spans: telemetry siblings of events, written DIRECTLY to ClickHouse (never
// through ext-db-sync). `span_type` is the operation name (the SDK's
// `span_type` wire field), and `data` is the span's structured payload as JSON.
//
// Identity is W3C trace context for EVERY producer: a 32-hex `trace_id`, a 16-hex
// `span_id` unique only WITHIN its trace (which is why trace_id is part of the
// sorting key), and one nullable `parent_span_id` where NULL means "this span is
// the trace root". `session_replay_id` / `session_replay_segment_id` /
// `refresh_token_id` / `page_view_span_id` are scalar CORRELATION columns and
// deliberately NOT ancestry — a session is not an operation, and modelling it as a
// trace root made every trace a session instead of a unit of work.
//
// `producer` distinguishes WHO wrote the span. Physical spans currently arrive
// through the authenticated SDK path and stamp `sdk`; Hexclave's own backend
// uses that same path under the internal project rather than contributing rows
// to customer projects.
export const SPANS_COLUMNS = [
  { name: "trace_id", type: "String" },
  { name: "span_id", type: "String" },
  { name: "span_type", type: "LowCardinality(String)" },
  { name: "billing_item", type: "LowCardinality(Nullable(String))" },
  { name: "started_at", type: "DateTime64(3, 'UTC')" },
  { name: "ended_at", type: "Nullable(DateTime64(3, 'UTC'))" },
  { name: "parent_span_id", type: "Nullable(String)" },
  { name: "trace_state", type: "String", default: "''" },
  { name: "trace_flags", type: "UInt32", default: "0" },
  { name: "start_time_unix_nano", type: "UInt64", default: "0" },
  { name: "end_time_unix_nano", type: "UInt64", default: "0" },
  { name: "kind", type: "LowCardinality(String)", default: "'internal'" },
  { name: "status_code", type: "LowCardinality(String)", default: "'unset'" },
  { name: "status_message", type: "Nullable(String)" },
  { name: "service_namespace", type: "LowCardinality(Nullable(String))" },
  { name: "service_name", type: "LowCardinality(Nullable(String))" },
  { name: "service_version", type: "Nullable(String)" },
  { name: "service_instance_id", type: "Nullable(String)" },
  { name: "deployment_environment_name", type: "LowCardinality(Nullable(String))" },
  { name: "resource_attributes", type: "String", default: "'{}'" },
  { name: "resource_dropped_attributes", type: "UInt32", default: "0" },
  { name: "resource_schema_url", type: "String", default: "''" },
  { name: "scope_name", type: "LowCardinality(Nullable(String))" },
  { name: "scope_version", type: "Nullable(String)" },
  { name: "scope_attributes", type: "String", default: "'{}'" },
  { name: "scope_dropped_attributes", type: "UInt32", default: "0" },
  { name: "scope_schema_url", type: "String", default: "''" },
  { name: "attributes", type: "String", default: "'{}'" },
  { name: "dropped_attributes", type: "UInt32", default: "0" },
  { name: "dropped_events", type: "UInt32", default: "0" },
  { name: "dropped_links", type: "UInt32", default: "0" },
  { name: "data", type: "String", default: "'{}'" },
  { name: "producer", type: "LowCardinality(String)", default: "'sdk'" },
  { name: "project_id", type: "String" },
  { name: "branch_id", type: "String" },
  { name: "user_id", type: "Nullable(String)" },
  { name: "team_id", type: "Nullable(String)" },
  { name: "refresh_token_id", type: "Nullable(String)" },
  { name: "session_replay_id", type: "Nullable(String)" },
  { name: "session_replay_segment_id", type: "Nullable(String)" },
  { name: "page_view_span_id", type: "Nullable(String)" },
  // Canonical AI-telemetry projection, extracted at ingest from the span's
  // attributes (Vercel AI SDK `ai.*`, current OTel `gen_ai.*`, and pre-rename
  // `gen_ai.*` spellings all normalize into these — see @hexclave/shared
  // gen-ai.tsx). First-class columns rather than query-time JSONExtract over
  // the `attributes` string because AI dashboards aggregate token counts and
  // filter by model/operation across the whole retention window, and the
  // attribute bag is a String precisely so tenant keys cannot become physical
  // subcolumns. All NULL for non-AI spans. Token counts include what the
  // narrower counts overlap (input_tokens contains cache reads), matching the
  // OTel GenAI hierarchy — never sum them together.
  { name: "gen_ai_operation_name", type: "LowCardinality(Nullable(String))" },
  { name: "gen_ai_provider_name", type: "LowCardinality(Nullable(String))" },
  { name: "gen_ai_request_model", type: "LowCardinality(Nullable(String))" },
  { name: "gen_ai_response_model", type: "LowCardinality(Nullable(String))" },
  { name: "gen_ai_input_tokens", type: "Nullable(UInt64)" },
  { name: "gen_ai_output_tokens", type: "Nullable(UInt64)" },
  { name: "gen_ai_cache_read_input_tokens", type: "Nullable(UInt64)" },
  { name: "gen_ai_reasoning_output_tokens", type: "Nullable(UInt64)" },
  { name: "gen_ai_tool_name", type: "Nullable(String)" },
  { name: "gen_ai_agent_name", type: "Nullable(String)" },
  { name: "gen_ai_conversation_id", type: "Nullable(String)" },
  { name: "created_at", type: "DateTime64(3, 'UTC')", default: "now64(3)" },
  { name: "version", type: "UInt64" },
] as const satisfies readonly ClickhouseColumn[];

export type SpanColumnName = (typeof SPANS_COLUMNS)[number]["name"];


// Partitioned by `started_at`, NOT by ingestion time: a ReplacingMergeTree's
// background merges never cross partitions, and `created_at` changes on every
// re-upsert of the same span — a span exported again in a later calendar month
// would land in a different partition and physically duplicate forever. SELECT
// ... FINAL happens to paper over that with default settings, but only by
// merge-sorting across partitions on every read, and it stops doing so under
// do_not_merge_across_partitions_select_final=1 — the standard FINAL
// optimization that a correctly-partitioned table is supposed to enable.
// `started_at` is immutable across re-upserts of one span identity (and matches
// how trace_roots is partitioned). buildSpansCreateTableSql is exported so the
// migration test can create the real shape under a throwaway name.
const SPANS_TABLE_ENGINE_SQL = `
ENGINE ReplacingMergeTree(version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (project_id, branch_id, trace_id, span_id)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}
SETTINGS non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`;

// The spans table had no skip indexes at all. The sorting key is
// (project_id, branch_id, trace_id, span_id), so any lookup that does not start
// from a trace id reads every granule in the tenant's partitions. These two are
// exactly the correlation columns the UI filters by without knowing a trace:
// "everything that happened on this page view" and "everything from this tab".
// bloom_filter (not set(0)) because both are high-cardinality — one value per page
// view / per browser tab — which is the case set() indexes degrade on.
export const SPANS_PAGE_VIEW_INDEX_NAME = "idx_page_view_span_id";
export const SPANS_PAGE_VIEW_INDEX_DEFINITION_SQL = "page_view_span_id TYPE bloom_filter(0.01) GRANULARITY 4";
export const SPANS_SEGMENT_INDEX_NAME = "idx_session_replay_segment_id";
export const SPANS_SEGMENT_INDEX_DEFINITION_SQL = "session_replay_segment_id TYPE bloom_filter(0.01) GRANULARITY 4";
// AI queries start from "the AI spans in this time range", not from a trace id,
// and in most workloads the overwhelming majority of granules contain zero AI
// spans. A set index over the low-cardinality operation column lets ClickHouse
// skip those granules for both `= 'chat'`-style filters and IS NOT NULL.
// set(0) (unbounded per-granule set) matches the events.event_type precedent
// and stays cheap because the column is LowCardinality.
export const SPANS_GEN_AI_OPERATION_INDEX_NAME = "idx_gen_ai_operation_name";
export const SPANS_GEN_AI_OPERATION_INDEX_DEFINITION_SQL = "gen_ai_operation_name TYPE set(0) GRANULARITY 4";

export function buildSpansCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, SPANS_COLUMNS, SPANS_TABLE_ENGINE_SQL, [
    `INDEX ${SPANS_PAGE_VIEW_INDEX_NAME} ${SPANS_PAGE_VIEW_INDEX_DEFINITION_SQL}`,
    `INDEX ${SPANS_SEGMENT_INDEX_NAME} ${SPANS_SEGMENT_INDEX_DEFINITION_SQL}`,
    `INDEX ${SPANS_GEN_AI_OPERATION_INDEX_NAME} ${SPANS_GEN_AI_OPERATION_INDEX_DEFINITION_SQL}`,
  ]);
}

const SPANS_TABLE_BASE_SQL = buildSpansCreateTableSql("analytics_internal.spans");

// Native OTLP Metrics are stored as one row per data point. The raw point JSON
// is the lossless contract for type-specific fields; the surrounding columns
// keep the identity, time, temporality, resource/scope, and exemplar fields
// queryable without re-parsing the entire payload for every read. The point
// identity is stable across retries, while ReplacingMergeTree(created_at)
// permits a later write at the same metric timestamp to supersede an earlier
// ambiguous delivery.
export const OTEL_METRICS_COLUMNS = [
  { name: "project_id", type: "String" },
  { name: "branch_id", type: "String" },
  { name: "metric_name", type: "String" },
  { name: "metric_description", type: "String", default: "''" },
  { name: "metric_unit", type: "String", default: "''" },
  { name: "metric_type", type: "LowCardinality(String)" },
  { name: "aggregation_temporality", type: "UInt8", default: "0" },
  { name: "is_monotonic", type: "UInt8", default: "0" },
  { name: "metric_metadata", type: "String", default: "'{}'" },
  { name: "resource_attributes", type: "String", default: "'{}'" },
  { name: "resource_dropped_attributes", type: "UInt32", default: "0" },
  { name: "resource_schema_url", type: "String", default: "''" },
  { name: "scope_name", type: "LowCardinality(Nullable(String))" },
  { name: "scope_version", type: "Nullable(String)" },
  { name: "scope_attributes", type: "String", default: "'{}'" },
  { name: "scope_dropped_attributes", type: "UInt32", default: "0" },
  { name: "scope_schema_url", type: "String", default: "''" },
  { name: "attributes", type: "String", default: "'{}'" },
  { name: "data_point", type: "String", default: "'{}'" },
  { name: "start_time_unix_nano", type: "Nullable(UInt64)" },
  { name: "time_unix_nano", type: "UInt64" },
  { name: "point_flags", type: "UInt32", default: "0" },
  { name: "exemplar_trace_id", type: "Nullable(String)" },
  { name: "exemplar_span_id", type: "Nullable(String)" },
  { name: "point_id", type: "String" },
  { name: "producer", type: "LowCardinality(String)", default: "'sdk'" },
  { name: "runtime", type: "LowCardinality(String)" },
  { name: "user_id", type: "Nullable(String)" },
  { name: "team_id", type: "Nullable(String)" },
  { name: "refresh_token_id", type: "Nullable(String)" },
  { name: "created_at", type: "DateTime64(3, 'UTC')", default: "now64(3)" },
] as const satisfies readonly ClickhouseColumn[];

export type OtelMetricsColumnName = (typeof OTEL_METRICS_COLUMNS)[number]["name"];

const OTEL_METRICS_TABLE_ENGINE_SQL = `
ENGINE ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(toDateTime(time_unix_nano / 1000000000))
ORDER BY (project_id, branch_id, point_id)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}
SETTINGS non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`;

export function buildOtelMetricsCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, OTEL_METRICS_COLUMNS, OTEL_METRICS_TABLE_ENGINE_SQL);
}

const OTEL_METRICS_TABLE_BASE_SQL = buildOtelMetricsCreateTableSql("analytics_internal.metrics");
const OTEL_METRICS_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.metrics", OTEL_METRICS_COLUMNS);

const SPANS_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.spans", SPANS_COLUMNS);

export const SPAN_LINKS_COLUMNS = [
  { name: "project_id", type: "String" },
  { name: "branch_id", type: "String" },
  { name: "trace_id", type: "String" },
  { name: "owner_span_id", type: "String" },
  { name: "linked_trace_id", type: "String" },
  { name: "linked_span_id", type: "String" },
  { name: "linked_project_id", type: "String", default: "project_id" },
  { name: "linked_branch_id", type: "String", default: "branch_id" },
  { name: "linked_trace_state", type: "Nullable(String)", default: "NULL" },
  { name: "linked_trace_flags", type: "UInt32", default: "0" },
  { name: "attributes", type: "String", default: "'{}'" },
  { name: "dropped_attributes", type: "UInt32", default: "0" },
  { name: "created_at", type: "DateTime64(3, 'UTC')", default: "now64(3)" },
] as const satisfies readonly ClickhouseColumn[];

export type SpanLinkColumnName = (typeof SPAN_LINKS_COLUMNS)[number]["name"];

// ReplacingMergeTree keyed by the link's full identity (the entire ORDER BY):
// the backend's self-instrumentation export is at-least-once, so a retried
// batch re-inserts identical links, and a plain MergeTree kept every copy. `created_at` as the version
// column makes which duplicate survives deterministic (the latest write).
// Known limitation, accepted as rare: dedup cannot cross partitions, so a
// retry that straddles a `created_at` month boundary keeps both copies — links
// have no client-supplied timestamp that could partition them stably.
const SPAN_LINKS_TABLE_ENGINE_SQL = `
ENGINE ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, trace_id, owner_span_id, linked_project_id, linked_branch_id, linked_trace_id, linked_span_id)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}`;

export function buildSpanLinksCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, SPAN_LINKS_COLUMNS, SPAN_LINKS_TABLE_ENGINE_SQL);
}

const SPAN_LINKS_TABLE_SQL = buildSpanLinksCreateTableSql("analytics_internal.span_links");

const SPAN_LINKS_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.span_links", SPAN_LINKS_COLUMNS);

export const PAGE_VIEWS_COLUMNS: readonly ClickhouseColumn[] = pickColumns(SPANS_COLUMNS, [
  "project_id",
  "branch_id",
  "user_id",
  "team_id",
  "refresh_token_id",
  "session_replay_id",
  "session_replay_segment_id",
  "started_at",
  "data",
  "trace_id",
  "span_id",
  "version",
]);

// Time is the product access path, but the complete span identity remains in
// the key so two traces that reuse a span id cannot collapse into one row.
export function buildPageViewsCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, PAGE_VIEWS_COLUMNS, `
ENGINE ReplacingMergeTree(version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (project_id, branch_id, started_at, span_id, trace_id)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS, "started_at")}`);
}

const PAGE_VIEWS_TABLE_SQL = buildPageViewsCreateTableSql("analytics_internal.page_views");

const PAGE_VIEWS_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.page_views", PAGE_VIEWS_COLUMNS);

export function buildPageViewsSourceSelectSql(database: string): string {
  return `
SELECT
  ${buildViewSelectList(PAGE_VIEWS_COLUMNS)}
FROM ${database}.spans
WHERE span_type = '$page-view'
`;
}

export const PAGE_VIEWS_SOURCE_SELECT_SQL = buildPageViewsSourceSelectSql("analytics_internal");

export function buildPageViewsMvSql(database: string): string {
  return `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.page_views_mv
TO ${database}.page_views
AS
${buildPageViewsSourceSelectSql(database)};
`;
}

const PAGE_VIEWS_MV_SQL = buildPageViewsMvSql("analytics_internal");

// Root spans are a tiny, time-ordered read model for the trace inbox. The main
// spans table is ordered by trace/span identity for point lookup and contains
// every auto-instrumented child, so asking it for recent roots would require
// FINAL-merging tens of millions of rows before applying the time/parent filters.
//
// The columns are picked out of SPANS_COLUMNS rather than restated so the types
// cannot drift from the source table — which would break the materialized
// view's positional INSERT.
//
// `trace_id` belongs in the sorting key even though the inbox never filters on
// it: this is a ReplacingMergeTree, and a backend-produced span id is unique
// only WITHIN its trace, so a key without trace_id would let two unrelated root
// spans that happen to share a span id collapse into a single row. It sits
// after `span_id` so the (project_id, branch_id, started_at) prefix still
// serves the inbox's keyset pagination.
export const TRACE_ROOTS_COLUMNS: readonly ClickhouseColumn[] = pickColumns(SPANS_COLUMNS, [
  "trace_id",
  "span_id",
  "span_type",
  "started_at",
  "ended_at",
  "kind",
  "status_code",
  "data",
  "service_namespace",
  "service_name",
  "service_version",
  "deployment_environment_name",
  "scope_name",
  "project_id",
  "branch_id",
  "user_id",
  "refresh_token_id",
  "session_replay_id",
  "session_replay_segment_id",
  "page_view_span_id",
  "created_at",
  "version",
]);

export function buildTraceRootsCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, TRACE_ROOTS_COLUMNS, `
ENGINE ReplacingMergeTree(version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (project_id, branch_id, started_at, span_id, trace_id)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}`);
}

const TRACE_ROOTS_TABLE_SQL = buildTraceRootsCreateTableSql("analytics_internal.trace_roots");

const TRACE_ROOTS_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.trace_roots", TRACE_ROOTS_COLUMNS);

// The trace-root index is deliberately a neutral projection: every span with
// no parent is a physical root. Framework-noise policy belongs to the OTel SDK
// at span creation, where it can participate in sampling and never requires a
// ClickHouse backfill or a policy-specific materialized-view migration.
export const TRACE_ROOTS_SOURCE_SELECT_SQL = `
SELECT
  ${buildViewSelectList(TRACE_ROOTS_COLUMNS)}
FROM analytics_internal.spans
WHERE parent_span_id IS NULL
`;

const TRACE_ROOTS_MV_SQL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_internal.trace_roots_mv
TO analytics_internal.trace_roots
AS
${TRACE_ROOTS_SOURCE_SELECT_SQL};
`;

export const TRACE_SERVICES_COLUMNS: readonly ClickhouseColumn[] = [
  { name: "project_id", type: "String" },
  { name: "branch_id", type: "String" },
  { name: "trace_id", type: "String" },
  { name: "service_namespace", type: "String" },
  { name: "service_name", type: "String" },
  // Exists solely to key the retention TTL the same way as the spans table
  // (copied from the source span's `created_at`, i.e. ingestion time). It is
  // NOT the ReplacingMergeTree version column — `version` (the span's ended_at)
  // keeps that job so re-exported spans still dedupe deterministically.
  { name: "created_at", type: "DateTime64(3, 'UTC')", default: "now64(3)" },
  { name: "version", type: "UInt64" },
];

export function buildTraceServicesCreateTableSql(fullTableName: string): string {
  return buildCreateTableSql(fullTableName, TRACE_SERVICES_COLUMNS, `
ENGINE ReplacingMergeTree(version)
ORDER BY (project_id, branch_id, service_namespace, service_name, trace_id)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS)}`);
}

const TRACE_SERVICES_TABLE_SQL = buildTraceServicesCreateTableSql("analytics_internal.trace_services");

const TRACE_SERVICES_SCHEMA_UPGRADE_SQL = buildColumnUpgradeSql("analytics_internal.trace_services", TRACE_SERVICES_COLUMNS);

export const TRACE_SERVICES_SOURCE_SELECT_SQL = `
SELECT
  project_id,
  branch_id,
  trace_id,
  coalesce(service_namespace, '') AS service_namespace,
  coalesce(service_name, '') AS service_name,
  created_at,
  version
FROM analytics_internal.spans
WHERE service_name IS NOT NULL
`;

const TRACE_SERVICES_MV_SQL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_internal.trace_services_mv
TO analytics_internal.trace_services
AS
${TRACE_SERVICES_SOURCE_SELECT_SQL};
`;

// Immutable billing ledger for custom-span writes. The source spans table is a
// ReplacingMergeTree whose old versions disappear during background merges, so
// it cannot answer how many writes were accepted during a billing period. The
// materialized view records one row for every custom-span row inserted while
// excluding the free $-prefixed system spans.
// Builders take the database name so the migration test can exercise the real
// billing filter against a throwaway database.
export function buildSpanWritesCreateTableSql(database: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${database}.span_writes (
    project_id String,
    created_at DateTime64(3, 'UTC')
)
ENGINE MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, created_at)
TTL ${buildRetentionTtlSql(SPAN_WRITES_TTL_DAYS)};
`;
}

const SPAN_WRITES_TABLE_SQL = buildSpanWritesCreateTableSql("analytics_internal");

export function buildSpanWritesMvSql(database: string): string {
  return `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.span_writes_mv
TO ${database}.span_writes
AS
SELECT project_id, created_at
FROM ${database}.spans
WHERE producer = 'sdk' AND billing_item = 'analytics_spans';
`;
}

const SPAN_WRITES_MV_SQL = buildSpanWritesMvSql("analytics_internal");

// Refresh tokens are synced dimensions rather than telemetry writes. Project
// each token into the same scalar W3C shape as physical spans so it remains the
// canonical root of the session trace without duplicating dimension state.
// The alias order is deliberately identical to SPANS_COLUMNS minus `version`:
// ClickHouse UNION ALL is positional and several adjacent columns share types.
// Every source column is qualified because ClickHouse resolves SELECT aliases
// globally: an unqualified source `created_at` would bind to the later output
// alias and turn the token's interval start into its latest sync timestamp.
export const REFRESH_TOKEN_SPAN_SELECT_SQL = `
SELECT
  replaceAll(lower(toString(rt.id)), '-', '') AS trace_id,
  right(replaceAll(lower(toString(rt.id)), '-', ''), 16) AS span_id,
  CAST('$refresh-token', 'LowCardinality(String)') AS span_type,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS billing_item,
  rt.created_at AS started_at,
  rt.expires_at AS ended_at,
  CAST(NULL, 'Nullable(String)') AS parent_span_id,
  CAST('', 'String') AS trace_state,
  CAST(0, 'UInt32') AS trace_flags,
  CAST(toUnixTimestamp64Milli(rt.created_at) * 1000000, 'UInt64') AS start_time_unix_nano,
  CAST(toUnixTimestamp64Milli(rt.expires_at) * 1000000, 'UInt64') AS end_time_unix_nano,
  CAST('internal', 'LowCardinality(String)') AS kind,
  CAST('unset', 'LowCardinality(String)') AS status_code,
  CAST(NULL, 'Nullable(String)') AS status_message,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS service_namespace,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS service_name,
  CAST(NULL, 'Nullable(String)') AS service_version,
  CAST(NULL, 'Nullable(String)') AS service_instance_id,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS deployment_environment_name,
  CAST('{}', 'String') AS resource_attributes,
  CAST(0, 'UInt32') AS resource_dropped_attributes,
  CAST('', 'String') AS resource_schema_url,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS scope_name,
  CAST(NULL, 'Nullable(String)') AS scope_version,
  CAST('{}', 'String') AS scope_attributes,
  CAST(0, 'UInt32') AS scope_dropped_attributes,
  CAST('', 'String') AS scope_schema_url,
  CAST('{}', 'String') AS attributes,
  CAST(0, 'UInt32') AS dropped_attributes,
  CAST(0, 'UInt32') AS dropped_events,
  CAST(0, 'UInt32') AS dropped_links,
  CAST('{}', 'String') AS data,
  CAST('sdk', 'LowCardinality(String)') AS producer,
  rt.project_id AS project_id,
  rt.branch_id AS branch_id,
  CAST(toString(rt.user_id), 'Nullable(String)') AS user_id,
  CAST(NULL, 'Nullable(String)') AS team_id,
  CAST(toString(rt.id), 'Nullable(String)') AS refresh_token_id,
  CAST(NULL, 'Nullable(String)') AS session_replay_id,
  CAST(NULL, 'Nullable(String)') AS session_replay_segment_id,
  CAST(NULL, 'Nullable(String)') AS page_view_span_id,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS gen_ai_operation_name,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS gen_ai_provider_name,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS gen_ai_request_model,
  CAST(NULL, 'LowCardinality(Nullable(String))') AS gen_ai_response_model,
  CAST(NULL, 'Nullable(UInt64)') AS gen_ai_input_tokens,
  CAST(NULL, 'Nullable(UInt64)') AS gen_ai_output_tokens,
  CAST(NULL, 'Nullable(UInt64)') AS gen_ai_cache_read_input_tokens,
  CAST(NULL, 'Nullable(UInt64)') AS gen_ai_reasoning_output_tokens,
  CAST(NULL, 'Nullable(String)') AS gen_ai_tool_name,
  CAST(NULL, 'Nullable(String)') AS gen_ai_agent_name,
  CAST(NULL, 'Nullable(String)') AS gen_ai_conversation_id,
  rt.sync_created_at AS created_at
FROM analytics_internal.refresh_tokens AS rt FINAL
WHERE rt.sync_is_deleted = 0
`;

export const REFRESH_TOKEN_SPAN_SELECT_ALIASES: readonly string[] = [
  "trace_id",
  "span_id",
  "span_type",
  "billing_item",
  "started_at",
  "ended_at",
  "parent_span_id",
  "trace_state",
  "trace_flags",
  "start_time_unix_nano",
  "end_time_unix_nano",
  "kind",
  "status_code",
  "status_message",
  "service_namespace",
  "service_name",
  "service_version",
  "service_instance_id",
  "deployment_environment_name",
  "resource_attributes",
  "resource_dropped_attributes",
  "resource_schema_url",
  "scope_name",
  "scope_version",
  "scope_attributes",
  "scope_dropped_attributes",
  "scope_schema_url",
  "attributes",
  "dropped_attributes",
  "dropped_events",
  "dropped_links",
  "data",
  "producer",
  "project_id",
  "branch_id",
  "user_id",
  "team_id",
  "refresh_token_id",
  "session_replay_id",
  "session_replay_segment_id",
  "page_view_span_id",
  "gen_ai_operation_name",
  "gen_ai_provider_name",
  "gen_ai_request_model",
  "gen_ai_response_model",
  "gen_ai_input_tokens",
  "gen_ai_output_tokens",
  "gen_ai_cache_read_input_tokens",
  "gen_ai_reasoning_output_tokens",
  "gen_ai_tool_name",
  "gen_ai_agent_name",
  "gen_ai_conversation_id",
  "created_at",
];

export const SPANS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.spans
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(SPANS_COLUMNS, ["version"])}
FROM analytics_internal.spans FINAL

UNION ALL

${REFRESH_TOKEN_SPAN_SELECT_SQL};
`;

export const PAGE_VIEWS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.page_views
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(PAGE_VIEWS_COLUMNS, ["version"])}
FROM analytics_internal.page_views FINAL

UNION ALL

SELECT
  project_id,
  branch_id,
  user_id,
  team_id,
  refresh_token_id,
  session_replay_id,
  session_replay_segment_id,
  event_at AS started_at,
  toString(data) AS data,
  trace_id,
  span_id
FROM analytics_internal.events
WHERE event_type = '$page-view';
`;

const SPAN_LINKS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.span_links
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(SPAN_LINKS_COLUMNS)}
FROM analytics_internal.span_links FINAL;
`;

export const TRACE_ROOTS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.trace_roots
SQL SECURITY DEFINER
AS
SELECT
  ${buildViewSelectList(TRACE_ROOTS_COLUMNS, ["version"])}
FROM analytics_internal.trace_roots FINAL

UNION ALL

SELECT
  ${buildViewSelectList(TRACE_ROOTS_COLUMNS, ["version"])}
FROM (
  ${REFRESH_TOKEN_SPAN_SELECT_SQL}
);
`;

const TRACE_SERVICES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.trace_services
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  trace_id,
  nullIf(service_namespace, '') AS service_namespace,
  service_name
FROM analytics_internal.trace_services FINAL;
`;

const CONTACT_CHANNELS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.contact_channels (
    project_id String,
    branch_id String,
    id UUID,
    user_id UUID,
    type LowCardinality(String),
    value String,
    is_primary UInt8,
    is_verified UInt8,
    used_for_auth UInt8,
    created_at DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const CONTACT_CHANNELS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.contact_channels
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  user_id,
  type,
  value,
  is_primary,
  is_verified,
  used_for_auth,
  created_at
FROM analytics_internal.contact_channels
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAMS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.teams (
    project_id String,
    branch_id String,
    id UUID,
    display_name String,
    profile_image_url Nullable(String),
    created_at DateTime64(3, 'UTC'),
    client_metadata String,
    client_read_only_metadata String,
    server_metadata String,
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const TEAMS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.teams
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  display_name,
  profile_image_url,
  created_at,
  client_metadata,
  client_read_only_metadata,
  server_metadata
FROM analytics_internal.teams
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAM_MEMBER_PROFILES_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.team_member_profiles (
    project_id String,
    branch_id String,
    team_id UUID,
    user_id UUID,
    display_name Nullable(String),
    profile_image_url Nullable(String),
    created_at DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, team_id, user_id);
`;

const TEAM_MEMBER_PROFILES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.team_member_profiles
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  team_id,
  user_id,
  display_name,
  profile_image_url,
  created_at
FROM analytics_internal.team_member_profiles
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAM_PERMISSIONS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.team_permissions (
    project_id       String,
    branch_id        String,
    team_id          UUID,
    user_id          UUID,
    id               String,
    created_at       DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted  UInt8,
    sync_created_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, team_id, user_id, id);
`;

const TEAM_PERMISSIONS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.team_permissions
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  team_id,
  user_id,
  id,
  created_at
FROM analytics_internal.team_permissions
FINAL
WHERE sync_is_deleted = 0;
`;

const TEAM_INVITATIONS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.team_invitations (
    project_id         String,
    branch_id          String,
    id                 UUID,
    team_id            UUID,
    team_display_name  String,
    recipient_email    String,
    expires_at_millis  Int64,
    created_at         DateTime64(3, 'UTC'),
    sync_sequence_id   Int64,
    sync_is_deleted    UInt8,
    sync_created_at    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const TEAM_INVITATIONS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.team_invitations
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  team_id,
  team_display_name,
  recipient_email,
  expires_at_millis,
  created_at
FROM analytics_internal.team_invitations
FINAL
WHERE sync_is_deleted = 0;
`;

const EMAIL_OUTBOXES_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.email_outboxes (
    project_id String,
    branch_id String,
    id UUID,
    status LowCardinality(String),
    simple_status LowCardinality(String),
    created_with LowCardinality(String),
    email_draft_id Nullable(String),
    email_programmatic_call_template_id Nullable(String),
    theme_id Nullable(String),
    is_high_priority UInt8,
    is_transactional Nullable(UInt8),
    subject Nullable(String),
    notification_category_id Nullable(String),
    started_rendering_at Nullable(DateTime64(3, 'UTC')),
    rendered_at Nullable(DateTime64(3, 'UTC')),
    render_error Nullable(String),
    scheduled_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC'),
    updated_at DateTime64(3, 'UTC'),
    started_sending_at Nullable(DateTime64(3, 'UTC')),
    server_error Nullable(String),
    delivered_at Nullable(DateTime64(3, 'UTC')),
    opened_at Nullable(DateTime64(3, 'UTC')),
    clicked_at Nullable(DateTime64(3, 'UTC')),
    unsubscribed_at Nullable(DateTime64(3, 'UTC')),
    marked_as_spam_at Nullable(DateTime64(3, 'UTC')),
    bounced_at Nullable(DateTime64(3, 'UTC')),
    delivery_delayed_at Nullable(DateTime64(3, 'UTC')),
    can_have_delivery_info Nullable(UInt8),
    skipped_reason LowCardinality(Nullable(String)),
    skipped_details Nullable(String),
    send_retries Int32,
    is_paused UInt8,
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const EMAIL_OUTBOXES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.email_outboxes
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  status,
  simple_status,
  created_with,
  email_draft_id,
  email_programmatic_call_template_id,
  theme_id,
  is_high_priority,
  is_transactional,
  subject,
  notification_category_id,
  started_rendering_at,
  rendered_at,
  render_error,
  scheduled_at,
  created_at,
  updated_at,
  started_sending_at,
  server_error,
  delivered_at,
  opened_at,
  clicked_at,
  unsubscribed_at,
  marked_as_spam_at,
  bounced_at,
  delivery_delayed_at,
  can_have_delivery_info,
  skipped_reason,
  skipped_details,
  send_retries,
  is_paused
FROM analytics_internal.email_outboxes
FINAL
WHERE sync_is_deleted = 0;
`;


const PROJECT_PERMISSIONS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.project_permissions (
    project_id       String,
    branch_id        String,
    user_id          UUID,
    id               String,
    created_at       DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted  UInt8,
    sync_created_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, user_id, id);
`;

const PROJECT_PERMISSIONS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.project_permissions
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  user_id,
  id,
  created_at
FROM analytics_internal.project_permissions
FINAL
WHERE sync_is_deleted = 0;
`;

const NOTIFICATION_PREFERENCES_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.notification_preferences (
    project_id             String,
    branch_id              String,
    user_id                UUID,
    notification_category_id String,
    enabled                UInt8,
    sync_sequence_id       Int64,
    sync_is_deleted        UInt8,
    sync_created_at        DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
ORDER BY (project_id, branch_id, user_id, notification_category_id);
`;

const NOTIFICATION_PREFERENCES_VIEW_SQL = `
CREATE OR REPLACE VIEW default.notification_preferences
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  user_id,
  notification_category_id,
  enabled
FROM analytics_internal.notification_preferences
FINAL
WHERE sync_is_deleted = 0;
`;

const REFRESH_TOKENS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.refresh_tokens (
    project_id String,
    branch_id String,
    id UUID,
    user_id UUID,
    created_at DateTime64(3, 'UTC'),
    last_used_at DateTime64(3, 'UTC'),
    is_impersonation UInt8,
    expires_at Nullable(DateTime64(3, 'UTC')),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, id);
`;

const REFRESH_TOKENS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.refresh_tokens
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  id,
  user_id,
  created_at,
  last_used_at,
  is_impersonation,
  expires_at
FROM analytics_internal.refresh_tokens
FINAL
WHERE sync_is_deleted = 0;
`;

const CONNECTED_ACCOUNTS_TABLE_BASE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.connected_accounts (
    project_id String,
    branch_id String,
    user_id UUID,
    provider String,
    provider_account_id String,
    created_at DateTime64(3, 'UTC'),
    sync_sequence_id Int64,
    sync_is_deleted UInt8,
    sync_created_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE ReplacingMergeTree(sync_sequence_id)
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, branch_id, user_id, provider, provider_account_id);
`;

const CONNECTED_ACCOUNTS_VIEW_SQL = `
CREATE OR REPLACE VIEW default.connected_accounts
SQL SECURITY DEFINER
AS
SELECT
  project_id,
  branch_id,
  user_id,
  provider,
  provider_account_id,
  created_at
FROM analytics_internal.connected_accounts
FINAL
WHERE sync_is_deleted = 0;
`;

const OTEL_VIEW_COLUMN_DESCRIPTIONS = new Map<string, string>([
  ["billing_item", "Platform metering category the span is billed under (for example analytics_spans); null when the span is not metered"],
  ["event_type", "Event or log classification emitted by the OpenTelemetry producer"],
  ["event_at", "Time at which the OpenTelemetry record occurred (UTC)"],
  ["message", "Human-readable message associated with the record, when present"],
  ["level", "Normalized severity level reported by the producer"],
  ["data", "Structured application payload as JSON"],
  ["body", "OpenTelemetry log body serialized as JSON"],
  ["attributes", "OpenTelemetry record attributes as JSON"],
  ["resource_attributes", "OpenTelemetry resource attributes as JSON"],
  ["scope_attributes", "OpenTelemetry instrumentation-scope attributes as JSON"],
  ["trace_id", "Trace identity shared by all spans and records in the trace"],
  ["span_id", "Span identity associated with this record, when present"],
  ["parent_span_id", "Immediate parent span identity, when present"],
  ["span_type", "OpenTelemetry span name"],
  ["started_at", "Time at which the span started (UTC)"],
  ["ended_at", "Time at which the span ended (UTC)"],
  ["kind", "OpenTelemetry span kind"],
  ["status_code", "OpenTelemetry operation status"],
  ["status_message", "Optional OpenTelemetry operation status message"],
  ["service_namespace", "Logical namespace of the producing service, when reported"],
  ["service_name", "Name of the producing service"],
  ["service_version", "Version of the producing service, when reported"],
  ["deployment_environment_name", "Deployment environment reported by the producer"],
  ["project_id", "Project identifier, automatically constrained by row-level security"],
  ["branch_id", "Branch identifier, automatically constrained by row-level security"],
  ["user_id", "User associated with the record, when known"],
  ["refresh_token_id", "Session refresh-token identifier, when known"],
  ["session_replay_id", "Session replay identifier, when known"],
  ["session_replay_segment_id", "Session replay segment identifier, when known"],
  ["page_view_span_id", "Page-view span associated with the record, when known"],
  ["created_at", "Time at which the record was inserted (UTC)"],
]);

function buildOtelViewColumnCommentStatements(
  table: string,
  columns: readonly ClickhouseColumn[],
  omittedColumns: readonly string[] = [],
): string[] {
  const omitted = new Set(omittedColumns);
  return columns
    .filter((column) => !omitted.has(column.name))
    .map((column) => {
      const description = OTEL_VIEW_COLUMN_DESCRIPTIONS.get(column.name)
        ?? `OpenTelemetry ${column.name.replace(/_/g, " ")} value exposed by the ${table} view`;
      return `ALTER TABLE default.${table} COMMENT COLUMN ${column.name} '${description}'`;
    });
}

const OTEL_VIEW_COLUMN_COMMENT_STATEMENTS = [
  ...buildOtelViewColumnCommentStatements("logs", LOGS_COLUMNS, [...ERROR_GROUPING_COLUMN_NAMES, ...ERROR_ENVELOPE_COLUMN_NAMES]),
  ...buildOtelViewColumnCommentStatements("errors", LOGS_COLUMNS),
  ...buildOtelViewColumnCommentStatements("span_events", SPAN_EVENTS_COLUMNS),
  ...buildOtelViewColumnCommentStatements("span_links", SPAN_LINKS_COLUMNS),
  ...buildOtelViewColumnCommentStatements("page_views", PAGE_VIEWS_COLUMNS, ["version"]),
  ...buildOtelViewColumnCommentStatements("trace_roots", TRACE_ROOTS_COLUMNS, ["version"]),
  ...buildOtelViewColumnCommentStatements("trace_services", TRACE_SERVICES_COLUMNS, ["created_at", "version"]),
];

// ─── Column comments ────────────────────────────────────────────────
// Applied to the default.* views after creation so that DESCRIBE TABLE
// returns useful descriptions for each column. The AI assistant uses
// SHOW TABLES + DESCRIBE TABLE for schema discovery instead of
// hardcoded schema in the prompt.
const COLUMN_COMMENT_STATEMENTS: string[] = [
  // ── events ──
  `ALTER TABLE default.events COMMENT COLUMN event_type 'Event type identifier. Known system types: \$click, \$keystroke, \$form-submit, \$window-resize, \$copy, \$cut, \$paste, \$context-menu, \$print, \$fullscreen-exit, \$token-refresh, \$sign-up-rule-trigger, \$log (log lines), \$error (captured errors); other values are customer-defined custom events. Query default.page_views for page views across current and legacy SDK writes'`,
  `ALTER TABLE default.events COMMENT COLUMN event_at 'When the event occurred (UTC)'`,
  `ALTER TABLE default.events COMMENT COLUMN level 'Log severity level (trace, debug, info, warn, or error). Always empty here: \$log and \$error rows are exposed via default.logs and default.errors instead of this view'`,
  `ALTER TABLE default.events COMMENT COLUMN data 'Event payload as JSON. MUST use toString(data) before JSONExtract* functions. Payload varies by event_type: \$click → {is_anonymous, selector, url, viewport_width, viewport_height, x, y, ...}; \$token-refresh → {is_anonymous, refresh_token_id, ip_info: {country_code, city_name, region_code, is_trusted, latitude, longitude, tz_identifier, ip}}'`,
  `ALTER TABLE default.events COMMENT COLUMN producer 'Who wrote the row: sdk = the application via the Hexclave SDK; hexclave-backend = Hexclave itself on the project behalf (system events like \$token-refresh, platform-produced logs)'`,
  `ALTER TABLE default.events COMMENT COLUMN runtime 'Where the producing code ran: browser (client-side SDK), server (server-side SDK), or system (written by Hexclave itself)'`,
  `ALTER TABLE default.events COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.events COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.events COMMENT COLUMN user_id 'User who triggered the event. NULL for rows that are not attributable to a user'`,
  `ALTER TABLE default.events COMMENT COLUMN team_id 'Reserved for future use. Currently always NULL — do not filter on this column'`,
  `ALTER TABLE default.events COMMENT COLUMN created_at 'When this record was inserted into the database (UTC)'`,
  `ALTER TABLE default.events COMMENT COLUMN refresh_token_id 'The session (refresh token) this event happened in, when known'`,
  `ALTER TABLE default.events COMMENT COLUMN session_replay_id 'Session replay identifier for linking to replay recordings'`,
  `ALTER TABLE default.events COMMENT COLUMN session_replay_segment_id 'Segment within a session replay recording'`,
  `ALTER TABLE default.events COMMENT COLUMN trace_id 'The trace this event belongs to, when known'`,
  `ALTER TABLE default.events COMMENT COLUMN trace_id 'Trace of the span this event happened inside, when known. NULL for events recorded outside any span — an event is an instant and never roots a trace of its own'`,
  `ALTER TABLE default.events COMMENT COLUMN span_id 'The exact span this event happened inside, when known. Join default.spans on (trace_id, span_id)'`,
  `ALTER TABLE default.events COMMENT COLUMN page_view_span_id 'Which \$page-view span the event happened on. A correlation label, not ancestry — join default.spans on span_id'`,
  `ALTER TABLE default.events COMMENT COLUMN service_namespace 'Logical grouping the sending service reported for itself, when reported'`,
  `ALTER TABLE default.events COMMENT COLUMN service_name 'Name of the service that produced the event. Required for SDK-produced rows; NULL only for service-neutral platform-derived rows'`,
  `ALTER TABLE default.events COMMENT COLUMN service_version 'Version of the sending service, when reported'`,
  `ALTER TABLE default.events COMMENT COLUMN service_instance_id 'Identifier of the specific service instance that produced the event, when reported'`,
  `ALTER TABLE default.events COMMENT COLUMN deployment_environment_name 'Deployment environment reported by the sending service (e.g. production, staging), when reported'`,
  `ALTER TABLE default.events COMMENT COLUMN resource_attributes 'Additional resource metadata reported by the sending service, as JSON string. Common service and deployment identity fields have dedicated columns'`,

  `ALTER TABLE default.spans COMMENT COLUMN trace_id 'Identity shared by every span in one trace: 32 lowercase hex characters (W3C trace id). Authenticated browser telemetry uses one trace per refresh-token session, including replay, page, client request, and backend descendants'`,
  `ALTER TABLE default.spans COMMENT COLUMN span_id 'Span identity: 16 lowercase hex characters (W3C span id), unique within its trace rather than globally — always match on (trace_id, span_id)'`,
  `ALTER TABLE default.spans COMMENT COLUMN span_type 'The OpenTelemetry span name, including customer-defined and auto-instrumented operations'`,
  `ALTER TABLE default.spans COMMENT COLUMN started_at 'When the span started (UTC)'`,
  `ALTER TABLE default.spans COMMENT COLUMN ended_at 'When the span ended (UTC). NULL while it is still open'`,
  `ALTER TABLE default.spans COMMENT COLUMN parent_span_id 'The immediate parent span within the same trace. NULL means this span IS the trace root'`,
  `ALTER TABLE default.spans COMMENT COLUMN kind 'Role of the span in a request flow: internal, server, client, producer, or consumer'`,
  `ALTER TABLE default.spans COMMENT COLUMN status_code 'Outcome of the operation: ok, error, or unset when the producer did not report one'`,
  `ALTER TABLE default.spans COMMENT COLUMN status_message 'Optional error/status description accompanying status_code'`,
  `ALTER TABLE default.spans COMMENT COLUMN data 'Structured span payload as JSON string. Use JSONExtract* functions directly (e.g. JSONExtractString(data, path))'`,
  `ALTER TABLE default.spans COMMENT COLUMN producer 'Who wrote the span. sdk = an authenticated application using the Hexclave SDK, including Hexclave backend telemetry owned by the internal project'`,
  `ALTER TABLE default.spans COMMENT COLUMN service_namespace 'Logical grouping the sending service reported for itself, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN service_name 'Name of the service that produced the span. Required for SDK-produced physical spans; NULL only for service-neutral platform-derived spans'`,
  `ALTER TABLE default.spans COMMENT COLUMN service_version 'Version of the sending service, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN service_instance_id 'Identifier of the specific service instance that produced the span, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN deployment_environment_name 'Deployment environment reported by the sending service (e.g. production, staging), when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN resource_attributes 'Additional environment metadata reported by the sending service, as JSON string. Common service and deployment identity fields have dedicated columns'`,
  `ALTER TABLE default.spans COMMENT COLUMN scope_name 'Name of the instrumentation component inside the sending service that produced the span, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN scope_version 'Version of the instrumentation component that produced the span, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.spans COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.spans COMMENT COLUMN user_id 'User the span is attributed to, when known'`,
  `ALTER TABLE default.spans COMMENT COLUMN team_id 'Reserved for future use. Currently always NULL — do not filter on this column'`,
  `ALTER TABLE default.spans COMMENT COLUMN refresh_token_id 'The session (refresh token) the span happened in, when known. The corresponding $refresh-token span is the root of authenticated browser traces'`,
  `ALTER TABLE default.spans COMMENT COLUMN session_replay_id 'Session replay identifier for linking to replay recordings'`,
  `ALTER TABLE default.spans COMMENT COLUMN session_replay_segment_id 'Segment within a session replay recording (one per browser tab); represented as a lifecycle ancestor when replay capture is enabled'`,
  `ALTER TABLE default.spans COMMENT COLUMN page_view_span_id 'Which \$page-view span this span happened on. Join default.spans on (trace_id, span_id); hierarchy itself remains parent_span_id'`,
  `ALTER TABLE default.spans COMMENT COLUMN created_at 'When this record was inserted into the database (UTC)'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_operation_name 'AI operation performed by this span, normalized at ingest from OTel GenAI and Vercel AI SDK telemetry: chat, embeddings, execute_tool, invoke_agent, invoke_workflow, and the other gen_ai.operation.name values. NULL for non-AI spans — filter gen_ai_operation_name IS NOT NULL to select AI/agent telemetry'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_provider_name 'AI provider serving the request (e.g. openai, anthropic, aws.bedrock), when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_request_model 'Model name the application requested (e.g. gpt-4.1, claude-fable-5), when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_response_model 'Model name the provider reported actually serving the response, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_input_tokens 'Input (prompt) tokens consumed, INCLUDING any cached input tokens. NULL when the producer did not report usage'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_output_tokens 'Output (completion) tokens produced, including reasoning output tokens where the provider counts them. NULL when the producer did not report usage'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_cache_read_input_tokens 'Portion of gen_ai_input_tokens served from the provider prompt cache — already counted in gen_ai_input_tokens, do not add them together'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_reasoning_output_tokens 'Portion of output tokens spent on reasoning, when reported separately — already counted in gen_ai_output_tokens, do not add them together'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_tool_name 'Name of the tool executed by an execute_tool span, when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_agent_name 'Name of the agent handling an invoke_agent/create_agent span (for Vercel AI SDK telemetry, the functionId), when reported'`,
  `ALTER TABLE default.spans COMMENT COLUMN gen_ai_conversation_id 'Application-assigned conversation/session identifier linking multi-turn AI interactions, when reported'`,

  // ── users ──
  `ALTER TABLE default.users COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.users COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.users COMMENT COLUMN id 'Unique user identifier (UUID primary key)'`,
  `ALTER TABLE default.users COMMENT COLUMN display_name 'User-facing display name set by the user or application'`,
  `ALTER TABLE default.users COMMENT COLUMN profile_image_url 'URL to the user profile/avatar image'`,
  `ALTER TABLE default.users COMMENT COLUMN primary_email 'User primary email address'`,
  `ALTER TABLE default.users COMMENT COLUMN primary_email_verified '1 if the primary email has been verified, 0 otherwise'`,
  `ALTER TABLE default.users COMMENT COLUMN signed_up_at 'When the user first signed up (UTC)'`,
  `ALTER TABLE default.users COMMENT COLUMN client_metadata 'Application-defined JSON metadata readable and writable from client SDKs'`,
  `ALTER TABLE default.users COMMENT COLUMN client_read_only_metadata 'Application-defined JSON metadata readable from client SDKs but only writable from server'`,
  `ALTER TABLE default.users COMMENT COLUMN server_metadata 'Application-defined JSON metadata only accessible from server SDKs'`,
  `ALTER TABLE default.users COMMENT COLUMN is_anonymous '1 if this is an anonymous/guest user, 0 for authenticated users'`,
  `ALTER TABLE default.users COMMENT COLUMN restricted_by_admin '1 if an admin has restricted this user access'`,
  `ALTER TABLE default.users COMMENT COLUMN restricted_by_admin_reason 'Admin-provided reason for restricting the user, shown to the user'`,
  `ALTER TABLE default.users COMMENT COLUMN restricted_by_admin_private_details 'Private admin notes about the restriction, not shown to the user'`,

  // ── contact_channels ──
  `ALTER TABLE default.contact_channels COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN id 'Unique contact channel identifier'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN user_id 'Owner user ID (join to users.id)'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN type 'Channel type, e.g. email'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN value 'Channel value, e.g. the email address'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN is_primary '1 if this is the user primary contact channel'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN is_verified '1 if ownership of this channel has been verified'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN used_for_auth '1 if this channel can be used as an authentication identifier'`,
  `ALTER TABLE default.contact_channels COMMENT COLUMN created_at 'When this contact channel was created (UTC)'`,

  // ── teams ──
  `ALTER TABLE default.teams COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.teams COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.teams COMMENT COLUMN id 'Unique team identifier'`,
  `ALTER TABLE default.teams COMMENT COLUMN display_name 'Team name shown in the UI'`,
  `ALTER TABLE default.teams COMMENT COLUMN profile_image_url 'URL to the team logo/avatar image'`,
  `ALTER TABLE default.teams COMMENT COLUMN created_at 'When the team was created (UTC)'`,
  `ALTER TABLE default.teams COMMENT COLUMN client_metadata 'Application-defined JSON metadata readable and writable from client SDKs'`,
  `ALTER TABLE default.teams COMMENT COLUMN client_read_only_metadata 'Application-defined JSON metadata readable from client SDKs but only writable from server'`,
  `ALTER TABLE default.teams COMMENT COLUMN server_metadata 'Application-defined JSON metadata only accessible from server SDKs'`,

  // ── team_member_profiles ──
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN team_id 'Team this membership belongs to (join to teams.id)'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN user_id 'User in this membership (join to users.id)'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN display_name 'Per-team display name override. NULL means use the user default display_name'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN profile_image_url 'Per-team profile image override. NULL means use the user default'`,
  `ALTER TABLE default.team_member_profiles COMMENT COLUMN created_at 'When this team membership was created (UTC)'`,

  // ── team_permissions ──
  `ALTER TABLE default.team_permissions COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN team_id 'Team this permission is scoped to (join to teams.id)'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN user_id 'User granted this permission (join to users.id)'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN id 'Permission identifier string, e.g. admin, member'`,
  `ALTER TABLE default.team_permissions COMMENT COLUMN created_at 'When this permission was granted (UTC)'`,

  // ── team_invitations ──
  `ALTER TABLE default.team_invitations COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN id 'Unique invitation identifier'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN team_id 'Team being invited to (join to teams.id)'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN team_display_name 'Snapshot of the team name at invitation time'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN recipient_email 'Email address the invitation was sent to'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN expires_at_millis 'Invitation expiry as Unix milliseconds. Compare with toUnixTimestamp64Milli(now())'`,
  `ALTER TABLE default.team_invitations COMMENT COLUMN created_at 'When the invitation was created (UTC)'`,

  // ── email_outboxes ──
  `ALTER TABLE default.email_outboxes COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN id 'Unique email record identifier'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN status 'Granular delivery status from the email provider'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN simple_status 'Simplified status for reporting, e.g. sent, delivered, failed'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN created_with 'How this email was created, e.g. programmatic API or draft editor'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN email_draft_id 'ID of the email draft template used, if created from a draft'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN email_programmatic_call_template_id 'ID of the programmatic template, if sent via API'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN theme_id 'Email theme/design ID applied to this email'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN is_high_priority '1 if marked as high priority for send ordering'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN is_transactional '1 for transactional emails (e.g. verification), NULL if unknown'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN subject 'Email subject line'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN notification_category_id 'Category for notification preferences/unsubscribe'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN started_rendering_at 'When email rendering began (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN rendered_at 'When email rendering completed (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN render_error 'Error message if rendering failed. Non-null implies render failure'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN scheduled_at 'When the email is/was scheduled to be sent (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN created_at 'When this email record was created (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN updated_at 'When this email record was last updated (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN started_sending_at 'When the send attempt began (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN server_error 'Error from the email provider. Non-null implies send failure'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN delivered_at 'When the email was confirmed delivered (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN opened_at 'When the recipient first opened the email (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN clicked_at 'When the recipient first clicked a link in the email (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN unsubscribed_at 'When the recipient unsubscribed via this email (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN marked_as_spam_at 'When the recipient marked this email as spam (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN bounced_at 'When the email bounced (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN delivery_delayed_at 'When a delivery delay was reported (UTC)'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN can_have_delivery_info '1 if the email provider supports delivery tracking for this email'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN skipped_reason 'Why sending was skipped, if applicable. Non-null implies send was skipped'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN skipped_details 'Additional details about why sending was skipped'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN send_retries 'Number of send retry attempts made'`,
  `ALTER TABLE default.email_outboxes COMMENT COLUMN is_paused '1 if email sending is currently paused'`,

  // ── project_permissions ──
  `ALTER TABLE default.project_permissions COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN user_id 'User granted this permission (join to users.id)'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN id 'Permission identifier string'`,
  `ALTER TABLE default.project_permissions COMMENT COLUMN created_at 'When this permission was granted (UTC)'`,

  // ── notification_preferences ──
  `ALTER TABLE default.notification_preferences COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN user_id 'User these preferences belong to (join to users.id)'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN notification_category_id 'Notification category this preference applies to'`,
  `ALTER TABLE default.notification_preferences COMMENT COLUMN enabled '1 if the user has opted in to this notification category, 0 if opted out'`,

  // ── refresh_tokens ──
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN id 'Unique token identifier'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN user_id 'User this token belongs to (join to users.id)'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN created_at 'When the token was issued (UTC)'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN last_used_at 'When the token was last exchanged for an access token (UTC). Proxy for session activity'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN is_impersonation '1 if this is a dashboard/admin impersonation session'`,
  `ALTER TABLE default.refresh_tokens COMMENT COLUMN expires_at 'When the token expires (UTC). NULL means non-expiring'`,

  // ── connected_accounts ──
  `ALTER TABLE default.connected_accounts COMMENT COLUMN project_id 'Project identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN branch_id 'Branch identifier. Auto-filtered by row-level security — do not use in WHERE clauses'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN user_id 'User this account is linked to (join to users.id)'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN provider 'OAuth/SSO provider name, e.g. google, github'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN provider_account_id 'User account ID at the external provider'`,
  `ALTER TABLE default.connected_accounts COMMENT COLUMN created_at 'When this account was linked (UTC)'`,

  ...OTEL_VIEW_COLUMN_COMMENT_STATEMENTS,
];

const SPANS_VIEW_COMMENT_PREFIX = "ALTER TABLE default.spans COMMENT COLUMN ";
COLUMN_COMMENT_STATEMENTS.push(...buildOtelViewColumnCommentStatements("spans", SPANS_COLUMNS, [
  "version",
  ...COLUMN_COMMENT_STATEMENTS
    .filter((statement) => statement.startsWith(SPANS_VIEW_COMMENT_PREFIX))
    .map((statement) => statement.slice(SPANS_VIEW_COMMENT_PREFIX.length).split(" ", 1)[0]),
]));

const COLUMN_COMMENT_TABLES = [
  "events",
  "spans",
  "users",
  "contact_channels",
  "teams",
  "team_member_profiles",
  "team_permissions",
  "team_invitations",
  "email_outboxes",
  "project_permissions",
  "notification_preferences",
  "refresh_tokens",
  "connected_accounts",
  "logs",
  "errors",
  "span_events",
  "span_links",
  "page_views",
  "trace_roots",
  "trace_services",
];

function buildColumnCommentSql(): string[] {
  const actionsByTable = new Map<string, string[]>();
  for (const table of COLUMN_COMMENT_TABLES) {
    actionsByTable.set(table, []);
  }

  for (const statement of COLUMN_COMMENT_STATEMENTS) {
    let matched = false;
    for (const table of COLUMN_COMMENT_TABLES) {
      const prefix = `ALTER TABLE default.${table} `;
      if (statement.startsWith(prefix)) {
        const actions = actionsByTable.get(table);
        if (actions == null) {
          throw new Error(`Missing column comment action group for analytics view: ${table}`);
        }
        actions.push(statement.slice(prefix.length));
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new Error(`Column comment statement does not target a known analytics view: ${statement}`);
    }
  }

  return COLUMN_COMMENT_TABLES.map((table) => {
    const actions = actionsByTable.get(table);
    if (actions == null || actions.length === 0) {
      throw new Error(`No column comments configured for analytics view: ${table}`);
    }
    return `ALTER TABLE default.${table}\n  ${actions.join(",\n  ")}`;
  });
}

const COLUMN_COMMENT_SQL = buildColumnCommentSql();

const EXTERNAL_ANALYTICS_DB_SQL = `
CREATE DATABASE IF NOT EXISTS analytics_internal;
`;

// Clickmap-only physical table (PostHog-style schema). Fed by clickmap_events_mv
// from analytics_internal.events WHERE event_type='$click'. Backwards compatible
// with click rows that pre-date elements_chain / scaled coords: the MV derives
// pointer_* from raw data.x / data.y / data.page_y, and elements_chain falls
// back to the empty string when the SDK didn't emit one.
//
// SCALE_FACTOR = 16 mirrors PostHog: pixel coords are divided at ingest so
// downstream queries operate on small integers and partitions stay compact.
//
// Order key (project_id, branch_id, date, path, viewport_width) matches the
// hot clickmap query: "all clicks on this path in this date range at these
// viewport widths".
//
// Dead-click classification lives on the click row itself: the SDK watches
// each click for up to ~3.75s for any observable effect and sets data.dead=1
// on the $click when there was none. One row per physical click, so count()
// stays the total and countIf(is_dead) is the dead subset; no second event
// type or table.
const CLICKMAP_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_internal.clickmap_events (
    project_id           String,
    branch_id            String,
    event_at             DateTime64(3, 'UTC'),
    user_id              Nullable(String),
    session_replay_id    Nullable(String),
    url                  String,
    path                 String,
    viewport_width       UInt16,
    viewport_height      UInt16,
    pointer_x            UInt16,
    pointer_y            UInt16,
    client_y             UInt16,
    pointer_relative_x   Float32,
    pointer_target_fixed UInt8,
    elements_chain       String,
    selector             String,
    elements_text        String,
    tag_name             LowCardinality(String),
    href                 Nullable(String),
    is_dead              UInt8 DEFAULT 0
)
ENGINE MergeTree
PARTITION BY toYYYYMM(event_at)
ORDER BY (project_id, branch_id, toDate(event_at), path, viewport_width)
TTL ${buildRetentionTtlSql(TELEMETRY_TTL_DAYS, "event_at")};
`;

const CLICKMAP_EVENTS_ADD_DEAD_COLUMN_SQL = `
ALTER TABLE analytics_internal.clickmap_events
ADD COLUMN IF NOT EXISTS is_dead UInt8 DEFAULT 0;
`;

// Materialized view that auto-populates clickmap_events on every $click insert.
// No POPULATE clause: existing rows stay in analytics_internal.events. New
// click rows flow into both tables.
//
// All field accesses use the toFloat64OrZero(toString(...)) pattern that the
// existing analytics queries use, so JSON-Variant nullability is handled the
// same way.
const CLICKMAP_EVENTS_MV_SELECT_SQL = `
SELECT
    project_id,
    branch_id,
    event_at,
    user_id,
    session_replay_id,
    toString(data.url) AS url,
    toString(data.path) AS path,
    toUInt16(least(65535, greatest(0, toUInt32(toFloat64OrZero(toString(data.viewport_width)))))) AS viewport_width,
    toUInt16(least(65535, greatest(0, toUInt32(toFloat64OrZero(toString(data.viewport_height)))))) AS viewport_height,
    toUInt16(least(65535, greatest(0, toUInt32(
        coalesce(toFloat64OrNull(toString(data.x_scaled)), toFloat64OrZero(toString(data.page_x)) / 16, toFloat64OrZero(toString(data.x)) / 16)
    )))) AS pointer_x,
    toUInt16(least(65535, greatest(0, toUInt32(
        coalesce(toFloat64OrNull(toString(data.y_scaled)), toFloat64OrZero(toString(data.page_y)) / 16, toFloat64OrZero(toString(data.y)) / 16)
    )))) AS pointer_y,
    toUInt16(least(65535, greatest(0, toUInt32(
        coalesce(toFloat64OrNull(toString(data.client_y_scaled)), toFloat64OrZero(toString(data.y)) / 16)
    )))) AS client_y,
    toFloat32(coalesce(
        toFloat64OrNull(toString(data.pointer_relative_x)),
        if(toFloat64OrZero(toString(data.viewport_width)) > 0,
           toFloat64OrZero(toString(data.x)) / toFloat64OrZero(toString(data.viewport_width)),
           0)
    )) AS pointer_relative_x,
    toUInt8(coalesce(toUInt8OrNull(toString(data.pointer_target_fixed)), 0)) AS pointer_target_fixed,
    toString(data.elements_chain) AS elements_chain,
    toString(data.selector) AS selector,
    toString(data.text) AS elements_text,
    toString(data.tag_name) AS tag_name,
    nullIf(toString(data.href), '') AS href,
    toUInt8(coalesce(toUInt8OrNull(toString(data.dead)), 0)) AS is_dead
FROM analytics_internal.events
WHERE event_type = '$click';
`;

const CLICKMAP_EVENTS_MV_SQL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_internal.clickmap_events_mv
TO analytics_internal.clickmap_events
AS
${CLICKMAP_EVENTS_MV_SELECT_SQL}
`;

const CLICKMAP_EVENTS_MV_UPGRADE_SQL = `
ALTER TABLE analytics_internal.clickmap_events_mv
MODIFY QUERY
${CLICKMAP_EVENTS_MV_SELECT_SQL}
`;
