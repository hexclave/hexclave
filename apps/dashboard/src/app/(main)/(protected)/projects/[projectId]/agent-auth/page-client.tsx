"use client";

import { CodeBlock } from "@/components/code-block";
import { DesignAlert, DesignCard } from "@/components/design-components";
import { getPublicEnvVar } from "@/lib/env";
import { CheckCircleIcon, RobotIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { AppEnabledGuard } from "../app-enabled-guard";
import { DeviceAuthMonitor, KpiCard, RecentAttemptsCard, SessionsCard, formatRelativeTime } from "../device-auth-monitor";
import { PageLayout } from "../page-layout";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="agent-auth">
      <PageLayout title="Agent Auth" description="Let AI agents connect to your app with approved, revocable sessions">
        <DeviceAuthMonitor kind="agent">
          {({ summary, recent_attempts, sessions }, projectId) => {
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
                    and {summary.session_window_limit} agent sessions.
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
                  <KpiCard label="Waiting" value={summary.waiting_attempts_in_window} icon={<WarningCircleIcon className="h-4 w-4 text-amber-500" />} />
                  <KpiCard label="Connected" value={summary.used_attempts_in_window} icon={<CheckCircleIcon className="h-4 w-4 text-emerald-500" />} />
                  <KpiCard label="Denied" value={summary.denied_attempts_in_window} icon={<XCircleIcon className="h-4 w-4 text-red-500" />} />
                  <KpiCard label="Active agents" value={summary.active_sessions_in_window} icon={<RobotIcon className="h-4 w-4 text-blue-500" />} />
                </div>

                <SessionsCard
                  title="Active Agent Sessions"
                  subtitle={`${summary.active_sessions_in_window} active agent session${summary.active_sessions_in_window === 1 ? "" : "s"}`}
                  icon={RobotIcon}
                  emptyText="No agents are connected yet."
                  sessions={sessions}
                  renderTitle={(session) => session.agent_name}
                  renderSubtitle={(session) => session.is_anonymous
                    ? "anonymous session (waiting for a user to approve)"
                    : `acting as ${session.display_name ?? session.primary_email ?? session.user_id}`}
                />

                <RecentAttemptsCard
                  title="Recent Registrations"
                  subtitle={`Last ${summary.attempt_window_limit} agent registrations`}
                  emptyText="No agent registrations yet."
                  attempts={recent_attempts}
                  renderTitle={(attempt) => attempt.agent?.name}
                  renderSubtitle={(attempt) => [
                    formatRelativeTime(attempt.created_at),
                    attempt.agent?.user_hint != null ? `for ${attempt.agent.user_hint}` : null,
                    attempt.agent?.url,
                  ].filter((part) => part != null).join(" · ")}
                />
              </div>
            );
          }}
        </DeviceAuthMonitor>
      </PageLayout>
    </AppEnabledGuard>
  );
}
