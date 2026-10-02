import type { Tenancy } from "@/lib/tenancies";
import { getBillingTeamId } from "@/lib/plan-entitlements";
import { getPrismaClientForTenancy, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { Prisma } from "@/generated/prisma/client";
import type { IssueBatchDelta } from "./issue-materialization-contract";
import { ISSUE_LOCK_LEASE_MS } from "./issue-merge";
import { randomUUID } from "node:crypto";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { toDurableGroupingProvenance } from "./grouping-provenance";
import type { GroupingHashProvenance } from "./types";


export type IssueBatchApplyOutcome = {
  issueId: string,
  shortId: bigint,
  ownerHash: string,
  isNew: boolean,
  isRegression: boolean,
};

export type IssueMaterializationSideEffectState = {
  webhooksDispatchedAt: Date | null,
  alertsDispatchedAt: Date | null,
};

export type IssueMaterializationResult = {
  status: "applied" | "already_applied" | "deferred_locked",
  outcomes: IssueBatchApplyOutcome[],
  sideEffects: IssueMaterializationSideEffectState,
};

type IssueMaterializationLedgerRow = IssueMaterializationSideEffectState & {
  outcomes: IssueBatchApplyOutcome[],
};


function decodeStoredOutcomes(value: unknown): IssueBatchApplyOutcome[] {
  if (value == null) return [];
  const parsedValue: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsedValue)) throw new Error("Issue materialization ledger outcomes must be an array");

  return parsedValue.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Issue materialization ledger contains an invalid outcome");
    }
    const outcome = entry;
    if (typeof outcome.issueId !== "string"
      || typeof outcome.shortId !== "string"
      || typeof outcome.ownerHash !== "string"
      || typeof outcome.isNew !== "boolean"
      || typeof outcome.isRegression !== "boolean") {
      throw new Error("Issue materialization ledger contains an invalid outcome");
    }
    return {
      issueId: outcome.issueId,
      shortId: BigInt(outcome.shortId),
      ownerHash: outcome.ownerHash,
      isNew: outcome.isNew,
      isRegression: outcome.isRegression,
    };
  });
}

async function readMaterializationLedger(
  prisma: PrismaClientTransaction,
  tenancyId: string,
  batchId: string,
): Promise<IssueMaterializationLedgerRow | null> {
  const rows = await prisma.$queryRaw<{
    outcomes: unknown,
    webhooksDispatchedAt: Date | null,
    alertsDispatchedAt: Date | null,
  }[]>`
    SELECT "outcomes", "webhooksDispatchedAt", "alertsDispatchedAt"
    FROM "IssueMaterialization"
    WHERE "tenancyId" = ${tenancyId}::uuid AND "batchId" = ${batchId}
    LIMIT 1
  `;
  const row = rows.at(0);
  if (row === undefined) return null;
  return {
    outcomes: decodeStoredOutcomes(row.outcomes),
    webhooksDispatchedAt: row.webhooksDispatchedAt,
    alertsDispatchedAt: row.alertsDispatchedAt,
  };
}

function serializeOutcomes(outcomes: readonly IssueBatchApplyOutcome[]): Array<{
  issueId: string,
  shortId: string,
  ownerHash: string,
  isNew: boolean,
  isRegression: boolean,
}> {
  return outcomes.map((outcome) => ({
    issueId: outcome.issueId,
    shortId: outcome.shortId.toString(),
    ownerHash: outcome.ownerHash,
    isNew: outcome.isNew,
    isRegression: outcome.isRegression,
  }));
}

export async function markIssueMaterializationSideEffect(options: {
  tenancy: Tenancy,
  batchId: string,
  sideEffect: "webhooks" | "alerts",
}): Promise<void> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  if (options.sideEffect === "webhooks") {
    await prisma.$executeRaw`
      UPDATE "IssueMaterialization"
      SET "webhooksDispatchedAt" = COALESCE("webhooksDispatchedAt", NOW())
      WHERE "tenancyId" = ${options.tenancy.id}::uuid AND "batchId" = ${options.batchId}
    `;
    return;
  }
  await prisma.$executeRaw`
    UPDATE "IssueMaterialization"
    SET "alertsDispatchedAt" = COALESCE("alertsDispatchedAt", NOW())
    WHERE "tenancyId" = ${options.tenancy.id}::uuid AND "batchId" = ${options.batchId}
  `;
}

