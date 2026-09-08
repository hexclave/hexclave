import { Prisma } from "@/generated/prisma/client";
import { GrowthPhaseStatus } from "@/generated/prisma/enums";
import type { Tenancy } from "@/lib/tenancies";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { globalPrismaClient, PrismaClientTransaction, retryTransaction } from "@/prisma-client";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { WorkflowManifestJson } from "@hexclave/shared/dist/interface/workflows";
import { assertGrowthActionTypeId, GROWTH_METRIC_IDS, GrowthWatchedMetric } from "./action-item-types";
import { getInitialPhaseKeysForRun, isGrowthAnalysisTopicPhaseKey } from "./phases";
import { GROWTH_ANALYSIS_TOPICS } from "./analysis-topics";
import { getGrowthActionEventSlug, validateGrowthWorkflowSpec } from "./workflow-authoring";
import { GROWTH_EVENT_TYPES } from "./workflows";
import { assertGrowthCategory, assertGrowthCategoryScore, GROWTH_CATEGORIES, GROWTH_NOTE_KIND, LEGACY_GROWTH_CATEGORIES, normalizeGrowthTags, type GrowthCategory } from "./categories";
import { compileGrowthActionDocument, compileGrowthDocument } from "./content-document";
import { withGrowthInterviewOtherOption } from "./interview-question-options";

/**
 * Write-side logic behind the internal/growth-agent/* machine routes, kept out of the route files the
 * same way lib/growth/dashboard.ts backs the internal/growth/* admin routes. Every function takes the
 * already-authenticated Tenancy from authenticateGrowthAgentRequest and re-scopes every row lookup to
 * that tenancy — the shared machine secret authenticates "the agent runtime", not a project, so
 * project/branch scoping is the only thing standing between projects.
 */

// GrowthAnalysisPhase.errorMessage surfaces directly in the dashboard, so the agent must already
// send safe user-readable text; the truncation only bounds the column size against a runaway
// agent, it is not a sanitization step.
export const GROWTH_AGENT_ERROR_MESSAGE_MAX_CHARS = 500;

export function truncateGrowthAgentErrorMessage(message: string): string {
  return message.length <= GROWTH_AGENT_ERROR_MESSAGE_MAX_CHARS ? message : message.slice(0, GROWTH_AGENT_ERROR_MESSAGE_MAX_CHARS);
}

export const GROWTH_NON_PHASE_FINDING_SOURCES = ["daily-brief", "scheduled-task", "chat", "admin"] as const;

/**
 * A finding's source is either the phase key that produced it or one of the fixed non-phase surfaces.
 * Validated loudly (the agent picking an unknown source is a bug in the agent prompt, not data we want
 * to store and later fail to render).
 */
export function isValidGrowthFindingSource(source: string): boolean {
  if (GROWTH_NON_PHASE_FINDING_SOURCES.some((candidate) => candidate === source)) {
    return true;
  }
  if (isGrowthAnalysisTopicPhaseKey(source)) {
    return GROWTH_ANALYSIS_TOPICS.has(source.slice("analysis:".length));
  }
  return getInitialPhaseKeysForRun().includes(source);
}

/**
 * Strictly parses a `YYYY-MM-DD` string into the UTC-midnight Date Prisma expects for @db.Date
 * columns. The ISO round-trip check rejects calendar-invalid dates (e.g. 2026-02-30), which
 * `new Date(...)` would silently roll over into March.
 */
export function parseGrowthBriefDate(dateString: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new StatusError(400, "date must be formatted as YYYY-MM-DD.");
  }
  const parsed = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateString) {
    throw new StatusError(400, `date "${dateString}" is not a valid calendar date.`);
  }
  return parsed;
}

/**
 * Resolves the watched metrics stored on a new action item: the agent may pass its own list, otherwise
 * the type registry's defaults apply. Agent-provided entries are validated against the metric registry
 * because they are consumed verbatim by the metric-snapshot engine later — a typo'd metric id would
 * only blow up days after creation otherwise.
 */
