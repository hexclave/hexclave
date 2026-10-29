// The ClickHouse side of the platform-analytics route, kept separate from the
// handler so the exact same query text can be executed by the route AND by the
// local bench harness (apps/backend/scripts/internal-analytics/bench-current-queries.ts)
// against a scratch database. Every query here runs under
// METRICS_CLICKHOUSE_SETTINGS (per-query max_memory_usage ≈ 488 MiB), so any
// change to a query should be re-checked with that harness at prod-like scale.
import type { ClickHouseClient } from "@/lib/clickhouse";
import { randomUUID } from "node:crypto";

export type ChQuerySpec<TRow> = {
  sql: string,
  params: Record<string, unknown>,
  // Phantom marker carrying the row type; never assigned at runtime.
  rowType?: TRow,
};

export type ChRowsOf<Q> = Q extends ChQuerySpec<infer TRow> ? TRow[] : never;

function chQuerySpec<TRow>(sql: string, params: Record<string, unknown>): ChQuerySpec<TRow> {
  return { sql, params };
}

// 1-in-N consistent user-level sampling for the new/retained/reactivated activity
// split, with counts scaled back up by N (~0.4% mean error at 1M users / 50M
// events). The bucket is on the user id, so each sampled user's full activity
// sequence is preserved and retention/reactivation stay unbiased. See
// scripts/internal-analytics/optimize-split.ts.
export const ACTIVITY_SPLIT_SAMPLE = 4;

export type CountRow = { projectId: string, c: string | number };
export type CurPrevRow = { projectId: string, cur: string | number, prev: string | number };
export type UsersByProjectRow = { projectId: string, total: string | number, totalPrev: string | number, verified: string | number, verifiedPrev: string | number, anonymous: string | number };

export type PlatformAnalyticsWindow = {
  branchId: string,
  internalProjectId: string,
  // ClickHouse DateTime params ("YYYY-MM-DDTHH:MM:SS", UTC).
  since: string,
  priorSince: string,
  mid: string,
  until: string,
};