type IssueDelta = {
  issueId: string,
  count: number,
  firstEventAt: Date,
  lastEventAt: Date,
  release: string | null,
  serviceName: string | null,
};

type PendingIssue = {
  id: string,
  input: IssueBatchDelta,
};

type IssueHashRole = "primary" | "secondary";

type StoredIssueHashValues = {
  hash: string,
  issueId: string,
  groupingConfigId: string,
  groupingRole: "PRIMARY" | "SECONDARY",
  groupingVariant: string,
  groupingProvenance: ReturnType<typeof toDurableGroupingProvenance>,
};

function issueHashValues(
  input: IssueBatchDelta,
  hash: string,
  role: IssueHashRole,
  issueId: string,
): StoredIssueHashValues {
  const matching = input.groupingProvenance.filter((entry) => entry.hash === hash && entry.role === role);
  const first = matching.at(0);
  if (first === undefined) {
    throw new Error(`Missing ${role} grouping provenance for hash ${JSON.stringify(hash)}`);
  }
  const observedConfigId = String(first.configId);
  const expectedConfigId = String(input.groupingConfigId);
  if (role === "primary" && observedConfigId !== expectedConfigId) {
    throw new Error(`Primary grouping provenance config does not match ${JSON.stringify(input.groupingConfigId)}`);
  }

  return {
    hash,
    issueId,
    groupingConfigId: first.configId,
    groupingRole: role === "primary" ? "PRIMARY" : "SECONDARY",
    groupingVariant: first.variant,
    groupingProvenance: toDurableGroupingProvenance(matching),
  };
}

export function deduplicateIssueMaterializationInputs(
  inputs: readonly IssueBatchDelta[],
): IssueBatchDelta[] {
  const byOwnerHash = new Map<string, IssueBatchDelta>();
  for (const input of inputs) {
    if (!byOwnerHash.has(input.ownerHash)) byOwnerHash.set(input.ownerHash, input);
  }
  return [...byOwnerHash.values()];
}

export function shouldDeferIssueMaterialization(
  rows: readonly { state: string | null }[],
): boolean {
  return rows.some((row) => row.state !== null);
}

async function reclaimExpiredIssueHashLeases(
  tx: PrismaClientTransaction,
  tenancyId: string,
  hashes: readonly string[],
  now: Date,
): Promise<void> {
  if (hashes.length === 0) return;
  const leaseCutoff = new Date(now.getTime() - ISSUE_LOCK_LEASE_MS);
  await tx.$executeRaw`
    UPDATE "IssueHash"
    SET "state" = NULL, "lockedAt" = NULL
    WHERE "tenancyId" = ${tenancyId}::uuid
      AND "hash" = ANY(${[...hashes]}::text[])
      AND "state" IS NOT NULL
      AND ("lockedAt" IS NULL OR "lockedAt" < ${leaseCutoff}::timestamptz)
  `;
}