export function resolveGrowthWatchedMetrics(typeId: string, provided: { metric_id: string, window_days: number }[] | undefined): GrowthWatchedMetric[] {
  const type = assertGrowthActionTypeId(typeId);
  if (provided == null) {
    return type.defaultWatchedMetrics;
  }
  return provided.map((entry) => {
    const metricId = GROWTH_METRIC_IDS.find((candidate) => candidate === entry.metric_id);
    if (metricId == null) {
      throw new StatusError(400, `Unknown watched metric id: ${entry.metric_id}`);
    }
    if (!Number.isInteger(entry.window_days) || entry.window_days < 1 || entry.window_days > 365) {
      throw new StatusError(400, `window_days must be an integer between 1 and 365, got ${entry.window_days}.`);
    }
    return { metricId, windowDays: entry.window_days };
  });
}

/**
 * Normalizes an arbitrary (already yup-validated) wire value into something Prisma's Json columns
 * accept. The JSON round-trip both strips non-JSON values (undefined properties, Dates, ...) and
 * produces the plain-object type Prisma wants; JSON.parse returning `any` is what makes this
 * assignable to InputJsonValue without a cast — the round-trip guarantees it really is plain JSON.
 */
export function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

async function requireRunInTenancy(tx: PrismaClientTransaction, tenancy: Tenancy, runId: string) {
  const run = await tx.growthAnalysisRun.findFirst({
    where: { id: runId, projectId: tenancy.project.id, branchId: tenancy.branchId },
  });
  if (run == null) {
    // Same 404 whether the run doesn't exist or belongs to someone else — the shared machine secret
    // must not be usable to probe which run ids exist in other projects.
    throw new StatusError(404, "Analysis run not found.");
  }
  return run;
}

// ---------------------------------------------------------------------------
// Phase lifecycle
// ---------------------------------------------------------------------------

const TERMINAL_PHASE_STATUSES: GrowthPhaseStatus[] = [GrowthPhaseStatus.COMPLETED, GrowthPhaseStatus.FAILED, GrowthPhaseStatus.SKIPPED];

type GrowthAgentPhaseIdentity = {
  tenancy: Tenancy,
  runId: string,
  phaseKey: string,
  /**
   * The attempt counter the agent was dispatched with, echoed back on every lifecycle call. This is
   * the zombie fence: when the engine re-dispatches a phase it bumps GrowthAnalysisPhase.attempt, so a
   * sandbox from the previous attempt that wakes up late fails every write with a 409 instead of
   * corrupting the new attempt's state.
   */
  attempt: number,
};

async function loadPhaseChecked(tx: PrismaClientTransaction, identity: GrowthAgentPhaseIdentity) {
  await requireRunInTenancy(tx, identity.tenancy, identity.runId);
  const phase = await tx.growthAnalysisPhase.findUnique({
    where: { runId_phaseKey: { runId: identity.runId, phaseKey: identity.phaseKey } },
  });
  if (phase == null) {
    throw new StatusError(404, "Analysis phase not found.");
  }
  if (phase.attempt !== identity.attempt) {
    throw new StatusError(409, "Stale attempt.");
  }
  return phase;
}

export async function startGrowthAgentPhase(identity: GrowthAgentPhaseIdentity, options: { eveSessionId: string | undefined }): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    const phase = await loadPhaseChecked(tx, identity);
    if (TERMINAL_PHASE_STATUSES.includes(phase.status)) {
      throw new StatusError(409, `Phase is already ${phase.status.toLowerCase()} and can no longer be started.`);
    }
    await tx.growthAnalysisPhase.update({
      where: { id: phase.id },
      data: {
        status: GrowthPhaseStatus.RUNNING,
        // startedAt is first-start only so retries within the same attempt (agent-side restart before
        // the engine noticed anything) don't erase how long the phase has really been going.
        startedAt: phase.startedAt ?? new Date(),
        heartbeatAt: new Date(),
        // undefined = leave unchanged; the agent only knows its session id on the initial start call.
        eveSessionId: options.eveSessionId,
      },
    });
  });
}

