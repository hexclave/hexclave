"use client";

import { DesignBadge, DesignCard } from "@/components/design-components";
import { Skeleton, Typography } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { CheckCircleIcon, ClockIcon, Icon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useEffect, useMemo, useState } from "react";
import { useAdminApp } from "./use-admin-app";

/**
 * Read-only monitor shared by the CLI Auth and Agent Auth dashboard pages. Both
 * are the same device-auth flow on the backend (one table, one status
 * vocabulary, one internal endpoint), so the page differs only in wording and
 * in which per-row details exist (agents have a name, URL, ...).
 */

export type DeviceAuthKind = "cli" | "agent";

export type DeviceAuthAttemptStatus = "waiting" | "success" | "denied" | "expired" | "used";

export type DeviceAuthSummary = {
  attempts_in_window: number,
  waiting_attempts_in_window: number,
  success_attempts_in_window: number,
  denied_attempts_in_window: number,
  expired_attempts_in_window: number,
  used_attempts_in_window: number,
  active_sessions_in_window: number,
  attempt_window_limit: number,
  session_window_limit: number,
};

export type DeviceAuthAttempt = {
  id: string,
  status: DeviceAuthAttemptStatus,
  created_at: string,
  expires_at: string,
  used_at: string | null,
  agent: {
    name: string,
    description: string | null,
    url: string | null,
    user_hint: string | null,
  } | null,
};

export type DeviceAuthSession = {
  session_id: string,
  agent_name: string | null,
  user_id: string,
  display_name: string | null,
  primary_email: string | null,
  is_anonymous: boolean,
  created_at: string,
  last_active_at: string,
  expires_at: string | null,
  is_expired: boolean,
};

export type DeviceAuthData = {
  summary: DeviceAuthSummary,
  recent_attempts: DeviceAuthAttempt[],
  sessions: DeviceAuthSession[],
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok", data: DeviceAuthData };

type SendInternalRequest = (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>;

// The admin app's internals are only typed inside the SDK package; the dashboard
// reaches them through the symbol like the other internal pages do, but checks
// the shape at runtime instead of casting.
function getSendRequest(appValue: unknown): SendInternalRequest {
  if (appValue == null || typeof appValue !== "object") {
    throw new Error("The Hexclave app instance is unavailable.");
  }
  const internals: unknown = Reflect.get(appValue, hexclaveAppInternalsSymbol);
  if (internals == null || typeof internals !== "object" || !("sendRequest" in internals)) {
    throw new Error("The Hexclave client app cannot send internal requests.");
  }
  const sendRequest: unknown = internals.sendRequest;
  if (typeof sendRequest !== "function") {
    throw new Error("The Hexclave client app cannot send internal requests.");
  }
  return async (path, requestOptions, requestType) => {
    const response: unknown = await sendRequest.call(internals, path, requestOptions, requestType);
    if (!(response instanceof Response)) {
      throw new Error("The Hexclave client app's sendRequest did not resolve to a Response.");
    }
    return response;
  };
}

export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(Math.abs(diff) / 1000);
  const suffix = diff >= 0 ? "ago" : "from now";
  if (seconds < 60) return `${seconds}s ${suffix}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${suffix}`;
}

/** Loads `/internal/device-auth` for the currently viewed project and renders `children` with the data. */
export function DeviceAuthMonitor(props: {
  kind: DeviceAuthKind,
  children: (data: DeviceAuthData, projectId: string) => React.ReactNode,
}) {
  // Admin app for the currently-viewed project (not useStackApp(), which is the
  // dashboard's own client app) so the request hits this project's tenancy.
  const app = useAdminApp();
  const sendRequest = useMemo(() => getSendRequest(app), [app]);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const response = await sendRequest(urlString`/internal/device-auth?kind=${props.kind}`, { method: "GET" }, "admin");
        if (!response.ok) {
          throw new Error(`Failed to load device auth data: ${response.status}`);
        }
        const body: DeviceAuthData = await response.json();
        if (!cancelled) setState({ status: "ok", data: body });
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error" });
        captureError("device-auth-monitor-load", e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sendRequest, props.kind]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-20 w-full rounded-xl" />)}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Typography variant="secondary">Could not load the data. Please try again.</Typography>
        </CardContent>
      </Card>
    );
  }

  return <>{props.children(state.data, app.projectId)}</>;
}

export function KpiCard({ label, value, icon }: { label: string, value: number, icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <div className="flex items-center gap-1.5">
          {icon}
          <Typography variant="secondary" className="truncate text-[11px] uppercase tracking-wide">{label}</Typography>
        </div>
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
      </CardContent>
    </Card>
  );
}

const attemptStatusPresentation: Record<DeviceAuthAttemptStatus, { label: string, color: "green" | "blue" | "red" | "orange", icon: Icon, iconClassName: string }> = {
  used: { label: "Used", color: "green", icon: CheckCircleIcon, iconClassName: "text-emerald-500" },
  success: { label: "Ready", color: "blue", icon: CheckCircleIcon, iconClassName: "text-blue-500" },
  denied: { label: "Denied", color: "red", icon: XCircleIcon, iconClassName: "text-red-500" },
  expired: { label: "Expired", color: "red", icon: XCircleIcon, iconClassName: "text-red-500" },
  waiting: { label: "Waiting", color: "orange", icon: WarningCircleIcon, iconClassName: "text-amber-500" },
};