async function resolveOrCreateIssues(
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancyId: string,
  inputs: readonly IssueBatchDelta[],
  receivedAt: Date,
  ownerTeamId: string | null,
): Promise<Map<string, { issueId: string, shortId: bigint, isNew: boolean }>> {
  return await retryTransaction(prisma, async (tx) => {
    const resolved = new Map<string, { issueId: string, shortId: bigint, isNew: boolean }>();
    const uniqueInputs = deduplicateIssueMaterializationInputs(inputs);
    const ownerHashes = uniqueInputs.map((input) => input.ownerHash);

    await reclaimExpiredIssueHashLeases(tx, tenancyId, ownerHashes, new Date());

    const existing = await tx.$queryRaw<{ hash: string, issueId: string, shortId: bigint, timesSeen: bigint, state: string | null }[]>`
      SELECT h."hash", h."issueId", i."shortId", i."timesSeen", h."state"::text AS "state"
      FROM "IssueHash" h
      JOIN "Issue" i ON i."tenancyId" = h."tenancyId" AND i."id" = h."issueId"
      WHERE h."tenancyId" = ${tenancyId}::uuid AND h."hash" = ANY(${ownerHashes}::text[])
    `;
    for (const row of existing) {
      if (row.state !== null) continue;
      resolved.set(row.hash, { issueId: row.issueId, shortId: row.shortId, isNew: row.timesSeen === 0n });
    }

    if (shouldDeferIssueMaterialization(existing)) return new Map();

    const missing: PendingIssue[] = uniqueInputs
      .filter((input) => !resolved.has(input.ownerHash))
      .map((input) => ({ id: randomUUID(), input }));
    if (missing.length === 0) return resolved;

    const [{ firstShortId }] = await tx.$queryRaw<{ firstShortId: bigint }[]>`
      INSERT INTO "IssueCounter" ("tenancyId", "nextShortId")
      VALUES (${tenancyId}::uuid, ${missing.length + 1}::bigint)
      ON CONFLICT ("tenancyId") DO UPDATE
        SET "nextShortId" = "IssueCounter"."nextShortId" + ${missing.length}::bigint
      RETURNING "nextShortId" - ${missing.length}::bigint AS "firstShortId"
    `;

    const created = await tx.$queryRaw<{ id: string, shortId: bigint }[]>(buildIssueInsertSql(
      tenancyId,
      missing,
      firstShortId,
      receivedAt,
      ownerTeamId,
    ));

    const ownerHashValues = missing.map(({ id, input }) => issueHashValues(input, input.ownerHash, "primary", id));
    if (ownerHashValues.length > 0) {
      await tx.$executeRaw`
        INSERT INTO "IssueHash" (
          "tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance"
        )
        SELECT
          ${tenancyId}::uuid, v."hash", v."issueId"::uuid, v."groupingConfigId",
          v."groupingRole"::"IssueHashGroupingRole", v."groupingVariant", v."groupingProvenance"
        FROM jsonb_to_recordset(${JSON.stringify(ownerHashValues)}::jsonb)
          AS v(
            "hash" text, "issueId" text, "groupingConfigId" text,
            "groupingRole" text, "groupingVariant" text, "groupingProvenance" jsonb
          )
        ON CONFLICT ("tenancyId", "hash") DO NOTHING
      `;
    }

    const rebound = await tx.$queryRaw<{ hash: string, issueId: string, shortId: bigint }[]>`
      SELECT h."hash", h."issueId", i."shortId"
      FROM "IssueHash" h
      JOIN "Issue" i ON i."tenancyId" = h."tenancyId" AND i."id" = h."issueId"
      WHERE h."tenancyId" = ${tenancyId}::uuid
        AND h."hash" = ANY(${missing.map((candidate) => candidate.input.ownerHash)}::text[])
        AND h."state" IS NULL
    `;
    const createdIds = new Set(created.map((candidate) => candidate.id));

    await tx.$executeRaw`
      DELETE FROM "Issue" i
      WHERE i."tenancyId" = ${tenancyId}::uuid
        AND i."id" = ANY(${[...createdIds]}::uuid[])
        AND NOT EXISTS (
          SELECT 1
          FROM "IssueHash" h
          WHERE h."tenancyId" = i."tenancyId" AND h."issueId" = i."id"
        )
    `;

    const pendingByOwnerHash = new Map(missing.map((candidate) => [candidate.input.ownerHash, candidate]));
    const aliasHashValues = rebound.flatMap((row) => {
      const candidate = pendingByOwnerHash.get(row.hash);
      if (candidate === undefined || row.issueId !== candidate.id) return [];
      return candidate.input.aliasHashes.map((hash) => issueHashValues(candidate.input, hash, "secondary", candidate.id));
    });
    if (aliasHashValues.length > 0) {
      await tx.$executeRaw`
        INSERT INTO "IssueHash" (
          "tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance"
        )
        SELECT
          ${tenancyId}::uuid, v."hash", v."issueId"::uuid, v."groupingConfigId",
          v."groupingRole"::"IssueHashGroupingRole", v."groupingVariant", v."groupingProvenance"
        FROM jsonb_to_recordset(${JSON.stringify(aliasHashValues)}::jsonb)
          AS v(
            "hash" text, "issueId" text, "groupingConfigId" text,
            "groupingRole" text, "groupingVariant" text, "groupingProvenance" jsonb
          )
        ON CONFLICT ("tenancyId", "hash") DO NOTHING
      `;
    }

    for (const row of rebound) {
      resolved.set(row.hash, {
        issueId: row.issueId,
        shortId: row.shortId,
        isNew: createdIds.has(row.issueId),
      });
    }

    return resolved;
  });
}