export async function heartbeatGrowthAgentPhase(identity: GrowthAgentPhaseIdentity): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    const phase = await loadPhaseChecked(tx, identity);
    if (phase.status !== GrowthPhaseStatus.RUNNING) {
      throw new StatusError(409, `Phase is ${phase.status.toLowerCase()}, not running; refusing heartbeat.`);
    }
    await tx.growthAnalysisPhase.update({
      where: { id: phase.id },
      data: { heartbeatAt: new Date() },
    });
  });
}

export async function completeGrowthAgentPhase(identity: GrowthAgentPhaseIdentity): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    const phase = await loadPhaseChecked(tx, identity);
    if (phase.status === GrowthPhaseStatus.COMPLETED) {
      // Idempotent: the agent may retry the completion call after a network error even though the
      // first one landed. Same attempt is guaranteed by loadPhaseChecked above.
      return;
    }
    if (phase.status !== GrowthPhaseStatus.RUNNING && phase.status !== GrowthPhaseStatus.DISPATCHED) {
      throw new StatusError(409, `Phase is ${phase.status.toLowerCase()} and cannot be completed.`);
    }
    await tx.growthAnalysisPhase.update({
      where: { id: phase.id },
      data: { status: GrowthPhaseStatus.COMPLETED, finishedAt: new Date() },
    });
  });
}

