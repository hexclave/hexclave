import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { Prisma } from "@/generated/prisma/client";
import { type Tenancy } from "@/lib/tenancies";
import {
  evaluateTvEventsIfDue,
  resolveTvEventPresentation,
  tvEventTablesAreReady,
  type TvEventPresentation,
} from "@/lib/tv-mode/events";
import { resolveTvProfile } from "@/lib/tv-mode/profiles";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, sqlQuoteIdent } from "@/prisma-client";
import {
  calculateTvEmailRates,
  calculateTvPaymentSuccessPercent,
  TV_MINIMUM_EMAIL_OUTCOMES,
  TV_MINIMUM_PAYMENT_ATTEMPTS,
  TV_SNAPSHOT_STALE_AFTER_MS,
  type TvAudienceMomentumScreen,
  type TvEmailHealthScreen,
  type TvLivePulseScreen,
  type TvProfileResource,
  type TvReportingWindow,
  type TvRevenuePaymentsScreen,
  type TvScreenSnapshot,
  type TvSnapshot,
  type TvStackedTrendPoint,
  type TvStatusFact,
  type TvTrendPoint,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAID_INVOICE_STATUSES = ["paid", "succeeded"] as const;
export const TV_NORMALIZED_SUBSCRIPTION_REVENUE_OUTCOME_FILTER = `
            AND ("markedUncollectibleAt" IS NULL OR "markedUncollectibleAt" <= "paidAt")
            AND ("voidedAt" IS NULL OR "voidedAt" <= "paidAt")`;
export const TV_LEGACY_SUBSCRIPTION_REVENUE_OUTCOME_FILTER = `
            AND "markedUncollectibleAt" IS NULL
            AND "voidedAt" IS NULL`;

// Every TV active-user aggregate must agree on what counts as an active user;
// keeping the predicate in one place stops the copies from silently diverging.
const TV_ACTIVE_USER_EVENT_FILTER = `
    event_type = '$token-refresh'
    AND project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND user_id IS NOT NULL
    AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0
`;

const TV_ACTIVE_USER_WINDOW_FILTER = `${TV_ACTIVE_USER_EVENT_FILTER}
    AND event_at >= {since:DateTime}
    AND event_at < {until:DateTime}
`;

// Keep the TV lifecycle query aligned with the memory-bounded metrics overview
// shape. Carrying raw UUIDs through DISTINCT + lagInFrame materializes one row
// per active user/day; this instead keeps one UInt64 day mask per hashed user.
// The unbounded first-activity lookup prevents established users from being
// reclassified as new merely because their first activity predates the window.
export const TV_AUDIENCE_LIFECYCLE_QUERY = `
  SELECT
    toString(addDays(toDate({since:DateTime}), idx)) AS day,
    count() AS total_count,
    countIf(f_first_date = addDays(toDate({since:DateTime}), idx)) AS new_count,
    countIf(f_first_date < addDays(toDate({since:DateTime}), idx) AND idx > 0 AND bitTest(active_days, if(idx = 0, 0, idx - 1))) AS retained_count,
    countIf(f_first_date < addDays(toDate({since:DateTime}), idx) AND (idx = 0 OR NOT bitTest(active_days, if(idx = 0, 0, idx - 1)))) AS reactivated_count
  FROM (
    SELECT activity.active_days AS active_days, first_activity.first_date AS f_first_date
    FROM (
      SELECT
        sipHash64(assumeNotNull(user_id)) AS entity_id,
        groupBitOr(bitShiftLeft(toUInt64(1), toUInt8(dateDiff('day', toDate({since:DateTime}), toDate(event_at))))) AS active_days
      FROM analytics_internal.events
      WHERE ${TV_ACTIVE_USER_WINDOW_FILTER}
      GROUP BY entity_id
    ) AS activity
    LEFT JOIN (
      SELECT
        sipHash64(assumeNotNull(user_id)) AS entity_id,
        toDate(min(event_at)) AS first_date
      FROM analytics_internal.events
      WHERE ${TV_ACTIVE_USER_EVENT_FILTER}
        AND event_at < {until:DateTime}
      GROUP BY entity_id
    ) AS first_activity USING (entity_id)
  )
  ARRAY JOIN range({windowDays:UInt32}) AS idx
  WHERE bitTest(active_days, idx)
  GROUP BY idx
  ORDER BY idx
`;

export const TV_AUDIENCE_ANALYTICS_QUERY = `
  WITH sessions AS (
    SELECT
      session_replay_segment_id AS sid,
      dateDiff('second', min(event_at), max(event_at)) AS duration_s
    FROM analytics_internal.events
    WHERE project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND event_at >= {since:DateTime}
      AND event_at < {until:DateTime}
      AND event_type IN ('$page-view', '$click')
      AND user_id IS NOT NULL
      AND session_replay_segment_id IS NOT NULL
      AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0
    GROUP BY sid
  )
  SELECT
    (
      SELECT uniqExact(assumeNotNull(user_id))
      FROM analytics_internal.events
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND event_at >= {since:DateTime}
        AND event_at < {until:DateTime}
        AND event_type = '$page-view'
        AND user_id IS NOT NULL
        AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0
    ) AS visitors,
    (SELECT count() FROM sessions) AS qualifying_sessions,
    (SELECT avgOrNull(duration_s) FROM sessions) AS average_session_seconds
`;

class TvSnapshotInvariantError extends Error {
  override name = "TvSnapshotInvariantError";
}

type TvWindowBounds = {
  currentStartsAt: Date,
  currentEndsAt: Date,
  comparisonStartsAt: Date,
  comparisonEndsAt: Date,
};

type TvAdapterResult<TScreen extends TvScreenSnapshot> =
  | { status: "success", screen: TScreen }
  | { status: "error", screen: TScreen };

type TvAudienceAnalytics = NonNullable<TvAudienceMomentumScreen["data"]>["analytics"];

export function getTvOperationalMetricsClient<T>(prisma: { $replica: () => T }): T {
  return prisma.$replica();
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentChange(current: number, comparison: number): number {
  return comparison > 0 ? roundPercent(((current - comparison) / comparison) * 100) : 0;
}

export function isTvReturningInsightEligible(newActivity: number, returningActivity: number): boolean {
  if (newActivity <= 0 || returningActivity <= newActivity) return false;
  return roundPercent(((returningActivity - newActivity) / newActivity) * 100) >= 10;
}

export function applyTvAudienceAnalytics(
  screen: TvAudienceMomentumScreen,
  analytics: TvAudienceAnalytics,
): TvAudienceMomentumScreen {
  if (screen.data == null) {
    throw new TvSnapshotInvariantError("TV Audience Analytics enrichment requires successful core audience data.");
  }
  return {
    ...screen,
    data: {
      ...screen.data,
      analytics,
    },
  };
}

export function createTvAudienceAnalyticsObservation(options: {
  observedAt: string,
  visitors: number,
  qualifyingSessions: number,
  averageSessionSeconds: number | null,
}): TvAudienceAnalytics {
  if (
    !Number.isInteger(options.visitors)
    || options.visitors < 0
    || !Number.isInteger(options.qualifyingSessions)
    || options.qualifyingSessions < 0
    || (
      options.averageSessionSeconds != null
      && (!Number.isFinite(options.averageSessionSeconds) || options.averageSessionSeconds < 0)
    )
  ) {
    throw new TvSnapshotInvariantError("TV analytics aggregate returned invalid numeric evidence.");
  }
  if ((options.qualifyingSessions === 0) !== (options.averageSessionSeconds === null)) {
    throw new TvSnapshotInvariantError("TV analytics session aggregate returned inconsistent qualification data.");
  }
  return {
    sourceStatus: options.visitors === 0 && options.qualifyingSessions === 0 ? "empty" : "ready",
    observedAt: options.observedAt,
    diagnosticCode: null,
    data: {
      visitors: options.visitors,
      qualifyingSessions: options.qualifyingSessions,
      averageSessionSeconds: options.averageSessionSeconds,
    },
  };
}

export function isTvEmailInsightEligible(
  deliveryRatePercent: number | null,
  volumeChangePercent: number,
): deliveryRatePercent is number {
  return deliveryRatePercent != null && deliveryRatePercent >= 99 && volumeChangePercent > 20;
}

function getRollingWindow(now: Date, days: number): TvWindowBounds {
  const currentEndsAt = new Date(now);
  const currentStartsAt = new Date(currentEndsAt.getTime() - days * DAY_MS);
  return {
    currentStartsAt,
    currentEndsAt,
    comparisonStartsAt: new Date(currentStartsAt.getTime() - days * DAY_MS),
    comparisonEndsAt: currentStartsAt,
  };
}

export function getTvAudienceWindowBounds(now: Date): TvWindowBounds {
  return getRollingWindow(now, 7);
}

function reportingWindow(bounds: TvWindowBounds, days: number): TvReportingWindow {
  return {
    current: {
      startsAt: bounds.currentStartsAt.toISOString(),
      endsAt: bounds.currentEndsAt.toISOString(),
      label: `Trailing ${days} days`,
    },
    comparison: {
      startsAt: bounds.comparisonStartsAt.toISOString(),
      endsAt: bounds.comparisonEndsAt.toISOString(),
      label: `Previous ${days} days`,
    },
  };
}

function currentDayWindow(now: Date): TvReportingWindow {
  const startsAt = new Date(now);
  startsAt.setUTCHours(0, 0, 0, 0);
  return {
    current: {
      startsAt: startsAt.toISOString(),
      endsAt: now.toISOString(),
      label: "Today · UTC",
    },
    comparison: null,
  };
}

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function dayLabel(dateString: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${dateString}T00:00:00.000Z`));
}

export function getTvAudienceLifecycleSince(currentEndsAt: Date): Date {
  // Lifecycle columns are UTC calendar days, while the other audience metrics
  // intentionally keep their rolling seven-day window bounds.
  const firstRenderedDay = new Date(currentEndsAt);
  firstRenderedDay.setUTCHours(0, 0, 0, 0);
  firstRenderedDay.setUTCDate(firstRenderedDay.getUTCDate() - 6);
  return firstRenderedDay;
}

function dateKeys(bounds: TvWindowBounds, count: number): string[] {
  const firstDay = new Date(bounds.currentEndsAt);
  firstDay.setUTCHours(0, 0, 0, 0);
  firstDay.setUTCDate(firstDay.getUTCDate() - (count - 1));
  return Array.from({ length: count }, (_, index) => (
    new Date(firstDay.getTime() + index * DAY_MS).toISOString().slice(0, 10)
  ));
}

function normalizeTrend(points: TvTrendPoint[]): TvTrendPoint[] {
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (maximum === minimum) return points.map((point) => ({ label: point.label, value: 100 }));
  return points.map((point) => ({
    label: point.label,
    value: Math.round(80 + ((point.value - minimum) / (maximum - minimum)) * 40),
  }));
}

export function buildCumulativeRevenueTrend(bounds: TvWindowBounds, revenueByDay: Map<string, number>): TvTrendPoint[] {
  if (bounds.currentEndsAt <= bounds.currentStartsAt) {
    throw new TvSnapshotInvariantError("TV revenue trend requires a non-empty reporting window.");
  }
  const firstDay = new Date(bounds.currentStartsAt);
  firstDay.setUTCHours(0, 0, 0, 0);
  // The range is timestamp-based and can touch 31 UTC dates. Use the last
  // included instant so a midnight-exclusive end does not add an empty day.
  const lastDay = new Date(bounds.currentEndsAt.getTime() - 1);
  lastDay.setUTCHours(0, 0, 0, 0);
  const dayCount = Math.floor((lastDay.getTime() - firstDay.getTime()) / DAY_MS) + 1;
  const daily = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(firstDay.getTime() + index * DAY_MS);
    const key = date.toISOString().slice(0, 10);
    return { date, value: revenueByDay.get(key) ?? 0 };
  });
  let cumulative = 0;
  const cumulativeDaily = daily.map((point) => {
    cumulative += point.value;
    return { ...point, value: cumulative };
  });
  const sampleIndexes = Array.from({ length: 7 }, (_, index) => (
    Math.round(index * (cumulativeDaily.length - 1) / 6)
  ));
  return sampleIndexes.map((index) => {
    const point = cumulativeDaily.at(index);
    if (point == null) throw new TvSnapshotInvariantError("TV revenue trend sample index is outside its reporting series.");
    return {
      label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(point.date),
      value: point.value,
    };
  });
}

function errorScreen<TScreen extends TvScreenSnapshot>(
  screen: TScreen,
  adapterName: string,
  cause: unknown,
  tenancy: Tenancy,
): TvAdapterResult<TScreen> {
  captureError(`tv-snapshot-${adapterName}-failed`, new HexclaveAssertionError(
    `TV snapshot ${adapterName} adapter failed.`,
    {
      cause,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
    },
  ));
  return {
    status: "error",
    screen: {
      ...screen,
      sourceStatus: "error",
      diagnosticCode: "source-query-failed",
      data: null,
      insight: null,
    },
  };
}

export function createTvLivePulseErrorScreen(now: Date): TvLivePulseScreen {
  return {
    id: "live-pulse",
    sourceStatus: "error",
    sourceLabel: "Hexclave activity",
    observedAt: now.toISOString(),
    window: currentDayWindow(now),
    diagnosticCode: "source-query-failed",
    data: null,
    insight: null,
  };
}

export function createReadyTvLivePulseScreen(options: {
  now: Date,
  liveUsers: number,
  todayActiveUsers: number,
  hourlyActivity: TvTrendPoint[],
}): TvLivePulseScreen {
  const currentHour = new Date(options.now);
  currentHour.setUTCMinutes(0, 0, 0);
  return {
    id: "live-pulse",
    sourceStatus: "ready",
    sourceLabel: "Hexclave activity",
    observedAt: options.now.toISOString(),
    window: currentDayWindow(options.now),
    diagnosticCode: null,
    data: {
      liveUsers: options.liveUsers,
      todayActiveUsers: options.todayActiveUsers,
      hourlyActivity: options.hourlyActivity.length > 0 ? options.hourlyActivity : [{
        label: currentHour.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        }),
        value: 0,
      }],
      sourceHealth: [],
    },
    insight: null,
  };
}

async function loadActivityScreens(
  tenancy: Tenancy,
  now: Date,
): Promise<{ livePulse: TvAdapterResult<TvLivePulseScreen>, audience: TvAdapterResult<TvAudienceMomentumScreen> }> {
  const observedAt = now.toISOString();
  const sevenDayBounds = getTvAudienceWindowBounds(now);
  const emptyLive = createTvLivePulseErrorScreen(now);
  const emptyAudience: TvAudienceMomentumScreen = {
    id: "audience-momentum",
    sourceStatus: "error",
    sourceLabel: "Hexclave users & analytics",
    observedAt,
    window: reportingWindow(sevenDayBounds, 7),
    diagnosticCode: "source-query-failed",
    data: null,
    insight: null,
  };

  try {
    const todayStartsAt = new Date(now);
    todayStartsAt.setUTCHours(0, 0, 0, 0);
    const monthlyStartsAt = new Date(now.getTime() - 30 * DAY_MS);
    const clickhouse = getClickhouseAdminClientForMetrics();
    const liveActivityQuery = Promise.all([
      clickhouse.query({
        query: `
          SELECT uniqExact(assumeNotNull(user_id)) AS live_users
          FROM analytics_internal.events
          WHERE ${TV_ACTIVE_USER_WINDOW_FILTER}
        `,
        query_params: {
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          since: formatClickhouseDateTime(new Date(now.getTime() - 2 * 60 * 1000)),
          until: formatClickhouseDateTime(now),
        },
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: `
          SELECT toStartOfHour(event_at) AS hour,
            uniqExact(assumeNotNull(user_id)) AS active_users
          FROM analytics_internal.events
          WHERE ${TV_ACTIVE_USER_WINDOW_FILTER}
          GROUP BY hour
          ORDER BY hour
        `,
        query_params: {
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          since: formatClickhouseDateTime(todayStartsAt),
          until: formatClickhouseDateTime(now),
        },
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: `
          SELECT uniqExact(assumeNotNull(user_id)) AS today_active_users
          FROM analytics_internal.events
          WHERE ${TV_ACTIVE_USER_WINDOW_FILTER}
        `,
        query_params: {
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          since: formatClickhouseDateTime(todayStartsAt),
          until: formatClickhouseDateTime(now),
        },
        format: "JSONEachRow",
      }),
    ]);
    const audienceActivityQuery = Promise.all([
      clickhouse.query({
        query: `
          SELECT
            countIf(sync_is_deleted = 0 AND is_anonymous = 0) AS total_users,
            countIf(
              sync_is_deleted = 0
              AND is_anonymous = 0
              AND signed_up_at >= {currentSince:DateTime}
              AND signed_up_at < {currentUntil:DateTime}
            ) AS current_new_users,
            (
              SELECT uniqExact(id)
              FROM analytics_internal.users
              WHERE project_id = {projectId:String}
                AND branch_id = {branchId:String}
                AND sync_is_deleted = 1
                AND is_anonymous = 0
                AND signed_up_at < {currentSince:DateTime}
                AND sync_created_at >= {currentSince:DateTime}
                AND sync_created_at < {currentUntil:DateTime}
            ) AS deleted_existing_users,
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
            ) AS verified_users
          FROM analytics_internal.users FINAL
          WHERE project_id = {projectId:String}
            AND branch_id = {branchId:String}
        `,
        query_params: {
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          currentSince: formatClickhouseDateTime(sevenDayBounds.currentStartsAt),
          currentUntil: formatClickhouseDateTime(sevenDayBounds.currentEndsAt),
        },
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: TV_AUDIENCE_LIFECYCLE_QUERY,
        query_params: {
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          since: formatClickhouseDateTime(getTvAudienceLifecycleSince(sevenDayBounds.currentEndsAt)),
          until: formatClickhouseDateTime(sevenDayBounds.currentEndsAt),
          windowDays: 7,
        },
        format: "JSONEachRow",
      }),
      clickhouse.query({
        query: `
          SELECT uniqExact(assumeNotNull(user_id)) AS mau
          FROM analytics_internal.events
          WHERE ${TV_ACTIVE_USER_WINDOW_FILTER}
        `,
        query_params: {
          projectId: tenancy.project.id,
          branchId: tenancy.branchId,
          since: formatClickhouseDateTime(monthlyStartsAt),
          until: formatClickhouseDateTime(now),
        },
        format: "JSONEachRow",
      }),
    ]);
    const [liveActivity, audienceActivity] = await Promise.allSettled([
      liveActivityQuery,
      audienceActivityQuery,
    ]);
    const liveActivityError = liveActivity.status === "rejected" ? liveActivity.reason : null;
    const audienceActivityError = audienceActivity.status === "rejected" ? audienceActivity.reason : null;
    if (liveActivityError != null && audienceActivityError != null) {
      return {
        livePulse: errorScreen(emptyLive, "users-activity", liveActivityError, tenancy),
        audience: errorScreen(emptyAudience, "users-activity", audienceActivityError, tenancy),
      };
    }
    const liveRowsQuery = liveActivity.status === "fulfilled"
      ? Promise.all([
        liveActivity.value[0].json<{ live_users: number | string }>(),
        liveActivity.value[1].json<{ hour: string, active_users: number | string }>(),
        liveActivity.value[2].json<{ today_active_users: number | string }>(),
      ])
      : Promise.reject(new TvSnapshotInvariantError("TV live activity query group did not return all responses."));
    const audienceRowsQuery = audienceActivity.status === "fulfilled"
      ? Promise.all([
        audienceActivity.value[0].json<{
          total_users: number | string,
          current_new_users: number | string,
          deleted_existing_users: number | string,
          verified_users: number | string,
        }>(),
        audienceActivity.value[1].json<{
          day: string,
          total_count: number | string,
          new_count: number | string,
          retained_count: number | string,
          reactivated_count: number | string,
        }>(),
        audienceActivity.value[2].json<{ mau: number | string }>(),
      ])
      : Promise.reject(new TvSnapshotInvariantError("TV audience query group did not return all responses."));
    const [liveRowsResult, audienceRowsResult] = await Promise.allSettled([
      liveRowsQuery,
      audienceRowsQuery,
    ]);
    const liveRowsError = liveRowsResult.status === "rejected" ? liveRowsResult.reason : null;
    const audienceRowsError = audienceRowsResult.status === "rejected" ? audienceRowsResult.reason : null;
    const liveRows = liveRowsResult.status === "fulfilled" ? liveRowsResult.value[0] : [];
    const hourlyRows = liveRowsResult.status === "fulfilled" ? liveRowsResult.value[1] : [];
    const todayRows = liveRowsResult.status === "fulfilled" ? liveRowsResult.value[2] : [];
    const usersRows = audienceRowsResult.status === "fulfilled" ? audienceRowsResult.value[0] : [];
    const lifecycleRows = audienceRowsResult.status === "fulfilled" ? audienceRowsResult.value[1] : [];
    const mauRows = audienceRowsResult.status === "fulfilled" ? audienceRowsResult.value[2] : [];
    const liveRow = liveRows.at(0);
    const todayRow = todayRows.at(0);
    const livePulse = liveActivityError != null || liveRowsError != null || liveRow == null || todayRow == null
      ? errorScreen(emptyLive, "users-activity", liveActivityError ?? liveRowsError ?? new TvSnapshotInvariantError("TV live activity aggregate returned no summary row."), tenancy)
      : (() => {
        const liveUsers = Number(liveRow.live_users);
        const todayHourly = hourlyRows.map((point) => ({
          // ClickHouse's default DateTime text has no zone marker. The source is
          // queried in UTC, so make that explicit before JavaScript parses it.
          label: new Date(`${point.hour.replace(" ", "T")}Z`).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }),
          value: Number(point.active_users),
        }));
        return {
          status: "success" as const,
          screen: createReadyTvLivePulseScreen({
            now,
            liveUsers,
            todayActiveUsers: Number(todayRow.today_active_users),
            hourlyActivity: todayHourly,
          }),
        };
      })();
    const lifecycleByDate = new Map(lifecycleRows.map((row) => [row.day.slice(0, 10), {
      primary: Number(row.new_count),
      secondary: Number(row.retained_count),
      tertiary: Number(row.reactivated_count),
    }]));

    const lifecycle = dateKeys(sevenDayBounds, 7).map((date): TvStackedTrendPoint => ({
      label: dayLabel(date),
      primary: lifecycleByDate.get(date)?.primary ?? 0,
      secondary: lifecycleByDate.get(date)?.secondary ?? 0,
      tertiary: lifecycleByDate.get(date)?.tertiary ?? 0,
    }));
    const users = usersRows.at(0);
    const mauRow = mauRows.at(0);
    const audience = audienceActivityError != null || audienceRowsError != null || users == null || mauRow == null
      ? errorScreen(emptyAudience, "users-activity", audienceActivityError ?? audienceRowsError ?? new TvSnapshotInvariantError("TV audience aggregate returned no summary row."), tenancy)
      : (() => {
        const totalUsers = Number(users.total_users);
        const currentNewUsers = Number(users.current_new_users);
        const previousTotalUsers = totalUsers - currentNewUsers + Number(users.deleted_existing_users);
        const currentReturning = lifecycle.reduce((sum, point) => sum + point.secondary + point.tertiary, 0);
        const currentNewActivity = lifecycle.reduce((sum, point) => sum + point.primary, 0);
        const returningLeadMarginPercent = currentNewActivity > 0
          ? roundPercent(((currentReturning - currentNewActivity) / currentNewActivity) * 100)
          : 0;
        const verificationRatePercent = totalUsers > 0
          ? roundPercent((Number(users.verified_users) / totalUsers) * 100)
          : 0;
        const hasAudience = totalUsers > 0;
        const screen: TvAudienceMomentumScreen = {
          ...emptyAudience,
          sourceStatus: hasAudience ? "ready" : "empty",
          diagnosticCode: null,
          data: hasAudience ? {
            totalUsers,
            userGrowthPercent: percentChange(totalUsers, Math.max(0, previousTotalUsers)),
            newUsers: currentNewUsers,
            monthlyActiveUsers: Number(mauRow.mau),
            verificationRatePercent,
            lifecycle,
            analytics: {
              sourceStatus: "error",
              observedAt,
              diagnosticCode: "analytics-not-loaded",
              data: null,
            },
          } : null,
          insight: hasAudience && isTvReturningInsightEligible(currentNewActivity, currentReturning) ? {
            kind: "returning-users-leading",
            message: "Audience momentum is being driven primarily by returning users.",
            evidence: {
              newActivity: currentNewActivity,
              retainedActivity: lifecycle.reduce((sum, point) => sum + point.secondary, 0),
              reactivatedActivity: lifecycle.reduce((sum, point) => sum + point.tertiary, 0),
              leadMarginPercent: returningLeadMarginPercent,
            },
          } : null,
        };
        return { status: "success" as const, screen };
      })();
    return {
      livePulse,
      audience,
    };
  } catch (cause) {
    if (cause instanceof TvSnapshotInvariantError) throw cause;
    return {
      livePulse: errorScreen(emptyLive, "users-activity", cause, tenancy),
      audience: errorScreen(emptyAudience, "users-activity", cause, tenancy),
    };
  }
}

async function loadAnalyticsIntoAudience(
  tenancy: Tenancy,
  now: Date,
  audienceResult: TvAdapterResult<TvAudienceMomentumScreen>,
): Promise<TvAdapterResult<TvAudienceMomentumScreen>> {
  if (audienceResult.screen.data == null) return audienceResult;
  if (!(tenancy.config.apps.installed.analytics?.enabled ?? false)) {
    return {
      status: "success",
      screen: applyTvAudienceAnalytics(audienceResult.screen, {
        sourceStatus: "unavailable",
        observedAt: now.toISOString(),
        diagnosticCode: "analytics-app-disabled",
        data: null,
      }),
    };
  }
  const bounds = getRollingWindow(now, 7);
  try {
    const result = await getClickhouseAdminClientForMetrics().query({
      query: TV_AUDIENCE_ANALYTICS_QUERY,
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        since: formatClickhouseDateTime(bounds.currentStartsAt),
        until: formatClickhouseDateTime(bounds.currentEndsAt),
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<{
      visitors: number | string,
      qualifying_sessions: number | string,
      average_session_seconds: number | string | null,
    }>();
    const row = rows.at(0);
    if (row == null) throw new TvSnapshotInvariantError("TV analytics aggregate returned no summary row.");
    const visitors = Number(row.visitors);
    const qualifyingSessions = Number(row.qualifying_sessions);
    const averageSessionSeconds = row.average_session_seconds == null
      ? null
      : Math.round(Number(row.average_session_seconds));
    return {
      status: "success",
      screen: applyTvAudienceAnalytics(audienceResult.screen, createTvAudienceAnalyticsObservation({
        observedAt: now.toISOString(),
        visitors,
        qualifyingSessions,
        averageSessionSeconds,
      })),
    };
  } catch (cause) {
    if (cause instanceof TvSnapshotInvariantError) throw cause;
    captureError("tv-snapshot-analytics-failed", new HexclaveAssertionError(
      "TV snapshot analytics enrichment failed.",
      { cause, projectId: tenancy.project.id, branchId: tenancy.branchId },
    ));
    return {
      status: "success",
      screen: applyTvAudienceAnalytics(audienceResult.screen, {
        sourceStatus: "error",
        observedAt: now.toISOString(),
        diagnosticCode: "source-query-failed",
        data: null,
      }),
    };
  }
}

async function loadRevenueScreen(
  tenancy: Tenancy,
  now: Date,
  financialVisibility: "redacted" | "exact",
): Promise<TvAdapterResult<TvRevenuePaymentsScreen>> {
  const observedAt = now.toISOString();
  const bounds = getRollingWindow(now, 30);
  const emptyScreen: TvRevenuePaymentsScreen = {
    id: "revenue-payments",
    sourceStatus: "error",
    sourceLabel: "Hexclave payments",
    observedAt,
    window: reportingWindow(bounds, 30),
    diagnosticCode: "source-query-failed",
    data: null,
    insight: null,
  };
  if (!(tenancy.config.apps.installed.payments?.enabled ?? false)) {
    return {
      status: "success",
      screen: { ...emptyScreen, sourceStatus: "unavailable", diagnosticCode: "payments-app-disabled" },
    };
  }

  try {
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const prisma = await getPrismaClientForTenancy(tenancy);
    const metricsPrisma = getTvOperationalMetricsClient(prisma);
    const successfulStatuses = PAID_INVOICE_STATUSES;
    const [summaryRows, trendRows] = await Promise.all([
      metricsPrisma.$queryRaw<[{
        current_revenue: bigint,
        previous_revenue: bigint,
        applicable_attempts: number,
        successful_attempts: number,
        active_subscriptions: number,
        new_subscriptions: number,
        past_due_subscriptions: number,
        unsupported_currencies: number,
        invalid_normalized_facts: number,
        invalid_legacy_facts: number,
      }]>`
        WITH normalized_subscription_revenue AS (
          SELECT "paidAt" AS occurred_at, "amountPaid"::BIGINT AS amount
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" >= ${bounds.comparisonStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
            AND "amountPaid" IS NOT NULL
            AND "currency" = 'USD'
            ${Prisma.raw(TV_NORMALIZED_SUBSCRIPTION_REVENUE_OUTCOME_FILTER)}
        ), legacy_subscription_revenue AS (
          SELECT "createdAt" AS occurred_at, COALESCE("amountTotal", 0)::BIGINT AS amount
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" IS NULL
            ${Prisma.raw(TV_LEGACY_SUBSCRIPTION_REVENUE_OUTCOME_FILTER)}
            AND "status" IN (${successfulStatuses[0]}, ${successfulStatuses[1]})
            AND "createdAt" >= ${bounds.comparisonStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND COALESCE("currency", 'USD') = 'USD'
        ), normalized_purchase_revenue AS (
          SELECT "paidAt" AS occurred_at, "amountReceived"::BIGINT AS amount
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" >= ${bounds.comparisonStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
            AND "amountReceived" IS NOT NULL
            AND "currency" = 'USD'
        ), legacy_purchase_revenue AS (
          SELECT "createdAt" AS occurred_at,
            ROUND((("product"->'prices'->"priceId"->>'USD')::NUMERIC) * "quantity" * 100)::BIGINT AS amount
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" IS NULL
            AND "createdAt" >= ${bounds.comparisonStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND COALESCE("currency", 'USD') = 'USD'
            AND ("product"->'prices'->"priceId"->>'USD') ~ '^[0-9]+(\\.[0-9]+)?$'
        ), revenue_events AS (
          SELECT * FROM normalized_subscription_revenue
          UNION ALL
          SELECT * FROM legacy_subscription_revenue
          UNION ALL
          SELECT * FROM normalized_purchase_revenue
          UNION ALL
          SELECT * FROM legacy_purchase_revenue
        ), raw_health_candidates AS (
          SELECT "id", "paidAt", "markedUncollectibleAt", "voidedAt", "amountPaid", "amountTotal"
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" >= ${bounds.currentStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
          UNION ALL
          SELECT "id", "paidAt", "markedUncollectibleAt", "voidedAt", "amountPaid", "amountTotal"
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "markedUncollectibleAt" >= ${bounds.currentStartsAt}
            AND "markedUncollectibleAt" < ${bounds.currentEndsAt}
        ), normalized_health_candidates AS (
          SELECT DISTINCT ON ("id") *
          FROM raw_health_candidates
          ORDER BY "id"
        ), selected_health AS (
          SELECT *, GREATEST("paidAt", "markedUncollectibleAt", "voidedAt") AS outcome_at
          FROM normalized_health_candidates
        ), invoice_health AS (
          SELECT COALESCE("paidAt" = outcome_at, FALSE) AS success
          FROM selected_health
          WHERE outcome_at >= ${bounds.currentStartsAt}
            AND outcome_at < ${bounds.currentEndsAt}
            AND (
              -- Paid outcomes represent collected value; uncollectible
              -- outcomes represent attempted value that failed collection.
              ("paidAt" = outcome_at AND COALESCE("amountPaid", 0) > 0)
              OR (
                "paidAt" IS DISTINCT FROM outcome_at
                AND "voidedAt" IS DISTINCT FROM outcome_at
                AND "markedUncollectibleAt" = outcome_at
                AND COALESCE("amountTotal", 0) > 0
              )
            )
          UNION ALL
          SELECT ("status" IN (${successfulStatuses[0]}, ${successfulStatuses[1]})) AS success
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" IS NULL
            AND "markedUncollectibleAt" IS NULL
            AND "voidedAt" IS NULL
            AND "createdAt" >= ${bounds.currentStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND "status" IN (${successfulStatuses[0]}, ${successfulStatuses[1]}, 'uncollectible')
            AND COALESCE("amountTotal", 0) > 0
        ), unsupported_currency_events AS (
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" >= ${bounds.comparisonStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
            AND "currency" IS NOT NULL
            AND "currency" <> 'USD'
          UNION ALL
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" IS NULL
            AND "status" IN (${successfulStatuses[0]}, ${successfulStatuses[1]})
            AND "createdAt" >= ${bounds.comparisonStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND "currency" IS NOT NULL
            AND "currency" <> 'USD'
          UNION ALL
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" >= ${bounds.comparisonStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
            AND "currency" IS NOT NULL
            AND "currency" <> 'USD'
          UNION ALL
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" IS NULL
            AND "createdAt" >= ${bounds.comparisonStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND "currency" IS NOT NULL
            AND "currency" <> 'USD'
        ), invalid_normalized_events AS (
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" >= ${bounds.comparisonStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
            AND ("amountPaid" IS NULL OR "currency" IS NULL)
          UNION ALL
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" >= ${bounds.comparisonStartsAt}
            AND "paidAt" < ${bounds.currentEndsAt}
            AND ("amountReceived" IS NULL OR "currency" IS NULL)
        ), invalid_legacy_events AS (
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" IS NULL
            AND "status" IN (${successfulStatuses[0]}, ${successfulStatuses[1]})
            AND "createdAt" >= ${bounds.comparisonStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND "amountTotal" IS NULL
          UNION ALL
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" IS NULL
            AND "createdAt" >= ${bounds.comparisonStartsAt}
            AND "createdAt" < ${bounds.currentEndsAt}
            AND (
              ("product"->'prices'->"priceId"->>'USD') IS NULL
              OR ("product"->'prices'->"priceId"->>'USD') !~ '^[0-9]+(\\.[0-9]+)?$'
            )
        )
        SELECT
          (SELECT COALESCE(SUM(amount), 0)::BIGINT FROM revenue_events
            WHERE occurred_at >= ${bounds.currentStartsAt} AND occurred_at < ${bounds.currentEndsAt}) AS current_revenue,
          (SELECT COALESCE(SUM(amount), 0)::BIGINT FROM revenue_events
            WHERE occurred_at >= ${bounds.comparisonStartsAt} AND occurred_at < ${bounds.comparisonEndsAt}) AS previous_revenue,
          (SELECT COUNT(*)::int FROM invoice_health) AS applicable_attempts,
          (SELECT COUNT(*) FILTER (WHERE success)::int FROM invoice_health) AS successful_attempts,
          (SELECT COUNT(*)::int FROM ${sqlQuoteIdent(schema)}."Subscription"
            WHERE "tenancyId" = ${tenancy.id}::UUID AND "status" = 'active'::${sqlQuoteIdent(schema)}."SubscriptionStatus") AS active_subscriptions,
          (SELECT COUNT(*)::int FROM ${sqlQuoteIdent(schema)}."Subscription"
            WHERE "tenancyId" = ${tenancy.id}::UUID
              AND "createdAt" >= ${bounds.currentStartsAt}
              AND "createdAt" < ${bounds.currentEndsAt}) AS new_subscriptions,
          (SELECT COUNT(*)::int FROM ${sqlQuoteIdent(schema)}."Subscription"
            WHERE "tenancyId" = ${tenancy.id}::UUID AND "status" = 'past_due'::${sqlQuoteIdent(schema)}."SubscriptionStatus") AS past_due_subscriptions
          ,(SELECT COUNT(*)::int FROM unsupported_currency_events) AS unsupported_currencies,
          (SELECT COUNT(*)::int FROM invalid_normalized_events) AS invalid_normalized_facts,
          (SELECT COUNT(*)::int FROM invalid_legacy_events) AS invalid_legacy_facts
      `,
      metricsPrisma.$queryRaw<{ day: string, revenue: bigint }[]>`
        WITH revenue_events AS (
          SELECT "paidAt" AS occurred_at, "amountPaid"::BIGINT AS amount
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID
            AND "paidAt" >= ${bounds.currentStartsAt} AND "paidAt" < ${bounds.currentEndsAt}
            AND "amountPaid" IS NOT NULL AND "currency" = 'USD'
            ${Prisma.raw(TV_NORMALIZED_SUBSCRIPTION_REVENUE_OUTCOME_FILTER)}
          UNION ALL
          SELECT "createdAt", COALESCE("amountTotal", 0)::BIGINT
          FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
          WHERE "tenancyId" = ${tenancy.id}::UUID AND "paidAt" IS NULL
            ${Prisma.raw(TV_LEGACY_SUBSCRIPTION_REVENUE_OUTCOME_FILTER)}
            AND "status" IN (${successfulStatuses[0]}, ${successfulStatuses[1]})
            AND "createdAt" >= ${bounds.currentStartsAt} AND "createdAt" < ${bounds.currentEndsAt}
            AND COALESCE("currency", 'USD') = 'USD'
          UNION ALL
          SELECT "paidAt", "amountReceived"::BIGINT
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" >= ${bounds.currentStartsAt} AND "paidAt" < ${bounds.currentEndsAt}
            AND "amountReceived" IS NOT NULL AND "currency" = 'USD'
          UNION ALL
          SELECT "createdAt", ROUND((("product"->'prices'->"priceId"->>'USD')::NUMERIC) * "quantity" * 100)::BIGINT
          FROM ${sqlQuoteIdent(schema)}."OneTimePurchase"
          WHERE "tenancyId" = ${tenancy.id}::UUID AND "creationSource" = 'PURCHASE_PAGE'::${sqlQuoteIdent(schema)}."PurchaseCreationSource"
            AND "paidAt" IS NULL
            AND "createdAt" >= ${bounds.currentStartsAt} AND "createdAt" < ${bounds.currentEndsAt}
            AND COALESCE("currency", 'USD') = 'USD'
            AND ("product"->'prices'->"priceId"->>'USD') ~ '^[0-9]+(\\.[0-9]+)?$'
        )
        SELECT TO_CHAR(occurred_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(amount), 0)::BIGINT AS revenue
        FROM revenue_events
        GROUP BY day
        ORDER BY day
      `,
    ]);
    const summary = summaryRows[0];
    assertTvRevenueFactsAreTrustworthy({
      unsupportedCurrencies: Number(summary.unsupported_currencies),
      invalidNormalizedFacts: Number(summary.invalid_normalized_facts),
      invalidLegacyFacts: Number(summary.invalid_legacy_facts),
    });
    const currentRevenue = Number(summary.current_revenue);
    const previousRevenue = Number(summary.previous_revenue);
    const attempts = Number(summary.applicable_attempts);
    const successes = Number(summary.successful_attempts);
    const paymentSuccessPercent = calculateTvPaymentSuccessPercent(attempts, successes);
    const revenueByDay = new Map(trendRows.map((row) => [row.day, Number(row.revenue)]));
    const revenueTrend = buildCumulativeRevenueTrend(bounds, revenueByDay);
    const revenueChangePercent = percentChange(currentRevenue, previousRevenue);
    const hasPaymentData = hasTvPaymentData({
      applicableAttempts: attempts,
      currentRevenue,
      activeSubscriptions: Number(summary.active_subscriptions),
      newSubscriptions: Number(summary.new_subscriptions),
      pastDueSubscriptions: Number(summary.past_due_subscriptions),
    });
    const screen: TvRevenuePaymentsScreen = {
      ...emptyScreen,
      sourceStatus: !hasPaymentData ? "empty" : attempts < TV_MINIMUM_PAYMENT_ATTEMPTS ? "insufficient-data" : "ready",
      diagnosticCode: null,
      data: hasPaymentData ? {
        financials: financialVisibility === "exact" ? {
          visibility: "exact",
          paidRevenueCents: currentRevenue,
          revenueTrend,
        } : {
          visibility: "redacted",
          direction: revenueChangePercent > 0 ? "up" : revenueChangePercent < 0 ? "down" : "flat",
          normalizedRevenueTrend: normalizeTrend(revenueTrend),
        },
        revenueChangePercent,
        activeSubscriptions: Number(summary.active_subscriptions),
        newSubscriptions: Number(summary.new_subscriptions),
        pastDueSubscriptions: Number(summary.past_due_subscriptions),
        paymentSuccess: { applicableAttempts: attempts, percent: paymentSuccessPercent },
      } : null,
      insight: hasPaymentData && paymentSuccessPercent != null && revenueChangePercent > 0 && paymentSuccessPercent >= 95 ? {
        kind: "revenue-up-payments-stable",
        message: "Gross collected revenue increased while subscription collection remained stable.",
        evidence: {
          revenueChangePercent,
          paymentSuccessPercent,
          applicablePaymentAttempts: attempts,
        },
      } : null,
    };
    return { status: "success", screen };
  } catch (cause) {
    if (cause instanceof TvSnapshotInvariantError) throw cause;
    return errorScreen(emptyScreen, "payments", cause, tenancy);
  }
}

async function loadEmailScreen(tenancy: Tenancy, now: Date): Promise<TvAdapterResult<TvEmailHealthScreen>> {
  const observedAt = now.toISOString();
  const bounds = getRollingWindow(now, 7);
  const emptyScreen: TvEmailHealthScreen = {
    id: "email-health",
    sourceStatus: "error",
    sourceLabel: "Hexclave email",
    observedAt,
    window: reportingWindow(bounds, 7),
    diagnosticCode: "source-query-failed",
    data: null,
    insight: null,
  };
  if (!(tenancy.config.apps.installed.emails?.enabled ?? false)) {
    return {
      status: "success",
      screen: { ...emptyScreen, sourceStatus: "unavailable", diagnosticCode: "emails-app-disabled" },
    };
  }

  try {
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const prisma = await getPrismaClientForTenancy(tenancy);
    const metricsPrisma = getTvOperationalMetricsClient(prisma);
    const [summaryRows, trendRows] = await Promise.all([
      metricsPrisma.$queryRaw<[{
        current_finished: number,
        previous_finished: number,
        delivered: number,
        bounced: number,
        errors: number,
        in_progress: number,
      }]>`
        SELECT
          COUNT(*) FILTER (
            WHERE "createdAt" >= ${bounds.currentStartsAt}
              AND "createdAt" < ${bounds.currentEndsAt}
              AND "finishedSendingAt" IS NOT NULL
          )::int AS current_finished,
          COUNT(*) FILTER (
            WHERE "createdAt" >= ${bounds.comparisonStartsAt}
              AND "createdAt" < ${bounds.comparisonEndsAt}
              AND "finishedSendingAt" IS NOT NULL
          )::int AS previous_finished,
          COUNT(*) FILTER (
            WHERE "createdAt" >= ${bounds.currentStartsAt}
              AND "createdAt" < ${bounds.currentEndsAt}
              AND "deliveredAt" IS NOT NULL
              AND "bouncedAt" IS NULL
              AND "sendServerErrorExternalMessage" IS NULL
          )::int AS delivered,
          COUNT(*) FILTER (
            WHERE "createdAt" >= ${bounds.currentStartsAt}
              AND "createdAt" < ${bounds.currentEndsAt}
              AND "bouncedAt" IS NOT NULL
          )::int AS bounced,
          COUNT(*) FILTER (
            WHERE "createdAt" >= ${bounds.currentStartsAt}
              AND "createdAt" < ${bounds.currentEndsAt}
              AND "bouncedAt" IS NULL
              AND "sendServerErrorExternalMessage" IS NOT NULL
          )::int AS errors,
          COUNT(*) FILTER (
            WHERE "createdAt" < ${bounds.currentEndsAt}
              AND "simpleStatus" = 'IN_PROGRESS'::${sqlQuoteIdent(schema)}."EmailOutboxSimpleStatus"
          )::int AS in_progress
        FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND (
            "createdAt" >= ${bounds.comparisonStartsAt}
            OR "simpleStatus" = 'IN_PROGRESS'::${sqlQuoteIdent(schema)}."EmailOutboxSimpleStatus"
          )
      `,
      metricsPrisma.$queryRaw<{ day: string, delivered: number, error: number, in_progress: number }[]>`
        SELECT
          TO_CHAR("createdAt"::date, 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (
            WHERE "deliveredAt" IS NOT NULL
              AND "bouncedAt" IS NULL
              AND "sendServerErrorExternalMessage" IS NULL
          )::int AS delivered,
          COUNT(*) FILTER (
            WHERE "bouncedAt" IS NOT NULL
              OR ("bouncedAt" IS NULL AND "sendServerErrorExternalMessage" IS NOT NULL)
          )::int AS error,
          COUNT(*) FILTER (WHERE "simpleStatus" = 'IN_PROGRESS'::${sqlQuoteIdent(schema)}."EmailOutboxSimpleStatus")::int AS in_progress
        FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "createdAt" >= ${bounds.currentStartsAt}
          AND "createdAt" < ${bounds.currentEndsAt}
        GROUP BY day
        ORDER BY day
      `,
    ]);
    const summary = summaryRows[0];
    const sent = Number(summary.current_finished);
    const delivered = Number(summary.delivered);
    const bounced = Number(summary.bounced);
    const errors = Number(summary.errors);
    const assessableSends = delivered + bounced + errors;
    const previousSent = Number(summary.previous_finished);
    const qualifies = assessableSends >= TV_MINIMUM_EMAIL_OUTCOMES;
    const { deliveryRatePercent, bounceRatePercent } = calculateTvEmailRates(assessableSends, delivered, bounced);
    const volumeChangePercent = percentChange(sent, previousSent);
    const trendByDay = new Map(trendRows.map((row) => [row.day, row]));
    const statusTrend = dateKeys(bounds, 7).map((date): TvStackedTrendPoint => {
      const row = trendByDay.get(date);
      return {
        label: dayLabel(date),
        primary: Number(row?.delivered ?? 0),
        secondary: Number(row?.error ?? 0),
        tertiary: Number(row?.in_progress ?? 0),
      };
    });
    const hasEmailData = sent > 0 || Number(summary.in_progress) > 0;
    const screen: TvEmailHealthScreen = {
      ...emptyScreen,
      sourceStatus: !hasEmailData ? "empty" : qualifies ? "ready" : "insufficient-data",
      diagnosticCode: null,
      data: hasEmailData ? {
        sent,
        assessableSends,
        delivered,
        bounced,
        errors,
        inProgress: Number(summary.in_progress),
        deliveryRatePercent,
        bounceRatePercent,
        volumeChangePercent,
        statusTrend,
      } : null,
      insight: hasEmailData && isTvEmailInsightEligible(deliveryRatePercent, volumeChangePercent) ? {
        kind: "delivery-healthy-volume-up",
        message: `Delivery remained above 99% while sending volume increased by ${Math.round(volumeChangePercent)}%.`,
        evidence: { deliveryRatePercent, volumeChangePercent, finishedSends: sent },
      } : null,
    };
    return { status: "success", screen };
  } catch (cause) {
    if (cause instanceof TvSnapshotInvariantError) throw cause;
    return errorScreen(emptyScreen, "email", cause, tenancy);
  }
}

export function hasTvPaymentData(metrics: {
  applicableAttempts: number,
  currentRevenue: number,
  activeSubscriptions: number,
  newSubscriptions: number,
  pastDueSubscriptions: number,
}): boolean {
  return metrics.applicableAttempts > 0
    || metrics.currentRevenue !== 0
    || metrics.activeSubscriptions > 0
    || metrics.newSubscriptions > 0
    || metrics.pastDueSubscriptions > 0;
}

export function assertTvRevenueFactsAreTrustworthy(facts: {
  unsupportedCurrencies: number,
  invalidNormalizedFacts: number,
  invalidLegacyFacts: number,
}): void {
  if (facts.unsupportedCurrencies > 0) {
    throw new Error("TV gross collected revenue cannot combine multiple currencies without an explicit conversion policy.");
  }
  if (facts.invalidNormalizedFacts > 0) {
    throw new Error("TV gross collected revenue encountered incomplete authoritative payment facts.");
  }
  if (facts.invalidLegacyFacts > 0) {
    throw new Error("TV gross collected revenue encountered incomplete legacy payment facts.");
  }
}

export function sourceHealthFact(
  label: string,
  screen: TvRevenuePaymentsScreen | TvEmailHealthScreen | TvAudienceMomentumScreen,
): TvStatusFact {
  if (screen.sourceStatus === "ready") {
    if (screen.id === "email-health") {
      return {
        label,
        status: "ready",
        value: screen.data?.deliveryRatePercent == null ? "Ready" : `${screen.data.deliveryRatePercent}%`,
        detail: "Metrics available",
      };
    }
    if (screen.id === "revenue-payments") {
      return {
        label,
        status: "ready",
        value: screen.data?.paymentSuccess.percent == null ? "Ready" : `${screen.data.paymentSuccess.percent}%`,
        detail: "Metrics available",
      };
    }
    if (screen.data == null) {
      throw new TvSnapshotInvariantError("A ready TV Audience source must contain audience data.");
    }
    const analyticsStatus = screen.data.analytics.sourceStatus;
    if (analyticsStatus === "unavailable") {
      return { label, status: "limited", value: "Limited", detail: "Engagement metrics not enabled" };
    }
    if (analyticsStatus === "error") {
      return { label, status: "limited", value: "Limited", detail: "Engagement metrics temporarily unavailable" };
    }
    if (analyticsStatus === "insufficient-data") {
      return { label, status: "limited", value: "Limited", detail: "Not enough engagement data" };
    }
    return { label, status: "ready", value: "Fresh", detail: "All metrics available" };
  }
  if (screen.sourceStatus === "empty") {
    return { label, status: "empty", value: "No activity", detail: "No data in this reporting window" };
  }
  if (screen.sourceStatus === "insufficient-data") {
    return { label, status: "insufficient-data", value: "Limited", detail: "Insufficient data" };
  }
  if (screen.sourceStatus === "error") {
    return { label, status: "error", value: "Error", detail: "Source error" };
  }
  if (screen.sourceStatus === "stale") {
    return { label, status: "stale", value: "Stale", detail: "Data may be outdated" };
  }
  return { label, status: "unavailable", value: "Unavailable", detail: "Source unavailable" };
}

export function addTvSourceHealth(
  livePulse: TvLivePulseScreen,
  sources: {
    email: TvEmailHealthScreen,
    revenue: TvRevenuePaymentsScreen,
    audience: TvAudienceMomentumScreen,
  },
): TvLivePulseScreen {
  if (livePulse.data == null) return livePulse;
  return {
    ...livePulse,
    data: {
      ...livePulse.data,
      sourceHealth: [
        sourceHealthFact("Email delivery", sources.email),
        sourceHealthFact("Payment collection", sources.revenue),
        sourceHealthFact("Audience", sources.audience),
      ],
    },
  };
}

export function assembleTvSnapshot(options: {
  project: { id: string, displayName: string },
  profile: TvProfileResource,
  now: Date,
  includeScreenDurations?: boolean,
  screens: {
    livePulse: TvLivePulseScreen,
    audience: TvAudienceMomentumScreen,
    revenue: TvRevenuePaymentsScreen,
    email: TvEmailHealthScreen,
  },
  presentation?: TvEventPresentation,
}): TvSnapshot {
  const configuration = options.profile.configuration;
  const exactFinancialsAllowed = configuration.financialVisibility === "exact";
  if (options.screens.revenue.data?.financials.visibility === "exact" && !exactFinancialsAllowed) {
    throw new HexclaveAssertionError("Live TV snapshots must not expose exact financial values for a redacted profile.");
  }
  const playlist = configuration.playlist.map((entry) => entry.screenId);
  return {
    generatedAt: options.now.toISOString(),
    staleAfter: new Date(options.now.getTime() + TV_SNAPSHOT_STALE_AFTER_MS).toISOString(),
    connectionStatus: "online",
    project: {
      id: options.project.id,
      displayName: options.project.displayName,
    },
    profile: {
      id: options.profile.id,
      displayName: configuration.displayName,
      mode: "general",
      defaultDurationSeconds: configuration.defaultDurationSeconds,
      playlist,
      ...(options.includeScreenDurations ? {
        screenDurations: configuration.playlist.map((entry) => ({
          screenId: entry.screenId,
          durationSeconds: entry.durationSecondsOverride ?? configuration.defaultDurationSeconds,
        })),
      } : {}),
    },
    screens: [
      options.screens.livePulse,
      options.screens.audience,
      options.screens.revenue,
      options.screens.email,
    ],
    presentation: options.presentation ?? { highlight: null, takeover: null },
    fatalErrorMessage: null,
  };
}

export async function buildLiveTvSnapshot(options: {
  tenancy: Tenancy,
  profileId: string,
  resolvedProfile?: TvProfileResource,
  now?: Date,
  includeScreenDurations?: boolean,
  forceFinancialRedaction?: boolean,
}): Promise<TvSnapshot | null> {
  const now = options.now ?? new Date();
  const resolvedProfile = options.resolvedProfile ?? await resolveTvProfile(options.tenancy, options.profileId);
  if (resolvedProfile == null) return null;
  if (resolvedProfile.id !== options.profileId) {
    throw new TvSnapshotInvariantError("A pre-resolved TV profile must match the requested profile ID.");
  }
  const profile = applyTvDisplayFinancialPolicy(resolvedProfile, options.forceFinancialRedaction === true);

  const [activity, revenue, email] = await Promise.all([
    loadActivityScreens(options.tenancy, now),
    loadRevenueScreen(options.tenancy, now, profile.configuration.financialVisibility),
    loadEmailScreen(options.tenancy, now),
  ]);
  const audience = await loadAnalyticsIntoAudience(options.tenancy, now, activity.audience);
  const livePulse = addTvSourceHealth(activity.livePulse.screen, {
    email: email.screen,
    revenue: revenue.screen,
    audience: audience.screen,
  });
  let eventTablesReady = false;
  try {
    eventTablesReady = await tvEventTablesAreReady(options.tenancy);
  } catch (cause) {
    captureError("tv-event-storage-readiness-failed", new HexclaveAssertionError(
      "TV event storage readiness failed without affecting the operational snapshot.",
      { cause, tenancyId: options.tenancy.id },
    ));
  }
  if (eventTablesReady) {
    try {
      await evaluateTvEventsIfDue({
        tenancy: options.tenancy,
        now,
        totalUsers: audience.screen.data?.totalUsers ?? null,
        eventTablesReady,
      });
    } catch (cause) {
      captureError("tv-event-evaluation-failed", new HexclaveAssertionError(
        "TV event evaluation failed without affecting the operational snapshot.",
        { cause, tenancyId: options.tenancy.id },
      ));
    }
  }
  let presentation: TvEventPresentation = { highlight: null, takeover: null };
  try {
    presentation = await resolveTvEventPresentation({
      tenancy: options.tenancy,
      profile,
      now,
      eventTablesReady,
    });
  } catch (cause) {
    captureError("tv-event-presentation-resolution-failed", new HexclaveAssertionError(
      "TV event presentation resolution failed without affecting the operational snapshot.",
      { cause, tenancyId: options.tenancy.id, profileId: profile.id },
    ));
  }

  return assembleTvSnapshot({
    project: {
      id: options.tenancy.project.id,
      displayName: options.tenancy.project.display_name,
    },
    profile,
    now,
    presentation,
    includeScreenDurations: options.includeScreenDurations,
    screens: {
      livePulse,
      audience: audience.screen,
      revenue: revenue.screen,
      email: email.screen,
    },
  });
}

export function applyTvDisplayFinancialPolicy(
  profile: TvProfileResource,
  forceFinancialRedaction: boolean,
): TvProfileResource {
  const redactedFinancialVisibility: "redacted" = "redacted";
  return forceFinancialRedaction && profile.configuration.financialVisibility === "exact"
    ? {
      ...profile,
      configuration: {
        ...profile.configuration,
        financialVisibility: redactedFinancialVisibility,
        interruptionPreferences: {
          ...profile.configuration.interruptionPreferences,
          celebrations: {
            ...profile.configuration.interruptionPreferences.celebrations,
            revenueMilestone: false,
          },
        },
      },
    }
    : profile;
}
