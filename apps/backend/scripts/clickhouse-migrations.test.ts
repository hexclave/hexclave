import { getClickhouseAdminClient, type ClickHouseClient } from "@/lib/clickhouse";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ERRORS_VIEW_SQL,
  ERROR_GROUPING_COLUMNS,
  ERROR_GROUPING_COLUMN_NAMES,
  ERROR_ENVELOPE_COLUMN_NAMES,
  EVENTS_COLUMNS,
  EVENTS_EVENT_TYPE_INDEX_DEFINITION_SQL,
  EVENTS_EVENT_TYPE_INDEX_NAME,
  LOGS_COLUMNS,
  OTEL_LOG_COLUMNS,
  LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL,
  LOGS_ISSUE_HASH_INDEX_NAME,
  LOGS_VIEW_SQL,
  PAGE_VIEWS_COLUMNS,
  PAGE_VIEWS_SOURCE_SELECT_SQL,
  PAGE_VIEWS_VIEW_SQL,
  REFRESH_TOKEN_SPAN_SELECT_ALIASES,
  REFRESH_TOKEN_SPAN_SELECT_SQL,
  SPANS_COLUMNS,
  SPANS_GEN_AI_OPERATION_INDEX_DEFINITION_SQL,
  SPANS_GEN_AI_OPERATION_INDEX_NAME,
  OTEL_METRICS_COLUMNS,
  SPANS_VIEW_SQL,
  SPAN_EVENTS_VIEW_SQL,
  SPAN_LINKS_COLUMNS,
  SPAN_EVENTS_COLUMNS,
  SPAN_WRITES_TTL_DAYS,
  TELEMETRY_COLUMNS,
  TELEMETRY_INSERT_DEDUPLICATION_WINDOW,
  TELEMETRY_INSERT_TABLES,
  TELEMETRY_TTL_DAYS,
  TRACE_ROOTS_COLUMNS,
  TRACE_ROOTS_SOURCE_SELECT_SQL,
  TRACE_ROOTS_VIEW_SQL,
  TRACE_SERVICES_COLUMNS,
  TRACE_SERVICES_SOURCE_SELECT_SQL,
  buildColumnUpgradeSql,
  computeSpansSubsystemFingerprint,
  buildIssueOccurrenceRollupCreateTableSql,
  buildIssueOccurrenceRollupMvSql,
  buildPageViewsCreateTableSql,
  buildPageViewsMvSql,
  buildSpanEventsCreateTableSql,
  buildSpanLinksCreateTableSql,
  buildSpanWritesCreateTableSql,
  buildSpanWritesMvSql,
  buildSpansCreateTableSql,
  buildTelemetryCreateTableSql,
  buildOtelMetricsCreateTableSql,
  buildTelemetryInsertDeduplicationSettingSql,
  buildTraceRootsCreateTableSql,
  buildTraceServicesCreateTableSql,
  backfillDerivedSpanTable,
  decideFingerprintGuard,
  ensureSkipIndex,
  ensureTableTtl,
  selectColumnNames,
  type ClickhouseColumn,
} from "./clickhouse-migrations";


function names(columns: readonly ClickhouseColumn[]): string[] {
  return columns.map((column) => column.name);
}

describe("default.spans", () => {
  test("exposes physical spans plus the canonical W3C refresh-token root", () => {
    expect(SPANS_VIEW_SQL).toContain("FROM analytics_internal.spans FINAL");
    expect(SPANS_VIEW_SQL).toContain("UNION ALL");
    expect(SPANS_VIEW_SQL).toContain(REFRESH_TOKEN_SPAN_SELECT_SQL);
    expect(REFRESH_TOKEN_SPAN_SELECT_ALIASES).toEqual(names(SPANS_COLUMNS).filter((name) => name !== "version"));
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("'$refresh-token'");
    // ClickHouse resolves aliases across the whole SELECT. Qualifying both
    // timestamps prevents the later `sync_created_at AS created_at` alias from
    // rewriting the token's true interval start to its latest sync time.
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("rt.created_at AS started_at");
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("rt.sync_created_at AS created_at");
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("FROM analytics_internal.refresh_tokens AS rt FINAL");
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("AS parent_span_id");
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("AS page_view_span_id");
  });
});

describe("spans subsystem fingerprint", () => {
  test("is a stable digest of the physical spans-subsystem definitions", () => {
    const current = computeSpansSubsystemFingerprint();
    expect(current).toMatch(/^[0-9a-f]{32}$/);
    expect(current).toBe(computeSpansSubsystemFingerprint());
  });
});

