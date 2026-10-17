import { VerificationCodeType } from "@/generated/prisma/client";
import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import { isSubscriptionInEffect } from "@/lib/payments";
import {
  arePlanLimitsEnforced,
  getBillingTeamId,
  getNonAnonymousUserCountForTenancies,
  getOwnedProjectAndTenancyIdsForBillingTeam,
} from "@/lib/plan-entitlements";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, globalPrismaClient, sqlQuoteIdent } from "@/prisma-client";
import { BASE_PLAN_IDS_BY_TIER, ITEM_IDS, PLAN_LIMITS, UNLIMITED, type ItemId, type PlanId } from "@hexclave/shared/dist/plans";
import type { PlanUsageResponse } from "@hexclave/shared/dist/interface/admin-interface";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { mapWithConcurrency } from "@hexclave/shared/dist/utils/promises";
import type { SubscriptionRow } from "./payments/schema/types";

type PlanUsageKind = PlanUsageResponse["rows"][number]["kind"];
type PlanUsageRow = PlanUsageResponse["rows"][number];
type UsageLimit = number | null;
type TenancyMeteredUsage = {
  emails: number,
  sessionReplays: number,
};

type UsagePeriod = {
  start: Date,
  end: Date,
};

type UsageSourceProject = {
  id: string,
  ownerTeamId?: string | null,
  owner_team_id?: string | null,
};

const USAGE_ITEM_LABELS = new Map<ItemId, string>([
  [ITEM_IDS.seats, "Dashboard admins"],
  [ITEM_IDS.authUsers, "Auth users"],
  [ITEM_IDS.emailsPerMonth, "Emails per month"],
  [ITEM_IDS.analyticsEvents, "Analytics events"],
  [ITEM_IDS.sessionReplays, "Session replays"],
  [ITEM_IDS.analyticsTimeoutSeconds, "Analytics timeout"],
  [ITEM_IDS.onboardingCall, "Onboarding call"],
]);

const PLAN_LABELS = new Map<PlanId, string>([
  ["free", "Free"],
  ["team", "Team"],
  ["growth", "Growth"],
]);

const PLAN_USAGE_TENANCY_COUNTER_CONCURRENCY = 4;

export function getNextPlanId(planId: PlanId): "team" | "growth" | null {
  if (planId === "free") {
    return "team";
  }
  if (planId === "team") {
    return "growth";
  }
  return null;
}

export function buildUsageRow(options: {
  itemId: ItemId,
  displayName: string,
  kind: PlanUsageKind,
  used: number | null,
  limit: UsageLimit,
}): PlanUsageRow {
  if (options.kind === "capability") {
    return {
      item_id: options.itemId,
      display_name: options.displayName,
      kind: options.kind,
      used: null,
      limit: options.limit,
      remaining: null,
      overage: null,
      is_unlimited: options.limit != null && options.limit >= UNLIMITED,
    };
  }

  const used = options.used ?? throwErr(`Used value is required for ${options.itemId}`);
  const isUnlimited = options.limit != null && options.limit >= UNLIMITED;
  const remaining = isUnlimited || options.limit == null ? null : Math.max(0, options.limit - used);
  const overage = isUnlimited || options.limit == null ? 0 : Math.max(0, used - options.limit);

  return {
    item_id: options.itemId,
    display_name: options.displayName,
    kind: options.kind,
    used,
    limit: isUnlimited ? null : options.limit,
    remaining,
    overage,
    is_unlimited: isUnlimited,
  };
}

export function getCurrentCalendarMonthPeriod(now: Date): UsagePeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function getPlanUsagePeriod(activeSubscription: SubscriptionRow | null, now: Date): UsagePeriod {
  if (activeSubscription?.currentPeriodEndMillis != null) {
    const end = new Date(activeSubscription.currentPeriodEndMillis);
    if (Number.isFinite(activeSubscription.currentPeriodStartMillis)) {
      return {
        start: new Date(activeSubscription.currentPeriodStartMillis),
        end,
      };
    }

    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);
    return { start, end };
  }

  return getCurrentCalendarMonthPeriod(now);
}

