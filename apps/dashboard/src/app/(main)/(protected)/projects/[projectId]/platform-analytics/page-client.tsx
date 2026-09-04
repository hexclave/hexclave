'use client';

import { Skeleton, Typography } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { DesignAnalyticsCard } from "@/components/design-components";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { cn } from "@/lib/utils";
import {
  ChartLineUpIcon,
  CreditCardIcon,
  CursorClickIcon,
  EnvelopeSimpleIcon,
  FingerprintSimpleIcon,
  LockKeyIcon,
  MonitorPlayIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useStackApp, useUser } from "@hexclave/next";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useState } from "react";
import { PageLayout } from "../page-layout";
import { useProjectId } from "../use-admin-app";
import {
  ComposedAnalyticsChart,
  DonutChartDisplay,
  StackedBarChartDisplay,
  type ComposedDataPoint,
  type StackedDataPoint,
} from "../(overview)/line-chart";
import { GlobeSection } from "../(overview)/globe";

type Kpi = { value: number, prev: number | null };
type SeriesPoint = {
  date: string,
  signups: number,
  active_users: number,
  page_views: number,
  visitors: number,
  revenue_cents: number,
};
type SplitPoint = { date: string, activity: number };
type ProjectRow = {
  id: string,
  display_name: string,
  created_at: string,
  total_users: number,
  verified_users: number,
  active_users: number,
  active_users_prev: number,
  signups: number,
  signups_prev: number,
  revenue_cents: number,
  revenue_cents_prev: number,
  features: string[],
  sparkline: number[],
};
type PlatformAnalytics = {
  generated_at: string,
  window_days: number,
  kpis: {
    active_projects: Kpi,
    total_users: Kpi,
    verified_users: Kpi,
    mau: Kpi,
    dau_avg: Kpi,
    stickiness: Kpi,
    new_signups: Kpi,
    mrr_cents: Kpi,
    active_subscriptions: Kpi,
    email_deliverability_rate: Kpi,
  },
  series: SeriesPoint[],
  activity_split: { total: SplitPoint[], new: SplitPoint[], retained: SplitPoint[], reactivated: SplitPoint[] },
  breakdowns: {
    auth_methods: Array<{ method: string, count: number }>,
    users_by_status: { verified: number, unverified: number, anonymous: number },
    users_by_country: Record<string, number>,
    email: { sent: number, delivered: number, bounced: number, error: number, in_progress: number },
    dead_click_rate: number,
  },
  total_projects: number,
  feature_adoption: Array<{ feature: string, projects_using: number }>,
  projects: ProjectRow[],
};

type LoadState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error" }
  | { status: "ok", data: PlatformAnalytics };

type HexclaveAppInternals = {
  sendRequest: (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>,
};

function getStackAppInternals(appValue: unknown): HexclaveAppInternals {
  if (appValue == null || typeof appValue !== "object") {
    throw new Error("The Stack app instance is unavailable.");
  }
  const internals = appValue[hexclaveAppInternalsSymbol];
  if (
    internals == null ||
    typeof internals !== "object" ||
    !("sendRequest" in internals) ||
    typeof (internals as HexclaveAppInternals).sendRequest !== "function"
  ) {
    throw new Error("The Stack client app cannot send internal requests.");
  }
  return internals as HexclaveAppInternals;
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString();
}

function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return formatNumber(n);
}

function formatUsdFromCents(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000) return `$${(dollars / 1_000).toFixed(1)}k`;
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function growthPct(value: number, prev: number): number | null {
  if (prev === 0) return value === 0 ? 0 : null;
  return Number((((value - prev) / prev) * 100).toFixed(1));
}

export default function PageClient() {
  const projectId = useProjectId();
  useUser({ or: "redirect", projectIdMustMatch: "internal" });

  if (projectId !== "internal") {
    return null;
  }

  return (
    <PageLayout
      title="Platform Analytics"
      description="Platform-wide usage across every project. Visible only to the internal team."
    >
      <PlatformAnalyticsContent />
    </PageLayout>
  );
}

