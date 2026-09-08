import { Prisma } from "@/generated/prisma/client";
import type { Tenancy } from "@/lib/tenancies";
import { deleteWorkflow, syncWorkflowSource } from "@/lib/workflows/api";
import { deterministicWorkflowUuid, enqueueWorkflowEvent } from "@/lib/workflows/events";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import type { WorkflowTriggerJson } from "@hexclave/shared/dist/interface/workflows";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import {
  getGrowthActionActivationEventType,
  growthManifestTriggersIncludeActivationEvent,
  growthWorkflowTriggerSetsEqual,
  parseStoredGrowthWorkflowManifestTriggers,
  parseWatchedMetrics,
} from "./action-item-wire";
import { GrowthMetricId, GrowthWatchedMetric } from "./action-item-types";
import { normalizeStoredGrowthCategory } from "./categories";
import { computeGrowthMetrics } from "./metrics";
import { scanWorkflowSourceWarnings } from "./workflow-authoring";
import { RELEASED_GROWTH_REPORT_FILTER } from "./report-visibility";

export {
  getGrowthActionActivationEventType,
  growthManifestTriggersIncludeActivationEvent,
  growthWorkflowTriggerSetsEqual,
  parseStoredGrowthWorkflowManifestTriggers,
  parseWatchedMetrics,
} from "./action-item-wire";


export const GROWTH_ACTION_STATUSES = ["proposed", "active", "completed", "dismissed"] as const;
export type GrowthActionStatus = typeof GROWTH_ACTION_STATUSES[number];

const DEFAULT_ACTIONS_PAGE_SIZE = 50;
const MAX_ACTIONS_PAGE_SIZE = 100;

function assertActionStatus(value: string): GrowthActionStatus {
  return GROWTH_ACTION_STATUSES.find((candidate) => candidate === value)
    ?? throwErr(new HexclaveAssertionError(`GrowthActionItem.status contained an unknown value "${value}" — statuses are only ever written from the fixed set, so this should be impossible.`, { value }));
}

type GrowthActionItemRow = {
  id: string,
  typeId: string,
  category: string | null,
  tags: string[],
  title: string,
  description: string,
  document?: unknown,
  status: string,
  payload: unknown,
  watchedMetrics: unknown,
  reportId: string | null,
  briefId: string | null,
  workflowId: string | null,
  workflowSource: string | null,
  workflowManifest: unknown,
  workflowExplanation: string | null,
  workflowRollbackNote: string | null,
  workflowDeployedAt: Date | null,
  createdAt: Date,
  activatedAt: Date | null,
  completedAt: Date | null,
};


export type GrowthActionWorkflowRuntimeInfo = {
  definitionExists: boolean,
  /** Lowercased latest WorkflowRun state, null when the workflow never ran. */
  lastRunState: string | null,
};


export async function loadGrowthActionWorkflowRuntimeInfo(tenancy: Tenancy, items: { id: string, workflowId: string | null }[]): Promise<Map<string, GrowthActionWorkflowRuntimeInfo>> {
  const workflowIds = [...new Set(items.flatMap((item) => item.workflowId == null ? [] : [item.workflowId]))];
  if (workflowIds.length === 0) return new Map();
  const definitions = await globalPrismaClient.workflowDefinition.findMany({
    where: { tenancyId: tenancy.id, workflowId: { in: workflowIds } },
    select: { workflowId: true },
  });
  const existingWorkflowIds = new Set(definitions.map((definition) => definition.workflowId));
  const latestRuns = await globalPrismaClient.$replica().$queryRaw<{ workflowId: string, state: string }[]>(Prisma.sql`
    SELECT DISTINCT ON ("workflowId") "workflowId", "state"::text AS "state"
    FROM "WorkflowRun"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "workflowId" IN (${Prisma.join(workflowIds)})
    ORDER BY "workflowId", "createdAt" DESC, "id" DESC
  `);
  const lastRunStateByWorkflowId = new Map(latestRuns.map((run) => [run.workflowId, run.state.toLowerCase()]));
  const result = new Map<string, GrowthActionWorkflowRuntimeInfo>();
  for (const item of items) {
    if (item.workflowId == null) continue;
    result.set(item.id, {
      definitionExists: existingWorkflowIds.has(item.workflowId),
      lastRunState: lastRunStateByWorkflowId.get(item.workflowId) ?? null,
    });
  }
  return result;
}