function formatClickhouseDateTimeParam(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function getPlanLabel(planId: PlanId): string {
  return PLAN_LABELS.get(planId) ?? throwErr(`Missing plan label for ${planId}`);
}

function getUsageItemLabel(itemId: ItemId): string {
  return USAGE_ITEM_LABELS.get(itemId) ?? throwErr(`Missing usage item label for ${itemId}`);
}

/**
 * Reads the billing team's subscription map, but never lets a bulldozer outage
 * break the caller. Plan usage is surfaced only on the dashboard's own
 * (internal project) surfaces — the overview/analytics limit banners and the
 * usage page — so a hard dependency on bulldozer here would take the whole
 * dashboard down whenever bulldozer is unreachable. On failure we report the
 * error and fall back to an empty subscription map, which resolves to the free
 * plan: we skip whatever we would normally bill/enforce rather than failing the
 * page. The real plan is re-resolved on the next request once bulldozer is back.
 */
export async function readBillingSubscriptionMapOrSkip(
  read: () => Promise<Record<string, SubscriptionRow>>,
): Promise<Record<string, SubscriptionRow>> {
  try {
    return await read();
  } catch (error) {
    captureError("plan-usage:subscription-map-unavailable", error);
    return {};
  }
}

export function resolveInEffectPlanSubscription(subscriptions: Record<string, SubscriptionRow>, nowMillis: number): SubscriptionRow | null {
  // In-effect (not active): a canceled-at-period-end plan sub keeps its item
  // grants until `endedAt`, so usage must be judged against that plan.
  const inEffectSubscriptions = Object.values(subscriptions).filter((candidate) => isSubscriptionInEffect(candidate, nowMillis));
  for (const planId of BASE_PLAN_IDS_BY_TIER) {
    const subscription = inEffectSubscriptions.find((candidate) => candidate.productId === planId);
    if (subscription != null) {
      return subscription;
    }
  }
  return null;
}

function resolveActivePlanId(subscription: SubscriptionRow | null): PlanId {
  for (const planId of BASE_PLAN_IDS_BY_TIER) {
    if (subscription?.productId === planId) {
      return planId;
    }
  }
  return "free";
}

async function getInternalBillingTenancy(): Promise<Tenancy> {
  const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
  if (tenancy == null) {
    throw new HexclaveAssertionError("Internal billing tenancy not found", {
      billingProjectId: "internal",
      branchId: DEFAULT_BRANCH_ID,
    });
  }
  return tenancy;
}

async function countDashboardAdmins(internalTenancy: Tenancy, ownerTeamId: string, now: Date): Promise<number> {
  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);
  const [acceptedMembers, pendingInvitations] = await Promise.all([
    internalPrisma.teamMember.count({
      where: {
        tenancyId: internalTenancy.id,
        teamId: ownerTeamId,
      },
    }),
    globalPrismaClient.verificationCode.count({
      where: {
        projectId: internalTenancy.project.id,
        branchId: internalTenancy.branchId,
        type: VerificationCodeType.TEAM_INVITATION,
        usedAt: null,
        expiresAt: { gt: now },
        data: {
          path: ["team_id"],
          equals: ownerTeamId,
        },
      },
    }),
  ]);
  return acceptedMembers + pendingInvitations;
}

async function getOwnerTeamDisplayName(internalTenancy: Tenancy, ownerTeamId: string): Promise<string> {
  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);
  const team = await internalPrisma.team.findUnique({
    where: {
      tenancyId_teamId: {
        tenancyId: internalTenancy.id,
        teamId: ownerTeamId,
      },
    },
    select: {
      displayName: true,
    },
  });
  return team?.displayName ?? throwErr(`Owner team ${ownerTeamId} not found in the internal tenancy`);
}

type TenancyPrismaClient = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;

type TenancyMeteredUsageGroup = {
  prisma: TenancyPrismaClient,
  schema: string,
  tenancyIds: string[],
};

