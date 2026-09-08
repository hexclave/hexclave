import { sendInternalUserRequest } from "@/lib/hexclave-app-internals";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { GrowthApiError, growthRequestHeaders, readGrowthErrorMessage, requestJson, toGrowthApiError } from "./growth-api-client";
import { growthDocumentSchema } from "./growth-document";
import { GROWTH_TIMELINE_STEP_IDS, type GrowthTimelineStepId } from "./growth-timeline";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { z } from "zod";
import {
  GROWTH_ACTION_STATUSES,
  GROWTH_ACTION_TYPES,
  GROWTH_CATEGORIES,
  GROWTH_ACTION_WORKFLOW_STATUSES,
  GROWTH_ADS_CREATION_STEPS,
  GROWTH_ADS_VERIFICATION_OUTCOMES,
  type GrowthAdsVerificationOutcome,
  GROWTH_ADS_STATUSES,
  GROWTH_ANALYSIS_STATES,
  GROWTH_ANALYSIS_STEP_STATES,
  GROWTH_BRIEF_STATUSES,
  GROWTH_CATALOG_METRIC_CATEGORIES,
  GROWTH_CATALOG_METRIC_KINDS,
  GROWTH_CATALOG_METRIC_UNITS,
  GROWTH_INTEGRATIONS_STATES,
  GROWTH_INTERVIEW_QUESTION_KINDS,
  GROWTH_INTERVIEW_QUESTION_ORIGINS,
  GROWTH_INTERVIEW_STATES,
  GROWTH_INTERVIEW_STATUSES,
  GROWTH_METRIC_IDS,
  GROWTH_MILESTONE_COMPARATORS,
  GROWTH_MILESTONE_SOURCES,
  GROWTH_MILESTONE_STATUSES,
  GROWTH_PHASE_STATUSES,
  GROWTH_PIPELINE_WORKFLOW_IDS,
  GROWTH_RUN_STATUSES,
  GROWTH_RELEASE_STATES,
  GROWTH_RUN_TRIGGERS,
  type GrowthActionItem,
  type GrowthAdminActionPage,
  type GrowthAdminFindingPage,
  type GrowthActionMetricSeries,
  type GrowthActionStatus,
  type GrowthAdminCategoryPage,
  type GrowthAdsBody,
  type GrowthAdsEntity,
  type GrowthBrief,
  type GrowthCategory,
  type GrowthCategoryPageVersion,
  type GrowthCategoryPageVersionSummary,
  type GrowthBriefStatus,
  type GrowthInterview,
  type GrowthInterviewStatus,
  type GrowthMetricId,
  type GrowthMetricsOverview,
  type GrowthOverview,
  type GrowthMilestone,
  type GrowthPipelineWorkflowId,
  type GrowthPublishedCategoryPage,
  type GrowthReport,
  type GrowthRun,
  type GrowthStatus,
} from "./growth-types";

const analysisStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  // `.optional()` for the same reason compute_metrics below is: a development environment's dashboard can
  // talk to a backend that predates this field. Absent means "no hover explanation", not an error.
  description: z.string().optional(),
  state: z.enum(GROWTH_ANALYSIS_STEP_STATES),
});

// The compute-metrics phase's standalone block (rendered above the checklist). `.optional()` on top
// of `.nullable()` because a development environment's dashboard can talk to a backend that predates
// the field entirely — absent must degrade to "no block", not a parse failure of the whole status.
const computeMetricsSchema = z.object({
  state: z.enum(GROWTH_ANALYSIS_STEP_STATES),
  metric_labels: z.array(z.string()),
});

// The human-gated integrations step's block. `.nullable().optional()` for the same back-compat
// reason as compute_metrics above: an older backend simply doesn't send the field.
const integrationsSchema = z.object({
  state: z.enum(GROWTH_INTEGRATIONS_STATES),
  connection_ready: z.boolean(),
});

const statusSchema = z.object({
  onboarding: z.object({
    completed: z.boolean(),
    completed_at_millis: z.number().nullable(),
    website_url: z.string().nullable(),
  }),
  analysis: z.object({
    state: z.enum(GROWTH_ANALYSIS_STATES),
    run_id: z.string().nullable(),
    trigger: z.enum(GROWTH_RUN_TRIGGERS).nullable(),
    started_at_millis: z.number().nullable(),
    completed_at_millis: z.number().nullable(),
    steps: z.array(analysisStepSchema).nullable(),
    compute_metrics: computeMetricsSchema.nullable().optional(),
    integrations: integrationsSchema.nullable().optional(),
    error_message: z.string().nullable(),
  }),
  interview: z.object({
    state: z.enum(GROWTH_INTERVIEW_STATES),
    answered_count: z.number(),
    estimated_total: z.number(),
  }),
  latest_report: z.object({
    id: z.string(),
    created_at_millis: z.number(),
    // Optional while a development dashboard may still be connected to an older backend.
    read_at_millis: z.number().nullable().optional(),
    trigger: z.enum(GROWTH_RUN_TRIGGERS),
    milestone_label: z.string().nullable(),
  }).nullable(),
  latest_brief: z.object({
    id: z.string(),
    date: z.string(),
    created_at_millis: z.number(),
  }).nullable(),
  counts: z.object({
    suggested_actions: z.number(),
    active_actions: z.number(),
    // Note: the wire still carries `enabled_tasks` (pinned to 0 since scheduled tasks migrated to
    // customer workflows); z.object strips unknown keys, so it is deliberately not modeled here.
  }),
  orchestration: z.object({
    workflows: z.array(z.object({
      workflow_id: z.enum(GROWTH_PIPELINE_WORKFLOW_IDS),
      exists: z.boolean(),
      edited: z.boolean(),
      active_workflow_run_state: z.string().nullable(),
      last_failed_run_summary: z.string().nullable(),
    })),
  }),
  release: z.object({
    state: z.enum(GROWTH_RELEASE_STATES),
  }),
});

const runPhaseSchema = z.object({
  phase_key: z.string(),
  status: z.enum(GROWTH_PHASE_STATUSES),
  attempt: z.number(),
  started_at_millis: z.number().nullable(),
  finished_at_millis: z.number().nullable(),
  error_message: z.string().nullable(),
});

const runSchema = z.object({
  id: z.string(),
  status: z.enum(GROWTH_RUN_STATUSES),
  trigger: z.enum(GROWTH_RUN_TRIGGERS),
  created_at_millis: z.number(),
  completed_at_millis: z.number().nullable(),
  error_message: z.string().nullable(),
  phases: z.array(runPhaseSchema),
});

const runIdResponseSchema = z.object({ run_id: z.string() });

const restartOnboardingResponseSchema = z.object({ cancelled_run_ids: z.array(z.string()) });

// The HTTP layer (GrowthApiError, the 4xx conversion, and the content-type quirk) lives in
// growth-api-client.ts so the Games section's fetchers can share it. Re-exported here because this
// module has always been the public entry point for them.
export { toGrowthApiError } from "./growth-api-client";
export { GrowthApiError, growthRequestHeaders };