export function buildPlatformAnalyticsClickhouseQueries(db: string, w: PlatformAnalyticsWindow) {
  const { branchId, internalProjectId } = w;
  const userScope = `branch_id = {branchId:String} AND sync_is_deleted = 0`;
  const customerUserScope = `${userScope} AND project_id != {internalProjectId:String}`;
  const customerEventScope = `project_id != {internalProjectId:String}`;
  const baseParams = { branchId, internalProjectId };
  const windowParams = { branchId, internalProjectId, since: w.since, until: w.until };
  const twoWindowParams = { branchId, internalProjectId, priorSince: w.priorSince, mid: w.mid, until: w.until };

  // Memory model for this route (measured with scripts/internal-analytics/bench-current-queries.ts,
  // 10k projects / 1M users x4 row versions / 50M events, per-query cap ~488 MiB):
  //
  //  * A GROUP BY with FEW keys but LARGE states (uniqExact per day / per project) cannot be
  //    split across external-aggregation buckets, so it keeps all of it in memory no matter
  //    what (~390 MiB for the platform DAU series alone) and grows with traffic.
  //  * `FINAL` over a platform-wide ReplacingMergeTree opens every part of a partition at
  //    once; each open part costs ~1 MiB per column read, so memory grows with part count
  //    (~250 MiB at ~40 parts/partition) before a single row is aggregated.
  //  * A GROUP BY with MANY keys and SMALL states goes two-level, and with
  //    max_bytes_before_external_group_by it spills bucket-by-bucket to disk and merges the
  //    buckets back one at a time. Its peak is bounded by the spill threshold (plus one
  //    partial table per thread) regardless of data size.
  //
  // So every heavy query below is written as the third shape: distinct counts are
  // `GROUP BY <keys>, user_hash` followed by `count()`, and ReplacingMergeTree dedup is
  // `GROUP BY project_id, id` + `argMax(col, sync_sequence_id)` instead of FINAL (same
  // result: FINAL keeps the row with the highest version). The settings keep the bound
  // well under the cap: 2 threads => at most 2 partial tables, spilling at 128 MB.
  const heavyGroupBySettings = "SETTINGS max_threads = 2, max_bytes_before_external_group_by = 128000000";
  // Hashing the user id (instead of grouping by the 36-char uuid string) is a deliberate
  // accuracy-for-memory tradeoff: a 64-bit collision is negligible for this internal KPI.
  const userHash = "sipHash64(assumeNotNull(user_id))";
  const tokenRefreshScope = `event_type = '$token-refresh' AND user_id IS NOT NULL AND ${customerEventScope}`;
  // Small window-pruned FINAL reads (a month or two of partitions) stay on FINAL; the
  // low-parallelism settings avoid buffering one large block per reader.
  const finalQuerySettings = "SETTINGS max_threads = 1, max_final_threads = 1, max_block_size = 1024";
  const liveRowsByProject = (table: string, rowKey: string) => `
    SELECT project_id AS projectId, countIf(is_deleted = 0) AS c
    FROM (
      SELECT project_id, argMax(sync_is_deleted, sync_sequence_id) AS is_deleted
      FROM ${db}.${table}
      WHERE branch_id = {branchId:String} AND project_id != {internalProjectId:String}
      GROUP BY project_id, ${rowKey}
    )
    GROUP BY project_id
    ${heavyGroupBySettings}
  `;

  return {
    // Platform daily DAU (active users) over the visible window.
    dauSeries: chQuerySpec<{ day: string, c: string | number }>(`
      SELECT day, count() AS c
      FROM (
        SELECT toDate(event_at) AS day, ${userHash} AS u
        FROM ${db}.events
        WHERE ${tokenRefreshScope}
          AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
        GROUP BY day, u
      )
      GROUP BY day ORDER BY day ASC
      ${heavyGroupBySettings}
    `, windowParams),
    // Page views + unique visitors per day.
    pvSeries: chQuerySpec<{ day: string, pv: string | number, visitors: string | number }>(`
      SELECT day, sum(user_pv) AS pv, countIf(user_pv > 0) AS visitors
      FROM (
        SELECT toDate(event_at) AS day, ${userHash} AS u, countIf(event_type = '$page-view') AS user_pv
        FROM ${db}.events
        WHERE event_type IN ('$page-view', '$click')
          AND ${customerEventScope}
          AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
        GROUP BY day, u
      )
      GROUP BY day ORDER BY day ASC
      ${heavyGroupBySettings}
    `, windowParams),
    // Signups per day (users table).
    signupSeries: chQuerySpec<{ day: string, c: string | number }>(`
      SELECT toDate(signed_up_at, 'UTC') AS day, count() AS c
      FROM ${db}.users FINAL
      WHERE ${customerUserScope} AND is_anonymous = 0
        AND signed_up_at >= {since:DateTime} AND signed_up_at < {until:DateTime}
      GROUP BY day ORDER BY day ASC
      ${finalQuerySettings}
    `, windowParams),
    // MAU + active projects, current vs prior 30d window (single pass over 60d).
    // User ids are per project, so (project_id, user_hash) is the natural distinct key.
    mauProjects: chQuerySpec<{ mauCur: string | number, mauPrev: string | number, projCur: string | number, projPrev: string | number }>(`
      SELECT
        countIf(cur) AS mauCur,
        countIf(prev) AS mauPrev,
        uniqExactIf(project_id, cur) AS projCur,
        uniqExactIf(project_id, prev) AS projPrev
      FROM (
        SELECT project_id, ${userHash} AS u,
          max(event_at >= {mid:DateTime}) AS cur,
          max(event_at < {mid:DateTime}) AS prev
        FROM ${db}.events
        WHERE ${tokenRefreshScope}
          AND event_at >= {priorSince:DateTime} AND event_at < {until:DateTime}
        GROUP BY project_id, u
      )
      ${heavyGroupBySettings}
    `, twoWindowParams),
    // Per-project user stock: total / verified (now + as-of window start) and anonymous,
    // over the latest version of every user row. Platform totals are the sum over rows.
    // "Verified" = has a verified EMAIL contact channel (latest version, not deleted).
    usersByProject: chQuerySpec<UsersByProjectRow>(`
      WITH verified_users AS (
        SELECT cityHash64(project_id, user_id) AS h
        FROM (
          SELECT project_id, any(user_id) AS user_id,
            argMax(is_verified, sync_sequence_id) AS is_verified,
            argMax(sync_is_deleted, sync_sequence_id) AS is_deleted
          FROM ${db}.contact_channels
          WHERE branch_id = {branchId:String} AND type = 'EMAIL' AND project_id != {internalProjectId:String}
          GROUP BY project_id, id
        )
        WHERE is_verified = 1 AND is_deleted = 0
      )
      SELECT project_id AS projectId,
        countIf(is_anonymous = 0) AS total,
        countIf(is_anonymous = 0 AND signed_up_at < {mid:DateTime}) AS totalPrev,
        countIf(is_anonymous = 0 AND cityHash64(project_id, id) IN verified_users) AS verified,
        countIf(is_anonymous = 0 AND signed_up_at < {mid:DateTime} AND cityHash64(project_id, id) IN verified_users) AS verifiedPrev,
        countIf(is_anonymous = 1) AS anonymous
      FROM (
        SELECT project_id, id,
          argMax(sync_is_deleted, sync_sequence_id) AS is_deleted,
          argMax(is_anonymous, sync_sequence_id) AS is_anonymous,
          argMax(signed_up_at, sync_sequence_id) AS signed_up_at
        FROM ${db}.users
        WHERE branch_id = {branchId:String} AND project_id != {internalProjectId:String}
        GROUP BY project_id, id
      )
      WHERE is_deleted = 0
      GROUP BY project_id
      ${heavyGroupBySettings}
    `, { branchId, internalProjectId, mid: w.mid }),
    // Users by country (for the globe) over the window.
    country: chQuerySpec<{ country_code: string, c: string | number }>(`
      SELECT country_code, count() AS c FROM (
        SELECT argMax(cc, event_at) AS country_code FROM (
          SELECT ${userHash} AS user_hash, event_at, CAST(data.ip_info.country_code, 'Nullable(String)') AS cc
          FROM ${db}.events
          WHERE ${tokenRefreshScope}
            AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
        ) WHERE cc IS NOT NULL GROUP BY user_hash
      ) WHERE country_code IS NOT NULL GROUP BY country_code ORDER BY c DESC
      ${heavyGroupBySettings}
    `, windowParams),
    // Dead-click health over the window.
    deadClicks: chQuerySpec<{ clicks: string | number, dead: string | number }>(`
      SELECT count() AS clicks, sum(is_dead) AS dead
      FROM ${db}.clickmap_events
      WHERE ${customerEventScope}
        AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
    `, windowParams),
    // New / retained / reactivated split across all projects. One pass over each sampled
    // user's history: first_date from all time, the sorted set of active days inside the
    // window, then each day is paired with the previous active day (epoch 0 for none) —
    // no JOIN and no window function, so it is a single many-key GROUP BY.
    split: chQuerySpec<{ day: string, total_count: string, new_count: string, retained_count: string, reactivated_count: string }>(`
      SELECT
        toString(d) AS day,
        count() * ${ACTIVITY_SPLIT_SAMPLE} AS total_count,
        countIf(first_date = d) * ${ACTIVITY_SPLIT_SAMPLE} AS new_count,
        countIf(first_date < d AND prev_d = d - 1) * ${ACTIVITY_SPLIT_SAMPLE} AS retained_count,
        countIf(first_date < d AND prev_d < d - 1) * ${ACTIVITY_SPLIT_SAMPLE} AS reactivated_count
      FROM (
        SELECT first_date,
          arrayJoin(arrayZip(days, arrayPushFront(arrayPopBack(days), toDate(0)))) AS day_pair,
          day_pair.1 AS d, day_pair.2 AS prev_d
        FROM (
          SELECT toDate(min(event_at)) AS first_date,
            arraySort(groupUniqArrayIf(toDate(event_at), event_at >= {since:DateTime})) AS days
          FROM ${db}.events
          WHERE ${tokenRefreshScope}
            AND cityHash64(assumeNotNull(user_id)) % ${ACTIVITY_SPLIT_SAMPLE} = 0
            AND event_at < {until:DateTime}
            AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0
          GROUP BY ${userHash}
        )
        WHERE notEmpty(days)
      )
      GROUP BY d ORDER BY d ASC
      ${heavyGroupBySettings}
    `, windowParams),
    // Per-project signups, current vs prior window.
    signupsByProject: chQuerySpec<CurPrevRow>(`
      SELECT project_id AS projectId,
        countIf(signed_up_at >= {mid:DateTime}) AS cur,
        countIf(signed_up_at < {mid:DateTime}) AS prev
      FROM ${db}.users FINAL
      WHERE ${customerUserScope} AND is_anonymous = 0
        AND signed_up_at >= {priorSince:DateTime} AND signed_up_at < {until:DateTime}
      GROUP BY project_id
      ${finalQuerySettings}
    `, twoWindowParams),
    // Per-project active users, current vs prior window.
    activeByProject: chQuerySpec<CurPrevRow>(`
      SELECT project_id AS projectId, countIf(cur) AS cur, countIf(prev) AS prev
      FROM (
        SELECT project_id, ${userHash} AS u,
          max(event_at >= {mid:DateTime}) AS cur,
          max(event_at < {mid:DateTime}) AS prev
        FROM ${db}.events
        WHERE ${tokenRefreshScope}
          AND event_at >= {priorSince:DateTime} AND event_at < {until:DateTime}
        GROUP BY project_id, u
      )
      GROUP BY project_id
      ${heavyGroupBySettings}
    `, twoWindowParams),
    // Per-project daily active sparkline (visible window).
    sparkByProject: chQuerySpec<{ projectId: string, day: string, c: string | number }>(`
      SELECT project_id AS projectId, day, count() AS c
      FROM (
        SELECT project_id, toDate(event_at) AS day, ${userHash} AS u
        FROM ${db}.events
        WHERE ${tokenRefreshScope}
          AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
        GROUP BY project_id, day, u
      )
      GROUP BY project_id, day
      ${heavyGroupBySettings}
    `, windowParams),
    // Feature adoption signals (per project) from synced CH tables.
    // Feature adoption: projects with at least one live row in the synced table. The
    // dedup key of each ReplacingMergeTree is its ORDER BY key, so that is what we group by.
    teamsByProject: chQuerySpec<CountRow>(liveRowsByProject("teams", "id"), baseParams),
    oauthByProject: chQuerySpec<CountRow>(liveRowsByProject("connected_accounts", "user_id, provider, provider_account_id"), baseParams),
    emailsByProject: chQuerySpec<CountRow>(liveRowsByProject("email_outboxes", "id"), baseParams),
    analyticsByProject: chQuerySpec<CountRow>(
      `SELECT project_id AS projectId, count() AS c FROM ${db}.events WHERE event_type = '$page-view' AND branch_id = {branchId:String} AND ${customerEventScope} GROUP BY project_id`,
      baseParams,
    ),
  };
}

