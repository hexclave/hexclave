"use client";

import { DesignButton } from "@/components/design-components";
import { ALL_APPS_FRONTEND } from "@/lib/apps-frontend";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { cn } from "@/lib/utils";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { UsersIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { ComponentType, SVGProps } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";

type UsageRow = {
  itemId: string,
  displayName: string,
  kind: "current" | "metered" | "capability",
  used: number | null,
  limit: number | null,
  remaining: number | null,
  overage: number | null,
  isUnlimited: boolean,
};

type PlanUsageData = {
  planDisplayName: string,
  ownerTeamDisplayName: string,
  periodStart: Date,
  periodEnd: Date,
  rows: UsageRow[],
};

const AUTH_USERS_ITEM_ID = "auth_users";
const DASHBOARD_ADMINS_ITEM_ID = "dashboard_admins";
const EMAILS_PER_MONTH_ITEM_ID = "emails_per_month";
const ANALYTICS_EVENTS_ITEM_ID = "analytics_events";
const ANALYTICS_SPANS_ITEM_ID = "analytics_spans";
const SESSION_REPLAYS_ITEM_ID = "session_replays";
const ANALYTICS_TIMEOUT_SECONDS_ITEM_ID = "analytics_timeout_seconds";

type UsageSectionInfo = {
  id: string,
  title: string,
  icon: ComponentType<SVGProps<SVGSVGElement>>,
};

type UsageSection = UsageSectionInfo & {
  rows: UsageRow[],
};

const DEFAULT_USAGE_SECTION_INFO: UsageSectionInfo = {
  id: "other",
  title: "Other",
  icon: UsersIcon,
};

const USAGE_SECTION_INFO_BY_ITEM_ID = new Map<string, UsageSectionInfo>([
  [DASHBOARD_ADMINS_ITEM_ID, {
    id: "dashboard",
    title: "Dashboard admins",
    icon: UsersIcon,
  }],
  [AUTH_USERS_ITEM_ID, {
    id: "authentication",
    title: "Authentication",
    icon: ALL_APPS_FRONTEND.authentication.icon,
  }],
  [EMAILS_PER_MONTH_ITEM_ID, {
    id: "emails",
    title: "Emails",
    icon: ALL_APPS_FRONTEND.emails.icon,
  }],
  [ANALYTICS_EVENTS_ITEM_ID, {
    id: "analytics",
    title: "Analytics",
    icon: ALL_APPS_FRONTEND.analytics.icon,
  }],
  [ANALYTICS_SPANS_ITEM_ID, {
    id: "analytics",
    title: "Analytics",
    icon: ALL_APPS_FRONTEND.analytics.icon,
  }],
  [SESSION_REPLAYS_ITEM_ID, {
    id: "analytics",
    title: "Analytics",
    icon: ALL_APPS_FRONTEND.analytics.icon,
  }],
]);

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatAnalyticsTimeout(row: UsageRow | undefined): string {
  if (row == null || row.limit == null) {
    return "Not included";
  }
  return `${formatNumber(row.limit)}s`;
}

function getUsagePercent(row: UsageRow): number | null {
  if (row.used == null || row.limit == null || row.limit <= 0) {
    return null;
  }
  return Math.min(100, (row.used / row.limit) * 100);
}

function getUsageSummaryText(row: UsageRow, percent: number | null): string {
  if (percent != null) {
    return `${Math.round(percent)}% · ${getRemainingText(row)}`;
  }
  if (row.itemId === AUTH_USERS_ITEM_ID && row.used != null) {
    const usedText = `${formatNumber(row.used)} ${row.used === 1 ? "user" : "users"}`;
    return row.isUnlimited ? `${usedText} · Unlimited` : usedText;
  }
  return getRemainingText(row);
}

function getRemainingText(row: UsageRow): string {
  if (row.kind === "capability") {
    return "Plan capability";
  }
  if (row.isUnlimited) {
    return "Unlimited";
  }
  if ((row.overage ?? 0) > 0) {
    return `${formatNumber(row.overage ?? 0)} over`;
  }
  return `${formatNumber(row.remaining ?? 0)} left`;
}

function isOverLimit(row: UsageRow): boolean {
  return (row.overage ?? 0) > 0;
}

function progressBarColor(row: UsageRow, percent: number): string {
  if (isOverLimit(row)) {
    return "bg-red-500";
  }
  if (percent >= 80) {
    return "bg-amber-500";
  }
  return "bg-emerald-500";
}

function getProgressWidth(row: UsageRow, percent: number | null): string | null {
  if (percent != null) {
    const minimumVisiblePercent = row.itemId === AUTH_USERS_ITEM_ID && row.isUnlimited ? 2 : 0;
    return `${Math.max(minimumVisiblePercent, percent)}%`;
  }
  if (row.itemId === AUTH_USERS_ITEM_ID && row.used != null) {
    return row.isUnlimited ? "1%" : "2%";
  }
  return null;
}

function shouldShowUsageRow(row: UsageRow): boolean {
  return row.itemId !== ANALYTICS_TIMEOUT_SECONDS_ITEM_ID;
}

function getOverageRows(rows: UsageRow[]): UsageRow[] {
  return rows.filter((row) => (row.overage ?? 0) > 0);
}

function getUsageSectionInfo(row: UsageRow): UsageSectionInfo {
  return USAGE_SECTION_INFO_BY_ITEM_ID.get(row.itemId) ?? DEFAULT_USAGE_SECTION_INFO;
}

function getUsageSections(rows: UsageRow[]): UsageSection[] {
  const sections = new Map<string, UsageSection>();
  for (const row of rows) {
    const sectionInfo = getUsageSectionInfo(row);
    const existingSection = sections.get(sectionInfo.id);
    if (existingSection != null) {
      existingSection.rows.push(row);
    } else {
      sections.set(sectionInfo.id, { ...sectionInfo, rows: [row] });
    }
  }
  const usageSections = [...sections.values()];
  const dashboardSection = usageSections.find((section) => section.id === "dashboard");
  if (dashboardSection == null) {
    return usageSections;
  }
  return [dashboardSection, ...usageSections.filter((section) => section.id !== "dashboard")];
}

function UsageMetricLine({ row }: { row: UsageRow }) {
  const percent = getUsagePercent(row);
  const progressWidth = getProgressWidth(row, percent);

  return (
    <div className="pt-3 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{row.displayName}</span>
        <span className={cn(
          "text-xs tabular-nums",
          isOverLimit(row) ? "font-semibold text-red-600 dark:text-red-400" : "text-muted-foreground",
        )}>
          {getUsageSummaryText(row, percent)}
        </span>
      </div>
      {progressWidth != null && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-foreground/[0.06]" aria-label={`${row.displayName} usage`}>
          <div className={cn("h-full rounded-full", progressBarColor(row, percent ?? 0))} style={{ width: progressWidth }} />
        </div>
      )}
    </div>
  );
}