export function mapGrowthStatus(value: z.infer<typeof statusSchema>): GrowthStatus {
  return {
    onboarding: {
      completed: value.onboarding.completed,
      completedAtMillis: value.onboarding.completed_at_millis,
      websiteUrl: value.onboarding.website_url,
    },
    analysis: {
      state: value.analysis.state,
      runId: value.analysis.run_id,
      trigger: value.analysis.trigger,
      startedAtMillis: value.analysis.started_at_millis,
      completedAtMillis: value.analysis.completed_at_millis,
      steps: value.analysis.steps == null ? null : value.analysis.steps.map((step) => ({ id: step.id, label: step.label, description: step.description ?? null, state: step.state })),
      computeMetrics: value.analysis.compute_metrics == null ? null : {
        state: value.analysis.compute_metrics.state,
        metricLabels: value.analysis.compute_metrics.metric_labels,
      },
      // `connection_ready` is parsed (the schema above keeps the wire contract pinned) but
      // deliberately not surfaced — see GrowthIntegrations in growth-types.ts.
      integrations: value.analysis.integrations == null ? null : {
        state: value.analysis.integrations.state,
      },
      errorMessage: value.analysis.error_message,
    },
    interview: {
      state: value.interview.state,
      answeredCount: value.interview.answered_count,
      estimatedTotal: value.interview.estimated_total,
    },
    latestReport: value.latest_report == null ? null : {
      id: value.latest_report.id,
      createdAtMillis: value.latest_report.created_at_millis,
      readAtMillis: value.latest_report.read_at_millis ?? null,
      trigger: value.latest_report.trigger,
      milestoneLabel: value.latest_report.milestone_label,
    },
    latestBrief: value.latest_brief == null ? null : {
      id: value.latest_brief.id,
      date: value.latest_brief.date,
      createdAtMillis: value.latest_brief.created_at_millis,
    },
    counts: {
      suggestedActions: value.counts.suggested_actions,
      activeActions: value.counts.active_actions,
    },
    orchestration: {
      workflows: value.orchestration.workflows.map((workflow) => ({
        workflowId: workflow.workflow_id,
        exists: workflow.exists,
        edited: workflow.edited,
        activeWorkflowRunState: workflow.active_workflow_run_state,
        lastFailedRunSummary: workflow.last_failed_run_summary,
      })),
    },
    release: {
      state: value.release.state,
    },
  };
}

function mapGrowthRun(value: z.infer<typeof runSchema>): GrowthRun {
  return {
    id: value.id,
    status: value.status,
    trigger: value.trigger,
    createdAtMillis: value.created_at_millis,
    completedAtMillis: value.completed_at_millis,
    errorMessage: value.error_message,
    phases: value.phases.map((phase) => ({
      phaseKey: phase.phase_key,
      status: phase.status,
      attempt: phase.attempt,
      startedAtMillis: phase.started_at_millis,
      finishedAtMillis: phase.finished_at_millis,
      errorMessage: phase.error_message,
    })),
  };
}

export async function getGrowthStatus(app: object): Promise<GrowthStatus> {
  return mapGrowthStatus(statusSchema.parse(await requestJson(app, "/status")));
}

export async function completeGrowthOnboarding(app: object, input: { websiteUrl: string, companySummary: string | null, additionalNotes: string | null }): Promise<{ runId: string }> {
  const response = runIdResponseSchema.parse(await requestJson(app, "/onboarding", {
    method: "POST",
    body: JSON.stringify({ website_url: input.websiteUrl, company_summary: input.companySummary, additional_notes: input.additionalNotes }),
  }));
  return { runId: response.run_id };
}

export async function restartGrowthOnboarding(app: object): Promise<{ cancelledRunIds: string[] }> {
  const response = restartOnboardingResponseSchema.parse(await requestJson(app, "/onboarding/restart", { method: "POST" }));
  return { cancelledRunIds: response.cancelled_run_ids };
}

export async function startGrowthRun(app: object): Promise<{ runId: string }> {
  const response = runIdResponseSchema.parse(await requestJson(app, "/runs", {
    method: "POST",
    body: JSON.stringify({ trigger: "manual" }),
  }));
  return { runId: response.run_id };
}

export async function retryGrowthAnalysis(app: object): Promise<{ runId: string }> {
  const response = runIdResponseSchema.parse(await requestJson(app, "/analysis/retry", { method: "POST" }));
  return { runId: response.run_id };
}

export async function getGrowthRun(app: object, runId: string): Promise<GrowthRun> {
  return mapGrowthRun(runSchema.parse(await requestJson(app, urlString`/runs/${runId}`)));
}

/**
 * Answers a run's human-gated integrations step: "continue" uses the connected ad platform (the
 * backend 400s with a human-readable message when no connection exists), "skip" runs the analysis
 * on product data only (and, via the stored SKIPPED phase, stops future runs from asking again).
 * Both resume the dormant run server-side; the ack is the run body after the answer landed.
 */
export async function resolveGrowthIntegrations(app: object, runId: string, action: "skip" | "continue"): Promise<GrowthRun> {
  return mapGrowthRun(runSchema.parse(await requestJson(app, urlString`/runs/${runId}/integrations`, {
    method: "POST",
    body: JSON.stringify({ action }),
  })));
}

// ---------------------------------------------------------------------------------------------------
// Everything below pins the wire contracts for the interview/report/actions/briefs/milestones
// pages ahead of the backend routes existing, so the backend is implemented against a frozen client
// surface instead of the other way around. Mutation acks that leave a resource behind return that
// resource's resulting status (skip → interview status, activate/dismiss → action status, read →
// brief status); the one true deletion (milestones) returns the literal "deleted".
// ---------------------------------------------------------------------------------------------------

const interviewQuestionSchema = z.object({
  question_key: z.string(),
  order_index: z.number(),
  prompt: z.string(),
  kind: z.enum(GROWTH_INTERVIEW_QUESTION_KINDS),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().nullish(),
  })),
  allow_skip: z.boolean(),
  origin: z.enum(GROWTH_INTERVIEW_QUESTION_ORIGINS),
  answer_option_ids: z.array(z.string()).nullable(),
  answer_free_text: z.string().nullable(),
  answered_at_millis: z.number().nullable(),
});

const interviewSchema = z.object({
  status: z.enum(GROWTH_INTERVIEW_STATUSES),
  questions: z.array(interviewQuestionSchema),
  // Opaque AI SDK UIMessages — passed through unvalidated on purpose, see GrowthInterview.messages.
  messages: z.array(z.unknown()),
});

const watchedMetricSchema = z.object({
  metric_id: z.enum(GROWTH_METRIC_IDS),
  window_days: z.number(),
});

// The manifest trigger JSON exactly as the workflows engine stores it (see WorkflowTriggerJson in
// packages/shared/src/interface/workflows.ts) — the action wire passes it through unmodified.
const actionWorkflowTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event_type: z.string() }),
  z.object({ type: z.literal("schedule"), cron: z.string(), timezone: z.string() }),
]);

const actionWorkflowSchema = z.object({
  workflow_id: z.string(),
  source: z.string(),
  triggers: z.array(actionWorkflowTriggerSchema),
  explanation: z.string(),
  rollback_note: z.string(),
  status: z.enum(GROWTH_ACTION_WORKFLOW_STATUSES),
  last_run_state: z.string().nullable(),
  warnings: z.array(z.string()),
});

const actionItemSchema = z.object({
  id: z.string(),
  type_id: z.enum(GROWTH_ACTION_TYPES),
  // Nullable/optional during the staged rollout: old rows and an older development backend remain
  // readable until the admin classification queue has been cleared and the DB constraint tightens.
  category: z.enum(GROWTH_CATEGORIES).nullable().optional(),
  tags: z.array(z.string()).optional(),
  title: z.string(),
  description: z.string(),
  document: growthDocumentSchema.nullable().optional(),
  status: z.enum(GROWTH_ACTION_STATUSES),
  payload: z.unknown().nullable(),
  watched_metrics: z.array(watchedMetricSchema),
  report_id: z.string().nullable(),
  brief_id: z.string().nullable(),
  workflow: actionWorkflowSchema.nullable(),
  created_at_millis: z.number(),
  activated_at_millis: z.number().nullable(),
  completed_at_millis: z.number().nullable(),
});

/**
 * Exported so the admin Reports card can parse a staff read of the same endpoint shape — staff
 * review the report exactly as the customer receives it, so there is one schema, not two.
 */
export const reportSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  title: z.string(),
  summary: z.string(),
  content_md: z.string(),
  document: growthDocumentSchema.nullable().optional(),
  // Field name follows the stored Json shape documented on GrowthReport.sections in the Prisma schema
  // ("body_markdown", not "body_md") so the backend can pass the column through without remapping.
  sections: z.array(z.object({
    id: z.string().nullish(),
    kind: z.string(),
    title: z.string(),
    body_markdown: z.string(),
  })).nullable(),
  created_at_millis: z.number(),
  action_items: z.array(actionItemSchema),
});