function PlatformAnalyticsContent() {
  const app = useStackApp();
  const appInternals = useMemo(() => getStackAppInternals(app), [app]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [range, setRange] = useState<7 | 30>(30);

  useEffect(() => {
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const response = await appInternals.sendRequest("/internal/platform-analytics", {}, "client");
        if (response.status === 403) {
          if (!cancelled) setState({ status: "forbidden" });
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to load platform analytics: ${response.status} ${await response.text()}`);
        }
        const body = await response.json() as unknown;
        if (body == null || typeof body !== "object" || !Array.isArray((body as PlatformAnalytics).projects)) {
          throw new Error("Platform analytics endpoint returned an invalid response.");
        }
        if (!cancelled) setState({ status: "ok", data: body as PlatformAnalytics });
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error" });
        captureError("platform-analytics-load", e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appInternals]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (state.status === "forbidden") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <LockKeyIcon className="h-6 w-6 text-muted-foreground" />
          <Typography type="h3">Access restricted</Typography>
          <Typography variant="secondary" className="max-w-md text-sm">
            Platform analytics is limited to members of the internal project&apos;s team.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Typography variant="secondary">Could not load platform analytics. Please try again.</Typography>
        </CardContent>
      </Card>
    );
  }

  return <Dashboard data={state.data} range={range} onRangeChange={setRange} />;
}

function Dashboard({
  data,
  range,
  onRangeChange,
}: {
  data: PlatformAnalytics,
  range: 7 | 30,
  onRangeChange: (range: 7 | 30) => void,
}) {
  const slice = <T,>(arr: T[]): T[] => (range === 30 ? arr : arr.slice(-range));
  const series = slice(data.series);

  const composed: ComposedDataPoint[] = series.map((p) => ({
    date: p.date,
    new_cents: p.revenue_cents,
    refund_cents: 0,
    page_views: p.page_views,
    visitors: p.visitors,
    dau: p.active_users,
  }));

  const splitByDate = new Map<string, StackedDataPoint>();
  for (const p of data.activity_split.total) {
    splitByDate.set(p.date, { date: p.date, new: 0, retained: 0, reactivated: 0 });
  }
  for (const p of data.activity_split.new) {
    const d = splitByDate.get(p.date);
    if (d) d.new = p.activity;
  }
  for (const p of data.activity_split.retained) {
    const d = splitByDate.get(p.date);
    if (d) d.retained = p.activity;
  }
  for (const p of data.activity_split.reactivated) {
    const d = splitByDate.get(p.date);
    if (d) d.reactivated = p.activity;
  }
  const stacked = slice([...splitByDate.values()]);

  const k = data.kpis;
  const tiles = [
    { label: "Active projects", kpi: k.active_projects, format: formatNumber },
    { label: "Total users", kpi: k.total_users, format: formatCompact },
    { label: "Verified users", kpi: k.verified_users, format: formatCompact },
    { label: "MAU", kpi: k.mau, format: formatCompact },
    { label: "Stickiness", kpi: k.stickiness, format: (n: number) => `${n}%`, suffixDelta: "pp" },
    { label: `New sign-ups (${data.window_days}d)`, kpi: k.new_signups, format: formatCompact },
    { label: "MRR", kpi: k.mrr_cents, format: formatUsdFromCents },
    { label: "Active subscriptions", kpi: k.active_subscriptions, format: formatNumber },
    { label: "Email deliverability", kpi: k.email_deliverability_rate, format: (n: number) => `${n}%`, suffixDelta: "pp" },
    { label: `Avg DAU (${data.window_days}d)`, kpi: k.dau_avg, format: formatCompact },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <RangeToggle range={range} onRangeChange={onRangeChange} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <KpiTile key={tile.label} label={tile.label} kpi={tile.kpi} format={tile.format} suffixDelta={tile.suffixDelta} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <ChartCard title="Platform growth" subtitle="Active users, visitors, page views and revenue" className="xl:col-span-2" gradient="blue">
          {composed.length === 0
            ? <EmptyChart />
            : <ComposedAnalyticsChart datapoints={composed} showVisitors showPageViews showRevenue height={300} />}
        </ChartCard>
        {/* Counts here are a sampled estimate (1-in-4 active users, scaled back up) to keep the backend query cheap; expect a ~0.4% margin. */}
        <ChartCard title="Growth quality" subtitle="New / retained / reactivated users · sampled estimate (~0.4%)" gradient="green">
          {stacked.length === 0
            ? <EmptyChart />
            : <StackedBarChartDisplay datapoints={stacked} height={300} />}
        </ChartCard>
      </div>

      <ProjectLeaderboard projects={data.projects} windowDays={data.window_days} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <ChartCard title="Where users are" subtitle="Active users by country" gradient="cyan">
          <div className="h-[320px] w-full">
            <GlobeSection countryData={data.breakdowns.users_by_country} interactive />
          </div>
        </ChartCard>
        <ChartCard title="Sign-in methods" subtitle="How end users authenticate" gradient="purple">
          {data.breakdowns.auth_methods.length === 0
            ? <EmptyChart />
            : <DonutChartDisplay datapoints={data.breakdowns.auth_methods} gradientColor="purple" />}
        </ChartCard>
        <ChartCard title="User mix" subtitle="Verified, unverified and anonymous" gradient="orange">
          <DonutChartDisplay
            datapoints={[
              { method: "Verified", count: data.breakdowns.users_by_status.verified },
              { method: "Unverified", count: data.breakdowns.users_by_status.unverified },
              { method: "Anonymous", count: data.breakdowns.users_by_status.anonymous },
            ]}
            gradientColor="orange"
          />
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <FeatureAdoption features={data.feature_adoption} totalProjects={data.total_projects} />
        <EmailHealth email={data.breakdowns.email} />
        <UxHealth deadClickRate={data.breakdowns.dead_click_rate} />
      </div>
    </div>
  );
}

function RangeToggle({ range, onRangeChange }: { range: 7 | 30, onRangeChange: (range: 7 | 30) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl bg-foreground/[0.06] p-1">
      {([7, 30] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onRangeChange(value)}
          className={cn(
            "rounded-lg px-3 py-1 text-xs font-medium transition-colors hover:transition-none",
            range === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value}D
        </button>
      ))}
    </div>
  );
}

function KpiTile({
  label,
  kpi,
  format,
  suffixDelta,
}: {
  label: string,
  kpi: Kpi,
  format: (n: number) => string,
  suffixDelta?: string,
}) {
  const delta = kpi.prev == null ? null : suffixDelta === "pp"
    ? Number((kpi.value - kpi.prev).toFixed(1))
    : growthPct(kpi.value, kpi.prev);
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <Typography variant="secondary" className="truncate text-[11px] uppercase tracking-wide">{label}</Typography>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{format(kpi.value)}</span>
          {delta != null && delta !== 0 && (
            <span className={cn(
              "text-xs font-semibold tabular-nums",
              delta > 0 ? "text-emerald-500 dark:text-emerald-400" : "text-red-500 dark:text-red-400",
            )}>
              {delta > 0 ? "+" : ""}{delta}{suffixDelta === "pp" ? "pp" : "%"}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  title,
  subtitle,
  className,
  gradient,
  children,
}: {
  title: string,
  subtitle?: string,
  className?: string,
  gradient: "blue" | "cyan" | "purple" | "green" | "orange" | "slate",
  children: React.ReactNode,
}) {
  return (
    <DesignAnalyticsCard gradient={gradient} className={cn("flex flex-col", className)}>
      <div className="flex flex-col gap-0.5 px-5 pt-4">
        <Typography className="text-sm font-semibold text-foreground">{title}</Typography>
        {subtitle && <Typography variant="secondary" className="text-xs">{subtitle}</Typography>}
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3 pt-2">{children}</div>
    </DesignAnalyticsCard>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[280px] items-center justify-center">
      <Typography variant="secondary" className="text-xs">No data for this period.</Typography>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  Growing: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Declining: "bg-red-500/10 text-red-600 dark:text-red-400",
  New: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Dormant: "bg-foreground/[0.06] text-muted-foreground",
  Flat: "bg-foreground/[0.06] text-muted-foreground",
};

function projectStatus(project: ProjectRow, windowDays: number): string {
  const ageDays = (Date.now() - new Date(project.created_at).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays <= windowDays) return "New";
  if (project.active_users === 0) return "Dormant";
  const g = growthPct(project.active_users, project.active_users_prev);
  if (g == null) return "Growing";
  if (g > 10) return "Growing";
  if (g < -10) return "Declining";
  return "Flat";
}

type SortKey = "total_users" | "verified" | "active_users" | "signups" | "signup_growth" | "revenue";

function ProjectLeaderboard({ projects, windowDays }: { projects: ProjectRow[], windowDays: number }) {
  const [sortKey, setSortKey] = useState<SortKey>("total_users");
  const [search, setSearch] = useState("");
  const [showDormant, setShowDormant] = useState(false);

  const sorted = useMemo(() => {
    const value = (p: ProjectRow): number => {
      switch (sortKey) {
        case "verified": {
          return p.verified_users;
        }
        case "active_users": {
          return p.active_users;
        }
        case "signups": {
          return p.signups;
        }
        case "signup_growth": {
          return growthPct(p.signups, p.signups_prev) ?? -Infinity;
        }
        case "revenue": {
          return p.revenue_cents;
        }
        default: {
          return p.total_users;
        }
      }
    };
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => showDormant || projectStatus(p, windowDays) !== "Dormant")
      .filter((p) => q === "" || p.display_name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => value(b) - value(a));
  }, [projects, sortKey, search, showDormant, windowDays]);

  const dormantCount = useMemo(
    () => projects.filter((p) => projectStatus(p, windowDays) === "Dormant").length,
    [projects, windowDays],
  );

  const header = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => setSortKey(key)}
      className={cn("text-right tabular-nums transition-colors hover:text-foreground", sortKey === key ? "text-foreground" : "")}
    >
      {label}{sortKey === key ? " ↓" : ""}
    </button>
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <Typography className="text-sm font-semibold">Projects</Typography>
            {!showDormant && dormantCount > 0 && (
              <Typography variant="secondary" className="text-xs">
                Hiding {formatNumber(dormantCount)} dormant project{dormantCount === 1 ? "" : "s"}.
              </Typography>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDormant((value) => !value)}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:transition-none",
                showDormant
                  ? "border-foreground/30 bg-foreground/[0.08] text-foreground"
                  : "border-border/60 bg-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {showDormant ? "Hide dormant" : "Show dormant"}
            </button>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects"
              className="w-48 rounded-lg border border-border/60 bg-transparent px-2.5 py-1 text-xs outline-none focus:border-foreground/30"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div className="grid grid-cols-[1.5rem_minmax(10rem,1.5fr)_5rem_5rem_4.5rem_5rem_5rem_5rem_5rem_4rem] items-center gap-3 border-b border-border/60 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>#</span>
              <span>Project</span>
              <span>ID</span>
              {header("total_users", "Users")}
              {header("verified", "Verified")}
              {header("active_users", "Active")}
              {header("signups", "Sign-ups")}
              {header("signup_growth", "Growth")}
              {header("revenue", "Revenue")}
              <span className="text-right">Trend</span>
            </div>
            <div className="divide-y divide-border/40">
              {sorted.map((project, index) => {
                const status = projectStatus(project, windowDays);
                const sg = growthPct(project.signups, project.signups_prev);
                return (
                  <div
                    key={project.id}
                    className="grid grid-cols-[1.5rem_minmax(10rem,1.5fr)_5rem_5rem_4.5rem_5rem_5rem_5rem_5rem_4rem] items-center gap-3 py-2.5 text-sm"
                  >
                    <span className="tabular-nums text-muted-foreground">{index + 1}</span>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-foreground">{project.display_name || project.id}</span>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", STATUS_STYLES[status])}>{status}</span>
                    </div>
                    <span className="truncate font-mono text-xs text-muted-foreground" title={project.id}>{project.id}</span>
                    <span className="text-right tabular-nums text-foreground">{formatCompact(project.total_users)}</span>
                    <span className="text-right tabular-nums text-muted-foreground">{formatCompact(project.verified_users)}</span>
                    <span className="text-right tabular-nums text-muted-foreground">{formatCompact(project.active_users)}</span>
                    <span className="text-right tabular-nums text-muted-foreground">{formatCompact(project.signups)}</span>
                    <span className={cn(
                      "text-right text-xs tabular-nums",
                      sg == null ? "text-muted-foreground" : sg > 0 ? "text-emerald-500 dark:text-emerald-400" : sg < 0 ? "text-red-500 dark:text-red-400" : "text-muted-foreground",
                    )}>
                      {sg == null ? "—" : `${sg > 0 ? "+" : ""}${sg}%`}
                    </span>
                    <span className="text-right tabular-nums text-muted-foreground">{project.revenue_cents > 0 ? formatUsdFromCents(project.revenue_cents) : "—"}</span>
                    <div className="flex justify-end"><Sparkline values={project.sparkline} /></div>
                  </div>
                );
              })}
              {sorted.length === 0 && (
                <Typography variant="secondary" className="py-6 text-center text-sm">No projects match.</Typography>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 56;
  const height = 18;
  if (values.length === 0) return <span className="text-muted-foreground">—</span>;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className="overflow-visible text-foreground/40" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const FEATURE_META = new Map<string, { label: string, icon: React.ElementType }>([
  ["teams", { label: "Teams", icon: UsersThreeIcon }],
  ["oauth", { label: "OAuth sign-in", icon: FingerprintSimpleIcon }],
  ["emails", { label: "Emails", icon: EnvelopeSimpleIcon }],
  ["analytics", { label: "Analytics SDK", icon: CursorClickIcon }],
  ["payments", { label: "Payments", icon: CreditCardIcon }],
  ["session_replay", { label: "Session replay", icon: MonitorPlayIcon }],
]);

function FeatureAdoption({ features, totalProjects }: { features: Array<{ feature: string, projects_using: number }>, totalProjects: number }) {
  const denominator = Math.max(1, totalProjects);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <Typography className="text-sm font-semibold">Feature adoption</Typography>
        {features.map((feature) => {
          const meta = FEATURE_META.get(feature.feature);
          const Icon = meta?.icon ?? ChartLineUpIcon;
          const pctClamped = Math.max(0, Math.min(100, Math.round((feature.projects_using / denominator) * 100)));
          return (
            <div key={feature.feature} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 text-foreground">
                  <Icon className="h-4 w-4 text-muted-foreground" weight="regular" />
                  {meta?.label ?? feature.feature}
                </span>
                <span className="tabular-nums text-muted-foreground">{formatNumber(feature.projects_using)} <span className="text-xs">({pctClamped}%)</span></span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
                <div className="h-full rounded-full bg-foreground/30" style={{ width: `${pctClamped}%` }} />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function EmailHealth({ email }: { email: PlatformAnalytics["breakdowns"]["email"] }) {
  const rows = [
    { label: "Sent", value: email.sent, color: "bg-blue-500" },
    { label: "Delivered", value: email.delivered, color: "bg-emerald-500" },
    { label: "Bounced", value: email.bounced, color: "bg-red-500" },
    { label: "Errored", value: email.error, color: "bg-amber-500" },
    { label: "In progress", value: email.in_progress, color: "bg-sky-400" },
  ];
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <Typography className="text-sm font-semibold">Email health</Typography>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 text-foreground">
              <span className={cn("h-1.5 w-1.5 rounded-full", row.color)} />
              {row.label}
            </span>
            <span className="tabular-nums text-muted-foreground">{formatNumber(row.value)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function UxHealth({ deadClickRate }: { deadClickRate: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-5">
        <Typography className="text-sm font-semibold">UX health</Typography>
        <Typography variant="secondary" className="text-xs">Dead clicks (clicks with no observable effect)</Typography>
        <div className="flex items-baseline gap-2">
          <span className={cn(
            "text-3xl font-semibold tabular-nums",
            deadClickRate > 10 ? "text-red-500 dark:text-red-400" : deadClickRate > 4 ? "text-amber-500 dark:text-amber-400" : "text-emerald-500 dark:text-emerald-400",
          )}>
            {deadClickRate}%
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
          <div className="h-full rounded-full bg-foreground/30" style={{ width: `${Math.min(100, deadClickRate)}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}
