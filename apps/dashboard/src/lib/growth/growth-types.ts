import type { GrowthDocument } from "./growth-document";

export const GROWTH_ACTION_TYPES = ["run_ads", "publish_blog", "custom"] as const;
export const GROWTH_CATEGORIES = ["product", "reach", "conversion", "retention", "revenue"] as const;
export const GROWTH_ACTION_STATUSES = ["proposed", "active", "completed", "dismissed"] as const;
export const GROWTH_METRIC_IDS = ["new_signups", "returning_users", "transactions", "emails_sent", "total_users", "revenue"] as const;
export const GROWTH_RUN_TRIGGERS = ["initial", "milestone", "manual"] as const;
export const GROWTH_ANALYSIS_STATES = ["none", "running", "completed", "failed"] as const;
export const GROWTH_ANALYSIS_STEP_STATES = ["pending", "running", "done", "failed"] as const;
export const GROWTH_INTERVIEW_STATES = ["not_ready", "preparing", "ready", "in_progress", "completed"] as const;
export const GROWTH_INTEGRATIONS_STATES = ["pending", "waiting", "connected", "skipped"] as const;
export const GROWTH_RUN_STATUSES = ["pending", "running", "awaiting_interview", "composing_report", "completed", "failed", "cancelled"] as const;
export const GROWTH_PHASE_STATUSES = ["pending", "dispatched", "running", "completed", "failed", "skipped"] as const;
// Note: distinct from GROWTH_INTERVIEW_STATES above — that one is the status endpoint's *derived* UI
// state, while these are the interview resource's own stored statuses (GrowthInterview.status in Prisma).
export const GROWTH_INTERVIEW_STATUSES = ["pending", "active", "completed", "skipped"] as const;
export const GROWTH_INTERVIEW_QUESTION_KINDS = ["single", "multi"] as const;
export const GROWTH_INTERVIEW_QUESTION_ORIGINS = ["planned", "adaptive"] as const;
export const GROWTH_INTERVIEW_OTHER_OPTION_ID = "other";
export const GROWTH_BRIEF_STATUSES = ["generating", "ready", "failed", "skipped"] as const;
export const GROWTH_MILESTONE_COMPARATORS = ["gte"] as const;
export const GROWTH_MILESTONE_SOURCES = ["default", "user", "agent"] as const;
export const GROWTH_MILESTONE_STATUSES = ["armed", "reached", "disabled"] as const;
// Deployment status of an action item's attached workflow. "deleted" is derived backend-side:
// the workflow was deployed but the customer since deleted its definition in the workflows app.
export const GROWTH_ACTION_WORKFLOW_STATUSES = ["not_deployed", "deployed", "deleted"] as const;
// The two canonical pipeline workflows Growth seeds into every onboarded project. The status
// endpoint's orchestration block reports exactly these; the restore endpoint accepts exactly these.
export const GROWTH_PIPELINE_WORKFLOW_IDS = ["growth-analysis", "growth-daily-brief"] as const;

export type GrowthActionType = typeof GROWTH_ACTION_TYPES[number];
export type GrowthCategory = typeof GROWTH_CATEGORIES[number];
export type GrowthActionStatus = typeof GROWTH_ACTION_STATUSES[number];
export type GrowthMetricId = typeof GROWTH_METRIC_IDS[number];
export type GrowthRunTrigger = typeof GROWTH_RUN_TRIGGERS[number];
export type GrowthAnalysisState = typeof GROWTH_ANALYSIS_STATES[number];
export type GrowthAnalysisStepState = typeof GROWTH_ANALYSIS_STEP_STATES[number];
export type GrowthInterviewState = typeof GROWTH_INTERVIEW_STATES[number];
export type GrowthIntegrationsState = typeof GROWTH_INTEGRATIONS_STATES[number];
export type GrowthRunStatus = typeof GROWTH_RUN_STATUSES[number];
export type GrowthPhaseStatus = typeof GROWTH_PHASE_STATUSES[number];
export type GrowthInterviewStatus = typeof GROWTH_INTERVIEW_STATUSES[number];
export type GrowthInterviewQuestionKind = typeof GROWTH_INTERVIEW_QUESTION_KINDS[number];
export type GrowthInterviewQuestionOrigin = typeof GROWTH_INTERVIEW_QUESTION_ORIGINS[number];
export type GrowthBriefStatus = typeof GROWTH_BRIEF_STATUSES[number];
export type GrowthMilestoneComparator = typeof GROWTH_MILESTONE_COMPARATORS[number];
export type GrowthMilestoneSource = typeof GROWTH_MILESTONE_SOURCES[number];
export type GrowthMilestoneStatus = typeof GROWTH_MILESTONE_STATUSES[number];
export type GrowthActionWorkflowStatus = typeof GROWTH_ACTION_WORKFLOW_STATUSES[number];
export type GrowthPipelineWorkflowId = typeof GROWTH_PIPELINE_WORKFLOW_IDS[number];

