import { Prisma } from "@/generated/prisma/client";
import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { CLICKHOUSE_ANALYTICS_DB, PlatformAnalyticsClickhouseQueryError, buildPlatformAnalyticsClickhouseQueries, runPlatformAnalyticsClickhouseQueries, type CountRow, type PlatformAnalyticsClickhouseResults } from "./clickhouse-queries";
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

function rowsToMap(rows: CountRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.projectId, Number(row.c));
  return out;
}

function num(value: unknown): number {
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
    const chQueries = buildPlatformAnalyticsClickhouseQueries(CLICKHOUSE_ANALYTICS_DB, {
      branchId,
      internalProjectId: INTERNAL_PROJECT_ID,
      since: sinceParam,
      priorSince: priorSinceParam,
      mid: midParam,
      until: untilParam,
    });
    let ch: PlatformAnalyticsClickhouseResults;
    try {
      ch = await runPlatformAnalyticsClickhouseQueries(clickhouse, chQueries);
    } catch (cause) {
      const queryName = cause instanceof PlatformAnalyticsClickhouseQueryError ? cause.queryName : "unknown";
      throw new HexclaveAssertionError(`Failed to load platform analytics from ClickHouse (query: ${queryName}): ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause, queryName, userId: req.auth.user.id,
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
    const dauByDay = new Map(ch.dauSeries.map((r) => [r.day.split("T")[0], num(r.c)]));
    const pvByDay = new Map(ch.pvSeries.map((r) => [r.day.split("T")[0], { pv: num(r.pv), visitors: num(r.visitors) }]));
    const signupByDay = new Map(ch.signupSeries.map((r) => [r.day.split("T")[0], num(r.c)]));
    const revenueByDay = new Map(pg.revenueDaily.map((r) => [r.day, num(r.cents)]));
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
      windowDays.map((date) => ({ date, activity: num(splitByDay.get(date)?.[field]) }));
    const activity_split = {
      total: splitField("total_count"),
      new: splitField("new_count"),
      retained: splitField("retained_count"),
      reactivated: splitField("reactivated_count"),
    };

    // ---- KPIs ----
    const mp = ch.mauProjects[0] ?? { mauCur: 0, mauPrev: 0, projCur: 0, projPrev: 0 };
    const uc = { total: 0, totalPrev: 0, verified: 0, verifiedPrev: 0, anonymous: 0 };
    for (const r of ch.usersByProject) {
      uc.total += num(r.total);
      uc.totalPrev += num(r.totalPrev);
      uc.verified += num(r.verified);
      uc.verifiedPrev += num(r.verifiedPrev);
      uc.anonymous += num(r.anonymous);
    }
    const dauAvgCur = Math.round(series.reduce((s, p) => s + p.active_users, 0) / Math.max(1, WINDOW_DAYS));
    const mauCur = num(mp.mauCur);
    const mauPrev = num(mp.mauPrev);
    const stick = (dau: number, mau: number) => mau > 0 ? Number(((dau / mau) * 100).toFixed(1)) : 0;
    const signupsCur = series.reduce((s, p) => s + p.signups, 0);
    const emailRow = pg.email[0] ?? { sent: 0, delivered: 0, bounced: 0, error: 0, in_progress: 0, deliveredCur: 0, finishedCur: 0, deliveredPrev: 0, finishedPrev: 0 };
    const rate = (n: number, d: number) => d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;

    // MRR (true recurring, normalized to monthly cents).
    let mrrCents = 0;
    for (const s of pg.subscriptions) {
      mrrCents += monthlyRecurringCents(s.product, s.priceId, num(s.quantity));
    }

    const kpis = {
      active_projects: { value: num(mp.projCur), prev: num(mp.projPrev) },
      total_users: { value: num(uc.total), prev: num(uc.totalPrev) },
      verified_users: { value: num(uc.verified), prev: num(uc.verifiedPrev) },
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
      if (r.country_code) usersByCountryMap.set(r.country_code.toUpperCase(), num(r.c));
    }
    const usersByCountry = Object.fromEntries(usersByCountryMap);
    const nonAnon = num(uc.total);
    const verified = num(uc.verified);
    const breakdowns = {
      auth_methods: pg.authMethods.map((m) => ({ method: m.method, count: num(m.count) })).filter((m) => m.count > 0),
      users_by_status: {
        verified,
        unverified: Math.max(0, nonAnon - verified),
        anonymous: num(uc.anonymous),
      },
      users_by_country: usersByCountry,
      email: {
        sent: emailRow.sent,
        delivered: emailRow.delivered,
        bounced: emailRow.bounced,
        error: emailRow.error,
        in_progress: emailRow.in_progress,
      },
      dead_click_rate: rate(num(ch.deadClicks[0]?.dead), num(ch.deadClicks[0]?.clicks)),
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
    const totalsMap = new Map(ch.usersByProject.map((r) => [r.projectId, num(r.total)]));
    const verifiedMap = new Map(ch.usersByProject.map((r) => [r.projectId, num(r.verified)]));
    const signupsMap = new Map(ch.signupsByProject.map((r) => [r.projectId, { cur: num(r.cur), prev: num(r.prev) }]));
    const activeMap = new Map(ch.activeByProject.map((r) => [r.projectId, { cur: num(r.cur), prev: num(r.prev) }]));
    const revenueMap = new Map(pg.revenueByProject.map((r) => [r.projectId, { cur: num(r.cur), prev: num(r.prev) }]));
    const sparkIndex = new Map<string, Map<string, number>>();
    for (const r of ch.sparkByProject) {
      const day = r.day.split("T")[0];
      let m = sparkIndex.get(r.projectId);
      if (!m) {
        m = new Map();
        sparkIndex.set(r.projectId, m);
      }
      m.set(day, num(r.c));
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