function buildIssueInsertSql(
  tenancyId: string,
  missing: readonly PendingIssue[],
  firstShortId: bigint,
  receivedAt: Date,
  ownerTeamId: string | null,
): Prisma.Sql {
  const rows = missing.map(({ id, input }, index) => Prisma.sql`(
    ${id}::uuid,
    ${tenancyId}::uuid,
    ${(firstShortId + BigInt(index)).toString()}::bigint,
    ${input.type}, ${input.value}, ${input.culprit}, ${input.platform},
    ${input.handled}, ${input.synthetic},
    ${input.firstEventAt}::timestamptz, ${input.lastEventAt}::timestamptz,
    ${input.serviceName}, ${input.deploymentEnvironmentName},
    ${input.release}, ${input.release},
    ${ownerTeamId}::uuid,
    ${receivedAt}::timestamptz
  )`);
  return Prisma.sql`
    INSERT INTO "Issue" (
      "id", "tenancyId", "shortId", "type", "value", "culprit", "platform",
      "handled", "synthetic",
      "firstSeenAt", "lastSeenAt", "serviceName", "deploymentEnvironmentName",
      "firstSeenRelease", "lastSeenRelease", "assignedTeamId", "updatedAt"
    )
    VALUES ${Prisma.join(rows, ",")}
    RETURNING "id", "shortId"
  `;
}

function foldDeltasByIssue(
  inputs: readonly IssueBatchDelta[],
  resolved: ReadonlyMap<string, { issueId: string }>,
): IssueDelta[] {
  const byIssue = new Map<string, IssueDelta>();
  for (const input of inputs) {
    const target = resolved.get(input.ownerHash);
    if (target === undefined) continue;
    const existing = byIssue.get(target.issueId);
    if (existing === undefined) {
      byIssue.set(target.issueId, {
        issueId: target.issueId,
        count: input.count,
        firstEventAt: input.firstEventAt,
        lastEventAt: input.lastEventAt,
        release: input.release,
        serviceName: input.serviceName,
      });
      continue;
    }
    existing.count += input.count;
    if (input.firstEventAt < existing.firstEventAt) existing.firstEventAt = input.firstEventAt;
    if (input.lastEventAt > existing.lastEventAt) existing.lastEventAt = input.lastEventAt;
    existing.release = input.release ?? existing.release;
    existing.serviceName = input.serviceName ?? existing.serviceName;
  }
  return [...byIssue.values()];
}

type AppliedIssue = { issueId: string, isRegression: boolean };

type ClaimAndApplyResult =
  | { status: "applied", outcomes: IssueBatchApplyOutcome[] }
  | { status: "already_applied", ledger: IssueMaterializationLedgerRow }
  | { status: "deferred_locked" };

function buildMaterializationOutcomes(
  resolved: ReadonlyMap<string, { issueId: string, shortId: bigint, isNew: boolean }>,
  applied: readonly AppliedIssue[],
  newIssueIds: ReadonlySet<string>,
): IssueBatchApplyOutcome[] {
  const regressionByIssueId = new Map(applied.map((row) => [row.issueId, row.isRegression]));
  return [...resolved.entries()].flatMap(([ownerHash, target]) => {
    const isRegression = regressionByIssueId.get(target.issueId);
    if (isRegression === undefined) return [];
    return [{
      issueId: target.issueId,
      shortId: target.shortId,
      ownerHash,
      isNew: newIssueIds.has(target.issueId),
      isRegression,
    }];
  });
}

