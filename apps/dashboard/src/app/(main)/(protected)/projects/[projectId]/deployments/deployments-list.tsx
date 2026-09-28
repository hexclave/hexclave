"use client";

// The Deployments app's top level: a list of deployments, one per `hexclave
// deploy`. Opening one shows that deploy's service map.
//
// This inverts the previous hierarchy, where the page was a board of SERVICES
// and each service had a "Deployments" tab listing its runs. A deploy ships
// several services together, so "what shipped, and did all of it land?" is the
// question the list answers first; the map is one level down.
//
// The list is flat across DEPLOYMENT SOURCES rather than grouped by them: a
// project deployed from several repositories has one source per repository, and
// what a reader wants first is the newest deploy of any of them. Each row
// therefore carries its source id, which is the only thing distinguishing two
// otherwise identical deploys of different repositories.

import { DesignBadge, DesignButton } from "@/components/design-components";
import { Skeleton, Typography, cn } from "@/components/ui";
import type { AdminDeploymentJson, AdminProject } from "@hexclave/next";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArrowClockwiseIcon, CaretRightIcon, CheckCircleIcon, CircleNotchIcon, ClockIcon, ProhibitIcon, RocketLaunchIcon, XCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

type DesignBadgeColor = "blue" | "cyan" | "purple" | "green" | "orange" | "red";

type StatusMeta = { label: string, color: DesignBadgeColor, icon: React.ElementType, spin: boolean };

function deploymentStatusMeta(status: AdminDeploymentJson["status"]): StatusMeta {
  switch (status) {
    case "queued": { return { label: "Queued", color: "blue", icon: ClockIcon, spin: false }; }
    case "building": { return { label: "Building", color: "cyan", icon: CircleNotchIcon, spin: true }; }
    case "deploying": { return { label: "Deploying", color: "cyan", icon: CircleNotchIcon, spin: true }; }
    case "deployed": { return { label: "Deployed", color: "green", icon: CheckCircleIcon, spin: false }; }
    case "failed": { return { label: "Failed", color: "red", icon: XCircleIcon, spin: false }; }
    case "canceled": { return { label: "Cancelled", color: "orange", icon: ProhibitIcon, spin: false }; }
    // A status the server added and this build doesn't know: render it rather
    // than crashing the whole list on one unexpected row.
    default: { return { label: status, color: "blue", icon: ClockIcon, spin: false }; }
  }
}

function isTerminalDeployment(deployment: AdminDeploymentJson): boolean {
  return deployment.status !== "queued" && deployment.status !== "building" && deployment.status !== "deploying";
}