function growthActionWorkflowToWire(item: GrowthActionItemRow, runtime: GrowthActionWorkflowRuntimeInfo | null) {
  if (item.workflowId == null) return null;
  const allOrNothing = (field: string) => new HexclaveAssertionError(`GrowthActionItem ${item.id} has workflowId but no ${field} — the workflow columns are all-or-nothing at write time, so this should be impossible.`, { itemId: item.id });
  const source = item.workflowSource ?? throwErr(allOrNothing("workflowSource"));
  const explanation = item.workflowExplanation ?? throwErr(allOrNothing("workflowExplanation"));
  const rollbackNote = item.workflowRollbackNote ?? throwErr(allOrNothing("workflowRollbackNote"));
  const triggers = parseStoredGrowthWorkflowManifestTriggers(item.workflowManifest ?? throwErr(allOrNothing("workflowManifest")));
  const runtimeInfo = item.workflowDeployedAt == null ? null : runtime ?? throwErr(new HexclaveAssertionError(
    `growthActionItemToWire called for deployed workflow-bearing item ${item.id} without runtime info — callers must batch-load it via loadGrowthActionWorkflowRuntimeInfo.`,
    { itemId: item.id },
  ));
  return {
    workflow_id: item.workflowId,
    source,
    triggers,
    explanation,
    rollback_note: rollbackNote,
    // "deleted" is DERIVED (deployed but the definition is gone — the customer deleted it in the
    // workflows app). Deliberately no auto-dismiss of the item: the customer's deletion of the
    // automation says nothing about whether they consider the growth action itself dead.
    status: item.workflowDeployedAt == null ? "not_deployed" as const : runtimeInfo?.definitionExists === true ? "deployed" as const : "deleted" as const,
    last_run_state: runtimeInfo == null ? null : runtimeInfo.lastRunState,
    warnings: scanWorkflowSourceWarnings(source),
  };
}

export function growthActionItemToWire(item: GrowthActionItemRow, workflowRuntime: GrowthActionWorkflowRuntimeInfo | null) {
  return {
    id: item.id,
    type_id: item.typeId,
    category: item.category == null ? null : normalizeStoredGrowthCategory(item.category)
      ?? throwErr(new HexclaveAssertionError(`GrowthActionItem ${item.id} has an unknown stored category.`, { category: item.category })),
    tags: item.tags,
    title: item.title,
    description: item.description,
    document: item.document ?? null,
    status: assertActionStatus(item.status),
    payload: item.payload ?? null,
    watched_metrics: parseWatchedMetrics(item.watchedMetrics).map((entry) => ({
      metric_id: entry.metricId,
      window_days: entry.windowDays,
    })),
    report_id: item.reportId,
    brief_id: item.briefId,
    workflow: growthActionWorkflowToWire(item, workflowRuntime),
    created_at_millis: item.createdAt.getTime(),
    activated_at_millis: item.activatedAt == null ? null : item.activatedAt.getTime(),
    completed_at_millis: item.completedAt == null ? null : item.completedAt.getTime(),
  };
}

function growthDocumentFromRow(row: { id: string, document?: unknown }): unknown | null {
  return row.document ?? null;
}


