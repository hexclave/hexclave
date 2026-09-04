"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignCard,
} from "@/components/design-components";
import { Skeleton, Typography } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import {
  CheckCircleIcon,
  ClockIcon,
  TerminalWindowIcon,
  UserIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useState } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

type CliAuthSummary = {
  attempts_in_window: number,
  completed_attempts_in_window: number,
  used_attempts_in_window: number,
  expired_attempts_in_window: number,
  pending_attempts_in_window: number,
  active_tokens_in_lookup_window: number,
  attempt_window_limit: number,
  active_token_lookup_window_limit: number,
};

type CliAuthAttempt = {
  id: string,
  status: "pending" | "completed" | "expired" | "used",
  created_at: string,
  expires_at: string,
  used_at: string | null,
};

type CliAuthUser = {
  user_id: string,
  display_name: string | null,
  primary_email: string | null,
  token_created_at: string,
  last_active_at: string,
  expires_at: string | null,
  is_expired: boolean,
};

type CliAuthData = {
  summary: CliAuthSummary,
  recent_attempts: CliAuthAttempt[],
  active_cli_users: CliAuthUser[],
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok", data: CliAuthData };

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

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function PageClient() {
  return (
    <AppEnabledGuard appId="cli-auth">
      <PageLayout title="CLI Auth" description="Monitor recent authentication attempts and CLI sessions">
        <CliAuthContent />
      </PageLayout>
    </AppEnabledGuard>
  );
}

function CliAuthContent() {
  // Use the admin app for the currently-viewed project (not useStackApp(), which
  // returns the dashboard's own internal-project client app): this both carries
  // admin credentials and scopes the /internal/cli-auth request to this project's
  // tenancy. Mirrors the external-db-sync page pattern.
  const app = useAdminApp();
  const appInternals = useMemo(() => getStackAppInternals(app), [app]);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const response = await appInternals.sendRequest("/internal/cli-auth", { method: "GET" }, "admin");
        if (!response.ok) {
          throw new Error(`Failed to load CLI auth data: ${response.status}`);
        }
        const body = await response.json() as CliAuthData;
        if (!cancelled) setState({ status: "ok", data: body });
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error" });
        captureError("cli-auth-load", e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appInternals]);

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
          <Typography variant="secondary">Could not load CLI auth data. Please try again.</Typography>
        </CardContent>
      </Card>
    );
  }

  return <CliAuthDashboard data={state.data} />;
}