function formatTime(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(deployment: AdminDeploymentJson): string | null {
  if (deployment.finished_at_millis == null) return null;
  const seconds = Math.max(0, Math.round((deployment.finished_at_millis - deployment.created_at_millis) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * One deployment. The whole row is the affordance for opening that deploy's
 * service map — there is no expansion, so the row summarises the outcome
 * (status, how many services, how long) and the map shows the detail.
 */
function DeploymentCard({ deployment, onOpen }: {
  deployment: AdminDeploymentJson,
  onOpen: () => void,
}) {
  const meta = deploymentStatusMeta(deployment.status);
  const Icon = meta.icon;
  const duration = formatDuration(deployment);
  const serviceCount = deployment.services.length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-border/60 px-4 py-3 text-left transition-colors duration-150 hover:bg-muted/40"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <Icon className={cn("h-4 w-4", meta.spin && "animate-spin")} />
        <DesignBadge label={meta.label} color={meta.color} size="sm" />
      </span>
      {/* Which deploy file shipped this. Given its own column rather than folded
          into the summary line: with several repositories deploying into one
          project it is the first thing that tells two rows apart, and it must
          stay readable when the service count and duration truncate. */}
      <span
        className="max-w-[14rem] shrink-0 truncate font-mono text-xs text-foreground/80"
        title={`Deployment source: ${deployment.deployment_source_id}`}
      >
        {deployment.deployment_source_id}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        #{deployment.number} · {serviceCount} service{serviceCount === 1 ? "" : "s"}
        {duration != null && ` · ${duration}`}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(deployment.created_at_millis)}</span>
      <CaretRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function DeploymentsList({ project, openDeploymentId, onOpenDeployment, onOpenDeploymentChange, onDeploymentsLoaded }: {
  project: AdminProject,
  // The deployment the caller currently has open, if any. This component keeps
  // polling while that view is up (it is hidden, not unmounted), and hands the
  // fresh copy back through onOpenDeploymentChange — otherwise an in-flight
  // deploy's statuses freeze at whatever they were when it was opened.
  openDeploymentId: string | null,
  onOpenDeployment: (deployment: AdminDeploymentJson) => void,
  onOpenDeploymentChange: (deployment: AdminDeploymentJson) => void,
  // Every deployment this list holds, of every source, on each poll. The open
  // deployment's map needs them: it shows what the OTHER sources had running at
  // that moment, which is read from their own deployments.
  onDeploymentsLoaded: (deployments: AdminDeploymentJson[]) => void,
}) {
  const [deployments, setDeployments] = useState<AdminDeploymentJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Read through a ref so the poll effect below doesn't restart (and lose its
  // interval) every time the open deployment changes identity.
  const openDeploymentIdRef = useRef(openDeploymentId);
  openDeploymentIdRef.current = openDeploymentId;
  const onOpenDeploymentChangeRef = useRef(onOpenDeploymentChange);
  onOpenDeploymentChangeRef.current = onOpenDeploymentChange;
  const onDeploymentsLoadedRef = useRef(onDeploymentsLoaded);
  onDeploymentsLoadedRef.current = onDeploymentsLoaded;

  const load = useCallback(async () => {
    try {
      const loaded = await project.listDeployments({ limit: 20 });
      setDeployments(loaded);
      onDeploymentsLoadedRef.current(loaded);
      setError(null);
      const openId = openDeploymentIdRef.current;
      if (openId !== null) {
        const refreshed = loaded.find((deployment) => deployment.id === openId);
        // Absent means it fell off the end of the 20-deployment page while open;
        // leave the caller's copy alone rather than blanking the view.
        if (refreshed !== undefined) onOpenDeploymentChangeRef.current(refreshed);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project]);

  useEffect(() => {
    runAsynchronously(load());
  }, [load]);

  // Always poll while the tab is open — a deploy can start from a terminal at
  // any time, and a deployment whose services all failed before starting a run
  // stays non-terminal forever, so gating on "something is in flight" would both
  // miss new deploys and poll one of those at full speed indefinitely. In-flight
  // work just gets a tighter interval.
  const hasInFlight = deployments?.some((deployment) => !isTerminalDeployment(deployment)) ?? false;
  useEffect(() => {
    const interval = setInterval(() => runAsynchronously(load()), hasInFlight ? 5000 : 20000);
    return () => clearInterval(interval);
  }, [hasInFlight, load]);

  // A failed refresh shows as a banner ABOVE whatever is already loaded, rather
  // than replacing it: returning early here would take the list and the Refresh
  // button away together, leaving no way to retry in-page.
  const errorBanner = error === null ? null : (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
      <Typography type="p" className="text-sm">Could not load deployments: {error}</Typography>
    </div>
  );

  const refreshButton = (
    <DesignButton
      variant="ghost"
      size="sm"
      onClick={() => {
        setRefreshing(true);
        runAsynchronously(load().finally(() => setRefreshing(false)));
      }}
    >
      <ArrowClockwiseIcon className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
      Refresh
    </DesignButton>
  );

  if (deployments === null) {
    return (
      <div className="flex flex-col gap-2">
        {errorBanner}
        {/* A failed FIRST load has no list to fall back on, so it needs its own
            retry control — otherwise the only way out is waiting for the poll. */}
        {error !== null && <div className="flex justify-end">{refreshButton}</div>}
        {error === null && [0, 1, 2].map((index) => <Skeleton key={index} className="h-14 w-full rounded-xl" />)}
      </div>
    );
  }

  if (deployments.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {errorBanner}
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 px-6 py-12 text-center">
          <RocketLaunchIcon className="h-8 w-8 text-muted-foreground" />
          <Typography type="h3" className="text-base font-semibold">No deployments yet</Typography>
          <Typography type="p" className="max-w-md text-sm text-muted-foreground">
            Define your services in the <code className="font-mono">deploy</code> export of{" "}
            <code className="font-mono">hexclave.deploy.ts</code>, give the file a{" "}
            <code className="font-mono">deploymentGroupId</code>, then run <code className="font-mono">hexclave deploy</code>.
            Each deploy shows up here with the services it shipped, tagged with the id of the deploy file it came from.
          </Typography>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {errorBanner}
      <div className="flex items-center justify-end">{refreshButton}</div>
      {deployments.map((deployment) => (
        <DeploymentCard
          key={deployment.id}
          deployment={deployment}
          onOpen={() => onOpenDeployment(deployment)}
        />
      ))}
    </div>
  );
}
