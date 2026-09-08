"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
} from "@/components/design-components";
import { Link } from "@/components/link";
import { useRouter } from "@/components/router";
import { generateGrowthActionBlogDraft, listGrowthActions } from "@/lib/growth/growth-api";
import { getGrowthActionNarrativeSections } from "@/lib/growth/growth-action-document";
import { type GrowthLoadable, useGrowthStatus } from "@/lib/growth/growth-data";
import { GROWTH_DEMO_NOW_MILLIS, buildGrowthDemoActions, buildGrowthDemoAdsBodyForAction } from "@/lib/growth/growth-demo-data";
import type { GrowthDocument, GrowthDocumentBlock } from "@/lib/growth/growth-document";
import { getGrowthMetricLabel } from "@/lib/growth/growth-format";
import type { GrowthActionItem, GrowthActionWorkflow } from "@/lib/growth/growth-types";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArrowLeftIcon, ArrowSquareOutIcon, LightningIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { PageLayout } from "../../../page-layout";
import { useAdminApp, useProjectId } from "../../../use-admin-app";
import { WorkflowRunsGrid, WorkflowTriggers } from "../../../workflows/shared";
import { GROWTH_ACTION_TYPE_META, GrowthActionStatusBadge, useGrowthHref } from "../../components/action-card";
import { GrowthActionMutationControls } from "../../components/action-controls";
import { GrowthAppFrame } from "../../components/frame";
import { GrowthMarkdown } from "../../components/report-sections";
import { GrowthWorkflowSourceViewer } from "../../components/workflow-source-viewer";
import { GrowthDocumentFragment } from "../../components/growth-document";
import { RunAdsPayloadSection } from "./ads-panel";

export default function PageClient() {
  return (
    <GrowthAppFrame>
      <PageLayout title="Growth Action" description="Finding, evidence, recommendation, and tracking" allowContentOverflow>
        <ActionDetailBody />
      </PageLayout>
    </GrowthAppFrame>
  );
}

type ActionDetail = {
  /** `null` = the id doesn't exist in this workspace (not-found state, not an error). */
  action: GrowthActionItem | null,
};

// There is no single-action GET endpoint (deliberate: the list endpoint is the only read surface for
// actions), so the detail page pages through the list until it finds its id. The page bound is a
// safety valve against a pathological workspace; hitting it is a bug worth failing loudly on.
const MAX_LOOKUP_PAGES = 25;

async function findActionById(app: object, actionId: string): Promise<GrowthActionItem | null> {
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
    const result = await listGrowthActions(app, cursor == null ? {} : { cursor });
    const match = result.items.find((item) => item.id === actionId);
    if (match != null) return match;
    if (result.nextCursor == null) return null;
    cursor = result.nextCursor;
  }
  throw new Error(`Could not find the action within ${MAX_LOOKUP_PAGES} pages of action results.`);
}

function ActionDetailBody() {
  const app = useAdminApp();
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const { demo } = useGrowthStatus();
  const params = useParams<{ actionId: string }>();
  const actionId = params.actionId;
  const [data, setData] = useState<GrowthLoadable<ActionDetail>>({ status: "loading" });

  const load = useCallback(async () => {
    if (demo) {
      const action = buildGrowthDemoActions(GROWTH_DEMO_NOW_MILLIS).find((item) => item.id === actionId) ?? null;
      setData({
        status: "loaded",
        value: {
          action,
        },
      });
      return;
    }
    try {
      const action = await findActionById(app, actionId);
      setData({ status: "loaded", value: { action } });
    } catch (error) {
      captureError("growth-action-detail-load", error);
      setData({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app, demo, actionId]);

  useEffect(() => {
    setData({ status: "loading" });
    runAsynchronously(load());
  }, [load]);

  const backLink = (
    <Link
      href={withQuery(`/projects/${projectId}/gtm`)}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground hover:transition-none"
    >
      <ArrowLeftIcon className="size-4" />
      Growth overview
    </Link>
  );

  if (data.status === "loading") {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading action">
        {backLink}
        <div className="h-48 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-64 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
          <div className="h-64 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
        </div>
      </div>
    );
  }
  if (data.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <DesignAlert variant="error" className="items-center">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Could not load this action: {data.message}</span>
            <DesignButton variant="outline" size="sm" onClick={async () => {
              setData({ status: "loading" });
              await load();
            }}>
              Retry
            </DesignButton>
          </div>
        </DesignAlert>
      </div>
    );
  }
  if (data.value.action == null) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <div className="rounded-2xl border border-dashed border-foreground/[0.1] bg-foreground/[0.02] p-8 text-center">
          <p className="text-sm text-muted-foreground">
            This action does not exist (or was removed). Head back to the Growth overview to see the latest suggestions.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {backLink}
      <ActionNarrative
        action={data.value.action}
        demo={demo}
        onChanged={load}
      />
      <ActionPayloadSection action={data.value.action} demo={demo} onChanged={load} />
    </div>
  );
}


