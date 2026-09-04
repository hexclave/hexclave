import { Prisma } from "@/generated/prisma/client";
import { EmailOutboxSimpleStatus } from "@/generated/prisma/enums";
import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { ClickHouseError } from "@clickhouse/client";
import { ActivitySplit } from "@/lib/metrics-activity-split";
import { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, sqlQuoteIdent } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import {
  type MetricsDataPoint,
  type MetricsRecentUser,
  MetricsActiveUsersByCountrySchema,
  MetricsAnalyticsOverviewSchema,
  MetricsAuthOverviewSchema,
  MetricsDataPointsSchema as DataPointsSchema,
  MetricsEmailOverviewSchema,
  MetricsLoginMethodEntrySchema,
  MetricsPaymentsOverviewSchema,
  MetricsRecentUserSchema,
} from "@hexclave/shared/dist/interface/admin-metrics";
import { captureError, HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { userFullInclude, userPrismaToCrud, usersCrudHandlers } from "../../users/crud";

type DataPoints = MetricsDataPoint[];

const MAX_USERS_FOR_COUNTRY_SAMPLE = 10_000;
export const METRICS_WINDOW_DAYS = 30;
const METRICS_WINDOW_MS = METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const METRICS_REVENUE_INVOICE_STATUSES = ["paid", "succeeded"] as const;
const METRICS_REVENUE_INVOICE_STATUSES_SQL = Prisma.raw(
  METRICS_REVENUE_INVOICE_STATUSES.map((status) => `'${status}'`).join(", "),
);
const METRICS_REVENUE_INVOICE_STATUS_SET = new Set<string>(METRICS_REVENUE_INVOICE_STATUSES);

export function isMetricsRevenueInvoiceStatus(status: string | null | undefined): boolean {
  return status != null && METRICS_REVENUE_INVOICE_STATUS_SET.has(status);
}

export function getMetricsWindowBounds(now: Date): {
  todayUtc: Date,
  since: Date,
  untilExclusive: Date,
} {
  const todayUtc = new Date(now);
  todayUtc.setUTCHours(0, 0, 0, 0);
  return {
    todayUtc,
    since: new Date(todayUtc.getTime() - METRICS_WINDOW_MS),
    untilExclusive: new Date(todayUtc.getTime() + ONE_DAY_MS),
  };
}

function formatClickhouseDateTimeParam(date: Date): string {
  // ClickHouse DateTime params are passed as "YYYY-MM-DDTHH:MM:SS" (no timezone); treat them as UTC.
  return date.toISOString().slice(0, 19);
}

// UUID v4 — same rule as isUuid() in stack-shared; JS RegExp for normalizing event `user_id` strings.
const UUID_V4_JS_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeUuidFromEvent(value: string): string | null {
  const n = value.trim().toLowerCase();
  return UUID_V4_JS_RE.test(n) ? n : null;
}

function parseEmailOutboxSimpleStatus(value: string): EmailOutboxSimpleStatus | null {
  return Object.values(EmailOutboxSimpleStatus).find((status) => status === value) ?? null;
}

// ClickHouse `match()` uses re2; pattern matches UUID_V4_JS_RE.source.
const MAU_UUID_V4_REGEX = UUID_V4_JS_RE.source;

async function loadUsersByCountry(tenancy: Tenancy, now: Date, includeAnonymous: boolean = false): Promise<Record<string, number>> {
  // Without the 30-day bound the inner GROUP BY materializes one row per
  // ever-seen user for the tenant.
  const { since, untilExclusive } = getMetricsWindowBounds(now);
  const clickhouseClient = getClickhouseAdminClientForMetrics();
  const res = await clickhouseClient.query({
    query: `
      SELECT
        country_code,
        count() AS userCount
      FROM (
        -- Only the per-country counts leave this query, so the per-user group
        -- key can be a hash: one row per distinct user costs 8 bytes instead of
        -- a 36-char uuid, which is what kept this within the metrics memory
        -- limit on projects with hundreds of thousands of monthly users.
        SELECT
          argMax(cc, event_at) AS country_code
        FROM (
          SELECT
            sipHash64(user_id) AS user_hash,
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
        GROUP BY user_hash
      )
      WHERE country_code IS NOT NULL
      GROUP BY country_code
      ORDER BY userCount DESC
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      includeAnonymous: includeAnonymous ? 1 : 0,
      since: formatClickhouseDateTimeParam(since),
      untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
    },
    format: "JSONEachRow",
  });
  const rows: { country_code: string, userCount: number }[] = await res.json();

  return Object.fromEntries(
    rows.map(({ userCount, country_code }) => {
      if (!country_code) {
        return null;
      }
      const count = Number(userCount);
      return [country_code, count] as [string, number];
    })
      .filter((entry): entry is [string, number] => entry !== null)
  );
}

// Max live users returned per country. Small enough to keep the Postgres join
// cheap, large enough for the dashboard globe and satellite bubbles to pick a
// few distinct avatars per country.
const ACTIVE_USERS_BY_COUNTRY_LIMIT = 8;
// "Live" window used to classify users as currently active for the globe
// ping layer. Token-refresh fires every few minutes for each open session,
// so a 2-minute window gives a genuine "who's online right now" read while
// still being wide enough to catch the polling jitter.
const ACTIVE_USERS_BY_COUNTRY_WINDOW_MS = 2 * 60 * 1000;

async function loadActiveUsersByCountry(
  tenancy: Tenancy,
  now: Date,
  includeAnonymous: boolean = false,
): Promise<Record<string, MetricsRecentUser[]>> {
  const since = new Date(now.getTime() - ACTIVE_USERS_BY_COUNTRY_WINDOW_MS);

  const clickhouseClient = getClickhouseAdminClientForMetrics();
  const res = await clickhouseClient.query({
    query: `
      SELECT
        country_code,
        groupArray(user_id) AS user_ids
      FROM (
        SELECT
          country_code,
          user_id
        FROM (
          SELECT
            country_code,
            user_id,
            row_number() OVER (
              PARTITION BY country_code
              ORDER BY last_event_at DESC, user_id ASC
            ) AS country_rank
          FROM (
            SELECT
              user_id,
              argMax(cc, event_at) AS country_code,
              max(event_at) AS last_event_at
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
            )
            WHERE cc IS NOT NULL
              AND ({includeAnonymous:UInt8} = 1 OR is_anonymous = 0)
            GROUP BY user_id
          )
          WHERE country_code IS NOT NULL
        )
        WHERE country_rank <= {limit:UInt32}
        ORDER BY country_code ASC, country_rank ASC
      )
      WHERE country_code IS NOT NULL
      GROUP BY country_code
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      includeAnonymous: includeAnonymous ? 1 : 0,
      since: formatClickhouseDateTimeParam(since),
      limit: ACTIVE_USERS_BY_COUNTRY_LIMIT,
    },
    format: "JSONEachRow",
  });
  const rows: { country_code: string, user_ids: string[] }[] = await res.json();

  // Collect every selected UUID once so we only hit Postgres with a single
  // `IN (...)` lookup, then re-attach them to their country buckets.
  const allIds = new Set<string>();
  const countryToIds = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.country_code) continue;
    const normalizedIds: string[] = [];
    for (const rawId of row.user_ids) {
      const normalized = normalizeUuidFromEvent(rawId);
      if (normalized == null) continue;
      allIds.add(normalized);
      normalizedIds.push(normalized);
    }
    if (normalizedIds.length > 0) {
      countryToIds.set(row.country_code.toUpperCase(), normalizedIds);
    }
  }

  if (allIds.size === 0) return {};

  const prisma = await getPrismaClientForTenancy(tenancy);
  const dbUsers = await prisma.$replica().projectUser.findMany({
    where: {
      tenancyId: tenancy.id,
      projectUserId: { in: Array.from(allIds) },
      ...(!includeAnonymous ? { isAnonymous: false } : {}),
    },
    include: userFullInclude,
  });

  const usersById = new Map<string, MetricsRecentUser>();
  for (const user of dbUsers) {
    const crud = userPrismaToCrud(user, tenancy.config);
    usersById.set(crud.id, {
      id: crud.id,
      display_name: crud.display_name,
      primary_email: crud.primary_email,
      profile_image_url: crud.profile_image_url,
      signed_up_at_millis: crud.signed_up_at_millis,
      last_active_at_millis: crud.last_active_at_millis,
    });
  }

  const result: Record<string, MetricsRecentUser[]> = {};
  for (const [country, ids] of countryToIds) {
    const users: MetricsRecentUser[] = [];
    for (const id of ids) {
      const user = usersById.get(id);
      if (user != null) users.push(user);
    }
    if (users.length > 0) {
      result[country] = users;
    }
  }

  return result;
}

// Distinct user count inside the same ~2-minute `$token-refresh` window used
// by `loadActiveUsersByCountry`. This is the "live users right now" number on
// the overview globe and works independently of whether the analytics app is
// installed (unlike `analytics_overview.online_live`, which relies on
// `$page-view` events).
async function loadLiveUsersCount(
  tenancy: Tenancy,
  now: Date,
  includeAnonymous: boolean = false,
): Promise<number> {
  const since = new Date(now.getTime() - ACTIVE_USERS_BY_COUNTRY_WINDOW_MS);

  try {
    const clickhouseClient = getClickhouseAdminClientForMetrics();
    const res = await clickhouseClient.query({
      query: `
        SELECT uniqExact(user_id) AS live_users
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND user_id IS NOT NULL
          AND event_at >= {since:DateTime}
          AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
      `,
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        includeAnonymous: includeAnonymous ? 1 : 0,
        since: formatClickhouseDateTimeParam(since),
      },
      format: "JSONEachRow",
    });
    const rows: { live_users: number | string }[] = await res.json();
    return Number(rows[0]?.live_users ?? 0);
  } catch (error) {
    // Best-effort: a missing ClickHouse table or CH outage must not break the
    // main metrics call. Sentry-log ClickHouseError vs. everything else so a
    // noisy CH outage doesn't drown out real bugs.
    const captureId = error instanceof ClickHouseError
      ? "internal-metrics-load-live-users-count-clickhouse-error"
      : "internal-metrics-load-live-users-count-unexpected-error";
    captureError(captureId, new HexclaveAssertionError(
      "Failed to load live users count for internal metrics.",
      {
        cause: error,
        tenancyId: tenancy.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        windowMs: ACTIVE_USERS_BY_COUNTRY_WINDOW_MS,
      },
    ));
    return 0;
  }
}