// Tenancies can route to different source-of-truth databases/schemas, so we can't assume a single
// query covers every tenancy. We group tenancies that share a (client, schema) and run one aggregate
// COUNT per group: the common case (all projects on one database) collapses to a single round trip,
// while multi-database teams fan out to one query per distinct database instead of one per tenancy.
async function groupTenanciesByMeteredUsageSource(tenancyIds: string[]): Promise<TenancyMeteredUsageGroup[]> {
  const resolved = await mapWithConcurrency(tenancyIds, PLAN_USAGE_TENANCY_COUNTER_CONCURRENCY, async (tenancyId) => {
    const tenancy = await getTenancy(tenancyId) ?? throwErr(`Tenancy ${tenancyId} not found while counting plan usage`);
    const [schema, prisma] = await Promise.all([
      getPrismaSchemaForTenancy(tenancy),
      getPrismaClientForTenancy(tenancy),
    ]);
    return { tenancyId: tenancy.id, schema, prisma };
  });

  const byClient = new Map<TenancyPrismaClient, Map<string, string[]>>();
  for (const { tenancyId, schema, prisma } of resolved) {
    let bySchema = byClient.get(prisma);
    if (bySchema == null) {
      bySchema = new Map<string, string[]>();
      byClient.set(prisma, bySchema);
    }
    const existing = bySchema.get(schema);
    if (existing == null) {
      bySchema.set(schema, [tenancyId]);
    } else {
      existing.push(tenancyId);
    }
  }

  const groups: TenancyMeteredUsageGroup[] = [];
  for (const [prisma, bySchema] of byClient) {
    for (const [schema, groupTenancyIds] of bySchema) {
      groups.push({ prisma, schema, tenancyIds: groupTenancyIds });
    }
  }
  return groups;
}

async function countMeteredUsageForGroup(group: TenancyMeteredUsageGroup, period: UsagePeriod): Promise<TenancyMeteredUsage> {
  const rows = await group.prisma.$replica().$queryRaw<Array<{ emails: number, sessionReplays: number }>>`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM ${sqlQuoteIdent(group.schema)}."EmailOutbox"
        WHERE "tenancyId" = ANY(${group.tenancyIds}::uuid[])
          AND "startedSendingAt" IS NOT NULL
          AND "startedSendingAt" >= ${period.start}
          AND "startedSendingAt" < ${period.end}
      ) AS "emails",
      (
        SELECT COUNT(*)::int
        FROM ${sqlQuoteIdent(group.schema)}."SessionReplay"
        WHERE "tenancyId" = ANY(${group.tenancyIds}::uuid[])
          AND "startedAt" >= ${period.start}
          AND "startedAt" < ${period.end}
      ) AS "sessionReplays"
  `;
  const row = rows[0] ?? throwErr(`Missing plan usage count row for metered usage group on schema ${group.schema}`);
  return {
    emails: Number(row.emails),
    sessionReplays: Number(row.sessionReplays),
  };
}

async function sumTenancyMeteredUsage(tenancyIds: string[], period: UsagePeriod): Promise<TenancyMeteredUsage> {
  if (tenancyIds.length === 0) {
    return { emails: 0, sessionReplays: 0 };
  }

  const groups = await groupTenanciesByMeteredUsageSource(tenancyIds);
  // The group count equals the number of distinct databases (usually 1), so concurrency mostly guards
  // the pathological multi-database team rather than the per-tenancy fan-out it used to.
  const subtotals = await mapWithConcurrency(
    groups,
    PLAN_USAGE_TENANCY_COUNTER_CONCURRENCY,
    (group) => countMeteredUsageForGroup(group, period),
  );

  return subtotals.reduce<TenancyMeteredUsage>(
    (totals, subtotal) => ({
      emails: totals.emails + subtotal.emails,
      sessionReplays: totals.sessionReplays + subtotal.sessionReplays,
    }),
    { emails: 0, sessionReplays: 0 },
  );
}

async function countAnalyticsEventsForProjects(projectIds: string[], period: UsagePeriod): Promise<number> {
  if (projectIds.length === 0) {
    return 0;
  }

  const clickhouseClient = getClickhouseAdminClientForMetrics();
  const result = await clickhouseClient.query({
    query: `
      SELECT count() AS total
      FROM analytics_internal.events
      WHERE project_id IN {projectIds:Array(String)}
        AND event_at >= {periodStart:DateTime}
        AND event_at < {periodEnd:DateTime}
    `,
    query_params: {
      projectIds,
      periodStart: formatClickhouseDateTimeParam(period.start),
      periodEnd: formatClickhouseDateTimeParam(period.end),
    },
    format: "JSONEachRow",
  });
  const rows: { total: string | number }[] = await result.json();
  return Number(rows[0]?.total ?? 0);
}