function ActionHeading(props: { action: GrowthActionItem }) {
  const { action } = props;
  const typeMeta = GROWTH_ACTION_TYPE_META.get(action.typeId) ?? { label: action.typeId, icon: LightningIcon };
  const dateLabel = action.activatedAtMillis != null
    ? `Activated ${new Date(action.activatedAtMillis).toLocaleDateString()}`
    : `Proposed ${new Date(action.createdAtMillis).toLocaleDateString()}`;
  const TypeIcon = typeMeta.icon;
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-balance text-xl font-semibold tracking-tight">{action.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><TypeIcon className="size-3.5" />{typeMeta.label}</span>
          <span aria-hidden="true">·</span>
          <span>{dateLabel}</span>
        </div>
      </div>
      <GrowthActionStatusBadge status={action.status} size="md" />
    </header>
  );
}


function ActionNarrativeBlock(props: { document: GrowthDocument, block: GrowthDocumentBlock, evidence: boolean }) {
  const { block, document } = props;
  if (block.type !== "component") return null;
  const isEditableSection = block.name === "Finding"
    || block.name === "Hypothesis"
    || block.name === "Evidence"
    || block.name === "Recommendation"
    || block.name === "Experiment";
  if (!isEditableSection) {
    return <GrowthDocumentFragment document={document} blocks={[block]} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />;
  }
  const datum = block.dataId == null ? null : document.data.find((candidate) => candidate.id === block.dataId) ?? null;
  const content = <GrowthDocumentFragment document={document} blocks={block.children} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />;
  if (!props.evidence) return content;
  return (
    <div className="border-b border-foreground/[0.08] py-4 first:pt-0 last:border-0 last:pb-0">
      {content}
      {datum != null && <p className="mt-2 text-xs text-muted-foreground">Source: {datum.source}</p>}
    </div>
  );
}

function ActionNarrativeSection(props: { title: "What we found" | "Evidence" | "What we suggest", document: GrowthDocument | null, blocks: GrowthDocumentBlock[], children?: React.ReactNode }) {
  const document = props.document;
  const sectionId = props.title === "What we found" ? "action-finding" : props.title === "Evidence" ? "action-evidence" : "action-recommendation";
  return (
    <section aria-labelledby={sectionId}>
      <h2 id={sectionId} className="mb-4 text-lg font-semibold tracking-tight">{props.title}</h2>
      {document != null && props.blocks.length > 0
        ? <div>{props.blocks.map((block, index) => <ActionNarrativeBlock key={`${block.type}-${index}`} document={document} block={block} evidence={props.title === "Evidence"} />)}</div>
        : <DesignAlert variant="warning">This suggestion does not include {props.title.toLocaleLowerCase()} content.</DesignAlert>}
      {props.children}
    </section>
  );
}

export function ActionMeasurementPlan(props: { watchedMetrics: GrowthActionItem["watchedMetrics"] }) {
  return (
    <section aria-labelledby="action-measurement-plan" className="border-t border-foreground/[0.08] pt-8">
      <h2 id="action-measurement-plan" className="text-lg font-semibold tracking-tight">What we&apos;ll track</h2>
      {props.watchedMetrics.length === 0
        ? <p className="mt-3 text-sm text-muted-foreground">No metrics are selected for this action.</p>
        : (
          <div className="mt-4 divide-y divide-foreground/[0.08] border-y border-foreground/[0.08]">
            {props.watchedMetrics.map((metric) => (
              <div key={metric.metricId} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <span className="text-sm font-medium text-foreground">{getGrowthMetricLabel(metric.metricId)}</span>
                <span className="text-sm text-muted-foreground">Track for {metric.windowDays} days</span>
              </div>
            ))}
          </div>
        )}
      <p className="mt-3 text-xs text-muted-foreground">Tracking starts when you activate this action.</p>
    </section>
  );
}