describe("fingerprint guard decision", () => {
  const expectedObjects = [
    {
      name: "spans",
      columns: [
        { name: "project_id", type: "String" },
        { name: "created_at", type: "DateTime64(3, 'UTC')" },
      ],
    },
    {
      name: "span_writes_mv",
      asSelect: `
        SELECT project_id, created_at
        FROM analytics_internal.spans
        WHERE producer = 'sdk' AND billing_item = 'analytics_spans'
      `,
    },
  ];
  const liveSpans = {
    name: "spans",
    columns: [
      { name: "project_id", type: "String" },
      { name: "created_at", type: "DateTime64(3,'UTC')" },
    ],
  };
  const liveSpanWritesMv = {
    name: "span_writes_mv",
    asSelect: `
      SELECT project_id, created_at FROM analytics_internal.spans
      WHERE (producer = 'sdk') AND (billing_item = 'analytics_spans')
    `,
  };
  const matchingLiveObjects = [liveSpans, liveSpanWritesMv];

  test("returns current when the stored fingerprint matches", () => {
    expect(decideFingerprintGuard({
      stored: "expected",
      expected: "expected",
      liveObjects: [],
      expectedObjects,
    })).toEqual({ kind: "current" });
  });

  test("returns fresh when no marker or owned objects exist", () => {
    expect(decideFingerprintGuard({
      stored: undefined,
      expected: "expected",
      liveObjects: [],
      expectedObjects,
    })).toEqual({ kind: "fresh" });
  });

  test("resumes when live tables and materialized views match", () => {
    expect(decideFingerprintGuard({
      stored: undefined,
      expected: "expected",
      liveObjects: matchingLiveObjects,
      expectedObjects,
    })).toEqual({ kind: "resume" });
  });

  test("resumes when live tables contain extra columns", () => {
    expect(decideFingerprintGuard({
      stored: undefined,
      expected: "expected",
      liveObjects: [
        {
          ...liveSpans,
          columns: [
            ...liveSpans.columns,
            { name: "future_column", type: "UInt64" },
          ],
        },
        liveSpanWritesMv,
      ],
      expectedObjects,
    })).toEqual({ kind: "resume" });
  });

  test("rejects a live table missing an expected column", () => {
    expect(decideFingerprintGuard({
      stored: undefined,
      expected: "expected",
      liveObjects: [{
        name: "spans",
        columns: [{ name: "project_id", type: "String" }],
      }],
      expectedObjects,
    })).toMatchObject({ kind: "mismatch", stored: "absent", expected: "expected" });
  });

  test("rejects a live table with a changed column type", () => {
    expect(decideFingerprintGuard({
      stored: undefined,
      expected: "expected",
      liveObjects: [{
        name: "spans",
        columns: [
          { name: "project_id", type: "String" },
          { name: "created_at", type: "DateTime64(6, 'UTC')" },
        ],
      }],
      expectedObjects,
    })).toMatchObject({ kind: "mismatch", stored: "absent", expected: "expected" });
  });

  test("rejects a materialized view missing an expected predicate", () => {
    expect(decideFingerprintGuard({
      stored: undefined,
      expected: "expected",
      liveObjects: [{
        name: "span_writes_mv",
        asSelect: "SELECT project_id, created_at FROM analytics_internal.spans WHERE producer = 'sdk'",
      }],
      expectedObjects,
    })).toMatchObject({ kind: "mismatch", stored: "absent", expected: "expected" });
  });

  test("rejects a different stored fingerprint even when live objects match", () => {
    expect(decideFingerprintGuard({
      stored: "old",
      expected: "expected",
      liveObjects: matchingLiveObjects,
      expectedObjects,
    })).toMatchObject({ kind: "mismatch", stored: "old", expected: "expected" });
  });
});

describe("derived read models", () => {
  test("the page-view read model is time-ordered without weakening span identity", () => {
    expect(buildPageViewsCreateTableSql("analytics_internal.page_views")).toContain(
      "ORDER BY (project_id, branch_id, started_at, span_id, trace_id)",
    );
    expect(PAGE_VIEWS_SOURCE_SELECT_SQL).toContain("WHERE span_type = '$page-view'");
    expect(PAGE_VIEWS_VIEW_SQL).toContain("FROM analytics_internal.page_views FINAL");
    expect(PAGE_VIEWS_VIEW_SQL).toContain("FROM analytics_internal.events");
    expect(PAGE_VIEWS_VIEW_SQL).toContain("toString(data) AS data");
    expect(PAGE_VIEWS_VIEW_SQL).not.toContain("default.spans");
  });

  test("page_views reuses the selected spans column types verbatim", () => {
    const spansByName = new Map<string, ClickhouseColumn>(SPANS_COLUMNS.map((column) => [column.name, column]));
    for (const column of PAGE_VIEWS_COLUMNS) {
      expect(column).toEqual(spansByName.get(column.name));
    }
  });

  test("the trace inbox is fed by the scalar-parent root test", () => {
    expect(TRACE_ROOTS_SOURCE_SELECT_SQL).toContain("WHERE parent_span_id IS NULL");
  });

  test("the trace inbox remains a neutral parentless-span projection", () => {
    expect(TRACE_ROOTS_SOURCE_SELECT_SQL).toContain("WHERE parent_span_id IS NULL");
    for (const sql of [TRACE_ROOTS_SOURCE_SELECT_SQL, TRACE_ROOTS_VIEW_SQL]) {
      expect(sql).not.toContain("coalesce(scope_name");
      expect(sql).not.toContain("JSONExtractString(data, 'http.target')");
      expect(sql).not.toContain("_next/static");
      expect(sql).not.toContain("span_type = 'OPTIONS'");
    }
  });

  test("the trace inbox unions the virtual session root with physical unparented operations", () => {
    expect(TRACE_ROOTS_VIEW_SQL).toContain("FROM analytics_internal.trace_roots FINAL");
    expect(TRACE_ROOTS_VIEW_SQL).toContain("UNION ALL");
    expect(TRACE_ROOTS_VIEW_SQL).toContain(REFRESH_TOKEN_SPAN_SELECT_SQL);
  });

  test("span usage follows the server-derived billing classification", () => {
    const sql = buildSpanWritesMvSql("analytics_internal");
    expect(sql).toContain("billing_item = 'analytics_spans'");
    expect(sql).not.toContain("scope_name IS NULL");
    expect(sql).not.toContain("startsWith(span_type");
  });

  test("trace_roots carries the page-view correlation the inbox groups by", () => {
    expect(names(TRACE_ROOTS_COLUMNS)).toContain("page_view_span_id");
  });

  test("trace_roots reuses the spans column types verbatim", () => {
    const spansByName = new Map<string, ClickhouseColumn>(SPANS_COLUMNS.map((column) => [column.name, column]));
    for (const column of TRACE_ROOTS_COLUMNS) {
      expect(column).toEqual(spansByName.get(column.name));
    }
  });

  test("selectColumnNames rejects an exclusion that does not exist", () => {
    expect(() => selectColumnNames(SPANS_COLUMNS, ["nonexistent"])).toThrow(/nonexistent/);
  });

  test("the trace_services source SELECT produces the declared columns in order", () => {
    const selectBody = TRACE_SERVICES_SOURCE_SELECT_SQL
      .slice(TRACE_SERVICES_SOURCE_SELECT_SQL.indexOf("SELECT") + "SELECT".length, TRACE_SERVICES_SOURCE_SELECT_SQL.indexOf("FROM analytics_internal.spans"))
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line.length > 0)
      .map((line) => line.split(/ AS /).at(-1) ?? line);
    expect(selectBody).toEqual(names(TRACE_SERVICES_COLUMNS));
  });
});