const metricPointSchema = z.object({
  date: z.string(),
  value: z.number(),
});

const actionMetricsSchema = z.object({
  metrics: z.array(z.object({
    metric_id: z.enum(GROWTH_METRIC_IDS),
    window_days: z.number(),
    before: z.array(metricPointSchema),
    after: z.array(metricPointSchema),
    before_captured_at_millis: z.number().nullable(),
    after_captured_at_millis: z.number().nullable(),
  })),
});

// The ad-metrics fields are `.optional()` (not just `.nullable()`) because older/pre-ads briefs never
// carried this block at all — an absent field must degrade to "no ad metrics for this brief", not a
// parse failure that blanks the whole briefs list.
const briefAdMetricsSchema = z.object({
  ad_spend_minor: z.number(),
  ad_currency: z.string(),
  ad_impressions: z.number(),
  ad_clicks: z.number(),
  ad_ctr: z.number(),
  ad_date: z.string(),
  ad_timezone: z.string(),
});

const briefSchema = z.object({
  id: z.string(),
  date: z.string(),
  status: z.enum(GROWTH_BRIEF_STATUSES),
  summary: z.string(),
  content_md: z.string(),
  document: growthDocumentSchema.nullable().optional(),
  read_at_millis: z.number().nullable(),
  created_at_millis: z.number(),
  data: briefAdMetricsSchema.partial().nullable().optional(),
});

const milestoneSchema = z.object({
  id: z.string(),
  metric_id: z.enum(GROWTH_METRIC_IDS),
  comparator: z.enum(GROWTH_MILESTONE_COMPARATORS),
  threshold: z.number(),
  source: z.enum(GROWTH_MILESTONE_SOURCES),
  status: z.enum(GROWTH_MILESTONE_STATUSES),
  created_at_millis: z.number(),
});

function mapGrowthInterview(value: z.infer<typeof interviewSchema>): GrowthInterview {
  return {
    status: value.status,
    questions: value.questions.map((question) => ({
      questionKey: question.question_key,
      orderIndex: question.order_index,
      prompt: question.prompt,
      kind: question.kind,
      options: question.options.map((option) => ({ id: option.id, label: option.label, description: option.description ?? null })),
      allowSkip: question.allow_skip,
      origin: question.origin,
      answerOptionIds: question.answer_option_ids,
      answerFreeText: question.answer_free_text,
      answeredAtMillis: question.answered_at_millis,
    })),
    messages: value.messages,
  };
}

function mapGrowthActionItem(value: z.infer<typeof actionItemSchema>): GrowthActionItem {
  return {
    id: value.id,
    typeId: value.type_id,
    category: value.category ?? null,
    tags: value.tags ?? [],
    title: value.title,
    description: value.description,
    document: value.document ?? null,
    status: value.status,
    payload: value.payload ?? null,
    watchedMetrics: value.watched_metrics.map((metric) => ({ metricId: metric.metric_id, windowDays: metric.window_days })),
    reportId: value.report_id,
    briefId: value.brief_id,
    workflow: value.workflow == null ? null : {
      workflowId: value.workflow.workflow_id,
      source: value.workflow.source,
      triggers: value.workflow.triggers.map((trigger) => trigger.type === "event"
        ? { type: "event" as const, eventType: trigger.event_type }
        : { type: "schedule" as const, cron: trigger.cron, timezone: trigger.timezone }),
      explanation: value.workflow.explanation,
      rollbackNote: value.workflow.rollback_note,
      status: value.workflow.status,
      lastRunState: value.workflow.last_run_state,
      warnings: value.workflow.warnings,
    },
    createdAtMillis: value.created_at_millis,
    activatedAtMillis: value.activated_at_millis,
    completedAtMillis: value.completed_at_millis,
  };
}

export function mapGrowthReport(value: z.infer<typeof reportSchema>): GrowthReport {
  return {
    id: value.id,
    runId: value.run_id,
    title: value.title,
    summary: value.summary,
    contentMd: value.content_md,
    document: value.document ?? null,
    sections: value.sections == null ? null : value.sections.map((section) => ({
      id: section.id ?? null,
      kind: section.kind,
      title: section.title,
      bodyMd: section.body_markdown,
    })),
    createdAtMillis: value.created_at_millis,
    actionItems: value.action_items.map(mapGrowthActionItem),
  };
}

/**
 * All seven ad-metric fields are written together server-side (or not at all), so "partially present"
 * is not a state worth rendering — treat it the same as absent rather than showing e.g. spend with no
 * currency, which formatAdMoneyMinor cannot safely format.
 */
function mapGrowthBriefAdMetrics(data: z.infer<typeof briefSchema>["data"]): GrowthBrief["adMetrics"] {
  if (data == null) return null;
  const { ad_spend_minor, ad_currency, ad_impressions, ad_clicks, ad_ctr, ad_date, ad_timezone } = data;
  if (ad_spend_minor === undefined || ad_currency === undefined || ad_impressions === undefined
    || ad_clicks === undefined || ad_ctr === undefined || ad_date === undefined || ad_timezone === undefined) {
    return null;
  }
  return { spendMinor: ad_spend_minor, currency: ad_currency, impressions: ad_impressions, clicks: ad_clicks, ctr: ad_ctr, date: ad_date, timezone: ad_timezone };
}

function mapGrowthBrief(value: z.infer<typeof briefSchema>): GrowthBrief {
  return {
    id: value.id,
    date: value.date,
    status: value.status,
    summary: value.summary,
    contentMd: value.content_md,
    document: value.document ?? null,
    readAtMillis: value.read_at_millis,
    createdAtMillis: value.created_at_millis,
    adMetrics: mapGrowthBriefAdMetrics(value.data),
  };
}

function mapGrowthMilestone(value: z.infer<typeof milestoneSchema>): GrowthMilestone {
  return {
    id: value.id,
    metricId: value.metric_id,
    comparator: value.comparator,
    threshold: value.threshold,
    source: value.source,
    status: value.status,
    createdAtMillis: value.created_at_millis,
  };
}

// Cursor pagination on list endpoints: the cursor is an opaque backend token, `null` means "no more".
function withQuery(path: string, query: Map<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of query) {
    if (value !== undefined) params.set(key, value);
  }
  const queryString = params.toString();
  return queryString.length === 0 ? path : `${path}?${queryString}`;
}

// -------------------------------------------------- interview --------------------------------------------------

export async function getGrowthInterview(app: object): Promise<GrowthInterview> {
  return mapGrowthInterview(interviewSchema.parse(await requestJson(app, "/interview")));
}

export async function skipGrowthInterview(app: object): Promise<{ status: GrowthInterviewStatus }> {
  return z.object({ status: z.enum(GROWTH_INTERVIEW_STATUSES) }).parse(await requestJson(app, "/interview/skip", { method: "POST" }));
}

/**
 * Discards the current question plan and transcript and re-runs the question-generation phase,
 * keeping the run's research findings. Resolves once the reset has landed — the new plan is written
 * asynchronously by the agent, so callers poll the interview back to `pending` -> questions present.
 */
export async function retakeGrowthInterview(app: object): Promise<{ status: GrowthInterviewStatus, runId: string }> {
  const body = z.object({ status: z.enum(GROWTH_INTERVIEW_STATUSES), run_id: z.string() })
    .parse(await requestJson(app, "/interview/retake", { method: "POST" }));
  return { status: body.status, runId: body.run_id };
}

// POST /internal/growth/interview/stream is deliberately NOT modeled here: it streams AI SDK chat
// chunks and will be wired through the AI SDK's transport (which owns the request/response framing)
// when the interview chat page is built. Same story for the freeform growth chat endpoint — the
// assistant-ui adapter owns that wire, not a zod fetcher.

// -------------------------------------------------- reports --------------------------------------------------

export async function getGrowthReport(app: object, reportId: string | "latest"): Promise<GrowthReport> {
  return mapGrowthReport(reportSchema.parse(await requestJson(app, urlString`/reports/${reportId}`)));
}

