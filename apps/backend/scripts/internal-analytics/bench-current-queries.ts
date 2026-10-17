/**
 * Runs the platform-analytics ClickHouse queries EXACTLY as the route does
 * (same SQL via clickhouse-queries.ts, same metrics client / settings, all in
 * parallel) against an isolated `bench_pa2` database seeded at prod-like
 * scale, and reports per-query peak memory from system.query_log so the
 * query that trips the ~488 MiB per-query cap can be named.
 *
 * Differences from benchmark-platform-analytics.ts (which copies the SQL and
 * runs queries one at a time): the synced tables are seeded the way the
 * Postgres->ClickHouse sync produces them in production — several row
 * versions per entity spread across month partitions, deletion tombstones,
 * and many un-merged parts (merges are stopped while seeding) — because the
 * production failure is inside `SourceFromNativeStream`, i.e. while reading
 * blocks, not while aggregating.
 *
 * Usage (local only):
 *   pnpm --filter @hexclave/backend run with-env:dev tsx scripts/internal-analytics/bench-current-queries.ts
 * Env:
 *   PA_PROJECTS=10000 PA_USERS=1000000 PA_EVENTS=50000000 PA_USER_VERSIONS=4
 *   PA_SKIP_SEED=1   reuse an already-seeded bench_pa2
 *   PA_SEQUENTIAL=1  run queries one by one instead of Promise.all
 *   PA_OUT=/tmp/pa-bench-current.untracked.json
 */