export type GrowthAnalysisStep = {
  id: string,
  label: string,
  /**
   * Two-to-three sentences on what this step does, shown on hover over its checklist row. Null when the
   * backend predates the field (see growth-api.ts) — the row then renders exactly as it did before, with
   * no hover affordance, rather than an empty tooltip.
   */
  description: string | null,
  state: GrowthAnalysisStepState,
};

/**
 * The compute-metrics phase's standalone status block (rendered above the deep-analysis checklist,
 * not as a checklist row). `metricLabels` is the backend catalog's stored-metric labels in catalog
 * order — presentation only; the phase's own `state` is the sole source of truth for done/failed.
 * Null when the run predates the compute-metrics phase (old runs render without the block).
 */
export type GrowthComputeMetrics = {
  state: GrowthAnalysisStepState,
  metricLabels: string[],
};

/**
 * The human-gated integrations step (rendered as its own block between the compute-metrics block
 * and the deep-analysis checklist, never as a checklist row). Null when the run predates the
 * integrations phase (old runs render without the block).
 *
 * The wire carries a `connection_ready` flag that is deliberately NOT mirrored here. This build has
 * no ad-platform backend, so the backend hardcodes it false and cannot do otherwise — the only
 * "connection" is a browser-local preview (lib/ad-platforms/ad-platforms-api.ts) that never reaches
 * the server. Mirroring an always-false flag invites exactly the bug it caused before: UI branching
 * on a signal that can never be true, stranding anyone who did connect. Re-add it here when a real
 * ad-platform integration lands and the backend can actually report it.
 */
export type GrowthIntegrations = {
  state: GrowthIntegrationsState,
};

/**
 * Whether the customer's workspace has been released to them.
 *
 * `preparing` is the initial hold from the moment deep analysis starts until an admin releases the
 * first report. The generated interview is presented inside that loading state when it becomes
 * ready; after the customer answers, the same state continues through report composition and review.
 *
 * `not_ready` is everything earlier (no onboarding, no run, or pre-analysis setup) plus failed runs.
 */
export const GROWTH_RELEASE_STATES = ["not_ready", "preparing", "released"] as const;
export type GrowthReleaseState = typeof GROWTH_RELEASE_STATES[number];

export type GrowthStatus = {
  onboarding: {
    completed: boolean,
    completedAtMillis: number | null,
    websiteUrl: string | null,
  },
  analysis: {
    state: GrowthAnalysisState,
    runId: string | null,
    trigger: GrowthRunTrigger | null,
    startedAtMillis: number | null,
    completedAtMillis: number | null,
    steps: GrowthAnalysisStep[] | null,
    computeMetrics: GrowthComputeMetrics | null,
    integrations: GrowthIntegrations | null,
    errorMessage: string | null,
  },
  interview: {
    state: GrowthInterviewState,
    answeredCount: number,
    estimatedTotal: number,
  },
  latestReport: {
    id: string,
    createdAtMillis: number,
    readAtMillis: number | null,
    trigger: GrowthRunTrigger,
    milestoneLabel: string | null,
  } | null,
  latestBrief: {
    id: string,
    /** ISO date (YYYY-MM-DD), UTC — briefs are keyed by day, not by timestamp. */
    date: string,
    createdAtMillis: number,
  } | null,
  counts: {
    suggestedActions: number,
    activeActions: number,
  },
  orchestration: {
    workflows: GrowthOrchestrationWorkflow[],
  },
  release: {
    state: GrowthReleaseState,
  },
};

/**
 * Health snapshot of one canonical pipeline workflow, straight from the status endpoint. `edited`
 * means the customer changed the shipped source; `exists: false` means they deleted it entirely.
 * Both are recoverable through the restore endpoint. `activeWorkflowRunState` is only ever non-null
 * for growth-analysis (relative to the current analysis run); `lastFailedRunSummary` is the most
 * recent FAILED run's summary (which may predate newer successful runs — phrase it accordingly).
 */