export async function markGrowthReportRead(app: object, reportId: string): Promise<{ id: string }> {
  return z.object({ id: z.string() }).parse(await requestJson(app, urlString`/reports/${reportId}/read`, { method: "POST" }));
}

const overviewFindingSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.string(),
  category: z.enum(GROWTH_CATEGORIES).nullable(),
  tags: z.array(z.string()),
  title: z.string(),
  body: z.string(),
  data: z.unknown().nullable(),
  document: growthDocumentSchema.nullable().optional(),
  created_at_millis: z.number(),
});

const publishedCategoryPageSchema = z.object({
  category: z.enum(GROWTH_CATEGORIES),
  version: z.number(),
  document: growthDocumentSchema,
  published_at_millis: z.number().nullable(),
  actions: z.array(actionItemSchema),
});

/**
 * Live stage pages, skipping any that don't parse.
 *
 * A page is staff-authored content compiled by the backend, so a shape this client can't read means
 * the two sides drifted — a real bug, but not one worth turning a customer's whole workspace into an
 * error screen for. The stage falls back to its raw lanes, and the drift is reported to Sentry.
 */
function readPublishedCategoryPages(values: unknown[]): GrowthPublishedCategoryPage[] {
  const pages: GrowthPublishedCategoryPage[] = [];
  for (const value of values) {
    const parsed = publishedCategoryPageSchema.safeParse(value);
    if (!parsed.success) {
      captureError("growth-overview-category-page-parse", parsed.error);
      continue;
    }
    pages.push({
      category: parsed.data.category,
      version: parsed.data.version,
      document: parsed.data.document,
      publishedAtMillis: parsed.data.published_at_millis,
      actions: parsed.data.actions.map(mapGrowthActionItem),
    });
  }
  return pages;
}

const overviewSchema = z.object({
  latest_report: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    created_at_millis: z.number(),
  }).nullable(),
  latest_brief: z.object({
    id: z.string(),
    date: z.string(),
    summary: z.string(),
    content_md: z.string(),
    created_at_millis: z.number(),
  }).nullable(),
  findings: z.array(overviewFindingSchema),
  notes: z.array(overviewFindingSchema),
  actions: z.array(actionItemSchema),
  archive: z.array(actionItemSchema),
  categories: z.array(z.object({ category: z.enum(GROWTH_CATEGORIES), count: z.number(), score: z.number().min(0).max(100).nullable() })),
  // A page whose document fails to parse would take the whole workspace down with it, so unparseable
  // pages are dropped below and the stage falls back to its lanes — the same as having no page.
  category_pages: z.array(z.unknown()),
  needs_category_count: z.number(),
  limit: z.number(),
});

function mapOverviewFinding(value: z.infer<typeof overviewFindingSchema>) {
  return {
    id: value.id,
    source: value.source,
    kind: value.kind,
    category: value.category,
    tags: value.tags,
    title: value.title,
    body: value.body,
    data: value.data ?? null,
    document: value.document ?? null,
    createdAtMillis: value.created_at_millis,
  };
}

const adminFindingPageDraftSchema = z.object({
  source_json: z.unknown().nullable(),
  document: z.unknown().nullable(),
  updated_at_millis: z.number(),
});

const adminFindingPageSchema = z.object({
  finding: overviewFindingSchema,
  draft: adminFindingPageDraftSchema.nullable(),
  published_at_millis: z.number().nullable(),
});

function mapGrowthAdminFindingPage(value: z.infer<typeof adminFindingPageSchema>): GrowthAdminFindingPage {
  const draftSource = value.draft == null ? null : categoryPageSourceSchema.safeParse(value.draft.source_json);
  const draftDocument = value.draft == null ? null : growthDocumentSchema.safeParse(value.draft.document);
  return {
    finding: mapOverviewFinding(value.finding),
    draft: value.draft == null ? null : {
      source: draftSource?.success === true ? { sourceMdx: draftSource.data.source_mdx, data: draftSource.data.data } : null,
      document: draftDocument?.success === true ? draftDocument.data : null,
      updatedAtMillis: value.draft.updated_at_millis,
    },
    publishedAtMillis: value.published_at_millis,
  };
}

export async function getGrowthOverview(app: object): Promise<GrowthOverview> {
  const value = overviewSchema.parse(await requestJson(app, "/overview"));
  return {
    latestReport: value.latest_report == null ? null : {
      id: value.latest_report.id,
      title: value.latest_report.title,
      summary: value.latest_report.summary,
      createdAtMillis: value.latest_report.created_at_millis,
    },
    latestBrief: value.latest_brief == null ? null : {
      id: value.latest_brief.id,
      date: value.latest_brief.date,
      summary: value.latest_brief.summary,
      contentMd: value.latest_brief.content_md,
      createdAtMillis: value.latest_brief.created_at_millis,
    },
    findings: value.findings.map(mapOverviewFinding),
    notes: value.notes.map(mapOverviewFinding),
    actions: value.actions.map(mapGrowthActionItem),
    archive: value.archive.map(mapGrowthActionItem),
    categories: value.categories,
    categoryPages: readPublishedCategoryPages(value.category_pages),
    needsCategoryCount: value.needs_category_count,
    limit: value.limit,
  };
}

/**
 * The platform-admin counterpart of requestJson: goes out as a USER request carrying the internal
 * project's key plus the staff user's session, with the target project named in the body or query.
 *
 * Exported so the Games admin fetchers can share it rather than growing a second copy of the
 * error-shaping below — same reasoning as the requestJson extraction in growth-api-client.ts.
 */
export async function requestGrowthAdminJson(app: object, path: string, init: RequestInit = {}): Promise<unknown> {
  let response;
  try {
    response = await sendInternalUserRequest(app, `/internal/growth/admin${path}`, { ...init, headers: growthRequestHeaders(init) });
  } catch (error) {
    throw toGrowthApiError(error) ?? error;
  }
  const responseText = await response.text();
  if (!response.ok) {
    throw new GrowthApiError(response.status, readGrowthErrorMessage(responseText, `Growth admin request failed with status ${response.status}`));
  }
  return responseText.length === 0 ? {} : JSON.parse(responseText);
}

export type GrowthAdminProject = { id: string, displayName: string, websiteUrl: string, companySummary: string | null, completedAtMillis: number };

export async function listGrowthAdminProjects(app: object): Promise<GrowthAdminProject[]> {
  const rows = z.array(z.object({ id: z.string(), display_name: z.string(), website_url: z.string(), company_summary: z.string().nullable(), completed_at_millis: z.number() })).parse(await requestGrowthAdminJson(app, "/projects"));
  return rows.map((row) => ({ id: row.id, displayName: row.display_name, websiteUrl: row.website_url, companySummary: row.company_summary, completedAtMillis: row.completed_at_millis }));
}

/**
 * The selected project's lifecycle status. Parsed with the customer status schema on purpose — the
 * admin page renders the same lifecycle view the customer gets, so the two must not drift.
 */
export async function getGrowthAdminStatus(app: object, projectId: string): Promise<GrowthStatus> {
  return mapGrowthStatus(statusSchema.parse(await requestGrowthAdminJson(app, urlString`/status?project_id=${projectId}`)));
}

export async function getGrowthAdminOverview(app: object, projectId: string): Promise<GrowthOverview> {
  const value = overviewSchema.parse(await requestGrowthAdminJson(app, `/overview?project_id=${encodeURIComponent(projectId)}`));
  return {
    latestReport: value.latest_report == null ? null : { id: value.latest_report.id, title: value.latest_report.title, summary: value.latest_report.summary, createdAtMillis: value.latest_report.created_at_millis },
    latestBrief: value.latest_brief == null ? null : { id: value.latest_brief.id, date: value.latest_brief.date, summary: value.latest_brief.summary, contentMd: value.latest_brief.content_md, createdAtMillis: value.latest_brief.created_at_millis },
    findings: value.findings.map(mapOverviewFinding), notes: value.notes.map(mapOverviewFinding), actions: value.actions.map(mapGrowthActionItem), archive: value.archive.map(mapGrowthActionItem),
    categories: value.categories, categoryPages: readPublishedCategoryPages(value.category_pages), needsCategoryCount: value.needs_category_count, limit: value.limit,
  };
}

