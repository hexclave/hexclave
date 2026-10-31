"use client";

import { UserTable } from "@/components/data-table/user-table";
import { StyledLink } from "@/components/link";
import { Alert, Button, SimpleTooltip, Skeleton } from "@/components/ui";
import { UserDialog } from "@/components/user-dialog";
import {
  fetchEntityKpisOrThrow,
  fetchMetricsUserCountsOrThrow,
  type MetricsEntityKpis,
  type MetricsUserCounts,
  useMetricsUserCountsOrThrow,
} from "@/lib/hexclave-app-internals";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";
import { UsersKpiCards } from "./users-kpi-cards";

const capturedUsersMetricsErrors = new WeakSet<Error>();

function captureUsersMetricsErrorOnce(error: Error) {
  if (capturedUsersMetricsErrors.has(error)) {
    return;
  }
  capturedUsersMetricsErrors.add(error);
  captureError("users-total-metrics-error-boundary", error);
}

function TotalUsersDisplay() {
  const hexclaveAdminApp = useAdminApp();
  const metrics = useMetricsUserCountsOrThrow(hexclaveAdminApp);
  return <TotalUsersText metrics={metrics} />;
}

function TotalUsersText(props: {
  metrics: MetricsUserCounts,
}) {
  const { metrics } = props;
  const anonymousUsersCount = metrics.anonymous_users;
  const nonAnonymousUsersCount = metrics.total_users - anonymousUsersCount;

  return (
    <>
      {nonAnonymousUsersCount}
      {anonymousUsersCount > 0 ? (
        <>
          {" "}(+ {anonymousUsersCount}{" "}
          <SimpleTooltip
            inline
            tooltip="When analytics are enabled, visitors that have not signed up yet are counted as anonymous users."
          >
            <span className="underline decoration-dotted underline-offset-2">anonymous visitors</span>
          </SimpleTooltip>
          )
        </>
      ) : null}
    </>
  );
}

function TotalUsersErrorComponent(props: { error: unknown }) {
  if (props.error instanceof Error) {
    captureUsersMetricsErrorOnce(props.error);
  }
  return <>Unavailable</>;
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const firstUserPage = hexclaveAdminApp.useUsers({ limit: 1 });
  const tableReloadRef = useRef<() => void>(() => {});
  const [userCounts, setUserCounts] = useState<MetricsUserCounts | null>(null);
  const [kpis, setKpis] = useState<MetricsEntityKpis | null>(null);
  const [kpisError, setKpisError] = useState<unknown>(null);

  // The KPI queries are much slower than the user count on large projects, so
  // each one updates its part of the page as soon as it arrives.
  // Refreshes can overlap (refresh button, mutations, page restore); only the
  // latest one may update state.
  const latestRefreshRef = useRef(0);
  const refreshUsersMetrics = useCallback(async () => {
    const refreshId = ++latestRefreshRef.current;
    const isLatest = () => refreshId === latestRefreshRef.current;
    // Show the skeleton again on retry instead of keeping the cards hidden.
    setKpisError(null);
    const kpisPromise = fetchEntityKpisOrThrow(hexclaveAdminApp, "users").then(
      (result) => {
        if (!isLatest()) return;
        setKpis(result);
        setKpisError(null);
      },
      (error: unknown) => {
        if (isLatest()) setKpisError(error);
      },
    );
    const counts = await fetchMetricsUserCountsOrThrow(hexclaveAdminApp);
    if (isLatest()) setUserCounts(counts);
    await kpisPromise;
  }, [hexclaveAdminApp]);

  useEffect(() => {
    const refresh = () => runAsynchronously(refreshUsersMetrics);
    const refreshAfterPageRestore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        refresh();
      }
    };
    refresh();
    window.addEventListener("pageshow", refreshAfterPageRestore);
    return () => window.removeEventListener("pageshow", refreshAfterPageRestore);
  }, [refreshUsersMetrics]);

  const handleTableReloadChange = useCallback((reload: () => void) => {
    tableReloadRef.current = reload;
  }, []);

  const handleUserMutated = useCallback(() => {
    tableReloadRef.current();
    runAsynchronouslyWithAlert(refreshUsersMetrics);
  }, [refreshUsersMetrics]);

  const handleRefresh = useCallback(() => {
    tableReloadRef.current();
    runAsynchronouslyWithAlert(refreshUsersMetrics);
  }, [refreshUsersMetrics]);

  const hasUsers = userCounts != null
    ? userCounts.total_users - userCounts.anonymous_users > 0
    : firstUserPage.length > 0;

  return (
    <AppEnabledGuard appId="authentication">
      <PageLayout
        title="Users"
        description={<>
          Total:{" "}
          <ErrorBoundary errorComponent={TotalUsersErrorComponent}>
            {userCounts != null ? (
              <TotalUsersText metrics={userCounts} />
            ) : (
              <Suspense fallback={<Skeleton className="inline"><span>Calculating</span></Skeleton>}>
                <TotalUsersDisplay />
              </Suspense>
            )}
          </ErrorBoundary>
        </>}
        actions={
          <div className="flex gap-2">
            <SimpleTooltip tooltip="Refresh">
              <Button variant="outline" size="icon" onClick={handleRefresh}>
                <ArrowsClockwiseIcon className="h-4 w-4" />
              </Button>
            </SimpleTooltip>
            <UserDialog
              type="create"
              trigger={<Button>Create User</Button>}
              onUserMutated={handleUserMutated}
            />
          </div>
        }
      >
        {hasUsers ? null : (
          <Alert variant='success'>
            Congratulations on starting your project! Check the <StyledLink href="https://docs.hexclave.com">documentation</StyledLink> to add your first users.
          </Alert>
        )}

        <UsersKpiCards kpis={kpis} error={kpisError} />

        <div data-walkthrough="users-table">
          <UserTable onUserMutated={handleUserMutated} onReloadChange={handleTableReloadChange} />
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}
