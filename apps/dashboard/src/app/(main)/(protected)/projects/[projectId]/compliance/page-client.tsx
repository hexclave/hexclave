"use client";

import {
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignInput,
} from "@/components/design-components";
import { AuditLogTable, type AuditLogEvent } from "@/components/data-table/audit-log-table";
import { Skeleton, Typography } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DownloadSimpleIcon,
  FileTextIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "../(overview)/line-chart";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";

type ComplianceTab = "overview" | "events" | "access" | "restricted" | "posture" | "admin-audit";

const COMPLIANCE_TABS = [
  ["overview", "Overview"],
  ["events", "Sign-in & denials"],
  ["access", "Access review"],
  ["restricted", "Restricted users"],
  ["posture", "Security posture"],
  ["admin-audit", "Admin audit"],
] as const;

type SecurityEvent = {
  event_at: string,
  category: "sign_in_attempt" | "permission_check" | "user_restricted" | "sign_up_rule",
  outcome: string | null,
  method: string | null,
  reason: string | null,
  failure_reason: string | null,
  rule_id: string | null,
  email: string | null,
  auth_method: string | null,
  oauth_provider: string | null,
  permission_id: string | null,
  team_id: string | null,
  restricted_reason: string | null,
  ip: string | null,
  country_code: string | null,
  region_code: string | null,
  city_name: string | null,
  ip_is_trusted: boolean | null,
  user_id: string | null,
};

type SecurityEventsData = {
  events: SecurityEvent[],
  capped: boolean,
  summary: Record<string, number>,
  trends: Record<string, { attempts: number, failures: number, denials: number }>,
  top_offenders: {
    emails: Record<string, number>,
    ips: Record<string, number>,
    countries: Record<string, number>,
  },
};

type AccessReviewUser = {
  id: string,
  primary_email: string | null,
  display_name: string | null,
  is_admin: boolean,
  teams: string[],
  permissions: string[],
  last_sign_in_at: string | null,
  signed_up_at: string,
};

type RestrictedUser = {
  id: string,
  primary_email: string | null,
  display_name: string | null,
  restricted_reason: string,
  signed_up_at: string,
};

type PostureControl = {
  key: string,
  label: string,
  enabled: boolean,
  value?: string | number | boolean,
  recommendation?: string,
};

type ComplianceData = {
  securityEvents: SecurityEventsData,
  accessReview: { users: AccessReviewUser[], capped: boolean, limit: number },
  restrictedUsers: { users: RestrictedUser[], capped: boolean, limit: number },
  posture: { controls: PostureControl[] },
};

type LoadState =
  | { status: "loading" }
  | { status: "invalid", message: string }
  | { status: "error" }
  | { status: "ok", data: ComplianceData };

type AppInternals = {
  sendRequest: (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>,
};

function getAppInternals(appValue: unknown): AppInternals {
  if (appValue == null || typeof appValue !== "object") throw new Error("The Stack app instance is unavailable.");
  const internals = Reflect.get(appValue, hexclaveAppInternalsSymbol);
  if (internals == null || typeof internals !== "object" || !("sendRequest" in internals) || typeof internals.sendRequest !== "function") {
    throw new Error("The Stack client app cannot send internal requests.");
  }
  return internals;
}

function dateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultRange(): { from: string, to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: dateInput(from), to: dateInput(to) };
}

