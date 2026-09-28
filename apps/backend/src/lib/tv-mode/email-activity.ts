import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, sqlQuoteIdent } from "@/prisma-client";
import type { TvEmailSendActivity } from "@hexclave/shared/dist/interface/admin-tv-mode";

export async function loadTvEmailSendActivity(tenancy: Tenancy, now: Date): Promise<TvEmailSendActivity> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  // A successful send need not have a delivery receipt. Use completion time so
  // an email scheduled more than a week ago still appears when it is sent today.
  const rows = await prisma.$replica().$queryRaw<{ day: string, sent: number, failed: number, queued: number }[]>`
    SELECT day, SUM(sent)::int AS sent, SUM(failed)::int AS failed, SUM(queued)::int AS queued
    FROM (
      SELECT TO_CHAR("finishedSendingAt", 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE "sendServerErrorExternalMessage" IS NULL)::int AS sent,
        COUNT(*) FILTER (WHERE "sendServerErrorExternalMessage" IS NOT NULL)::int AS failed,
        0 AS queued
      FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
      WHERE "tenancyId" = ${tenancy.id}::uuid
        AND "finishedSendingAt" >= ${since} AND "finishedSendingAt" < ${now}
        AND "skippedReason" IS NULL
      GROUP BY day
      UNION ALL
      SELECT TO_CHAR("createdAt", 'YYYY-MM-DD') AS day, 0 AS sent, 0 AS failed, COUNT(*)::int AS queued
      FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
      WHERE "tenancyId" = ${tenancy.id}::uuid
        AND "createdAt" >= ${since} AND "createdAt" < ${now}
        AND "finishedSendingAt" IS NULL
        AND "simpleStatus" = 'IN_PROGRESS'::${sqlQuoteIdent(schema)}."EmailOutboxSimpleStatus"
      GROUP BY day
    ) activity
    GROUP BY day
    ORDER BY day
  `;
  const byDay = new Map(rows.map(row => [row.day, row]));
  const trend: TvEmailSendActivity["trend"] = [];
  const day = new Date(since);
  day.setUTCHours(0, 0, 0, 0);
  // A trailing seven-day window can touch eight UTC dates; keep both partial
  // boundary days so the chart accounts for every send in the displayed total.
  while (day < now) {
    const key = day.toISOString().slice(0, 10);
    const row = byDay.get(key);
    trend.push({
      label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(day),
      primary: row?.sent ?? 0,
      secondary: row?.failed ?? 0,
      tertiary: row?.queued ?? 0,
    });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return {
    sent: trend.reduce((sum, point) => sum + point.primary, 0),
    failed: trend.reduce((sum, point) => sum + point.secondary, 0),
    trend,
  };
}