export function AttemptStatusIcon({ status }: { status: DeviceAuthAttemptStatus }) {
  const { icon: StatusIcon, iconClassName } = attemptStatusPresentation[status];
  return <StatusIcon className={`h-4 w-4 shrink-0 ${iconClassName}`} />;
}

export function AttemptStatusBadge({ status }: { status: DeviceAuthAttemptStatus }) {
  const { label, color } = attemptStatusPresentation[status];
  return <DesignBadge label={label} color={color} size="sm" />;
}

export function SessionsCard(props: {
  title: string,
  subtitle: string,
  icon: Icon,
  emptyText: string,
  sessions: DeviceAuthSession[],
  /** Primary line per row; defaults to the user's name. */
  renderTitle?: (session: DeviceAuthSession) => React.ReactNode,
  /** Secondary line per row; hidden when it returns null. */
  renderSubtitle?: (session: DeviceAuthSession) => React.ReactNode,
}) {
  const activeSessions = props.sessions.filter((session) => !session.is_expired);
  const expiredSessions = props.sessions.filter((session) => session.is_expired);
  const renderTitle = props.renderTitle ?? ((session: DeviceAuthSession) => session.display_name ?? session.primary_email ?? session.user_id);
  const renderSubtitle = props.renderSubtitle ?? ((session: DeviceAuthSession) => (
    session.primary_email != null && session.display_name != null ? session.primary_email : null
  ));

  return (
    <DesignCard title={props.title} subtitle={props.subtitle} icon={props.icon} glassmorphic>
      {activeSessions.length === 0 ? (
        <div className="py-6 text-center">
          <Typography variant="secondary" className="text-xs">{props.emptyText}</Typography>
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {activeSessions.map((session) => {
            const subtitle = renderSubtitle(session);
            return (
              <div key={session.session_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <Typography className="text-sm font-medium truncate">{renderTitle(session)}</Typography>
                  {subtitle != null && (
                    <Typography variant="secondary" className="text-xs truncate">{subtitle}</Typography>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col items-end gap-0.5">
                    <Typography variant="secondary" className="text-[11px]">
                      Active {formatRelativeTime(session.last_active_at)}
                    </Typography>
                    <Typography variant="secondary" className="text-[11px]">
                      {session.expires_at == null ? "No expiry" : `Expires ${new Date(session.expires_at).toLocaleDateString()}`}
                    </Typography>
                  </div>
                  <DesignBadge label="Active" color="green" size="sm" />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {expiredSessions.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground hover:transition-none">
            {expiredSessions.length} expired session{expiredSessions.length === 1 ? "" : "s"} in the lookup window
          </summary>
          <div className="mt-2 divide-y divide-border/40">
            {expiredSessions.map((session) => (
              <div key={session.session_id} className="flex items-center justify-between gap-3 py-2.5 opacity-60">
                <Typography className="text-sm truncate">{renderTitle(session)}</Typography>
                <div className="flex items-center gap-3 shrink-0">
                  <Typography variant="secondary" className="text-[11px]">
                    Expired {session.expires_at != null ? formatRelativeTime(session.expires_at) : ""}
                  </Typography>
                  <DesignBadge label="Expired" color="red" size="sm" />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </DesignCard>
  );
}

export function RecentAttemptsCard(props: {
  title: string,
  subtitle: string,
  emptyText: string,
  attempts: DeviceAuthAttempt[],
  /** Primary line per row; defaults to the attempt id prefix. */
  renderTitle?: (attempt: DeviceAuthAttempt) => React.ReactNode,
  /** Secondary line per row; defaults to the relative creation time. */
  renderSubtitle?: (attempt: DeviceAuthAttempt) => React.ReactNode,
}) {
  const renderTitle = props.renderTitle ?? ((attempt: DeviceAuthAttempt) => <span className="font-mono text-xs">{attempt.id.slice(0, 8)}</span>);
  const renderSubtitle = props.renderSubtitle ?? ((attempt: DeviceAuthAttempt) => formatRelativeTime(attempt.created_at));

  return (
    <DesignCard title={props.title} subtitle={props.subtitle} icon={ClockIcon} glassmorphic>
      {props.attempts.length === 0 ? (
        <div className="py-6 text-center">
          <Typography variant="secondary" className="text-xs">{props.emptyText}</Typography>
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {props.attempts.map((attempt) => (
            <div key={attempt.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <AttemptStatusIcon status={attempt.status} />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <Typography className="text-sm font-medium truncate">{renderTitle(attempt)}</Typography>
                  <Typography variant="secondary" className="text-[11px] truncate">{renderSubtitle(attempt)}</Typography>
                </div>
              </div>
              <AttemptStatusBadge status={attempt.status} />
            </div>
          ))}
        </div>
      )}
    </DesignCard>
  );
}