function buildRows(options: {
  planId: PlanId,
  dashboardAdmins: number,
  authUsers: number,
  emails: number,
  analyticsEvents: number,
  sessionReplays: number,
}): PlanUsageRow[] {
  const limits = PLAN_LIMITS[options.planId];
  return [
    buildUsageRow({
      itemId: ITEM_IDS.seats,
      displayName: getUsageItemLabel(ITEM_IDS.seats),
      kind: "current",
      used: options.dashboardAdmins,
      limit: limits.seats,
    }),
    buildUsageRow({
      itemId: ITEM_IDS.authUsers,
      displayName: getUsageItemLabel(ITEM_IDS.authUsers),
      kind: "current",
      used: options.authUsers,
      limit: limits.authUsers,
    }),
    buildUsageRow({
      itemId: ITEM_IDS.emailsPerMonth,
      displayName: getUsageItemLabel(ITEM_IDS.emailsPerMonth),
      kind: "metered",
      used: options.emails,
      limit: limits.emailsPerMonth,
    }),
    buildUsageRow({
      itemId: ITEM_IDS.analyticsEvents,
      displayName: getUsageItemLabel(ITEM_IDS.analyticsEvents),
      kind: "metered",
      used: options.analyticsEvents,
      limit: limits.analyticsEvents,
    }),
    buildUsageRow({
      itemId: ITEM_IDS.sessionReplays,
      displayName: getUsageItemLabel(ITEM_IDS.sessionReplays),
      kind: "metered",
      used: options.sessionReplays,
      limit: limits.sessionReplays,
    }),
    buildUsageRow({
      itemId: ITEM_IDS.analyticsTimeoutSeconds,
      displayName: getUsageItemLabel(ITEM_IDS.analyticsTimeoutSeconds),
      kind: "capability",
      used: null,
      limit: limits.analyticsTimeoutSeconds,
    }),
  ];
}

export async function getPlanUsageForProject(project: UsageSourceProject, now: Date = new Date()): Promise<PlanUsageResponse> {
  const ownerTeamId = getBillingTeamId(project);
  if (ownerTeamId == null) {
    throw new HexclaveAssertionError("Project does not have an owner team for plan usage", {
      projectId: project.id,
    });
  }

  const internalTenancy = await getInternalBillingTenancy();
  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);
  const subscriptions = await readBillingSubscriptionMapOrSkip(() => getSubscriptionMapForCustomer({
    prisma: internalPrisma,
    tenancyId: internalTenancy.id,
    customerType: "team",
    customerId: ownerTeamId,
  }));
  const inEffectPlanSubscription = resolveInEffectPlanSubscription(subscriptions, now.getTime());
  const planId = resolveActivePlanId(inEffectPlanSubscription);
  const period = getPlanUsagePeriod(inEffectPlanSubscription, now);

  const [ownerTeamDisplayName, ownedScope, dashboardAdmins] = await Promise.all([
    getOwnerTeamDisplayName(internalTenancy, ownerTeamId),
    getOwnedProjectAndTenancyIdsForBillingTeam(ownerTeamId),
    countDashboardAdmins(internalTenancy, ownerTeamId, now),
  ]);

  const [authUsers, meteredUsage, analyticsEvents] = await Promise.all([
    getNonAnonymousUserCountForTenancies(ownedScope.tenancyIds),
    sumTenancyMeteredUsage(ownedScope.tenancyIds, period),
    countAnalyticsEventsForProjects(ownedScope.projectIds, period),
  ]);

  return {
    owner_team_id: ownerTeamId,
    owner_team_display_name: ownerTeamDisplayName,
    plan_id: planId,
    plan_display_name: inEffectPlanSubscription?.product.displayName ?? getPlanLabel(planId),
    period_start_millis: period.start.getTime(),
    period_end_millis: period.end.getTime(),
    next_plan_id: getNextPlanId(planId),
    are_plan_limits_enforced: arePlanLimitsEnforced(),
    rows: buildRows({
      planId,
      dashboardAdmins,
      authUsers,
      emails: meteredUsage.emails,
      analyticsEvents,
      sessionReplays: meteredUsage.sessionReplays,
    }),
  };
}