export type PlatformAnalyticsClickhouseQueries = ReturnType<typeof buildPlatformAnalyticsClickhouseQueries>;
export type PlatformAnalyticsClickhouseQueryName = keyof PlatformAnalyticsClickhouseQueries;
export type PlatformAnalyticsClickhouseResults = { [K in PlatformAnalyticsClickhouseQueryName]: ChRowsOf<PlatformAnalyticsClickhouseQueries[K]> };

export const CLICKHOUSE_ANALYTICS_DB = "analytics_internal";

// Wraps a ClickHouse failure with the name of the query that produced it. The
// server-side error alone (e.g. MEMORY_LIMIT_EXCEEDED) does not say which of
// the ~17 concurrent queries failed, which is what you need to know to fix it.
export class PlatformAnalyticsClickhouseQueryError extends Error {
  constructor(
    public readonly queryName: PlatformAnalyticsClickhouseQueryName,
    public readonly queryId: string,
    cause: unknown,
  ) {
    super(`ClickHouse query "${queryName}" (query_id ${queryId}) failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PlatformAnalyticsClickhouseQueryError";
  }
}

export function platformAnalyticsQueryId(name: PlatformAnalyticsClickhouseQueryName): string {
  // The name prefix makes the row easy to find in system.query_log.
  return `platform-analytics.${name}.${randomUUID()}`;
}

export async function runClickhouseQuerySpec<TRow>(
  clickhouse: ClickHouseClient,
  name: PlatformAnalyticsClickhouseQueryName,
  spec: ChQuerySpec<TRow>,
): Promise<TRow[]> {
  const queryId = platformAnalyticsQueryId(name);
  try {
    const result = await clickhouse.query({ query: spec.sql, query_params: spec.params, query_id: queryId, format: "JSONEachRow" });
    return await result.json<TRow>();
  } catch (cause) {
    throw new PlatformAnalyticsClickhouseQueryError(name, queryId, cause);
  }
}

// Runs every query concurrently, exactly like the route always has. Written out
// per key (rather than a generic Object.keys loop) so the per-query row types
// survive without casts.
export async function runPlatformAnalyticsClickhouseQueries(
  clickhouse: ClickHouseClient,
  q: PlatformAnalyticsClickhouseQueries,
): Promise<PlatformAnalyticsClickhouseResults> {
  const [
    dauSeries, pvSeries, signupSeries, mauProjects, usersByProject, country, deadClicks, split,
    signupsByProject, activeByProject, sparkByProject,
    teamsByProject, oauthByProject, emailsByProject, analyticsByProject,
  ] = await Promise.all([
    runClickhouseQuerySpec(clickhouse, "dauSeries", q.dauSeries),
    runClickhouseQuerySpec(clickhouse, "pvSeries", q.pvSeries),
    runClickhouseQuerySpec(clickhouse, "signupSeries", q.signupSeries),
    runClickhouseQuerySpec(clickhouse, "mauProjects", q.mauProjects),
    runClickhouseQuerySpec(clickhouse, "usersByProject", q.usersByProject),
    runClickhouseQuerySpec(clickhouse, "country", q.country),
    runClickhouseQuerySpec(clickhouse, "deadClicks", q.deadClicks),
    runClickhouseQuerySpec(clickhouse, "split", q.split),
    runClickhouseQuerySpec(clickhouse, "signupsByProject", q.signupsByProject),
    runClickhouseQuerySpec(clickhouse, "activeByProject", q.activeByProject),
    runClickhouseQuerySpec(clickhouse, "sparkByProject", q.sparkByProject),
    runClickhouseQuerySpec(clickhouse, "teamsByProject", q.teamsByProject),
    runClickhouseQuerySpec(clickhouse, "oauthByProject", q.oauthByProject),
    runClickhouseQuerySpec(clickhouse, "emailsByProject", q.emailsByProject),
    runClickhouseQuerySpec(clickhouse, "analyticsByProject", q.analyticsByProject),
  ]);
  return {
    dauSeries, pvSeries, signupSeries, mauProjects, usersByProject, country, deadClicks, split,
    signupsByProject, activeByProject, sparkByProject,
    teamsByProject, oauthByProject, emailsByProject, analyticsByProject,
  };
}
