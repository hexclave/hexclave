import { Prisma } from "@/generated/prisma/client";
import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { DEFAULT_BRANCH_ID } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, moneyAmountSchema, yupArray, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

// Platform-wide analytics for the internal (platform team) dashboard. Aggregates
// across EVERY customer project in a handful of grouped queries — never N per-project
// calls. Reachable only from the internal project route, which in this deployment is
// the platform team's private dashboard.

const WINDOW_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LEADERBOARD_LIMIT = 500;
// 1-in-N consistent user-level sampling for the new/retained/reactivated activity
// split, with counts scaled back up by N. The split's window function + all-history
// scan made it the heaviest query in this route (~1.3 GiB peak at 1M users / 50M
// events); sampling 1/4 cuts that ~78% for a ~0.4% mean error. The same cityHash
// bucket is applied to both subqueries so each sampled user's full activity
// sequence is preserved (retention/reactivation stay unbiased). See
// scripts/benchmark-platform-analytics.ts.
const ACTIVITY_SPLIT_SAMPLE = 4;
const INTERNAL_PROJECT_ID = "internal";
const AVG_DAYS_PER_MONTH = 365.25 / 12;
const MRR_SUBSCRIPTION_STATUSES = ["active", "trialing"];
const REVENUE_INVOICE_STATUSES = ["paid", "succeeded"];

function ymd(date: Date): string {
  return date.toISOString().split("T")[0];
}

function chDateTime(date: Date): string {
  // ClickHouse DateTime params are "YYYY-MM-DDTHH:MM:SS" with no timezone; treated as UTC.
  return date.toISOString().slice(0, 19);
}

type CountRow = { projectId: string, c: string | number };

function rowsToMap(rows: CountRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.projectId, Number(row.c));
  return out;
}

function parseFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Normalize a single subscription's chosen recurring price to monthly cents.
// Returns 0 for one-time prices (no interval) or missing/non-USD amounts.
function monthlyRecurringCents(product: unknown, priceId: string | null, quantity: number): number {
  if (priceId == null || product == null || typeof product !== "object") return 0;
  const prices = (product as { prices?: unknown }).prices;
  if (prices == null || typeof prices !== "object") return 0;
  const price = (prices as Record<string, unknown>)[priceId];
  if (price == null || typeof price !== "object") return 0;
  const interval = (price as { interval?: unknown }).interval;
  if (!Array.isArray(interval) || interval.length < 2) return 0; // one-time purchase
  const count = Number(interval[0]);
  const unit = String(interval[1]);
  const unitMonths = unit === "day" ? 1 / AVG_DAYS_PER_MONTH
    : unit === "week" ? 7 / AVG_DAYS_PER_MONTH
      : unit === "month" ? 1
        : unit === "year" ? 12
          : 0;
  const intervalMonths = count * unitMonths;
  if (!(intervalMonths > 0)) return 0;
  // Amounts are decimal strings per currency (e.g. "9.99"); we sum USD only.
  // Convert via moneyAmountToStripeUnits — never `Number(USD) * 100`, which
  // yields non-integers for values like 79.99 (→ 7998.999999999999).
  const usd = (price as Record<string, unknown>).USD;
  if (typeof usd !== "string" || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(usd)) {
    return 0;
  }
  const amountStripeUnits = moneyAmountToStripeUnits(usd as MoneyAmount, USD_CURRENCY);
  if (!Number.isFinite(quantity) || quantity < 0) return 0;
  return Math.round((amountStripeUnits * quantity) / intervalMonths);
}

const KpiSchema = yupObject({
  value: yupNumber().defined(),
  prev: yupNumber().nullable().defined(),
}).defined();

const SeriesPointSchema = yupObject({
  date: yupString().defined(),
  signups: yupNumber().integer().defined(),
  active_users: yupNumber().integer().defined(),
  page_views: yupNumber().integer().defined(),
  visitors: yupNumber().integer().defined(),
  revenue_cents: yupNumber().integer().defined(),
}).defined();

const SplitPointsSchema = yupArray(yupObject({
  date: yupString().defined(),
  activity: yupNumber().defined(),
}).defined()).defined();