export async function loadTotalUsers(tenancy: Tenancy, now: Date, includeAnonymous: boolean = false): Promise<DataPoints> {
  const { since, untilExclusive } = getMetricsWindowBounds(now);
  const clickhouseClient = getClickhouseAdminClientForMetrics();

  const result = await clickhouseClient.query({
    query: `
      SELECT
        toDate(signed_up_at) AS day,
        count() AS daily_users
      FROM analytics_internal.users FINAL
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND sync_is_deleted = 0
        AND signed_up_at >= {since:DateTime}
        AND signed_up_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR is_anonymous = 0)
      GROUP BY day
      ORDER BY day
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      since: formatClickhouseDateTimeParam(since),
      untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
      includeAnonymous: includeAnonymous ? 1 : 0,
    },
    format: "JSONEachRow",
  });
  const rows = await result.json() as { day: string, daily_users: string | number }[];

  const countByDay = new Map<string, number>();
  for (const row of rows) {
    countByDay.set(row.day.split('T')[0], Number(row.daily_users));
  }

  const out: DataPoints = [];
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i++) {
    const dayKey = new Date(since.getTime() + i * ONE_DAY_MS).toISOString().split('T')[0];
    out.push({ date: dayKey, activity: countByDay.get(dayKey) ?? 0 });
  }
  return out;
}

async function loadHourlyUsers(tenancy: Tenancy, now: Date, includeAnonymous: boolean = false): Promise<DataPoints> {
  const latestHour = new Date(now);
  latestHour.setUTCMinutes(0, 0, 0);
  const since = new Date(latestHour.getTime() - 23 * 60 * 60 * 1000);
  const untilExclusive = new Date(latestHour.getTime() + 60 * 60 * 1000);
  const clickhouseClient = getClickhouseAdminClientForMetrics();

  const result = await clickhouseClient.query({
    query: `
      SELECT
        toStartOfHour(signed_up_at) AS hour,
        count() AS hourly_users
      FROM analytics_internal.users FINAL
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND sync_is_deleted = 0
        AND signed_up_at >= {since:DateTime}
        AND signed_up_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR is_anonymous = 0)
      GROUP BY hour
      ORDER BY hour
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      since: formatClickhouseDateTimeParam(since),
      untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
      includeAnonymous: includeAnonymous ? 1 : 0,
    },
    format: "JSONEachRow",
  });
  const rows = await result.json() as { hour: string, hourly_users: string | number }[];

  const countByHour = new Map<string, number>();
  for (const row of rows) {
    countByHour.set(new Date(row.hour).toISOString().slice(0, 13), Number(row.hourly_users));
  }

  const out: DataPoints = [];
  for (let i = 0; i < 24; i++) {
    const hour = new Date(since.getTime() + i * 60 * 60 * 1000);
    const key = hour.toISOString().slice(0, 13);
    out.push({ date: `${key}:00:00.000Z`, activity: countByHour.get(key) ?? 0 });
  }
  return out;
}

async function loadDailyActiveUsers(tenancy: Tenancy, now: Date, includeAnonymous: boolean = false) {
  const todayUtc = new Date(now);
  todayUtc.setUTCHours(0, 0, 0, 0);
  const since = new Date(todayUtc.getTime() - METRICS_WINDOW_MS);
  const untilExclusive = new Date(todayUtc.getTime() + ONE_DAY_MS);

  const clickhouseClient = getClickhouseAdminClientForMetrics();
  const result = await clickhouseClient.query({
    query: `
      SELECT
        toDate(event_at) AS day,
        -- Counting hashes instead of the raw uuids keeps the count exact while
        -- holding 8 bytes per distinct user per day group rather than 36.
        uniqExact(sipHash64(assumeNotNull(user_id))) AS dau
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
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      since: formatClickhouseDateTimeParam(since),
      untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
      includeAnonymous: includeAnonymous ? 1 : 0,
    },
    format: "JSONEachRow",
  });

  const rows: { day: string, dau: number }[] = await result.json();
  const dauByDay = new Map<string, number>();
  for (const row of rows) {
    // ClickHouse returns dates/datetimes without timezone, treat as UTC.
    const dayKey = row.day.split('T')[0];
    dauByDay.set(dayKey, Number(row.dau));
  }

  const out: DataPoints = [];
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i += 1) {
    const day = new Date(since.getTime() + i * ONE_DAY_MS);
    const dayKey = day.toISOString().split('T')[0];
    out.push({
      date: dayKey,
      activity: dauByDay.get(dayKey) ?? 0,
    });
  }
  return out;
}

async function loadHourlyActiveUsers(tenancy: Tenancy, now: Date, includeAnonymous: boolean = false): Promise<DataPoints> {
  const latestHour = new Date(now);
  latestHour.setUTCMinutes(0, 0, 0);
  const since = new Date(latestHour.getTime() - 23 * 60 * 60 * 1000);
  const untilExclusive = new Date(latestHour.getTime() + 60 * 60 * 1000);
  const clickhouseClient = getClickhouseAdminClientForMetrics();
  const result = await clickhouseClient.query({
    query: `
      SELECT
        toStartOfHour(event_at) AS hour,
        uniqExact(sipHash64(assumeNotNull(user_id))) AS dau
      FROM analytics_internal.events
      WHERE event_type = '$token-refresh'
        AND project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND user_id IS NOT NULL
        AND event_at >= {since:DateTime}
        AND event_at < {untilExclusive:DateTime}
        AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)
      GROUP BY hour
      ORDER BY hour ASC
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      since: formatClickhouseDateTimeParam(since),
      untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
      includeAnonymous: includeAnonymous ? 1 : 0,
    },
    format: "JSONEachRow",
  });

  const rows: { hour: string, dau: number }[] = await result.json();
  const dauByHour = new Map<string, number>();
  for (const row of rows) {
    dauByHour.set(new Date(row.hour).toISOString().slice(0, 13), Number(row.dau));
  }

  const out: DataPoints = [];
  for (let i = 0; i < 24; i += 1) {
    const hour = new Date(since.getTime() + i * 60 * 60 * 1000);
    const key = hour.toISOString().slice(0, 13);
    out.push({ date: `${key}:00:00.000Z`, activity: dauByHour.get(key) ?? 0 });
  }
  return out;
}

