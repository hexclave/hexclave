"use client";

import { DesignAlert, DesignButton, DesignSelectorDropdown } from "@/components/design-components";
import { Link } from "@/components/link";
import { getGrowthAdminEditGate } from "@/lib/growth/growth-admin-lifecycle";
import { createGrowthAdminNote, createGrowthAdminSuggestion, getGrowthAdminOverview, getGrowthAdminStatus, listGrowthAdminProjects, setGrowthAdminCategoryScore, updateGrowthAdminAction, updateGrowthAdminFinding, type GrowthAdminFunctionalActionFields, type GrowthAdminProject } from "@/lib/growth/growth-api";
import { getGrowthAdminReports, type GrowthAdminReportsBody } from "@/lib/growth/reports/growth-reports-admin-api";
import type { GrowthActionItem, GrowthOverview, GrowthStatus } from "@/lib/growth/growth-types";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useStackApp, useUser } from "@hexclave/next";
import { GearSixIcon } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useProjectId } from "../../use-admin-app";
import { GrowthWorkspaceEditProvider, type GrowthWorkspaceEditors } from "../components/workspace-edit";
import { GrowthWorkspaceContent } from "../components/workspace-overview";
import { GrowthAdminCategoryPageCard, GrowthAdminCategoryPagesProvider, GrowthAdminPublishAllCategoryPages } from "./category-page-card";
import { GrowthAdminLifecycleCard } from "./lifecycle-card";

type Loadable =
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "loaded", projects: GrowthAdminProject[], selected: GrowthAdminProject | null, overview: GrowthOverview | null, lifecycle: GrowthStatus | null, reports: GrowthAdminReportsBody | null };

/**
 * Functional fields are immutable once an action leaves the proposal stage — the backend rejects them —
 * so they are only ever sent for proposals, and then unchanged: the workspace edits the customer-facing
 * fields, and resending the current values keeps the PATCH from being read as "clear these".
 */
function functionalFieldsOf(action: GrowthActionItem): GrowthAdminFunctionalActionFields | undefined {
  if (action.status !== "proposed") return undefined;
  const workflow = action.workflow;
  return {
    payload: action.payload,
    watchedMetrics: action.watchedMetrics,
    workflow: workflow == null ? null : { workflowId: workflow.workflowId, source: workflow.source, explanation: workflow.explanation, rollbackNote: workflow.rollbackNote },
  };
}

/**
 * The customer's own Growth workspace, wired to the admin API. Rendering the same component the
 * customer gets — rather than an admin-shaped mirror of it — is the point: an admin sees precisely
 * what the customer sees, and edits it where it sits.
 */
function GrowthAdminWorkspace(props: { app: object, project: GrowthAdminProject, overview: GrowthOverview, lifecycle: GrowthStatus, reports: GrowthAdminReportsBody, refresh: () => Promise<void> }) {
  const { app, refresh } = props;
  const [nowMillis] = useState(() => Date.now());
  const projectId = props.project.id;
  const editors = useMemo<GrowthWorkspaceEditors>(() => ({
    saveCategoryScore: async (category, score) => {
      await setGrowthAdminCategoryScore(app, projectId, category, score);
      await refresh();
    },
    saveItem: async (item, patch) => {
      if (item.kind === "finding") {
        const finding = item.value;
        const category = patch.category ?? finding.category
          ?? throwErr("Give this item a stage before editing its other fields — the Growth API stores findings per stage.");
        await updateGrowthAdminFinding(app, projectId, finding.id, {
          kind: finding.kind,
          category,
          tags: patch.tags ?? finding.tags,
          title: patch.title ?? finding.title,
          body: patch.body ?? finding.body,
        });
      } else {
        const action = item.value;
        const category = patch.category ?? action.category
          ?? throwErr("Give this action a stage before editing its other fields — the Growth API stores actions per stage.");
        await updateGrowthAdminAction(app, projectId, {
          ...action,
          category,
          tags: patch.tags ?? action.tags,
          title: patch.title ?? action.title,
          description: patch.body ?? action.description,
        }, functionalFieldsOf(action));
      }
      await refresh();
    },
    saveActionStatus: async (action, status) => {
      const category = action.category ?? throwErr("Give this action a stage before changing its status.");
      await updateGrowthAdminAction(app, projectId, { ...action, category, status }, functionalFieldsOf(action));
      await refresh();
    },
    createNote: async (input) => {
      await createGrowthAdminNote(app, projectId, { category: input.category, tags: [], title: input.title, body: input.body });
      await refresh();
    },
    createSuggestion: async (input) => {
      await createGrowthAdminSuggestion(app, projectId, { category: input.category, tags: [], title: input.title, body: input.body });
      await refresh();
    },
  }), [app, projectId, refresh]);

  // This is a mirror of the customer's workspace, so it appears only after staff have actually
  // released the first report. Reaching or publishing the interview does not make the workspace
  // customer-visible; lifecycle-specific review and release controls remain available above.
  const gate = getGrowthAdminEditGate(props.lifecycle);
  const pendingReportId = props.reports.reports.find((report) => report.publishedAtMillis == null)?.id ?? null;
  const hasUnpublishedReport = pendingReportId != null;

  const workspace = (
    <GrowthAdminCategoryPagesProvider app={app} projectId={projectId}>
      <GrowthWorkspaceContent
        overview={props.overview}
        status={props.lifecycle}
        projectId={projectId}
        projectName={props.project.displayName}
        // The admin page always edits a real project's records; there is no demo fixture mode here.
        demo={false}
        onRefresh={refresh}
        journeyActions={<GrowthAdminPublishAllCategoryPages app={app} projectId={projectId} pendingReportId={pendingReportId} onPublishedChanged={refresh} />}
        // Authoring a stage page out of research that doesn't exist yet would be writing fiction, so
        // the composer appears with the rest of the editing affordances.
        categoryPageEditor={gate.contentEditable
          ? (category) => (
            <GrowthAdminCategoryPageCard
              app={app}
              projectId={projectId}
              category={category}
              overview={props.overview}
              onPublishedChanged={refresh}
            />
          )
          : undefined}
      />
    </GrowthAdminCategoryPagesProvider>
  );

  return (
    <div className="space-y-8">
      <GrowthAdminLifecycleCard projectId={projectId} status={props.lifecycle} gate={gate} nowMillis={nowMillis} hasUnpublishedReport={hasUnpublishedReport} />
      {gate.contentEditable && <GrowthWorkspaceEditProvider editors={editors}>{workspace}</GrowthWorkspaceEditProvider>}
    </div>
  );
}