export async function failGrowthAgentPhase(identity: GrowthAgentPhaseIdentity, options: { errorMessage: string }): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    const phase = await loadPhaseChecked(tx, identity);
    if (phase.status === GrowthPhaseStatus.FAILED) {
      return;
    }
    if (phase.status !== GrowthPhaseStatus.RUNNING && phase.status !== GrowthPhaseStatus.DISPATCHED) {
      throw new StatusError(409, `Phase is ${phase.status.toLowerCase()} and cannot be failed.`);
    }
    await tx.growthAnalysisPhase.update({
      where: { id: phase.id },
      data: {
        status: GrowthPhaseStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: truncateGrowthAgentErrorMessage(options.errorMessage),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Content writes
// ---------------------------------------------------------------------------

export async function createGrowthFindings(options: {
  tenancy: Tenancy,
  runId: string | undefined,
  source: string,
  findings: { kind: string, category: GrowthCategory, tags: string[], title: string, body: string, data: unknown | undefined, document: unknown | undefined }[],
}): Promise<{ createdCount: number, skippedCount: number }> {
  if (!isValidGrowthFindingSource(options.source)) {
    throw new StatusError(400, `Unknown finding source: ${options.source}`);
  }
  const findings = options.findings.map((finding) => ({
    ...finding,
    compiledDocument: finding.document === undefined ? undefined : compileGrowthDocument(finding.document),
  }));
  return await retryTransaction(globalPrismaClient, async (tx) => {
    if (options.runId != null) {
      await requireRunInTenancy(tx, options.tenancy, options.runId);
    }
    let createdCount = 0;
    let skippedCount = 0;
    for (const finding of findings) {
      // Dedup key is (runId, source, kind, title) inside the tenancy: the agent re-running a phase (or
      // retrying a request) re-produces the same findings, and re-inserting them would multiply the
      // context every later invocation reads. `runId ?? null` matters: findings without a run must
      // only collide with other run-less findings.
      const existing = await tx.growthFinding.findFirst({
        where: {
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
          runId: options.runId ?? null,
          source: options.source,
          kind: finding.kind,
          title: finding.title,
        },
        select: { id: true },
      });
      if (existing != null) {
        skippedCount++;
        continue;
      }
      await tx.growthFinding.create({
        data: {
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
          runId: options.runId,
          source: options.source,
          kind: finding.kind,
          category: assertGrowthCategory(finding.category),
          tags: normalizeGrowthTags(finding.tags),
          title: finding.title,
          body: finding.body,
          data: finding.data === undefined ? undefined : toJsonInput(finding.data),
          document: finding.compiledDocument === undefined ? undefined : toJsonInput(finding.compiledDocument),
        },
      });
      createdCount++;
    }
    return { createdCount, skippedCount };
  });
}

/**
 * Notes are the "what changed and where it is heading" lane of the workspace: trends and patterns
 * the agent observed across the metric history, as opposed to findings, which are point-in-time
 * insights, and action items, which are proposals. Implemented on top of createGrowthFindings rather
 * than duplicating the dedup/tenancy logic — the only difference is that `kind` is pinned, which is
 * exactly what makes the note lane machine-identifiable.
 */
export async function createGrowthNotes(options: {
  tenancy: Tenancy,
  runId: string | undefined,
  source: string,
  notes: { category: GrowthCategory, tags: string[], title: string, body: string, data: unknown | undefined, document: unknown | undefined }[],
}): Promise<{ createdCount: number, skippedCount: number }> {
  return await createGrowthFindings({
    tenancy: options.tenancy,
    runId: options.runId,
    source: options.source,
    findings: options.notes.map((note) => ({ ...note, kind: GROWTH_NOTE_KIND })),
  });
}

/**
 * Validates a growth-journey payload into a stage→score map, accepting the whole journey and only
 * the whole journey: accepting a partial write would let the agent
 * believe it scored the project while the customer still sees "Not scored". Requiring the complete
 * set also forces the model to score the categories relative to each other in a single judgement
 * instead of drifting across separate calls.
 *
 * Pure and separately exported so the completeness/duplicate/range rules are unit-testable without a
 * database, in line with the other pure helpers in this module.
 */
export function resolveGrowthCategoryScores(scores: { category: string, score: number }[]): Map<GrowthCategory, number> {
  const byCategory = new Map<GrowthCategory, number>();
  for (const entry of scores) {
    const category = assertGrowthCategory(entry.category);
    if (byCategory.has(category)) {
      throw new StatusError(400, `Category "${category}" was scored more than once. Send exactly one score per category.`);
    }
    byCategory.set(category, assertGrowthCategoryScore(entry.score));
  }
  const missing = GROWTH_CATEGORIES.filter((category) => !byCategory.has(category));
  if (missing.length > 0) {
    throw new StatusError(400, `Scores are missing for: ${missing.join(", ")}. Score all ${GROWTH_CATEGORIES.length} categories in a single call.`);
  }
  return byCategory;
}

/**
 * Upsert, not insert: re-running the report phase re-scores rather than failing, and the row's
 * `updatedAt` is what tells the workspace how fresh the journey is. Not run-scoped either — a score is
 * the project's current standing, not a per-run artifact.
 */
export async function saveGrowthCategoryScores(options: {
  tenancy: Tenancy,
  scores: { category: string, score: number }[],
}): Promise<{ scores: { category: GrowthCategory, score: number }[] }> {
  const byCategory = resolveGrowthCategoryScores(options.scores);
  await retryTransaction(globalPrismaClient, async (tx) => {
    await tx.growthCategoryScore.deleteMany({
      where: {
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        category: { in: [...LEGACY_GROWTH_CATEGORIES] },
      },
    });
    for (const [category, score] of byCategory) {
      await tx.growthCategoryScore.upsert({
        where: { projectId_branchId_category: { projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, category } },
        create: { projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, category, score },
        update: { score },
      });
    }
  });
  return { scores: GROWTH_CATEGORIES.map((category) => ({ category, score: byCategory.get(category) ?? throwErr(new HexclaveAssertionError("Every category was just verified present.", { category })) })) };
}

export async function upsertGrowthArtifact(options: {
  tenancy: Tenancy,
  runId: string | undefined,
  kind: string,
  title: string,
  content: string,
  metadata: unknown | undefined,
}): Promise<{ artifactId: string }> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    if (options.runId != null) {
      await requireRunInTenancy(tx, options.tenancy, options.runId);
    }
    // App-level upsert: (runId, kind, title) has no DB unique (runId is nullable and artifacts are
    // agent-written only, so a lost race just creates a duplicate the next upsert converges on).
    const existing = await tx.growthArtifact.findFirst({
      where: {
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        runId: options.runId ?? null,
        kind: options.kind,
        title: options.title,
      },
      select: { id: true },
    });
    if (existing != null) {
      await tx.growthArtifact.update({
        where: { id: existing.id },
        // Upsert semantics are whole-value replace, so an omitted metadata clears the stored one
        // instead of silently keeping stale metadata alongside new content.
        data: {
          content: options.content,
          metadata: options.metadata === undefined ? Prisma.JsonNull : toJsonInput(options.metadata),
        },
      });
      return { artifactId: existing.id };
    }
    const created = await tx.growthArtifact.create({
      data: {
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        runId: options.runId,
        kind: options.kind,
        title: options.title,
        content: options.content,
        metadata: options.metadata === undefined ? undefined : toJsonInput(options.metadata),
      },
      select: { id: true },
    });
    return { artifactId: created.id };
  });
}

