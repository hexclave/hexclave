"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { getGrowthAdminStageRunState, getGrowthAdminStatus, listGrowthAdminProjects, type GrowthAdminProject, type GrowthAdminStageRunState } from "@/lib/growth/growth-api";
import type { GrowthTimelineStepId } from "@/lib/growth/growth-timeline";
import type { GrowthStatus } from "@/lib/growth/growth-types";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useStackApp, useUser } from "@hexclave/next";
import { ArrowLeftIcon, ChartLineIcon, CheckCircleIcon, CircleIcon, CircleNotchIcon, GlobeIcon, MagnifyingGlassIcon, PlugsConnectedIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageLayout } from "../../../page-layout";
import { useProjectId } from "../../../use-admin-app";
import { GrowthAdminInterviewCard } from "../interview-card";
import { getGrowthAdminLifecycleStep } from "../lifecycle-routes";
import { GrowthAdminReportsCard } from "../reports-card";
import { GrowthAdminRunNowCard } from "../run-now-card";

type Loadable =
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "loaded", project: GrowthAdminProject | null, lifecycle: GrowthStatus | null, operation: GrowthAdminStageRunState | null };

function ResearchProgress(props: { lifecycle: GrowthStatus }) {
  const steps = props.lifecycle.analysis.steps;
  if (steps == null) {
    return (
      <DesignCard title="Research progress" icon={MagnifyingGlassIcon}>
        <DesignAlert variant="info">No research checklist is available for this analysis run.</DesignAlert>
      </DesignCard>
    );
  }

  const completedCount = steps.filter((step) => step.state === "done").length;
  return (
    <DesignCard title="Research progress" icon={MagnifyingGlassIcon}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <DesignBadge label={`${completedCount} of ${steps.length} complete`} color={completedCount === steps.length ? "green" : "cyan"} size="sm" />
          <span className="text-sm text-muted-foreground">Overall status: {props.lifecycle.analysis.state}</span>
        </div>
        {props.lifecycle.analysis.errorMessage != null && (
          <DesignAlert variant="error">{props.lifecycle.analysis.errorMessage}</DesignAlert>
        )}
        <div className="divide-y divide-border/60 rounded-xl border border-border/70">
          {steps.map((step) => {
            const label = step.state === "done" ? "Done" : step.state === "running" ? "In progress" : step.state === "failed" ? "Failed" : "Not started";
            const color = step.state === "done" ? "green" : step.state === "running" ? "cyan" : step.state === "failed" ? "red" : "blue";
            const icon = step.state === "done"
              ? <CheckCircleIcon weight="fill" className="size-4 text-emerald-600 dark:text-emerald-400" />
              : step.state === "running"
                ? <CircleNotchIcon className="size-4 animate-spin text-cyan-600 dark:text-cyan-400" />
                : step.state === "failed"
                  ? <WarningCircleIcon weight="fill" className="size-4 text-destructive" />
                  : <CircleIcon className="size-4 text-muted-foreground/50" />;
            return (
              <div key={step.id} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="shrink-0">{icon}</span>
                  <span className={step.state === "pending" ? "truncate text-sm text-muted-foreground" : "truncate text-sm text-foreground"}>{step.label}</span>
                </div>
                <DesignBadge label={label} color={color} size="sm" />
              </div>
            );
          })}
        </div>
      </div>
    </DesignCard>
  );
}