function UsageSectionBlock({
  section,
  analyticsTimeoutRow,
}: {
  section: UsageSection,
  analyticsTimeoutRow: UsageRow | undefined,
}) {
  const isAnalytics = section.id === "analytics";
  const isDashboard = section.id === "dashboard";
  const Icon = section.icon;

  return (
    <div className="space-y-3">
      {!isDashboard && (
        <div className="flex items-center gap-2 border-b border-black/[0.08] pb-1.5 dark:border-white/[0.08]">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{section.title}</h3>
        </div>
      )}
      <div className="space-y-3 divide-y divide-black/[0.04] dark:divide-white/[0.04]">
        {section.rows.map((row) => (
          <UsageMetricLine key={row.itemId} row={row} />
        ))}
        {isAnalytics && (
          <div className="flex items-center justify-between pt-3">
            <span className="text-sm font-medium text-foreground">Analytics query timeout</span>
            <span className="text-xs tabular-nums text-muted-foreground">{formatAnalyticsTimeout(analyticsTimeoutRow)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function UsageContent({
  planUsage,
  analyticsTimeoutRow,
}: {
  planUsage: PlanUsageData,
  analyticsTimeoutRow: UsageRow | undefined,
}) {
  const sections = getUsageSections(planUsage.rows);
  const statItems = [
    { label: "Plan", value: planUsage.planDisplayName },
    { label: "Billing period", value: `${formatDate(planUsage.periodStart)} – ${formatDate(planUsage.periodEnd)}` },
    { label: "Owner", value: planUsage.ownerTeamDisplayName },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {statItems.map((stat) => (
          <div key={stat.label} className="rounded-xl bg-foreground/[0.03] px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{stat.label}</div>
            <div className="mt-1 truncate text-sm font-medium text-foreground">{stat.value}</div>
          </div>
        ))}
      </div>

      <div className="space-y-8 py-2">
        {sections.map((section) => (
          <UsageSectionBlock
            key={section.id}
            section={section}
            analyticsTimeoutRow={analyticsTimeoutRow}
          />
        ))}
      </div>
    </div>
  );
}

function UsageBody({
  planUsage,
  analyticsTimeoutRow,
  onUpgrade,
  arePlanLimitsEnforced,
}: {
  planUsage: PlanUsageData,
  analyticsTimeoutRow: UsageRow | undefined,
  onUpgrade: (() => void) | undefined,
  arePlanLimitsEnforced: boolean,
}) {
  const overageRows = getOverageRows(planUsage.rows);

  return (
    <div className="flex flex-col gap-4">
      {arePlanLimitsEnforced && overageRows.length > 0 && (
        <div
          role="alert"
          className="relative grid w-full gap-4 rounded-2xl border border-amber-500/40 bg-amber-500/[0.08] p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div className="flex min-w-0 gap-3">
            <WarningCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <h5 className="mb-1 font-medium leading-none tracking-tight text-amber-700 dark:text-amber-300">
                Plan limit exceeded
              </h5>
              <div className="text-sm text-foreground/80 dark:text-muted-foreground">
                You exceeded your limits. Upgrade to the Team or Growth plan to get higher quotas.
              </div>
            </div>
          </div>
          {onUpgrade != null && (
            <div className="justify-self-start sm:justify-self-end">
              <DesignButton onClick={onUpgrade}>
                Upgrade
              </DesignButton>
            </div>
          )}
        </div>
      )}
      <UsageContent planUsage={planUsage} analyticsTimeoutRow={analyticsTimeoutRow} />
    </div>
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const planUsage = adminApp.usePlanUsage();
  const user = useDashboardInternalUser();
  const teams = user.useTeams();
  const ownerTeam = useMemo(
    () => teams.find((team) => team.id === planUsage.ownerTeamId) ?? throwErr(`Owner team ${planUsage.ownerTeamId} not found in user's teams?`, { projectId: project.id, teamIds: teams.map((team) => team.id) }),
    [planUsage.ownerTeamId, project.id, teams],
  );
  const visibleRows = useMemo(
    () => planUsage.rows.filter(shouldShowUsageRow),
    [planUsage.rows],
  );
  const analyticsTimeoutRow = useMemo(
    () => planUsage.rows.find((row) => row.itemId === ANALYTICS_TIMEOUT_SECONDS_ITEM_ID),
    [planUsage.rows],
  );
  const planUsageForDisplay = useMemo(
    () => ({ ...planUsage, rows: visibleRows }),
    [planUsage, visibleRows],
  );

  const handleUpgrade = planUsage.nextPlanId == null ? undefined : () => {
    runAsynchronouslyWithAlert(async () => {
      const checkoutUrl = await ownerTeam.createCheckoutUrl({
        productId: planUsage.nextPlanId ?? throwErr("nextPlanId became null unexpectedly"),
        returnUrl: window.location.href,
      });
      window.location.assign(checkoutUrl);
    });
  };

  return (
    <PageLayout
      title="Billing & Usage"
      description={`Usage for ${planUsage.ownerTeamDisplayName} across all projects owned by this team.`}
      width={1050}
    >
      <UsageBody
        planUsage={planUsageForDisplay}
        analyticsTimeoutRow={analyticsTimeoutRow}
        onUpgrade={handleUpgrade}
        arePlanLimitsEnforced={planUsage.arePlanLimitsEnforced}
      />
    </PageLayout>
  );
}
