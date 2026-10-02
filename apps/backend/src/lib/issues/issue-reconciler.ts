import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import type { IssueBatchDelta } from "./issue-materialization-contract";
import { isGroupingConfigId } from "./grouping-config";
import {
  fromDurableGroupingProvenance,
  parseDurableGroupingProvenance,
  type DurableGroupingHashProvenance,
} from "./grouping-provenance";
import {
  markIssueMaterializationSideEffect,
  materializeIssuesFromBatchWithStatus,
  type IssueMaterializationResult,
} from "./issue-store";
import { emitIssueWebhooks } from "./issue-webhooks";
import { dispatchIssueAlertsForMaterialization } from "./issue-alerts/ingestion";


export const ISSUE_RECONCILER_LOOKBACK_MS = 60 * 60 * 1000;

export const ISSUE_RECONCILER_SETTLE_MS = 2 * 60 * 1000;

export const ISSUE_RECONCILER_MAX_CANDIDATE_BATCHES = 5000;
export const ISSUE_RECONCILER_MAX_TENANCIES = 25;
export const ISSUE_RECONCILER_MAX_BATCHES_PER_TENANCY = 100;
export const ISSUE_RECONCILER_MAX_BATCHES_PER_RUN = 500;
export const ISSUE_MATERIALIZATION_LEDGER_RETENTION_DAYS = 96;
export const ISSUE_MATERIALIZATION_PRUNE_BATCH_SIZE = 1_000;

export type IssueReconcilerResult = {
  tenanciesScanned: number,
  batchesRepaired: number,
  batchesDeferred: number,
  occurrencesSkipped: number,
  ledgerRowsPruned: number,
};

type CandidateRow = { project_id: string, branch_id: string, batch_id: string };

type OccurrenceGroupRow = {
  batch_id: string,
  issue_hash: string,
  grouping_config: string,
  selected_issue_variant: string,
  grouping_provenance: string,
  occurrences: string | number,
  first_event_at_millis: string | number,
  last_event_at_millis: string | number,
  received_at_millis: string | number,
  error_type: string,
  message: string,
  culprit: string,
  runtime: string,
  service_name: string | null,
  environment: string | null,
  release: string | null,
  handled: boolean,
  synthetic: boolean,
};

export function groupingProvenanceForReconciliation(row: Pick<OccurrenceGroupRow, "grouping_config" | "grouping_provenance" | "issue_hash" | "selected_issue_variant">): DurableGroupingHashProvenance[] {
  if (row.grouping_provenance !== "[]") return parseDurableGroupingProvenance(row.grouping_provenance);
  return [{
    hash: row.issue_hash,
    role: "primary",
    config_id: row.grouping_config,
    variant: row.selected_issue_variant,
    fingerprint: {
      type: "default",
      source: "degraded",
      tokens: [],
      resolved_tokens: [],
    },
  }];
}

export function completeBatchRebuildOptions(options: {
  projectId: string,
  branchId: string,
  batchIds: readonly string[],
  from: Date,
  to: Date,
}): { projectId: string, branchId: string, batchIds: readonly string[] } {
  return { projectId: options.projectId, branchId: options.branchId, batchIds: options.batchIds };
}

function platformFromRuntime(runtime: string): string {
  return runtime === "browser" ? "javascript" : "node";
}

export function buildIssueRebuildQuery(timeFilter: string): string {
  return `
      SELECT
        batch_id,
        issue_hash,
        any(issue_grouping_config) AS grouping_config,
        any(issue_variant) AS selected_issue_variant,
        -- \`any\` matches the neighboring column projections. The alias hashes are
        -- deliberately NOT selected from \`issue_hashes\`: the provenance column
        -- records every hash of the decision (owner primary + alias secondaries),
        -- and reading aliases out of the same value that carries their decision
        -- records keeps the two consistent even when two \`any(...)\` aggregates
        -- would have picked different rows of the group.
        any(issue_grouping_provenance) AS grouping_provenance,
        count() AS occurrences,
        toUnixTimestamp64Milli(min(event_at)) AS first_event_at_millis,
        toUnixTimestamp64Milli(max(event_at)) AS last_event_at_millis,
        toUnixTimestamp64Milli(max(created_at)) AS received_at_millis,
        argMax(error_type, event_at) AS error_type,
        argMax(message, event_at) AS message,
        argMax(error_culprit, event_at) AS culprit,
        argMax(runtime, event_at) AS runtime,
        argMax(service_name, event_at) AS service_name,
        argMax(deployment_environment_name, event_at) AS environment,
        argMax(nullIf(toString(data.release), ''), event_at) AS release,
        -- Mechanism facts, read back out of the occurrence's \`data\` because the
        -- Issue row persists them at CREATION time and a reconciled batch may be
        -- the one that creates the issue. \`handled\` defaults to true: an error we
        -- cannot prove crashed the caller must not be reported as a crash.
        argMax(toString(data.handled) = 'true', event_at) AS handled,
        argMax(issue_variant = 'message' AND toString(data.synthetic) = 'true', event_at) AS synthetic
      FROM analytics_internal.events
      PREWHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND event_type = '$error'
        ${timeFilter}
      WHERE issue_hash != ''
        AND batch_id IN {batchIds:Array(String)}
      GROUP BY batch_id, issue_hash
    `;
}