describe("error grouping columns on analytics_internal.events", () => {
  test("logs carries the full event shape plus grouping and canonical OTel columns", () => {
    expect(names(LOGS_COLUMNS)).toEqual([...names(EVENTS_COLUMNS), ...ERROR_GROUPING_COLUMN_NAMES, ...ERROR_ENVELOPE_COLUMN_NAMES, ...names(OTEL_LOG_COLUMNS)]);
    expect(names(LOGS_COLUMNS)).toContain("message");
    expect(names(EVENTS_COLUMNS).at(-1)).toBe("created_at");

    for (const columns of [EVENTS_COLUMNS, SPAN_EVENTS_COLUMNS]) {
      for (const name of ERROR_GROUPING_COLUMN_NAMES) {
        expect(names(columns)).not.toContain(name);
      }
    }
  });

  test("every grouping column has a DB-side default", () => {
    for (const column of ERROR_GROUPING_COLUMNS) {
      expect(column.default, `grouping column ${column.name} must be defaulted`).not.toBeUndefined();
    }
  });

  test("error_frames is its own String column rather than a path inside data", () => {
    const frames = ERROR_GROUPING_COLUMNS.find((column) => column.name === "error_frames");
    expect(frames?.type).toBe("String");
    expect(EVENTS_COLUMNS.find((column) => column.name === "data")?.type).toBe("JSON");
  });

  test("default.errors exposes the grouping columns and default.logs hides exactly them", () => {
    for (const name of ERROR_GROUPING_COLUMN_NAMES) {
      expect(ERRORS_VIEW_SQL).toContain(`\n  ${name}`);
      expect(LOGS_VIEW_SQL).not.toContain(`\n  ${name}`);
    }
    expect(ERRORS_VIEW_SQL).toContain("WHERE event_type = '$error'");
    expect(LOGS_VIEW_SQL).toContain("WHERE event_type = '$log'");
    expect(ERRORS_VIEW_SQL).toContain("FROM analytics_internal.events");
    expect(LOGS_VIEW_SQL).toContain("FROM analytics_internal.events");
    expect(selectColumnNames(LOGS_COLUMNS, ERROR_GROUPING_COLUMN_NAMES)).toEqual([
      ...names(EVENTS_COLUMNS),
      ...ERROR_ENVELOPE_COLUMN_NAMES,
      ...names(OTEL_LOG_COLUMNS),
    ]);
  });

  test("the skip index covers the scalar owning hash, not the diagnostic alias array", () => {
    expect(LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL).toBe("issue_hash TYPE bloom_filter(0.01) GRANULARITY 4");
    expect(LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL).not.toContain("issue_hashes");
    expect(buildTelemetryCreateTableSql("t")).toContain(`INDEX ${LOGS_ISSUE_HASH_INDEX_NAME} ${LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL}`);
  });
});

describe("canonical telemetry table", () => {
  test("contains the compatible product, error, and OTel column superset", () => {
    expect(names(TELEMETRY_COLUMNS)).toEqual([
      ...names(EVENTS_COLUMNS),
      ...ERROR_GROUPING_COLUMN_NAMES,
      ...ERROR_ENVELOPE_COLUMN_NAMES,
      ...names(OTEL_LOG_COLUMNS),
    ]);
  });
});

describe("issue occurrence rollup", () => {
  const tableSql = buildIssueOccurrenceRollupCreateTableSql("analytics_internal");
  const mvSql = buildIssueOccurrenceRollupMvSql("analytics_internal");

  test("expiry is keyed on bucket_start, and there is no created_at to key it on instead", () => {
    expect(tableSql).toContain(`TTL toDateTime(bucket_start) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE`);
    expect(tableSql).not.toContain("created_at");
    expect(tableSql).toContain("ENGINE = AggregatingMergeTree");
    expect(tableSql).toContain("PARTITION BY toYYYYMM(bucket_start)");
  });

  test("service and environment precede issue_hash in the sorting key", () => {
    expect(tableSql).toContain("ORDER BY (project_id, branch_id, service_name, deployment_environment_name, issue_hash, bucket_start)");
  });

  test("unique users are kept as a mergeable state over Nullable(String)", () => {
    expect(tableSql).toContain("users_state AggregateFunction(uniq, Nullable(String))");
    expect(mvSql).toContain("uniqState(user_id) AS users_state");
    expect(mvSql).not.toContain("coalesce(user_id");
  });

  test("the materialized view coalesces the nullable service columns", () => {
    for (const column of ["service_name", "deployment_environment_name"] as const) {
      expect(EVENTS_COLUMNS.find((c) => c.name === column)?.type).toBe("LowCardinality(Nullable(String))");
      expect(tableSql).toContain(`${column} LowCardinality(String)`);
      expect(mvSql).toContain(`coalesce(${column}, '') AS ${column}`);
    }
  });

  test("the materialized view reads only grouped $error rows from logs", () => {
    expect(mvSql).toContain("FROM analytics_internal.events");
    expect(mvSql).toContain("WHERE event_type = '$error' AND issue_hash != ''");
    expect(mvSql).toContain("toStartOfHour(event_at) AS bucket_start");
    expect(mvSql).toContain("GROUP BY project_id, branch_id, issue_hash, bucket_start, service_name, deployment_environment_name");
  });

  test("the materialized view's output order matches the target table's column order", () => {
    const selectBody = mvSql
      .slice(mvSql.indexOf("SELECT") + "SELECT".length, mvSql.indexOf("FROM analytics_internal.events"))
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line.length > 0)
      .map((line) => line.split(/ AS /).at(-1) ?? line);
    expect(selectBody).toEqual([
      "project_id", "branch_id", "issue_hash", "bucket_start",
      "service_name", "deployment_environment_name",
      "occurrences", "users_state", "first_seen", "last_seen",
    ]);
  });
});