function StepDetails(props: {
  app: object,
  project: GrowthAdminProject,
  lifecycle: GrowthStatus,
  stepId: GrowthTimelineStepId,
  operation: GrowthAdminStageRunState,
}) {
  if (props.stepId === "set-up") {
    return (
      <DesignCard title="Set up" icon={GlobeIcon}>
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <DesignBadge label={props.lifecycle.onboarding.completed ? "Complete" : "Incomplete"} color={props.lifecycle.onboarding.completed ? "green" : "orange"} size="sm" />
            <a href={props.project.websiteUrl} target="_blank" rel="noreferrer" className="text-muted-foreground underline underline-offset-4 transition-colors duration-150 hover:text-foreground hover:transition-none">
              {props.project.websiteUrl}
            </a>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Description</p>
            <p className="max-w-3xl leading-relaxed text-foreground">
              {props.project.companySummary ?? "No description provided."}
            </p>
          </div>
        </div>
      </DesignCard>
    );
  }

  if (props.stepId === "compute-metrics") {
    const metrics = props.lifecycle.analysis.computeMetrics;
    return (
      <DesignCard title="Metrics" icon={ChartLineIcon}>
        {metrics == null ? (
          <DesignAlert variant="info">This analysis run predates the compute-metrics phase.</DesignAlert>
        ) : (
          <div className="space-y-3">
            <DesignBadge label={metrics.state} color={metrics.state === "done" ? "green" : metrics.state === "failed" ? "red" : "cyan"} size="sm" />
            <div className="flex flex-col gap-2">
              {metrics.metricLabels.map((label) => (
                <div key={label} className="flex min-h-10 items-center gap-2 rounded-xl bg-foreground/[0.03] px-3 text-sm">
                  <CheckCircleIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        )}
      </DesignCard>
    );
  }

  if (props.stepId === "integrations") {
    const integrations = props.lifecycle.analysis.integrations;
    return (
      <DesignCard title="Integrations" icon={PlugsConnectedIcon}>
        {integrations == null
          ? <DesignAlert variant="info">This analysis run predates the integrations phase.</DesignAlert>
          : <div className="flex items-center gap-2"><DesignBadge label={integrations.state} color={integrations.state === "connected" || integrations.state === "skipped" ? "green" : "cyan"} size="sm" /><span className="text-sm text-muted-foreground">Integration state is managed by the analysis pipeline.</span></div>}
      </DesignCard>
    );
  }

  if (props.stepId === "analysis") {
    return <ResearchProgress lifecycle={props.lifecycle} />;
  }
  if (props.stepId === "interview") {
    return <GrowthAdminInterviewCard app={props.app} projectId={props.project.id} />;
  }
  return <GrowthAdminReportsCard app={props.app} projectId={props.project.id} operation={props.operation} />;
}

function StepContent(props: {
  app: object,
  project: GrowthAdminProject,
  lifecycle: GrowthStatus,
  stepId: GrowthTimelineStepId,
  operation: GrowthAdminStageRunState,
  refresh: () => Promise<void>,
}) {
  return (
    <div className="space-y-4">
      <GrowthAdminRunNowCard
        app={props.app}
        projectId={props.project.id}
        stage={props.stepId}
        operation={props.operation}
        onCompleted={props.refresh}
      />
      <StepDetails app={props.app} project={props.project} lifecycle={props.lifecycle} stepId={props.stepId} operation={props.operation} />
    </div>
  );
}

export default function PageClient() {
  useUser({ or: "redirect", projectIdMustMatch: "internal" });
  const mountedProjectId = useProjectId();
  if (mountedProjectId !== "internal") throwErr("Growth Admin must be opened from the internal project.");

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const app = useStackApp();
  const stepSegment = pathname.split("/").filter((segment) => segment.length > 0).at(-1) ?? "";
  const step = getGrowthAdminLifecycleStep(stepSegment);
  const targetProjectId = searchParams.get("targetProjectId");
  const [data, setData] = useState<Loadable>({ status: "loading" });
  const selectedProjectId = data.status === "loaded" && data.project != null ? data.project.id : targetProjectId ?? "";

  const load = useCallback(async (showLoading: boolean) => {
    if (showLoading) setData({ status: "loading" });
    try {
      const projects = await listGrowthAdminProjects(app);
      const project = targetProjectId == null
        ? (projects.at(0) ?? null)
        : (projects.find((candidate) => candidate.id === targetProjectId) ?? throwErr(`Growth Admin could not find project ${targetProjectId}.`));
      if (project == null) {
        setData({ status: "loaded", project: null, lifecycle: null, operation: null });
        return;
      }
      if (step == null) throwErr(`Growth Admin cannot load the unknown lifecycle step ${stepSegment}.`);
      const [lifecycle, operation] = await Promise.all([
        getGrowthAdminStatus(app, project.id),
        getGrowthAdminStageRunState(app, project.id, step.id),
      ]);
      setData({ status: "loaded", project, lifecycle, operation });
    } catch (error) {
      captureError("growth-admin-lifecycle-step-load", error);
      setData({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app, step, stepSegment, targetProjectId]);

  useEffect(() => runAsynchronously(load(true)), [load]);

  const operationIsRunning = data.status === "loaded" && data.operation?.state === "running";
  useEffect(() => {
    if (!operationIsRunning) return;
    const interval = setInterval(() => runAsynchronously(load(false)), 5000);
    return () => clearInterval(interval);
  }, [load, operationIsRunning]);

  const refresh = useCallback(async () => await load(false), [load]);

  return (
    <PageLayout
      allowContentOverflow
      width={1200}
      title={step == null ? "Unknown lifecycle step" : `${step.label} · Growth Admin`}
      description={data.status === "loaded" && data.project != null ? data.project.displayName : "Manage one customer lifecycle stage"}
      backLink={(
        <DesignButton asChild variant="ghost" size="sm" className="-ml-3 text-muted-foreground">
          <Link href={urlString`/projects/internal/gtm/admin?targetProjectId=${selectedProjectId}`}>
            <ArrowLeftIcon className="size-4" />
            Back to Growth Admin
          </Link>
        </DesignButton>
      )}
    >
      {step == null ? <DesignAlert variant="error">This lifecycle step does not exist.</DesignAlert>
        : data.status === "loading" ? <div className="h-48 animate-pulse rounded-2xl border bg-foreground/[0.03]" />
          : data.status === "error" ? <DesignAlert variant="error">{data.message}</DesignAlert>
            : data.project == null || data.lifecycle == null || data.operation == null ? <DesignAlert>No completed Growth onboarding records were found.</DesignAlert>
              : <StepContent app={app} project={data.project} lifecycle={data.lifecycle} stepId={step.id} operation={data.operation} refresh={refresh} />}
    </PageLayout>
  );
}