export const ISSUE_RECONCILER_CANDIDATE_BATCHES_SQL = `
      SELECT project_id, branch_id, batch_id
      FROM analytics_internal.events
      PREWHERE event_type = '$error'
        AND event_at >= {from:DateTime64(3)}
        AND event_at < {to:DateTime64(3)}
      WHERE issue_hash != ''
        AND batch_id != ''
      GROUP BY project_id, branch_id, batch_id
      ORDER BY min(event_at) ASC
      LIMIT {cap:UInt64}
    `;

async function findCandidateBatches(from: Date, to: Date): Promise<CandidateRow[]> {
  const client = getSharedClickhouseAdminClient();
  const result = await client.query({
    query: ISSUE_RECONCILER_CANDIDATE_BATCHES_SQL,
    query_params: {
      from: from.getTime() / 1000,
      to: to.getTime() / 1000,
      cap: ISSUE_RECONCILER_MAX_CANDIDATE_BATCHES,
    },
    format: "JSONEachRow",
  });
  return await result.json<CandidateRow>();
}

async function findAppliedBatchIds(tenancy: Tenancy, batchIds: readonly string[]): Promise<Set<string>> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$replica().$queryRaw<{ batchId: string }[]>`
    SELECT "batchId"
    FROM "IssueMaterialization"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "batchId" = ANY(${[...batchIds]}::text[])
  `;
  return new Set(rows.map((row) => row.batchId));
}

async function rebuildInputs(options: {
  projectId: string,
  branchId: string,
  batchIds: readonly string[],
  from?: Date,
  to?: Date,
}): Promise<{ byBatch: Map<string, { inputs: IssueBatchDelta[], receivedAt: Date }>, skipped: number }> {
  const client = getSharedClickhouseAdminClient();
  const timeFilter = options.from === undefined || options.to === undefined
    ? ""
    : `
        AND event_at >= {from:DateTime64(3)}
        AND event_at < {to:DateTime64(3)}`;
  const queryParams: { projectId: string, branchId: string, batchIds: string[], from?: number, to?: number } = {
    projectId: options.projectId,
    branchId: options.branchId,
    batchIds: [...options.batchIds],
  };
  if (options.from !== undefined && options.to !== undefined) {
    queryParams.from = options.from.getTime() / 1000;
    queryParams.to = options.to.getTime() / 1000;
  }
  const result = await client.query({
    query: buildIssueRebuildQuery(timeFilter),
    query_params: queryParams,
    format: "JSONEachRow",
  });
  const rows = await result.json<OccurrenceGroupRow>();

  const byBatch = new Map<string, { inputs: IssueBatchDelta[], receivedAt: Date }>();
  let skipped = 0;
  for (const row of rows) {
    const durableProvenance = groupingProvenanceForReconciliation(row);
    if (!isGroupingConfigId(row.grouping_config) || durableProvenance.some((entry) => !isGroupingConfigId(entry.config_id))) {
      skipped += 1;
      continue;
    }
    const groupingProvenance = fromDurableGroupingProvenance(durableProvenance);
    const primary = groupingProvenance.find((entry) => entry.role === "primary")
      ?? throwErr("Stored grouping provenance has no primary entry; ingest always records the owner hash's decision first");
    if (primary.hash !== row.issue_hash) {
      throw new Error("Stored grouping provenance's primary hash does not match the row's issue_hash; both are written from the same grouping result at ingest");
    }
    const receivedAt = new Date(Number(row.received_at_millis));
    const entry = byBatch.get(row.batch_id) ?? { inputs: [], receivedAt };
    if (receivedAt > entry.receivedAt) entry.receivedAt = receivedAt;
    entry.inputs.push({
      ownerHash: row.issue_hash,
      aliasHashes: [...new Set(groupingProvenance
        .filter((provenanceEntry) => provenanceEntry.role === "secondary")
        .map((provenanceEntry) => provenanceEntry.hash))]
        .filter((hash) => hash !== row.issue_hash),
      groupingConfigId: row.grouping_config,
      groupingProvenance,
      type: row.error_type,
      value: row.message,
      culprit: row.culprit,
      handled: row.handled,
      synthetic: row.synthetic,
      platform: platformFromRuntime(row.runtime),
      count: Number(row.occurrences),
      firstEventAt: new Date(Number(row.first_event_at_millis)),
      lastEventAt: new Date(Number(row.last_event_at_millis)),
      serviceName: row.service_name,
      deploymentEnvironmentName: row.environment,
      release: row.release,
      level: "error",
    });
    byBatch.set(row.batch_id, entry);
  }
  return { byBatch, skipped };
}