describe("telemetry table physical layout", () => {
  test("spans are partitioned by started_at, not ingestion time", () => {
    const sql = buildSpansCreateTableSql("analytics_internal.spans");
    expect(sql).toContain("PARTITION BY toYYYYMM(started_at)");
    expect(sql).toContain("ENGINE ReplacingMergeTree(version)");
    expect(sql).toContain(`SETTINGS non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`);
  });

  test("spans carry the canonical gen_ai projection with a skip index for AI filters", () => {
    const sql = buildSpansCreateTableSql("analytics_internal.spans");
    expect(sql).toContain("gen_ai_operation_name LowCardinality(Nullable(String))");
    expect(sql).toContain("gen_ai_provider_name LowCardinality(Nullable(String))");
    expect(sql).toContain("gen_ai_input_tokens Nullable(UInt64)");
    expect(sql).toContain("gen_ai_cache_read_input_tokens Nullable(UInt64)");
    expect(sql).toContain(`INDEX ${SPANS_GEN_AI_OPERATION_INDEX_NAME} ${SPANS_GEN_AI_OPERATION_INDEX_DEFINITION_SQL}`);
    // Customer-facing: the public view and its positional refresh-token branch
    // both expose the projection.
    expect(SPANS_VIEW_SQL).toContain("gen_ai_operation_name");
    expect(REFRESH_TOKEN_SPAN_SELECT_SQL).toContain("AS gen_ai_conversation_id");
    // The derived read models stay AI-free on purpose: trace_roots is the
    // trace inbox and page_views the product path — AI listings query
    // default.spans directly via the skip index.
    expect(names(TRACE_ROOTS_COLUMNS)).not.toContain("gen_ai_operation_name");
    expect(names(PAGE_VIEWS_COLUMNS)).not.toContain("gen_ai_operation_name");
  });

  test("every physical batch destination enables non-replicated insert deduplication", () => {
    expect(TELEMETRY_INSERT_TABLES.map(buildTelemetryInsertDeduplicationSettingSql)).toEqual([
      `ALTER TABLE analytics_internal.events MODIFY SETTING non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`,
      `ALTER TABLE analytics_internal.spans MODIFY SETTING non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`,
      `ALTER TABLE analytics_internal.span_events MODIFY SETTING non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`,
      `ALTER TABLE analytics_internal.span_links MODIFY SETTING non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`,
      `ALTER TABLE analytics_internal.metrics MODIFY SETTING non_replicated_deduplication_window = ${TELEMETRY_INSERT_DEDUPLICATION_WINDOW}`,
    ]);
  });

  test("event-shaped ingest does not create a second physical table", () => {
    expect(TELEMETRY_INSERT_TABLES).not.toContain("telemetry");
    expect(LOGS_VIEW_SQL).not.toContain("analytics_internal.telemetry");
    expect(ERRORS_VIEW_SQL).not.toContain("analytics_internal.telemetry");
    expect(buildTelemetryCreateTableSql("analytics_internal.events")).toContain("CREATE TABLE IF NOT EXISTS analytics_internal.events");
  });

  test("native OTLP metrics preserve point identity across retries", () => {
    const sql = buildOtelMetricsCreateTableSql("analytics_internal.metrics");
    expect(names(OTEL_METRICS_COLUMNS)).toContain("metric_name");
    expect(names(OTEL_METRICS_COLUMNS)).toContain("data_point");
    expect(names(OTEL_METRICS_COLUMNS)).toContain("exemplar_trace_id");
    expect(sql).toContain("ENGINE ReplacingMergeTree(created_at)");
    expect(sql).toContain("ORDER BY (project_id, branch_id, point_id)");
    expect(sql).toContain("PARTITION BY toYYYYMM(toDateTime(time_unix_nano / 1000000000))");
    expect(sql).toContain(`TTL toDateTime(created_at) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE`);
  });

  test("span_links dedupe retried exports via ReplacingMergeTree over the full identity key", () => {
    const sql = buildSpanLinksCreateTableSql("analytics_internal.span_links");
    expect(sql).toContain("ENGINE ReplacingMergeTree(created_at)");
    expect(sql).toContain("ORDER BY (project_id, branch_id, trace_id, owner_span_id, linked_project_id, linked_branch_id, linked_trace_id, linked_span_id)");
    expect(sql).toContain("linked_project_id String DEFAULT project_id");
    expect(sql).toContain("linked_branch_id String DEFAULT branch_id");
  });

  test("span_events converge retried OTLP exports on their canonical event identity", () => {
    const sql = buildSpanEventsCreateTableSql("analytics_internal.span_events");
    expect(sql).toContain("ENGINE ReplacingMergeTree");
    expect(sql).toContain("ifNull(trace_id, ''), ifNull(span_id, ''), event_ordinal, event_at, event_type");
    expect(SPAN_EVENTS_VIEW_SQL).toContain("FROM analytics_internal.span_events FINAL");
  });

  test("telemetry tables declare the retention TTL in their CREATE statements", () => {
    expect(buildSpansCreateTableSql("t")).toContain(`TTL toDateTime(created_at) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE`);
    expect(buildSpanLinksCreateTableSql("t")).toContain(`TTL toDateTime(created_at) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE`);
    expect(buildTraceRootsCreateTableSql("t")).toContain(`TTL toDateTime(created_at) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE`);
    expect(buildTraceServicesCreateTableSql("t")).toContain(`TTL toDateTime(created_at) + INTERVAL ${TELEMETRY_TTL_DAYS} DAY DELETE`);
  });

  test("the billing ledger outlives telemetry retention", () => {
    expect(SPAN_WRITES_TTL_DAYS).toBeGreaterThan(TELEMETRY_TTL_DAYS);
  });

  test("the billing view trusts only the authenticated ingestion classification", () => {
    expect(buildSpanWritesMvSql("analytics_internal")).toContain("WHERE producer = 'sdk' AND billing_item = 'analytics_spans'");
  });
});