export type GrowthAgentInterviewQuestionInput = {
  questionKey: string,
  prompt: string,
  kind: "single" | "multi",
  options: { id: string, label: string, description: string | undefined }[],
  allowSkip: boolean | undefined,
  origin: "planned" | "adaptive" | undefined,
};

export async function replaceGrowthInterviewQuestions(options: {
  tenancy: Tenancy,
  runId: string,
  questions: GrowthAgentInterviewQuestionInput[],
}): Promise<{ interviewId: string, questionCount: number }> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    await requireRunInTenancy(tx, options.tenancy, options.runId);
    const interview = await tx.growthInterview.upsert({
      where: { runId: options.runId },
      create: {
        runId: options.runId,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
      },
      update: {},
      include: { questions: { select: { answeredAt: true } } },
    });
    // Wholesale replace is only safe while nobody answered anything: the interview chat references
    // questions by id, so replacing under a started interview would orphan the transcript.
    if (interview.status !== "pending" || interview.questions.some((question) => question.answeredAt != null)) {
      throw new StatusError(409, "The interview has already started; the question plan can no longer be replaced.");
    }
    // Keys must be unique within a plan for the same reason appendGrowthInterviewQuestion rejects a
    // collision: the dashboard pairs a presented card with a plan row by key, so duplicates make the
    // card ambiguous and can render an unanswered question as an answered one.
    const keys = new Set(options.questions.map((question) => question.questionKey));
    if (keys.size !== options.questions.length) {
      throw new StatusError(400, "Every question_key in the plan must be unique.");
    }
    await tx.growthInterviewQuestion.deleteMany({ where: { interviewId: interview.id } });
    await tx.growthInterviewQuestion.createMany({
      data: options.questions.map((question, orderIndex) => ({
        interviewId: interview.id,
        orderIndex,
        questionKey: question.questionKey,
        prompt: question.prompt,
        kind: question.kind,
        options: toJsonInput(withGrowthInterviewOtherOption(question.options)),
        allowSkip: question.allowSkip ?? true,
        origin: question.origin ?? "planned",
      })),
    });
    return { interviewId: interview.id, questionCount: options.questions.length };
  });
}

/**
 * Appends ONE adaptive follow-up question at the next orderIndex. Unlike the wholesale replace
 * above, this is allowed while the interview is pending OR active (the whole point is mid-interview
 * adaptation) and never touches existing rows — answered questions stay untouched, so the 409 guard
 * on replaceGrowthInterviewQuestions is not needed here. The stored origin is always "adaptive"
 * regardless of what the agent sent: a follow-up invented mid-interview is adaptive by definition,
 * and letting the agent label it "planned" would corrupt the plan/adaptive split the dashboard
 * renders.
 */
