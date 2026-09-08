"use client";

import { DesignAlert, DesignButton, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { buildGrowthDemoActions, GROWTH_DEMO_NOW_MILLIS } from "@/lib/growth/growth-demo-data";
import { useGrowthStatus } from "@/lib/growth/growth-data";
import type { GrowthActionItem, GrowthStatus } from "@/lib/growth/growth-types";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { FlaskIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { GrowthActionCard, useGrowthHref } from "../components/action-card";
import { GrowthAppFrame, GrowthStatusGate } from "../components/frame";
import { GrowthReportHoldPanel } from "../components/report-hold";
import { listAllActiveGrowthExperiments } from "./experiments-data";

type ExperimentsState =
  | { status: "loading", sourceKey: string }
  | { status: "error", sourceKey: string, message: string }
  | { status: "loaded", sourceKey: string, items: GrowthActionItem[] };

export default function PageClient() {
  return (
    <GrowthAppFrame>
      <PageLayout title="Experiments" description="Active growth experiments and the metrics they are tracking">
        <GrowthStatusGate>
          {(status) => status.release.state === "released" ? <ActiveExperiments /> : <ExperimentsLocked status={status} />}
        </GrowthStatusGate>
      </PageLayout>
    </GrowthAppFrame>
  );
}

function ExperimentsLocked(props: { status: GrowthStatus }) {
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const overviewLink = (
    <Link href={withQuery(urlString`/projects/${projectId}/gtm`)}>
      <DesignButton variant="outline" size="sm">Go to the Growth overview</DesignButton>
    </Link>
  );
  if (props.status.release.state === "preparing") {
    return <GrowthReportHoldPanel>{overviewLink}</GrowthReportHoldPanel>;
  }
  return (
    <DesignCard>
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <FlaskIcon className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Experiments open with your first report</p>
        <p className="max-w-md text-sm text-muted-foreground">Complete your first Growth analysis, then activate recommendations to track them here.</p>
        <div className="mt-2">{overviewLink}</div>
      </div>
    </DesignCard>
  );
}

function ExperimentsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading active experiments">
      {[0, 1, 2, 3].map((index) => <div key={index} className="h-44 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />)}
    </div>
  );
}

export function ActiveExperiments() {
  const app = useAdminApp();
  const projectId = useProjectId();
  const { demo } = useGrowthStatus();
  const sourceKey = `${projectId}:${demo ? "demo" : "live"}`;
  const [state, setState] = useState<ExperimentsState>({ status: "loading", sourceKey });
  const latestRequestId = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestRequestId.current;
    try {
      const items = demo
        ? buildGrowthDemoActions(GROWTH_DEMO_NOW_MILLIS).filter((action) => action.status === "active")
        : await listAllActiveGrowthExperiments(app);
      if (requestId !== latestRequestId.current) return;
      setState({ status: "loaded", sourceKey, items });
    } catch (error) {
      if (requestId !== latestRequestId.current) return;
      captureError("growth-experiments-load", error);
      setState({ status: "error", sourceKey, message: error instanceof Error ? error.message : String(error) });
    }
  }, [app, demo, sourceKey]);

  useEffect(() => {
    setState({ status: "loading", sourceKey });
    runAsynchronously(load());
  }, [load, sourceKey]);

  // Effects start after paint. Refuse to render a previous project's experiments during that gap.
  if (state.sourceKey !== sourceKey || state.status === "loading") return <ExperimentsSkeleton />;
  if (state.status === "error") {
    return (
      <DesignAlert variant="error">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>Could not load active experiments: {state.message}</span>
          <DesignButton size="sm" variant="outline" onClick={load}>Retry</DesignButton>
        </div>
      </DesignAlert>
    );
  }
  if (state.items.length === 0) {
    return (
      <DesignCard>
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <FlaskIcon className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No active experiments</p>
          <p className="max-w-md text-sm text-muted-foreground">Activate a recommendation from your Growth report and it will appear here.</p>
        </div>
      </DesignCard>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {state.items.length} active {state.items.length === 1 ? "experiment" : "experiments"}
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {state.items.map((experiment) => <GrowthActionCard key={experiment.id} action={experiment} linkLabel="Review experiment" />)}
      </div>
    </div>
  );
}