function ActionNarrative(props: { action: GrowthActionItem, demo: boolean, onChanged: () => Promise<void> }) {
  const { action } = props;
  const document = action.document ?? null;
  const sections = document == null
    ? { finding: [], evidence: [], recommendation: [] }
    : getGrowthActionNarrativeSections(document);
  return (
    <section className="border-y border-foreground/[0.08] py-7">
      <article className="mx-auto w-full max-w-4xl">
        <ActionHeading action={action} />
        <div className="flex flex-col gap-10">
          <ActionNarrativeSection title="What we found" document={document} blocks={sections.finding} />
          <ActionNarrativeSection title="Evidence" document={document} blocks={sections.evidence} />
          <ActionNarrativeSection title="What we suggest" document={document} blocks={sections.recommendation}>
            {action.workflow != null && <div className="mt-5"><ActionAutomationPreview action={action} workflow={action.workflow} /></div>}
            <div className="mt-5"><GrowthActionMutationControls action={action} onChanged={props.onChanged} demo={props.demo} /></div>
          </ActionNarrativeSection>
          <ActionMeasurementPlan watchedMetrics={action.watchedMetrics} />
        </div>
      </article>
    </section>
  );
}


const WORKFLOW_STATUS_BADGE = new Map<GrowthActionWorkflow["status"], { label: string, color: "cyan" | "green" | "orange" }>([
  ["not_deployed", { label: "Not deployed", color: "cyan" }],
  ["deployed", { label: "Deployed", color: "green" }],
  ["deleted", { label: "Deleted", color: "orange" }],
]);

/**
 * Run history for a deployed automation. Split out because it needs the workflow's latest version
 * (a WorkflowRunsGrid requirement) from the workflows listing hook, which only makes sense to
 * subscribe to once we know the workflow is deployed.
 */