export default function PageClient() {
  useUser({ or: "redirect", projectIdMustMatch: "internal" });
  const projectId = useProjectId();
  if (projectId !== "internal") throwErr("Growth Admin must be opened from the internal project.");
  const app = useStackApp();
  const searchParams = useSearchParams();
  const initialTargetProjectId = searchParams.get("targetProjectId") ?? undefined;
  const [data, setData] = useState<Loadable>({ status: "loading" });
  const load = useCallback(async (selectedId?: string) => {
    try {
      const projects = await listGrowthAdminProjects(app);
      const selected = projects.find((project) => project.id === selectedId) ?? projects.at(0) ?? null;
      const [overview, lifecycle, reports] = selected == null
        ? [null, null, null]
        : await Promise.all([getGrowthAdminOverview(app, selected.id), getGrowthAdminStatus(app, selected.id), getGrowthAdminReports(app, selected.id)]);
      setData({
        status: "loaded",
        projects,
        selected,
        overview,
        lifecycle,
        reports,
      });
    } catch (error) {
      captureError("growth-admin-load", error);
      setData({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app]);
  useEffect(() => runAsynchronously(load(initialTargetProjectId)), [initialTargetProjectId, load]);
  const loadedSelectedId = data.status === "loaded" ? data.selected?.id : undefined;
  const refresh = useCallback(async () => await load(loadedSelectedId), [load, loadedSelectedId]);
  return (
    <PageLayout
      allowContentOverflow
      width={1600}
      title="Growth Admin"
      description="The customer's own Growth workspace, with every field editable — without bypassing domain lifecycle rules"
    >
      {data.status === "loading" ? <div className="h-72 animate-pulse rounded-2xl border bg-foreground/[0.03]" />
        : data.status === "error" ? <DesignAlert variant="error"><div className="flex justify-between gap-3"><span>{data.message}</span><DesignButton onClick={() => load()}>Retry</DesignButton></div></DesignAlert>
          : data.selected == null || data.overview == null || data.lifecycle == null || data.reports == null ? <DesignAlert>No completed Growth onboarding records were found.</DesignAlert>
            : (
              <div className="space-y-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <DesignSelectorDropdown
                      value={data.selected.id}
                      onValueChange={(value) => {
                        setData({ status: "loading" });
                        runAsynchronously(load(value));
                      }}
                      options={data.projects.map((project) => ({ value: project.id, label: project.displayName }))}
                    />
                  </div>
                  <DesignButton asChild variant="outline" className="shrink-0 gap-2">
                    <Link href={urlString`/projects/${data.selected.id}/project-settings`}>
                      <GearSixIcon className="size-4" />
                      Project settings
                    </Link>
                  </DesignButton>
                </div>
                <GrowthAdminWorkspace app={app} project={data.selected} overview={data.overview} lifecycle={data.lifecycle} reports={data.reports} refresh={refresh} />
              </div>
            )}
    </PageLayout>
  );
}