export type GrowthOrchestrationWorkflow = {
  workflowId: GrowthPipelineWorkflowId,
  exists: boolean,
  edited: boolean,
  activeWorkflowRunState: string | null,
  lastFailedRunSummary: string | null,
};

export type GrowthRunPhase = {
  phaseKey: string,
  status: GrowthPhaseStatus,
  attempt: number,
  startedAtMillis: number | null,
  finishedAtMillis: number | null,
  errorMessage: string | null,
};

export type GrowthRun = {
  id: string,
  status: GrowthRunStatus,
  trigger: GrowthRunTrigger,
  createdAtMillis: number,
  completedAtMillis: number | null,
  errorMessage: string | null,
  phases: GrowthRunPhase[],
};

export type GrowthInterviewQuestionOption = {
  id: string,
  label: string,
  description: string | null,
};

export type GrowthInterviewQuestion = {
  questionKey: string,
  orderIndex: number,
  prompt: string,
  kind: GrowthInterviewQuestionKind,
  options: GrowthInterviewQuestionOption[],
  allowSkip: boolean,
  origin: GrowthInterviewQuestionOrigin,
  answerOptionIds: string[] | null,
  answerFreeText: string | null,
  answeredAtMillis: number | null,
};

export type GrowthInterview = {
  status: GrowthInterviewStatus,
  questions: GrowthInterviewQuestion[],
  /**
   * The chat transcript, an AI SDK UIMessage list. Deliberately opaque here: the dashboard hands these
   * straight to the AI SDK / assistant-ui renderer, which owns the (versioned) message shape, so
   * validating them with zod would only create a second source of truth that drifts.
   */
  messages: unknown[],
};

export type GrowthWatchedMetric = {
  metricId: GrowthMetricId,
  windowDays: number,
};

/**
 * A workflow trigger as carried on the growth action wire (the manifest trigger JSON, camelCased).
 * Structurally identical to the SDK's AdminWorkflowTrigger on purpose, so the workflows app's
 * trigger-chip components render these without conversion.
 */
export type GrowthActionWorkflowTrigger =
  | { type: "event", eventType: string }
  | { type: "schedule", cron: string, timezone: string };

/**
 * The agent-authored automation attached to an action item. Deployed as an ordinary customer
 * workflow (visible in the workflows app) when the item is activated; until then only the proposed
 * source/manifest exist. `lastRunState` is the lowercased latest workflow-run state (null when the
 * workflow never ran); `warnings` are backend-produced display strings from the source scan
 * (secret-looking literals, external domains).
 */
export type GrowthActionWorkflow = {
  workflowId: string,
  source: string,
  triggers: GrowthActionWorkflowTrigger[],
  explanation: string,
  rollbackNote: string,
  status: GrowthActionWorkflowStatus,
  lastRunState: string | null,
  warnings: string[],
};

export type GrowthActionItem = {
  id: string,
  typeId: GrowthActionType,
  category: GrowthCategory | null,
  tags: string[],
  title: string,
  description: string,
  document?: GrowthDocument | null,
  status: GrowthActionStatus,
  /** Type-specific payload (e.g. the blog draft for publish_blog); shape is owned by the type registry. */
  payload: unknown | null,
  watchedMetrics: GrowthWatchedMetric[],
  reportId: string | null,
  briefId: string | null,
  workflow: GrowthActionWorkflow | null,
  createdAtMillis: number,
  activatedAtMillis: number | null,
  completedAtMillis: number | null,
};

export type GrowthAdminDocumentDraft = {
  source: { sourceMdx: string, data: unknown[] } | null,
  document: GrowthDocument | null,
  updatedAtMillis: number,
};

export type GrowthAdminActionPageDraft = GrowthAdminDocumentDraft;

export type GrowthAdminActionPage = {
  action: GrowthActionItem,
  draft: GrowthAdminActionPageDraft | null,
  publishedAtMillis: number | null,
};

export type GrowthOverviewFinding = {
  id: string,
  source: string,
  kind: string,
  category: GrowthCategory | null,
  tags: string[],
  title: string,
  body: string,
  data: unknown | null,
  document?: GrowthDocument | null,
  createdAtMillis: number,
};

export type GrowthAdminFindingPage = {
  finding: GrowthOverviewFinding,
  draft: GrowthAdminDocumentDraft | null,
  publishedAtMillis: number | null,
};