const ProjectRowSchema = yupObject({
  id: yupString().defined(),
  display_name: yupString().defined(),
  created_at: yupString().defined(),
  total_users: yupNumber().integer().defined(),
  verified_users: yupNumber().integer().defined(),
  active_users: yupNumber().integer().defined(),
  active_users_prev: yupNumber().integer().defined(),
  signups: yupNumber().integer().defined(),
  signups_prev: yupNumber().integer().defined(),
  revenue_cents: yupNumber().integer().defined(),
  revenue_cents_prev: yupNumber().integer().defined(),
  features: yupArray(yupString().defined()).defined(),
  sparkline: yupArray(yupNumber().defined()).defined(),
}).defined();

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      project: adaptSchema.defined(),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      generated_at: yupString().defined(),
      window_days: yupNumber().integer().defined(),
      kpis: yupObject({
        active_projects: KpiSchema,
        total_users: KpiSchema,
        verified_users: KpiSchema,
        mau: KpiSchema,
        dau_avg: KpiSchema,
        stickiness: KpiSchema,
        new_signups: KpiSchema,
        mrr_cents: KpiSchema,
        active_subscriptions: KpiSchema,
        email_deliverability_rate: KpiSchema,
      }).defined(),
      series: yupArray(SeriesPointSchema).defined(),
      activity_split: yupObject({
        total: SplitPointsSchema,
        new: SplitPointsSchema,
        retained: SplitPointsSchema,
        reactivated: SplitPointsSchema,
      }).defined(),
      breakdowns: yupObject({
        auth_methods: yupArray(yupObject({
          method: yupString().defined(),
          count: yupNumber().integer().defined(),
        }).defined()).defined(),
        users_by_status: yupObject({
          verified: yupNumber().integer().defined(),
          unverified: yupNumber().integer().defined(),
          anonymous: yupNumber().integer().defined(),
        }).defined(),
        users_by_country: yupRecord(yupString().defined(), yupNumber().integer().defined()).defined(),
        email: yupObject({
          sent: yupNumber().integer().defined(),
          delivered: yupNumber().integer().defined(),
          bounced: yupNumber().integer().defined(),
          error: yupNumber().integer().defined(),
          in_progress: yupNumber().integer().defined(),
        }).defined(),
        dead_click_rate: yupNumber().defined(),
      }).defined(),
      total_projects: yupNumber().integer().defined(),
      feature_adoption: yupArray(yupObject({
        feature: yupString().defined(),
        projects_using: yupNumber().integer().defined(),
      }).defined()).defined(),
      projects: yupArray(ProjectRowSchema).defined(),
    }).defined(),
  }),
  handler: async (req) => {
    if (!req.auth.user) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (req.auth.project.id !== INTERNAL_PROJECT_ID) {
      throw new KnownErrors.ExpectedInternalProject();
    }
    // Being signed into the internal project is not enough — this returns data
    // across ALL customer projects, so require membership of the internal project's
    // owning team (the platform team).
    await ensurePlatformAdmin(req.auth.user);

    const now = new Date();
    const todayUtc = new Date(now);
    todayUtc.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(todayUtc.getTime() - (WINDOW_DAYS - 1) * ONE_DAY_MS); // first day shown
    const priorStart = new Date(todayUtc.getTime() - (2 * WINDOW_DAYS - 1) * ONE_DAY_MS);
    const untilExclusive = new Date(todayUtc.getTime() + ONE_DAY_MS);
    const midParam = chDateTime(windowStart); // boundary between prior and current windows
    const sinceParam = chDateTime(windowStart);
    const priorSinceParam = chDateTime(priorStart);
    const untilParam = chDateTime(untilExclusive);

    const branchId = DEFAULT_BRANCH_ID;

    // Ordered day axis for the visible window.
    const windowDays: string[] = [];
    for (let i = 0; i < WINDOW_DAYS; i += 1) {
      windowDays.push(ymd(new Date(windowStart.getTime() + i * ONE_DAY_MS)));
    }

    // All real customer projects (exclude the internal project itself).
    const projectRows = await globalPrismaClient.project.findMany({
      where: { id: { not: INTERNAL_PROJECT_ID } },
      select: { id: true, displayName: true, createdAt: true },
    });
    const projectInfo = new Map(projectRows.map((p) => [p.id, p]));

    if (projectInfo.size === 0) {
      return {
        statusCode: 200 as const,
        bodyType: "json" as const,
        body: emptyBody(now),
      };
    }

    const clickhouse = getClickhouseAdminClientForMetrics();
    const chQuery = async <T,>(query: string, params: Record<string, unknown>): Promise<T[]> => {
      const result = await clickhouse.query({ query, query_params: params, format: "JSONEachRow" });
      return await result.json<T>();
    };

    const internalProjectId = INTERNAL_PROJECT_ID;
    const userScope = `branch_id = {branchId:String} AND sync_is_deleted = 0`;
    const customerUserScope = `${userScope} AND project_id != {internalProjectId:String}`;
    const customerEventScope = `project_id != {internalProjectId:String}`;
    const baseParams = { branchId, internalProjectId };
    const windowParams = { branchId, internalProjectId, since: sinceParam, until: untilParam };
    const twoWindowParams = { branchId, internalProjectId, priorSince: priorSinceParam, mid: midParam, until: untilParam };

    let ch: {
      dauSeries: Array<{ day: string, c: string | number }>,
      pvSeries: Array<{ day: string, pv: string | number, visitors: string | number }>,
      signupSeries: Array<{ day: string, c: string | number }>,
      mauProjects: Array<{ mauCur: string | number, mauPrev: string | number, projCur: string | number, projPrev: string | number }>,
      userCounts: Array<{ total: string | number, totalPrev: string | number, verified: string | number, verifiedPrev: string | number, anonymous: string | number }>,
      country: Array<{ country_code: string, c: string | number }>,
      deadClicks: Array<{ clicks: string | number, dead: string | number }>,
      split: Array<{ day: string, total_count: string, new_count: string, retained_count: string, reactivated_count: string }>,
      totalsByProject: CountRow[],
      verifiedByProject: CountRow[],
      signupsByProject: Array<{ projectId: string, cur: string | number, prev: string | number }>,
      activeByProject: Array<{ projectId: string, cur: string | number, prev: string | number }>,
      sparkByProject: Array<{ projectId: string, day: string, c: string | number }>,
      teamsByProject: CountRow[],
      oauthByProject: CountRow[],
      emailsByProject: CountRow[],
      analyticsByProject: CountRow[],
    };
    try {
      // FINAL normally merges every partition before evaluating the IN set;
      // hashing the key is a deliberate accuracy-for-memory tradeoff: a
      // 64-bit collision is negligible at these row counts for this internal
      // KPI. Limiting FINAL read parallelism also avoids buffering one large
      // block per reader on object-backed storage.
      const verifiedSubquery = `
        cityHash64(project_id, id) IN (
          SELECT cityHash64(project_id, user_id)
          FROM analytics_internal.contact_channels FINAL
          WHERE branch_id = {branchId:String} AND sync_is_deleted = 0
            AND type = 'EMAIL' AND is_verified = 1
          SETTINGS do_not_merge_across_partitions_select_final = 1
        )`;
      const verifiedQuerySettings = "SETTINGS max_threads = 1, max_final_threads = 1, max_block_size = 1024";
      const [
        dauSeries, pvSeries, signupSeries, mauProjects, userCounts, country, deadClicks, split,
        totalsByProject, verifiedByProject, signupsByProject, activeByProject, sparkByProject,
        teamsByProject, oauthByProject, emailsByProject, analyticsByProject,
      ] = await Promise.all([
        // Platform daily DAU (active users) over the visible window.
        chQuery<{ day: string, c: string | number }>(`
          SELECT toDate(event_at) AS day, uniqExact(sipHash64(assumeNotNull(user_id))) AS c
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
            AND ${customerEventScope}
            AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
          GROUP BY day ORDER BY day ASC
        `, windowParams),
        // Page views + unique visitors per day. Exact distinct counts are taken
        // over hashed user ids: the state is kept once per day group, so 36-char
        // uuids across every customer project overran the metrics memory limit.
        chQuery<{ day: string, pv: string | number, visitors: string | number }>(`
          SELECT toDate(event_at) AS day,
            countIf(event_type = '$page-view') AS pv,
            uniqExactIf(sipHash64(assumeNotNull(user_id)), event_type = '$page-view') AS visitors
          FROM analytics_internal.events
          WHERE event_type IN ('$page-view', '$click')
            AND ${customerEventScope}
            AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
          GROUP BY day ORDER BY day ASC
        `, windowParams),
        // Signups per day (users table).
        chQuery<{ day: string, c: string | number }>(`
          SELECT toDate(signed_up_at, 'UTC') AS day, count() AS c
          FROM analytics_internal.users FINAL
          WHERE ${customerUserScope} AND is_anonymous = 0
            AND signed_up_at >= {since:DateTime} AND signed_up_at < {until:DateTime}
          GROUP BY day ORDER BY day ASC
        `, windowParams),
        // MAU + active projects, current vs prior 30d window (single pass over 60d).
        chQuery<{ mauCur: string | number, mauPrev: string | number, projCur: string | number, projPrev: string | number }>(`
          SELECT
            uniqExactIf(sipHash64(assumeNotNull(user_id)), event_at >= {mid:DateTime}) AS mauCur,
            uniqExactIf(sipHash64(assumeNotNull(user_id)), event_at < {mid:DateTime}) AS mauPrev,
            uniqExactIf(project_id, event_at >= {mid:DateTime}) AS projCur,
            uniqExactIf(project_id, event_at < {mid:DateTime}) AS projPrev
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
            AND ${customerEventScope}
            AND event_at >= {priorSince:DateTime} AND event_at < {until:DateTime}
        `, twoWindowParams),
        // User stock counts: total, verified, anonymous (now + as-of window start).
        chQuery<{ total: string | number, totalPrev: string | number, verified: string | number, verifiedPrev: string | number, anonymous: string | number }>(`
          SELECT
            countIf(is_anonymous = 0) AS total,
            countIf(is_anonymous = 0 AND signed_up_at < {mid:DateTime}) AS totalPrev,
            countIf(is_anonymous = 0 AND ${verifiedSubquery}) AS verified,
            countIf(is_anonymous = 0 AND signed_up_at < {mid:DateTime} AND ${verifiedSubquery}) AS verifiedPrev,
            countIf(is_anonymous = 1) AS anonymous
          FROM analytics_internal.users FINAL
          WHERE ${customerUserScope}
          ${verifiedQuerySettings}
        `, { branchId, internalProjectId, mid: midParam }),
        // Users by country (for the globe) over the window.
        chQuery<{ country_code: string, c: string | number }>(`
          SELECT country_code, count() AS c FROM (
            SELECT argMax(cc, event_at) AS country_code FROM (
              SELECT sipHash64(user_id) AS user_hash, event_at, CAST(data.ip_info.country_code, 'Nullable(String)') AS cc
              FROM analytics_internal.events
              WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
                AND ${customerEventScope}
                AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
            ) WHERE cc IS NOT NULL GROUP BY user_hash
          ) WHERE country_code IS NOT NULL GROUP BY country_code ORDER BY c DESC
        `, windowParams),
        // Dead-click health over the window.
        chQuery<{ clicks: string | number, dead: string | number }>(`
          SELECT count() AS clicks, sum(is_dead) AS dead
          FROM analytics_internal.clickmap_events
          WHERE ${customerEventScope}
            AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
        `, windowParams),
        // New / retained / reactivated split across all projects.
        chQuery<{ day: string, total_count: string, new_count: string, retained_count: string, reactivated_count: string }>(`
          SELECT
            toString(w.day) AS day,
            count() * ${ACTIVITY_SPLIT_SAMPLE} AS total_count,
            countIf(f.first_date = w.day) * ${ACTIVITY_SPLIT_SAMPLE} AS new_count,
            countIf(f.first_date < w.day AND w.prev_day = addDays(w.day, -1)) * ${ACTIVITY_SPLIT_SAMPLE} AS retained_count,
            countIf(f.first_date < w.day AND (isNull(w.prev_day) OR w.prev_day < addDays(w.day, -1))) * ${ACTIVITY_SPLIT_SAMPLE} AS reactivated_count
          FROM (
            SELECT day, entity_id, lagInFrame(day, 1) OVER (PARTITION BY entity_id ORDER BY day) AS prev_day
            FROM (
              SELECT DISTINCT toDate(event_at) AS day, sipHash64(assumeNotNull(user_id)) AS entity_id
              FROM analytics_internal.events
              WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
                AND ${customerEventScope}
                AND cityHash64(assumeNotNull(user_id)) % ${ACTIVITY_SPLIT_SAMPLE} = 0
                AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
                AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0
            )
          ) AS w
          LEFT JOIN (
            SELECT sipHash64(assumeNotNull(user_id)) AS entity_id, toDate(min(event_at)) AS first_date
            FROM analytics_internal.events
            WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
              AND ${customerEventScope}
              AND cityHash64(assumeNotNull(user_id)) % ${ACTIVITY_SPLIT_SAMPLE} = 0
              AND event_at < {until:DateTime}
              AND coalesce(CAST(data.is_anonymous, 'Nullable(UInt8)'), 0) = 0
            GROUP BY entity_id
          ) AS f USING (entity_id)
          GROUP BY w.day ORDER BY w.day ASC
        `, windowParams),
        // Per-project total users.
        chQuery<CountRow>(`
          SELECT project_id AS projectId, count() AS c
          FROM analytics_internal.users FINAL
          WHERE ${customerUserScope} AND is_anonymous = 0 GROUP BY project_id
        `, baseParams),
        // Per-project verified users.
        chQuery<CountRow>(`
          SELECT project_id AS projectId, count() AS c
          FROM analytics_internal.users FINAL
          WHERE ${customerUserScope} AND is_anonymous = 0 AND ${verifiedSubquery} GROUP BY project_id
          ${verifiedQuerySettings}
        `, baseParams),
        // Per-project signups, current vs prior window.
        chQuery<{ projectId: string, cur: string | number, prev: string | number }>(`
          SELECT project_id AS projectId,
            countIf(signed_up_at >= {mid:DateTime}) AS cur,
            countIf(signed_up_at < {mid:DateTime}) AS prev
          FROM analytics_internal.users FINAL
          WHERE ${customerUserScope} AND is_anonymous = 0
            AND signed_up_at >= {priorSince:DateTime} AND signed_up_at < {until:DateTime}
          GROUP BY project_id
        `, twoWindowParams),
        // Per-project active users, current vs prior window.
        chQuery<{ projectId: string, cur: string | number, prev: string | number }>(`
          SELECT project_id AS projectId,
            uniqExactIf(sipHash64(assumeNotNull(user_id)), event_at >= {mid:DateTime}) AS cur,
            uniqExactIf(sipHash64(assumeNotNull(user_id)), event_at < {mid:DateTime}) AS prev
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
            AND ${customerEventScope}
            AND event_at >= {priorSince:DateTime} AND event_at < {until:DateTime}
          GROUP BY project_id
        `, twoWindowParams),
        // Per-project daily active sparkline (visible window).
        chQuery<{ projectId: string, day: string, c: string | number }>(`
          SELECT project_id AS projectId, toDate(event_at) AS day, uniqExact(sipHash64(assumeNotNull(user_id))) AS c
          FROM analytics_internal.events
          WHERE event_type = '$token-refresh' AND user_id IS NOT NULL
            AND ${customerEventScope}
            AND event_at >= {since:DateTime} AND event_at < {until:DateTime}
          GROUP BY project_id, day
        `, windowParams),
        // Feature adoption signals (per project) from synced CH tables.
        chQuery<CountRow>(`SELECT project_id AS projectId, count() AS c FROM analytics_internal.teams FINAL WHERE ${customerUserScope} GROUP BY project_id`, baseParams),
        chQuery<CountRow>(`SELECT project_id AS projectId, count() AS c FROM analytics_internal.connected_accounts FINAL WHERE ${customerUserScope} GROUP BY project_id`, baseParams),
        chQuery<CountRow>(`SELECT project_id AS projectId, count() AS c FROM analytics_internal.email_outboxes FINAL WHERE ${customerUserScope} GROUP BY project_id`, baseParams),
        chQuery<CountRow>(`SELECT project_id AS projectId, count() AS c FROM analytics_internal.events WHERE event_type = '$page-view' AND branch_id = {branchId:String} AND ${customerEventScope} GROUP BY project_id`, baseParams),
      ]);
      ch = {
        dauSeries, pvSeries, signupSeries, mauProjects, userCounts, country, deadClicks, split,
        totalsByProject, verifiedByProject, signupsByProject, activeByProject, sparkByProject,
        teamsByProject, oauthByProject, emailsByProject, analyticsByProject,
      };
    } catch (cause) {
      throw new HexclaveAssertionError(`Failed to load platform analytics from ClickHouse: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause, userId: req.auth.user.id,
      });
    }

    // Postgres-only signals: revenue (per project + daily), MRR (true recurring),
    // auth-method split, email deliverability, payments/replay adoption.
    let pg: {
      revenueDaily: Array<{ day: string, cents: string | number }>,
      revenueByProject: Array<{ projectId: string, cur: string | number, prev: string | number }>,
      subscriptions: Array<{ projectId: string, product: unknown, priceId: string | null, quantity: number }>,
      authMethods: Array<{ method: string, count: number }>,
      email: Array<{ sent: number, delivered: number, bounced: number, error: number, in_progress: number, deliveredCur: number, finishedCur: number, deliveredPrev: number, finishedPrev: number }>,
      paymentsRows: Array<{ projectId: string }>,
      replayRows: Array<{ projectId: string }>,
    };
    try {
      const replica = globalPrismaClient.$replica();
      const since = windowStart;
      const prior = priorStart;
      const mid = windowStart;
      const [revenueDaily, revenueByProject, subscriptions, authMethods, email, paymentsRows, replayRows] = await Promise.all([
        replica.$queryRaw<Array<{ day: string, cents: string | number }>>(Prisma.sql`
          SELECT TO_CHAR(si."createdAt"::date, 'YYYY-MM-DD') AS day, COALESCE(SUM(si."amountTotal"), 0)::bigint AS cents
          FROM "SubscriptionInvoice" si JOIN "Tenancy" t ON t."id" = si."tenancyId"
          WHERE si."amountTotal" IS NOT NULL AND si."status" = ANY(${REVENUE_INVOICE_STATUSES})
            AND si."createdAt" >= ${since} AND t."projectId" <> ${INTERNAL_PROJECT_ID}
          GROUP BY day ORDER BY day
        `),
        replica.$queryRaw<Array<{ projectId: string, cur: string | number, prev: string | number }>>(Prisma.sql`
          SELECT t."projectId" AS "projectId",
            COALESCE(SUM("amountTotal") FILTER (WHERE si."createdAt" >= ${mid}), 0)::bigint AS cur,
            COALESCE(SUM("amountTotal") FILTER (WHERE si."createdAt" < ${mid}), 0)::bigint AS prev
          FROM "SubscriptionInvoice" si JOIN "Tenancy" t ON t."id" = si."tenancyId"
          WHERE si."amountTotal" IS NOT NULL AND si."status" = ANY(${REVENUE_INVOICE_STATUSES})
            AND si."createdAt" >= ${prior} AND t."projectId" <> ${INTERNAL_PROJECT_ID}
          GROUP BY t."projectId"
        `),
        replica.$queryRaw<Array<{ projectId: string, product: unknown, priceId: string | null, quantity: number }>>(Prisma.sql`
          SELECT t."projectId" AS "projectId", s."product" AS product, s."priceId" AS "priceId", s."quantity" AS quantity
          FROM "Subscription" s JOIN "Tenancy" t ON t."id" = s."tenancyId"
          WHERE s."status"::text = ANY(${MRR_SUBSCRIPTION_STATUSES}) AND t."projectId" <> ${INTERNAL_PROJECT_ID}
        `),
        replica.$queryRaw<Array<{ method: string, count: number }>>(Prisma.sql`
          SELECT method, COUNT(*)::int AS count FROM (
            SELECT COALESCE(
              oaam."configOAuthProviderId"::text,
              CASE WHEN pam."authMethodId" IS NOT NULL THEN 'password' END,
              CASE WHEN pkm."authMethodId" IS NOT NULL THEN 'passkey' END,
              CASE WHEN oam."authMethodId" IS NOT NULL THEN 'otp' END,
              'other'
            ) AS method
            FROM "AuthMethod" am
            JOIN "Tenancy" t ON t."id" = am."tenancyId"
            LEFT JOIN "OAuthAuthMethod" oaam ON oaam."tenancyId" = am."tenancyId" AND oaam."authMethodId" = am."id"
            LEFT JOIN "PasswordAuthMethod" pam ON pam."tenancyId" = am."tenancyId" AND pam."authMethodId" = am."id"
            LEFT JOIN "PasskeyAuthMethod" pkm ON pkm."tenancyId" = am."tenancyId" AND pkm."authMethodId" = am."id"
            LEFT JOIN "OtpAuthMethod" oam ON oam."tenancyId" = am."tenancyId" AND oam."authMethodId" = am."id"
            WHERE t."projectId" <> ${INTERNAL_PROJECT_ID}
          ) sub GROUP BY method ORDER BY count DESC
        `),
        replica.$queryRaw<Array<{ sent: number, delivered: number, bounced: number, error: number, in_progress: number, deliveredCur: number, finishedCur: number, deliveredPrev: number, finishedPrev: number }>>(Prisma.sql`
          SELECT
            COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL)::int AS sent,
            COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL)::int AS delivered,
            COUNT(*) FILTER (WHERE eo."bouncedAt" IS NOT NULL)::int AS bounced,
            COUNT(*) FILTER (WHERE eo."simpleStatus"::text = 'ERROR')::int AS error,
            COUNT(*) FILTER (WHERE eo."simpleStatus"::text = 'IN_PROGRESS')::int AS in_progress,
            COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL AND eo."createdAt" >= ${mid})::int AS "deliveredCur",
            COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL AND eo."createdAt" >= ${mid})::int AS "finishedCur",
            COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL AND eo."createdAt" >= ${prior} AND eo."createdAt" < ${mid})::int AS "deliveredPrev",
            COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL AND eo."createdAt" >= ${prior} AND eo."createdAt" < ${mid})::int AS "finishedPrev"
          FROM "EmailOutbox" eo JOIN "Tenancy" t ON t."id" = eo."tenancyId"
          WHERE t."projectId" <> ${INTERNAL_PROJECT_ID}
        `),
        replica.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
          SELECT DISTINCT t."projectId" AS "projectId"
          FROM "Subscription" s JOIN "Tenancy" t ON t."id" = s."tenancyId"
          WHERE s."status" IN ('active', 'trialing', 'paused') AND t."projectId" <> ${INTERNAL_PROJECT_ID}
        `),
        replica.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
          SELECT DISTINCT t."projectId" AS "projectId"
          FROM "SessionReplay" sr JOIN "Tenancy" t ON t."id" = sr."tenancyId"
          WHERE t."projectId" <> ${INTERNAL_PROJECT_ID}
        `),
      ]);
      pg = { revenueDaily, revenueByProject, subscriptions, authMethods, email, paymentsRows, replayRows };
    } catch (cause) {
      throw new HexclaveAssertionError(`Failed to load platform analytics from Postgres: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause, userId: req.auth.user.id,
      });
    }

    // ---- Assemble series ----
    const dauByDay = new Map(ch.dauSeries.map((r) => [r.day.split("T")[0], parseFiniteNumber(r.c)]));
    const pvByDay = new Map(ch.pvSeries.map((r) => [r.day.split("T")[0], { pv: parseFiniteNumber(r.pv), visitors: parseFiniteNumber(r.visitors) }]));
    const signupByDay = new Map(ch.signupSeries.map((r) => [r.day.split("T")[0], parseFiniteNumber(r.c)]));
    const revenueByDay = new Map(pg.revenueDaily.map((r) => [r.day, parseFiniteNumber(r.cents)]));
    const series = windowDays.map((date) => ({
      date,
      signups: signupByDay.get(date) ?? 0,
      active_users: dauByDay.get(date) ?? 0,
      page_views: pvByDay.get(date)?.pv ?? 0,
      visitors: pvByDay.get(date)?.visitors ?? 0,
      revenue_cents: revenueByDay.get(date) ?? 0,
    }));

    // ---- Activity split ----
    const splitByDay = new Map(ch.split.map((r) => [r.day.split("T")[0], r]));
    const splitField = (field: "total_count" | "new_count" | "retained_count" | "reactivated_count") =>
      windowDays.map((date) => ({ date, activity: parseFiniteNumber(splitByDay.get(date)?.[field]) }));
    const activity_split = {
      total: splitField("total_count"),
      new: splitField("new_count"),
      retained: splitField("retained_count"),
      reactivated: splitField("reactivated_count"),
    };

    // ---- KPIs ----
    const mp = ch.mauProjects[0] ?? { mauCur: 0, mauPrev: 0, projCur: 0, projPrev: 0 };
    const uc = ch.userCounts[0] ?? { total: 0, totalPrev: 0, verified: 0, verifiedPrev: 0, anonymous: 0 };
    const dauAvgCur = Math.round(series.reduce((s, p) => s + p.active_users, 0) / Math.max(1, WINDOW_DAYS));
    const mauCur = parseFiniteNumber(mp.mauCur);
    const mauPrev = parseFiniteNumber(mp.mauPrev);
    const stick = (dau: number, mau: number) => mau > 0 ? Number(((dau / mau) * 100).toFixed(1)) : 0;
    const signupsCur = series.reduce((s, p) => s + p.signups, 0);
    const emailRow = pg.email[0] ?? { sent: 0, delivered: 0, bounced: 0, error: 0, in_progress: 0, deliveredCur: 0, finishedCur: 0, deliveredPrev: 0, finishedPrev: 0 };
    const rate = (n: number, d: number) => d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;

    // MRR (true recurring, normalized to monthly cents).
    let mrrCents = 0;
    for (const s of pg.subscriptions) {
      mrrCents += monthlyRecurringCents(s.product, s.priceId, parseFiniteNumber(s.quantity));
    }

    const kpis = {
      active_projects: { value: parseFiniteNumber(mp.projCur), prev: parseFiniteNumber(mp.projPrev) },
      total_users: { value: parseFiniteNumber(uc.total), prev: parseFiniteNumber(uc.totalPrev) },
      verified_users: { value: parseFiniteNumber(uc.verified), prev: parseFiniteNumber(uc.verifiedPrev) },
      mau: { value: mauCur, prev: mauPrev },
      dau_avg: { value: dauAvgCur, prev: null },
      stickiness: { value: stick(dauAvgCur, mauCur), prev: null },
      new_signups: { value: signupsCur, prev: null },
      mrr_cents: { value: mrrCents, prev: null },
      active_subscriptions: { value: pg.subscriptions.length, prev: null },
      email_deliverability_rate: {
        value: rate(emailRow.deliveredCur, emailRow.finishedCur),
        prev: emailRow.finishedPrev > 0 ? rate(emailRow.deliveredPrev, emailRow.finishedPrev) : null,
      },
    };

    // ---- Breakdowns ----
    const usersByCountryMap = new Map<string, number>();
    for (const r of ch.country) {
      if (r.country_code) usersByCountryMap.set(r.country_code.toUpperCase(), parseFiniteNumber(r.c));
    }
    const usersByCountry = Object.fromEntries(usersByCountryMap);
    const nonAnon = parseFiniteNumber(uc.total);
    const verified = parseFiniteNumber(uc.verified);
    const breakdowns = {
      auth_methods: pg.authMethods.map((m) => ({ method: m.method, count: parseFiniteNumber(m.count) })).filter((m) => m.count > 0),
      users_by_status: {
        verified,
        unverified: Math.max(0, nonAnon - verified),
        anonymous: parseFiniteNumber(uc.anonymous),
      },
      users_by_country: usersByCountry,
      email: {
        sent: emailRow.sent,
        delivered: emailRow.delivered,
        bounced: emailRow.bounced,
        error: emailRow.error,
        in_progress: emailRow.in_progress,
      },
      dead_click_rate: rate(parseFiniteNumber(ch.deadClicks[0]?.dead), parseFiniteNumber(ch.deadClicks[0]?.clicks)),
    };

    // ---- Feature adoption ----
    const keysWithCount = (rows: CountRow[]) => rowsToMap(rows);
    const countProjects = (map: Map<string, number>) => {
      let n = 0;
      for (const [id, c] of map) if (c > 0 && projectInfo.has(id) && id !== INTERNAL_PROJECT_ID) n += 1;
      return n;
    };
    const countList = (ids: Iterable<string>) => {
      const seen = new Set<string>();
      for (const id of ids) if (projectInfo.has(id) && id !== INTERNAL_PROJECT_ID) seen.add(id);
      return seen.size;
    };
    const teamsMap = keysWithCount(ch.teamsByProject);
    const oauthMap = keysWithCount(ch.oauthByProject);
    const emailsMap = keysWithCount(ch.emailsByProject);
    const analyticsMap = keysWithCount(ch.analyticsByProject);
    const feature_adoption = [
      { feature: "teams", projects_using: countProjects(teamsMap) },
      { feature: "oauth", projects_using: countProjects(oauthMap) },
      { feature: "emails", projects_using: countProjects(emailsMap) },
      { feature: "analytics", projects_using: countProjects(analyticsMap) },
      { feature: "payments", projects_using: countList(pg.paymentsRows.map((r) => r.projectId)) },
      { feature: "session_replay", projects_using: countList(pg.replayRows.map((r) => r.projectId)) },
    ];

    // ---- Per-project leaderboard ----
    const totalsMap = rowsToMap(ch.totalsByProject);
    const verifiedMap = rowsToMap(ch.verifiedByProject);
    const signupsMap = new Map(ch.signupsByProject.map((r) => [r.projectId, { cur: parseFiniteNumber(r.cur), prev: parseFiniteNumber(r.prev) }]));
    const activeMap = new Map(ch.activeByProject.map((r) => [r.projectId, { cur: parseFiniteNumber(r.cur), prev: parseFiniteNumber(r.prev) }]));
    const revenueMap = new Map(pg.revenueByProject.map((r) => [r.projectId, { cur: parseFiniteNumber(r.cur), prev: parseFiniteNumber(r.prev) }]));
    const sparkIndex = new Map<string, Map<string, number>>();
    for (const r of ch.sparkByProject) {
      const day = r.day.split("T")[0];
      let m = sparkIndex.get(r.projectId);
      if (!m) {
        m = new Map();
        sparkIndex.set(r.projectId, m);
      }
      m.set(day, parseFiniteNumber(r.c));
    }
    const featureSet = (id: string): string[] => {
      const f: string[] = [];
      if ((teamsMap.get(id) ?? 0) > 0) f.push("teams");
      if ((oauthMap.get(id) ?? 0) > 0) f.push("oauth");
      if ((emailsMap.get(id) ?? 0) > 0) f.push("emails");
      if ((analyticsMap.get(id) ?? 0) > 0) f.push("analytics");
      return f;
    };
    const paymentsSet = new Set(pg.paymentsRows.map((r) => r.projectId));
    const replaySet = new Set(pg.replayRows.map((r) => r.projectId));

    const projects = projectRows.map((p) => {
      const sp = sparkIndex.get(p.id);
      const features = featureSet(p.id);
      if (paymentsSet.has(p.id)) features.push("payments");
      if (replaySet.has(p.id)) features.push("session_replay");
      return {
        id: p.id,
        display_name: p.displayName,
        created_at: p.createdAt.toISOString(),
        total_users: totalsMap.get(p.id) ?? 0,
        verified_users: verifiedMap.get(p.id) ?? 0,
        active_users: activeMap.get(p.id)?.cur ?? 0,
        active_users_prev: activeMap.get(p.id)?.prev ?? 0,
        signups: signupsMap.get(p.id)?.cur ?? 0,
        signups_prev: signupsMap.get(p.id)?.prev ?? 0,
        revenue_cents: revenueMap.get(p.id)?.cur ?? 0,
        revenue_cents_prev: revenueMap.get(p.id)?.prev ?? 0,
        features,
        sparkline: windowDays.map((d) => sp?.get(d) ?? 0),
      };
    });
    projects.sort((a, b) => b.total_users - a.total_users || b.active_users - a.active_users);

    return {
      statusCode: 200 as const,
      bodyType: "json" as const,
      body: {
        generated_at: now.toISOString(),
        window_days: WINDOW_DAYS,
        kpis,
        series,
        activity_split,
        breakdowns,
        total_projects: projectRows.length,
        feature_adoption,
        projects: projects.slice(0, LEADERBOARD_LIMIT),
      },
    };
  },
});

function emptyBody(now: Date) {
  const zeroKpi = { value: 0, prev: null };
  return {
    generated_at: now.toISOString(),
    window_days: WINDOW_DAYS,
    kpis: {
      active_projects: zeroKpi,
      total_users: zeroKpi,
      verified_users: zeroKpi,
      mau: zeroKpi,
      dau_avg: zeroKpi,
      stickiness: zeroKpi,
      new_signups: zeroKpi,
      mrr_cents: zeroKpi,
      active_subscriptions: zeroKpi,
      email_deliverability_rate: zeroKpi,
    },
    series: [],
    activity_split: { total: [], new: [], retained: [], reactivated: [] },
    breakdowns: {
      auth_methods: [],
      users_by_status: { verified: 0, unverified: 0, anonymous: 0 },
      users_by_country: {},
      email: { sent: 0, delivered: 0, bounced: 0, error: 0, in_progress: 0 },
      dead_click_rate: 0,
    },
    total_projects: 0,
    feature_adoption: [],
    projects: [],
  };
}