async function loadDailyActiveSplitFromClickhouse(options: {
  tenancy: Tenancy,
  now: Date,
  entity: "user" | "team",
  includeAnonymous: boolean,
}): Promise<ActivitySplit> {
  const { tenancy, now, entity, includeAnonymous } = options;
  const todayUtc = new Date(now);
  todayUtc.setUTCHours(0, 0, 0, 0);
  const since = new Date(todayUtc.getTime() - METRICS_WINDOW_MS);
  const untilExclusive = new Date(todayUtc.getTime() + ONE_DAY_MS);

  const idCol = entity === "user" ? "user_id" : "team_id";
  // Teams don't have an is_anonymous concept, so that filter is users-only.
  const anonFilter = entity === "user"
    ? "AND ({includeAnonymous:UInt8} = 1 OR coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0)"
    : "";

  const clickhouseClient = getClickhouseAdminClientForMetrics();
  // The `active_days` bitmask below dedupes days per entity, so it must cover
  // the whole window plus today in a UInt64.
  const windowDays = METRICS_WINDOW_DAYS + 1;
  if (windowDays > 64) {
    throw new HexclaveAssertionError("The daily-active split packs one bit per day of the metrics window into a UInt64, so the window can't exceed 63 days.", { windowDays });
  }

  // Note: the inner `assumeNotNull(${idCol}) AS entity_id` must not reuse the
  // column name, or ClickHouse re-resolves `WHERE ${idCol} IS NOT NULL`
  // against the alias (assumeNotNull returns '' for NULLs, which passes the
  // not-null test) and phantom rows slip through.
  //
  // The LEFT JOIN's `min(event_at)` subquery below is intentionally unbounded:
  // bounding it would reclassify entities first seen >30d ago and active today
  // as "new" instead of "reactivated".
  //
  // Shape: one row per entity holding a bitmask of the days it was active, then
  // fan that back out to one row per (entity, active day). The straightforward
  // shape — DISTINCT (day, entity_id) plus a `lagInFrame` window to find each
  // entity's previous active day — has to hold every (day, entity) pair in
  // memory at once, which is up to 31x the number of entities and blew
  // `max_memory_usage` on busy projects (a 500 there takes down the whole
  // metrics endpoint). The bitmask collapses that to one row per entity, and
  // "was active yesterday" becomes a bit test on the neighbouring day instead
  // of a window function. Entities are keyed by hash for the same reason: only
  // per-day counts are read back, so there's no need to carry 36-char uuid
  // strings through the aggregation and the join. A 64-bit collision would
  // merge two entities' first-seen dates; at these cardinalities that is
  // ~1e-8 likely.
  const result = await clickhouseClient.query({
    query: `
      SELECT
        toString(addDays(toDate({since:DateTime}), idx)) AS day,
        count() AS total_count,
        countIf(f_first_date = addDays(toDate({since:DateTime}), idx)) AS new_count,
        countIf(f_first_date < addDays(toDate({since:DateTime}), idx) AND idx > 0 AND bitTest(active_days, if(idx = 0, 0, idx - 1))) AS retained_count,
        countIf(f_first_date < addDays(toDate({since:DateTime}), idx) AND (idx = 0 OR NOT bitTest(active_days, if(idx = 0, 0, idx - 1)))) AS reactivated_count
      FROM (
        SELECT
          a.active_days AS active_days,
          f.first_date AS f_first_date
        FROM (
          SELECT
            sipHash64(assumeNotNull(${idCol})) AS entity_id,
            groupBitOr(bitShiftLeft(toUInt64(1), toUInt8(dateDiff('day', toDate({since:DateTime}), toDate(event_at))))) AS active_days
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND ${idCol} IS NOT NULL
            AND event_at >= {since:DateTime}
            AND event_at < {untilExclusive:DateTime}
            ${anonFilter}
          GROUP BY entity_id
        ) AS a
        LEFT JOIN (
          SELECT
            sipHash64(assumeNotNull(${idCol})) AS entity_id,
            toDate(min(event_at)) AS first_date
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh'
            AND project_id = {projectId:String}
            AND branch_id = {branchId:String}
            AND ${idCol} IS NOT NULL
            AND event_at < {untilExclusive:DateTime}
            ${anonFilter}
          GROUP BY entity_id
        ) AS f USING (entity_id)
      )
      ARRAY JOIN range({windowDays:UInt32}) AS idx
      WHERE bitTest(active_days, idx)
      GROUP BY idx
      ORDER BY idx ASC
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      since: formatClickhouseDateTimeParam(since),
      untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
      includeAnonymous: includeAnonymous ? 1 : 0,
      windowDays,
    },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as {
    day: string,
    total_count: string,
    new_count: string,
    retained_count: string,
    reactivated_count: string,
  }[];

  const byDay = new Map(rows.map((r) => [r.day.split('T')[0], r]));
  const orderedDays: string[] = [];
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i += 1) {
    orderedDays.push(new Date(since.getTime() + i * ONE_DAY_MS).toISOString().split('T')[0]);
  }
  const split: ActivitySplit = {
    total: orderedDays.map((date) => ({ date, activity: Number(byDay.get(date)?.total_count ?? 0) })),
    new: orderedDays.map((date) => ({ date, activity: Number(byDay.get(date)?.new_count ?? 0) })),
    retained: orderedDays.map((date) => ({ date, activity: Number(byDay.get(date)?.retained_count ?? 0) })),
    reactivated: orderedDays.map((date) => ({ date, activity: Number(byDay.get(date)?.reactivated_count ?? 0) })),
  };
  return split;
}

async function loadDailyActiveUsersSplit(tenancy: Tenancy, now: Date, includeAnonymous: boolean): Promise<ActivitySplit> {
  return await loadDailyActiveSplitFromClickhouse({ tenancy, now, entity: "user", includeAnonymous });
}

async function loadDailyActiveTeamsSplit(tenancy: Tenancy, now: Date): Promise<ActivitySplit> {
  return await loadDailyActiveSplitFromClickhouse({ tenancy, now, entity: "team", includeAnonymous: false });
}

async function loadLoginMethods(tenancy: Tenancy): Promise<{ method: string, count: number }[]> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await prisma.$replica().$queryRaw<{ method: string, count: number }[]>`
    WITH tab AS (
      SELECT
        COALESCE(
          CASE WHEN oaam IS NOT NULL THEN oaam."configOAuthProviderId"::text ELSE NULL END,
          CASE WHEN pam IS NOT NULL THEN 'password' ELSE NULL END,
          CASE WHEN pkm IS NOT NULL THEN 'passkey' ELSE NULL END,
          CASE WHEN oam IS NOT NULL THEN 'otp' ELSE NULL END,
          'other'
        ) AS "method",
        method.id AS id
      FROM
        ${sqlQuoteIdent(schema)}."AuthMethod" method
      LEFT JOIN ${sqlQuoteIdent(schema)}."OAuthAuthMethod" oaam ON method.id = oaam."authMethodId"
      LEFT JOIN ${sqlQuoteIdent(schema)}."PasswordAuthMethod" pam ON method.id = pam."authMethodId"
      LEFT JOIN ${sqlQuoteIdent(schema)}."PasskeyAuthMethod" pkm ON method.id = pkm."authMethodId"
      LEFT JOIN ${sqlQuoteIdent(schema)}."OtpAuthMethod" oam ON method.id = oam."authMethodId"
      WHERE method."tenancyId" = ${tenancy.id}::UUID)
    SELECT LOWER("method") AS method, COUNT(id)::int AS "count" FROM tab
    GROUP BY "method"
  `;
}

async function loadRecentlyActiveUsers(tenancy: Tenancy, includeAnonymous: boolean = false): Promise<UsersCrud["Admin"]["Read"][]> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const dbUsers = await prisma.$replica().projectUser.findMany({
    where: {
      tenancyId: tenancy.id,
      ...(!includeAnonymous ? { isAnonymous: false } : {}),
    },
    orderBy: {
      lastActiveAt: 'desc',
    },
    take: 5,
    include: userFullInclude,
  });

  return dbUsers.map((user) => userPrismaToCrud(user, tenancy.config));
}

async function loadAnonymousVisitorsFromTokenRefresh(
  tenancy: Tenancy,
  now: Date,
): Promise<{ dailyVisitors: DataPoints, visitors: number }> {
  const { since, untilExclusive } = getMetricsWindowBounds(now);
  const clickhouseClient = getClickhouseAdminClientForMetrics();

  // GROUPING SETS keeps the exact old normalized-UUID semantics, but collapses
  // the result to 31 daily rows plus one total row. The previous `GROUP BY day,
  // user_id` returned every distinct (day, user) pair to Node and rebuilt those
  // sets in JS, so response size and V8 memory grew with tenant activity.
  const query = `
    SELECT
      if(GROUPING(event_day) = 1, '', toString(event_day)) AS day,
      uniqExact(normalized_user_uuid) AS visitors
    FROM (
      SELECT
        event_day,
        normalized_user_id,
        toUUIDOrNull(normalized_user_id) AS normalized_user_uuid
      FROM (
        SELECT
          toDate(event_at) AS event_day,
          lower(trim(assumeNotNull(user_id))) AS normalized_user_id
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND user_id IS NOT NULL
          AND event_at >= {since:DateTime}
          AND event_at < {untilExclusive:DateTime}
          AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 1
      )
    )
    WHERE normalized_user_uuid IS NOT NULL
      AND match(normalized_user_id, {uuidRe:String})
    GROUP BY GROUPING SETS ((event_day), ())
    ORDER BY GROUPING(event_day) ASC, day ASC
  `;

  try {
    const result = await clickhouseClient.query({
      query,
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        since: formatClickhouseDateTimeParam(since),
        untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
        uuidRe: MAU_UUID_V4_REGEX,
      },
      format: "JSONEachRow",
    });
    const rows: { day: string, visitors: string | number }[] = await result.json();
    const totalRow = rows.at(-1);
    if (totalRow == null || totalRow.day !== "") {
      throw new HexclaveAssertionError("Anonymous visitor query did not return the expected total row.", { rows });
    }

    const visitorsByDay = new Map<string, number>();
    for (const row of rows.slice(0, -1)) {
      const visitors = Number(row.visitors);
      if (!Number.isFinite(visitors) || visitors < 0) {
        throw new HexclaveAssertionError("Invalid anonymous visitor count returned by ClickHouse.", { row });
      }
      visitorsByDay.set(row.day.split('T')[0], visitors);
    }

    const dailyVisitors: DataPoints = [];
    for (let i = 0; i <= METRICS_WINDOW_DAYS; i += 1) {
      const date = new Date(since.getTime() + i * ONE_DAY_MS).toISOString().split('T')[0];
      dailyVisitors.push({ date, activity: visitorsByDay.get(date) ?? 0 });
    }

    return { dailyVisitors, visitors: Number(totalRow.visitors) };
  } catch (error) {
    // Swallow all failures so callers can `await` this without guarding — the
    // fallback is best-effort and must never take down the main metrics call.
    // Separate Sentry IDs for ClickHouseError vs. everything else so noisy CH
    // outages don't drown out real bugs.
    const captureId = error instanceof ClickHouseError
      ? "internal-metrics-load-anonymous-visitors-fallback-clickhouse-error"
      : "internal-metrics-load-anonymous-visitors-fallback-unexpected-error";
    captureError(captureId, new HexclaveAssertionError(
      "Failed to load anonymous visitors fallback for internal metrics.",
      {
        cause: error,
        tenancyId: tenancy.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        windowDays: METRICS_WINDOW_DAYS,
        query,
      },
    ));
    return { dailyVisitors: [], visitors: 0 };
  }
}

async function loadMonthlyActiveUsers(tenancy: Tenancy, now: Date, includeAnonymous: boolean = false): Promise<number> {
  const { since, untilExclusive } = getMetricsWindowBounds(now);

  const clickhouseClient = getClickhouseAdminClientForMetrics();
  try {
    const result = await clickhouseClient.query({
      query: `
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
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        since: formatClickhouseDateTimeParam(since),
        untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
        includeAnonymous: includeAnonymous ? 1 : 0,
        uuidRe: MAU_UUID_V4_REGEX,
      },
      format: "JSONEachRow",
    });
    const rows: { mau: string | number }[] = await result.json();
    return Number(rows[0]?.mau ?? 0);
  } catch (error) {
    // Only swallow real ClickHouse errors (e.g. project hasn't enabled
    // analytics yet, transient query failure). Anything else is a programming
    // bug and should propagate to the smart route handler.
    if (!(error instanceof ClickHouseError)) {
      throw error;
    }
    captureError("internal-metrics-load-monthly-active-users-failed", new HexclaveAssertionError(
      "Failed to load monthly active users for internal metrics.",
      {
        cause: error,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
      },
    ));
    return 0;
  }
}


export async function loadDailyRevenue(tenancy: Tenancy, now: Date): Promise<Array<{ date: string, new_cents: number, refund_cents: number }>> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const { since } = getMetricsWindowBounds(now);

  const rows = await prisma.$replica().$queryRaw<{ day: string, new_cents: bigint }[]>`
    SELECT
      TO_CHAR("createdAt"::date, 'YYYY-MM-DD') AS day,
      COALESCE(SUM("amountTotal"), 0)::bigint AS new_cents
    FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
    WHERE "tenancyId" = ${tenancy.id}::UUID
      AND "amountTotal" IS NOT NULL
      AND "status" IN (${METRICS_REVENUE_INVOICE_STATUSES_SQL})
      AND "createdAt" >= ${since}
    GROUP BY day
    ORDER BY day
  `;

  const revenueByDay = new Map<string, number>();
  for (const row of rows) {
    revenueByDay.set(row.day, Number(row.new_cents));
  }

  const dailyRevenue: Array<{ date: string, new_cents: number, refund_cents: number }> = [];
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i++) {
    const day = new Date(since.getTime() + i * ONE_DAY_MS);
    const key = day.toISOString().split('T')[0];
    dailyRevenue.push({ date: key, new_cents: revenueByDay.get(key) ?? 0, refund_cents: 0 });
  }

  return dailyRevenue;
}

export async function loadPaymentsOverview(tenancy: Tenancy, now: Date) {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);

  const { since: thirtyDaysAgo } = getMetricsWindowBounds(now);

  const [
    subscriptionsByStatus,
    aggregates,
    dailySubscriptionRows,
  ] = await Promise.all([
    prisma.$replica().$queryRaw<{ status: string, cnt: number }[]>`
      SELECT "status"::text AS status, COUNT(*)::int AS cnt
      FROM ${sqlQuoteIdent(schema)}."Subscription"
      WHERE "tenancyId" = ${tenancy.id}::UUID
      GROUP BY "status"
    `,
    prisma.$replica().$queryRaw<[{
      active_subscription_count: number,
      total_one_time_purchases: number,
      revenue_cents: bigint,
      total_subscription_invoices: number,
      successful_subscription_invoices: number,
      mrr_cents: bigint,
    }]>`
      SELECT
        (SELECT COUNT(*)::int
          FROM ${sqlQuoteIdent(schema)}."Subscription"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "status" = 'active'::"SubscriptionStatus") AS active_subscription_count,
        (SELECT COUNT(*)::int
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID) AS total_one_time_purchases,
        (SELECT COALESCE(SUM("amountTotal"), 0)::bigint
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "amountTotal" IS NOT NULL
            AND "status" IN (${METRICS_REVENUE_INVOICE_STATUSES_SQL})) AS revenue_cents,
        (SELECT COUNT(*)::int
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID) AS total_subscription_invoices,
        (SELECT COUNT(*)::int
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "status" IN (${METRICS_REVENUE_INVOICE_STATUSES_SQL})) AS successful_subscription_invoices,
        (SELECT COALESCE(SUM("amountTotal"), 0)::bigint
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "amountTotal" IS NOT NULL
            AND "status" IN (${METRICS_REVENUE_INVOICE_STATUSES_SQL})
            AND "createdAt" >= ${thirtyDaysAgo}) AS mrr_cents
    `,
    // Daily subscription signups for the last 30 days
    prisma.$replica().$queryRaw<{ day: string, cnt: number }[]>`
      SELECT
        TO_CHAR("createdAt"::date, 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS cnt
      FROM ${sqlQuoteIdent(schema)}."Subscription"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "createdAt" >= ${thirtyDaysAgo}
      GROUP BY day
      ORDER BY day
    `,
  ]);

  const subsByStatusMap = new Map<string, number>();
  for (const group of subscriptionsByStatus) {
    subsByStatusMap.set(group.status.toLowerCase(), Number(group.cnt));
  }
  const subsByStatus = Object.fromEntries(subsByStatusMap);

  const activeSubscriptionCount = Number(aggregates[0].active_subscription_count);
  const totalOneTimePurchases = Number(aggregates[0].total_one_time_purchases);
  const invoiceRevenueCents = Number(aggregates[0].revenue_cents);
  const totalSubscriptionInvoices = Number(aggregates[0].total_subscription_invoices);
  const successfulSubscriptionInvoices = Number(aggregates[0].successful_subscription_invoices);
  const mrrCents = Number(aggregates[0].mrr_cents);

  const recentByDay = new Map<string, number>();
  for (const row of dailySubscriptionRows) {
    recentByDay.set(row.day, Number(row.cnt));
  }
  const dailySubscriptions: DataPoints = [];
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i++) {
    const day = new Date(thirtyDaysAgo.getTime() + i * ONE_DAY_MS);
    const key = day.toISOString().split('T')[0];
    dailySubscriptions.push({ date: key, activity: recentByDay.get(key) ?? 0 });
  }

  // MRR proxy: trailing-30-day paid invoice revenue. This is an approximation
  // (it conflates one-time and recurring revenue and ignores billing cadence)
  // but it is derived from real data instead of a hardcoded per-subscription rate.
  const totalOrders = totalOneTimePurchases + totalSubscriptionInvoices;
  const checkoutConversionRate = totalOrders > 0
    ? Number((((successfulSubscriptionInvoices + totalOneTimePurchases) / totalOrders) * 100).toFixed(2))
    : 0;

  return {
    subscriptions_by_status: subsByStatus,
    active_subscription_count: activeSubscriptionCount,
    total_one_time_purchases: totalOneTimePurchases,
    daily_subscriptions: dailySubscriptions,
    revenue_cents: invoiceRevenueCents,
    mrr_cents: mrrCents,
    total_orders: totalOrders,
    checkout_conversion_rate: checkoutConversionRate,
  };
}

// ── Email Aggregates ─────────────────────────────────────────────────────────

export async function loadEmailOverview(tenancy: Tenancy, now: Date) {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const { since: thirtyDaysAgo } = getMetricsWindowBounds(now);

  const [
    counts,
    recentEmails,
    emailsByDayAndStatus,
  ] = await Promise.all([
    // Single scan: per-status counts + delivered/bounced/clicked/finishedSending counts
    prisma.$replica().$queryRaw<[{
      ok_count: number,
      error_count: number,
      in_progress_count: number,
      delivered_count: number,
      bounced_count: number,
      clicked_count: number,
      finished_sending_count: number,
    }]>`
      SELECT
        COUNT(*) FILTER (WHERE "simpleStatus" = 'OK'::"EmailOutboxSimpleStatus")::int AS ok_count,
        COUNT(*) FILTER (WHERE "simpleStatus" = 'ERROR'::"EmailOutboxSimpleStatus")::int AS error_count,
        COUNT(*) FILTER (WHERE "simpleStatus" = 'IN_PROGRESS'::"EmailOutboxSimpleStatus")::int AS in_progress_count,
        COUNT(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int AS delivered_count,
        COUNT(*) FILTER (WHERE "bouncedAt" IS NOT NULL)::int AS bounced_count,
        COUNT(*) FILTER (WHERE "clickedAt" IS NOT NULL)::int AS clicked_count,
        COUNT(*) FILTER (WHERE "finishedSendingAt" IS NOT NULL)::int AS finished_sending_count
      FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
      WHERE "tenancyId" = ${tenancy.id}::UUID
    `,
    prisma.$replica().$queryRaw<{
      id: string,
      createdAt: Date,
      simpleStatus: string,
      status: string,
      renderedSubject: string | null,
    }[]>`
      SELECT
        "id"::text AS id,
        "createdAt",
        "simpleStatus"::text AS "simpleStatus",
        "status"::text AS "status",
        "renderedSubject"
      FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
      WHERE "tenancyId" = ${tenancy.id}::UUID
      ORDER BY "createdAt" DESC
      LIMIT ${RECENT_LIST_PAGE_SIZE}
    `,
    // Per-day per-simpleStatus counts for the last 30 days
    prisma.$replica().$queryRaw<{ day: string, status: string, cnt: number }[]>`
      SELECT
        TO_CHAR("createdAt"::date, 'YYYY-MM-DD') AS day,
        "simpleStatus"::text AS status,
        COUNT(*)::int AS cnt
      FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "createdAt" >= ${thirtyDaysAgo}
      GROUP BY day, "simpleStatus"
      ORDER BY day
    `,
  ]);

  const deliveredCount = Number(counts[0].delivered_count);
  const bouncedCount = Number(counts[0].bounced_count);
  const clickedCount = Number(counts[0].clicked_count);
  const finishedSendingCount = Number(counts[0].finished_sending_count);

  // Match the original groupBy behavior: only include statuses that actually
  // have at least one row, mirroring what Prisma's groupBy used to return.
  const emailsByStatus: Record<string, number> = {};
  const okCount = Number(counts[0].ok_count);
  const errorCount = Number(counts[0].error_count);
  const inProgressCount = Number(counts[0].in_progress_count);
  if (okCount > 0) emailsByStatus.ok = okCount;
  if (errorCount > 0) emailsByStatus.error = errorCount;
  if (inProgressCount > 0) emailsByStatus['in-progress'] = inProgressCount;

  // Daily email sends for last 30 days
  const emailByDay = new Map<string, number>();
  for (const row of emailsByDayAndStatus) {
    emailByDay.set(row.day, (emailByDay.get(row.day) ?? 0) + Number(row.cnt));
  }
  const dailyEmails: DataPoints = [];
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i++) {
    const day = new Date(thirtyDaysAgo.getTime() + i * ONE_DAY_MS);
    const key = day.toISOString().split('T')[0];
    dailyEmails.push({ date: key, activity: emailByDay.get(key) ?? 0 });
  }

  const totalEmails = Object.values(emailsByStatus).reduce((a, b) => a + b, 0);
  const denom = finishedSendingCount > 0 ? finishedSendingCount : 1;
  const deliverabilityRate = Number((Math.min(deliveredCount / denom, 1) * 100).toFixed(2));
  const bounceRate = Number((Math.min(bouncedCount / denom, 1) * 100).toFixed(2));
  const clickRate = Number((Math.min(clickedCount / denom, 1) * 100).toFixed(2));

  // Build per-day per-status breakdown for stacked bar chart
  type DayStatusCounts = { date: string, ok: number, error: number, in_progress: number };
  const dayStatusMap = new Map<string, { ok: number, error: number, in_progress: number }>();
  for (let i = 0; i <= METRICS_WINDOW_DAYS; i++) {
    const key = new Date(thirtyDaysAgo.getTime() + i * ONE_DAY_MS).toISOString().split('T')[0];
    dayStatusMap.set(key, { ok: 0, error: 0, in_progress: 0 });
  }
  for (const row of emailsByDayAndStatus) {
    const entry = dayStatusMap.get(row.day);
    if (entry == null) continue;
    const count = Number(row.cnt);
    // Exhaustive switch over EmailOutboxSimpleStatus — adding a new enum
    // value will fail typecheck here so we can't silently miscount.
    const status = parseEmailOutboxSimpleStatus(row.status);
    if (status == null) {
      captureError("internal-metrics-unknown-email-simple-status", new HexclaveAssertionError(
        `Unknown EmailOutboxSimpleStatus value: ${String(row.status)}`,
        { status: row.status },
      ));
      continue;
    }
    switch (status) {
      case 'OK': {
        entry.ok += count;
        break;
      }
      case 'ERROR': {
        entry.error += count;
        break;
      }
      case 'IN_PROGRESS': {
        entry.in_progress += count;
        break;
      }
      default: {
        const _exhaustiveCheck: never = status;
        captureError("internal-metrics-unknown-email-simple-status", new HexclaveAssertionError(
          `Unknown EmailOutboxSimpleStatus value: ${String(_exhaustiveCheck)}`,
          { status: _exhaustiveCheck },
        ));
      }
    }
  }
  const dailyEmailsByStatus: DayStatusCounts[] = [...dayStatusMap.entries()].map(([date, counts]) => ({
    date,
    ...counts,
  }));

  return {
    emails_by_status: emailsByStatus,
    total_emails: totalEmails,
    daily_emails: dailyEmails,
    daily_emails_by_status: dailyEmailsByStatus,
    emails_sent: finishedSendingCount,
    recent_emails: recentEmails.map((email) => ({
      id: email.id,
      status: email.status,
      subject: email.renderedSubject ?? '(no subject)',
      created_at_millis: email.createdAt.getTime(),
    })),
    deliverability_status: {
      delivered: deliveredCount,
      bounced: bouncedCount,
      error: emailsByStatus['error'] ?? 0,
      in_progress: emailsByStatus['in-progress'] ?? 0,
    },
    deliverability_rate: deliverabilityRate,
    bounce_rate: bounceRate,
    click_rate: clickRate,
  };
}

// ── Web Analytics Aggregates ─────────────────────────────────────────────────

type SessionReplayAggregates = {
  total: number,
  recent: number,
  avgSessionSeconds: number,
  totalRevenueCents: number,
};

async function loadSessionReplayAggregates(tenancy: Tenancy, since: Date): Promise<SessionReplayAggregates> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const result = await prisma.$replica().$queryRaw<[{
    total: number,
    recent: number,
    avg_ms: number | null,
    total_revenue_cents: bigint,
  }]>`
    SELECT
      (SELECT COUNT(*)::int
        FROM ${sqlQuoteIdent(schema)}."SessionReplay"
        WHERE "tenancyId" = ${tenancy.id}::UUID) AS total,
      (SELECT COUNT(*)::int
        FROM ${sqlQuoteIdent(schema)}."SessionReplay"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "startedAt" >= ${since}) AS recent,
      (SELECT AVG(GREATEST(0, EXTRACT(EPOCH FROM ("lastEventAt" - "startedAt")) * 1000))
        FROM ${sqlQuoteIdent(schema)}."SessionReplay"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "startedAt" >= ${since}) AS avg_ms,
      (SELECT COALESCE(SUM("amountTotal"), 0)::bigint
        FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "amountTotal" IS NOT NULL
          AND "status" IN (${METRICS_REVENUE_INVOICE_STATUSES_SQL})) AS total_revenue_cents
  `;

  const row = result[0];
  const avgSessionSeconds = Number(((Number(row.avg_ms ?? 0)) / 1000).toFixed(1));
  return {
    total: Number(row.total),
    recent: Number(row.recent),
    avgSessionSeconds,
    totalRevenueCents: Number(row.total_revenue_cents),
  };
}

const DIRECT_REFERRER_LABEL = "(direct)";

export type AnalyticsOverviewFilters = {
  country_code?: string,
  referrer?: string,
  browser?: string,
  os?: string,
  device?: string,
  // ISO 8601 datetimes bounding the top-N breakdowns (referrers, regions,
  // browsers/OS/devices). Clamped to the analytics window server-side; the
  // daily/hourly series intentionally stay full-window so the dashboard can
  // compute previous-period deltas client-side.
  since?: string,
  until?: string,
};

export function normalizeAnalyticsOverviewFilters(filters: AnalyticsOverviewFilters): AnalyticsOverviewFilters {
  const countryCode = filters.country_code?.trim().toUpperCase();
  const referrer = filters.referrer?.trim();
  const browser = filters.browser?.trim();
  const os = filters.os?.trim();
  const device = filters.device?.trim();
  const since = filters.since?.trim();
  const until = filters.until?.trim();
  return {
    country_code: countryCode || undefined,
    referrer: referrer || undefined,
    browser: browser || undefined,
    os: os || undefined,
    device: device || undefined,
    since: since || undefined,
    until: until || undefined,
  };
}

function parseAnalyticsRangeBound(value: string | undefined, paramName: string): Date | undefined {
  if (value == null) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new StatusError(400, `Invalid ${paramName}: expected an ISO 8601 datetime, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

const analyticsOverviewUserAgentSql = "toString(e.data.user_agent)";
const analyticsOverviewViewportWidthSql = "toInt32(toInt64OrZero(toString(e.data.viewport_width)))";

const analyticsOverviewBrowserSql = `multiIf(
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'edg/') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'edge/') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'edga/') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'edgios/') > 0, 'Edge',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'opr/') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'opera') > 0, 'Opera',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'samsungbrowser') > 0, 'Samsung Internet',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'firefox') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'fxios') > 0, 'Firefox',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'crios') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'chrome') > 0, 'Chrome',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'safari') > 0, 'Safari',
  'Other'
)`;

const analyticsOverviewOsSql = `multiIf(
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'windows') > 0, 'Windows',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'android') > 0, 'Android',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'iphone') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'ipad') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'ipod') > 0, 'iOS',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'mac os') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'macintosh') > 0, 'macOS',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'cros') > 0, 'ChromeOS',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'linux') > 0, 'Linux',
  'Other'
)`;

const analyticsOverviewDeviceSql = `multiIf(
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'ipad') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'tablet') > 0 OR (positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'android') > 0 AND positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'mobile') = 0), 'Tablet',
  positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'mobile') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'iphone') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'ipod') > 0 OR positionCaseInsensitive(${analyticsOverviewUserAgentSql}, 'android') > 0, 'Mobile',
  ${analyticsOverviewViewportWidthSql} > 0 AND ${analyticsOverviewViewportWidthSql} < 600, 'Mobile',
  ${analyticsOverviewViewportWidthSql} >= 600 AND ${analyticsOverviewViewportWidthSql} < 1024, 'Tablet',
  'Desktop'
)`;

function buildAnalyticsOverviewUserAgentFilterFragments(filters: AnalyticsOverviewFilters): {
  browserFragment: string,
  osFragment: string,
  deviceFragment: string,
  params: Record<string, string>,
} {
  return {
    browserFragment: filters.browser ? `AND ${analyticsOverviewBrowserSql} = {browserFilter:String}` : "",
    osFragment: filters.os ? `AND ${analyticsOverviewOsSql} = {osFilter:String}` : "",
    deviceFragment: filters.device ? `AND ${analyticsOverviewDeviceSql} = {deviceFilter:String}` : "",
    params: {
      ...(filters.browser ? { browserFilter: filters.browser } : {}),
      ...(filters.os ? { osFilter: filters.os } : {}),
      ...(filters.device ? { deviceFilter: filters.device } : {}),
    },
  };
}

export function buildAnalyticsOverviewUserAgentFilterFragmentsForTest(filters: AnalyticsOverviewFilters): {
  hasBrowserFilter: boolean,
  hasOsFilter: boolean,
  hasDeviceFilter: boolean,
  params: Record<string, string>,
  usesRawUserAgentAllowlist: boolean,
} {
  const fragments = buildAnalyticsOverviewUserAgentFilterFragments(filters);
  const combinedFragments = [
    fragments.browserFragment,
    fragments.osFragment,
    fragments.deviceFragment,
  ].join("\n");
  return {
    hasBrowserFilter: fragments.browserFragment.length > 0,
    hasOsFilter: fragments.osFragment.length > 0,
    hasDeviceFilter: fragments.deviceFragment.length > 0,
    params: fragments.params,
    usesRawUserAgentAllowlist: combinedFragments.includes("matchingUAs") || combinedFragments.includes("IN {"),
  };
}

export async function loadAnalyticsOverview(
  tenancy: Tenancy,
  now: Date,
  includeAnonymous: boolean,
  filters: AnalyticsOverviewFilters = {},
) {
  const todayUtc = new Date(now);
  todayUtc.setUTCHours(0, 0, 0, 0);
  const since = new Date(todayUtc.getTime() - METRICS_WINDOW_MS);
  const untilExclusive = new Date(todayUtc.getTime() + ONE_DAY_MS);

  // Optional date range for the top-N breakdowns, clamped to the analytics
  // window (ClickHouse only has detail for the last METRICS_WINDOW_DAYS).
  // The daily/hourly series stay full-window — see AnalyticsOverviewFilters.
  const requestedRangeSince = parseAnalyticsRangeBound(filters.since, "filter_since");
  const requestedRangeUntil = parseAnalyticsRangeBound(filters.until, "filter_until");
  const rangeSince = new Date(Math.max(since.getTime(), requestedRangeSince?.getTime() ?? since.getTime()));
  const rangeUntilExclusive = new Date(Math.min(untilExclusive.getTime(), requestedRangeUntil?.getTime() ?? untilExclusive.getTime()));
  if (rangeSince.getTime() >= rangeUntilExclusive.getTime()) {
    throw new StatusError(400, "filter_since must be before filter_until after clamping to the analytics window");
  }

  const clickhouseClient = getClickhouseAdminClientForMetrics();

  // Session replay aggregates come from Postgres and have nothing to do with
  // ClickHouse availability. Run them in parallel with the ClickHouse queries
  // but keep them outside the ClickHouse-only try/catch so a postgres failure
  // never gets misattributed to "analytics not enabled".
  const replayPromise = loadSessionReplayAggregates(tenancy, since);

  // Token-refresh-based anon visitor fallback. Always computed so the frontend
  // can swap it in when the analytics app isn't installed (no `$page-view`
  // events). The helper swallows all failures and Sentry-logs them, so this
  // promise is guaranteed to resolve — no unhandled rejection if the main
  // analytics query fails before we get to the await below.
  const anonymousVisitorsPromise = loadAnonymousVisitorsFromTokenRefresh(tenancy, now);

  let clickhouseAggregates: {
    dailyPageViews: DataPoints,
    dailyClicks: DataPoints,
    dailyVisitors: DataPoints,
    hourlyPageViews: DataPoints,
    hourlyActiveUsers: DataPoints,
    hourlyVisitors: DataPoints,
    dailyBounceRate: DataPoints,
    dailyAvgSession: DataPoints,
    visitors: number,
    onlineLive: number,
    bounceRate: number,
    avgSessionSeconds: number,
    topReferrers: { referrer: string, visitors: number }[],
    topRegion: { country_code: string | null, region_code: string | null, count: number } | null,
    topRegions: { country_code: string, count: number }[],
    topBrowsers: { name: string, visitors: number }[],
    topOperatingSystems: { name: string, visitors: number }[],
    topDevices: { name: string, visitors: number }[],
  } | null = null;

  // Explicit installed-check instead of inferring "analytics not enabled" from
  // a failed ClickHouse query: when the app isn't installed we skip ClickHouse
  // entirely and return the token-refresh fallback payload; when it IS
  // installed, every ClickHouse error propagates to the caller so the
  // dashboard renders its error state instead of plausible-looking zeros.
  const analyticsInstalled = tenancy.config.apps.installed["analytics"]?.enabled ?? false;

  if (analyticsInstalled) try {
    // The `event_at >= since` bound on the inner subquery is load-bearing:
    // without it the GROUP BY hash table holds one row per ever-seen user.
    // Edge case: anonymous page-views by users with no token-refresh in the
    // last 30 days now coalesce to non-anonymous. The proper fix is to stamp
    // `is_anonymous` on page-view/click events at ingest and drop this join
    // entirely (the coalesce below short-circuits on the first non-null arg).
    //
    // The join key is the hashed user id rather than the 36-char uuid string:
    // the build side holds one row per user seen in the window, and a 64-bit key
    // costs a fraction of the string one (~290 MiB -> tens of MiB on a project
    // with hundreds of thousands of visitors, which is the difference between
    // fitting in `max_memory_usage` and 500ing the whole endpoint). A 64-bit
    // collision would merge two users' anonymity flags; at these cardinalities
    // that is ~1e-8 likely, and the blast radius is one visitor counted on the
    // wrong side of the anonymous filter.
    const buildAnalyticsUserJoin = (includeCountry: boolean) => `
      LEFT JOIN (
        SELECT
          sipHash64(user_id) AS user_hash,
          argMax(coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0), event_at) AS latest_is_anonymous
          ${includeCountry ? ", argMax(CAST(data.ip_info.country_code, 'Nullable(String)'), event_at) AS latest_country" : ""}
        FROM analytics_internal.events
        WHERE event_type = '$token-refresh'
          AND project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND user_id IS NOT NULL
          AND event_at >= {since:DateTime}
          AND event_at < {untilExclusive:DateTime}
        GROUP BY user_hash
      ) AS token_refresh_users
        -- Hash the nullable column directly rather than via assumeNotNull: the
        -- hash of NULL stays NULL and matches nothing, whereas assumeNotNull
        -- would turn every event without a user into the hash of the empty
        -- string and join them all onto a user whose id is empty, if one exists.
        ON sipHash64(e.user_id) = token_refresh_users.user_hash
    `;
    const analyticsUserJoinForFilteredEvents = buildAnalyticsUserJoin(filters.country_code != null);
    const analyticsUserJoinWithCountry = buildAnalyticsUserJoin(true);
    const nonAnonymousAnalyticsUserFilter = "({includeAnonymous:UInt8} = 1 OR coalesce(CAST(e.data.is_anonymous, 'Nullable(UInt8)'), token_refresh_users.latest_is_anonymous, 0) = 0)";
    const analyticsContributingUserFilter = `e.user_id IS NOT NULL AND ${nonAnonymousAnalyticsUserFilter}`;
    // `uniqExact` keeps every distinct value it sees, once per aggregation
    // group, so exact visitor counts over 36-char user ids cost (users x groups)
    // strings — the per-day/per-hour queries alone blew the memory limit on
    // high-traffic projects. Hashing first keeps the counts exact (64-bit
    // collisions are ~1e-8 likely here) at 8 bytes per distinct user.
    const analyticsVisitorKey = "sipHash64(assumeNotNull(e.user_id))";

    // Build per-dimension filter fragments; callers below opt out of the
    // fragment matching their own dimension so top-N queries don't collapse to
    // a single row (e.g. top_referrers must not also filter by referrer).
    const referrerFragment = filters.referrer
      ? (filters.referrer === DIRECT_REFERRER_LABEL
        ? `AND CAST(e.data.referrer, 'String') = ''`
        : `AND CAST(e.data.referrer, 'String') = {referrerFilter:String}`)
      : '';
    const countryFragment = filters.country_code
      ? `AND upper(coalesce(token_refresh_users.latest_country, '')) = {countryFilter:String}`
      : '';
    const userAgentFilterFragments = buildAnalyticsOverviewUserAgentFilterFragments(filters);
    const uaFragment = [
      userAgentFilterFragments.browserFragment,
      userAgentFilterFragments.osFragment,
      userAgentFilterFragments.deviceFragment,
    ].join(" ");

    const sharedExtraFilters = `${referrerFragment} ${countryFragment} ${uaFragment}`.trim();
    const filterParams = {
      ...(filters.referrer && filters.referrer !== DIRECT_REFERRER_LABEL ? { referrerFilter: filters.referrer } : {}),
      ...(filters.country_code ? { countryFilter: filters.country_code } : {}),
      ...userAgentFilterFragments.params,
    };
    const onlineFilteredUserFragment = sharedExtraFilters
      ? `
            AND user_id IN (
              SELECT assumeNotNull(e.user_id)
              FROM analytics_internal.events AS e
              ${filters.country_code != null ? analyticsUserJoinWithCountry : ""}
              WHERE e.event_type = '$page-view'
                AND e.project_id = {projectId:String}
                AND e.branch_id = {branchId:String}
                AND e.user_id IS NOT NULL
                AND e.event_at >= {since:DateTime}
                AND e.event_at < {untilExclusive:DateTime}
                ${sharedExtraFilters}
              GROUP BY e.user_id
            )
        `
      : '';
    const [dailyEventResult, hourlyEventResult, totalVisitorResult, referrerResult, topRegionResult, onlineResult, sessionResult, userAgentResult] = await Promise.all([
      // Combined daily aggregates: page-view count, click count, and unique
      // visitors per day — one scan over the page-view/click event types.
      clickhouseClient.query({
        query: `
          SELECT
            toDate(e.event_at) AS day,
            countIf(e.event_type = '$page-view') AS pv,
            countIf(e.event_type = '$click') AS cl,
            uniqExactIf(
              ${analyticsVisitorKey},
              e.event_type = '$page-view'
            ) AS visitors
          FROM analytics_internal.events AS e
          ${analyticsUserJoinForFilteredEvents}
          WHERE e.event_type IN ('$page-view', '$click')
            AND e.project_id = {projectId:String}
            AND e.branch_id = {branchId:String}
            AND e.event_at >= {since:DateTime}
            AND e.event_at < {untilExclusive:DateTime}
            AND ${analyticsContributingUserFilter}
            ${sharedExtraFilters}
          GROUP BY day
          ORDER BY day ASC
        `,
        query_params: {
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      clickhouseClient.query({
        query: `
          SELECT
            toStartOfHour(e.event_at) AS hour,
            countIf(e.event_type = '$page-view') AS pv,
            uniqExactIf(
              ${analyticsVisitorKey},
              e.event_type IN ('$page-view', '$click')
            ) AS active_users,
            uniqExactIf(
              ${analyticsVisitorKey},
              e.event_type = '$page-view'
            ) AS visitors
          FROM analytics_internal.events AS e
          ${analyticsUserJoinForFilteredEvents}
          WHERE e.event_type IN ('$page-view', '$click')
            AND e.project_id = {projectId:String}
            AND e.branch_id = {branchId:String}
            AND e.event_at >= {hourlySince:DateTime}
            AND e.event_at < {untilExclusive:DateTime}
            AND ${analyticsContributingUserFilter}
            ${sharedExtraFilters}
          GROUP BY hour
          ORDER BY hour ASC
        `,
        query_params: {
          hourlySince: formatClickhouseDateTimeParam((() => {
            const latestHour = new Date(now);
            latestHour.setUTCMinutes(0, 0, 0);
            return new Date(latestHour.getTime() - 23 * 60 * 60 * 1000);
          })()),
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      clickhouseClient.query({
        query: `
          SELECT
            uniqExact(${analyticsVisitorKey}) AS visitors
          FROM analytics_internal.events AS e
          ${analyticsUserJoinForFilteredEvents}
          WHERE e.event_type = '$page-view'
            AND e.project_id = {projectId:String}
            AND e.branch_id = {branchId:String}
            AND e.event_at >= {since:DateTime}
            AND e.event_at < {untilExclusive:DateTime}
            AND ${analyticsContributingUserFilter}
            ${sharedExtraFilters}
        `,
        query_params: {
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      clickhouseClient.query({
        query: `
          SELECT
            nullIf(CAST(e.data.referrer, 'String'), '') AS referrer,
            uniqExact(${analyticsVisitorKey}) AS visitors
          FROM analytics_internal.events AS e
          ${analyticsUserJoinForFilteredEvents}
          WHERE e.event_type = '$page-view'
            AND e.project_id = {projectId:String}
            AND e.branch_id = {branchId:String}
            AND e.event_at >= {rangeSince:DateTime}
            AND e.event_at < {rangeUntilExclusive:DateTime}
            AND ${analyticsContributingUserFilter}
            ${countryFragment}
            ${uaFragment}
          GROUP BY referrer
          HAVING visitors > 0
          ORDER BY visitors DESC
          LIMIT ${TOP_REFERRERS_PAGE_SIZE}
        `,
        query_params: {
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          rangeSince: formatClickhouseDateTimeParam(rangeSince),
          rangeUntilExclusive: formatClickhouseDateTimeParam(rangeUntilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      // Top regions come from the same page-view population as the rest of the
      // analytics overview, but intentionally omit the country filter so the
      // country card still shows a distribution when one country is selected.
      clickhouseClient.query({
        query: `
          SELECT
            upper(coalesce(token_refresh_users.latest_country, '')) AS country_code,
            uniqExact(${analyticsVisitorKey}) AS visitors
          FROM analytics_internal.events AS e
          ${analyticsUserJoinWithCountry}
          WHERE e.event_type = '$page-view'
            AND e.project_id = {projectId:String}
            AND e.branch_id = {branchId:String}
            AND e.event_at >= {rangeSince:DateTime}
            AND e.event_at < {rangeUntilExclusive:DateTime}
            AND ${analyticsContributingUserFilter}
            AND coalesce(token_refresh_users.latest_country, '') != ''
            ${referrerFragment}
            ${uaFragment}
          GROUP BY country_code
          HAVING visitors > 0
          ORDER BY visitors DESC
          LIMIT ${TOP_REGIONS_PAGE_SIZE}
        `,
        query_params: {
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          rangeSince: formatClickhouseDateTimeParam(rangeSince),
          rangeUntilExclusive: formatClickhouseDateTimeParam(rangeUntilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      clickhouseClient.query({
        query: `
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
            ${onlineFilteredUserFragment}
        `,
        query_params: {
          onlineSince: formatClickhouseDateTimeParam(new Date(now.getTime() - 5 * 60 * 1000)),
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      // Session aggregates keyed by session_replay_segment_id (one row per
      // browser tab/session): bounce rate (single-page-view sessions) and
      // average session duration per day.
      //
      // One pass over the session's events instead of prefiltering the matching
      // session ids and re-scanning with `sid IN (SELECT ...)`: that set held
      // every session id in the window, which on its own outgrew the memory
      // limit on projects with millions of sessions. Counting the page-views
      // that match the user/dimension filters per session and requiring at least
      // one keeps exactly the population the prefilter selected, while the
      // aggregates still span all of the session's page-views and clicks.
      // Sessions are grouped by the hashed id because only the aggregates are
      // read back, and 64-bit keys cost a fraction of the uuid strings.
      clickhouseClient.query({
        query: `
          SELECT
            session_day AS day,
            count() AS sessions,
            countIf(pv = 1) AS bounced,
            avg(duration_s) AS avg_duration_s
          FROM (
            SELECT
              sipHash64(e.session_replay_segment_id) AS sid,
              toDate(min(e.event_at)) AS session_day,
              countIf(e.event_type = '$page-view') AS pv,
              dateDiff('second', min(e.event_at), max(e.event_at)) AS duration_s,
              countIf(e.event_type = '$page-view' AND (${analyticsContributingUserFilter} ${sharedExtraFilters})) AS matching_pv
            FROM analytics_internal.events AS e
            ${analyticsUserJoinForFilteredEvents}
            WHERE e.session_replay_segment_id IS NOT NULL
              AND e.project_id = {projectId:String}
              AND e.branch_id = {branchId:String}
              AND e.event_at >= {since:DateTime}
              AND e.event_at < {untilExclusive:DateTime}
              AND e.event_type IN ('$page-view', '$click')
            GROUP BY sid
            HAVING matching_pv > 0
          )
          GROUP BY day
          ORDER BY day ASC
        `,
        query_params: {
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
        },
        format: "JSONEachRow",
      }),
      // User-Agent buckets pulled from the same `$page-view` event stream so
      // visitor counts line up with the referrer / region cards on the overview.
      // `data.user_agent` is captured client-side (navigator.userAgent), so
      // older rows that pre-date capture simply return empty here.
      clickhouseClient.query({
        query: `
          SELECT
            tupleElement(facet, 1) AS dimension,
            tupleElement(facet, 2) AS name,
            uniqExact(visitor) AS visitors
          FROM (
            SELECT
              ${analyticsVisitorKey} AS visitor,
              ${analyticsOverviewBrowserSql} AS browser,
              ${analyticsOverviewOsSql} AS os,
              ${analyticsOverviewDeviceSql} AS device
            FROM analytics_internal.events AS e
            ${analyticsUserJoinForFilteredEvents}
            WHERE e.event_type = '$page-view'
              AND e.project_id = {projectId:String}
              AND e.branch_id = {branchId:String}
              AND e.event_at >= {rangeSince:DateTime}
              AND e.event_at < {rangeUntilExclusive:DateTime}
              AND ${analyticsContributingUserFilter}
              AND ${analyticsOverviewUserAgentSql} != ''
              ${referrerFragment}
              ${countryFragment}
            -- Collapse to one row per visitor/facet combination before the
            -- ARRAY JOIN triples the row count: the buckets only need distinct
            -- visitors, and this keeps the fan-out proportional to visitors
            -- rather than to page-views.
            GROUP BY visitor, browser, os, device
          )
          ARRAY JOIN [
            ('browser', browser),
            ('os', os),
            ('device', device)
          ] AS facet
          WHERE ({browserFilterEnabled:UInt8} = 0 OR tupleElement(facet, 1) = 'browser' OR browser = {browserFilter:String})
            AND ({osFilterEnabled:UInt8} = 0 OR tupleElement(facet, 1) = 'os' OR os = {osFilter:String})
            AND ({deviceFilterEnabled:UInt8} = 0 OR tupleElement(facet, 1) = 'device' OR device = {deviceFilter:String})
          GROUP BY dimension, name
          HAVING visitors > 0
          ORDER BY dimension ASC, visitors DESC
        `,
        query_params: {
          since: formatClickhouseDateTimeParam(since),
          untilExclusive: formatClickhouseDateTimeParam(untilExclusive),
          rangeSince: formatClickhouseDateTimeParam(rangeSince),
          rangeUntilExclusive: formatClickhouseDateTimeParam(rangeUntilExclusive),
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          includeAnonymous: includeAnonymous ? 1 : 0,
          ...filterParams,
          browserFilterEnabled: filters.browser ? 1 : 0,
          browserFilter: filters.browser ?? "",
          osFilterEnabled: filters.os ? 1 : 0,
          osFilter: filters.os ?? "",
          deviceFilterEnabled: filters.device ? 1 : 0,
          deviceFilter: filters.device ?? "",
        },
        format: "JSONEachRow",
      }),
    ]);

    const dailyEventRows: { day: string, pv: number, cl: number, visitors: number }[] = await dailyEventResult.json();
    const pvByDay = new Map<string, number>();
    const clByDay = new Map<string, number>();
    const visitorByDay = new Map<string, number>();
    for (const row of dailyEventRows) {
      const key = row.day.split('T')[0];
      pvByDay.set(key, Number(row.pv));
      clByDay.set(key, Number(row.cl));
      visitorByDay.set(key, Number(row.visitors));
    }
    const hourlyEventRows: { hour: string, pv: number, active_users: number, visitors: number }[] = await hourlyEventResult.json();
    const pageViewsByHour = new Map<string, number>();
    const activeUsersByHour = new Map<string, number>();
    const visitorsByHour = new Map<string, number>();
    for (const row of hourlyEventRows) {
      const key = new Date(row.hour).toISOString().slice(0, 13);
      pageViewsByHour.set(key, Number(row.pv));
      activeUsersByHour.set(key, Number(row.active_users));
      visitorsByHour.set(key, Number(row.visitors));
    }
    const hourlyPageViews: DataPoints = [];
    const hourlyActiveUsers: DataPoints = [];
    const hourlyVisitors: DataPoints = [];
    const latestHour = new Date(now);
    latestHour.setUTCMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const hour = new Date(latestHour.getTime() - i * 60 * 60 * 1000);
      const key = hour.toISOString().slice(0, 13);
      const date = `${key}:00:00.000Z`;
      hourlyPageViews.push({ date, activity: pageViewsByHour.get(key) ?? 0 });
      hourlyActiveUsers.push({ date, activity: activeUsersByHour.get(key) ?? 0 });
      hourlyVisitors.push({ date, activity: visitorsByHour.get(key) ?? 0 });
    }
    const totalVisitorRows: { visitors: number }[] = await totalVisitorResult.json();
    const visitors = Number(totalVisitorRows[0]?.visitors ?? 0);

    const sessionRows: { day: string, sessions: string | number, bounced: string | number, avg_duration_s: string | number | null }[] = await sessionResult.json();
    const sessionsByDay = new Map<string, { sessions: number, bounced: number, avg_duration_s: number }>();
    for (const row of sessionRows) {
      const key = row.day.split('T')[0];
      sessionsByDay.set(key, {
        sessions: Number(row.sessions),
        bounced: Number(row.bounced),
        avg_duration_s: Number(row.avg_duration_s ?? 0),
      });
    }

    const dailyPageViews: DataPoints = [];
    const dailyClicks: DataPoints = [];
    const dailyVisitors: DataPoints = [];
    const dailyBounceRate: DataPoints = [];
    const dailyAvgSession: DataPoints = [];
    let totalSessions = 0;
    let totalBounced = 0;
    let totalDurationWeighted = 0;
    for (let i = 0; i <= METRICS_WINDOW_DAYS; i++) {
      const day = new Date(since.getTime() + i * ONE_DAY_MS);
      const key = day.toISOString().split('T')[0];
      dailyPageViews.push({ date: key, activity: pvByDay.get(key) ?? 0 });
      dailyClicks.push({ date: key, activity: clByDay.get(key) ?? 0 });
      dailyVisitors.push({ date: key, activity: visitorByDay.get(key) ?? 0 });
      const s = sessionsByDay.get(key);
      const sessions = s?.sessions ?? 0;
      const bounced = s?.bounced ?? 0;
      const avgDuration = s?.avg_duration_s ?? 0;
      dailyBounceRate.push({ date: key, activity: sessions > 0 ? Number(((bounced / sessions) * 100).toFixed(1)) : 0 });
      dailyAvgSession.push({ date: key, activity: Math.round(avgDuration) });
      totalSessions += sessions;
      totalBounced += bounced;
      totalDurationWeighted += avgDuration * sessions;
    }
    // Weighted (not arithmetic mean of dailies) so a high-traffic day counts
    // more than a 1-session day at 100% bounce.
    const bounceRate = totalSessions > 0 ? Number(((totalBounced / totalSessions) * 100).toFixed(1)) : 0;
    const avgSessionSeconds = totalSessions > 0 ? Number((totalDurationWeighted / totalSessions).toFixed(1)) : 0;

    const referrers: { referrer: string | null, visitors: number }[] = await referrerResult.json();
    const topRegionRows: { country_code: string, visitors: number }[] = await topRegionResult.json();
    const onlineRows: { online: number }[] = await onlineResult.json();

    const userAgentRows: { dimension: string, name: string, visitors: number | string }[] = await userAgentResult.json();
    const browserCounts = new Map<string, number>();
    const osCounts = new Map<string, number>();
    const deviceCounts = new Map<string, number>();
    for (const row of userAgentRows) {
      const visitors = Number(row.visitors);
      if (!Number.isFinite(visitors) || visitors <= 0) continue;
      if (row.dimension === "browser") {
        browserCounts.set(row.name, visitors);
      } else if (row.dimension === "os") {
        osCounts.set(row.name, visitors);
      } else if (row.dimension === "device") {
        deviceCounts.set(row.name, visitors);
      }
    }
    const toSortedTop = (m: Map<string, number>, limit: number) =>
      Array.from(m.entries())
        .map(([name, visitors]) => ({ name, visitors }))
        .sort((a, b) => b.visitors - a.visitors)
        .slice(0, limit);
    const topBrowsers = toSortedTop(browserCounts, 10);
    const topOperatingSystems = toSortedTop(osCounts, 10);
    const topDevices = toSortedTop(deviceCounts, 3);
    const topRegions = topRegionRows
      .map((row) => ({ country_code: row.country_code, count: Number(row.visitors) }))
      .filter((row) => row.country_code !== "" && row.count > 0);

    clickhouseAggregates = {
      dailyPageViews,
      dailyClicks,
      dailyVisitors,
      hourlyPageViews,
      hourlyActiveUsers,
      hourlyVisitors,
      dailyBounceRate,
      dailyAvgSession,
      visitors,
      onlineLive: Number(onlineRows[0]?.online ?? 0),
      bounceRate,
      avgSessionSeconds,
      topReferrers: referrers.map((row) => ({
        referrer: row.referrer ?? '(direct)',
        visitors: Number(row.visitors),
      })),
      topRegion: topRegionRows[0] ? {
        country_code: topRegionRows[0].country_code,
        region_code: null,
        count: Number(topRegionRows[0].visitors),
      } : null,
      topRegions,
      topBrowsers,
      topOperatingSystems,
      topDevices,
    };
  } catch (error) {
    // The analytics app is installed, so a ClickHouse failure here is a real
    // error — capture with context, then propagate so the dashboard shows its
    // error state instead of silently rendering an empty overview.
    captureError("internal-metrics-analytics-overview-clickhouse", new HexclaveAssertionError(
      "Analytics overview ClickHouse queries failed for a project with the analytics app installed.",
      {
        cause: error,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
      },
    ));
    // Rethrowing skips the `await replayPromise` below, so observe it here to
    // keep a concurrent Postgres failure from becoming an unhandled rejection.
    // (anonymousVisitorsPromise swallows its own failures and never rejects.)
    replayPromise.catch(() => {});
    throw error;
  }

  // Postgres-backed session replay query has its own error surface — let it
  // propagate naturally so we don't conflate it with "clickhouse missing".
  const replayResult = await replayPromise;
  const anonymousVisitorsResult = await anonymousVisitorsPromise;

  // daily_revenue is intentionally not populated here — it is owned by
  // payments_overview (real invoice data) and stitched into analytics_overview
  // by the response builder so the dashboard can keep reading it from a single
  // location.
  if (clickhouseAggregates == null) {
    return {
      daily_page_views: [] as DataPoints,
      daily_clicks: [] as DataPoints,
      daily_visitors: [] as DataPoints,
      hourly_page_views: [] as DataPoints,
      hourly_active_users: [] as DataPoints,
      hourly_visitors: [] as DataPoints,
      daily_anonymous_visitors_fallback: anonymousVisitorsResult.dailyVisitors,
      daily_revenue: [] as Array<{ date: string, new_cents: number, refund_cents: number }>,
      total_revenue_cents: replayResult.totalRevenueCents,
      total_replays: replayResult.total,
      recent_replays: replayResult.recent,
      visitors: 0,
      anonymous_visitors_fallback: anonymousVisitorsResult.visitors,
      avg_session_seconds: replayResult.avgSessionSeconds,
      bounce_rate: 0,
      daily_bounce_rate: [] as DataPoints,
      daily_avg_session_seconds: [] as DataPoints,
      online_live: 0,
      revenue_per_visitor: 0,
      top_referrers: [],
      top_region: null,
      top_regions: [],
      top_browsers: [],
      top_operating_systems: [],
      top_devices: [],
    };
  }

  // When the analytics app isn't installed, `clickhouseAggregates.visitors` is
  // 0 even though the fallback can surface a number. Prefer the larger of the
  // two so `revenue_per_visitor` divides by something meaningful in both
  // cases — page-view visitors when the app is wired up, anon token-refresh
  // visitors otherwise.
  const effectiveVisitors = Math.max(clickhouseAggregates.visitors, anonymousVisitorsResult.visitors);

  return {
    daily_page_views: clickhouseAggregates.dailyPageViews,
    daily_clicks: clickhouseAggregates.dailyClicks,
    daily_visitors: clickhouseAggregates.dailyVisitors,
    hourly_page_views: clickhouseAggregates.hourlyPageViews,
    hourly_active_users: clickhouseAggregates.hourlyActiveUsers,
    hourly_visitors: clickhouseAggregates.hourlyVisitors,
    daily_anonymous_visitors_fallback: anonymousVisitorsResult.dailyVisitors,
    daily_revenue: [] as Array<{ date: string, new_cents: number, refund_cents: number }>,
    total_revenue_cents: replayResult.totalRevenueCents,
    total_replays: replayResult.total,
    recent_replays: replayResult.recent,
    visitors: clickhouseAggregates.visitors,
    anonymous_visitors_fallback: anonymousVisitorsResult.visitors,
    avg_session_seconds: clickhouseAggregates.avgSessionSeconds,
    bounce_rate: clickhouseAggregates.bounceRate,
    daily_bounce_rate: clickhouseAggregates.dailyBounceRate,
    daily_avg_session_seconds: clickhouseAggregates.dailyAvgSession,
    online_live: clickhouseAggregates.onlineLive,
    revenue_per_visitor: effectiveVisitors > 0
      ? Number(((replayResult.totalRevenueCents / 100) / effectiveVisitors).toFixed(2))
      : 0,
    top_referrers: clickhouseAggregates.topReferrers,
    top_region: clickhouseAggregates.topRegion,
    top_regions: clickhouseAggregates.topRegions,
    top_browsers: clickhouseAggregates.topBrowsers,
    top_operating_systems: clickhouseAggregates.topOperatingSystems,
    top_devices: clickhouseAggregates.topDevices,
  };
}

// ── Auth Extra Aggregates ────────────────────────────────────────────────────

export async function loadAuthOverview(tenancy: Tenancy, includeAnonymous: boolean, now: Date) {
  const clickhouseClient = getClickhouseAdminClientForMetrics();

  const [usersRow, teamsRow, dailyActiveUsersSplit, dailyActiveTeamsSplit, mau] = await Promise.all([
    clickhouseClient.query({
      query: `
        SELECT
          countIf(sync_is_deleted = 0) AS total_users,
          countIf(sync_is_deleted = 0 AND is_anonymous = 1) AS anonymous_users,
          countIf(
            sync_is_deleted = 0
            AND is_anonymous = 0
            AND id IN (
              SELECT user_id
              FROM analytics_internal.contact_channels FINAL
              WHERE project_id = {projectId:String}
                AND branch_id = {branchId:String}
                AND sync_is_deleted = 0
                AND type = 'EMAIL'
                AND is_verified = 1
            )
          ) AS verified_non_anonymous_users
        FROM analytics_internal.users FINAL
        WHERE project_id = {projectId:String}
          AND branch_id = {branchId:String}
      `,
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
      },
      format: "JSONEachRow",
    }).then(async (r) => {
      const rows = await r.json() as [{
        total_users: string | number,
        anonymous_users: string | number,
        verified_non_anonymous_users: string | number,
      }];
      return rows[0];
    }),
    clickhouseClient.query({
      query: `
        SELECT countIf(sync_is_deleted = 0) AS total_teams
        FROM analytics_internal.teams FINAL
        WHERE project_id = {projectId:String}
          AND branch_id = {branchId:String}
      `,
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
      },
      format: "JSONEachRow",
    }).then(async (r) => {
      const rows = await r.json() as [{ total_teams: string | number }];
      return rows[0];
    }),
    loadDailyActiveUsersSplit(tenancy, now, includeAnonymous),
    loadDailyActiveTeamsSplit(tenancy, now),
    loadMonthlyActiveUsers(tenancy, now, includeAnonymous),
  ]);

  const totalUsers = Number(usersRow.total_users);
  const verifiedNonAnonymousUsers = Number(usersRow.verified_non_anonymous_users);
  const anonymousUsers = Number(usersRow.anonymous_users);
  const totalTeams = Number(teamsRow.total_teams);
  const nonAnonymousTotal = totalUsers - anonymousUsers;
  // total_users_filtered respects the includeAnonymous query flag so the
  // handler can use it directly without a separate count round trip.
  const totalUsersFiltered = includeAnonymous ? totalUsers : nonAnonymousTotal;

  // verified_users / unverified_users always count non-anonymous users only,
  // so they never overlap with anonymous_users (which is its own bucket).
  // Adding all three always equals totalUsers, regardless of includeAnonymous.
  return {
    verified_users: verifiedNonAnonymousUsers,
    unverified_users: nonAnonymousTotal - verifiedNonAnonymousUsers,
    anonymous_users: anonymousUsers,
    total_teams: totalTeams,
    mau,
    daily_active_users_split: dailyActiveUsersSplit,
    daily_active_teams_split: dailyActiveTeamsSplit,
    total_users_filtered: totalUsersFiltered,
  };
}

const RECENT_LIST_PAGE_SIZE = 100;
const TOP_REFERRERS_PAGE_SIZE = 100;
const TOP_REGIONS_PAGE_SIZE = 100;

export const GET = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }),
    query: yupObject({
      include_anonymous: yupString().oneOf(["true", "false"]).optional(),
      filter_country_code: yupString().optional(),
      filter_referrer: yupString().optional(),
      filter_browser: yupString().optional(),
      filter_os: yupString().optional(),
      filter_device: yupString().optional(),
      // ISO 8601 datetimes bounding the analytics top-N breakdowns (referrers,
      // regions, browsers/OS/devices); clamped to the analytics window.
      filter_since: yupString().optional(),
      filter_until: yupString().optional(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      total_users: yupNumber().integer().defined(),
      live_users: yupNumber().integer().defined(),
      daily_users: DataPointsSchema,
      daily_active_users: DataPointsSchema,
      hourly_users: DataPointsSchema,
      hourly_active_users: DataPointsSchema,
      users_by_country: yupRecord(yupString().defined(), yupNumber().defined()).defined(),
      active_users_by_country: MetricsActiveUsersByCountrySchema,
      // recently_registered/active are CRUD User objects passed through from
      // usersCrudHandlers. Validated against MetricsRecentUserSchema, which
      // covers the fields the dashboard reads — extra fields from
      // UsersCrud["Admin"]["Read"] flow through.
      recently_registered: yupArray(MetricsRecentUserSchema).defined(),
      recently_active: yupArray(MetricsRecentUserSchema).defined(),
      login_methods: yupArray(MetricsLoginMethodEntrySchema).defined(),
      auth_overview: MetricsAuthOverviewSchema,
      payments_overview: MetricsPaymentsOverviewSchema,
      email_overview: MetricsEmailOverviewSchema,
      analytics_overview: MetricsAnalyticsOverviewSchema,
    }).defined(),
  }),
  handler: async (req) => {
    const now = new Date();
    const includeAnonymous = req.query.include_anonymous === "true";
    const analyticsFilters = normalizeAnalyticsOverviewFilters({
      country_code: req.query.filter_country_code || undefined,
      referrer: req.query.filter_referrer || undefined,
      browser: req.query.filter_browser || undefined,
      os: req.query.filter_os || undefined,
      device: req.query.filter_device || undefined,
      since: req.query.filter_since || undefined,
      until: req.query.filter_until || undefined,
    });

    const [
      dailyUsers,
      dailyActiveUsers,
      hourlyUsers,
      hourlyActiveUsers,
      usersByCountry,
      activeUsersByCountry,
      liveUsers,
      recentlyRegistered,
      recentlyActive,
      loginMethods,
      authOverview,
      paymentsOverview,
      emailOverview,
      analyticsOverview,
      dailyRevenue,
    ] = await Promise.all([
      loadTotalUsers(req.auth.tenancy, now, includeAnonymous),
      loadDailyActiveUsers(req.auth.tenancy, now, includeAnonymous),
      loadHourlyUsers(req.auth.tenancy, now, includeAnonymous),
      loadHourlyActiveUsers(req.auth.tenancy, now, includeAnonymous),
      loadUsersByCountry(req.auth.tenancy, now, includeAnonymous),
      loadActiveUsersByCountry(req.auth.tenancy, now, includeAnonymous),
      loadLiveUsersCount(req.auth.tenancy, now, includeAnonymous),
      usersCrudHandlers.adminList({
        tenancy: req.auth.tenancy,
        query: {
          order_by: 'signed_up_at',
          desc: "true",
          limit: RECENT_LIST_PAGE_SIZE,
          include_anonymous: includeAnonymous ? "true" : "false",
        },
        allowedErrorTypes: [
          KnownErrors.UserNotFound,
        ],
      }).then(res => res.items),
      loadRecentlyActiveUsers(req.auth.tenancy, includeAnonymous),
      loadLoginMethods(req.auth.tenancy),
      loadAuthOverview(req.auth.tenancy, includeAnonymous, now),
      loadPaymentsOverview(req.auth.tenancy, now),
      loadEmailOverview(req.auth.tenancy, now),
      loadAnalyticsOverview(req.auth.tenancy, now, includeAnonymous, analyticsFilters),
      loadDailyRevenue(req.auth.tenancy, now),
    ] as const);

    const totalUsers = authOverview.total_users_filtered;

    // Stitch real daily revenue (from paid invoices) into analytics_overview so
    // the dashboard can read it from a single location.
    const finalAnalyticsOverview = { ...analyticsOverview, daily_revenue: dailyRevenue };

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        total_users: totalUsers,
        live_users: liveUsers,
        daily_users: dailyUsers,
        daily_active_users: dailyActiveUsers,
        hourly_users: hourlyUsers,
        hourly_active_users: hourlyActiveUsers,
        users_by_country: usersByCountry,
        active_users_by_country: activeUsersByCountry,
        recently_registered: recentlyRegistered,
        recently_active: recentlyActive,
        login_methods: loginMethods,
        auth_overview: authOverview,
        payments_overview: paymentsOverview,
        email_overview: emailOverview,
        analytics_overview: finalAnalyticsOverview,
      }
    };
  },
});
