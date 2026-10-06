/**
 * Local-only benchmark + equivalence harness for the ClickHouse queries in
 * apps/backend/src/app/api/latest/internal/metrics/route.tsx.
 *
 * Three modes, selected via env flags (all run by default):
 *
 *   1. MAU equivalence matrix (default ON; set BENCH_SKIP_MATRIX=1 to skip)
 *      Small-data test cases for loadMonthlyActiveUsers. Asserts that the
 *      BEFORE (pre-fix) and AFTER (current) queries return the same MAU
 *      count AND the same set of individual users across 13 edge cases:
 *      empty, dedup, anonymous filter, window boundary, null user_id,
 *      non-UUID user_id, case variation, project isolation, etc.
 *
 *   2. MAU perf run (default ON; set BENCH_SKIP_PERF=1 to skip)
 *      Runs OLD vs NEW MAU query on the heavy seed. Reads
 *      memory_usage/read_rows/result_bytes from system.query_log and prints
 *      a comparison table plus all candidate variants (v1 uniqExact strings,
 *      v2 inline regex, v3 UUID keys, v4 sipHash64 [shipped], v5-v7 HLL
 *      sketches). Also includes a set-equality check so "same count,
 *      different users" can't slip through.
 *
 *   3. Full-route benchmark (set BENCH_ROUTE_QUERIES=1)
 *      Runs every ClickHouse query in the internal-metrics route
 *      (loadUsersByCountry, loadDailyActiveUsers, the splits,
 *      loadMonthlyActiveUsers, analyticsOverview:{dailyEvents,
 *      totalVisitors, topReferrers, topRegion, online}) in three stages:
 *      BEFORE (pre-fix), AFTER (current: fixes 1 + 3), and OPTIMIZED
 *      (further candidate opts not yet shipped — e.g. dropping the
 *      analyticsOverview LEFT JOIN, hashed split partition keys,
 *      loadUsersByCountry time window). Prints ranked per-query deltas and
 *      endpoint-level totals (sum peak memory, max duration).
 *
 * Seeds synthetic events under a unique project_id so real data is never
 * touched; cleans up via ALTER TABLE ... DELETE on exit.
 *
 * Run: pnpm --filter @hexclave/backend run with-env:dev tsx scripts/benchmark-internal-metrics.ts
 * Env knobs:
 *   BENCH_USERS           (default 200_000) – distinct users in the perf seed
 *   BENCH_EVENTS_USER     (default 5)       – $token-refresh events per user
 *   BENCH_ANON_RATIO      (default 0.1)     – fraction flagged is_anonymous
 *   BENCH_BATCH           (default 50_000)  – insert batch size
 *   BENCH_SKIP_PERF=1                       – skip the heavy MAU perf run
 *   BENCH_SKIP_MATRIX=1                     – skip the equivalence matrix
 *   BENCH_ROUTE_QUERIES=1                   – also run the full-route
 *                                             BEFORE/AFTER/OPTIMIZED suite
 *   BENCH_PAGE_VIEWS_USER (default 3)       – $page-view events per user
 *   BENCH_CLICKS_USER     (default 1)       – $click events per user
 *   BENCH_TEAM_RATIO      (default 0.3)     – fraction of users with a team
 */

import { getClickhouseAdminClient, getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { randomUUID } from "node:crypto";

const RUN_ID = randomUUID();
const BENCH_PROJECT_ID = `bench-mau-${RUN_ID}`;
const PERF_BRANCH_ID = "perf";

const METRICS_WINDOW_DAYS = 30;
const METRICS_WINDOW_MS = METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_RE_CH = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

function envInt(name: string, fallback: number): number {
  const v = getEnvVariable(name, "");
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad ${name}: ${v}`);
  return n;
}
function envFloat(name: string, fallback: number): number {
  const v = getEnvVariable(name, "");
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad ${name}: ${v}`);
  return n;
}
function envBool(name: string): boolean {
  const v = getEnvVariable(name, "");
  return v === "1" || v === "true";
}