export async function appendGrowthInterviewQuestion(options: {
  tenancy: Tenancy,
  runId: string,
  question: GrowthAgentInterviewQuestionInput,
}): Promise<{ interviewId: string, questionId: string, orderIndex: number }> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    await requireRunInTenancy(tx, options.tenancy, options.runId);
    const interview = await tx.growthInterview.findUnique({
      where: { runId: options.runId },
      include: { questions: { select: { orderIndex: true, questionKey: true } } },
    });
    if (interview == null) {
      // Append cannot bootstrap an interview: adaptive questions only make sense once a plan exists,
      // and creating a row here would let the report phase start against a phantom interview.
      throw new StatusError(404, "Interview not found.");
    }
    if (interview.status !== "pending" && interview.status !== "active") {
      throw new StatusError(409, `The interview is ${interview.status}; adaptive questions can no longer be added.`);
    }
    // The question key is what the dashboard's transcript uses to pair a presented card with the
    // plan row its answer lands on, so two rows sharing a key make a presented card ambiguous — the
    // customer then sees the repeated question rendered read-only against the already-answered row.
    // The agent chooses the key, and a follow-up that restates an earlier question is exactly when
    // it reuses one, so reject it here and let the agent retry with a distinct key.
    if (interview.questions.some((question) => question.questionKey === options.question.questionKey)) {
      throw new StatusError(409, "A question with this question_key already exists in this interview; adaptive follow-ups need a new key.");
    }
    // max+1 rather than count: a retried append that already landed must not collide with the
    // (interviewId, orderIndex) unique in a way that corrupts ordering.
    const nextOrderIndex = interview.questions.reduce((max, question) => Math.max(max, question.orderIndex), -1) + 1;
    const created = await tx.growthInterviewQuestion.create({
      data: {
        interviewId: interview.id,
        orderIndex: nextOrderIndex,
        questionKey: options.question.questionKey,
        prompt: options.question.prompt,
        kind: options.question.kind,
        options: toJsonInput(withGrowthInterviewOtherOption(options.question.options)),
        allowSkip: options.question.allowSkip ?? true,
        origin: "adaptive",
      },
      select: { id: true },
    });
    return { interviewId: interview.id, questionId: created.id, orderIndex: nextOrderIndex };
  });
}

/**
 * An agent-authored workflow attached to an action item. All-or-nothing by construction: the four
 * fields are only ever carried together inside this object (the routes' yup schemas require every
 * field once the object is present), so a half-specified workflow cannot reach the write path.
 */
export type GrowthAgentActionItemWorkflowInput = {
  workflowId: string,
  source: string,
  explanation: string,
  rollbackNote: string,
};

export type GrowthAgentActionItemInput = {
  typeId: string,
  category: GrowthCategory,
  tags: string[],
  title: string,
  description: string,
  document: unknown | undefined,
  payload: unknown | undefined,
  watchedMetrics: { metric_id: string, window_days: number }[] | undefined,
  workflow: GrowthAgentActionItemWorkflowInput | undefined,
};

/**
 * Dry-validates the workflow specs of a batch of action items BEFORE any transaction touches the
 * DB (the validation compiles + sandbox-executes the source, which must never run inside a
 * retryTransaction), returning the manifest to store per input index. Rejects the whole batch with
 * the compile/validation error text so the agent can fix its source and retry — a half-invalid
 * request writes nothing, mirroring the watched-metrics pre-validation above.
 */
async function validateActionItemWorkflowSpecs(tenancy: Tenancy, items: readonly GrowthAgentActionItemInput[]): Promise<Map<number, WorkflowManifestJson>> {
  const manifestsByIndex = new Map<number, WorkflowManifestJson>();
  const seenWorkflowIds = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (item.workflow == null) continue;
    // Duplicate ids within one batch would both pass the DB availability check (nothing is
    // deployed yet) and then collide at activation time — reject at authoring time instead.
    if (seenWorkflowIds.has(item.workflow.workflowId)) {
      throw new StatusError(400, `Multiple action items use the same workflow id "${item.workflow.workflowId}". Workflow ids must be unique per item.`);
    }
    seenWorkflowIds.add(item.workflow.workflowId);
    const result = await validateGrowthWorkflowSpec({
      tenancy,
      workflowId: item.workflow.workflowId,
      source: item.workflow.source,
      expectedActionEventSlug: getGrowthActionEventSlug(item.workflow.workflowId),
    });
    if (!result.valid || result.manifest == null) {
      throw new StatusError(400, `Invalid workflow for action item "${item.title}": ${result.error ?? "unknown validation error"}`);
    }
    manifestsByIndex.set(index, result.manifest);
  }
  return manifestsByIndex;
}

