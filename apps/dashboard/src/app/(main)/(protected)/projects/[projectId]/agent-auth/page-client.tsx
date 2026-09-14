"use client";

import { CodeBlock } from "@/components/code-block";
import {
  DesignAlert,
  DesignBadge,
  DesignCard,
} from "@/components/design-components";
import { Skeleton, Typography } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { getPublicEnvVar } from "@/lib/env";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import {
  CheckCircleIcon,
  ClockIcon,
  RobotIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useEffect, useMemo, useState } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

type AgentAuthSummary = {
  attempts_in_window: number,
  pending_attempts_in_window: number,
  used_attempts_in_window: number,
  denied_attempts_in_window: number,
  expired_attempts_in_window: number,
  active_agent_sessions_in_window: number,
  attempt_window_limit: number,
  agent_session_window_limit: number,
};

type AgentAuthAttempt = {
  id: string,
  agent_name: string,
  agent_description: string | null,
  agent_url: string | null,
  user_hint: string | null,
  status: "pending" | "approved" | "denied" | "expired" | "used",
  approved_by_user_id: string | null,
  created_at: string,
  expires_at: string,
};

type AgentSession = {
  session_id: string,
  agent_name: string,
  user_id: string,
  display_name: string | null,
  primary_email: string | null,
  is_anonymous: boolean,
  created_at: string,
  last_active_at: string,
  expires_at: string | null,
  is_expired: boolean,
};