/**
 * A stage page the customer can see: only the compiled document of the live version.
 *
 * Drafts, version history and the source items a page was written from never reach a customer, so
 * they are absent from this type by construction rather than filtered out at render time.
 */
export type GrowthPublishedCategoryPage = {
  category: GrowthCategory,
  version: number,
  document: GrowthDocument,
  publishedAtMillis: number | null,
  /**
   * The actions this page's buttons reference, carried with the page: the overview's action lanes are
   * capped and active-only, so resolving a button against them would show "no longer available" for a
   * completed action, or for one that simply fell outside the cap.
   */
  actions: GrowthActionItem[],
};

export type GrowthCategoryPageStatus = "draft" | "published" | "archived";

export type GrowthCategoryPageVersionSummary = {
  id: string,
  version: number,
  status: GrowthCategoryPageStatus,
  publishedAtMillis: number | null,
  updatedAtMillis: number,
};

/** A draft or live version as staff see it: the authored source, the compiled document, and provenance. */
export type GrowthCategoryPageVersion = GrowthCategoryPageVersionSummary & {
  category: GrowthCategory,
  /**
   * What the page was authored from, and what the editor round-trips: the `growth-mdx-v1` body plus
   * the evidence data its `<Metric>`/chart components reference. `data` stays opaque here because
   * the compiler — not the dashboard — owns its shape; the editor only moves it back and forth.
   */
  source: { sourceMdx: string, data: unknown[] } | null,
  document: GrowthDocument | null,
  sourceItemIds: { findings: string[], actions: string[] },
  /** Source items that changed (or were deleted) after this version was last saved. */
  staleSourceIds: string[],
  /**
   * The actions this version's buttons reference, carried with it for the same reason a live page
   * carries its own: the overview's lanes are capped and active-only, so a preview resolving a
   * reference against them would call a perfectly valid draft's button unavailable.
   */
  actions: GrowthActionItem[],
};

export type GrowthAdminCategoryPage = {
  category: GrowthCategory,
  draft: GrowthCategoryPageVersion | null,
  published: GrowthCategoryPageVersion | null,
  archived: GrowthCategoryPageVersionSummary[],
};

export type GrowthOverview = {
  latestReport: { id: string, title: string, summary: string, createdAtMillis: number } | null,
  latestBrief: { id: string, date: string, summary: string, contentMd: string, createdAtMillis: number } | null,
  findings: GrowthOverviewFinding[],
  notes: GrowthOverviewFinding[],
  actions: GrowthActionItem[],
  archive: GrowthActionItem[],
  categories: { category: GrowthCategory, count: number, score: number | null }[],
  /** Live stage pages, one per stage that has one. A stage without one keeps the raw item lanes. */
  categoryPages: GrowthPublishedCategoryPage[],
  needsCategoryCount: number,
  limit: number,
};

export type GrowthReportSection = {
  id: string | null,
  kind: string,
  title: string,
  bodyMd: string,
};

export type GrowthReport = {
  id: string,
  runId: string,
  title: string,
  summary: string,
  contentMd: string,
  document?: GrowthDocument | null,
  sections: GrowthReportSection[] | null,
  createdAtMillis: number,
  actionItems: GrowthActionItem[],
};

/** One point of a daily metric series; `date` is an ISO date (YYYY-MM-DD, UTC). */
export type GrowthMetricPoint = {
  date: string,
  value: number,
};

export type GrowthActionMetricSeries = {
  metricId: GrowthMetricId,
  windowDays: number,
  before: GrowthMetricPoint[],
  after: GrowthMetricPoint[],
  beforeCapturedAtMillis: number | null,
  afterCapturedAtMillis: number | null,
};

/**
 * Ad spend for the brief's day, present only once at least one `run_ads` campaign has reported
 * insights. Reported in the AD ACCOUNT's own timezone (`timezone`), which is generally NOT the brief's
 * own UTC date key — see growth-format.ts's `formatGrowthAdMetricsTimezoneNote` for why every render of
 * this must say so.
 */
export type GrowthBriefAdMetrics = {
  spendMinor: number,
  currency: string,
  impressions: number,
  clicks: number,
  ctr: number,
  /** ISO date (YYYY-MM-DD) in the ad account's own timezone — may differ from the brief's UTC `date`. */
  date: string,
  timezone: string,
};