export async function upsertGrowthReport(options: {
  tenancy: Tenancy,
  runId: string,
  title: string,
  summary: string,
  contentMd: string,
  document: unknown | undefined,
  sections: unknown | undefined,
  actionItems: GrowthAgentActionItemInput[],
}): Promise<{ reportId: string, actionItemIds: string[] }> {
  // Validate every type id (and the watched metrics against the registry) before touching the DB, so
  // a half-invalid request writes nothing.
  const compiledDocument = options.document === undefined ? undefined : compileGrowthDocument(options.document);
  const resolvedItems = options.actionItems.map((item) => ({
    ...item,
    compiledDocument: item.document === undefined ? undefined : compileGrowthActionDocument(item.document),
    resolvedWatchedMetrics: resolveGrowthWatchedMetrics(item.typeId, item.watchedMetrics),
  }));
  const workflowManifestsByIndex = await validateActionItemWorkflowSpecs(options.tenancy, options.actionItems);
  for (const item of options.actionItems) {
    validateRunAdsActionItemPayload(item);
  }
  return await retryTransaction(globalPrismaClient, async (tx) => {
    await requireRunInTenancy(tx, options.tenancy, options.runId);
    const report = await tx.growthReport.upsert({
      where: { runId: options.runId },
      create: {
        runId: options.runId,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        title: options.title,
        summary: options.summary,
        contentMd: options.contentMd,
        sections: options.sections === undefined ? undefined : toJsonInput(options.sections),
        document: compiledDocument === undefined ? undefined : toJsonInput(compiledDocument),
      },
      update: {
        title: options.title,
        summary: options.summary,
        contentMd: options.contentMd,
        sections: options.sections === undefined ? Prisma.JsonNull : toJsonInput(options.sections),
        document: compiledDocument === undefined ? Prisma.JsonNull : toJsonInput(compiledDocument),
      },
      select: { id: true },
    });
    const existingItems = await tx.growthActionItem.findMany({
      where: { reportId: report.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true },
    });
    if (existingItems.some((item) => item.status !== "proposed")) {
      return { reportId: report.id, actionItemIds: existingItems.map((item) => item.id) };
    }
    await tx.growthActionItem.deleteMany({ where: { reportId: report.id } });
    const actionItemIds: string[] = [];
    for (const [index, item] of resolvedItems.entries()) {
      const workflowManifest = workflowManifestsByIndex.get(index);
      const created = await tx.growthActionItem.create({
        data: {
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
          reportId: report.id,
          typeId: item.typeId,
          category: assertGrowthCategory(item.category),
          tags: normalizeGrowthTags(item.tags),
          title: item.title,
          description: item.description,
          document: item.compiledDocument === undefined ? undefined : toJsonInput(item.compiledDocument),
          payload: item.payload === undefined ? undefined : toJsonInput(item.payload),
          watchedMetrics: toJsonInput(item.resolvedWatchedMetrics),
          // workflowDeployedAt stays null: the workflow only becomes a WorkflowDefinition when the
          // customer activates the item (activation logic is a separate migration step).
          workflowId: item.workflow?.workflowId,
          workflowSource: item.workflow?.source,
          workflowManifest: workflowManifest === undefined ? undefined : toJsonInput(workflowManifest),
          workflowExplanation: item.workflow?.explanation,
          workflowRollbackNote: item.workflow?.rollbackNote,
        },
        select: { id: true },
      });
      actionItemIds.push(created.id);
    }
    return { reportId: report.id, actionItemIds };
  });
}