function isValidDateInput(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function humanize(value: string | null): string {
  if (value == null || value.length === 0) return "—";
  return value.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
}

function formatTimestamp(value: string | null): string {
  return value == null ? "—" : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function csvValue(value: string | number | boolean | null | undefined): string {
  const stringValue = String(value ?? "");
  const safeValue = /^[=+\-@\t\r]/.test(stringValue) ? `'${stringValue}` : stringValue;
  return `"${safeValue.replaceAll("\"", "\"\"")}"`;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): void {
  const content = [headers.map(csvValue).join(","), ...rows.map(row => row.map(csvValue).join(","))].join("\r\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadEvidence(data: ComplianceData): void {
  downloadCsv("compliance-security-events.csv", Object.keys(data.securityEvents.events[0] ?? {
    event_at: "", category: "", outcome: "", method: "", reason: "", failure_reason: "", rule_id: "",
    email: "", auth_method: "", oauth_provider: "", permission_id: "", team_id: "", restricted_reason: "",
    ip: "", country_code: "", region_code: "", city_name: "", user_id: "",
  }), data.securityEvents.events.map(event => Object.values(event)));
  downloadCsv("compliance-access-review.csv", ["id", "primary_email", "display_name", "is_admin", "teams", "permissions", "last_sign_in_at", "signed_up_at"], data.accessReview.users.map(user => [user.id, user.primary_email, user.display_name, user.is_admin, user.teams.join("; "), user.permissions.join("; "), user.last_sign_in_at, user.signed_up_at]));
  downloadCsv("compliance-restricted-users.csv", ["id", "primary_email", "display_name", "restricted_reason", "signed_up_at"], data.restrictedUsers.users.map(user => [user.id, user.primary_email, user.display_name, user.restricted_reason, user.signed_up_at]));
  downloadCsv("compliance-security-posture.csv", ["key", "label", "enabled", "value", "recommendation"], data.posture.controls.map(control => [control.key, control.label, control.enabled, control.value, control.recommendation]));
}

export default function PageClient() {
  return (
    <AppEnabledGuard appId="compliance">
      <PageLayout title="Compliance Center" description="Review access, denials, admin actions, and compliance posture">
        <ComplianceContent />
      </PageLayout>
    </AppEnabledGuard>
  );
}

function ComplianceContent() {
  const app = useAdminApp();
  const internals = useMemo(() => getAppInternals(app), [app]);
  const range = useMemo(defaultRange, []);
  const [tab, setTab] = useState<ComplianceTab>("overview");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const showDateRange = tab !== "admin-audit";

  useEffect(() => {
    if (tab === "admin-audit") {
      return;
    }
    if (!isValidDateInput(from) || !isValidDateInput(to) || from > to) {
      setState({
        status: "invalid",
        message: !isValidDateInput(from) || !isValidDateInput(to)
          ? "Enter a complete, valid date for both fields."
          : "The start date must be on or before the end date.",
      });
      return;
    }
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const query = new URLSearchParams({ from, to }).toString();
        const paths = [
          `/internal/compliance/security-events?${query}`,
          "/internal/compliance/access-review",
          "/internal/compliance/restricted-users",
          "/internal/compliance/security-posture",
        ] as const;
        const responses = await Promise.all(paths.map(path => internals.sendRequest(path, { method: "GET" }, "admin")));
        for (const response of responses) {
          if (!response.ok) throw new Error(`Compliance request failed: ${response.status}`);
        }
        const [securityEvents, accessReview, restrictedUsers, posture] = await Promise.all(responses.map(response => response.json()));
        if (!cancelled) setState({ status: "ok", data: { securityEvents, accessReview, restrictedUsers, posture } });
      } catch (error) {
        if (cancelled) return;
        captureError("compliance-load", error);
        setState({ status: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [from, internals, reloadKey, tab, to]);

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Compliance sections" className="flex flex-wrap gap-1 border-b border-border/50">
        {COMPLIANCE_TABS.map(([id, label]) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            type="button"
            className={`px-3 py-2 text-sm transition-colors hover:transition-none ${tab === id ? "border-b-2 border-foreground font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {showDateRange ? (
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-wrap items-end gap-3">
            <DateField label="From" value={from} onChange={setFrom} />
            <DateField label="To" value={to} onChange={setTo} />
          </div>
        </div>
      ) : null}
      {tab === "admin-audit" ? (
        <div id="panel-admin-audit" role="tabpanel" aria-labelledby="tab-admin-audit">
          <AdminAuditPanel internals={internals} />
        </div>
      ) : (
        <>
          {state.status === "loading" && <ComplianceLoading />}
          {state.status === "invalid" && <Card><CardContent className="py-8 text-center"><Typography variant="secondary">{state.message}</Typography></CardContent></Card>}
          {state.status === "error" && <Card><CardContent className="flex flex-col items-center gap-3 py-10 text-center"><Typography variant="secondary">Could not load compliance data. Please try again.</Typography><DesignButton size="sm" variant="secondary" onClick={() => setReloadKey(value => value + 1)}>Retry</DesignButton></CardContent></Card>}
          {state.status === "ok" && (
            <ComplianceDashboard
              tab={tab}
              data={state.data}
              onExport={() => downloadEvidence(state.data)}
            />
          )}
        </>
      )}
    </div>
  );
}

type AdminAuditLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok", events: AuditLogEvent[], nextCursor: string | null, loadingMore: boolean };

const AUDIT_LOG_PAGE_SIZE = 200;

function AdminAuditPanel({ internals }: { internals: AppInternals }) {
  const projectId = useProjectId();
  const [state, setState] = useState<AdminAuditLoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const response = await internals.sendRequest(
          urlString`/internal/audit-log?limit=${AUDIT_LOG_PAGE_SIZE}`,
          { method: "GET" },
          "admin",
        );
        if (!response.ok) {
          throw new Error(`Failed to load admin audit log: ${response.status}`);
        }
        const body = await response.json() as {
          items: AuditLogEvent[],
          pagination?: { next_cursor: string | null },
        };
        if (!cancelled) {
          setState({
            status: "ok",
            events: body.items,
            nextCursor: body.pagination?.next_cursor ?? null,
            loadingMore: false,
          });
        }
      } catch (error) {
        if (cancelled) return;
        captureError("compliance-admin-audit-load", error);
        setState({ status: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [internals, reloadKey]);

  async function loadMore() {
    if (state.status !== "ok" || state.nextCursor == null || state.loadingMore) {
      return;
    }
    setState({ ...state, loadingMore: true });
    try {
      const response = await internals.sendRequest(
        urlString`/internal/audit-log?limit=${AUDIT_LOG_PAGE_SIZE}&cursor=${state.nextCursor}`,
        { method: "GET" },
        "admin",
      );
      if (!response.ok) {
        throw new Error(`Failed to load more admin audit log: ${response.status}`);
      }
      const body = await response.json() as {
        items: AuditLogEvent[],
        pagination?: { next_cursor: string | null },
      };
      setState({
        status: "ok",
        events: [...state.events, ...body.items],
        nextCursor: body.pagination?.next_cursor ?? null,
        loadingMore: false,
      });
    } catch (error) {
      captureError("compliance-admin-audit-load-more", error);
      setState({ ...state, loadingMore: false });
    }
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Typography variant="secondary">Could not load the admin audit log. Please try again.</Typography>
          <DesignButton size="sm" variant="secondary" onClick={() => setReloadKey(value => value + 1)}>Retry</DesignButton>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Typography variant="secondary" className="text-sm">
        Timeline of sensitive admin actions such as impersonation and project settings changes.
      </Typography>
      <AuditLogTable
        events={state.status === "ok" ? state.events : []}
        projectId={projectId}
        isLoading={state.status === "loading"}
      />
      {state.status === "ok" && state.nextCursor != null && (
        <div className="flex justify-center">
          <DesignButton
            size="sm"
            variant="secondary"
            disabled={state.loadingMore}
            onClick={async () => { await loadMore(); }}
          >
            {state.loadingMore ? "Loading…" : "Load more"}
          </DesignButton>
        </div>
      )}
    </div>
  );
}

function ComplianceLoading() {
  return <div className="flex flex-col gap-4"><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-xl" />)}</div><Skeleton className="h-72 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></div>;
}

function ComplianceDashboard({
  tab,
  data,
  onExport,
}: {
  tab: Exclude<ComplianceTab, "admin-audit">,
  data: ComplianceData,
  onExport: () => void,
}) {
  const controlsEnabled = data.posture.controls.filter(control => control.enabled).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end"><DesignButton size="sm" variant="secondary" onClick={async () => onExport()}><DownloadSimpleIcon className="h-4 w-4" />Export compliance data</DesignButton></div>
      {data.securityEvents.capped && <div role="alert" className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-700 dark:text-orange-300">The security event detail list is truncated to 5000 rows; summaries cover the full selected range.</div>}
      {tab === "overview" && <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview"><Overview data={data} controlsEnabled={controlsEnabled} /></div>}
      {tab === "events" && <div id="panel-events" role="tabpanel" aria-labelledby="tab-events"><Events data={data.securityEvents} /></div>}
      {tab === "access" && <div id="panel-access" role="tabpanel" aria-labelledby="tab-access"><AccessReview data={data.accessReview} /></div>}
      {tab === "restricted" && <div id="panel-restricted" role="tabpanel" aria-labelledby="tab-restricted"><RestrictedUsers data={data.restrictedUsers} /></div>}
      {tab === "posture" && <div id="panel-posture" role="tabpanel" aria-labelledby="tab-posture"><Posture data={data.posture} /></div>}
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string, value: string, onChange: (value: string) => void }) {
  return <label className="flex flex-col gap-1 text-xs text-muted-foreground">{label}<DesignInput type="date" value={value} onChange={event => onChange(event.target.value)} /></label>;
}

function Overview({ data, controlsEnabled }: { data: ComplianceData, controlsEnabled: number }) {
  const summary = data.securityEvents.summary;
  const attempts = summary["sign_in_attempt"] || 0;
  const failures = summary["sign_in_attempt.failed"] || 0;
  const permissionDenials = summary.permission_check || 0;
  const restrictedUsers = summary.user_restricted || 0;
  return <div className="flex flex-col gap-4"><div className="grid grid-cols-2 gap-3 sm:grid-cols-5"><Kpi label="Sign-in attempts" value={attempts} icon={<FileTextIcon className="h-4 w-4" />} /><Kpi label="Failed sign-ins" value={failures} icon={<ShieldWarningIcon className="h-4 w-4 text-red-500" />} /><Kpi label="Permission denials" value={permissionDenials} icon={<ShieldWarningIcon className="h-4 w-4 text-orange-500" />} /><Kpi label="Restricted users" value={restrictedUsers} icon={<UsersThreeIcon className="h-4 w-4 text-orange-500" />} /><Kpi label="Controls enabled" value={`${controlsEnabled}/${data.posture.controls.length}`} icon={<ShieldCheckIcon className="h-4 w-4 text-emerald-500" />} /></div><ChartCard gradientColor="blue"><div className="p-4"><Typography className="font-medium">Security trends</Typography><Typography variant="secondary" className="text-xs">Daily attempts, failures, and denials</Typography><div className="mt-4 h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={Object.entries(data.securityEvents.trends).map(([date, values]) => ({ date, ...values }))}><CartesianGrid strokeDasharray="3 3" opacity={0.2} /><XAxis dataKey="date" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} /><Tooltip /><Line type="monotone" dataKey="attempts" stroke="#2563eb" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="failures" stroke="#dc2626" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="denials" stroke="#ea580c" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div></div></ChartCard><div className="grid gap-4 md:grid-cols-3"><OffenderList title="Top emails" values={data.securityEvents.top_offenders.emails} /><OffenderList title="Top IPs" values={data.securityEvents.top_offenders.ips} /><OffenderList title="Top countries" values={data.securityEvents.top_offenders.countries} /></div></div>;
}

function Events({ data }: { data: SecurityEventsData }) {
  const [filter, setFilter] = useState<"all" | "failed" | "denials">("all");
  const [page, setPage] = useState(0);
  const setEventFilter = (value: "all" | "failed" | "denials") => {
    setFilter(value);
    setPage(0);
  };
  const filtered = data.events.filter(event => filter === "all" || (filter === "failed" ? event.category === "sign_in_attempt" && event.outcome === "failed" : event.outcome === "denied" || event.category === "user_restricted" || event.category === "sign_up_rule"));
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  return <div className="flex flex-col gap-4"><DesignCard title="Security events" subtitle={`${filtered.length} matching event${filtered.length === 1 ? "" : "s"}`} icon={ShieldWarningIcon} gradient="orange" glassmorphic><div className="mb-3 flex items-center justify-between gap-3"><div className="flex gap-1">{(["all", "failed", "denials"] as const).map(value => <button key={value} type="button" className={`rounded-md px-2 py-1 text-xs transition-colors hover:transition-none ${filter === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setEventFilter(value)}>{humanize(value)}</button>)}</div><CsvButton label="Export events" onClick={async () => downloadCsv("compliance-security-events.csv", ["event_at", "category", "outcome", "method", "email", "oauth_provider", "ip", "ip_trusted", "country_code", "region_code", "city_name", "user_id"], filtered.map(event => [event.event_at, event.category, event.outcome, event.method, event.email, event.oauth_provider, event.ip == null ? null : event.ip_is_trusted === false ? `${event.ip} (unverified)` : event.ip, event.ip_is_trusted, event.country_code, event.region_code, event.city_name, event.user_id]))} /></div><Typography variant="secondary" className="mb-3 text-xs">IP and geo data is best-effort and can be spoofed unless the request came through a trusted proxy.</Typography><EventTable events={visible} /><div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>Page {page + 1} of {pages}</span><div className="flex gap-1"><button type="button" aria-label="Previous events page" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ArrowLeftIcon /></button><button type="button" aria-label="Next events page" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}><ArrowRightIcon /></button></div></div></DesignCard><div className="grid gap-4 md:grid-cols-3"><Typography variant="secondary" className="text-xs md:col-span-3">Top IP and country offenders use best-effort metadata; treat them as unverified unless the request came through a trusted proxy.</Typography><OffenderList title="Top emails" values={data.top_offenders.emails} /><OffenderList title="Top IPs" values={data.top_offenders.ips} /><OffenderList title="Top countries" values={data.top_offenders.countries} /></div></div>;
}

function EventTable({ events }: { events: SecurityEvent[] }) {
  if (events.length === 0) return <div className="py-8 text-center"><Typography variant="secondary">No events match this filter.</Typography></div>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-xs"><thead className="border-b border-border/50 text-[11px] uppercase tracking-wide text-muted-foreground"><tr>{["Timestamp", "Category / outcome", "Email", "Auth / provider", "IP", "Location", "User ID"].map(label => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-border/40">{events.map((event, index) => <tr key={`${event.event_at}-${event.user_id ?? "anonymous"}-${index}`} className="transition-colors duration-150 hover:bg-foreground/[0.03] hover:transition-none"><td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{formatTimestamp(event.event_at)}</td><td className="px-3 py-3"><DesignBadge label={`${humanize(event.category)}${event.outcome == null ? "" : ` · ${humanize(event.outcome)}`}`} color={event.outcome === "failed" || event.outcome === "denied" ? "red" : "orange"} size="sm" /><div className="mt-1 text-muted-foreground">{humanize(event.reason)}</div></td><td className="max-w-[220px] truncate px-3 py-3">{event.email ?? "—"}</td><td className="px-3 py-3 text-muted-foreground">{humanize(event.auth_method ?? event.method ?? event.oauth_provider)}</td><td className="whitespace-nowrap px-3 py-3 font-mono text-[11px] text-muted-foreground">{event.ip == null ? "—" : <span className={event.ip_is_trusted === false ? "text-muted-foreground/70" : undefined} title={event.ip_is_trusted === false ? "This IP may be spoofed because the request was not received through a trusted proxy." : undefined}>{event.ip}{event.ip_is_trusted === false && <span className="ml-1 font-sans text-[10px]">(unverified)</span>}</span>}</td><td className="px-3 py-3 text-muted-foreground">{[event.city_name, event.region_code, event.country_code].filter(Boolean).join(", ") || "—"}</td><td className="max-w-[180px] truncate px-3 py-3 font-mono text-[11px] text-muted-foreground">{event.user_id ?? "—"}</td></tr>)}</tbody></table></div>;
}

function AccessReview({ data }: { data: ComplianceData["accessReview"] }) {
  return <DesignCard title="Access review" subtitle={`${data.users.length} users`} icon={UsersThreeIcon} gradient="purple" glassmorphic>{data.capped && <Typography variant="secondary" className="mb-3 text-xs">Showing the first {data.limit} users. Export is capped at this limit.</Typography>}<div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="border-b border-border/50 text-[11px] uppercase tracking-wide text-muted-foreground"><tr>{["Email", "Display name", "Admin", "Teams", "Permissions", "Last sign-in", "Signed up"].map(label => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-border/40">{data.users.map(user => <tr key={user.id}><td className="px-3 py-3">{user.primary_email ?? "—"}</td><td className="px-3 py-3">{user.display_name ?? "—"}</td><td className="px-3 py-3">{user.is_admin && <DesignBadge label="Admin" color="blue" size="sm" />}</td><td className="px-3 py-3 text-muted-foreground">{user.teams.join(", ") || "—"}</td><td className="max-w-[260px] truncate px-3 py-3 text-muted-foreground">{user.permissions.join(", ") || "—"}</td><td className="px-3 py-3 text-muted-foreground">{formatTimestamp(user.last_sign_in_at)}</td><td className="px-3 py-3 text-muted-foreground">{formatTimestamp(user.signed_up_at)}</td></tr>)}</tbody></table></div><CsvButton label="Export access review" onClick={async () => downloadCsv("compliance-access-review.csv", ["id", "primary_email", "display_name", "is_admin", "teams", "permissions", "last_sign_in_at", "signed_up_at"], data.users.map(user => [user.id, user.primary_email, user.display_name, user.is_admin, user.teams.join("; "), user.permissions.join("; "), user.last_sign_in_at, user.signed_up_at]))} /></DesignCard>;
}

function RestrictedUsers({ data }: { data: ComplianceData["restrictedUsers"] }) {
  return <DesignCard title="Restricted users" subtitle={`${data.users.length} users in the current snapshot`} icon={UsersThreeIcon} gradient="orange" glassmorphic>{data.capped && <Typography variant="secondary" className="mb-3 text-xs">Showing the first {data.limit} users. Export is capped at this limit.</Typography>}<div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-xs"><thead className="border-b border-border/50 text-[11px] uppercase tracking-wide text-muted-foreground"><tr>{["Email", "Display name", "Reason", "Signed up"].map(label => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-border/40">{data.users.map(user => <tr key={user.id}><td className="px-3 py-3">{user.primary_email ?? "—"}</td><td className="px-3 py-3">{user.display_name ?? "—"}</td><td className="px-3 py-3"><DesignBadge label={humanize(user.restricted_reason)} color="orange" size="sm" /></td><td className="px-3 py-3 text-muted-foreground">{formatTimestamp(user.signed_up_at)}</td></tr>)}</tbody></table></div><CsvButton label="Export restricted users" onClick={async () => downloadCsv("compliance-restricted-users.csv", ["id", "primary_email", "display_name", "restricted_reason", "signed_up_at"], data.users.map(user => [user.id, user.primary_email, user.display_name, user.restricted_reason, user.signed_up_at]))} /></DesignCard>;
}

function Posture({ data }: { data: ComplianceData["posture"] }) {
  return <DesignCard title="Security posture" subtitle="Controls relevant to compliance readiness" icon={ShieldCheckIcon} gradient="green" glassmorphic><div className="divide-y divide-border/40">{data.controls.map(control => <div key={control.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"><div><Typography className="text-sm font-medium">{control.label}</Typography>{control.recommendation != null && !control.enabled && <Typography variant="secondary" className="text-xs">{control.recommendation}</Typography>}</div><div className="flex items-center gap-3 text-xs text-muted-foreground">{control.value != null && <span>{String(control.value)}</span>}<DesignBadge label={control.enabled ? "Enabled" : "Disabled"} color={control.enabled ? "green" : "red"} size="sm" /></div></div>)}</div></DesignCard>;
}

function OffenderList({ title, values }: { title: string, values: Record<string, number> }) {
  return <DesignCard title={title} subtitle="Failed or denied activity" icon={ShieldWarningIcon} glassmorphic><div className="divide-y divide-border/40">{Object.entries(values).length === 0 ? <Typography variant="secondary" className="py-4 text-xs">No offenders in this range.</Typography> : Object.entries(values).map(([value, count]) => <div key={value} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="truncate">{value}</span><DesignBadge label={String(count)} color="orange" size="sm" /></div>)}</div></DesignCard>;
}

function Kpi({ label, value, icon }: { label: string, value: string | number, icon: React.ReactNode }) {
  return <DesignCard title={label} icon={() => icon} glassmorphic><div className="text-2xl font-semibold tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</div></DesignCard>;
}

function CsvButton({ label, onClick }: { label: string, onClick: () => Promise<void> }) {
  return <div className="mt-4 flex justify-end"><DesignButton size="sm" variant="secondary" onClick={onClick}><DownloadSimpleIcon className="h-4 w-4" />{label}</DesignButton></div>;
}
