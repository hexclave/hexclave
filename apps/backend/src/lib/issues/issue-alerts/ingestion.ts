import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { getPrismaClientForTenancy, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { enqueueIssueAlertWorkflowEvent } from "@/lib/workflows/issue-alerts/contract";
import { ensureIssueAlertEmailWorkflow } from "@/lib/workflows/issue-alerts/registration";
import {
  recordIssueAlertWorkflowUpdateInTransaction,
  claimIssueAlertDeliveryInTransaction,
  issueAlertPersistenceService,
  type IssueAlertDeliveryClaimResult,
} from "./persistence";
import { evaluateIssueAlertRule } from "./evaluator";
import { buildIssueAlertSignal } from "./signal";
import { hydrateIssueAlertOwnership } from "@/lib/issues/ownership/hydration";
import type { OwnershipRoutingResolution } from "@/lib/issues/ownership/routing-metadata";
import type { IssueBatchDelta } from "../issue-materialization-contract";
import type { IssueBatchApplyOutcome } from "../issue-store";
import type { IssueAlertMatch, IssueAlertPredicate, IssueAlertRule, IssueAlertRuleScope } from "./types";

const MAX_FREQUENCY_WINDOWS_PER_QUERY = 64;
const MAX_FREQUENCY_COUNT = 1_000_000_000;

type IssueAlertOccurrenceRow = { error_envelope: string | null };

type IssueAlertIssueRow = {
  id: string,
  shortId: bigint,
  type: string,
  value: string,
  culprit: string,
  status: "UNRESOLVED" | "RESOLVED" | "IGNORED",
};

export type IssueAlertDispatchResult = {
  evaluated: number,
  matched: number,
  claimed: number,
  enqueued: number,
  suppressed: number,
  duplicates: number,
  dropped: number,
};

function rulePredicates(rule: IssueAlertRule): readonly IssueAlertPredicate[] {
  return [...rule.conditions.all ?? [], ...rule.conditions.any ?? []];
}

export function collectIssueAlertFrequencyWindows(rules: readonly IssueAlertRule[]): readonly number[] {
  const windows = new Set<number>();
  for (const rule of rules) {
    for (const predicate of rulePredicates(rule)) {
      if (predicate.type !== "frequency") continue;
      windows.add(predicate.windowSeconds);
    }
  }
  return [...windows];
}

function ruleNeedsOccurrenceEnvelope(rule: IssueAlertRule): boolean {
  if (rule.filters?.tags !== undefined && rule.filters.tags.length > 0) return true;
  return rulePredicates(rule).some((predicate) => predicate.type === "attribute");
}

export function buildIssueAlertFrequencyCountsQuery(windows: readonly number[]): string {
  const counts = windows.map((_, index) =>
    `toUInt64(countIf(event_at >= {rangeStart${index}:DateTime})) AS count_${index}`
  ).join(",\n          ");
  return `
        SELECT
          ${counts}
        FROM analytics_internal.events
        PREWHERE project_id = {projectId:String}
          AND branch_id = {branchId:String}
          AND event_type = '$error'
          AND event_at >= {earliestRangeStart:DateTime}
        WHERE issue_hash IN {hashes:Array(String)}
      `;
}

async function loadOccurrenceEnvelope(tenancy: Tenancy, occurrenceId: string | null): Promise<string | undefined> {
  if (occurrenceId === null) return undefined;
  const result = await getSharedClickhouseAdminClient().query({
    query: `
      SELECT error_envelope
      FROM analytics_internal.events
      PREWHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND event_type = '$error'
      WHERE occurrence_id = {occurrenceId:String}
      ORDER BY event_at DESC
      LIMIT 1
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      occurrenceId,
    },
    format: "JSONEachRow",
  });
  const rows = await result.json<IssueAlertOccurrenceRow>();
  return rows[0]?.error_envelope ?? undefined;
}

async function loadFrequencyCounts(
  tenancy: Tenancy,
  hashes: readonly string[],
  windows: readonly number[],
  now: Date,
): Promise<ReadonlyMap<number, number>> {
  if (windows.length === 0 || hashes.length === 0) return new Map();
  const client = getSharedClickhouseAdminClient();
  const counts = new Map<number, number>();
  for (let offset = 0; offset < windows.length; offset += MAX_FREQUENCY_WINDOWS_PER_QUERY) {
    const chunk = windows.slice(offset, offset + MAX_FREQUENCY_WINDOWS_PER_QUERY);
    const rangeStarts = chunk.map((windowSeconds) => Math.floor((now.getTime() - windowSeconds * 1000) / 1000));
    const result = await client.query({
      query: buildIssueAlertFrequencyCountsQuery(chunk),
      query_params: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        hashes: [...hashes],
        earliestRangeStart: Math.min(...rangeStarts),
        ...Object.fromEntries(rangeStarts.map((rangeStart, index) => [`rangeStart${index}`, rangeStart])),
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<Record<string, string | number>>();
    const row = rows[0] ?? {};
    for (const [index, windowSeconds] of chunk.entries()) {
      const raw = row[`count_${index}`] ?? "0";
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("ClickHouse returned an invalid issue-alert frequency count");
      counts.set(windowSeconds, Math.min(count, MAX_FREQUENCY_COUNT));
    }
  }
  return counts;
}

async function enqueueMatchInTransaction(
  tx: PrismaClientTransaction,
  tenancy: Tenancy,
  scope: IssueAlertRuleScope,
  databaseRuleId: string,
  match: IssueAlertMatch,
  now: Date,
  routingResolution?: OwnershipRoutingResolution,
): Promise<{ claim: IssueAlertDeliveryClaimResult, enqueued: boolean }> {
  const claim = await claimIssueAlertDeliveryInTransaction(tx, {
    scope,
    databaseRuleId,
    match,
    now,
  });
  if (claim.status !== "claimed") return { claim, enqueued: false };

  const enqueue = await enqueueIssueAlertWorkflowEvent(tx, tenancy, match, routingResolution);
  if (enqueue.status === "enqueued") {
    await recordIssueAlertWorkflowUpdateInTransaction(tx, scope, claim.delivery.id, {
      kind: "enqueued",
      workflowEventId: enqueue.eventId,
      payload: enqueue.payload,
      at: now,
    });
    return { claim, enqueued: true };
  }

  await recordIssueAlertWorkflowUpdateInTransaction(tx, scope, claim.delivery.id, {
    kind: "dropped",
    error: `Workflow event was dropped: ${enqueue.reason}`,
    at: now,
  });
  return { claim, enqueued: false };
}

function toScope(tenancy: Tenancy): IssueAlertRuleScope {
  return { tenancyId: tenancy.id, projectId: tenancy.project.id, branchId: tenancy.branchId };
}

function ownershipRoutingKey(issueId: string, routing: NonNullable<Extract<IssueAlertMatch["action"], { type: "email" }>["routing"]>): string {
  return JSON.stringify([issueId, routing]);
}

async function issueStillOwnsHashInTransaction(
  tx: PrismaClientTransaction,
  tenancy: Tenancy,
  issueId: string,
  hash: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ hash: string }>>`
    SELECT "hash"
    FROM "IssueHash"
    WHERE "tenancyId" = ${tenancy.id}::uuid
      AND "issueId" = ${issueId}::uuid
      AND "hash" = ${hash}
    FOR UPDATE
  `;
  return rows.length > 0;
}

export async function dispatchIssueAlertsForMaterialization(options: {
  tenancy: Tenancy,
  batchId: string,
  outcomes: readonly IssueBatchApplyOutcome[],
  inputs: readonly IssueBatchDelta[],
  receivedAt: Date,
}): Promise<IssueAlertDispatchResult> {
  const result: IssueAlertDispatchResult = {
    evaluated: 0,
    matched: 0,
    claimed: 0,
    enqueued: 0,
    suppressed: 0,
    duplicates: 0,
    dropped: 0,
  };
  if (options.outcomes.length === 0 || options.inputs.length === 0) return result;

  const scope = toScope(options.tenancy);
  const records = await issueAlertPersistenceService.listActiveRuleRecords(scope);
  if (records.length === 0) return result;
  await ensureIssueAlertEmailWorkflow(options.tenancy);

  const inputsByHash = new Map(options.inputs.map((input) => [input.ownerHash, input]));
  const outcomeIds = [...new Set(options.outcomes.map((outcome) => outcome.issueId))];
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const issueRows = await prisma.issue.findMany({
    where: { tenancyId: options.tenancy.id, id: { in: outcomeIds } },
    select: { id: true, shortId: true, type: true, value: true, culprit: true, status: true },
  });
  const issues = new Map(issueRows.map((issue) => [issue.id, issue]));
  const issueHashRows = await prisma.issueHash.findMany({
    where: { tenancyId: options.tenancy.id, issueId: { in: outcomeIds } },
    select: { issueId: true, hash: true },
  });
  const ownedHashesByIssueId = new Map<string, string[]>();
  for (const row of issueHashRows) {
    const hashes = ownedHashesByIssueId.get(row.issueId);
    if (hashes === undefined) ownedHashesByIssueId.set(row.issueId, [row.hash]);
    else hashes.push(row.hash);
  }
  const rules = records.map((record) => record.rule);
  const frequencyWindows = collectIssueAlertFrequencyWindows(rules);
  const needsEnvelope = rules.some(ruleNeedsOccurrenceEnvelope);
  const ownershipResolutionCache = new Map<string, Promise<OwnershipRoutingResolution>>();
  const frequencyCountsCache = new Map<string, Promise<ReadonlyMap<number, number>>>();

  for (const outcome of options.outcomes) {
    const input = inputsByHash.get(outcome.ownerHash);
    const issue = issues.get(outcome.issueId);
    if (input === undefined || issue === undefined) continue;

    const envelope = needsEnvelope
      ? await loadOccurrenceEnvelope(options.tenancy, input.occurrenceId ?? null)
      : undefined;
    const ownedHashes = ownedHashesByIssueId.get(outcome.issueId) ?? [];
    if (!ownedHashes.includes(outcome.ownerHash)) continue;
    const frequencyCacheKey = JSON.stringify([...ownedHashes].sort());
    const cachedFrequencyCounts = frequencyCountsCache.get(frequencyCacheKey);
    const pendingFrequencyCounts = cachedFrequencyCounts
      ?? loadFrequencyCounts(options.tenancy, ownedHashes, frequencyWindows, options.receivedAt);
    if (cachedFrequencyCounts === undefined) frequencyCountsCache.set(frequencyCacheKey, pendingFrequencyCounts);
    const frequencyCounts = await pendingFrequencyCounts;
    const signal = buildIssueAlertSignal({
      scope,
      outcome,
      input,
      issue,
      errorEnvelope: envelope,
      frequencyCounts,
      batchId: options.batchId,
    });

    for (const record of records) {
      result.evaluated += 1;
      const evaluation = evaluateIssueAlertRule(record.rule, signal);
      if (evaluation.outcome !== "match") continue;
      result.matched += 1;

      let routingResolution: OwnershipRoutingResolution | undefined;
      if (evaluation.action.type === "email" && evaluation.action.userIds === undefined) {
        const routing = evaluation.action.routing;
        if (routing === undefined) throw new Error("Issue alert owner routing is missing its routing target");
        const key = ownershipRoutingKey(signal.issue.id, routing);
        const cached = ownershipResolutionCache.get(key);
        const pending = cached ?? hydrateIssueAlertOwnership(options.tenancy, signal.issue.id, routing);
        if (cached === undefined) ownershipResolutionCache.set(key, pending);
        routingResolution = await pending;
      }

      const delivery = await retryTransaction(prisma, async (tx) => {
        if (!await issueStillOwnsHashInTransaction(tx, options.tenancy, outcome.issueId, outcome.ownerHash)) return null;
        return await enqueueMatchInTransaction(
          tx,
          options.tenancy,
          scope,
          record.databaseId,
          evaluation,
          options.receivedAt,
          routingResolution,
        );
      }, { level: "serializable" });
      if (delivery === null) continue;
      if (delivery.claim.status === "claimed") {
        result.claimed += 1;
        if (delivery.enqueued) result.enqueued += 1;
        else result.dropped += 1;
      } else if (delivery.claim.status === "cooldown_active") {
        result.suppressed += 1;
      } else if (delivery.claim.status === "duplicate") {
        result.duplicates += 1;
      } else {
        result.dropped += 1;
      }
    }
  }
  return result;
}