export async function upsertGrowthBrief(options: {
  tenancy: Tenancy,
  date: Date,
  summary: string,
  contentMd: string,
  document: unknown | undefined,
  data: unknown | undefined,
}): Promise<{ briefId: string }> {
  const compiledDocument = options.document === undefined ? undefined : compileGrowthDocument(options.document);
  const brief = await globalPrismaClient.growthBrief.upsert({
    where: {
      projectId_branchId_date: {
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        date: options.date,
      },
    },
    create: {
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      date: options.date,
      status: "ready",
      summary: options.summary,
      contentMd: options.contentMd,
      data: options.data === undefined ? undefined : toJsonInput(options.data),
      document: compiledDocument === undefined ? undefined : toJsonInput(compiledDocument),
    },
    update: {
      status: "ready",
      summary: options.summary,
      contentMd: options.contentMd,
      data: options.data === undefined ? Prisma.JsonNull : toJsonInput(options.data),
      document: compiledDocument === undefined ? Prisma.JsonNull : toJsonInput(compiledDocument),
    },
    select: { id: true },
  });
  return { briefId: brief.id };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRunAdsActionItemPayload(item: GrowthAgentActionItemInput): void {
  if (item.typeId !== "run_ads" || !isPlainObject(item.payload) || item.payload.ad_campaign === undefined) {
    return;
  }
  const adCampaign = item.payload.ad_campaign;
  if (!isPlainObject(adCampaign)) {
    throw new StatusError(400, "Invalid ad_campaign: must be an object.");
  }
}

export async function createGrowthAgentActionItem(options: {
  tenancy: Tenancy,
  briefId: string | undefined,
  item: GrowthAgentActionItemInput,
}): Promise<{ actionItemId: string }> {
  const compiledDocument = options.item.document === undefined ? undefined : compileGrowthActionDocument(options.item.document);
  const watchedMetrics = resolveGrowthWatchedMetrics(options.item.typeId, options.item.watchedMetrics);
  const workflowManifestsByIndex = await validateActionItemWorkflowSpecs(options.tenancy, [options.item]);
  const workflowManifest = workflowManifestsByIndex.get(0);
  validateRunAdsActionItemPayload(options.item);
  return await retryTransaction(globalPrismaClient, async (tx) => {
    if (options.briefId != null) {
      const brief = await tx.growthBrief.findFirst({
        where: { id: options.briefId, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId },
        select: { id: true },
      });
      if (brief == null) {
        throw new StatusError(404, "Brief not found.");
      }
      const existing = await tx.growthActionItem.findFirst({
        where: { briefId: options.briefId, typeId: options.item.typeId, title: options.item.title },
        select: { id: true },
      });
      if (existing != null) {
        return { actionItemId: existing.id };
      }
    }
    const created = await tx.growthActionItem.create({
      data: {
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        briefId: options.briefId,
        typeId: options.item.typeId,
        category: assertGrowthCategory(options.item.category),
        tags: normalizeGrowthTags(options.item.tags),
        title: options.item.title,
        description: options.item.description,
        document: compiledDocument === undefined ? undefined : toJsonInput(compiledDocument),
        payload: options.item.payload === undefined ? undefined : toJsonInput(options.item.payload),
        watchedMetrics: toJsonInput(watchedMetrics),
        // workflowDeployedAt stays null until the customer activates the item (later migration step).
        workflowId: options.item.workflow?.workflowId,
        workflowSource: options.item.workflow?.source,
        workflowManifest: workflowManifest === undefined ? undefined : toJsonInput(workflowManifest),
        workflowExplanation: options.item.workflow?.explanation,
        workflowRollbackNote: options.item.workflow?.rollbackNote,
      },
      select: { id: true },
    });
    return { actionItemId: created.id };
  });
}

export async function completeGrowthInterviewAsAgent(options: { tenancy: Tenancy, runId: string }): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    await requireRunInTenancy(tx, options.tenancy, options.runId);
    const interview = await tx.growthInterview.findUnique({ where: { runId: options.runId } });
    if (interview == null) {
      throw new StatusError(404, "Interview not found.");
    }
    if (interview.status === "completed") {
      return;
    }
    if (interview.status !== "pending" && interview.status !== "active") {
      throw new StatusError(409, `Interview is ${interview.status} and cannot be completed.`);
    }
    await tx.growthInterview.update({
      where: { id: interview.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await enqueueWorkflowEvent(tx, {
      tenancy: { id: options.tenancy.id },
      type: GROWTH_EVENT_TYPES.interviewFinished,
      payload: { growth_run_id: options.runId },
    });
  });
}