export type GrowthBrief = {
  id: string,
  /** ISO date (YYYY-MM-DD), UTC — briefs are keyed by day, not by timestamp. */
  date: string,
  status: GrowthBriefStatus,
  summary: string,
  contentMd: string,
  document?: GrowthDocument | null,
  readAtMillis: number | null,
  createdAtMillis: number,
  adMetrics: GrowthBriefAdMetrics | null,
};

/**
 * Dashboard-side mirror of the frozen `AdsBody` — the wire shape the ads lifecycle routes return.
 *
 * No such route exists in this build (the ad platform integration owns them), so today this type has
 * exactly one producer: the demo fixtures in growth-demo-data.ts, which is what still makes the
 * created-paused / live / failed panels demoable. It is kept in the frozen shape rather than trimmed
 * to what the fixtures happen to use, so the panels do not need rewriting when the real routes land.
 * camelCase per this file's own convention.
 */
export const GROWTH_ADS_STATUSES = ["creating", "paused", "publishing", "active", "pausing", "rolled_back", "failed", "discarded"] as const;
export type GrowthAdsStatus = typeof GROWTH_ADS_STATUSES[number];

/**
 * The lifecycle phase of a campaign build.
 *
 * `claiming | anchored | dispatched | verifying | done` are the current values: the backend creates
 * an anchor campaign, dispatches an agent session to build the rest through Meta's MCP server, and
 * then verifies the result by reading the ad account back. `campaign | adset | creative | ad` are
 * the LEGACY values from the deterministic create walk that preceded it — kept here for the same
 * reason the database's CHECK constraint keeps them for one release: a row that was mid-build across
 * the deploy still carries one, and the panel must render it rather than failing to parse the whole
 * response.
 */
export const GROWTH_ADS_CREATION_STEPS = [
  "claiming", "anchored", "dispatched", "verifying", "done",
  "campaign", "adset", "creative", "ad",
] as const;
export type GrowthAdsCreationStep = typeof GROWTH_ADS_CREATION_STEPS[number];

/** Phase labels for the panel. A raw value like "dispatched" tells a customer nothing. */
export const GROWTH_ADS_CREATION_STEP_LABELS: ReadonlyMap<GrowthAdsCreationStep, string> = new Map([
  ["claiming", "Getting ready"],
  ["anchored", "Campaign created"],
  ["dispatched", "Building ad set and creative"],
  ["verifying", "Checking what was created"],
  ["done", "Finished"],
  ["campaign", "Creating campaign"],
  ["adset", "Creating ad set"],
  ["creative", "Creating creative"],
  ["ad", "Creating ad"],
] satisfies [GrowthAdsCreationStep, string][]);

export type GrowthAdsEntity = {
  externalId: string,
  name: string,
  configuredStatus: string,
  effectiveStatus: string,
};

export type GrowthAdsBody = {
  status: GrowthAdsStatus,
  creationStep: GrowthAdsCreationStep,
  attempt: number,
  platform: "meta",
  accountId: string,
  campaign: GrowthAdsEntity | null,
  adSet: GrowthAdsEntity | null,
  creative: { externalId: string } | null,
  ad: GrowthAdsEntity | null,
  currency: string,
  dailyBudgetMinor: number | null,
  lifetimeBudgetMinor: number | null,
  orphanedExternalIds: string[],
  lastError: { stage: string | null, code: string | null, subcode: string | null },
  publishedAtMillis: number | null,
  publishedByUserId: string | null,
  pausedAtMillis: number | null,
  createdAtMillis: number,
  reconciledAtMillis: number | null,
  /**
   * "We tried to flip this campaign live, and we cannot currently reach Meta to confirm whether it is
   * spending." The frozen contract requires this be rendered prominently, never buried in a tooltip —
   * see ads-panel.tsx's CreatedPausedPanel.
   */
  mayBeLiveUnconfirmed: boolean,
  /**
   * What Hexclave's own independent read of the ad account concluded. This is the ONLY field the UI
   * may present as fact — everything under `execution` is a claim by the AI that built the campaign.
   *
   * `outcome: null` means verification has not run yet, which is different from having run cleanly.
   */
  verification: GrowthAdsVerification,
  /** Progress of the AI build, so the panel can show a stepper rather than an opaque spinner. */
  execution: GrowthAdsExecution,
  /**
   * Meta has accepted the change and is still publishing it. Deliberately SEPARATE from
   * `mayBeLiveUnconfirmed`: this one means "Meta told us it is mid-handoff", that one means "we could
   * not reach Meta to find out". Meta's own tooling is explicit that a PUBLISHING entity must not be
   * reported as live, and collapsing the two would make the honest signal dishonest.
   */
  publishInProgress: boolean,
};