describe("clickhouse upgrade helpers (integration)", () => {
  const testDatabase = `analytics_migrations_test_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = getClickhouseAdminClient();
    await client.command({ query: `CREATE DATABASE ${testDatabase}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${testDatabase}` });
    await client.close();
  });

  async function getTableLayout(table: string): Promise<{ engine: string, partition_key: string, engine_full: string }> {
    const resultSet = await client.query({
      query: "SELECT engine, partition_key, engine_full FROM system.tables WHERE database = {database:String} AND name = {table:String}",
      query_params: { database: testDatabase, table },
      format: "JSONEachRow",
    });
    const rows = await resultSet.json<{ engine: string, partition_key: string, engine_full: string }>();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function countRows(table: string, options: { final?: boolean } = {}): Promise<number> {
    const resultSet = await client.query({
      query: `SELECT count() AS count FROM ${testDatabase}.${table}${options.final ? " FINAL" : ""}`,
      format: "JSONEachRow",
    });
    const rows = await resultSet.json<{ count: string }>();
    return Number(rows[0].count);
  }

  async function countMutations(table: string): Promise<number> {
    const resultSet = await client.query({
      query: "SELECT count() AS count FROM system.mutations WHERE database = {database:String} AND table = {table:String}",
      query_params: { database: testDatabase, table },
      format: "JSONEachRow",
    });
    const rows = await resultSet.json<{ count: string }>();
    return Number(rows[0].count);
  }

  async function countActivePartitions(table: string): Promise<number> {
    const resultSet = await client.query({
      query: "SELECT countDistinct(partition) AS count FROM system.parts WHERE database = {database:String} AND table = {table:String} AND active",
      query_params: { database: testDatabase, table },
      format: "JSONEachRow",
    });
    const rows = await resultSet.json<{ count: string }>();
    return Number(rows[0].count);
  }

  const toClickhouseDateTime = (date: Date) => date.toISOString().replace("T", " ").replace("Z", "");

  async function withThrowawayDatabase<T>(callback: (database: string) => Promise<T>): Promise<T> {
    const database = `clickhouse_migrations_test_${randomUUID().replaceAll("-", "")}`;
    await client.command({ query: `CREATE DATABASE ${database}` });
    try {
      return await callback(database);
    } finally {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    }
  }

  async function countRowsIn(database: string, table: string): Promise<number> {
    const resultSet = await client.query({
      query: `SELECT count() AS count FROM ${database}.${table}`,
      format: "JSONEachRow",
    });
    const rows = await resultSet.json<{ count: string }>();
    return Number(rows[0].count);
  }

  test("the span_writes billing view meters only classified SDK spans", async () => {
    await client.command({ query: buildSpansCreateTableSql(`${testDatabase}.spans`) });
    await client.command({ query: buildSpanWritesCreateTableSql(testDatabase) });
    await client.command({ query: buildSpanWritesMvSql(testDatabase) });

    const startedAt = toClickhouseDateTime(new Date());
    await client.command({
      query: `
        INSERT INTO ${testDatabase}.spans (trace_id, span_id, span_type, billing_item, producer, started_at, project_id, branch_id, version) VALUES
        ('trace-b1', 'span-b1', 'checkout-flow', 'analytics_spans', 'sdk', '${startedAt}', 'billed-project', 'b', 1),
        ('trace-b2', 'span-b2', '$page-view', NULL, 'sdk', '${startedAt}', 'billed-project', 'b', 1),
        ('trace-b3', 'span-b3', 'handler', NULL, 'hexclave-backend', '${startedAt}', 'billed-project', 'b', 1),
        ('trace-b4', 'span-b4', 'spoofed', 'analytics_spans', 'hexclave-backend', '${startedAt}', 'billed-project', 'b', 1)
      `,
    });

    const resultSet = await client.query({
      query: `SELECT project_id FROM ${testDatabase}.span_writes`,
      format: "JSONEachRow",
    });
    const ledgerRows = await resultSet.json<{ project_id: string }>();
    expect(ledgerRows).toEqual([{ project_id: "billed-project" }]);
  });

  test("the page_views materialized view keeps only the latest page-view span version", async () => {
    await withThrowawayDatabase(async (database) => {
      await client.command({ query: buildSpansCreateTableSql(`${database}.spans`) });
      await client.command({ query: buildPageViewsCreateTableSql(`${database}.page_views`) });
      await client.command({ query: buildPageViewsMvSql(database) });

      await client.command({
        query: `
          INSERT INTO ${database}.spans
            (trace_id, span_id, span_type, started_at, data, project_id, branch_id, version)
          VALUES
            ('trace-page', 'span-page', '$page-view', '2026-08-01 00:00:00.000', '{"path":"/old"}', 'project', 'main', 1),
            ('trace-page', 'span-page', '$page-view', '2026-08-01 00:00:00.000', '{"path":"/new"}', 'project', 'main', 2),
            ('trace-noise', 'span-noise', 'GET /noise', '2026-08-01 00:00:00.000', '{}', 'project', 'main', 1)
        `,
      });

      const resultSet = await client.query({
        query: `SELECT trace_id, span_id, data FROM ${database}.page_views FINAL`,
        format: "JSONEachRow",
      });
      expect(await resultSet.json<{ trace_id: string, span_id: string, data: string }>()).toEqual([{
        trace_id: "trace-page",
        span_id: "span-page",
        data: '{"path":"/new"}',
      }]);
    });
  });

  test("the physical spans table stores canonical uint64-string token counts losslessly", async () => {
    await withThrowawayDatabase(async (database) => {
      await client.command({ query: buildSpansCreateTableSql(`${database}.spans`) });
      // Token counts arrive from the ingest path as canonical uint64 strings
      // (the OTLP int64 wire form); JSONEachRow must coerce them into the
      // Nullable(UInt64) columns the same way version already relies on.
      await client.insert({
        table: `${database}.spans`,
        values: [{
          trace_id: "11111111111111111111111111111111",
          span_id: "2222222222222222",
          span_type: "chat gpt-4.1",
          started_at: new Date("2026-08-01T00:00:00.000Z"),
          project_id: "p",
          branch_id: "b",
          gen_ai_operation_name: "chat",
          gen_ai_provider_name: "openai",
          gen_ai_request_model: "gpt-4.1",
          gen_ai_input_tokens: "18446744073709551615",
          gen_ai_output_tokens: "92",
          version: 1,
        }],
        format: "JSONEachRow",
        clickhouse_settings: { date_time_input_format: "best_effort" },
      });

      const resultSet = await client.query({
        query: `
          SELECT gen_ai_operation_name, gen_ai_provider_name, gen_ai_request_model,
                 toString(gen_ai_input_tokens) AS gen_ai_input_tokens,
                 toString(gen_ai_output_tokens) AS gen_ai_output_tokens,
                 gen_ai_tool_name
          FROM ${database}.spans
        `,
        format: "JSONEachRow",
      });
      expect(await resultSet.json()).toEqual([{
        gen_ai_operation_name: "chat",
        gen_ai_provider_name: "openai",
        gen_ai_request_model: "gpt-4.1",
        gen_ai_input_tokens: "18446744073709551615",
        gen_ai_output_tokens: "92",
        gen_ai_tool_name: null,
      }]);
    });
  });

  test("ensureTableTtl applies the retention TTL exactly once, and re-applies on a changed retention", async () => {
    const table = "ttl_probe";
    await client.command({
      query: `CREATE TABLE ${testDatabase}.${table} (id String, created_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE MergeTree ORDER BY id`,
    });

    await ensureTableTtl(client, { database: testDatabase, table, ttlDays: TELEMETRY_TTL_DAYS });
    // ClickHouse normalizes `INTERVAL n DAY` to `toIntervalDay(n)` in metadata;
    // ensureTableTtl's idempotency probe relies on exactly this form.
    expect((await getTableLayout(table)).engine_full).toContain(`toDateTime(created_at) + toIntervalDay(${TELEMETRY_TTL_DAYS})`);

    const mutationsAfterFirstRun = await countMutations(table);
    await ensureTableTtl(client, { database: testDatabase, table, ttlDays: TELEMETRY_TTL_DAYS });
    expect(await countMutations(table)).toBe(mutationsAfterFirstRun);

    await ensureTableTtl(client, { database: testDatabase, table, ttlDays: SPAN_WRITES_TTL_DAYS });
    expect((await getTableLayout(table)).engine_full).toContain(`toDateTime(created_at) + toIntervalDay(${SPAN_WRITES_TTL_DAYS})`);
  });

  test("ensureTableTtl recognizes the TTL declared by the derived read models' CREATE statements", async () => {
    // Fresh databases create trace_roots/trace_services with the TTL clause
    // already in place; ensureTableTtl must see it as current (ClickHouse
    // normalizes `INTERVAL n DAY` to `toIntervalDay(n)` in metadata) and not
    // schedule a MODIFY TTL mutation on every boot.
    for (const [table, buildCreateSql, timestampColumn] of [
      ["page_views", buildPageViewsCreateTableSql, "started_at"],
      ["trace_roots", buildTraceRootsCreateTableSql, "created_at"],
      ["trace_services", buildTraceServicesCreateTableSql, "created_at"],
    ] as const) {
      await client.command({ query: buildCreateSql(`${testDatabase}.${table}`) });
      await ensureTableTtl(client, { database: testDatabase, table, ttlDays: TELEMETRY_TTL_DAYS, timestampColumn });
      expect((await getTableLayout(table)).engine_full).toContain(`toDateTime(${timestampColumn}) + toIntervalDay(${TELEMETRY_TTL_DAYS})`);
      expect(await countMutations(table)).toBe(0);
    }
  });

  test("a pre-TTL trace_services table gains created_at and the TTL without losing rows", async () => {
    const table = "trace_services_upgrade_probe";
    await client.command({
      query: `
        CREATE TABLE ${testDatabase}.${table} (
            project_id String,
            branch_id String,
            trace_id String,
            service_namespace String,
            service_name String,
            version UInt64
        )
        ENGINE ReplacingMergeTree(version)
        ORDER BY (project_id, branch_id, service_namespace, service_name, trace_id)
      `,
    });
    await client.command({
      query: `INSERT INTO ${testDatabase}.${table} (project_id, branch_id, trace_id, service_namespace, service_name, version) VALUES ('p', 'b', 'trace-1', '', 'checkout-api', 1)`,
    });

    await client.command({ query: buildColumnUpgradeSql(`${testDatabase}.${table}`, TRACE_SERVICES_COLUMNS) });
    await ensureTableTtl(client, { database: testDatabase, table, ttlDays: TELEMETRY_TTL_DAYS });

    expect((await getTableLayout(table)).engine_full).toContain(`toDateTime(created_at) + toIntervalDay(${TELEMETRY_TTL_DAYS})`);
    expect(await countRows(table)).toBe(1);
    const resultSet = await client.query({
      query: `SELECT created_at FROM ${testDatabase}.${table}`,
      format: "JSONEachRow",
    });
    const rows = await resultSet.json<{ created_at: string }>();
    const createdAt = new Date(`${rows[0].created_at.replace(" ", "T")}Z`);
    expect(Math.abs(createdAt.getTime() - Date.now())).toBeLessThan(5 * 60 * 1000);
  });

  test("ensureSkipIndex refuses unbounded historical materialization before changing metadata", async () => {
    const table = "skip_index_probe";
    await client.command({
      query: `CREATE TABLE ${testDatabase}.${table} (project_id String, event_type LowCardinality(String)) ENGINE MergeTree ORDER BY project_id`,
    });
    await client.command({
      query: `INSERT INTO ${testDatabase}.${table} (project_id, event_type) VALUES ('p', '$log')`,
    });

    const options = { database: testDatabase, table, indexName: EVENTS_EVENT_TYPE_INDEX_NAME, indexDefinitionSql: EVENTS_EVENT_TYPE_INDEX_DEFINITION_SQL, materializeHistoricalParts: true };
    await expect(ensureSkipIndex(client, options)).rejects.toThrow(/materialize closed partitions separately/);

    const resultSet = await client.query({
      query: "SELECT count() AS count FROM system.data_skipping_indices WHERE database = {database:String} AND table = {table:String} AND name = {indexName:String}",
      query_params: { database: testDatabase, table, indexName: EVENTS_EVENT_TYPE_INDEX_NAME },
      format: "JSONEachRow",
    });
    expect(Number((await resultSet.json<{ count: number | string }>())[0].count)).toBe(0);
    expect(await countMutations(table)).toBe(0);
  });

  test("ensureSkipIndex can skip historical materialization for a freshly-defaulted column", async () => {
    const table = "skip_index_no_materialize_probe";
    await client.command({
      query: `CREATE TABLE ${testDatabase}.${table} (project_id String, issue_hash String DEFAULT '') ENGINE MergeTree ORDER BY project_id`,
    });
    await client.command({
      query: `INSERT INTO ${testDatabase}.${table} (project_id) VALUES ('p')`,
    });

    await ensureSkipIndex(client, {
      database: testDatabase,
      table,
      indexName: LOGS_ISSUE_HASH_INDEX_NAME,
      indexDefinitionSql: LOGS_ISSUE_HASH_INDEX_DEFINITION_SQL,
      materializeHistoricalParts: false,
    });

    const indexSet = await client.query({
      query: "SELECT name FROM system.data_skipping_indices WHERE database = {database:String} AND table = {table:String}",
      query_params: { database: testDatabase, table },
      format: "JSONEachRow",
    });
    expect(await indexSet.json<{ name: string }>()).toEqual([{ name: LOGS_ISSUE_HASH_INDEX_NAME }]);
    expect(await countMutations(table)).toBe(0);
  });

  test("derived span backfills checkpoint physical partitions and never use target emptiness", async () => {
    await withThrowawayDatabase(async (database) => {
      await client.command({
        query: `
          CREATE TABLE ${database}.spans (
            trace_id String,
            started_at DateTime64(3, 'UTC'),
            created_at DateTime64(3, 'UTC'),
            version UInt64
          )
          ENGINE ReplacingMergeTree(version)
          PARTITION BY toYYYYMM(started_at)
          ORDER BY trace_id
        `,
      });
      await client.command({
        query: `
          CREATE TABLE ${database}.derived_probe (
            trace_id String,
            started_at DateTime64(3, 'UTC'),
            created_at DateTime64(3, 'UTC'),
            version UInt64
          )
          ENGINE ReplacingMergeTree(version)
          PARTITION BY toYYYYMM(started_at)
          ORDER BY trace_id
        `,
      });
      await client.command({
        query: `
          INSERT INTO ${database}.spans VALUES
            ('old-a', '2026-06-01 00:00:00.000', '2026-06-01 00:00:01.000', 1),
            ('old-b', '2026-07-01 00:00:00.000', '2026-07-01 00:00:01.000', 1)
        `,
      });
      await client.command({
        query: `INSERT INTO ${database}.derived_probe VALUES ('live', '2026-08-01 00:00:00.000', '2026-08-01 00:00:01.000', 1)`,
      });

      const columns = [
        { name: "trace_id", type: "String" },
        { name: "created_at", type: "DateTime64(3, 'UTC')" },
        { name: "version", type: "UInt64" },
      ] as const satisfies readonly ClickhouseColumn[];
      const selectSql = `SELECT trace_id, created_at, version FROM ${database}.spans`;
      await backfillDerivedSpanTable(client, { database, table: "derived_probe", selectSql, targetColumns: columns });
      expect(await countRowsIn(database, "derived_probe")).toBe(3);
      expect(await countRowsIn(database, "derived_span_backfill_state")).toBe(3);

      await backfillDerivedSpanTable(client, { database, table: "derived_probe", selectSql, targetColumns: columns });
      expect(await countRowsIn(database, "derived_probe")).toBe(3);
      expect(await countRowsIn(database, "derived_span_backfill_state")).toBe(3);
    });
  });

  test("the rollup materialized view's output types match its target table exactly", async () => {
    await client.command({ query: buildTelemetryCreateTableSql(`${testDatabase}.events`) });
    await client.command({ query: buildIssueOccurrenceRollupCreateTableSql(testDatabase) });
    await client.command({ query: buildIssueOccurrenceRollupMvSql(testDatabase) });

    const columnTypes = async (table: string) => {
      const resultSet = await client.query({
        query: "SELECT name, type FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position",
        query_params: { database: testDatabase, table },
        format: "JSONEachRow",
      });
      return await resultSet.json<{ name: string, type: string }>();
    };
    // `SimpleAggregateFunction(f, T)` accepts a plain `T` from the SELECT — that
    // is exactly what makes it "simple". Unwrap it so the comparison asserts the
    // real ClickHouse compatibility rule rather than a spelling difference; the
    // genuinely strict cases (`bucket_start DateTime('UTC')` from
    // toStartOfHour, `LowCardinality(String)` from coalesce, and the `uniq`
    // state's Nullable(String) argument) are compared verbatim.
    const unwrapSimpleAggregate = (type: string) => type.replace(/^SimpleAggregateFunction\([^,]+, (.*)\)$/, "$1");

    const target = await columnTypes("issue_occurrence_rollup");
    const view = await columnTypes("issue_occurrence_rollup_mv");
    expect(view.map((column) => column.name)).toEqual(target.map((column) => column.name));
    expect(view.map((column) => column.type)).toEqual(target.map((column) => unwrapSimpleAggregate(column.type)));
    expect(view.find((column) => column.name === "users_state")?.type).toBe("AggregateFunction(uniq, Nullable(String))");
  });

  test("the rollup fills forward from $error inserts without breaking the source insert", async () => {
    await client.command({ query: buildTelemetryCreateTableSql(`${testDatabase}.events`) });
    await client.command({ query: buildIssueOccurrenceRollupCreateTableSql(testDatabase) });
    await client.command({ query: buildIssueOccurrenceRollupMvSql(testDatabase) });

    await client.command({
      query: `
        INSERT INTO ${testDatabase}.events (event_type, event_at, data, project_id, branch_id, user_id, service_name, deployment_environment_name, issue_hash) VALUES
        ('$error', now64(3), '{}', 'roll', 'b', 'u1',  'api',  'production', 'hash-a'),
        ('$error', now64(3), '{}', 'roll', 'b', NULL,  'api',  'production', 'hash-a'),
        ('$error', now64(3), '{}', 'roll', 'b', 'u2',  'api',  'production', 'hash-a'),
        ('$error', now64(3), '{}', 'roll', 'b', 'u1',  NULL,   NULL,         'hash-b'),
        ('$error', now64(3), '{}', 'roll', 'b', 'u3',  'api',  'production', ''),
        ('$log',   now64(3), '{}', 'roll', 'b', 'u4',  'api',  'production', '')
      `,
    });

    const resultSet = await client.query({
      query: `
        SELECT issue_hash, service_name, deployment_environment_name, sum(occurrences) AS occurrences, uniqMerge(users_state) AS users
        FROM ${testDatabase}.issue_occurrence_rollup
        WHERE project_id = 'roll'
        GROUP BY issue_hash, service_name, deployment_environment_name
        ORDER BY issue_hash
      `,
      format: "JSONEachRow",
    });
    const rollupRows = await resultSet.json<{ issue_hash: string, service_name: string, deployment_environment_name: string, occurrences: number | string, users: number | string }>();
    expect(rollupRows.map((row) => ({ ...row, occurrences: Number(row.occurrences), users: Number(row.users) }))).toEqual([
      { issue_hash: "hash-a", service_name: "api", deployment_environment_name: "production", occurrences: 3, users: 2 },
      { issue_hash: "hash-b", service_name: "", deployment_environment_name: "", occurrences: 1, users: 1 },
    ]);
    const ungrouped = await client.query({
      query: `SELECT count() AS count FROM ${testDatabase}.issue_occurrence_rollup WHERE project_id = 'roll' AND issue_hash = ''`,
      format: "JSONEachRow",
    });
    expect(Number((await ungrouped.json<{ count: string }>())[0].count)).toBe(0);
  });

  test("the rollup expires on bucket_start, so late arrivals never extend or shorten a bucket's lease", async () => {
    const table = "issue_rollup_ttl_probe";
    await client.command({ query: buildIssueOccurrenceRollupCreateTableSql(testDatabase).replace("issue_occurrence_rollup", table) });

    const insertBucket = async (issueHash: string, daysAgo: number, userId: string) => {
      await client.command({
        query: `
          INSERT INTO ${testDatabase}.${table}
          SELECT 'ttl', 'b', '${issueHash}', toStartOfHour(now() - INTERVAL ${daysAgo} DAY), 'api', 'production',
                 1, uniqState(CAST('${userId}', 'Nullable(String)')), now64(3), now64(3)
        `,
      });
    };
    const applyTtl = async () => {
      await client.command({ query: `ALTER TABLE ${testDatabase}.${table} MATERIALIZE TTL`, clickhouse_settings: { mutations_sync: "2" } });
    };
    const bucketsByHash = async () => {
      const resultSet = await client.query({
        query: `SELECT issue_hash, toString(bucket_start) AS bucket_start, sum(occurrences) AS occurrences FROM ${testDatabase}.${table} GROUP BY issue_hash, bucket_start ORDER BY issue_hash`,
        format: "JSONEachRow",
      });
      const rows = await resultSet.json<{ issue_hash: string, bucket_start: string, occurrences: number | string }>();
      return rows.map((row) => ({ ...row, occurrences: Number(row.occurrences) }));
    };

    await insertBucket("just-expired", 91, "u1");
    await insertBucket("still-live", 89, "u1");
    await applyTtl();
    expect((await bucketsByHash()).map((row) => row.issue_hash)).toEqual(["still-live"]);

    const liveBucketStart = (await bucketsByHash())[0].bucket_start;
    await insertBucket("still-live", 89, "u2");
    await applyTtl();
    expect(await bucketsByHash()).toEqual([
      { issue_hash: "still-live", bucket_start: liveBucketStart, occurrences: 2 },
    ]);

    await insertBucket("just-expired", 91, "u3");
    await applyTtl();
    expect((await bucketsByHash()).map((row) => row.issue_hash)).toEqual(["still-live"]);
  });
});