type AgentAuthData = {
  summary: AgentAuthSummary,
  recent_attempts: AgentAuthAttempt[],
  agent_sessions: AgentSession[],
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok", data: AgentAuthData };

type HexclaveAppInternals = {
  sendRequest: (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>,
};

function getStackAppInternals(appValue: unknown): HexclaveAppInternals {
  if (appValue == null || typeof appValue !== "object") {
    throw new Error("The Stack app instance is unavailable.");
  }
  const internals: unknown = Reflect.get(appValue, hexclaveAppInternalsSymbol);
  if (
    internals == null
    || typeof internals !== "object"
    || !("sendRequest" in internals)
    || typeof internals.sendRequest !== "function"
  ) {
    throw new Error("The Stack client app cannot send internal requests.");
  }
  const sendRequest = internals.sendRequest;
  return {
    sendRequest: (path, requestOptions, requestType) => {
      const result: unknown = sendRequest.call(internals, path, requestOptions, requestType);
      if (!(result instanceof Promise)) {
        throw new Error("The Stack client app's sendRequest did not return a promise.");
      }
      return result.then((response: unknown) => {
        if (!(response instanceof Response)) {
          throw new Error("The Stack client app's sendRequest did not resolve to a Response.");
        }
        return response;
      });
    },
  };
}

function formatRelativeTime(dateStr: string): string {
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

export default function PageClient() {
  return (
    <AppEnabledGuard appId="agent-auth">
      <PageLayout title="Agent Auth" description="Let AI agents connect to your app with approved, revocable sessions">
        <AgentAuthContent />
      </PageLayout>
    </AppEnabledGuard>
  );
}

function AgentAuthContent() {
  // Admin app for the currently-viewed project (not useStackApp(), which is the
  // dashboard's own client app) so /internal/agent-auth hits this project's tenancy.
  const app = useAdminApp();
  const appInternals = useMemo(() => getStackAppInternals(app), [app]);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const response = await appInternals.sendRequest("/internal/agent-auth", { method: "GET" }, "admin");
        if (!response.ok) {
          throw new Error(`Failed to load agent auth data: ${response.status}`);
        }
        const body: AgentAuthData = await response.json();
        if (!cancelled) setState({ status: "ok", data: body });
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error" });
        captureError("agent-auth-load", e);
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
          <Typography variant="secondary">Could not load agent auth data. Please try again.</Typography>
        </CardContent>
      </Card>
    );
  }

  return <AgentAuthDashboard projectId={app.projectId} data={state.data} />;
}

function AgentAuthDashboard({ projectId, data }: { projectId: string, data: AgentAuthData }) {
  const { summary, recent_attempts, agent_sessions } = data;
  const activeSessions = agent_sessions.filter((session) => !session.is_expired);
  const apiUrl = getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL") ?? "";
  const authMdUrl = `${apiUrl}${urlString`/api/v1/agent/auth.md`}`;
  const agentPrompt = `Read ${authMdUrl} (send the header x-hexclave-project-id: ${projectId}) and follow it to sign in to this app.`;

  return (
    <div className="flex flex-col gap-4">
      <DesignAlert
        variant="info"
        title="About Agent Auth"
        description={<>
          Agents read one Markdown file, register themselves, and hand the user a link to approve.
          Approval mints the agent its own session on the user&apos;s account, tagged with the agent&apos;s name,
          so RBAC, teams, and session revocation apply unchanged. Users can revoke an agent at any time from their
          account settings. Metrics below are bounded snapshots covering the newest {summary.attempt_window_limit} registrations
          and {summary.agent_session_window_limit} agent sessions.
        </>}
      />

      <DesignCard
        title="Point an agent at your app"
        subtitle="Paste this into any agent that can make HTTP requests"
        icon={RobotIcon}
        glassmorphic
      >
        <CodeBlock
          language="text"
          content={agentPrompt}
          title="Prompt"
          icon="code"
          compact
          neutralBackground
        />
      </DesignCard>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiCard label="Registrations" value={summary.attempts_in_window} icon={<RobotIcon className="h-4 w-4" />} />
        <KpiCard label="Pending" value={summary.pending_attempts_in_window} icon={<WarningCircleIcon className="h-4 w-4 text-amber-500" />} />
        <KpiCard label="Connected" value={summary.used_attempts_in_window} icon={<CheckCircleIcon className="h-4 w-4 text-emerald-500" />} />
        <KpiCard label="Denied" value={summary.denied_attempts_in_window} icon={<XCircleIcon className="h-4 w-4 text-red-500" />} />
        <KpiCard label="Active agents" value={summary.active_agent_sessions_in_window} icon={<RobotIcon className="h-4 w-4 text-blue-500" />} />
      </div>

      <DesignCard
        title="Active Agent Sessions"
        subtitle={`${activeSessions.length} active agent session${activeSessions.length === 1 ? "" : "s"}`}
        icon={RobotIcon}
        glassmorphic
      >
        {activeSessions.length === 0 ? (
          <div className="py-6 text-center">
            <Typography variant="secondary" className="text-xs">No agents are connected yet.</Typography>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {activeSessions.map((session) => (
              <div key={session.session_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <Typography className="text-sm font-medium truncate">{session.agent_name}</Typography>
                  <Typography variant="secondary" className="text-xs truncate">
                    {session.is_anonymous
                      ? "anonymous session (waiting for a user to approve)"
                      : `acting as ${session.display_name ?? session.primary_email ?? session.user_id}`}
                  </Typography>
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
            ))}
          </div>
        )}
      </DesignCard>

      <DesignCard
        title="Recent Registrations"
        subtitle={`Last ${summary.attempt_window_limit} agent registrations`}
        icon={ClockIcon}
        glassmorphic
      >
        {recent_attempts.length === 0 ? (
          <div className="py-6 text-center">
            <Typography variant="secondary" className="text-xs">No agent registrations yet.</Typography>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {recent_attempts.map((attempt) => (
              <div key={attempt.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <AttemptStatusIcon status={attempt.status} />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <Typography className="text-sm font-medium truncate">{attempt.agent_name}</Typography>
                    <Typography variant="secondary" className="text-[11px] truncate">
                      {formatRelativeTime(attempt.created_at)}
                      {attempt.user_hint != null ? ` · for ${attempt.user_hint}` : ""}
                      {attempt.agent_url != null ? ` · ${attempt.agent_url}` : ""}
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

function AttemptStatusIcon({ status }: { status: AgentAuthAttempt["status"] }) {
  switch (status) {
    case "used": {
      return <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-500" />;
    }
    case "approved": {
      return <CheckCircleIcon className="h-4 w-4 shrink-0 text-blue-500" />;
    }
    case "denied":
    case "expired": {
      return <XCircleIcon className="h-4 w-4 shrink-0 text-red-500" />;
    }
    case "pending": {
      return <WarningCircleIcon className="h-4 w-4 shrink-0 text-amber-500" />;
    }
  }
}

function AttemptStatusBadge({ status }: { status: AgentAuthAttempt["status"] }) {
  switch (status) {
    case "used": {
      return <DesignBadge label="Connected" color="green" size="sm" />;
    }
    case "approved": {
      return <DesignBadge label="Approved" color="blue" size="sm" />;
    }
    case "denied": {
      return <DesignBadge label="Denied" color="red" size="sm" />;
    }
    case "expired": {
      return <DesignBadge label="Expired" color="red" size="sm" />;
    }
    case "pending": {
      return <DesignBadge label="Pending" color="orange" size="sm" />;
    }
  }
}