const categoryPageVersionSummarySchema = z.object({
  id: z.string(),
  version: z.number(),
  status: z.enum(["draft", "published", "archived"]),
  published_at_millis: z.number().nullable(),
  updated_at_millis: z.number(),
});

const categoryPageVersionSchema = categoryPageVersionSummarySchema.extend({
  category: z.enum(GROWTH_CATEGORIES),
  source_json: z.unknown().nullable(),
  document: z.unknown().nullable(),
  source_item_ids: z.object({ findings: z.array(z.string()), actions: z.array(z.string()) }),
  stale_source_ids: z.array(z.string()),
  actions: z.array(actionItemSchema),
});

/** The authored payload as it goes over the wire, and as it comes back on a stored version. */
const categoryPageSourceSchema = z.object({
  format: z.literal("growth-mdx-v1"),
  source_mdx: z.string(),
  data: z.array(z.unknown()),
});

function mapCategoryPageVersionSummary(value: z.infer<typeof categoryPageVersionSummarySchema>): GrowthCategoryPageVersionSummary {
  return {
    id: value.id,
    version: value.version,
    status: value.status,
    publishedAtMillis: value.published_at_millis,
    updatedAtMillis: value.updated_at_millis,
  };
}

function mapCategoryPageVersion(value: z.infer<typeof categoryPageVersionSchema>): GrowthCategoryPageVersion {
  // A stored version that no longer round-trips (hand-edited row, or a format we have since changed)
  // must not blank the composer: the editor shows an explicit "source could not be read" state and
  // the author can still discard or republish, which is why both are nullable rather than throwing.
  const source = categoryPageSourceSchema.safeParse(value.source_json);
  const document = growthDocumentSchema.safeParse(value.document);
  return {
    ...mapCategoryPageVersionSummary(value),
    category: value.category,
    source: source.success ? { sourceMdx: source.data.source_mdx, data: source.data.data } : null,
    document: document.success ? document.data : null,
    sourceItemIds: value.source_item_ids,
    staleSourceIds: value.stale_source_ids,
    actions: value.actions.map(mapGrowthActionItem),
  };
}

const adminCategoryPageSchema = z.object({
  category: z.enum(GROWTH_CATEGORIES),
  draft: categoryPageVersionSchema.nullable(),
  published: categoryPageVersionSchema.nullable(),
  archived: z.array(categoryPageVersionSummarySchema),
});

// The route wraps the list in an envelope so it can grow extra top-level fields without a breaking change.
const adminCategoryPagesResponseSchema = z.object({
  pages: z.array(adminCategoryPageSchema),
});

/** Exported separately from the fetch so the wire contract itself is unit-testable. */
export function parseGrowthAdminCategoryPagesBody(value: unknown): GrowthAdminCategoryPage[] {
  return adminCategoryPagesResponseSchema.parse(value).pages.map((row) => ({
    category: row.category,
    draft: row.draft == null ? null : mapCategoryPageVersion(row.draft),
    published: row.published == null ? null : mapCategoryPageVersion(row.published),
    archived: row.archived.map(mapCategoryPageVersionSummary),
  }));
}

export async function listGrowthAdminCategoryPages(app: object, projectId: string): Promise<GrowthAdminCategoryPage[]> {
  return parseGrowthAdminCategoryPagesBody(await requestGrowthAdminJson(app, `/category-pages?project_id=${encodeURIComponent(projectId)}`));
}

/**
 * Saves the stage's draft. The response is the stored draft, compiled — so the composer previews
 * exactly what the backend accepted rather than a client-side guess at how it would compile.
 */
export async function saveGrowthAdminCategoryPageDraft(app: object, projectId: string, input: {
  category: GrowthCategory,
  sourceMdx: string,
  data: unknown[],
  sourceFindingIds: string[],
  sourceActionIds: string[],
  /** `updatedAtMillis` of the draft the composer loaded, or null if the stage had no draft. */
  expectedDraftUpdatedAtMillis: number | null,
}): Promise<GrowthCategoryPageVersion> {
  const value = categoryPageVersionSchema.parse(await requestGrowthAdminJson(app, "/category-pages", {
    method: "PUT",
    body: JSON.stringify({
      target_project_id: projectId,
      category: input.category,
      document: { format: "growth-mdx-v1", source_mdx: input.sourceMdx, data: input.data },
      source_finding_ids: input.sourceFindingIds,
      source_action_ids: input.sourceActionIds,
      expected_draft_updated_at_millis: input.expectedDraftUpdatedAtMillis,
    }),
  }));
  return mapCategoryPageVersion(value);
}

export async function discardGrowthAdminCategoryPageDraft(app: object, projectId: string, category: GrowthCategory): Promise<void> {
  await requestGrowthAdminJson(app, "/category-pages", { method: "DELETE", body: JSON.stringify({ target_project_id: projectId, category }) });
}

/** Publishing an older version is how rollback works — same endpoint, an archived version number. */
export async function publishGrowthAdminCategoryPage(app: object, projectId: string, category: GrowthCategory, version: number): Promise<void> {
  await requestGrowthAdminJson(app, "/category-pages/publish", { method: "POST", body: JSON.stringify({ target_project_id: projectId, category, version }) });
}

export async function publishAllGrowthAdminCategoryPageDrafts(app: object, projectId: string, drafts: { category: GrowthCategory, version: number }[], reportId: string | null): Promise<void> {
  await requestGrowthAdminJson(app, "/category-pages/publish", { method: "PUT", body: JSON.stringify({ target_project_id: projectId, drafts, report_id: reportId }) });
}

export async function unpublishGrowthAdminCategoryPage(app: object, projectId: string, category: GrowthCategory): Promise<void> {
  await requestGrowthAdminJson(app, "/category-pages/publish", { method: "DELETE", body: JSON.stringify({ target_project_id: projectId, category }) });
}

const adminActionPageDraftSchema = z.object({
  source_json: z.unknown().nullable(),
  document: z.unknown().nullable(),
  updated_at_millis: z.number(),
});

const adminActionPageSchema = z.object({
  action: actionItemSchema,
  draft: adminActionPageDraftSchema.nullable(),
  published_at_millis: z.number().nullable(),
});

function mapGrowthAdminActionPage(value: z.infer<typeof adminActionPageSchema>): GrowthAdminActionPage {
  const draftSource = value.draft == null ? null : categoryPageSourceSchema.safeParse(value.draft.source_json);
  const draftDocument = value.draft == null ? null : growthDocumentSchema.safeParse(value.draft.document);
  return {
    action: mapGrowthActionItem(value.action),
    draft: value.draft == null ? null : {
      source: draftSource?.success === true ? { sourceMdx: draftSource.data.source_mdx, data: draftSource.data.data } : null,
      document: draftDocument?.success === true ? draftDocument.data : null,
      updatedAtMillis: value.draft.updated_at_millis,
    },
    publishedAtMillis: value.published_at_millis,
  };
}

export async function getGrowthAdminActionPage(app: object, projectId: string, actionId: string): Promise<GrowthAdminActionPage> {
  return mapGrowthAdminActionPage(adminActionPageSchema.parse(await requestGrowthAdminJson(
    app,
    `/actions/${encodeURIComponent(actionId)}?project_id=${encodeURIComponent(projectId)}`,
  )));
}

