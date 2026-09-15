"use client";

import { DesignAlert } from "@/components/design-components";
import { CheckCircleIcon, TerminalWindowIcon, UserIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { DeviceAuthMonitor, KpiCard, RecentAttemptsCard, SessionsCard } from "../device-auth-monitor";
import { PageLayout } from "../page-layout";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="cli-auth">
      <PageLayout title="CLI Auth" description="Monitor recent authentication attempts and CLI sessions">
        <DeviceAuthMonitor kind="cli">
          {({ summary, recent_attempts, sessions }) => (
            <div className="flex flex-col gap-4">
              <DesignAlert
                variant="info"
                title="About CLI Auth"
                description={<>
                  CLI Auth allows users to authenticate from command-line tools using a browser-based login flow.
                  The CLI initiates a session, the user confirms in a browser, and a refresh token is issued to the CLI.
                  Metrics below are bounded snapshots: attempt counts cover the newest {summary.attempt_window_limit} attempts,
                  and CLI sessions are discovered from the newest {summary.session_window_limit} attempts.
                </>}
              />

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <KpiCard label="Recent attempts" value={summary.attempts_in_window} icon={<TerminalWindowIcon className="h-4 w-4" />} />
                <KpiCard label="Waiting" value={summary.waiting_attempts_in_window} icon={<WarningCircleIcon className="h-4 w-4 text-amber-500" />} />
                <KpiCard label="Used" value={summary.used_attempts_in_window} icon={<CheckCircleIcon className="h-4 w-4 text-emerald-500" />} />
                <KpiCard label="Expired" value={summary.expired_attempts_in_window} icon={<XCircleIcon className="h-4 w-4 text-red-500" />} />
                <KpiCard label="Active sessions" value={summary.active_sessions_in_window} icon={<UserIcon className="h-4 w-4 text-blue-500" />} />
              </div>

              <SessionsCard
                title="Active CLI Sessions"
                subtitle={`${summary.active_sessions_in_window} active session${summary.active_sessions_in_window === 1 ? "" : "s"} found in the latest ${summary.session_window_limit} attempts`}
                icon={UserIcon}
                emptyText="No active CLI sessions in the lookup window."
                sessions={sessions}
              />

              <RecentAttemptsCard
                title="Recent Login Attempts"
                subtitle={`Last ${summary.attempt_window_limit} CLI authentication attempts`}
                emptyText="No CLI auth attempts yet."
                attempts={recent_attempts}
              />
            </div>
          )}
        </DeviceAuthMonitor>
      </PageLayout>
    </AppEnabledGuard>
  );
}