export const GROWTH_ADS_VERIFICATION_OUTCOMES = ["verified", "verified_with_notes", "quarantine", "incomplete", "unreadable"] as const;
export type GrowthAdsVerificationOutcome = typeof GROWTH_ADS_VERIFICATION_OUTCOMES[number];

/** Customer-safe projection of a reconciliation finding. Never carries raw text from Meta. */
export type GrowthAdsVerificationFinding = {
  code: string,
  severity: "blocking" | "note",
  level: string,
  externalId: string | null,
  expected: string | null,
  actual: string | null,
  message: string,
};

export type GrowthAdsVerification = {
  outcome: GrowthAdsVerificationOutcome | null,
  verifiedAtMillis: number | null,
  findings: GrowthAdsVerificationFinding[],
};

export type GrowthAdsExecution = {
  mode: "agent" | "mock" | null,
  attempt: number | null,
  status: string | null,
  dispatchedAtMillis: number | null,
  leaseExpiresAtMillis: number | null,
  /**
   * Ids the AI SAID it created. Deliberately not merged into `campaign`/`adSet`/`ad`, which only ever
   * carry ids reconciliation independently confirmed — the UI must label these as a claim.
   */
  agentReportedIds: Record<string, string>,
};

export type GrowthMilestone = {
  id: string,
  metricId: GrowthMetricId,
  comparator: GrowthMilestoneComparator,
  threshold: number,
  source: GrowthMilestoneSource,
  status: GrowthMilestoneStatus,
  createdAtMillis: number,
};

// ─── Metrics overview (the wide per-day metric store) ─────────────────────────
// Vocabulary mirrors the stored entries of the backend metric catalog
// (apps/backend/src/lib/growth/metric-catalog.ts). The ads category is deliberately absent:
// the metrics-overview endpoint never puts ads entries into `metrics` — ad data rides in
// `adAccounts` with account-local (non-UTC) dates.
export const GROWTH_CATALOG_METRIC_UNITS = ["count", "cents", "percent", "seconds", "minor_units"] as const;
export const GROWTH_CATALOG_METRIC_KINDS = ["flow", "snapshot"] as const;
export const GROWTH_CATALOG_METRIC_CATEGORIES = ["users", "engagement", "web", "email", "revenue", "teams", "derived"] as const;

export type GrowthCatalogMetricUnit = typeof GROWTH_CATALOG_METRIC_UNITS[number];
export type GrowthCatalogMetricKind = typeof GROWTH_CATALOG_METRIC_KINDS[number];
export type GrowthCatalogMetricCategory = typeof GROWTH_CATALOG_METRIC_CATEGORIES[number];

export type GrowthMetricsOverviewMetric = {
  /** Catalog metric id (snake_case), a distinct namespace from the legacy 6 GROWTH_METRIC_IDS. */
  id: string,
  label: string,
  unit: GrowthCatalogMetricUnit,
  category: GrowthCatalogMetricCategory,
  /** flow = value for that day; snapshot = state as of rollup time. */
  kind: GrowthCatalogMetricKind,
  description: string,
  latest: GrowthMetricPoint | null,
  /** Daily points (UTC days) over the endpoint's window, sorted ascending; empty = no rows stored. */
  series: GrowthMetricPoint[],
};

export type GrowthAdAccountMetricPoint = {
  /** ISO date (YYYY-MM-DD) in the AD ACCOUNT's local timezone — NOT UTC. */
  date: string,
  /** Spend in the account currency's minor units. */
  spendMinor: number,
  impressions: number,
  clicks: number,
};

export type GrowthMetricsOverviewAdAccount = {
  accountId: string,
  /** IANA timezone the dates are expressed in; "" when the platform didn't report one. */
  accountTimezone: string,
  /** ISO 4217 currency of spendMinor; "" when the platform didn't report one. */
  currency: string,
  series: GrowthAdAccountMetricPoint[],
};

export type GrowthMetricsOverview = {
  windowDays: number,
  /** Max UTC day with any stored product-metric row; null = the rollup has never produced data. */
  latestStoredDate: string | null,
  metrics: GrowthMetricsOverviewMetric[],
  adAccounts: GrowthMetricsOverviewAdAccount[],
};