export async function saveGrowthAdminActionPageDraft(app: object, projectId: string, actionId: string, input: {
  sourceMdx: string,
  data: unknown[],
  expectedDraftUpdatedAtMillis: number | null,
}): Promise<GrowthAdminActionPage["draft"]> {
  const draft = adminActionPageDraftSchema.parse(await requestGrowthAdminJson(app, `/actions/${encodeURIComponent(actionId)}`, {
    method: "PUT",
    body: JSON.stringify({
      target_project_id: projectId,
      document: { format: "growth-mdx-v1", source_mdx: input.sourceMdx, data: input.data },
      expected_draft_updated_at_millis: input.expectedDraftUpdatedAtMillis,
    }),
  }));
  const source = categoryPageSourceSchema.safeParse(draft.source_json);
  const document = growthDocumentSchema.safeParse(draft.document);
  return {
    source: source.success ? { sourceMdx: source.data.source_mdx, data: source.data.data } : null,
    document: document.success ? document.data : null,
    updatedAtMillis: draft.updated_at_millis,
  };
}

export async function publishGrowthAdminActionPageDraft(app: object, projectId: string, actionId: string, expectedDraftUpdatedAtMillis: number): Promise<void> {
  await requestGrowthAdminJson(app, `/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    body: JSON.stringify({ target_project_id: projectId, expected_draft_updated_at_millis: expectedDraftUpdatedAtMillis }),
  });
}

export async function discardGrowthAdminActionPageDraft(app: object, projectId: string, actionId: string): Promise<void> {
  await requestGrowthAdminJson(app, `/actions/${encodeURIComponent(actionId)}`, {
    method: "DELETE",
    body: JSON.stringify({ target_project_id: projectId }),
  });
}

export async function getGrowthAdminFindingPage(app: object, projectId: string, findingId: string): Promise<GrowthAdminFindingPage> {
  return mapGrowthAdminFindingPage(adminFindingPageSchema.parse(await requestGrowthAdminJson(
    app,
    `/findings/${encodeURIComponent(findingId)}/document?project_id=${encodeURIComponent(projectId)}`,
  )));
}

export async function saveGrowthAdminFindingPageDraft(app: object, projectId: string, findingId: string, input: {
  sourceMdx: string,
  data: unknown[],
  expectedDraftUpdatedAtMillis: number | null,
}): Promise<GrowthAdminFindingPage["draft"]> {
  const draft = adminFindingPageDraftSchema.parse(await requestGrowthAdminJson(app, `/findings/${encodeURIComponent(findingId)}/document`, {
    method: "PUT",
    body: JSON.stringify({
      target_project_id: projectId,
      document: { format: "growth-mdx-v1", source_mdx: input.sourceMdx, data: input.data },
      expected_draft_updated_at_millis: input.expectedDraftUpdatedAtMillis,
    }),
  }));
  const source = categoryPageSourceSchema.safeParse(draft.source_json);
  const document = growthDocumentSchema.safeParse(draft.document);
  return {
    source: source.success ? { sourceMdx: source.data.source_mdx, data: source.data.data } : null,
    document: document.success ? document.data : null,
    updatedAtMillis: draft.updated_at_millis,
  };
}

export async function publishGrowthAdminFindingPageDraft(app: object, projectId: string, findingId: string, expectedDraftUpdatedAtMillis: number): Promise<void> {
  await requestGrowthAdminJson(app, `/findings/${encodeURIComponent(findingId)}/document`, {
    method: "POST",
    body: JSON.stringify({ target_project_id: projectId, expected_draft_updated_at_millis: expectedDraftUpdatedAtMillis }),
  });
}

export async function discardGrowthAdminFindingPageDraft(app: object, projectId: string, findingId: string): Promise<void> {
  await requestGrowthAdminJson(app, `/findings/${encodeURIComponent(findingId)}/document`, {
    method: "DELETE",
    body: JSON.stringify({ target_project_id: projectId }),
  });
}

async function createGrowthAdminFinding(app: object, projectId: string, input: { category: string, tags: string[], title: string, body: string, kind: "note" | "suggestion" }): Promise<void> {
  await requestGrowthAdminJson(app, "/findings", {
    method: "POST",
    body: JSON.stringify({
      target_project_id: projectId,
      kind: input.kind,
      note: input.kind === "note",
      category: input.category,
      tags: input.tags,
      title: input.title,
      body: input.body,
    }),
  });
}

export async function createGrowthAdminNote(app: object, projectId: string, input: { category: string, tags: string[], title: string, body: string }): Promise<void> {
  await createGrowthAdminFinding(app, projectId, { ...input, kind: "note" });
}

export async function createGrowthAdminSuggestion(app: object, projectId: string, input: { category: string, tags: string[], title: string, body: string }): Promise<void> {
  await createGrowthAdminFinding(app, projectId, { ...input, kind: "suggestion" });
}

export async function updateGrowthAdminFinding(app: object, projectId: string, findingId: string, input: { kind: string, category: string, tags: string[], title: string, body: string }): Promise<void> {
  await requestGrowthAdminJson(app, `/findings/${encodeURIComponent(findingId)}`, { method: "PATCH", body: JSON.stringify({ target_project_id: projectId, ...input }) });
}

export async function setGrowthAdminCategoryScore(app: object, projectId: string, category: string, score: number): Promise<void> {
  await requestGrowthAdminJson(app, "/category-scores", { method: "PUT", body: JSON.stringify({ target_project_id: projectId, category, score }) });
}

export type GrowthAdminSchedulerResult = {
  readonly didWork: boolean,
  readonly legStarted: boolean | null,
};

export async function runGrowthAdminSchedulerStep(app: object, projectId: string): Promise<GrowthAdminSchedulerResult> {
  const response = z.object({
    step: z.string(),
    did_work: z.boolean(),
    leg_started: z.boolean().nullable(),
  }).parse(await requestGrowthAdminJson(app, "/run-now", {
    method: "POST",
    body: JSON.stringify({ step: "project_recovery", target_project_id: projectId }),
  }));
  return { didWork: response.did_work, legStarted: response.leg_started };
}

export const GROWTH_ADMIN_STAGE_RUN_STATES = ["ready", "running", "complete", "blocked", "failed"] as const;
export type GrowthAdminStageRunStateName = typeof GROWTH_ADMIN_STAGE_RUN_STATES[number];

export type GrowthAdminStageRunState = {
  readonly stage: GrowthTimelineStepId,
  readonly state: GrowthAdminStageRunStateName,
  readonly canRun: boolean,
  readonly message: string,
};

export type GrowthAdminStageRunResult = GrowthAdminStageRunState & {
  readonly didWork: boolean,
  readonly legStarted: boolean | null,
};

const growthAdminStageRunStateSchema = z.object({
  stage: z.enum(GROWTH_TIMELINE_STEP_IDS),
  state: z.enum(GROWTH_ADMIN_STAGE_RUN_STATES),
  can_run: z.boolean(),
  message: z.string(),
});

function mapGrowthAdminStageRunState(value: z.infer<typeof growthAdminStageRunStateSchema>): GrowthAdminStageRunState {
  return { stage: value.stage, state: value.state, canRun: value.can_run, message: value.message };
}

export async function getGrowthAdminStageRunState(app: object, projectId: string, stage: GrowthTimelineStepId): Promise<GrowthAdminStageRunState> {
  const value = growthAdminStageRunStateSchema.parse(await requestGrowthAdminJson(app, "/run-now", {
    method: "POST",
    body: JSON.stringify({ step: "lifecycle_stage_state", target_project_id: projectId, stage }),
  }));
  return mapGrowthAdminStageRunState(value);
}

export async function runGrowthAdminStage(app: object, projectId: string, stage: GrowthTimelineStepId): Promise<GrowthAdminStageRunResult> {
  const value = growthAdminStageRunStateSchema.extend({
    did_work: z.boolean(),
    leg_started: z.boolean().nullable(),
  }).parse(await requestGrowthAdminJson(app, "/run-now", {
    method: "POST",
    body: JSON.stringify({ step: "lifecycle_stage", target_project_id: projectId, stage }),
  }));
  return { ...mapGrowthAdminStageRunState(value), didWork: value.did_work, legStarted: value.leg_started };
}

export type GrowthAdminFunctionalActionFields = {
  payload: unknown,
  watchedMetrics: GrowthActionItem["watchedMetrics"],
  workflow: null | Pick<NonNullable<GrowthActionItem["workflow"]>, "workflowId" | "source" | "explanation" | "rollbackNote">,
};

/**
 * The admin action endpoint replaces every field it receives, so an edit to one field has to resend the
 * others; the functional fields are only included when the caller may change them (while the action is
 * still a proposal).
 */
export function growthAdminActionRequestBody(projectId: string, action: GrowthActionItem, functionalFields?: GrowthAdminFunctionalActionFields): Record<string, unknown> {
  return {
    target_project_id: projectId, type_id: action.typeId, category: action.category, tags: action.tags, title: action.title, description: action.description,
    status: action.status,
    ...functionalFields === undefined ? {} : {
      // The endpoint takes `payload` as optional-but-not-nullable, and an action's payload column is
      // nullable (that is its default until the agent fills it in), so a null payload has to be left
      // out of the body entirely — sending `null` is rejected and would make an otherwise unrelated
      // edit, such as flipping a proposal to active, impossible for those actions.
      ...functionalFields.payload == null ? {} : { payload: functionalFields.payload },
      watched_metrics: functionalFields.watchedMetrics.map((metric) => ({ metric_id: metric.metricId, window_days: metric.windowDays })),
      workflow: functionalFields.workflow == null ? null : { workflow_id: functionalFields.workflow.workflowId, source: functionalFields.workflow.source, explanation: functionalFields.workflow.explanation, rollback_note: functionalFields.workflow.rollbackNote },
    },
  };
}

export async function updateGrowthAdminAction(app: object, projectId: string, action: GrowthActionItem, functionalFields?: GrowthAdminFunctionalActionFields): Promise<void> {
  await requestGrowthAdminJson(app, `/actions/${encodeURIComponent(action.id)}`, {
    method: "PATCH",
    body: JSON.stringify(growthAdminActionRequestBody(projectId, action, functionalFields)),
  });
}

// -------------------------------------------------- ads (Meta campaign lifecycle) --------------------------------------------------

const adsEntitySchema = z.object({
  external_id: z.string(),
  name: z.string(),
  configured_status: z.string(),
  effective_status: z.string(),
});

const adsBodySchema = z.object({
  status: z.enum(GROWTH_ADS_STATUSES),
  creation_step: z.enum(GROWTH_ADS_CREATION_STEPS),
  attempt: z.number(),
  platform: z.literal("meta"),
  account_id: z.string(),
  campaign: adsEntitySchema.nullable(),
  ad_set: adsEntitySchema.nullable(),
  creative: z.object({ external_id: z.string() }).nullable(),
  ad: adsEntitySchema.nullable(),
  currency: z.string(),
  daily_budget_minor: z.number().nullable(),
  lifetime_budget_minor: z.number().nullable(),
  orphaned_external_ids: z.array(z.string()),
  last_error: z.object({ stage: z.string().nullable(), code: z.string().nullable(), subcode: z.string().nullable() }),
  published_at_millis: z.number().nullable(),
  published_by_user_id: z.string().nullable(),
  paused_at_millis: z.number().nullable(),
  created_at_millis: z.number(),
  reconciled_at_millis: z.number().nullable(),
  may_be_live_unconfirmed: z.boolean(),
  verification: z.object({
    // Deliberately NOT z.enum(GROWTH_ADS_VERIFICATION_OUTCOMES): a backend that grows a sixth verdict
    // must not make every campaign unparseable in an older dashboard. Unknown values fall through to
    // the panel's neutral "we could not verify" branch, which is the safe reading.
    outcome: z.string().nullable(),
    verified_at_millis: z.number().nullable(),
    findings: z.array(z.object({
      code: z.string(),
      severity: z.string(),
      level: z.string(),
      external_id: z.string().nullable(),
      expected: z.string().nullable(),
      actual: z.string().nullable(),
      message: z.string(),
    })),
  }),
  execution: z.object({
    mode: z.string().nullable(),
    attempt: z.number().nullable(),
    status: z.string().nullable(),
    dispatched_at_millis: z.number().nullable(),
    lease_expires_at_millis: z.number().nullable(),
    agent_reported_ids: z.record(z.string(), z.string()),
  }),
  publish_in_progress: z.boolean(),
});

function mapAdsEntity(value: z.infer<typeof adsEntitySchema>): GrowthAdsEntity {
  return { externalId: value.external_id, name: value.name, configuredStatus: value.configured_status, effectiveStatus: value.effective_status };
}

/**
 * Parse + map in one step. Exported (unlike the schema and mapper it wraps) so the wire-tolerance
 * decisions inside — an unknown verification outcome collapsing to `null`, an unknown severity
 * reading as a note — are directly testable, since those are what keep an older dashboard readable
 * against a newer backend rather than throwing on every campaign.
 */
export function parseGrowthAdsBody(raw: unknown): GrowthAdsBody {
  return mapAdsBody(adsBodySchema.parse(raw));
}

function mapAdsBody(value: z.infer<typeof adsBodySchema>): GrowthAdsBody {
  return {
    status: value.status,
    creationStep: value.creation_step,
    attempt: value.attempt,
    platform: value.platform,
    accountId: value.account_id,
    campaign: value.campaign == null ? null : mapAdsEntity(value.campaign),
    adSet: value.ad_set == null ? null : mapAdsEntity(value.ad_set),
    creative: value.creative == null ? null : { externalId: value.creative.external_id },
    ad: value.ad == null ? null : mapAdsEntity(value.ad),
    currency: value.currency,
    dailyBudgetMinor: value.daily_budget_minor,
    lifetimeBudgetMinor: value.lifetime_budget_minor,
    orphanedExternalIds: value.orphaned_external_ids,
    lastError: value.last_error,
    publishedAtMillis: value.published_at_millis,
    publishedByUserId: value.published_by_user_id,
    pausedAtMillis: value.paused_at_millis,
    createdAtMillis: value.created_at_millis,
    reconciledAtMillis: value.reconciled_at_millis,
    mayBeLiveUnconfirmed: value.may_be_live_unconfirmed,
    verification: {
      outcome: narrowVerificationOutcome(value.verification.outcome),
      verifiedAtMillis: value.verification.verified_at_millis,
      findings: value.verification.findings.map((finding) => ({
        code: finding.code,
        // Anything that isn't explicitly "blocking" is treated as a note. Erring toward "note" on an
        // unrecognized severity is right for the DISPLAY layer only — the backend already decided the
        // verdict, and a row that was quarantined stays quarantined regardless of how we style a chip.
        severity: finding.severity === "blocking" ? "blocking" : "note",
        level: finding.level,
        externalId: finding.external_id,
        expected: finding.expected,
        actual: finding.actual,
        message: finding.message,
      })),
    },
    execution: {
      mode: value.execution.mode === "agent" || value.execution.mode === "mock" ? value.execution.mode : null,
      attempt: value.execution.attempt,
      status: value.execution.status,
      dispatchedAtMillis: value.execution.dispatched_at_millis,
      leaseExpiresAtMillis: value.execution.lease_expires_at_millis,
      agentReportedIds: value.execution.agent_reported_ids,
    },
    publishInProgress: value.publish_in_progress,
  };
}

/**
 * Maps a wire outcome onto the known set, or null. An unrecognized value becomes null rather than
 * being passed through, so the panel's "not verified yet / could not verify" branch — the branch that
 * refuses to present the campaign as confirmed — is what a future backend verdict falls into.
 */
function narrowVerificationOutcome(value: string | null): GrowthAdsVerificationOutcome | null {
  return GROWTH_ADS_VERIFICATION_OUTCOMES.find((outcome) => outcome === value) ?? null;
}

// -------------------------------------------------- actions --------------------------------------------------

export async function listGrowthActions(app: object, options: { status?: GrowthActionStatus, cursor?: string } = {}): Promise<{ items: GrowthActionItem[], nextCursor: string | null }> {
  const response = z.object({ items: z.array(actionItemSchema), next_cursor: z.string().nullable() })
    .parse(await requestJson(app, withQuery("/actions", new Map([["status", options.status], ["cursor", options.cursor]]))));
  return { items: response.items.map(mapGrowthActionItem), nextCursor: response.next_cursor };
}

/**
 * Activates an action item. A bodyless POST for every action type — see `growthRequestHeaders`'s doc
 * comment for why a body must never be declared unless there is one.
 *
 * A `run_ads` item activates like any other: its `ad_campaign` proposal is recorded and displayed,
 * but nothing is created on any ad platform, so there is nothing for the customer to attest to at
 * this point. The campaign review this call used to carry (the special-ad-category acknowledgement
 * and the creative binding) belongs with the ad platform integration and returns with it.
 */
export async function activateGrowthAction(
  app: object,
  actionId: string,
): Promise<{ status: GrowthActionStatus, workflowId: string | null }> {
  // workflow_id is non-null exactly when the item carried a workflow that got deployed by this
  // activation — the dashboard uses it to link straight to the freshly deployed automation.
  const response = z.object({
    status: z.enum(GROWTH_ACTION_STATUSES),
    workflow_id: z.string().nullable(),
  }).parse(await requestJson(app, urlString`/actions/${actionId}/activate`, { method: "POST" }));
  return { status: response.status, workflowId: response.workflow_id };
}

export async function dismissGrowthAction(app: object, actionId: string): Promise<{ status: GrowthActionStatus }> {
  return z.object({ status: z.enum(GROWTH_ACTION_STATUSES) }).parse(await requestJson(app, urlString`/actions/${actionId}/dismiss`, { method: "POST" }));
}

/**
 * Writes the blog post for a `publish_blog` action item, on demand. The analysis run only proposes
 * the IDEA (writing a post inline was the slowest thing in the run), so this is what turns an idea
 * into a draft. Idempotent server-side: `generated: false` means a draft already existed.
 *
 * Slow by nature — a full generation — so callers must render a loading state (our Button's async
 * onClick does this) rather than leaving the page looking idle.
 */
export async function generateGrowthActionBlogDraft(app: object, actionId: string): Promise<{ draftMarkdown: string, generated: boolean }> {
  const response = z.object({
    draft_markdown: z.string(),
    generated: z.boolean(),
  }).parse(await requestJson(app, urlString`/actions/${actionId}/blog-draft`, { method: "POST" }));
  return { draftMarkdown: response.draft_markdown, generated: response.generated };
}

export async function getGrowthActionMetrics(app: object, actionId: string): Promise<GrowthActionMetricSeries[]> {
  const response = actionMetricsSchema.parse(await requestJson(app, urlString`/actions/${actionId}/metrics`));
  return response.metrics.map((series) => ({
    metricId: series.metric_id,
    windowDays: series.window_days,
    before: series.before.map((point) => ({ date: point.date, value: point.value })),
    after: series.after.map((point) => ({ date: point.date, value: point.value })),
    beforeCapturedAtMillis: series.before_captured_at_millis,
    afterCapturedAtMillis: series.after_captured_at_millis,
  }));
}

// -------------------------------------------------- briefs --------------------------------------------------

export async function listGrowthBriefs(app: object, options: { cursor?: string } = {}): Promise<{ items: GrowthBrief[], nextCursor: string | null }> {
  const response = z.object({ items: z.array(briefSchema), next_cursor: z.string().nullable() })
    .parse(await requestJson(app, withQuery("/briefs", new Map([["cursor", options.cursor]]))));
  return { items: response.items.map(mapGrowthBrief), nextCursor: response.next_cursor };
}

export async function getGrowthBrief(app: object, briefId: string): Promise<GrowthBrief> {
  return mapGrowthBrief(briefSchema.parse(await requestJson(app, urlString`/briefs/${briefId}`)));
}

export async function markGrowthBriefRead(app: object, briefId: string): Promise<{ status: GrowthBriefStatus }> {
  return z.object({ status: z.enum(GROWTH_BRIEF_STATUSES) }).parse(await requestJson(app, urlString`/briefs/${briefId}/read`, { method: "POST" }));
}

// -------------------------------------------------- milestones --------------------------------------------------

export async function listGrowthMilestones(app: object): Promise<GrowthMilestone[]> {
  const response = z.object({ items: z.array(milestoneSchema) }).parse(await requestJson(app, "/milestones"));
  return response.items.map(mapGrowthMilestone);
}

export async function createGrowthMilestone(app: object, input: { metricId: GrowthMetricId, threshold: number }): Promise<GrowthMilestone> {
  return mapGrowthMilestone(milestoneSchema.parse(await requestJson(app, "/milestones", {
    method: "POST",
    body: JSON.stringify({ metric_id: input.metricId, threshold: input.threshold }),
  })));
}

export async function updateGrowthMilestone(app: object, milestoneId: string, input: { status?: GrowthMilestone["status"] }): Promise<GrowthMilestone> {
  return mapGrowthMilestone(milestoneSchema.parse(await requestJson(app, urlString`/milestones/${milestoneId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input.status === undefined ? {} : { status: input.status } }),
  })));
}