export async function getGrowthReportBody(tenancy: Tenancy, reportId: string | "latest", options: { publishedOnly: boolean }) {
  const projectId = tenancy.project.id;
  const branchId = tenancy.branchId;
  // A non-UUID id can never match a row, but Prisma would turn it into a Postgres cast error (a
  // 500) instead of a clean miss — so pre-check and 404 early. "latest" is the only non-UUID value
  // with meaning.
  if (reportId !== "latest" && !isUuid(reportId)) {
    throw new StatusError(404, "Report not found.");
  }
  const report = await globalPrismaClient.growthReport.findFirst({
    where: {
      projectId,
      branchId,
      ...reportId === "latest" ? {} : { id: reportId },
      ...options.publishedOnly ? RELEASED_GROWTH_REPORT_FILTER : {},
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (report == null) {
    throw new StatusError(404, "Report not found.");
  }
  const actionItems = await globalPrismaClient.growthActionItem.findMany({
    where: { reportId: report.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const workflowRuntimeByItemId = await loadGrowthActionWorkflowRuntimeInfo(tenancy, actionItems);
  return {
    id: report.id,
    run_id: report.runId,
    title: report.title,
    summary: report.summary,
    content_md: report.contentMd,
    document: growthDocumentFromRow(report),
    sections: report.sections ?? null,
    created_at_millis: report.createdAt.getTime(),
    action_items: actionItems.map((item) => growthActionItemToWire(item, workflowRuntimeByItemId.get(item.id) ?? null)),
  };
}

export async function markGrowthReportReadBody(tenancy: Tenancy, reportId: string): Promise<{ id: string }> {
  if (!isUuid(reportId)) throw new StatusError(404, "Report not found.");
  const report = await globalPrismaClient.growthReport.findFirst({
    where: {
      id: reportId,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      ...RELEASED_GROWTH_REPORT_FILTER,
    },
    select: { id: true, readAt: true },
  });
  if (report == null) throw new StatusError(404, "Report not found.");
  if (report.readAt == null) {
    await globalPrismaClient.growthReport.updateMany({
      where: { id: report.id, readAt: null },
      data: { readAt: new Date() },
    });
  }
  return { id: report.id };
}

export async function listGrowthActionsBody(tenancy: Tenancy, options: {
  status: string | undefined,
  cursor: string | undefined,
  limit: number | undefined,
}) {
  const projectId = tenancy.project.id;
  const branchId = tenancy.branchId;
  const limit = Math.max(1, Math.min(MAX_ACTIONS_PAGE_SIZE, options.limit ?? DEFAULT_ACTIONS_PAGE_SIZE));
  const statusFilter = options.status == null ? undefined : GROWTH_ACTION_STATUSES.find((candidate) => candidate === options.status)
    ?? throwErr(new StatusError(400, `Unknown action status filter: ${options.status}`));

  let cursorPivot: { createdAt: Date, id: string } | null = null;
  if (options.cursor != null) {
    if (!isUuid(options.cursor)) {
      throw new StatusError(400, "Invalid cursor.");
    }
    const pivotRow = await globalPrismaClient.growthActionItem.findFirst({
      where: { id: options.cursor, projectId, branchId },
      select: { id: true, createdAt: true },
    });
    if (pivotRow == null) {
      throw new StatusError(400, "Invalid cursor.");
    }
    cursorPivot = pivotRow;
  }

  const rows = await globalPrismaClient.growthActionItem.findMany({
    where: {
      projectId,
      branchId,
      ...statusFilter === undefined ? {} : { status: statusFilter },
      ...cursorPivot == null ? {} : {
        OR: [
          { createdAt: { lt: cursorPivot.createdAt } },
          { createdAt: cursorPivot.createdAt, id: { lt: cursorPivot.id } },
        ],
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastPageItem = page.length === 0 ? null : page[page.length - 1] ?? throwErr(new HexclaveAssertionError("Non-empty page has no last element — impossible."));
  const workflowRuntimeByItemId = await loadGrowthActionWorkflowRuntimeInfo(tenancy, page);
  return {
    items: page.map((item) => growthActionItemToWire(item, workflowRuntimeByItemId.get(item.id) ?? null)),
    next_cursor: hasMore && lastPageItem != null ? lastPageItem.id : null,
  };
}

// ---------------------------------------------------------------------------
// Activation / dismissal
// ---------------------------------------------------------------------------

async function requireActionItemInTenancy(tenancy: Tenancy, actionItemId: string) {
  const item = await globalPrismaClient.growthActionItem.findFirst({
    where: { id: actionItemId, projectId: tenancy.project.id, branchId: tenancy.branchId },
  });
  if (item == null) {
    // Same 404 whether the item doesn't exist or belongs to another project — no id probing.
    throw new StatusError(404, "Action item not found.");
  }
  return item;
}

export async function deployGrowthActionWorkflow(tenancy: Tenancy, item: { id: string, title: string, workflowId: string, workflowSource: string, workflowManifest: unknown }): Promise<{ createdNew: boolean }> {
  const expectedTriggers = parseStoredGrowthWorkflowManifestTriggers(item.workflowManifest);
  let createdNew: boolean;
  try {
    await syncWorkflowSource(tenancy, { workflowId: item.workflowId, source: item.workflowSource, displayName: item.title, mustBeNew: true });
    createdNew = true;
  } catch (error) {
    if (!(error instanceof StatusError) || error.statusCode !== 400) throw error;
    // syncWorkflowSource throws 400 both for "id already exists" (checked BEFORE compiling) and
    // for compile errors (only reachable when the id was free). Rather than string-matching the
    // message, disambiguate by re-checking the DB: a definition existing now means the 400 was the
    // already-exists case.
    const existingDefinition = await globalPrismaClient.workflowDefinition.findUnique({
      where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId: item.workflowId } },
      select: { latestVersion: true },
    });
    if (existingDefinition == null) throw error;
    const latestVersion = await globalPrismaClient.workflowVersion.findUnique({
      where: { tenancyId_workflowId_version: { tenancyId: tenancy.id, workflowId: item.workflowId, version: existingDefinition.latestVersion } },
      select: { source: true },
    }) ?? throwErr(new HexclaveAssertionError("WorkflowDefinition.latestVersion points at a missing version row", { workflowId: item.workflowId }));
    if (latestVersion.source !== item.workflowSource) {
      throw new StatusError(400, `The workflow id "${item.workflowId}" is already taken in this project — ask the growth assistant to rename this automation.`);
    }
    // Identical source: half-finished prior activation. mustBeNew: false is a hash-match no-op
    // version-wise and simply confirms the deployment.
    await syncWorkflowSource(tenancy, { workflowId: item.workflowId, source: item.workflowSource, displayName: item.title, mustBeNew: false });
    createdNew = false;
  }
  const deployedDefinition = await globalPrismaClient.workflowDefinition.findUnique({
    where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId: item.workflowId } },
    select: { latestVersion: true },
  }) ?? throwErr(new HexclaveAssertionError("Workflow definition vanished right after a successful sync", { workflowId: item.workflowId }));
  const deployedVersion = await globalPrismaClient.workflowVersion.findUnique({
    where: { tenancyId_workflowId_version: { tenancyId: tenancy.id, workflowId: item.workflowId, version: deployedDefinition.latestVersion } },
    select: { manifest: true },
  }) ?? throwErr(new HexclaveAssertionError("WorkflowDefinition.latestVersion points at a missing version row after sync", { workflowId: item.workflowId }));
  const deployedTriggers = parseStoredGrowthWorkflowManifestTriggers(deployedVersion.manifest);
  if (!growthWorkflowTriggerSetsEqual(expectedTriggers, deployedTriggers)) {
    throw new HexclaveAssertionError(
      `Deployed workflow "${item.workflowId}" has a different trigger set than the manifest stored on action item ${item.id} — the stored manifest came from a dry-compile of the same source, so this should be impossible.`,
      { itemId: item.id, workflowId: item.workflowId, expectedTriggers, deployedTriggers },
    );
  }
  return { createdNew };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function activateGrowthActionItem(
  tenancy: Tenancy,
  actionItemId: string,
): Promise<{ status: GrowthActionStatus, workflowId: string | null }> {
  const item = await requireActionItemInTenancy(tenancy, actionItemId);
  const status = assertActionStatus(item.status);

  if (status === "active") {
    // Idempotent: the dashboard retrying an activation (or double-clicking) must not error and must
    // not capture a second "before" snapshot.
    return { status: "active", workflowId: item.workflowId };
  }
  if (status !== "proposed") {
    throw new StatusError(400, `This action is ${status} and can no longer be activated.`);
  }

  // Computed BEFORE the transaction: computeGrowthMetrics fans out to the analytics loaders
  // (ClickHouse + Postgres) and must not run while holding a transaction open. If a concurrent
  // request wins the CAS below in the meantime, this computation is simply discarded.
  const watched = parseWatchedMetrics(item.watchedMetrics);
  const now = new Date();
  const metrics = await computeGrowthMetrics(tenancy, now);
  const snapshotMetrics = Object.fromEntries(watched.map((entry) => [entry.metricId, metrics[entry.metricId]]));

  // Workflow deployment happens OUTSIDE the CAS transaction (it compiles source and writes to the
  // workflows tables in its own transaction). Honest window: a schedule/platform-trigger workflow
  // is live from here until the CAS below commits — if we crash in between, the item stays
  // "proposed" with a deployed workflow, and the retry heals through deployGrowthActionWorkflow's
  // identical-source path (the customer clicking activate again converges the two stores).
  let createdWorkflowInThisCall = false;
  let workflowTriggers: WorkflowTriggerJson[] | null = null;
  if (item.workflowId != null) {
    const workflowSource = item.workflowSource ?? throwErr(new HexclaveAssertionError(`GrowthActionItem ${item.id} has workflowId but no workflowSource — the workflow columns are all-or-nothing at write time.`, { itemId: item.id }));
    const workflowManifest = item.workflowManifest ?? throwErr(new HexclaveAssertionError(`GrowthActionItem ${item.id} has workflowId but no workflowManifest — the workflow columns are all-or-nothing at write time.`, { itemId: item.id }));
    workflowTriggers = parseStoredGrowthWorkflowManifestTriggers(workflowManifest);
    const deployed = await deployGrowthActionWorkflow(tenancy, { id: item.id, title: item.title, workflowId: item.workflowId, workflowSource, workflowManifest });
    createdWorkflowInThisCall = deployed.createdNew;
  }

  const won = await retryTransaction(globalPrismaClient, async (tx) => {
    // CAS on status: exactly one activation flips proposed -> active, so exactly one "before"
    // snapshot exists per item (mirroring how the engine's daily rollup owns the "after" rows).
    const claimed = await tx.growthActionItem.updateMany({
      where: { id: item.id, status: "proposed" },
      data: {
        status: "active",
        activatedAt: now,
        ...item.workflowId != null ? { workflowDeployedAt: now } : {},
      },
    });
    if (claimed.count === 0) return false;
    await tx.growthMetricSnapshot.create({
      data: { actionItemId: item.id, phase: "before", capturedAt: now, metrics: snapshotMetrics },
    });
    // The one-shot activation event fires atomically with the status flip: the CAS guarantees this
    // block runs for exactly one activation, and the outbox row commits iff the flip does.
    // Schedule/platform-trigger workflows enqueue nothing here — they were armed by the deployment
    // itself. The deterministic eventId is belt-and-braces on top of the CAS (a crash-replay of
    // the outbox insert stays a no-op).
    if (item.workflowId != null && workflowTriggers != null && growthManifestTriggersIncludeActivationEvent(workflowTriggers, item.workflowId)) {
      await enqueueWorkflowEvent(tx, {
        tenancy,
        type: getGrowthActionActivationEventType(item.workflowId),
        payload: { action_item_id: item.id, title: item.title, activated_at_millis: now.getTime() },
        eventId: deterministicWorkflowUuid(`growth-action-activation:${tenancy.id}:${item.id}`),
      });
    }
    return true;
  });
  if (!won) {
    // Lost a race with a concurrent activate/dismiss; report whatever the item became. Cleanup of
    // the workflow we just deployed depends on WHO won: a concurrent ACTIVATION wants the workflow
    // deployed (it either created it in a racing sync or healed onto ours), so deleting it would
    // sabotage the winner — only a winning DISMISS leaves our deployment orphaned.
    const current = assertActionStatus((await requireActionItemInTenancy(tenancy, actionItemId)).status);
    if (createdWorkflowInThisCall && item.workflowId != null && current !== "active") {
      try {
        await deleteWorkflow(tenancy, item.workflowId);
      } catch (error) {
        if (error instanceof StatusError && error.statusCode === 404) {
          // Already gone (e.g. the winning dismiss's own cleanup beat us) — fine.
        } else {
          // Best-effort only: the orphaned workflow is visible (and deletable) in the customer's
          // workflows list, so log loudly but do not fail the request over cleanup.
          captureError("growth-action-activation-cleanup", new HexclaveAssertionError(`Failed to clean up workflow "${item.workflowId}" after losing the activation CAS for action item ${item.id}`, { cause: error, itemId: item.id, workflowId: item.workflowId }));
        }
      }
    }
    if (current === "active") {
      return { status: "active", workflowId: item.workflowId };
    }
    throw new StatusError(400, `This action is ${current} and can no longer be activated.`);
  }

  // A `run_ads` item activates like any other action item here: its `payload.ad_campaign` proposal is
  // recorded and surfaced, but nothing is created in any ad platform. The real Meta write path — spec
  // pre-validation, the committed-row-before-creation invariant, and the PAUSED-only Graph walk —
  // lands with the ad platform integration; see GROWTH_ACTION_ITEM_TYPES's `run_ads` executor note.
  return { status: "active", workflowId: item.workflowId };
}

export async function dismissGrowthActionItem(tenancy: Tenancy, actionItemId: string): Promise<{ status: GrowthActionStatus }> {
  const item = await requireActionItemInTenancy(tenancy, actionItemId);
  const status = assertActionStatus(item.status);
  if (status === "dismissed") {
    return { status: "dismissed" };
  }
  if (status === "completed") {
    // Completed items are historical record — dismissing one would erase the fact that it ran.
    throw new StatusError(400, "This action is completed and can no longer be dismissed.");
  }
  const updated = await globalPrismaClient.growthActionItem.updateMany({
    where: { id: item.id, status: { in: ["proposed", "active"] } },
    data: { status: "dismissed" },
  });
  if (updated.count === 0) {
    // Lost a race; converge on the current state the same way activate does.
    const current = assertActionStatus((await requireActionItemInTenancy(tenancy, actionItemId)).status);
    if (current === "dismissed") return { status: "dismissed" };
    throw new StatusError(400, `This action is ${current} and can no longer be dismissed.`);
  }
  // Tear down the deployed workflow AFTER the status flip committed. Re-read workflowDeployedAt
  // fresh: our `item` snapshot may predate a concurrent activation that deployed the workflow and
  // then lost its CAS to this dismiss — deciding from the stale snapshot would leave that
  // workflow running forever for a dismissed item.
  if (item.workflowId != null) {
    const fresh = await globalPrismaClient.growthActionItem.findUnique({
      where: { id: item.id },
      select: { workflowDeployedAt: true },
    });
    if (fresh?.workflowDeployedAt != null) {
      try {
        await deleteWorkflow(tenancy, item.workflowId);
      } catch (error) {
        if (error instanceof StatusError && error.statusCode === 404) {
          // The customer already deleted the workflow themselves — exactly the tolerated state.
        } else {
          // Best-effort: the dismiss itself must never fail over cleanup. The workflow remains
          // visible in the customer's workflows list and the wire keeps reporting it, so nothing
          // is silently lost.
          captureError("growth-action-dismiss-cleanup", new HexclaveAssertionError(`Failed to delete workflow "${item.workflowId}" while dismissing action item ${item.id}`, { cause: error, itemId: item.id, workflowId: item.workflowId }));
        }
      }
    }
  }
  return { status: "dismissed" };
}

// ---------------------------------------------------------------------------
// Before/after metric series
// ---------------------------------------------------------------------------

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(dateString: string, days: number): string {
  return utcDateString(new Date(new Date(`${dateString}T00:00:00.000Z`).getTime() + days * 86_400_000));
}

type DailyRollupRow = { date: string, metrics: unknown };

function rollupSeriesInRange(rollups: DailyRollupRow[], metricId: GrowthMetricId, fromInclusive: string, toExclusive: string): { date: string, value: number }[] {
  const series: { date: string, value: number }[] = [];
  for (const rollup of rollups) {
    if (rollup.date < fromInclusive || rollup.date >= toExclusive) continue;
    if (typeof rollup.metrics !== "object" || rollup.metrics == null || Array.isArray(rollup.metrics)) {
      throw new HexclaveAssertionError("GrowthDailyMetrics.metrics is not an object", { date: rollup.date });
    }
    const value = (rollup.metrics as Record<string, unknown>)[metricId]; // Json object narrowing — validated to a plain object above, and the value's type is checked right below
    // A missing (or non-numeric) value means the rollup predates this metric joining the registry;
    // the day is simply absent from the series rather than an error, matching the wire contract
    // ("missing days simply absent").
    if (typeof value !== "number") continue;
    series.push({ date: rollup.date, value });
  }
  return series;
}

/**
 * Pure series assembly, split from the data loading for testability. Series values come from the
 * stored daily rollups ONLY (never live computation): the metrics page is a trend view and must be
 * cheap and consistent with what briefs/milestones saw.
 *
 * - Activated item: `before` = the windowDays days strictly before the activation day, `after` =
 *   from the activation day onward, capped at windowDays days.
 * - Not activated yet: before-only preview — the last windowDays days of rollups, empty `after`,
 *   null captured_at on both sides.
 */
export function buildGrowthActionMetricSeries(options: {
  watched: GrowthWatchedMetric[],
  rollups: DailyRollupRow[],
  activatedAt: Date | null,
  beforeCapturedAt: Date | null,
  afterCapturedAt: Date | null,
  now: Date,
}) {
  return options.watched.map((entry) => {
    let before: { date: string, value: number }[];
    let after: { date: string, value: number }[];
    if (options.activatedAt != null) {
      const activationDay = utcDateString(options.activatedAt);
      before = rollupSeriesInRange(options.rollups, entry.metricId, addUtcDays(activationDay, -entry.windowDays), activationDay);
      after = rollupSeriesInRange(options.rollups, entry.metricId, activationDay, addUtcDays(activationDay, entry.windowDays));
    } else {
      const today = utcDateString(options.now);
      before = rollupSeriesInRange(options.rollups, entry.metricId, addUtcDays(today, -(entry.windowDays - 1)), addUtcDays(today, 1));
      after = [];
    }
    return {
      metric_id: entry.metricId,
      window_days: entry.windowDays,
      before,
      after,
      before_captured_at_millis: options.activatedAt == null || options.beforeCapturedAt == null ? null : options.beforeCapturedAt.getTime(),
      after_captured_at_millis: options.activatedAt == null || options.afterCapturedAt == null ? null : options.afterCapturedAt.getTime(),
    };
  });
}

export async function getGrowthActionMetricsBody(tenancy: Tenancy, actionItemId: string, now: Date) {
  const item = await requireActionItemInTenancy(tenancy, actionItemId);
  const watched = parseWatchedMetrics(item.watchedMetrics);
  const snapshots = await globalPrismaClient.growthMetricSnapshot.findMany({
    where: { actionItemId: item.id },
    orderBy: { capturedAt: "asc" },
    select: { phase: true, capturedAt: true },
  });
  const beforeSnapshot = snapshots.find((snapshot) => snapshot.phase === "before") ?? null;
  // The engine appends one "after" row per daily rollup; the latest one is when the after-series
  // data was last refreshed.
  const afterSnapshots = snapshots.filter((snapshot) => snapshot.phase === "after");
  const latestAfterSnapshot = afterSnapshots.length === 0 ? null : afterSnapshots[afterSnapshots.length - 1] ?? throwErr(new HexclaveAssertionError("Non-empty snapshot list has no last element — impossible."));

  const maxWindowDays = watched.reduce((acc, entry) => Math.max(acc, entry.windowDays), 1);
  const rangeStartDay = item.activatedAt != null
    ? addUtcDays(utcDateString(item.activatedAt), -maxWindowDays)
    : addUtcDays(utcDateString(now), -(maxWindowDays - 1));
  const rollupRows = await globalPrismaClient.growthDailyMetrics.findMany({
    where: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      date: { gte: new Date(`${rangeStartDay}T00:00:00.000Z`) },
    },
    orderBy: { date: "asc" },
    select: { date: true, metrics: true },
  });
  return {
    metrics: buildGrowthActionMetricSeries({
      watched,
      rollups: rollupRows.map((row) => ({ date: utcDateString(row.date), metrics: row.metrics })),
      activatedAt: item.activatedAt,
      beforeCapturedAt: beforeSnapshot == null ? null : beforeSnapshot.capturedAt,
      afterCapturedAt: latestAfterSnapshot == null ? null : latestAfterSnapshot.capturedAt,
      now,
    }),
  };
}