function CliAuthDashboard({ data }: { data: CliAuthData }) {
  const { summary, recent_attempts, active_cli_users } = data;
  const activeUsers = active_cli_users.filter((user) => !user.is_expired);
  const expiredUsers = active_cli_users.filter((user) => user.is_expired);

  return (
    <div className="flex flex-col gap-4">
      <DesignAlert
        variant="info"
        title="About CLI Auth"
        description={<>
          CLI Auth allows users to authenticate from command-line tools using a browser-based login flow.
          The CLI initiates a session, the user confirms in a browser, and a refresh token is issued to the CLI.
          Metrics below are bounded snapshots: attempt counts cover the newest {summary.attempt_window_limit} attempts,
          and CLI sessions are discovered from the newest {summary.active_token_lookup_window_limit} attempts.
        </>}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiCard label="Recent attempts" value={summary.attempts_in_window} icon={<TerminalWindowIcon className="h-4 w-4" />} />
        <KpiCard label="Used" value={summary.used_attempts_in_window} icon={<CheckCircleIcon className="h-4 w-4 text-emerald-500" />} />
        <KpiCard label="Ready" value={summary.completed_attempts_in_window} icon={<CheckCircleIcon className="h-4 w-4 text-blue-500" />} />
        <KpiCard label="Expired" value={summary.expired_attempts_in_window} icon={<XCircleIcon className="h-4 w-4 text-red-500" />} />
        <KpiCard label="Active tokens" value={summary.active_tokens_in_lookup_window} icon={<UserIcon className="h-4 w-4 text-blue-500" />} />
      </div>

      <DesignCard
        title="Active CLI Sessions"
        subtitle={`${summary.active_tokens_in_lookup_window} active token${summary.active_tokens_in_lookup_window === 1 ? "" : "s"} found in the latest ${summary.active_token_lookup_window_limit} attempts`}
        icon={UserIcon}
        glassmorphic
      >
        {activeUsers.length === 0 ? (
          <div className="py-6 text-center">
            <Typography variant="secondary" className="text-xs">No active CLI sessions in the lookup window.</Typography>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {activeUsers.map((user) => (
              <div key={`${user.user_id}-${user.token_created_at}`} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <Typography className="text-sm font-medium truncate">
                    {user.display_name ?? user.primary_email ?? user.user_id}
                  </Typography>
                  {user.primary_email != null && user.display_name != null && (
                    <Typography variant="secondary" className="text-xs truncate">{user.primary_email}</Typography>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex flex-col items-end gap-0.5">
                    <Typography variant="secondary" className="text-[11px]">
                      Active {formatRelativeTime(user.last_active_at)}
                    </Typography>
                    <Typography variant="secondary" className="text-[11px]">
                      {user.expires_at == null ? "No expiry" : `Expires ${new Date(user.expires_at).toLocaleDateString()}`}
                    </Typography>
                  </div>
                  <DesignBadge label="Active" color="green" size="sm" />
                </div>
              </div>
            ))}
          </div>
        )}
        {expiredUsers.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground hover:transition-none">
              {expiredUsers.length} expired session{expiredUsers.length === 1 ? "" : "s"} in the lookup window
            </summary>
            <div className="mt-2 divide-y divide-border/40">
              {expiredUsers.map((user) => (
                <div key={`${user.user_id}-${user.token_created_at}`} className="flex items-center justify-between gap-3 py-2.5 opacity-60">
                  <Typography className="text-sm truncate">
                    {user.display_name ?? user.primary_email ?? user.user_id}
                  </Typography>
                  <div className="flex items-center gap-3 shrink-0">
                    <Typography variant="secondary" className="text-[11px]">
                      Expired {user.expires_at != null ? formatRelativeTime(user.expires_at) : ""}
                    </Typography>
                    <DesignBadge label="Expired" color="red" size="sm" />
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </DesignCard>

      <DesignCard
        title="Recent Login Attempts"
        subtitle="Last 50 CLI authentication attempts"
        icon={ClockIcon}
        glassmorphic
      >
        {recent_attempts.length === 0 ? (
          <div className="py-6 text-center">
            <Typography variant="secondary" className="text-xs">No CLI auth attempts yet.</Typography>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {recent_attempts.map((attempt) => (
              <div key={attempt.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <AttemptStatusIcon status={attempt.status} />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <Typography className="text-xs font-mono truncate">{attempt.id.slice(0, 8)}</Typography>
                    <Typography variant="secondary" className="text-[11px]">
                      {formatRelativeTime(attempt.created_at)}
                    </Typography>
                  </div>
                </div>
                <AttemptStatusBadge status={attempt.status} />
              </div>
            ))}
          </div>
        )}
      </DesignCard>
    </div>
  );
}

function KpiCard({ label, value, icon }: { label: string, value: number, icon: React.ReactNode }) {
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

function AttemptStatusIcon({ status }: { status: CliAuthAttempt["status"] }) {
  switch (status) {
    case "used": {
      return <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-500" />;
    }
    case "completed": {
      return <CheckCircleIcon className="h-4 w-4 shrink-0 text-blue-500" />;
    }
    case "expired": {
      return <XCircleIcon className="h-4 w-4 shrink-0 text-red-500" />;
    }
    case "pending": {
      return <WarningCircleIcon className="h-4 w-4 shrink-0 text-amber-500" />;
    }
    default: {
      return <WarningCircleIcon className="h-4 w-4 shrink-0 text-gray-400" />;
    }
  }
}

function AttemptStatusBadge({ status }: { status: CliAuthAttempt["status"] }) {
  switch (status) {
    case "used": {
      return <DesignBadge label="Used" color="green" size="sm" />;
    }
    case "completed": {
      return <DesignBadge label="Ready" color="blue" size="sm" />;
    }
    case "expired": {
      return <DesignBadge label="Expired" color="red" size="sm" />;
    }
    case "pending": {
      return <DesignBadge label="Pending" color="orange" size="sm" />;
    }
    default: {
      return <DesignBadge label={status} color="orange" size="sm" />;
    }
  }
}