export async function deleteGrowthMilestone(app: object, milestoneId: string): Promise<void> {
  z.object({ status: z.literal("deleted") }).parse(await requestJson(app, urlString`/milestones/${milestoneId}`, { method: "DELETE" }));
}

// -------------------------------------------------- pipeline workflows --------------------------------------------------

/**
 * Resets one canonical pipeline workflow back to its shipped source (recreating it if the customer
 * deleted it in the workflows app). This is the only path that overwrites a customer-edited growth
 * workflow, which is why it is an explicit dashboard action with a confirm dialog.
 */
export async function restoreGrowthWorkflow(app: object, workflowId: GrowthPipelineWorkflowId): Promise<{ workflowId: string, version: number, created: boolean }> {
  const response = z.object({ workflow_id: z.string(), version: z.number(), created: z.boolean() })
    .parse(await requestJson(app, "/workflows/restore", {
      method: "POST",
      body: JSON.stringify({ workflow_id: workflowId }),
    }));
  return { workflowId: response.workflow_id, version: response.version, created: response.created };
}

// -------------------------------------------------- metrics overview --------------------------------------------------

const metricsOverviewSchema = z.object({
  window_days: z.number(),
  latest_stored_date: z.string().nullable(),
  metrics: z.array(z.object({
    id: z.string(),
    label: z.string(),
    unit: z.enum(GROWTH_CATALOG_METRIC_UNITS),
    category: z.enum(GROWTH_CATALOG_METRIC_CATEGORIES),
    kind: z.enum(GROWTH_CATALOG_METRIC_KINDS),
    description: z.string(),
    latest: metricPointSchema.nullable(),
    series: z.array(metricPointSchema),
  })),
  ad_accounts: z.array(z.object({
    account_id: z.string(),
    account_timezone: z.string(),
    currency: z.string(),
    series: z.array(z.object({
      date: z.string(),
      spend_minor: z.number(),
      impressions: z.number(),
      clicks: z.number(),
    })),
  })),
});

function mapGrowthMetricsOverview(value: z.infer<typeof metricsOverviewSchema>): GrowthMetricsOverview {
  return {
    windowDays: value.window_days,
    latestStoredDate: value.latest_stored_date,
    metrics: value.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      category: metric.category,
      kind: metric.kind,
      description: metric.description,
      latest: metric.latest == null ? null : { date: metric.latest.date, value: metric.latest.value },
      series: metric.series.map((point) => ({ date: point.date, value: point.value })),
    })),
    adAccounts: value.ad_accounts.map((account) => ({
      accountId: account.account_id,
      accountTimezone: account.account_timezone,
      currency: account.currency,
      series: account.series.map((point) => ({
        date: point.date,
        spendMinor: point.spend_minor,
        impressions: point.impressions,
        clicks: point.clicks,
      })),
    })),
  };
}

/** The last ~90 days of the wide per-day metric store, plus per-ad-account daily spend series. */
export async function getGrowthMetricsOverview(app: object): Promise<GrowthMetricsOverview> {
  return mapGrowthMetricsOverview(metricsOverviewSchema.parse(await requestJson(app, "/metrics-overview")));
}