async function claimAndApply(
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancyId: string,
  batchId: string,
  deltas: readonly IssueDelta[],
  ownerHashes: readonly string[],
  resolved: ReadonlyMap<string, { issueId: string, shortId: bigint, isNew: boolean }>,
  receivedAt: Date,
): Promise<ClaimAndApplyResult> {
  const valueRows = deltas.map((delta) => Prisma.sql`(
    ${delta.issueId}::uuid, ${delta.count}::bigint,
    ${delta.firstEventAt}::timestamptz, ${delta.lastEventAt}::timestamptz,
    ${delta.release}, ${delta.serviceName}
  )`);

  return await retryTransaction(prisma, async (tx) => {
    const existingLedger = await readMaterializationLedger(tx, tenancyId, batchId);
    if (existingLedger !== null) return { status: "already_applied", ledger: existingLedger };

    await reclaimExpiredIssueHashLeases(tx, tenancyId, ownerHashes, new Date());

    const lockedHashes = await tx.$queryRaw<{ hash: string, state: string | null }[]>(Prisma.sql`
      SELECT h."hash", h."state"::text AS "state"
      FROM "IssueHash" AS h
      WHERE h."tenancyId" = ${tenancyId}::uuid
        AND h."hash" = ANY(${[...ownerHashes]}::text[])
      ORDER BY h."hash"
      FOR UPDATE OF h
    `);
    if (lockedHashes.length !== ownerHashes.length || lockedHashes.some((row) => row.state !== null)) {
      return { status: "deferred_locked" };
    }

    const lockedIssues = await tx.$queryRaw<{
      id: string,
      timesSeen: bigint,
      status: "UNRESOLVED" | "RESOLVED" | "IGNORED",
      resolvedAt: Date | null,
    }[]>(Prisma.sql`
      WITH target_ids (issue_id) AS (
        VALUES ${Prisma.join(deltas.map((delta) => Prisma.sql`(${delta.issueId}::uuid)`), ",")}
      )
      SELECT i."id", i."timesSeen", i."status", i."resolvedAt"
      FROM "Issue" AS i
      JOIN target_ids AS d ON d.issue_id = i."id"
      WHERE i."tenancyId" = ${tenancyId}::uuid
      FOR UPDATE OF i
    `);
    if (lockedIssues.length !== deltas.length) return { status: "deferred_locked" };
    // isNew belongs to the materialization that first increments the issue,
    // not whichever resolver happened to observe timesSeen=0 before this lock.
    const newIssueIds = new Set(lockedIssues.filter((issue) => issue.timesSeen === 0n).map((issue) => issue.id));
    const regressionIssueIds = new Set(lockedIssues
      .filter((issue) => issue.status === "RESOLVED"
        && issue.resolvedAt !== null
        && receivedAt > issue.resolvedAt)
      .map((issue) => issue.id));

    const applied = await tx.$queryRaw<Array<Pick<AppliedIssue, "issueId">>>(Prisma.sql`
      WITH deltas (issue_id, cnt, first_event_at, last_event_at, release, service_name) AS (
        VALUES ${Prisma.join(valueRows, ",")}
      ),
      claim AS (
        INSERT INTO "IssueMaterialization" ("tenancyId", "batchId")
        VALUES (${tenancyId}::uuid, ${batchId})
        ON CONFLICT ("tenancyId", "batchId") DO NOTHING
        RETURNING 1
      ),
      applied AS (
        UPDATE "Issue" AS i
        SET "timesSeen"   = i."timesSeen" + d.cnt,
            "lastSeenAt"  = GREATEST(i."lastSeenAt",  d.last_event_at),
            "firstSeenAt" = LEAST(i."firstSeenAt",    d.first_event_at),
            "lastSeenRelease" = COALESCE(d.release, i."lastSeenRelease"),
            "serviceName"     = COALESCE(d.service_name, i."serviceName"),
            "status" = CASE
                WHEN i."status" = 'RESOLVED'
                     AND ${receivedAt}::timestamptz > COALESCE(i."resolvedAt", '-infinity'::timestamptz) THEN 'UNRESOLVED'
                WHEN i."status" = 'IGNORED'
                     AND i."ignoredUntil" IS NOT NULL
                     AND ${receivedAt}::timestamptz > i."ignoredUntil" THEN 'UNRESOLVED'
                ELSE i."status"
              END::"IssueStatus",
            "regressedAt" = CASE
                WHEN i."status" = 'RESOLVED'
                     AND ${receivedAt}::timestamptz > COALESCE(i."resolvedAt", '-infinity'::timestamptz) THEN ${receivedAt}::timestamptz
                ELSE i."regressedAt"
              END,
            "ignoredUntil" = CASE
                WHEN i."status" = 'IGNORED'
                     AND i."ignoredUntil" IS NOT NULL
                     AND ${receivedAt}::timestamptz > i."ignoredUntil" THEN NULL
                ELSE i."ignoredUntil"
              END,
            "updatedAt" = ${receivedAt}::timestamptz
        FROM deltas d
        WHERE i."tenancyId" = ${tenancyId}::uuid
          AND i."id" = d.issue_id
          AND EXISTS (SELECT 1 FROM claim)
        RETURNING i."id" AS "issueId"
      )
      SELECT * FROM applied
    `);
    if (applied.length === 0) {
      const ledger = await readMaterializationLedger(tx, tenancyId, batchId);
      if (ledger === null) throw new Error("Issue materialization claim disappeared without a ledger row");
      return { status: "already_applied", ledger };
    }

    // PostgreSQL RETURNING exposes the post-update row. Deriving regression
    // from regressedAt there makes a second batch with the same timestamp look
    // like it performed the transition too, so carry the pre-update decision
    // captured while the issue row was locked.
    const outcomes = buildMaterializationOutcomes(
      resolved,
      applied.map(({ issueId }) => ({ issueId, isRegression: regressionIssueIds.has(issueId) })),
      newIssueIds,
    );
    await tx.$executeRaw`
      UPDATE "IssueMaterialization"
      SET "outcomes" = ${JSON.stringify(serializeOutcomes(outcomes))}::jsonb
      WHERE "tenancyId" = ${tenancyId}::uuid AND "batchId" = ${batchId}
    `;
    return { status: "applied", outcomes };
  });
}