function DeployedWorkflowRuns(props: { workflowId: string }) {
  const app = useAdminApp();
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const router = useRouter();
  const workflows = app.useWorkflows();
  const workflow = workflows.find((candidate) => candidate.id === props.workflowId);
  if (workflow == null) {
    // The wire said "deployed" but the listing lacks the definition — a race with a just-deleted
    // workflow. Reloading resolves it; render the same non-blocking notice as the deleted state.
    return (
      <DesignAlert variant="default">
        The automation&apos;s workflow could not be found in this project — it may have just been deleted. Reload to refresh its status.
      </DesignAlert>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Run history</span>
      <WorkflowRunsGrid
        workflowId={workflow.id}
        latestVersion={workflow.latestVersion}
        maxHeight={320}
        onOpenRun={() => {
          // Run drill-in (step timeline, retries) lives in the workflows app; hand over instead of
          // duplicating the dialog here.
          router.push(withQuery(`/projects/${projectId}/workflows/${workflow.id}`));
        }}
      />
    </div>
  );
}

function ActionAutomationPreview(props: { action: GrowthActionItem, workflow: GrowthActionWorkflow }) {
  const { action, workflow } = props;
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const statusBadge = WORKFLOW_STATUS_BADGE.get(workflow.status) ?? { label: workflow.status, color: "cyan" as const };
  return (
    <div className="flex flex-col gap-4 border-t border-foreground/[0.08] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold"><TreeStructureIcon className="size-4" />Workflow preview</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {action.status === "proposed" ? "Deployed and started when you activate this experiment" : "The workflow deployed by this experiment"}
          </p>
        </div>
        <DesignBadge label={statusBadge.label} color={statusBadge.color} size="md" />
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{workflow.workflowId}</span>
          <WorkflowTriggers triggers={workflow.triggers} />
          {workflow.status === "deployed" && (
            <Link
              href={withQuery(`/projects/${projectId}/workflows/${workflow.workflowId}`)}
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline"
            >
              Open in Workflows app
              <ArrowSquareOutIcon className="size-3.5" />
            </Link>
          )}
        </div>
        {workflow.status === "deleted" && (
          <DesignAlert variant="default">
            This automation was deleted in the Workflows app, so it will not run again. The action item itself stays — dismiss it if the work is off the table, or keep it to track the metrics.
          </DesignAlert>
        )}
        {workflow.status === "deployed" && workflow.lastRunState === "failed" && (
          <DesignAlert variant="error">
            The automation&apos;s most recent run failed. Open it in the Workflows app to see the failing step and retry it.
          </DesignAlert>
        )}
        {workflow.warnings.length > 0 && (
          <DesignAlert variant="warning">
            <ul className="list-disc pl-4">
              {workflow.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </DesignAlert>
        )}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">What it does</p>
            <p className="mt-1 text-sm text-muted-foreground">{workflow.explanation}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Undoing it</p>
            <p className="mt-1 text-sm text-muted-foreground">{workflow.rollbackNote}</p>
          </div>
        </div>
        <GrowthWorkflowSourceViewer workflowId={workflow.workflowId} source={workflow.source} />
        {workflow.status === "deployed" && <DeployedWorkflowRuns workflowId={workflow.workflowId} />}
      </div>
    </div>
  );
}

// The payload column is an opaque Json owned by the action-type registry; each type's renderer
// validates only the slice it needs and degrades gracefully (with a visible notice, never silently)
// when the shape is unexpected.
const blogPayloadSchema = z.object({ draft_markdown: z.string() });
// The idea an analysis run attaches instead of a finished post — the run proposes, the customer
// generates on demand (writing every proposed post inline was the slowest step of a growth run).
// Every field but the title is optional: a run that couldn't ground one shouldn't block generation.
const blogIdeaPayloadSchema = z.object({
  blog_idea: z.object({
    title: z.string(),
    target_intent: z.string().nullish(),
    aeo_angle: z.string().nullish(),
    outline_summary: z.string().nullish(),
  }),
});

/** One labelled line of the proposed idea; omitted entirely when the run didn't ground that field. */
function BlogIdeaRow(props: { label: string, value: string | null | undefined }) {
  if (props.value == null || props.value.trim().length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{props.label}</span>
      <span className="text-sm">{props.value}</span>
    </div>
  );
}

function BlogPayloadLayout(props: { title: string, description: string, children: React.ReactNode }) {
  return (
    <section className="border-b border-foreground/[0.08] py-7">
      <div className="mx-auto w-full max-w-4xl">
        <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
        <div className="mt-5">{props.children}</div>
      </div>
    </section>
  );
}

/**
 * The `publish_blog` payload panel. Two states, driven purely by whether a draft exists yet:
 * the proposed idea with a "Write the draft" button, or the finished post. The generated draft is
 * held in local state as well as written server-side, so the reader sees it immediately without
 * waiting for a refetch of the whole action.
 */
function BlogPayloadSection(props: { action: GrowthActionItem, demo: boolean }) {
  const app = useAdminApp();
  const { action, demo } = props;
  const [generatedDraft, setGeneratedDraft] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const storedDraft = blogPayloadSchema.safeParse(action.payload);
  const draftMarkdown = generatedDraft ?? (storedDraft.success ? storedDraft.data.draft_markdown : null);
  if (draftMarkdown != null) {
    return (
      <BlogPayloadLayout title="Blog draft" description="The post this action would publish">
        <GrowthMarkdown content={draftMarkdown} />
      </BlogPayloadLayout>
    );
  }

  const idea = blogIdeaPayloadSchema.safeParse(action.payload);
  if (!idea.success) {
    return (
      <BlogPayloadLayout title="Blog draft" description="The post this action would publish">
        <DesignAlert variant="warning">
          This action has no readable draft or idea attached yet — it will appear here once the analysis prepares one.
        </DesignAlert>
      </BlogPayloadLayout>
    );
  }

  const { blog_idea: blogIdea } = idea.data;
  return (
    <BlogPayloadLayout title="Article plan" description="Review the outline, then write the draft when you are ready.">
      <div className="flex flex-col gap-4">
        <details className="border-y border-foreground/[0.08] py-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2">View article plan</summary>
          <div className="mt-4 flex flex-col gap-3 pb-1">
            <BlogIdeaRow label="Working title" value={blogIdea.title} />
            <BlogIdeaRow label="Target search intent" value={blogIdea.target_intent} />
            <BlogIdeaRow label="Answer-engine angle" value={blogIdea.aeo_angle} />
            <BlogIdeaRow label="What it should cover" value={blogIdea.outline_summary} />
          </div>
        </details>
        {generateError != null && <DesignAlert variant="error">{generateError}</DesignAlert>}
        <div className="flex flex-wrap items-center gap-3">
          {/* DesignButton's async onClick drives its own loading state — generation takes a while,
            * so the button must not look idle while it runs. */}
          <DesignButton
            disabled={demo}
            onClick={async () => {
              setGenerateError(null);
              try {
                const result = await generateGrowthActionBlogDraft(app, action.id);
                setGeneratedDraft(result.draftMarkdown);
              } catch (error) {
                setGenerateError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            Write the draft
          </DesignButton>
          {demo && <span className="text-sm text-muted-foreground">Demo mode — generating is disabled on fixture data.</span>}
        </div>
      </div>
    </BlogPayloadLayout>
  );
}

function ActionPayloadSection(props: { action: GrowthActionItem, demo: boolean, onChanged: () => Promise<void> }) {
  const { action, demo, onChanged } = props;
  switch (action.typeId) {
    case "publish_blog": {
      return <BlogPayloadSection action={action} demo={demo} />;
    }
    case "run_ads": {
      return (
        <RunAdsPayloadSection
          actionId={action.id}
          actionStatus={action.status}
          payload={action.payload}
          demo={demo}
          demoAds={demo ? buildGrowthDemoAdsBodyForAction(action.id, GROWTH_DEMO_NOW_MILLIS) : null}
          onActivated={onChanged}
        />
      );
    }
    case "custom": {
      // Custom actions are described entirely by their title/description — nothing extra to render.
      return null;
    }
  }
}