export class IssueMaterializationBatchNotVisibleError extends Error {
  public constructor(public readonly batchId: string) {
    super(`Telemetry batch ${JSON.stringify(batchId)} is not visible in ClickHouse yet`);
    this.name = "IssueMaterializationBatchNotVisibleError";
  }
}

export type IssueMaterializationBatchResult =
  | { status: "applied", batchesRepaired: 1, occurrencesSkipped: number }
  | { status: "already_applied" | "deferred_locked" | "no_error_rows" | "deleted_tenancy", batchesRepaired: 0, occurrencesSkipped: number };

async function dispatchMaterializationSideEffects(options: {
  tenancy: Tenancy,
  batchId: string,
  inputs: readonly IssueBatchDelta[],
  receivedAt: Date,
  result: IssueMaterializationResult,
}): Promise<void> {
  if (options.result.status === "deferred_locked") return;

  if (options.result.sideEffects.alertsDispatchedAt === null) {
    await dispatchIssueAlertsForMaterialization({
      tenancy: options.tenancy,
      batchId: options.batchId,
      outcomes: options.result.outcomes,
      inputs: options.inputs,
      receivedAt: options.receivedAt,
    });
    await markIssueMaterializationSideEffect({
      tenancy: options.tenancy,
      batchId: options.batchId,
      sideEffect: "alerts",
    });
  }

  if (options.result.sideEffects.webhooksDispatchedAt === null) {
    await emitIssueWebhooks({
      tenancy: options.tenancy,
      outcomes: options.result.outcomes,
      now: options.receivedAt,
      batchId: options.batchId,
      force: options.result.status === "already_applied",
    });
    await markIssueMaterializationSideEffect({
      tenancy: options.tenancy,
      batchId: options.batchId,
      sideEffect: "webhooks",
    });
  }
}

export async function processIssueMaterializationBatch(options: {
  tenancy: Tenancy,
  batchId: string,
}): Promise<IssueMaterializationBatchResult> {
  const client = getSharedClickhouseAdminClient();
  const visibility = await client.query({
    query: `
      SELECT count() AS count
      FROM analytics_internal.events
      PREWHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND event_type = '$error'
      WHERE batch_id = {batchId:String}
    `,
    query_params: {
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      batchId: options.batchId,
    },
    format: "JSONEachRow",
  });
  const visibilityRows = await visibility.json<{ count: string | number }>();
  const visibilityRow = visibilityRows.at(0) ?? throwErr("ClickHouse telemetry visibility query returned no row");
  const visibleCount = Number(visibilityRow.count);
  if (!Number.isSafeInteger(visibleCount) || visibleCount < 0) {
    throw new Error("ClickHouse telemetry visibility query returned an invalid count");
  }
  if (visibleCount === 0) throw new IssueMaterializationBatchNotVisibleError(options.batchId);

  const { byBatch, skipped } = await rebuildInputs({
    projectId: options.tenancy.project.id,
    branchId: options.tenancy.branchId,
    batchIds: [options.batchId],
  });
  const batch = byBatch.get(options.batchId);
  if (batch === undefined || batch.inputs.length === 0) {
    return { status: "no_error_rows", batchesRepaired: 0, occurrencesSkipped: skipped };
  }

  const result = await materializeIssuesFromBatchWithStatus({
    tenancy: options.tenancy,
    batchId: options.batchId,
    inputs: batch.inputs,
    receivedAt: batch.receivedAt,
  });
  if (result.status === "deferred_locked") {
    return { status: "deferred_locked", batchesRepaired: 0, occurrencesSkipped: skipped };
  }

  await dispatchMaterializationSideEffects({
    tenancy: options.tenancy,
    batchId: options.batchId,
    inputs: batch.inputs,
    receivedAt: batch.receivedAt,
    result,
  });
  if (result.status === "applied") {
    return { status: "applied", batchesRepaired: 1, occurrencesSkipped: skipped };
  }
  return { status: "already_applied", batchesRepaired: 0, occurrencesSkipped: skipped };
}

function groupCandidatesByProjectBranch(candidates: readonly CandidateRow[]): Array<{ projectId: string, branchId: string, batchIds: string[] }> {
  const byProject = new Map<string, Map<string, { projectId: string, branchId: string, batchIds: string[] }>>();
  for (const candidate of candidates) {
    const byBranch = byProject.get(candidate.project_id) ?? new Map();
    const entry = byBranch.get(candidate.branch_id) ?? { projectId: candidate.project_id, branchId: candidate.branch_id, batchIds: [] };
    entry.batchIds.push(candidate.batch_id);
    byBranch.set(candidate.branch_id, entry);
    byProject.set(candidate.project_id, byBranch);
  }
  return [...byProject.values()].flatMap((byBranch) => [...byBranch.values()]);
}