export async function materializeIssuesFromBatchWithStatus(options: {
  tenancy: Tenancy,
  batchId: string,
  inputs: readonly IssueBatchDelta[],
  receivedAt: Date,
}): Promise<IssueMaterializationResult> {
  const { tenancy, batchId, inputs, receivedAt } = options;
  const emptySideEffects = {
    webhooksDispatchedAt: null,
    alertsDispatchedAt: null,
  };
  if (inputs.length === 0) {
    return { status: "already_applied", outcomes: [], sideEffects: emptySideEffects };
  }

  const prisma = await getPrismaClientForTenancy(tenancy);
  const tenancyId = tenancy.id;
  const existingLedger = await readMaterializationLedger(prisma, tenancyId, batchId);
  if (existingLedger !== null) {
    return {
      status: "already_applied",
      outcomes: existingLedger.outcomes,
      sideEffects: {
        webhooksDispatchedAt: existingLedger.webhooksDispatchedAt,
        alertsDispatchedAt: existingLedger.alertsDispatchedAt,
      },
    };
  }

  const resolved = await resolveOrCreateIssues(prisma, tenancyId, inputs, receivedAt, getBillingTeamId(tenancy.project));
  const deltas = foldDeltasByIssue(inputs, resolved);
  if (deltas.length === 0) {
    return { status: "deferred_locked", outcomes: [], sideEffects: emptySideEffects };
  }

  const ownerHashes = [...new Set(inputs.map((input) => input.ownerHash))];
  const result = await claimAndApply(prisma, tenancyId, batchId, deltas, ownerHashes, resolved, receivedAt);
  if (result.status === "applied") {
    return { status: "applied", outcomes: result.outcomes, sideEffects: emptySideEffects };
  }
  if (result.status === "deferred_locked") {
    return { status: "deferred_locked", outcomes: [], sideEffects: emptySideEffects };
  }
  return {
    status: "already_applied",
    outcomes: result.ledger.outcomes,
    sideEffects: {
      webhooksDispatchedAt: result.ledger.webhooksDispatchedAt,
      alertsDispatchedAt: result.ledger.alertsDispatchedAt,
    },
  };
}

export async function materializeIssuesFromBatch(options: {
  tenancy: Tenancy,
  batchId: string,
  inputs: readonly IssueBatchDelta[],
  receivedAt: Date,
}): Promise<IssueBatchApplyOutcome[]> {
  const result = await materializeIssuesFromBatchWithStatus(options);
  return result.outcomes;
}