import { buildPlatformAnalyticsClickhouseQueries, platformAnalyticsQueryId, type PlatformAnalyticsClickhouseQueryName } from "@/app/api/latest/internal/platform-analytics/clickhouse-queries";
import { getClickhouseAdminClient, getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { writeFileSync } from "node:fs";

function envInt(name: string, fallback: number): number {
  const v = getEnvVariable(name, "");
  return v === "" ? fallback : Number(v);
}
const envBool = (name: string) => getEnvVariable(name, "") === "1";

const NUM_PROJECTS = envInt("PA_PROJECTS", 10_000);
const NUM_USERS = envInt("PA_USERS", 1_000_000);
const NUM_EVENTS = envInt("PA_EVENTS", 50_000_000);
const USER_VERSIONS = envInt("PA_USER_VERSIONS", 4);
const ZIPF_K = 4;
const BRANCH = "main";
const DB = "bench_pa2";
const OUT = getEnvVariable("PA_OUT", "/tmp/pa-bench-current.untracked.json");

const chAdmin = getClickhouseAdminClient();
const chMetrics = getClickhouseAdminClientForMetrics();
const t0 = performance.now();
const log = (...a: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const ONE_DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const todayUtc = new Date();
todayUtc.setUTCHours(0, 0, 0, 0);
const chDT = (d: Date) => d.toISOString().slice(0, 19);
const window = {
  branchId: BRANCH,
  internalProjectId: "internal",
  since: chDT(new Date(todayUtc.getTime() - (WINDOW_DAYS - 1) * ONE_DAY_MS)),
  mid: chDT(new Date(todayUtc.getTime() - (WINDOW_DAYS - 1) * ONE_DAY_MS)),
  priorSince: chDT(new Date(todayUtc.getTime() - (2 * WINDOW_DAYS - 1) * ONE_DAY_MS)),
  until: chDT(new Date(todayUtc.getTime() + ONE_DAY_MS)),
};

const SYNCED_TABLES = ["users", "contact_channels", "teams", "connected_accounts", "email_outboxes"];
const ALL_TABLES = ["events", ...SYNCED_TABLES, "clickmap_events"];

async function seed() {
  log(`CH: drop+create ${DB}`);
  await chAdmin.command({ query: `DROP DATABASE IF EXISTS ${DB}` });
  await chAdmin.command({ query: `CREATE DATABASE ${DB}` });
  for (const t of ALL_TABLES) {
    await chAdmin.command({ query: `CREATE TABLE ${DB}.${t} AS analytics_internal.${t}` });
  }
  // Keep every insert as its own part, like a steady trickle of sync batches would.
  for (const t of SYNCED_TABLES) await chAdmin.command({ query: `SYSTEM STOP MERGES ${DB}.${t}` });

  const projExpr = (key: string) =>
    `concat('bench-proj-', toString(toUInt32(floor(${NUM_PROJECTS} * pow((cityHash64(${key}) % 1000000)/1000000.0, ${ZIPF_K})))))`;
  const uuidExpr = (key: string) => `reinterpretAsUUID(MD5(toString(${key})))`;
  const ccExpr = `['US','DE','IN','BR','GB','FR','JP','CA','AU','NL'][(cityHash64(number,'cc') % 10)+1]`;

  const CHUNK = 5_000_000;
  for (let off = 0; off < NUM_EVENTS; off += CHUNK) {
    const n = Math.min(CHUNK, NUM_EVENTS - off);
    await chAdmin.command({
      query: `
      INSERT INTO ${DB}.events
      SELECT
        ['$token-refresh','$token-refresh','$token-refresh','$token-refresh','$token-refresh','$token-refresh','$token-refresh','$page-view','$page-view','$click'][((number+${off}) % 10)+1] AS event_type,
        now64(3,'UTC') - toIntervalSecond(cityHash64(number+${off},'t') % (90*86400)) AS event_at,
        CAST(concat('{"is_anonymous":', toString(toUInt8(cityHash64((number+${off}) % ${NUM_USERS},'a') % 10 = 0)),
          ',"ip_info":{"country_code":"', ${ccExpr}, '"},"referrer":"","user_agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36","path":"/dashboard/settings/', toString(number % 977), '"}'), 'JSON') AS data,
        ${projExpr(`(number+${off}) % ${NUM_USERS}`)} AS project_id,
        '${BRANCH}' AS branch_id,
        toString(${uuidExpr(`(number+${off}) % ${NUM_USERS}`)}) AS user_id,
        NULL AS team_id, NULL AS refresh_token_id, NULL AS session_replay_id, NULL AS session_replay_segment_id,
        now64(3,'UTC') AS created_at
      FROM numbers(${n})`,
    });
    log(`CH events: ${(off + n).toLocaleString()} / ${NUM_EVENTS.toLocaleString()}`);
  }

  // users: USER_VERSIONS row versions per user (sync re-emits the row on every
  // update, each with a higher sync_sequence_id), inserted in 100k batches so
  // the table has hundreds of parts. Version v is written signed_up_at-shifted
  // so versions land in different month partitions; ~5% of users additionally
  // get a deletion tombstone in the newest partition.
  const USER_BATCH = 100_000;
  for (let v = 0; v < USER_VERSIONS; v++) {
    for (let off = 0; off < NUM_USERS; off += USER_BATCH) {
      const n = Math.min(USER_BATCH, NUM_USERS - off);
      await chAdmin.command({
        query: `
        INSERT INTO ${DB}.users
        SELECT
          ${projExpr(`number+${off}`)} AS project_id, '${BRANCH}' AS branch_id, ${uuidExpr(`number+${off}`)} AS id,
          if(${v} = 0, NULL, concat('User ', toString(number+${off}))) AS display_name, NULL AS profile_image_url,
          concat('u', toString(number+${off}), '@ex.com') AS primary_email,
          toUInt8(cityHash64(number+${off},'v') % 10 < 7) AS primary_email_verified,
          now64(3,'UTC') - toIntervalSecond(cityHash64(number+${off},'s') % (365*86400)) - toIntervalDay(${v} * 31) AS signed_up_at,
          '{}' AS client_metadata, '{}' AS client_read_only_metadata,
          concat('{"v":', toString(${v}), ',"plan":"free","notes":"', repeat('x', 64), '"}') AS server_metadata,
          toUInt8(cityHash64(number+${off},'a') % 10 = 0) AS is_anonymous,
          0 AS restricted_by_admin, NULL AS restricted_by_admin_reason, NULL AS restricted_by_admin_private_details,
          toInt64(number+${off}) + ${v} * ${NUM_USERS} AS sync_sequence_id, 0 AS sync_is_deleted, now64(3,'UTC') AS sync_created_at
        FROM numbers(${n})`,
      });
    }
    log(`CH users: version ${v + 1}/${USER_VERSIONS} written`);
  }
  await chAdmin.command({
    query: `
    INSERT INTO ${DB}.users
    SELECT
      ${projExpr("number")} AS project_id, '${BRANCH}' AS branch_id, ${uuidExpr("number")} AS id,
      NULL AS display_name, NULL AS profile_image_url, concat('u', toString(number), '@ex.com') AS primary_email,
      0 AS primary_email_verified, now64(3,'UTC') AS signed_up_at,
      '{}' AS client_metadata, '{}' AS client_read_only_metadata, '{}' AS server_metadata,
      0 AS is_anonymous, 0 AS restricted_by_admin, NULL AS restricted_by_admin_reason, NULL AS restricted_by_admin_private_details,
      toInt64(number) + ${USER_VERSIONS} * ${NUM_USERS} AS sync_sequence_id, 1 AS sync_is_deleted, now64(3,'UTC') AS sync_created_at
    FROM numbers(${NUM_USERS}) WHERE cityHash64(number,'del') % 20 = 0`,
  });
  log("CH users: tombstones written");

  for (let v = 0; v < 2; v++) {
    for (let off = 0; off < NUM_USERS; off += USER_BATCH) {
      const n = Math.min(USER_BATCH, NUM_USERS - off);
      await chAdmin.command({
        query: `
        INSERT INTO ${DB}.contact_channels
        SELECT
          ${projExpr(`number+${off}`)} AS project_id, '${BRANCH}' AS branch_id,
          reinterpretAsUUID(MD5(concat('cc', toString(number+${off})))) AS id, ${uuidExpr(`number+${off}`)} AS user_id,
          'EMAIL' AS type, concat('u', toString(number+${off}), '@ex.com') AS value,
          1 AS is_primary, toUInt8(${v} = 1) AS is_verified, 1 AS used_for_auth,
          now64(3,'UTC') - toIntervalDay(${v} * 31) AS created_at, toInt64(number+${off}) + ${v} * ${NUM_USERS} AS sync_sequence_id, 0 AS sync_is_deleted, now64(3,'UTC') AS sync_created_at
        FROM numbers(${n}) WHERE cityHash64(number+${off},'v') % 10 < 7`,
      });
    }
  }
  log("CH contact_channels written");

  await chAdmin.command({
    query: `
    INSERT INTO ${DB}.teams
    SELECT ${projExpr("number")} AS project_id, '${BRANCH}' AS branch_id,
      reinterpretAsUUID(MD5(concat('tm', toString(number)))) AS id, concat('Team ', toString(number)) AS display_name,
      NULL AS profile_image_url, now64(3,'UTC') AS created_at, '{}' AS client_metadata, '{}' AS client_read_only_metadata,
      '{}' AS server_metadata, toInt64(number) AS sync_sequence_id, 0 AS sync_is_deleted, now64(3,'UTC') AS sync_created_at
    FROM numbers(150000)`,
  });
  await chAdmin.command({
    query: `
    INSERT INTO ${DB}.connected_accounts
    SELECT ${projExpr("number")} AS project_id, '${BRANCH}' AS branch_id, ${uuidExpr("number")} AS user_id,
      ['google','github','microsoft'][(number%3)+1] AS provider, concat('pa', toString(number)) AS provider_account_id,
      now64(3,'UTC') AS created_at, toInt64(number) AS sync_sequence_id, 0 AS sync_is_deleted, now64(3,'UTC') AS sync_created_at
    FROM numbers(300000)`,
  });
  await chAdmin.command({
    query: `
    INSERT INTO ${DB}.email_outboxes
    SELECT ${projExpr("number")} AS project_id, '${BRANCH}' AS branch_id,
      reinterpretAsUUID(MD5(concat('eo', toString(number)))) AS id, 'SENT' AS status, 'OK' AS simple_status,
      'API' AS created_with, NULL AS email_draft_id, NULL AS email_programmatic_call_template_id, NULL AS theme_id,
      0 AS is_high_priority, 1 AS is_transactional, 'Subj' AS subject, NULL AS notification_category_id,
      NULL AS started_rendering_at, NULL AS rendered_at, NULL AS render_error, now64(3,'UTC') AS scheduled_at,
      now64(3,'UTC') AS created_at, now64(3,'UTC') AS updated_at, NULL AS started_sending_at, NULL AS server_error,
      NULL AS delivered_at, NULL AS opened_at, NULL AS clicked_at, NULL AS unsubscribed_at, NULL AS marked_as_spam_at,
      NULL AS bounced_at, NULL AS delivery_delayed_at, NULL AS can_have_delivery_info, NULL AS skipped_reason,
      NULL AS skipped_details, 0 AS send_retries, 0 AS is_paused, toInt64(number) AS sync_sequence_id, 0 AS sync_is_deleted, now64(3,'UTC') AS sync_created_at
    FROM numbers(500000)`,
  });
  await chAdmin.command({
    query: `
    INSERT INTO ${DB}.clickmap_events
    SELECT ${projExpr("number")} AS project_id, '${BRANCH}' AS branch_id,
      now64(3,'UTC') - toIntervalSecond(cityHash64(number,'t') % (90*86400)) AS event_at,
      toString(number % ${NUM_USERS}) AS user_id, NULL AS session_replay_id,
      'https://app.example.com/x' AS url, '/x' AS path, 1280 AS viewport_width, 800 AS viewport_height,
      100 AS pointer_x, 200 AS pointer_y, 200 AS client_y, 0.1 AS pointer_relative_x, 0 AS pointer_target_fixed,
      '' AS elements_chain, 'button' AS selector, 'Click' AS elements_text, 'button' AS tag_name, NULL AS href,
      toUInt8(cityHash64(number,'d') % 20 = 0) AS is_dead
    FROM numbers(2000000)`,
  });
  log("CH: small tables written");
}

async function describeTables() {
  const rows = await (await chAdmin.query({
    query: `SELECT table, count() AS parts, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS size
            FROM system.parts WHERE active AND database = {db:String} GROUP BY table ORDER BY table`,
    query_params: { db: DB }, format: "JSONEachRow",
  })).json<{ table: string, parts: string, rows: string, size: string }>();
  for (const r of rows) log(`  ${DB}.${r.table}: ${Number(r.rows).toLocaleString()} rows, ${r.parts} parts, ${r.size}`);
}

type Stat = { name: string, ok: boolean, durationMs: number, peakMiB: number, readRows: number, readMiB: number, resultRows: number, error?: string };
type Run = { name: PlatformAnalyticsClickhouseQueryName, queryId: string, resultRows: number, error?: string };

async function runOne(name: PlatformAnalyticsClickhouseQueryName, sql: string, params: Record<string, unknown>): Promise<Run> {
  const queryId = platformAnalyticsQueryId(name);
  try {
    const r = await chMetrics.query({ query: sql, query_params: params, query_id: queryId, format: "JSONEachRow" });
    return { name, queryId, resultRows: (await r.json<unknown>()).length };
  } catch (e) {
    return { name, queryId, resultRows: 0, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}

// query_log is written asynchronously; flush once after every query has finished
// and look all of them up in a single pass.
async function collectStats(runs: Run[]): Promise<Stat[]> {
  type LogRow = { query_id: string, query_duration_ms: string, memory_usage: string, read_rows: string, read_bytes: string };
  let byId = new Map<string, LogRow>();
  // The QueryFinish entry is enqueued after the response has been sent, so a
  // single flush right after the client returns can miss it; poll briefly.
  for (let attempt = 0; attempt < 20 && byId.size < runs.length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await chAdmin.command({ query: "SYSTEM FLUSH LOGS" });
    const rows = await (await chAdmin.query({
      query: `SELECT query_id, query_duration_ms, memory_usage, read_rows, read_bytes
              FROM system.query_log WHERE query_id IN {qids:Array(String)} AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart')`,
      query_params: { qids: runs.map((r) => r.queryId) }, format: "JSONEachRow",
    })).json<LogRow>();
    byId = new Map(rows.map((r) => [r.query_id, r]));
  }
  return runs.map((run) => {
    const s = byId.get(run.queryId) ?? throwErr(`no query_log row for ${run.name} (${run.queryId})`);
    return {
      name: run.name, ok: run.error === undefined, durationMs: Number(s.query_duration_ms), peakMiB: Number(s.memory_usage) / 1048576,
      readRows: Number(s.read_rows), readMiB: Number(s.read_bytes) / 1048576, resultRows: run.resultRows, error: run.error,
    };
  });
}

async function main() {
  if (!envBool("PA_SKIP_SEED")) {
    log(`seeding ${DB}: ${NUM_PROJECTS} projects, ${NUM_USERS.toLocaleString()} users x${USER_VERSIONS}, ${NUM_EVENTS.toLocaleString()} events`);
    await seed();
  }
  await describeTables();

  const queries = buildPlatformAnalyticsClickhouseQueries(DB, window);
  const specs = typedEntries(queries).map(([name, spec]) => ({ name, spec }));
  log(`running ${specs.length} queries ${envBool("PA_SEQUENTIAL") ? "sequentially" : "in parallel (like the route)"}`);
  let runs: Run[];
  if (envBool("PA_SEQUENTIAL")) {
    runs = [];
    for (const { name, spec } of specs) {
      const r = await runOne(name, spec.sql, spec.params);
      log(`  ${name}: ${r.error === undefined ? "ok" : `FAIL ${r.error}`}`);
      runs.push(r);
    }
  } else {
    runs = await Promise.all(specs.map(({ name, spec }) => runOne(name, spec.sql, spec.params)));
  }
  const stats = await collectStats(runs);
  stats.sort((a, b) => b.peakMiB - a.peakMiB);
  console.table(stats.map((s) => ({ name: s.name, ok: s.ok, peakMiB: s.peakMiB.toFixed(1), ms: s.durationMs, readRows: s.readRows, readMiB: s.readMiB.toFixed(0), rows: s.resultRows, error: s.error ?? "" })));
  writeFileSync(OUT, JSON.stringify({ window, scale: { NUM_PROJECTS, NUM_USERS, NUM_EVENTS, USER_VERSIONS }, stats }, null, 2));
  log(`wrote ${OUT}`);
  await chAdmin.close();
  await chMetrics.close();
}

try {
  await main();
} catch (e) {
  console.error("BENCH FAILED:", e);
  process.exit(1);
}