export async function reconcileIssues(options?: { now?: Date }): Promise<IssueReconcilerResult> {
  const now = options?.now ?? new Date();
  const to = new Date(now.getTime() - ISSUE_RECONCILER_SETTLE_MS);
  const from = new Date(now.getTime() - ISSUE_RECONCILER_LOOKBACK_MS);

  const candidates = await findCandidateBatches(from, to);
  const byProjectBranch = groupCandidatesByProjectBranch(candidates);

  const result: IssueReconcilerResult = {
    tenanciesScanned: 0,
    batchesRepaired: 0,
    batchesDeferred: 0,
    occurrencesSkipped: 0,
    ledgerRowsPruned: 0,
  };

  for (const entry of byProjectBranch.slice(0, ISSUE_RECONCILER_MAX_TENANCIES)) {
    if (result.batchesRepaired >= ISSUE_RECONCILER_MAX_BATCHES_PER_RUN) {
      result.batchesDeferred += entry.batchIds.length;
      continue;
    }
    try {
      const repaired = await reconcileTenancy({ ...entry, from, to });
      result.tenanciesScanned += 1;
      result.batchesRepaired += repaired.batchesRepaired;
      result.batchesDeferred += repaired.batchesDeferred;
      result.occurrencesSkipped += repaired.occurrencesSkipped;
    } catch (error) {
      captureError("issue-reconciler-tenancy", { error, projectId: entry.projectId, branchId: entry.branchId });
    }
  }

  result.ledgerRowsPruned = await pruneIssueMaterializationLedger();
  if (result.batchesRepaired > 0 || result.occurrencesSkipped > 0) {
    console.log(
      `[IssueReconciler] repaired ${result.batchesRepaired} batch(es) across ${result.tenanciesScanned} tenancy(ies)`
      + `; deferred ${result.batchesDeferred}, skipped ${result.occurrencesSkipped} occurrence group(s) on unknown grouping configs`,
    );
  }
  return result;
}

export async function pruneIssueMaterializationLedger(): Promise<number> {
  const rows = await globalPrismaClient.$queryRaw<{ id: number }[]>`
    WITH stale AS (
      SELECT "tenancyId", "batchId"
      FROM "IssueMaterialization"
      WHERE "appliedAt" < NOW() - make_interval(days => ${ISSUE_MATERIALIZATION_LEDGER_RETENTION_DAYS})
      ORDER BY "appliedAt"
      LIMIT ${ISSUE_MATERIALIZATION_PRUNE_BATCH_SIZE}
    )
    DELETE FROM "IssueMaterialization" AS ledger
    USING stale
    WHERE ledger."tenancyId" = stale."tenancyId"
      AND ledger."batchId" = stale."batchId"
    RETURNING 1 AS id
  `;
  return rows.length;
}

async function reconcileTenancy(options: {
  projectId: string,
  branchId: string,
  batchIds: readonly string[],
  from: Date,
  to: Date,
}): Promise<{ batchesRepaired: number, batchesDeferred: number, occurrencesSkipped: number }> {
  const tenancy = await getSoleTenancyFromProjectBranch(options.projectId, options.branchId, true);
  if (tenancy === null) {
    return { batchesRepaired: 0, batchesDeferred: 0, occurrencesSkipped: 0 };
  }

  const applied = await findAppliedBatchIds(tenancy, options.batchIds);
  const unapplied = options.batchIds.filter((batchId) => !applied.has(batchId));
  if (unapplied.length === 0) return { batchesRepaired: 0, batchesDeferred: 0, occurrencesSkipped: 0 };

  const attempted = unapplied.slice(0, ISSUE_RECONCILER_MAX_BATCHES_PER_TENANCY);
  const { byBatch, skipped } = await rebuildInputs(completeBatchRebuildOptions({
    ...options,
    batchIds: attempted,
  }));

  let batchesRepaired = 0;
  for (const [batchId, { inputs, receivedAt }] of byBatch) {
    if (inputs.length === 0) continue;
    const result = await materializeIssuesFromBatchWithStatus({ tenancy, batchId, inputs, receivedAt });
    if (result.status === "deferred_locked") continue;
    if (result.status === "applied") batchesRepaired += 1;
    await dispatchMaterializationSideEffects({
      tenancy,
      batchId,
      inputs,
      receivedAt,
      result,
    });
  }

  return {
    batchesRepaired,
    batchesDeferred: unapplied.length - attempted.length,
    occurrencesSkipped: skipped,
  };
}