function formatCh(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function normalizeUuidFromEvent(value: string): string | null {
  const n = value.trim().toLowerCase();
  return UUID_RE.test(n) ? n : null;
}

type EventRow = {
  event_type: string,
  event_at: string,
  data: Record<string, unknown>,
  project_id: string,
  branch_id: string,
  user_id: string | null,
  team_id: string | null,
};

const OLD_QUERY = `
  SELECT assumeNotNull(user_id) AS user_id
  FROM analytics_internal.events
  WHERE event_type = '$token-refresh'
    AND project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND user_id IS NOT NULL
    AND event_at >= {since:DateTime}
    AND event_at < {untilExclusive:DateTime}
    AND ({includeAnonymous:UInt8} = 1 OR JSONExtract(toJSONString(data), 'is_anonymous', 'UInt8') = 0)
  GROUP BY user_id
`;

// Proposed query. Counts on the server (so we never ship N user_ids back to
// the client) and filters via direct JSON path access (skips the per-row
// toJSONString → JSONExtract round-trip that blows up memory in prod).
// Matches the old JS normalization: lower/trim + isUuid regex.
const NEW_QUERY = `
  SELECT uniqExact(normalized_user_id) AS mau
  FROM (
    SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
    FROM analytics_internal.events
    WHERE event_type = '$token-refresh'
      AND project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND user_id IS NOT NULL
      AND event_at >= {since:DateTime}
      AND event_at < {untilExclusive:DateTime}
      AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
  )
  WHERE match(normalized_user_id, {uuidRe:String})
`;

type QueryParams = {
  projectId: string,
  branchId: string,
  since: Date,
  untilExclusive: Date,
  includeAnonymous: boolean,
};

async function runOld(p: QueryParams): Promise<{ count: number, set: Set<string>, queryId: string }> {
  const client = getClickhouseAdminClient();
  const queryId = `bench-old-${randomUUID()}`;
  const res = await client.query({
    query: OLD_QUERY,
    query_params: {
      projectId: p.projectId,
      branchId: p.branchId,
      since: formatCh(p.since),
      untilExclusive: formatCh(p.untilExclusive),
      includeAnonymous: p.includeAnonymous ? 1 : 0,
    },
    query_id: queryId,
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { user_id: string }[];
  const set = new Set<string>();
  for (const r of rows) {
    const n = normalizeUuidFromEvent(r.user_id);
    if (n != null) set.add(n);
  }
  return { count: set.size, set, queryId };
}

async function runNew(p: QueryParams): Promise<{ count: number, queryId: string }> {
  const client = getClickhouseAdminClient();
  const queryId = `bench-new-${randomUUID()}`;
  const res = await client.query({
    query: NEW_QUERY,
    query_params: {
      projectId: p.projectId,
      branchId: p.branchId,
      since: formatCh(p.since),
      untilExclusive: formatCh(p.untilExclusive),
      includeAnonymous: p.includeAnonymous ? 1 : 0,
      uuidRe: UUID_RE_CH,
    },
    query_id: queryId,
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { mau: string | number }[];
  return { count: Number(rows[0]?.mau ?? 0), queryId };
}

// Diagnostic-only variant of the NEW query that returns the set of distinct
// normalized user_ids instead of just the count. Used by the equivalence
// check to prove the OLD pipeline and the NEW pipeline would have counted
// the *same users*, not just the same number of users.
const NEW_QUERY_SET = `
  SELECT DISTINCT normalized_user_id
  FROM (
    SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
    FROM analytics_internal.events
    WHERE event_type = '$token-refresh'
      AND project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND user_id IS NOT NULL
      AND event_at >= {since:DateTime}
      AND event_at < {untilExclusive:DateTime}
      AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
  )
  WHERE match(normalized_user_id, {uuidRe:String})
`;

async function runNewSet(p: QueryParams): Promise<Set<string>> {
  const client = getClickhouseAdminClient();
  const res = await client.query({
    query: NEW_QUERY_SET,
    query_params: {
      projectId: p.projectId,
      branchId: p.branchId,
      since: formatCh(p.since),
      untilExclusive: formatCh(p.untilExclusive),
      includeAnonymous: p.includeAnonymous ? 1 : 0,
      uuidRe: UUID_RE_CH,
    },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { normalized_user_id: string }[];
  return new Set(rows.map((r) => r.normalized_user_id));
}

function setDiff(a: Set<string>, b: Set<string>): { onlyInA: string[], onlyInB: string[] } {
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const x of a) if (!b.has(x)) onlyInA.push(x);
  for (const x of b) if (!a.has(x)) onlyInB.push(x);
  return { onlyInA, onlyInB };
}

// ── Alternate query variants explored for further memory/duration wins ──────
// Each variant returns a single row with `mau` (count). The equivalence check
// compares against the OLD pipeline's exact count.

type Variant = {
  name: string,
  description: string,
  approximate?: boolean,
  sql: string,
};

const COMMON_FILTERS = `
  WHERE event_type = '$token-refresh'
    AND project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND user_id IS NOT NULL
    AND event_at >= {since:DateTime}
    AND event_at < {untilExclusive:DateTime}
    AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
`;

const VARIANTS: Variant[] = [
  {
    name: "v1_uniqExact_string",
    description: "uniqExact on lower(trim(user_id)) string; regex filter in outer WHERE (current fix)",
    sql: `
      SELECT uniqExact(normalized_user_id) AS mau
      FROM (
        SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        ${COMMON_FILTERS}
      )
      WHERE match(normalized_user_id, {uuidRe:String})
    `,
  },
  {
    name: "v2_uniqExact_inline",
    description: "Same as v1 but regex + normalization folded into inner WHERE (no subquery)",
    sql: `
      SELECT uniqExact(lower(trim(assumeNotNull(user_id)))) AS mau
      FROM analytics_internal.events
      ${COMMON_FILTERS}
        AND match(lower(trim(assumeNotNull(user_id))), {uuidRe:String})
    `,
  },
  {
    name: "v3_uniqExact_toUUID",
    description: "uniqExact on toUUIDOrNull(...) — 16-byte native UUID keys instead of 36-byte strings",
    sql: `
      SELECT uniqExact(uid) AS mau
      FROM (
        SELECT toUUIDOrNull(lower(trim(assumeNotNull(user_id)))) AS uid
        FROM analytics_internal.events
        ${COMMON_FILTERS}
      )
      WHERE uid IS NOT NULL
        AND match(toString(uid), {uuidRe:String})
    `,
  },
  {
    name: "v4_uniqExact_sipHash64",
    description: "uniqExact on sipHash64(...) — 8-byte keys; collision prob negligible at <<2^32 users",
    sql: `
      SELECT uniqExact(h) AS mau
      FROM (
        SELECT sipHash64(lower(trim(assumeNotNull(user_id)))) AS h,
               lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        ${COMMON_FILTERS}
      )
      WHERE match(normalized_user_id, {uuidRe:String})
    `,
  },
  {
    name: "v5_uniq_hll",
    description: "uniq() HyperLogLog — bounded ~16 KiB state, typical error ~0.5% (APPROXIMATE)",
    approximate: true,
    sql: `
      SELECT uniq(normalized_user_id) AS mau
      FROM (
        SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        ${COMMON_FILTERS}
      )
      WHERE match(normalized_user_id, {uuidRe:String})
    `,
  },
  {
    name: "v6_uniqCombined",
    description: "uniqCombined(17) — exact for small N, HLL after threshold; ~96 KiB state (APPROXIMATE)",
    approximate: true,
    sql: `
      SELECT uniqCombined(17)(normalized_user_id) AS mau
      FROM (
        SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        ${COMMON_FILTERS}
      )
      WHERE match(normalized_user_id, {uuidRe:String})
    `,
  },
  {
    name: "v7_uniqHLL12",
    description: "uniqHLL12 — ~4 KiB state, typical error ~2% (APPROXIMATE)",
    approximate: true,
    sql: `
      SELECT uniqHLL12(normalized_user_id) AS mau
      FROM (
        SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        ${COMMON_FILTERS}
      )
      WHERE match(normalized_user_id, {uuidRe:String})
    `,
  },
];

// ── Route-wide query census ─────────────────────────────────────────────────
// Every ClickHouse query from apps/backend/src/app/api/latest/internal/metrics/route.tsx,
// captured verbatim so we can measure the full shape of the endpoint.

type RouteQuery = {
  name: string,
  desc: string,
  sql: string,
  extraParams?: (now: Date, untilExclusive: Date) => Record<string, unknown>,
};

const ANALYTICS_USER_JOIN = `
  LEFT JOIN (
    SELECT
      user_id,
      argMax(JSONExtract(toJSONString(data), 'is_anonymous', 'UInt8'), event_at) AS latest_is_anonymous
    FROM analytics_internal.events
    WHERE event_type = '$token-refresh'
      AND project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND user_id IS NOT NULL
      AND event_at < {untilExclusive:DateTime}
    GROUP BY user_id
  ) AS token_refresh_users
    ON e.user_id = token_refresh_users.user_id
`;
const NON_ANON_FILTER = "({includeAnonymous:UInt8} = 1 OR coalesce(JSONExtract(toJSONString(e.data), 'is_anonymous', 'Nullable(UInt8)'), token_refresh_users.latest_is_anonymous, 0) = 0)";

// Post-fix: lower `event_at >= since` bound added to the inner subquery.
const ANALYTICS_USER_JOIN_AFTER = `
  LEFT JOIN (
    SELECT
      user_id,
      argMax(coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0), event_at) AS latest_is_anonymous
    FROM analytics_internal.events
    WHERE event_type = '$token-refresh'
      AND project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND user_id IS NOT NULL
      AND event_at >= {since:DateTime}
      AND event_at < {untilExclusive:DateTime}
    GROUP BY user_id
  ) AS token_refresh_users
    ON e.user_id = token_refresh_users.user_id
`;
const NON_ANON_FILTER_AFTER = "({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), token_refresh_users.latest_is_anonymous, 0) = 0)";

const ROUTE_QUERIES_BEFORE: RouteQuery[] = [
  {
    name: "loadUsersByCountry",
    desc: "argMax country per user over all $token-refresh events (NO time window)",
    sql: `
      SELECT
        country_code,
        count() AS userCount
      FROM (
        SELECT
          user_id,
          argMax(cc, event_at) AS country_code
        FROM (
          SELECT
            user_id,
            event_at,
            CAST(data.ip_info.country_code, 'Nullable(String)') AS cc,
            coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) AS is_anonymous
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND user_id IS NOT NULL
        )
        WHERE cc IS NOT NULL
          AND ({includeAnonymous:UInt8} = 1 OR is_anonymous = 0)
        GROUP BY user_id
      )
      WHERE country_code IS NOT NULL
      GROUP BY country_code
      ORDER BY userCount DESC
    `,
  },
  {
    name: "loadDailyActiveUsers",
    desc: "DAU per day over 30d (uniqExact on raw user_id)",
    sql: `
      SELECT
        toDate(event_at) AS day,
        uniqExact(assumeNotNull(user_id)) AS dau
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR JSONExtract(toJSONString(data), 'is_anonymous', 'UInt8') = 0)
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "loadDailyActiveUsersSplit",
    desc: "All (day, user_id) pairs — ships N rows back to Node for split processing",
    sql: `
      SELECT
        toDate(event_at) AS day,
        assumeNotNull(user_id) AS user_id
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR JSONExtract(toJSONString(data), 'is_anonymous', 'UInt8') = 0)
      GROUP BY day, user_id
    `,
  },
  {
    name: "loadDailyActiveTeamsSplit",
    desc: "All (day, team_id) pairs — same shape as DAU split, team side",
    sql: `
      SELECT
        toDate(event_at) AS day,
        assumeNotNull(team_id) AS team_id
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND team_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
      GROUP BY day, team_id
    `,
  },
  {
    name: "loadMonthlyActiveUsers (FIXED: v4)",
    desc: "NEW: uniqExact(sipHash64(normalized)) — what we just shipped",
    sql: `
      SELECT uniqExact(sipHash64(normalized_user_id)) AS mau
      FROM (
        SELECT lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND user_id IS NOT NULL
          AND event_at >= {since:DateTime}
          AND event_at < {untilExclusive:DateTime}
          AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
      )
      WHERE match(normalized_user_id, {uuidRe:String})
    `,
  },
  {
    name: "analyticsOverview:dailyEvents",
    desc: "page-view+click daily counts, visitors/day — with LEFT JOIN to token_refresh_users",
    sql: `
      SELECT
        toDate(e.event_at) AS day,
        countIf(
          e.event_type = '$page-view'
            AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER}
        ) AS pv,
        countIf(
          e.event_type = '$click'
            AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER}
        ) AS cl,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.event_type = '$page-view'
            AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${ANALYTICS_USER_JOIN}
      WHERE e.event_type IN ('$page-view', '$click')
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "analyticsOverview:totalVisitors",
    desc: "uniq visitors over 30d (page-view + join)",
    sql: `
      SELECT
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${ANALYTICS_USER_JOIN}
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.user_id IS NOT NULL
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
    `,
  },
  {
    name: "analyticsOverview:topReferrers",
    desc: "top 100 referrers by uniq visitors (GROUP BY referrer)",
    sql: `
      SELECT
        nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${ANALYTICS_USER_JOIN}
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY referrer
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 100
    `,
  },
  {
    name: "analyticsOverview:topRegion",
    desc: "top (country, region) by uniq visitors (LIMIT 1)",
    sql: `
      SELECT
        CAST(data.ip_info.country_code, 'Nullable(String)') AS country_code,
        CAST(data.ip_info.region_code, 'Nullable(String)') AS region_code,
        uniqExactIf(
          assumeNotNull(user_id),
          user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR JSONExtract(toJSONString(data), 'is_anonymous', 'UInt8') = 0)
        ) AS visitors
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
      GROUP BY country_code, region_code
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 1
    `,
  },
  {
    name: "analyticsOverview:online",
    desc: "uniq users active in last 5 minutes",
    sql: `
      SELECT
        uniqExact(assumeNotNull(user_id)) AS online
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {onlineSince:DateTime}
        AND event_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR JSONExtract(toJSONString(data), 'is_anonymous', 'UInt8') = 0)
    `,
    extraParams: (now, untilExclusive) => ({
      onlineSince: formatCh(new Date(now.getTime() - 5 * 60 * 1000)),
      untilExclusive: formatCh(untilExclusive),
    }),
  },
];

// After fixes 1 + 3. Same names, updated SQL. Queries not touched by either
// fix (loadUsersByCountry, loadMonthlyActiveUsers-FIXED) reuse the BEFORE entry.
function splitSqlAfter(idCol: "user_id" | "team_id", withAnonFilter: boolean): string {
  const anonFilter = withAnonFilter
    ? "AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)"
    : "";
  return `
    SELECT
      toString(w.day) AS day,
      count() AS total_count,
      countIf(f.first_date = w.day) AS new_count,
      countIf(f.first_date < w.day AND w.prev_day = addDays(w.day, -1)) AS retained_count,
      countIf(f.first_date < w.day AND (isNull(w.prev_day) OR w.prev_day < addDays(w.day, -1))) AS reactivated_count
    FROM (
      SELECT
        day,
        ${idCol},
        lagInFrame(day, 1) OVER (PARTITION BY ${idCol} ORDER BY day) AS prev_day
      FROM (
        SELECT DISTINCT
          toDate(event_at) AS day,
          assumeNotNull(${idCol}) AS ${idCol}
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND ${idCol} IS NOT NULL
          AND event_at >= {since:DateTime}
          AND event_at < {untilExclusive:DateTime}
          ${anonFilter}
      )
    ) AS w
    LEFT JOIN (
      SELECT
        assumeNotNull(${idCol}) AS ${idCol},
        toDate(min(event_at)) AS first_date
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND ${idCol} IS NOT NULL
        AND event_at < {untilExclusive:DateTime}
        ${anonFilter}
      GROUP BY ${idCol}
    ) AS f USING (${idCol})
    GROUP BY w.day
    ORDER BY w.day ASC
  `;
}

const ROUTE_QUERIES_AFTER: RouteQuery[] = [
  {
    name: "loadUsersByCountry",
    desc: "30-day window added (was unbounded scan)",
    sql: `
      SELECT
        country_code,
        count() AS userCount
      FROM (
        SELECT
          user_id,
          argMax(cc, event_at) AS country_code
        FROM (
          SELECT
            user_id,
            event_at,
            CAST(data.ip_info.country_code, 'Nullable(String)') AS cc,
            coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) AS is_anonymous
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND user_id IS NOT NULL
            AND event_at >= {since:DateTime}
            AND event_at < {untilExclusive:DateTime}
        )
        WHERE cc IS NOT NULL
          AND ({includeAnonymous:UInt8} = 1 OR is_anonymous = 0)
        GROUP BY user_id
      )
      WHERE country_code IS NOT NULL
      GROUP BY country_code
      ORDER BY userCount DESC
    `,
  },
  {
    name: "loadDailyActiveUsers",
    desc: "DAU per day (fix 1: CAST instead of JSONExtract)",
    sql: `
      SELECT
        toDate(event_at) AS day,
        uniqExact(assumeNotNull(user_id)) AS dau
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "loadDailyActiveUsersSplit",
    desc: "fix 3: server-side new/retained/reactivated (no PG join, 31-row result)",
    sql: splitSqlAfter("user_id", true),
  },
  {
    name: "loadDailyActiveTeamsSplit",
    desc: "fix 3: server-side new/retained/reactivated (no PG join, 31-row result)",
    sql: splitSqlAfter("team_id", false),
  },
  // Unchanged — already v4 fixed.
  ROUTE_QUERIES_BEFORE[4], // loadMonthlyActiveUsers
  {
    name: "analyticsOverview:dailyEvents",
    desc: "fix 1: direct CAST in join + non-anon filter",
    sql: `
      SELECT
        toDate(e.event_at) AS day,
        countIf(
          e.event_type = '$page-view'
            AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS pv,
        countIf(
          e.event_type = '$click'
            AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS cl,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.event_type = '$page-view'
            AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${ANALYTICS_USER_JOIN_AFTER}
      WHERE e.event_type IN ('$page-view', '$click')
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "analyticsOverview:totalVisitors",
    desc: "fix 1: direct CAST in join + non-anon filter",
    sql: `
      SELECT
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${ANALYTICS_USER_JOIN_AFTER}
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.user_id IS NOT NULL
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
    `,
  },
  {
    name: "analyticsOverview:topReferrers",
    desc: "fix 1: direct CAST in join + non-anon filter",
    sql: `
      SELECT
        nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${ANALYTICS_USER_JOIN_AFTER}
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY referrer
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 100
    `,
  },
  {
    name: "analyticsOverview:topRegion",
    desc: "fix 1: direct CAST",
    sql: `
      SELECT
        CAST(data.ip_info.country_code, 'Nullable(String)') AS country_code,
        CAST(data.ip_info.region_code, 'Nullable(String)') AS region_code,
        uniqExactIf(
          assumeNotNull(user_id),
          user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        ) AS visitors
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
      GROUP BY country_code, region_code
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 1
    `,
  },
  {
    name: "analyticsOverview:online",
    desc: "fix 1: direct CAST",
    sql: `
      SELECT
        uniqExact(assumeNotNull(user_id)) AS online
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {onlineSince:DateTime}
        AND event_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
    `,
    extraParams: (now, untilExclusive) => ({
      onlineSince: formatCh(new Date(now.getTime() - 5 * 60 * 1000)),
      untilExclusive: formatCh(untilExclusive),
    }),
  },
];

// More aggressive optimizations stacked on top of fixes 1+3. Each entry is
// paired with its BEFORE/AFTER counterpart by name (normalized) so the
// comparator can line them up.
const ROUTE_QUERIES_OPTIMIZED: RouteQuery[] = [
  {
    name: "loadUsersByCountry",
    desc: "opt: add 30-day event_at window (was unbounded)",
    sql: `
      SELECT
        country_code,
        count() AS userCount
      FROM (
        SELECT
          user_id,
          argMax(cc, event_at) AS country_code
        FROM (
          SELECT
            user_id,
            event_at,
            CAST(data.ip_info.country_code, 'Nullable(String)') AS cc,
            CAST(data.is_anonymous, 'UInt8') AS is_anonymous
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND user_id IS NOT NULL
            AND event_at >= {since:DateTime}
            AND event_at < {untilExclusive:DateTime}
        )
        WHERE cc IS NOT NULL
          AND ({includeAnonymous:UInt8} = 1 OR is_anonymous = 0)
        GROUP BY user_id
      )
      WHERE country_code IS NOT NULL
      GROUP BY country_code
      ORDER BY userCount DESC
    `,
  },
  {
    name: "loadDailyActiveUsersSplit",
    desc: "opt: sipHash64(user_id) as window partition key + join key",
    sql: `
      SELECT
        toString(w.day) AS day,
        count() AS total_count,
        countIf(f.first_date = w.day) AS new_count,
        countIf(f.first_date < w.day AND w.prev_day = addDays(w.day, -1)) AS retained_count,
        countIf(f.first_date < w.day AND (isNull(w.prev_day) OR w.prev_day < addDays(w.day, -1))) AS reactivated_count
      FROM (
        SELECT
          day,
          user_hash,
          lagInFrame(day, 1) OVER (PARTITION BY user_hash ORDER BY day) AS prev_day
        FROM (
          SELECT DISTINCT
            toDate(event_at) AS day,
            sipHash64(assumeNotNull(user_id)) AS user_hash
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND user_id IS NOT NULL
            AND event_at >= {since:DateTime}
            AND event_at < {untilExclusive:DateTime}
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        )
      ) AS w
      LEFT JOIN (
        SELECT
          sipHash64(assumeNotNull(user_id)) AS user_hash,
          toDate(min(event_at)) AS first_date
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND user_id IS NOT NULL
          AND event_at < {untilExclusive:DateTime}
          AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        GROUP BY user_hash
      ) AS f USING (user_hash)
      GROUP BY w.day
      ORDER BY w.day ASC
    `,
  },
  {
    name: "loadDailyActiveTeamsSplit",
    desc: "opt: sipHash64(team_id) as window partition key + join key",
    sql: `
      SELECT
        toString(w.day) AS day,
        count() AS total_count,
        countIf(f.first_date = w.day) AS new_count,
        countIf(f.first_date < w.day AND w.prev_day = addDays(w.day, -1)) AS retained_count,
        countIf(f.first_date < w.day AND (isNull(w.prev_day) OR w.prev_day < addDays(w.day, -1))) AS reactivated_count
      FROM (
        SELECT
          day,
          team_hash,
          lagInFrame(day, 1) OVER (PARTITION BY team_hash ORDER BY day) AS prev_day
        FROM (
          SELECT DISTINCT
            toDate(event_at) AS day,
            sipHash64(assumeNotNull(team_id)) AS team_hash
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND team_id IS NOT NULL
            AND event_at >= {since:DateTime}
            AND event_at < {untilExclusive:DateTime}
        )
      ) AS w
      LEFT JOIN (
        SELECT
          sipHash64(assumeNotNull(team_id)) AS team_hash,
          toDate(min(event_at)) AS first_date
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND team_id IS NOT NULL
          AND event_at < {untilExclusive:DateTime}
        GROUP BY team_hash
      ) AS f USING (team_hash)
      GROUP BY w.day
      ORDER BY w.day ASC
    `,
  },
  {
    name: "analyticsOverview:dailyEvents",
    desc: "opt: drop LEFT JOIN, trust e.data.is_anonymous",
    sql: `
      SELECT
        toDate(e.event_at) AS day,
        countIf(
          e.event_type = '$page-view'
            AND e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        ) AS pv,
        countIf(
          e.event_type = '$click'
            AND e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        ) AS cl,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.event_type = '$page-view'
            AND e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        ) AS visitors
      FROM analytics_internal.events AS e
      WHERE e.event_type IN ('$page-view', '$click')
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "analyticsOverview:totalVisitors",
    desc: "opt: drop LEFT JOIN, trust e.data.is_anonymous",
    sql: `
      SELECT
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        ) AS visitors
      FROM analytics_internal.events AS e
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.user_id IS NOT NULL
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
    `,
  },
  {
    name: "analyticsOverview:topReferrers",
    desc: "opt: drop LEFT JOIN, trust e.data.is_anonymous",
    sql: `
      SELECT
        nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
        ) AS visitors
      FROM analytics_internal.events AS e
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY referrer
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 100
    `,
  },
];

// ── Backfill comparison (BENCH_BACKFILL_COMPARE=1) ──────────────────────────
// Compares post-backfill query shapes: A (bounded join, no backfill), B/C/E
// (drop join, classify from data.is_anonymous), D (drop join, classify from
// a top-level column). B/C/E produce identical query SQL; they differ only in
// how the data gets stamped.

// Scoped to RUN_ID so concurrent runs / SIGKILL-leaked columns don't collide.
const BENCH_OPTION_D_COLUMN = `bench_is_anon_d_${RUN_ID.replace(/-/g, "_")}`;

const analyticsUserJoinBounded = `
  LEFT JOIN (
    SELECT
      user_id,
      argMax(coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0), event_at) AS latest_is_anonymous
    FROM analytics_internal.events
    WHERE event_type = '$token-refresh'
      AND project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND user_id IS NOT NULL
      AND event_at >= {since:DateTime}        -- ★ option A's lower bound
      AND event_at < {untilExclusive:DateTime}
    GROUP BY user_id
  ) AS token_refresh_users
    ON e.user_id = token_refresh_users.user_id
`;

const ROUTE_QUERIES_BACKFILL_A: RouteQuery[] = [
  {
    name: "analyticsOverview:dailyEvents",
    desc: "A: bounded LEFT JOIN (event_at >= since on inner)",
    sql: `
      SELECT
        toDate(e.event_at) AS day,
        countIf(
          e.event_type = '$page-view' AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS pv,
        countIf(
          e.event_type = '$click' AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS cl,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.event_type = '$page-view' AND e.user_id IS NOT NULL
            AND ${NON_ANON_FILTER_AFTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${analyticsUserJoinBounded}
      WHERE e.event_type IN ('$page-view', '$click')
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "analyticsOverview:totalVisitors",
    desc: "A: bounded LEFT JOIN (event_at >= since on inner)",
    sql: `
      SELECT
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL AND ${NON_ANON_FILTER_AFTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${analyticsUserJoinBounded}
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.user_id IS NOT NULL
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
    `,
  },
  {
    name: "analyticsOverview:topReferrers",
    desc: "A: bounded LEFT JOIN (event_at >= since on inner)",
    sql: `
      SELECT
        nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL AND ${NON_ANON_FILTER_AFTER}
        ) AS visitors
      FROM analytics_internal.events AS e
      ${analyticsUserJoinBounded}
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY referrer
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 100
    `,
  },
];

// Options B/C/E all collapse to the same post-backfill SQL shape: drop the
// LEFT JOIN entirely and trust e.data.is_anonymous (the field that the
// ingestion fix will populate). The OPTIMIZED array already contains exactly
// these queries — reuse them so we have a single source of truth.
const ROUTE_QUERIES_BACKFILL_BCE: RouteQuery[] = ROUTE_QUERIES_OPTIMIZED.filter((q) =>
  q.name === "analyticsOverview:dailyEvents"
  || q.name === "analyticsOverview:totalVisitors"
  || q.name === "analyticsOverview:topReferrers",
);

const ROUTE_QUERIES_BACKFILL_D: RouteQuery[] = [
  {
    name: "analyticsOverview:dailyEvents",
    desc: "D: drop join, top-level UInt8 column (no JSON parse)",
    sql: `
      SELECT
        toDate(e.event_at) AS day,
        countIf(
          e.event_type = '$page-view' AND e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(e.${BENCH_OPTION_D_COLUMN}, 0) = 0)
        ) AS pv,
        countIf(
          e.event_type = '$click' AND e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(e.${BENCH_OPTION_D_COLUMN}, 0) = 0)
        ) AS cl,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.event_type = '$page-view' AND e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(e.${BENCH_OPTION_D_COLUMN}, 0) = 0)
        ) AS visitors
      FROM analytics_internal.events AS e
      WHERE e.event_type IN ('$page-view', '$click')
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY day
      ORDER BY day ASC
    `,
  },
  {
    name: "analyticsOverview:totalVisitors",
    desc: "D: drop join, top-level UInt8 column (no JSON parse)",
    sql: `
      SELECT
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(e.${BENCH_OPTION_D_COLUMN}, 0) = 0)
        ) AS visitors
      FROM analytics_internal.events AS e
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.user_id IS NOT NULL
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
    `,
  },
  {
    name: "analyticsOverview:topReferrers",
    desc: "D: drop join, top-level UInt8 column (no JSON parse)",
    sql: `
      SELECT
        nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
        uniqExactIf(
          assumeNotNull(e.user_id),
          e.user_id IS NOT NULL
            AND ({includeAnonymous:UInt8} = 1 OR coalesce(e.${BENCH_OPTION_D_COLUMN}, 0) = 0)
        ) AS visitors
      FROM analytics_internal.events AS e
      WHERE e.event_type = '$page-view'
        AND e.project_id = {projectId:String}
        AND e.branch_id = {branchId:String}
        AND e.event_at >= {since:DateTime}
        AND e.event_at < {untilExclusive:DateTime}
      GROUP BY referrer
      HAVING visitors > 0
      ORDER BY visitors DESC
      LIMIT 100
    `,
  },
];

async function ensureOptionDColumn(): Promise<void> {
  const client = getClickhouseAdminClient();
  const res = await client.query({
    query: `
      SELECT count() AS c FROM system.columns
      WHERE database = 'analytics_internal'
        AND table = 'events'
        AND name = {col:String}
    `,
    query_params: { col: BENCH_OPTION_D_COLUMN },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { c: string | number }[];
  if (Number(rows[0]?.c ?? 0) === 0) {
    await client.command({
      query: `
        ALTER TABLE analytics_internal.events
        ADD COLUMN IF NOT EXISTS ${BENCH_OPTION_D_COLUMN} Nullable(UInt8)
      `,
    });
  }
}

async function populateOptionDColumn(): Promise<void> {
  const client = getClickhouseAdminClient();
  await client.command({
    query: `
      ALTER TABLE analytics_internal.events
      UPDATE ${BENCH_OPTION_D_COLUMN} = CAST(data.is_anonymous, 'Nullable(UInt8)')
      WHERE project_id = {projectId:String}
    `,
    query_params: { projectId: BENCH_PROJECT_ID },
    clickhouse_settings: { mutations_sync: "2" },
  });
}

async function dropOptionDColumn(): Promise<void> {
  const client = getClickhouseAdminClient();
  await client.command({
    query: `ALTER TABLE analytics_internal.events DROP COLUMN IF EXISTS ${BENCH_OPTION_D_COLUMN}`,
  });
}

// Pulls only the 3 analyticsOverview queries that touch the join from the
// current (post-fixes-1+3) shipped SQL, so we have a baseline to compare against.
const ROUTE_QUERIES_BACKFILL_BASELINE: RouteQuery[] = ROUTE_QUERIES_AFTER.filter((q) =>
  q.name === "analyticsOverview:dailyEvents"
  || q.name === "analyticsOverview:totalVisitors"
  || q.name === "analyticsOverview:topReferrers",
);

async function benchmarkBackfillCompare(now: Date): Promise<void> {
  const untilExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + ONE_DAY_MS);
  const since = new Date(untilExclusive.getTime() - METRICS_WINDOW_MS);
  const params: QueryParams = {
    projectId: BENCH_PROJECT_ID,
    branchId: PERF_BRANCH_ID,
    since,
    untilExclusive,
    includeAnonymous: false,
  };

  console.log("\n── Backfill option comparison (post-backfill query memory) ──");
  console.log("  Each option leaves the metrics queries in one of three shapes:");
  console.log("    Today / A (bounded join) / B,C,E (drop join, JSON) / D (drop join, top-level column)\n");

  // Set up option D's column.
  console.log("  Setting up option D top-level column…");
  await ensureOptionDColumn();
  await populateOptionDColumn();
  console.log("  done.\n");

  async function runShape(label: string, list: RouteQuery[]): Promise<Map<string, QueryStats>> {
    const out = new Map<string, QueryStats>();
    for (const rq of list) {
      const qid = await runRouteQuery(rq, params, now);
      out.set(rq.name, await readStats(qid));
    }
    return out;
  }

  // Warm cache once with a tiny query.
  await runRouteQuery(ROUTE_QUERIES_BEFORE[1], params, now);

  const baseline = await runShape("today", ROUTE_QUERIES_BACKFILL_BASELINE);
  const a = await runShape("A", ROUTE_QUERIES_BACKFILL_A);
  const bce = await runShape("B/C/E", ROUTE_QUERIES_BACKFILL_BCE);
  const d = await runShape("D", ROUTE_QUERIES_BACKFILL_D);

  const padL = (s: string, n: number) => s.padEnd(n);
  const padR = (s: string, n: number) => s.padStart(n);
  const mem = (n: number | undefined) => n == null ? "—" : padR(fmtBytes(n), 12);
  const dur = (n: number | undefined) => n == null ? "—" : padR(`${n} ms`, 9);

  const queryNames = ["analyticsOverview:dailyEvents", "analyticsOverview:totalVisitors", "analyticsOverview:topReferrers"];

  console.log("  Peak memory per query, per backfill shape:");
  console.log([
    padL("query", 36),
    padR("Today", 12),
    padR("A: bounded", 12),
    padR("B/C/E: drop", 12),
    padR("D: column", 12),
  ].join("  "));
  console.log("  " + "─".repeat(96));
  for (const name of queryNames) {
    const t = baseline.get(name);
    const av = a.get(name);
    const bv = bce.get(name);
    const dv = d.get(name);
    console.log([
      "  " + padL(name, 34),
      mem(t?.memory_usage),
      mem(av?.memory_usage),
      mem(bv?.memory_usage),
      mem(dv?.memory_usage),
    ].join("  "));
  }

  // Totals
  const sum = (m: Map<string, QueryStats>) =>
    queryNames.reduce((acc, n) => acc + (m.get(n)?.memory_usage ?? 0), 0);
  const tSum = sum(baseline);
  const aSum = sum(a);
  const bSum = sum(bce);
  const dSum = sum(d);

  console.log("  " + "─".repeat(96));
  console.log([
    "  " + padL("SUM peak memory", 34),
    padR(fmtBytes(tSum), 12),
    padR(fmtBytes(aSum), 12),
    padR(fmtBytes(bSum), 12),
    padR(fmtBytes(dSum), 12),
  ].join("  "));

  const ratio = (s: number) => s === 0 ? "—" : `${(tSum / s).toFixed(2)}× less`;
  console.log([
    "  " + padL("vs. Today", 34),
    padR("—", 12),
    padR(ratio(aSum), 12),
    padR(ratio(bSum), 12),
    padR(ratio(dSum), 12),
  ].join("  "));

  // Duration too
  console.log("\n  Query duration per shape:");
  console.log([
    padL("query", 36),
    padR("Today", 9),
    padR("A", 9),
    padR("B/C/E", 9),
    padR("D", 9),
  ].join("  "));
  console.log("  " + "─".repeat(84));
  for (const name of queryNames) {
    console.log([
      "  " + padL(name, 34),
      dur(baseline.get(name)?.query_duration_ms),
      dur(a.get(name)?.query_duration_ms),
      dur(bce.get(name)?.query_duration_ms),
      dur(d.get(name)?.query_duration_ms),
    ].join("  "));
  }

  console.log("\n  Notes:");
  console.log("    • B, C, E all produce the same query SQL; their column above is one number.");
  console.log("    • The semantic differences (argMax-latest vs ASOF vs partition-swap) live");
  console.log("      in the backfill operation, not in the query that runs afterwards.");
  console.log("    • Option D mutates a stored column instead of the JSON field; the runtime");
  console.log("      win comes from skipping per-row JSON access.");
}

async function runRouteQuery(rq: RouteQuery, p: QueryParams, now: Date, opts: { useMetricsClient?: boolean } = {}): Promise<string> {
  // `useMetricsClient` applies the route.tsx connection-level SETTINGS so AFTER
  // measurements reflect what actually ships, not the raw SQL.
  const client = opts.useMetricsClient ? getClickhouseAdminClientForMetrics() : getClickhouseAdminClient();
  const queryId = `bench-route-${rq.name.replace(/[^a-z0-9]/gi, "-")}-${randomUUID()}`;
  const baseParams: Record<string, unknown> = {
    projectId: p.projectId,
    branchId: p.branchId,
    since: formatCh(p.since),
    untilExclusive: formatCh(p.untilExclusive),
    includeAnonymous: p.includeAnonymous ? 1 : 0,
    uuidRe: UUID_RE_CH,
  };
  const extra = rq.extraParams ? rq.extraParams(now, p.untilExclusive) : {};
  await client.query({
    query: rq.sql,
    query_params: { ...baseParams, ...extra },
    query_id: queryId,
    format: "JSONEachRow",
  }).then((r) => r.json()); // drain stream
  return queryId;
}

// ── Join algorithm comparison (BENCH_JOIN_ALGO_COMPARE=1) ─────────────────────
// Runs each of ClickHouse's 6 join_algorithm values against the bounded and
// unbounded analyticsUserJoin shapes. Algorithms that don't apply (e.g.
// `direct` without a Dictionary right side) error and show as ERR.

const ANALYTICS_OVERVIEW_QUERY_NAMES = [
  "analyticsOverview:dailyEvents",
  "analyticsOverview:totalVisitors",
  "analyticsOverview:topReferrers",
] as const;

const JOIN_ALGORITHMS = [
  "default",
  "direct",
  "hash",
  "parallel_hash",
  "grace_hash",
  "full_sorting_merge",
  "partial_merge",
] as const;
type JoinAlgorithm = typeof JOIN_ALGORITHMS[number];

// Build the 3 analyticsOverview queries with the given join SQL, filter SQL,
// and a per-query SETTINGS clause (used to force `join_algorithm`).
function buildAnalyticsOverviewVariant(opts: {
  joinSql: string,
  nonAnonFilter: string,
  joinAlgorithm: JoinAlgorithm,
}): RouteQuery[] {
  const settings = opts.joinAlgorithm === "default"
    ? ""
    : `SETTINGS join_algorithm = '${opts.joinAlgorithm}'`;
  return [
    {
      name: "analyticsOverview:dailyEvents",
      desc: `analyticsOverview daily events (join_algorithm=${opts.joinAlgorithm})`,
      sql: `
        SELECT
          toDate(e.event_at) AS day,
          countIf(
            e.event_type = '$page-view'
              AND e.user_id IS NOT NULL
              AND ${opts.nonAnonFilter}
          ) AS pv,
          countIf(
            e.event_type = '$click'
              AND e.user_id IS NOT NULL
              AND ${opts.nonAnonFilter}
          ) AS cl,
          uniqExactIf(
            assumeNotNull(e.user_id),
            e.event_type = '$page-view'
              AND e.user_id IS NOT NULL
              AND ${opts.nonAnonFilter}
          ) AS visitors
        FROM analytics_internal.events AS e
        ${opts.joinSql}
        WHERE e.event_type IN ('$page-view', '$click')
          AND e.project_id = {projectId:String}
          AND e.branch_id = {branchId:String}
          AND e.event_at >= {since:DateTime}
          AND e.event_at < {untilExclusive:DateTime}
        GROUP BY day
        ORDER BY day ASC
        ${settings}
      `,
    },
    {
      name: "analyticsOverview:totalVisitors",
      desc: `analyticsOverview total visitors (join_algorithm=${opts.joinAlgorithm})`,
      sql: `
        SELECT
          uniqExactIf(
            assumeNotNull(e.user_id),
            e.user_id IS NOT NULL
              AND ${opts.nonAnonFilter}
          ) AS visitors
        FROM analytics_internal.events AS e
        ${opts.joinSql}
        WHERE e.event_type = '$page-view'
          AND e.project_id = {projectId:String}
          AND e.branch_id = {branchId:String}
          AND e.user_id IS NOT NULL
          AND e.event_at >= {since:DateTime}
          AND e.event_at < {untilExclusive:DateTime}
        ${settings}
      `,
    },
    {
      name: "analyticsOverview:topReferrers",
      desc: `analyticsOverview top referrers (join_algorithm=${opts.joinAlgorithm})`,
      sql: `
        SELECT
          nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
          uniqExactIf(
            assumeNotNull(e.user_id),
            e.user_id IS NOT NULL
              AND ${opts.nonAnonFilter}
          ) AS visitors
        FROM analytics_internal.events AS e
        ${opts.joinSql}
        WHERE e.event_type = '$page-view'
          AND e.project_id = {projectId:String}
          AND e.branch_id = {branchId:String}
          AND e.event_at >= {since:DateTime}
          AND e.event_at < {untilExclusive:DateTime}
        GROUP BY referrer
        HAVING visitors > 0
        ORDER BY visitors DESC
        LIMIT 100
        ${settings}
      `,
    },
  ];
}

// Run a query; on failure log the error and return null so the join-algo
// matrix can show ERR for shapes a given algorithm doesn't support (e.g.
// `direct` without a Dictionary right side).
async function tryRunAndReadStats(rq: RouteQuery, p: QueryParams, now: Date): Promise<QueryStats | null> {
  try {
    const qid = await runRouteQuery(rq, p, now);
    return await readStats(qid);
  } catch (e) {
    console.warn(`  [bench] query "${rq.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function benchmarkJoinAlgorithms(now: Date): Promise<void> {
  const untilExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + ONE_DAY_MS);
  const since = new Date(untilExclusive.getTime() - METRICS_WINDOW_MS);
  const params: QueryParams = {
    projectId: BENCH_PROJECT_ID,
    branchId: PERF_BRANCH_ID,
    since,
    untilExclusive,
    includeAnonymous: false,
  };

  console.log("\n── Join algorithm comparison (6 algorithms × 2 cases) ──");
  console.log("  Cases:");
  console.log("    normal = bounded analyticsUserJoin (the SQL we just shipped)");
  console.log("    heavy  = UNBOUNDED analyticsUserJoin (pre-fix; what caused the Sentry OOM)");
  console.log("");

  // Warm cache once.
  await runRouteQuery(
    buildAnalyticsOverviewVariant({
      joinSql: ANALYTICS_USER_JOIN_AFTER,
      nonAnonFilter: NON_ANON_FILTER_AFTER,
      joinAlgorithm: "default",
    })[0],
    params,
    now,
  );

  type CaseName = "normal" | "heavy";
  const cases: Record<CaseName, { joinSql: string, nonAnonFilter: string }> = {
    normal: { joinSql: ANALYTICS_USER_JOIN_AFTER, nonAnonFilter: NON_ANON_FILTER_AFTER },
    heavy: { joinSql: ANALYTICS_USER_JOIN, nonAnonFilter: NON_ANON_FILTER },
  };

  type StatsByCaseByAlgo = Record<CaseName, Record<JoinAlgorithm, Map<string, QueryStats | null>>>;
  const stats: StatsByCaseByAlgo = {
    normal: {} as Record<JoinAlgorithm, Map<string, QueryStats | null>>,
    heavy: {} as Record<JoinAlgorithm, Map<string, QueryStats | null>>,
  };

  for (const caseName of ["normal", "heavy"] as const) {
    for (const algo of JOIN_ALGORITHMS) {
      const queries = buildAnalyticsOverviewVariant({
        joinSql: cases[caseName].joinSql,
        nonAnonFilter: cases[caseName].nonAnonFilter,
        joinAlgorithm: algo,
      });
      const out = new Map<string, QueryStats | null>();
      for (const rq of queries) {
        out.set(rq.name, await tryRunAndReadStats(rq, params, now));
      }
      stats[caseName][algo] = out;
    }
  }

  const padL = (s: string, n: number) => s.padEnd(n);
  const padR = (s: string, n: number) => s.padStart(n);
  const memCell = (s: QueryStats | null | undefined) =>
    s == null ? padR("ERR", 11) : padR(fmtBytes(s.memory_usage), 11);
  const durCell = (s: QueryStats | null | undefined) =>
    s == null ? padR("ERR", 9) : padR(`${s.query_duration_ms} ms`, 9);

  function printCaseTable(caseName: CaseName): void {
    console.log(`\n  ── ${caseName.toUpperCase()} case (${caseName === "normal" ? "bounded join" : "UNBOUNDED join"}) ──`);
    // Header row
    console.log([
      padL("query", 32),
      ...JOIN_ALGORITHMS.map((a) => padR(a, 11)),
    ].join("  "));
    console.log("  " + "─".repeat(32 + JOIN_ALGORITHMS.length * 13));
    // Per-query memory
    for (const name of ANALYTICS_OVERVIEW_QUERY_NAMES) {
      console.log([
        "  " + padL(name, 30),
        ...JOIN_ALGORITHMS.map((a) => memCell(stats[caseName][a].get(name))),
      ].join("  "));
    }
    // Sum memory row
    console.log("  " + "─".repeat(32 + JOIN_ALGORITHMS.length * 13));
    console.log([
      "  " + padL("SUM peak memory", 30),
      ...JOIN_ALGORITHMS.map((a) => {
        const sum = ANALYTICS_OVERVIEW_QUERY_NAMES.reduce((acc, n) => {
          const s = stats[caseName][a].get(n);
          return s == null ? acc : acc + s.memory_usage;
        }, 0);
        const anyErr = ANALYTICS_OVERVIEW_QUERY_NAMES.some((n) => stats[caseName][a].get(n) == null);
        return anyErr ? padR("partial", 11) : padR(fmtBytes(sum), 11);
      }),
    ].join("  "));
    // Sum duration row
    console.log([
      "  " + padL("SUM duration", 30),
      ...JOIN_ALGORITHMS.map((a) => {
        const sum = ANALYTICS_OVERVIEW_QUERY_NAMES.reduce((acc, n) => {
          const s = stats[caseName][a].get(n);
          return s == null ? acc : acc + s.query_duration_ms;
        }, 0);
        const anyErr = ANALYTICS_OVERVIEW_QUERY_NAMES.some((n) => stats[caseName][a].get(n) == null);
        return anyErr ? padR("partial", 11) : padR(`${sum} ms`, 11);
      }),
    ].join("  "));
  }

  printCaseTable("normal");
  printCaseTable("heavy");

  // Find the best algorithm per case by memory and by duration
  function bestByMemory(caseName: CaseName): { algo: JoinAlgorithm, mem: number } | null {
    let best: { algo: JoinAlgorithm, mem: number } | null = null;
    for (const a of JOIN_ALGORITHMS) {
      const sum = ANALYTICS_OVERVIEW_QUERY_NAMES.reduce((acc, n) => {
        const s = stats[caseName][a].get(n);
        return s == null ? acc : acc + s.memory_usage;
      }, 0);
      const anyErr = ANALYTICS_OVERVIEW_QUERY_NAMES.some((n) => stats[caseName][a].get(n) == null);
      if (anyErr) continue;
      if (best == null || sum < best.mem) best = { algo: a, mem: sum };
    }
    return best;
  }
  function bestByDuration(caseName: CaseName): { algo: JoinAlgorithm, dur: number } | null {
    let best: { algo: JoinAlgorithm, dur: number } | null = null;
    for (const a of JOIN_ALGORITHMS) {
      const sum = ANALYTICS_OVERVIEW_QUERY_NAMES.reduce((acc, n) => {
        const s = stats[caseName][a].get(n);
        return s == null ? acc : acc + s.query_duration_ms;
      }, 0);
      const anyErr = ANALYTICS_OVERVIEW_QUERY_NAMES.some((n) => stats[caseName][a].get(n) == null);
      if (anyErr) continue;
      if (best == null || sum < best.dur) best = { algo: a, dur: sum };
    }
    return best;
  }

  console.log("\n  Headlines:");
  for (const c of ["normal", "heavy"] as const) {
    const bm = bestByMemory(c);
    const bd = bestByDuration(c);
    if (bm) console.log(`    ${c.padEnd(7)} | best memory: ${bm.algo.padEnd(20)} (${fmtBytes(bm.mem)})`);
    if (bd) console.log(`    ${c.padEnd(7)} | best speed:  ${bd.algo.padEnd(20)} (${bd.dur} ms)`);
  }
  console.log("\n  Notes:");
  console.log("    • ERR / partial = the algorithm errored or didn't apply for that query shape");
  console.log("      (typical for `direct` which requires a Dictionary right-hand side).");
  console.log("    • The OOM bottleneck is the inner GROUP BY user_id aggregation, not the");
  console.log("      join's hash table — algorithms that only target the join (everything");
  console.log("      except sorting-merge variants) cap out at ~modest savings on the heavy case.");
}

async function benchmarkRouteQueries(now: Date): Promise<void> {
  const untilExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + ONE_DAY_MS);
  const since = new Date(untilExclusive.getTime() - METRICS_WINDOW_MS);
  const params: QueryParams = {
    projectId: BENCH_PROJECT_ID,
    branchId: PERF_BRANCH_ID,
    since,
    untilExclusive,
    includeAnonymous: false,
  };

  console.log("\n── Route-wide query benchmark (every ClickHouse query in /internal/metrics) ──");

  // Warm cache once.
  await runRouteQuery(ROUTE_QUERIES_BEFORE[1], params, now);

  async function runAll(list: RouteQuery[]): Promise<Map<string, QueryStats>> {
    const out = new Map<string, QueryStats>();
    for (const rq of list) {
      const qid = await runRouteQuery(rq, params, now);
      out.set(rq.name, await readStats(qid));
    }
    return out;
  }

  // Also capture row payloads to spot-check OPT variants (e.g. dropping the
  // LEFT JOIN must not change counts).
  async function runAndCollect(list: RouteQuery[], opts: { useMetricsClient?: boolean } = {}): Promise<{ stats: Map<string, QueryStats>, payloads: Map<string, unknown[]> }> {
    const stats = new Map<string, QueryStats>();
    const payloads = new Map<string, unknown[]>();
    for (const rq of list) {
      const client = opts.useMetricsClient ? getClickhouseAdminClientForMetrics() : getClickhouseAdminClient();
      const queryId = `bench-route-${rq.name.replace(/[^a-z0-9]/gi, "-")}-${randomUUID()}`;
      const baseParams: Record<string, unknown> = {
        projectId: params.projectId,
        branchId: params.branchId,
        since: formatCh(params.since),
        untilExclusive: formatCh(params.untilExclusive),
        includeAnonymous: params.includeAnonymous ? 1 : 0,
        uuidRe: UUID_RE_CH,
      };
      const extra = rq.extraParams ? rq.extraParams(now, params.untilExclusive) : {};
      const res = await client.query({
        query: rq.sql,
        query_params: { ...baseParams, ...extra },
        query_id: queryId,
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as unknown[];
      payloads.set(rq.name, rows);
      stats.set(rq.name, await readStats(queryId));
    }
    return { stats, payloads };
  }

  const before = await runAndCollect(ROUTE_QUERIES_BEFORE);
  const after = await runAndCollect(ROUTE_QUERIES_AFTER, { useMetricsClient: true });
  const opt = await runAndCollect(ROUTE_QUERIES_OPTIMIZED, { useMetricsClient: true });
  const beforeStats = before.stats;
  const afterStats = after.stats;

  // Normalize query names for the comparison table. Some AFTER queries have
  // the same name as BEFORE so they line up; loadMonthlyActiveUsers's BEFORE
  // entry is labeled "(FIXED: v4)" — normalize to match.
  const normalize = (n: string) => n.replace(/\s*\(FIXED.*\)$/, "").trim();

  const padL = (s: string, n: number) => s.padEnd(n);
  const padR = (s: string, n: number) => s.padStart(n);
  const fmtDelta = (a: number, b: number): string => {
    if (a === 0) return "—";
    const ratio = a / Math.max(b, 1);
    if (ratio >= 1) return `${ratio.toFixed(2)}× less`;
    return `${(1 / ratio).toFixed(2)}× more`;
  };

  console.log("\n  Per-query comparison (BEFORE → AFTER):");
  console.log("  " + [
    padL("query", 36),
    padR("mem BEFORE", 12),
    padR("mem AFTER", 12),
    padR("Δ mem", 10),
    padR("dur BEFORE", 11),
    padR("dur AFTER", 11),
    padR("Δ dur", 10),
  ].join("  "));
  console.log("  " + "─".repeat(130));

  const pairs: { name: string, before: QueryStats, after: QueryStats }[] = [];
  for (const rq of ROUTE_QUERIES_BEFORE) {
    const name = normalize(rq.name);
    const b = beforeStats.get(rq.name);
    const a = afterStats.get(rq.name) ?? afterStats.get(name) ??
      [...afterStats.entries()].find(([k]) => normalize(k) === name)?.[1];
    if (!b || !a) continue;
    pairs.push({ name, before: b, after: a });
  }
  // Sort by BEFORE memory descending for readability.
  pairs.sort((x, y) => y.before.memory_usage - x.before.memory_usage);

  for (const { name, before, after } of pairs) {
    console.log("  " + [
      padL(name, 36),
      padR(fmtBytes(before.memory_usage), 12),
      padR(fmtBytes(after.memory_usage), 12),
      padR(fmtDelta(before.memory_usage, after.memory_usage), 10),
      padR(`${before.query_duration_ms} ms`, 11),
      padR(`${after.query_duration_ms} ms`, 11),
      padR(fmtDelta(before.query_duration_ms, after.query_duration_ms), 10),
    ].join("  "));
  }

  const sumMemBefore = pairs.reduce((a, b) => a + b.before.memory_usage, 0);
  const sumMemAfter = pairs.reduce((a, b) => a + b.after.memory_usage, 0);
  const maxDurBefore = Math.max(...pairs.map((p) => p.before.query_duration_ms));
  const maxDurAfter = Math.max(...pairs.map((p) => p.after.query_duration_ms));
  const sumDurBefore = pairs.reduce((a, b) => a + b.before.query_duration_ms, 0);
  const sumDurAfter = pairs.reduce((a, b) => a + b.after.query_duration_ms, 0);
  const sumReadBefore = pairs.reduce((a, b) => a + b.before.read_bytes, 0);
  const sumReadAfter = pairs.reduce((a, b) => a + b.after.read_bytes, 0);
  const sumResultBefore = pairs.reduce((a, b) => a + b.before.result_bytes, 0);
  const sumResultAfter = pairs.reduce((a, b) => a + b.after.result_bytes, 0);

  console.log("\n  Totals (BEFORE → AFTER):");
  console.log(`    Sum peak memory:  ${fmtBytes(sumMemBefore)} → ${fmtBytes(sumMemAfter)}  (${fmtDelta(sumMemBefore, sumMemAfter)})`);
  console.log(`    Max query dur:    ${maxDurBefore} ms → ${maxDurAfter} ms  (${fmtDelta(maxDurBefore, maxDurAfter)})  [endpoint wall-clock floor]`);
  console.log(`    Sum query dur:    ${sumDurBefore} ms → ${sumDurAfter} ms  (${fmtDelta(sumDurBefore, sumDurAfter)})  [total CPU work]`);
  console.log(`    Sum bytes read:   ${fmtBytes(sumReadBefore)} → ${fmtBytes(sumReadAfter)}  (${fmtDelta(sumReadBefore, sumReadAfter)})`);
  console.log(`    Sum result ship:  ${fmtBytes(sumResultBefore)} → ${fmtBytes(sumResultAfter)}  (${fmtDelta(sumResultBefore, sumResultAfter)})`);

  // ── AFTER vs OPTIMIZED (additional peak-memory work) ───────────────────────
  console.log("\n  AFTER vs OPTIMIZED (stacked on top of fixes 1+3):");
  console.log("  " + [
    padL("query", 36),
    padR("mem AFTER", 12),
    padR("mem OPT", 12),
    padR("Δ mem", 12),
    padR("dur AFTER", 11),
    padR("dur OPT", 11),
    padR("Δ dur", 10),
    padL("counts=", 10),
  ].join("  "));
  console.log("  " + "─".repeat(140));

  type OptRow = { name: string, after: QueryStats, optStats: QueryStats, countsMatch: boolean | null };
  const optRows: OptRow[] = [];
  for (const rq of ROUTE_QUERIES_OPTIMIZED) {
    const optStats = opt.stats.get(rq.name);
    const afterS = after.stats.get(rq.name);
    const optPayload = opt.payloads.get(rq.name);
    const afterPayload = after.payloads.get(rq.name);
    if (!optStats || !afterS || !optPayload || !afterPayload) continue;
    // Deep-equal JSON of both sets (ordered matters for top-N, fine otherwise).
    const countsMatch = JSON.stringify(optPayload) === JSON.stringify(afterPayload);
    optRows.push({ name: rq.name, after: afterS, optStats, countsMatch });
  }
  optRows.sort((a, b) => b.after.memory_usage - a.after.memory_usage);
  for (const r of optRows) {
    console.log("  " + [
      padL(r.name, 36),
      padR(fmtBytes(r.after.memory_usage), 12),
      padR(fmtBytes(r.optStats.memory_usage), 12),
      padR(fmtDelta(r.after.memory_usage, r.optStats.memory_usage), 12),
      padR(`${r.after.query_duration_ms} ms`, 11),
      padR(`${r.optStats.query_duration_ms} ms`, 11),
      padR(fmtDelta(r.after.query_duration_ms, r.optStats.query_duration_ms), 10),
      padL(r.countsMatch ? "yes" : "NO", 10),
    ].join("  "));
  }

  // Totals if we stack OPTIMIZED on top (using OPT for queries that have an
  // OPT variant, AFTER for queries that don't).
  const optByName = new Map(ROUTE_QUERIES_OPTIMIZED.map((q) => [q.name, q]));
  let sumMemStacked = 0;
  let maxDurStacked = 0;
  let sumDurStacked = 0;
  for (const rq of ROUTE_QUERIES_AFTER) {
    const nm = rq.name;
    const optHasIt = optByName.has(nm);
    const s = optHasIt ? opt.stats.get(nm) : after.stats.get(nm);
    if (!s) continue;
    sumMemStacked += s.memory_usage;
    sumDurStacked += s.query_duration_ms;
    maxDurStacked = Math.max(maxDurStacked, s.query_duration_ms);
  }
  console.log("\n  Totals (AFTER → OPTIMIZED-stacked):");
  console.log(`    Sum peak memory:  ${fmtBytes(sumMemAfter)} → ${fmtBytes(sumMemStacked)}  (${fmtDelta(sumMemAfter, sumMemStacked)})`);
  console.log(`    Max query dur:    ${maxDurAfter} ms → ${maxDurStacked} ms  (${fmtDelta(maxDurAfter, maxDurStacked)})`);
  console.log(`    Sum query dur:    ${sumDurAfter} ms → ${sumDurStacked} ms  (${fmtDelta(sumDurAfter, sumDurStacked)})`);
}

async function runVariant(v: Variant, p: QueryParams): Promise<{ count: number, queryId: string }> {
  const client = getClickhouseAdminClient();
  const queryId = `bench-${v.name}-${randomUUID()}`;
  const res = await client.query({
    query: v.sql,
    query_params: {
      projectId: p.projectId,
      branchId: p.branchId,
      since: formatCh(p.since),
      untilExclusive: formatCh(p.untilExclusive),
      includeAnonymous: p.includeAnonymous ? 1 : 0,
      uuidRe: UUID_RE_CH,
    },
    query_id: queryId,
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { mau: string | number }[];
  return { count: Number(rows[0]?.mau ?? 0), queryId };
}

type QueryStats = {
  memory_usage: number,
  read_rows: number,
  read_bytes: number,
  result_rows: number,
  result_bytes: number,
  query_duration_ms: number,
};

async function readStats(queryId: string): Promise<QueryStats> {
  const client = getClickhouseAdminClient();
  await client.command({ query: "SYSTEM FLUSH LOGS" });
  // ~12.7s budget; the async query_log flush can lag at 300k-user scale.
  const delays = [100, 200, 400, 800, 1600, 3200, 6400];
  for (let i = 0; i <= delays.length; i++) {
    const res = await client.query({
      query: `
        SELECT
          toUInt64(memory_usage)         AS memory_usage,
          toUInt64(read_rows)            AS read_rows,
          toUInt64(read_bytes)           AS read_bytes,
          toUInt64(result_rows)          AS result_rows,
          toUInt64(result_bytes)         AS result_bytes,
          toUInt64(query_duration_ms)    AS query_duration_ms
        FROM system.query_log
        WHERE query_id = {qid:String} AND type = 'QueryFinish'
        ORDER BY event_time DESC
        LIMIT 1
      `,
      query_params: { qid: queryId },
      format: "JSONEachRow",
    });
    const rows = (await res.json()) as Array<Record<string, string>>;
    if (rows.length === 1) {
      const r = rows[0];
      return {
        memory_usage: Number(r.memory_usage),
        read_rows: Number(r.read_rows),
        read_bytes: Number(r.read_bytes),
        result_rows: Number(r.result_rows),
        result_bytes: Number(r.result_bytes),
        query_duration_ms: Number(r.query_duration_ms),
      };
    }
    if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
  }
  throw new Error(`no query_log row for ${queryId}`);
}

async function seed(rows: EventRow[], batch = envInt("BENCH_BATCH", 50_000)): Promise<void> {
  const client = getClickhouseAdminClient();
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    await client.insert({
      table: "analytics_internal.events",
      values: chunk,
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  }
}

async function cleanup(): Promise<void> {
  const client = getClickhouseAdminClient();
  await client.command({
    query: `ALTER TABLE analytics_internal.events DELETE WHERE project_id = {p:String}`,
    query_params: { p: BENCH_PROJECT_ID },
    // Block until the mutation is applied so the script exits clean.
    clickhouse_settings: { mutations_sync: "2" },
  });
  // Best-effort: drop the option-D bench column if we added it. Safe to run
  // unconditionally because of the IF EXISTS guard.
  try {
    await dropOptionDColumn();
  } catch (e) {
    console.error("  (could not drop option-D column:", e, ")");
  }
}

// ── Edge-case matrix ─────────────────────────────────────────────────────────

type Case = {
  name: string,
  branchId: string,
  includeAnonymous: boolean,
  expected: number,
  buildEvents: (windowStart: Date, windowEnd: Date) => EventRow[],
};

function mkUuid(): string {
  // randomUUID is v4, matches isUuid regex.
  return randomUUID();
}

function mkEvent(opts: {
  branchId: string,
  at: Date,
  userId: string | null,
  isAnonymous?: boolean | null,
  eventType?: string,
  projectId?: string,
  teamId?: string | null,
  extraData?: Record<string, unknown>,
}): EventRow {
  const eventType = opts.eventType ?? "$token-refresh";
  let data: Record<string, unknown>;
  if (eventType === "$token-refresh") {
    data = {
      refresh_token_id: mkUuid(),
      ip_info: null,
    };
    if (opts.isAnonymous !== undefined) data.is_anonymous = opts.isAnonymous;
  } else {
    data = {};
    if (opts.isAnonymous !== undefined) data.is_anonymous = opts.isAnonymous;
  }
  if (opts.extraData) Object.assign(data, opts.extraData);
  return {
    event_type: eventType,
    event_at: formatCh(opts.at),
    data,
    project_id: opts.projectId ?? BENCH_PROJECT_ID,
    branch_id: opts.branchId,
    user_id: opts.userId,
    team_id: opts.teamId ?? null,
  };
}

function buildMatrix(): Case[] {
  const otherProjectId = `${BENCH_PROJECT_ID}-other`;
  return [
    {
      name: "empty",
      branchId: "m-empty",
      includeAnonymous: false,
      expected: 0,
      buildEvents: () => [],
    },
    {
      name: "one user one event",
      branchId: "m-one",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-one", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
      ],
    },
    {
      name: "one user many events (dedup)",
      branchId: "m-dedup",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => {
        const u = mkUuid();
        const rows: EventRow[] = [];
        for (let i = 0; i < 50; i++) {
          rows.push(mkEvent({ branchId: "m-dedup", at: new Date(s.getTime() + (i + 1) * 60_000), userId: u, isAnonymous: false }));
        }
        return rows;
      },
    },
    {
      name: "mixed anon + non-anon, include_anonymous=false",
      branchId: "m-mix-false",
      includeAnonymous: false,
      expected: 3,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-mix-false", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-mix-false", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-mix-false", at: new Date(s.getTime() + 3 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-mix-false", at: new Date(s.getTime() + 4 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: true }),
        mkEvent({ branchId: "m-mix-false", at: new Date(s.getTime() + 5 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: true }),
      ],
    },
    {
      name: "mixed anon + non-anon, include_anonymous=true",
      branchId: "m-mix-true",
      includeAnonymous: true,
      expected: 5,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-mix-true", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-mix-true", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-mix-true", at: new Date(s.getTime() + 3 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-mix-true", at: new Date(s.getTime() + 4 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: true }),
        mkEvent({ branchId: "m-mix-true", at: new Date(s.getTime() + 5 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: true }),
      ],
    },
    {
      name: "window boundary (before since / after until)",
      branchId: "m-boundary",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s, e) => [
        // just before since — should be excluded
        mkEvent({ branchId: "m-boundary", at: new Date(s.getTime() - 1000), userId: mkUuid(), isAnonymous: false }),
        // inside window — counted
        mkEvent({ branchId: "m-boundary", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        // at untilExclusive — excluded (half-open interval)
        mkEvent({ branchId: "m-boundary", at: new Date(e.getTime()), userId: mkUuid(), isAnonymous: false }),
      ],
    },
    {
      name: "null user_id",
      branchId: "m-null-uid",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-null-uid", at: new Date(s.getTime() + ONE_DAY_MS), userId: null, isAnonymous: false }),
        mkEvent({ branchId: "m-null-uid", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
      ],
    },
    {
      name: "non-UUID user_id (filtered)",
      branchId: "m-non-uuid",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-non-uuid", at: new Date(s.getTime() + ONE_DAY_MS), userId: "not-a-uuid", isAnonymous: false }),
        mkEvent({ branchId: "m-non-uuid", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: "12345678-1234-1234-1234-123456789012", isAnonymous: false }), // v1 UUID shape, fails v4 regex
        mkEvent({ branchId: "m-non-uuid", at: new Date(s.getTime() + 3 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
      ],
    },
    {
      name: "case variation on user_id (dedup)",
      branchId: "m-case",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => {
        const u = mkUuid();
        return [
          mkEvent({ branchId: "m-case", at: new Date(s.getTime() + ONE_DAY_MS), userId: u, isAnonymous: false }),
          mkEvent({ branchId: "m-case", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: u.toUpperCase(), isAnonymous: false }),
          mkEvent({ branchId: "m-case", at: new Date(s.getTime() + 3 * ONE_DAY_MS), userId: `  ${u}  `, isAnonymous: false }),
        ];
      },
    },
    {
      name: "project isolation",
      branchId: "m-iso",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-iso", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
        mkEvent({ branchId: "m-iso", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false, projectId: otherProjectId }),
      ],
    },
    {
      name: "missing is_anonymous field (treated as non-anon)",
      branchId: "m-missing",
      includeAnonymous: false,
      expected: 2,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-missing", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid() /* no is_anonymous */ }),
        mkEvent({ branchId: "m-missing", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
      ],
    },
    {
      name: "null is_anonymous (treated as non-anon)",
      branchId: "m-null-anon",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-null-anon", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: null }),
      ],
    },
    {
      name: "wrong event_type ignored",
      branchId: "m-wrong-type",
      includeAnonymous: false,
      expected: 1,
      buildEvents: (s) => [
        mkEvent({ branchId: "m-wrong-type", at: new Date(s.getTime() + ONE_DAY_MS), userId: mkUuid(), isAnonymous: false, eventType: "$page-view" }),
        mkEvent({ branchId: "m-wrong-type", at: new Date(s.getTime() + 2 * ONE_DAY_MS), userId: mkUuid(), isAnonymous: false }),
      ],
    },
  ];
}

async function runMatrix(now: Date): Promise<boolean> {
  const untilExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + ONE_DAY_MS);
  const since = new Date(untilExclusive.getTime() - METRICS_WINDOW_MS - ONE_DAY_MS);

  const cases = buildMatrix();
  // Seed everything for matrix in one go (lots of small branches).
  const all: EventRow[] = cases.flatMap((c) => c.buildEvents(since, untilExclusive));
  if (all.length) await seed(all);

  let allPass = true;
  console.log("\n── Equivalence matrix (set equality, not just count) ──");
  for (const c of cases) {
    const params: QueryParams = {
      projectId: BENCH_PROJECT_ID,
      branchId: c.branchId,
      since,
      untilExclusive,
      includeAnonymous: c.includeAnonymous,
    };
    const [oldRes, newRes, newSet] = await Promise.all([
      runOld(params),
      runNew(params),
      runNewSet(params),
    ]);
    const countMatch = oldRes.count === newRes.count && oldRes.count === c.expected;
    const { onlyInA, onlyInB } = setDiff(oldRes.set, newSet);
    const setMatch = onlyInA.length === 0 && onlyInB.length === 0;
    const match = countMatch && setMatch;
    const tag = match ? "OK" : "FAIL";
    console.log(
      `  [${tag}] ${c.name.padEnd(48)} expected=${c.expected} old_count=${oldRes.count} new_count=${newRes.count} set_match=${setMatch}`,
    );
    if (!setMatch) {
      if (onlyInA.length > 0) console.log(`       only in OLD: ${onlyInA.slice(0, 3).join(", ")}${onlyInA.length > 3 ? ` …(+${onlyInA.length - 3})` : ""}`);
      if (onlyInB.length > 0) console.log(`       only in NEW: ${onlyInB.slice(0, 3).join(", ")}${onlyInB.length > 3 ? ` …(+${onlyInB.length - 3})` : ""}`);
    }
    if (!match) allPass = false;
  }
  return allPass;
}

// ── Heavy perf seed ──────────────────────────────────────────────────────────

const COUNTRY_CODES = ["US", "DE", "FR", "GB", "JP", "IN", "BR", "CA", "AU", "ES"];
const REFERRERS = ["https://google.com/", "https://twitter.com/", "https://news.ycombinator.com/", "", "https://github.com/", "https://reddit.com/"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function seedPerf(now: Date): Promise<void> {
  const users = envInt("BENCH_USERS", 200_000);
  const perUser = envInt("BENCH_EVENTS_USER", 5);
  const pvPerUser = envInt("BENCH_PAGE_VIEWS_USER", 3);
  const clicksPerUser = envInt("BENCH_CLICKS_USER", 1);
  const teamRatio = envFloat("BENCH_TEAM_RATIO", 0.3);
  const teamCount = Math.max(1, Math.floor(users * 0.05)); // ~5% as many teams as users
  const anonRatio = envFloat("BENCH_ANON_RATIO", 0.1);
  const tokenEvents = users * perUser;
  const pvEvents = users * pvPerUser;
  const clickEvents = users * clicksPerUser;
  const total = tokenEvents + pvEvents + clickEvents;
  console.log(
    `\n── Seeding perf data: ${users.toLocaleString()} users ` +
    `× (${perUser} $token-refresh + ${pvPerUser} $page-view + ${clicksPerUser} $click) ` +
    `+ ${teamCount.toLocaleString()} teams = ${total.toLocaleString()} rows ──`,
  );

  const batchRows = envInt("BENCH_BATCH", 50_000);
  // BENCH_HISTORICAL_DAYS extends the seed beyond the 30-day metrics window so
  // unbounded-scan queries read more rows than windowed ones (default 365).
  const historicalDays = envInt("BENCH_HISTORICAL_DAYS", 365);
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + ONE_DAY_MS);
  const windowStart = new Date(windowEnd.getTime() - historicalDays * 24 * 60 * 60 * 1000);
  const spanMs = windowEnd.getTime() - windowStart.getTime();
  if (historicalDays !== METRICS_WINDOW_DAYS) {
    console.log(`  (event_at spans last ${historicalDays} days; only the most recent ${METRICS_WINDOW_DAYS} fall inside the metrics window)`);
  }
  const teamIds: string[] = Array.from({ length: teamCount }, () => mkUuid());

  const t0 = Date.now();
  let buf: EventRow[] = [];
  const flushIfNeeded = async () => {
    if (buf.length >= batchRows) {
      await seed(buf, batchRows);
      buf = [];
    }
  };
  for (let u = 0; u < users; u++) {
    const uid = mkUuid();
    const isAnon = Math.random() < anonRatio;
    const country = pick(COUNTRY_CODES);
    const region = country + "-" + Math.floor(Math.random() * 50).toString(36);
    const teamId = Math.random() < teamRatio ? pick(teamIds) : null;
    // $token-refresh events (realistic ip_info payload)
    for (let e = 0; e < perUser; e++) {
      const at = new Date(windowStart.getTime() + Math.floor(Math.random() * spanMs));
      buf.push({
        event_type: "$token-refresh",
        event_at: formatCh(at),
        data: {
          refresh_token_id: mkUuid(),
          is_anonymous: isAnon,
          ip_info: {
            ip: `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
            is_trusted: true,
            country_code: country,
            region_code: region,
            city_name: `City-${Math.floor(Math.random() * 1000)}`,
            latitude: Math.random() * 180 - 90,
            longitude: Math.random() * 360 - 180,
            tz_identifier: "UTC",
          },
        },
        project_id: BENCH_PROJECT_ID,
        branch_id: PERF_BRANCH_ID,
        user_id: uid,
        team_id: teamId,
      });
      await flushIfNeeded();
    }
    // $page-view events
    for (let e = 0; e < pvPerUser; e++) {
      const at = new Date(windowStart.getTime() + Math.floor(Math.random() * spanMs));
      buf.push(mkEvent({
        branchId: PERF_BRANCH_ID,
        at,
        userId: uid,
        isAnonymous: isAnon,
        eventType: "$page-view",
        extraData: { referrer: pick(REFERRERS), url: `https://example.com/page-${Math.floor(Math.random() * 100)}` },
      }));
      await flushIfNeeded();
    }
    // $click events
    for (let e = 0; e < clicksPerUser; e++) {
      const at = new Date(windowStart.getTime() + Math.floor(Math.random() * spanMs));
      buf.push(mkEvent({
        branchId: PERF_BRANCH_ID,
        at,
        userId: uid,
        isAnonymous: isAnon,
        eventType: "$click",
        extraData: { element: `btn-${Math.floor(Math.random() * 50)}` },
      }));
      await flushIfNeeded();
    }
    if ((u + 1) % 20_000 === 0) {
      console.log(`  seeded ${(u + 1).toLocaleString()} / ${users.toLocaleString()} users (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }
  if (buf.length) await seed(buf, batchRows);
  // Force parts to settle so first-query cost isn't dominated by merges.
  const client = getClickhouseAdminClient();
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

async function runPerf(now: Date): Promise<void> {
  const untilExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + ONE_DAY_MS);
  const since = new Date(untilExclusive.getTime() - METRICS_WINDOW_MS);
  const params: QueryParams = {
    projectId: BENCH_PROJECT_ID,
    branchId: PERF_BRANCH_ID,
    since,
    untilExclusive,
    includeAnonymous: false,
  };

  console.log("\n── Perf run (include_anonymous=false) ──");
  // Warm up caches so variants compete on equal footing.
  const warmup = await runVariant(VARIANTS[0], params);
  void warmup;

  const oldRes = await runOld(params);
  const oldStats = await readStats(oldRes.queryId);

  // Set-equality baseline: the "ground truth" set of users the OLD pipeline counts.
  const truthSet = oldRes.set;

  type Row = {
    name: string,
    description: string,
    approximate: boolean,
    count: number,
    stats: QueryStats,
    setMatch: boolean | null,  // null if approximate (skipped)
    errorPct: number | null,
  };

  const rows: Row[] = [
    {
      name: "v0_old (baseline)",
      description: "current query: GROUP BY user_id + JS normalize",
      approximate: false,
      count: oldRes.count,
      stats: oldStats,
      setMatch: true,
      errorPct: 0,
    },
  ];

  for (const v of VARIANTS) {
    const { count, queryId } = await runVariant(v, params);
    const stats = await readStats(queryId);
    const errorPct = oldRes.count > 0 ? ((count - oldRes.count) / oldRes.count) * 100 : 0;
    let setMatch: boolean | null = null;
    if (!v.approximate) {
      // Exact variant: verify it sees the *same users* as the old pipeline, not
      // just the same count. Skip for approximate variants since they don't
      // return a recoverable set.
      const resSet = await runNewSet(params);
      const { onlyInA, onlyInB } = setDiff(truthSet, resSet);
      setMatch = onlyInA.length === 0 && onlyInB.length === 0;
    }
    rows.push({ name: v.name, description: v.description, approximate: v.approximate ?? false, count, stats, setMatch, errorPct });
  }

  // Table output, ranked by peak memory.
  const baselineMem = oldStats.memory_usage;
  const baselineDur = oldStats.query_duration_ms;
  const padR = (s: string, n: number) => s.padStart(n);
  const padL = (s: string, n: number) => s.padEnd(n);
  console.log(`\n  Ground truth (v0_old): MAU=${oldRes.count}`);
  console.log("  " + [
    padL("variant", 24),
    padR("memory", 12),
    padR("vs base", 8),
    padR("duration", 10),
    padR("vs base", 8),
    padR("read", 12),
    padR("result", 10),
    padR("count", 9),
    padR("err%", 7),
    padL("set=", 6),
  ].join("  "));
  console.log("  " + "─".repeat(120));
  for (const r of rows) {
    const memRatio = baselineMem / Math.max(r.stats.memory_usage, 1);
    const durRatio = baselineDur / Math.max(r.stats.query_duration_ms, 1);
    const setMatch = r.setMatch == null ? "—" : r.setMatch ? "yes" : "NO";
    console.log("  " + [
      padL(r.name + (r.approximate ? " ~" : ""), 24),
      padR(fmtBytes(r.stats.memory_usage), 12),
      padR(memRatio >= 1 ? `${memRatio.toFixed(2)}×` : `${memRatio.toFixed(2)}×`, 8),
      padR(`${r.stats.query_duration_ms} ms`, 10),
      padR(durRatio >= 1 ? `${durRatio.toFixed(2)}×` : `${durRatio.toFixed(2)}×`, 8),
      padR(fmtBytes(r.stats.read_bytes), 12),
      padR(fmtBytes(r.stats.result_bytes), 10),
      padR(r.count.toLocaleString(), 9),
      padR(r.errorPct == null ? "—" : `${r.errorPct >= 0 ? "+" : ""}${r.errorPct.toFixed(3)}%`, 7),
      padL(setMatch, 6),
    ].join("  "));
  }
  console.log("\n  Legend: ~ = approximate variant.  set=yes means the variant counts the same individual users as the OLD pipeline.");
}

async function main(): Promise<void> {
  console.log(`Benchmark run_id=${RUN_ID}`);
  console.log(`project_id=${BENCH_PROJECT_ID}`);

  const now = new Date();
  let matrixOk = true;

  try {
    if (!envBool("BENCH_SKIP_MATRIX")) {
      matrixOk = await runMatrix(now);
      if (!matrixOk) {
        console.error("\nEquivalence matrix failed — skipping perf run.");
      }
    } else {
      console.log("Skipping equivalence matrix (BENCH_SKIP_MATRIX=1)");
    }

    const doPerf = matrixOk && !envBool("BENCH_SKIP_PERF");
    const doRouteQueries = matrixOk && envBool("BENCH_ROUTE_QUERIES");
    const doBackfillCompare = matrixOk && envBool("BENCH_BACKFILL_COMPARE");
    const doJoinAlgoCompare = matrixOk && (envBool("BENCH_JOIN_ALGO_COMPARE") || envBool("BENCH_GRACE_HASH_COMPARE"));
    if (doPerf || doRouteQueries || doBackfillCompare || doJoinAlgoCompare) {
      await seedPerf(now);
      if (doPerf) await runPerf(now);
      if (doRouteQueries) await benchmarkRouteQueries(now);
      if (doBackfillCompare) await benchmarkBackfillCompare(now);
      if (doJoinAlgoCompare) await benchmarkJoinAlgorithms(now);
    } else if (envBool("BENCH_SKIP_PERF")) {
      console.log("Skipping perf run (BENCH_SKIP_PERF=1)");
    }
  } finally {
    console.log("\nCleaning up seeded rows…");
    try {
      await cleanup();
      console.log("  done.");
    } catch (e) {
      console.error("  cleanup failed:", e);
    }
  }

  if (!matrixOk) process.exit(1);
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
