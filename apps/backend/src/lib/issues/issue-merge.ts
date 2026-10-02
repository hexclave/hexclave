import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { getBillingTeamId } from "@/lib/plan-entitlements";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { Prisma } from "@/generated/prisma/client";
import { TELEMETRY_TTL_DAYS } from "../../../scripts/clickhouse-migrations";


export const ISSUE_LOCK_LEASE_MS = 5 * 60 * 1000;

export const ISSUE_COUNTER_WINDOW_DAYS = TELEMETRY_TTL_DAYS;

type IssueRow = {
  id: string,
  shortId: bigint,
  firstSeenAt: Date,
  lastSeenAt: Date,
  timesSeen: bigint,
  status: string,
  statusChangedAt: Date | null,
  resolvedAt: Date | null,
  ignoredUntil: Date | null,
  assigneeUserId: string | null,
  assignedTeamId: string | null,
  type: string,
  value: string,
  culprit: string,
  platform: string,
  handled: boolean,
  synthetic: boolean,
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
  firstSeenRelease: string | null,
  lastSeenRelease: string | null,
  hashes: string[],
};

type TenancyPrismaClient = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;

async function readIssuesWithHashes(
  prisma: TenancyPrismaClient,
  tenancyId: string,
  issueIds: readonly string[],
): Promise<IssueRow[]> {
  if (issueIds.length === 0) return [];
  return await prisma.$queryRaw<IssueRow[]>`
    SELECT
      i."id", i."shortId", i."firstSeenAt", i."lastSeenAt", i."timesSeen",
      i."status"::text AS "status", i."statusChangedAt", i."resolvedAt", i."ignoredUntil",
      i."assigneeUserId", i."assignedTeamId", i."type", i."value", i."culprit", i."platform",
      i."handled", i."synthetic",
      i."serviceName", i."deploymentEnvironmentName",
      i."firstSeenRelease", i."lastSeenRelease",
      COALESCE(
        array_agg(h."hash" ORDER BY h."hash") FILTER (WHERE h."hash" IS NOT NULL),
        ARRAY[]::text[]
      ) AS "hashes"
    FROM "Issue" i
    LEFT JOIN "IssueHash" h ON h."tenancyId" = i."tenancyId" AND h."issueId" = i."id"
    WHERE i."tenancyId" = ${tenancyId}::uuid AND i."id" = ANY(${[...issueIds]}::uuid[])
    GROUP BY i."id", i."tenancyId"
  `;
}

export function orderIssuesForMerge<T extends { firstSeenAt: Date, timesSeen: bigint, id: string }>(issues: readonly T[]): T[] {
  return [...issues].sort((a, b) => {
    const byFirstSeen = a.firstSeenAt.getTime() - b.firstSeenAt.getTime();
    if (byFirstSeen !== 0) return byFirstSeen;
    if (a.timesSeen !== b.timesSeen) return a.timesSeen > b.timesSeen ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function resolveMergedMetadata(ordered: readonly {
  assigneeUserId: string | null,
  firstSeenRelease: string | null,
  lastSeenRelease: string | null,
}[]): { assigneeUserId: string | null, firstSeenRelease: string | null, lastSeenRelease: string | null } {
  const firstNonNull = <T>(pick: (issue: (typeof ordered)[number]) => T | null): T | null => {
    for (const issue of ordered) {
      const value = pick(issue);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    assigneeUserId: firstNonNull((issue) => issue.assigneeUserId),
    firstSeenRelease: firstNonNull((issue) => issue.firstSeenRelease),
    lastSeenRelease: firstNonNull((issue) => issue.lastSeenRelease),
  };
}

async function acquireHashLocks(
  prisma: TenancyPrismaClient,
  tenancyId: string,
  hashes: readonly string[],
  now: Date,
): Promise<string[]> {
  const leaseCutoff = new Date(now.getTime() - ISSUE_LOCK_LEASE_MS);
  const rows = await prisma.$queryRaw<{ hash: string }[]>`
    WITH ordered AS (
      SELECT "hash"
      FROM "IssueHash"
      WHERE "tenancyId" = ${tenancyId}::uuid AND "hash" = ANY(${[...hashes]}::text[])
      ORDER BY "hash"
      FOR UPDATE
    )
    UPDATE "IssueHash" h
    SET "state" = 'LOCKED'::"IssueHashState", "lockedAt" = ${now}::timestamptz
    WHERE h."tenancyId" = ${tenancyId}::uuid
      AND h."hash" IN (SELECT "hash" FROM ordered)
      AND (h."state" IS NULL OR h."lockedAt" IS NULL OR h."lockedAt" < ${leaseCutoff}::timestamptz)
    RETURNING h."hash"
  `;
  return rows.map((row) => row.hash);
}

async function releaseHashLocks(
  prisma: TenancyPrismaClient,
  tenancyId: string,
  hashes: readonly string[],
  lockedAt: Date,
): Promise<void> {
  if (hashes.length === 0) return;
  await prisma.$executeRaw`
    UPDATE "IssueHash"
    SET "state" = NULL, "lockedAt" = NULL
    WHERE "tenancyId" = ${tenancyId}::uuid
      AND "hash" = ANY(${[...hashes]}::text[])
      AND "lockedAt" = ${lockedAt}::timestamptz
  `;
}

async function lockHashesOrThrow(
  prisma: TenancyPrismaClient,
  tenancyId: string,
  hashes: readonly string[],
  now: Date,
): Promise<void> {
  const acquired = await acquireHashLocks(prisma, tenancyId, hashes, now);
  if (acquired.length === hashes.length) return;
  await releaseHashLocks(prisma, tenancyId, acquired, now);
  throw new StatusError(
    StatusError.Conflict,
    "Another merge or unmerge is currently in flight for one of these issues. Try again in a moment.",
  );
}

async function withHashLocks<T>(
  prisma: TenancyPrismaClient,
  tenancyId: string,
  hashes: readonly string[],
  now: Date,
  body: () => Promise<T>,
): Promise<T> {
  await lockHashesOrThrow(prisma, tenancyId, hashes, now);
  try {
    return await body();
  } catch (error) {
    await releaseHashLocks(prisma, tenancyId, hashes, now);
    throw error;
  }
}

async function resolveIssueIds(
  prisma: TenancyPrismaClient,
  tenancyId: string,
  issueIds: readonly string[],
): Promise<Map<string, string>> {
  const redirects = await prisma.$queryRaw<{ fromIssueId: string, toIssueId: string }[]>`
    SELECT "fromIssueId", "toIssueId"
    FROM "IssueRedirect"
    WHERE "tenancyId" = ${tenancyId}::uuid AND "fromIssueId" = ANY(${[...issueIds]}::uuid[])
  `;
  const byFrom = new Map(redirects.map((row) => [row.fromIssueId, row.toIssueId]));
  return new Map(issueIds.map((id) => [id, byFrom.get(id) ?? id]));
}

export type MergeIssuesResult = {
  primaryIssueId: string,
  mergedIssueIds: string[],
};

class RetryMerge extends Error {
  constructor() {
    super("The issue set changed while the merge was running.");
  }
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((value) => bSet.has(value));
}

export async function mergeIssues(options: {
  tenancy: Tenancy,
  issueIds: string[],
}): Promise<MergeIssuesResult> {
  const { tenancy, issueIds } = options;
  const prisma = await getPrismaClientForTenancy(tenancy);
  const tenancyId = tenancy.id;

  const requested = [...new Set(issueIds)];
  if (requested.length < 2) {
    throw new StatusError(StatusError.BadRequest, "Merging requires at least two distinct issues.");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date();
    const resolvedById = await resolveIssueIds(prisma, tenancyId, requested);
    const targetIds = [...new Set(resolvedById.values())];
    if (targetIds.length < 2) {
      const primaryIssueId = targetIds[0] ?? throwNoPrimary(requested);
      return { primaryIssueId, mergedIssueIds: [] };
    }

    const preLock = await readIssuesWithHashes(prisma, tenancyId, targetIds);
    if (preLock.length !== targetIds.length) {
      const found = new Set(preLock.map((issue) => issue.id));
      const missing = targetIds.find((id) => !found.has(id));
      throw new StatusError(StatusError.NotFound, `Issue ${missing} was not found in this project.`);
    }

    const lockedHashes = preLock.flatMap((issue) => issue.hashes);

    try {
      return await withHashLocks(prisma, tenancyId, lockedHashes, now, async () => {
        const currentResolvedById = await resolveIssueIds(prisma, tenancyId, requested);
        const currentTargetIds = [...new Set(currentResolvedById.values())];
        if (!sameStringSet(currentTargetIds, targetIds)) throw new RetryMerge();

        const issues = await readIssuesWithHashes(prisma, tenancyId, targetIds);
        if (issues.length !== targetIds.length) throw new RetryMerge();
        const currentHashes = issues.flatMap((issue) => issue.hashes);
        if (!sameStringSet(currentHashes, lockedHashes)) throw new RetryMerge();

        const ordered = orderIssuesForMerge(issues);
        const primary = ordered[0] ?? throwNoPrimary(targetIds);
        const losers = ordered.slice(1);
        const metadata = resolveMergedMetadata(ordered);

        const applied = await applyMerge(prisma, {
          tenancyId,
          primaryId: primary.id,
          loserIds: losers.map((issue) => issue.id),
          lockedHashes,
          metadata,
          now,
        });
        if (applied.primaryUpdated !== 1) throw new RetryMerge();

        return { primaryIssueId: primary.id, mergedIssueIds: losers.map((issue) => issue.id) };
      });
    } catch (error) {
      if (error instanceof StatusError && error.statusCode === StatusError.Conflict.statusCode) {
        if (attempt === 2) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      if (!(error instanceof RetryMerge)) throw error;
      if (attempt === 2) {
        throw new StatusError(StatusError.Conflict, "The issue set kept changing while the merge was running. Try again.");
      }
    }
  }

  throw new StatusError(StatusError.Conflict, "The merge did not complete.");
}

function throwNoPrimary(targetIds: readonly string[]): never {
  throw new StatusError(StatusError.NotFound, `No issues left to merge among ${targetIds.join(", ")}.`);
}

type MergeCounts = {
  primaryUpdated: number,
  repointedHashes: number,
  rewrittenRedirects: number,
  insertedRedirects: number,
  deletedIssues: number,
};

async function applyMerge(
  prisma: TenancyPrismaClient,
  options: {
    tenancyId: string,
    primaryId: string,
    loserIds: readonly string[],
    lockedHashes: readonly string[],
    metadata: { assigneeUserId: string | null, firstSeenRelease: string | null, lastSeenRelease: string | null },
    now: Date,
  },
): Promise<MergeCounts> {
  const { tenancyId, primaryId, loserIds, lockedHashes, metadata, now } = options;
  const rows = await prisma.$queryRaw<MergeCounts[]>(Prisma.sql`
    WITH lease AS (
      -- FOR UPDATE, not a plain read: the lease was VALIDATED here from the
      -- statement's snapshot, but the statement then runs several dependent
      -- CTEs. If our lease had expired and a concurrent merge stole it while
      -- this statement was executing, a snapshot read could still say "held"
      -- while the hash rows were already repointed — and the gated deletes
      -- below would run against the thief's state. Locking the rows (in hash
      -- order, matching acquireHashLocks) makes the check current AND keeps
      -- the rows frozen until this statement commits.
      SELECT COUNT(*) = ${lockedHashes.length} AS "held"
      FROM (
        SELECT 1
        FROM "IssueHash"
        WHERE "tenancyId" = ${tenancyId}::uuid
          AND "hash" = ANY(${[...lockedHashes]}::text[])
          AND "state" = 'LOCKED'::"IssueHashState"
          AND "lockedAt" = ${now}::timestamptz
        ORDER BY "hash"
        FOR UPDATE
      ) AS locked_lease_rows
    ),
    losers AS (
      SELECT "id", "shortId", "timesSeen", "firstSeenAt", "lastSeenAt", "countersTruncatedAt"
      FROM "Issue"
      WHERE "tenancyId" = ${tenancyId}::uuid AND "id" = ANY(${[...loserIds]}::uuid[])
    ),
    folded AS (
      SELECT
        COALESCE(SUM("timesSeen"), 0)::bigint AS "timesSeen",
        MIN("firstSeenAt") AS "firstSeenAt",
        MAX("lastSeenAt") AS "lastSeenAt",
        MIN("countersTruncatedAt") AS "countersTruncatedAt"
      FROM losers
    ),
    primary_updated AS (
      UPDATE "Issue" i
      SET "timesSeen"        = i."timesSeen" + f."timesSeen",
          "firstSeenAt"      = LEAST(i."firstSeenAt", COALESCE(f."firstSeenAt", i."firstSeenAt")),
          "lastSeenAt"       = GREATEST(i."lastSeenAt", COALESCE(f."lastSeenAt", i."lastSeenAt")),
          -- An issue produced by unmergeIssue carries a windowed counter seed,
          -- marked by countersTruncatedAt. Folding such a loser in makes the
          -- primary's counter approximate too, so the EARLIEST marker must
          -- survive the merge: the summed counter includes every event from
          -- each participant's retained window, and the oldest boundary is the
          -- only honest lower bound for that union. (LEAST skips NULLs; NULL
          -- only when no participant had one.)
          "countersTruncatedAt" = LEAST(i."countersTruncatedAt", f."countersTruncatedAt"),
          "assigneeUserId"   = ${metadata.assigneeUserId}::uuid,
          "firstSeenRelease" = ${metadata.firstSeenRelease},
          "lastSeenRelease"  = ${metadata.lastSeenRelease},
          "updatedAt"        = ${now}::timestamptz
      FROM folded f, lease l
      WHERE i."tenancyId" = ${tenancyId}::uuid
        AND i."id" = ${primaryId}::uuid
        AND l."held"
      RETURNING i."id"
    ),
    -- Everything below is gated on primary_updated having produced a row -- the
    -- same trick issue-store.ts uses for its ledger claim. Reading a
    -- data-modifying CTE's RETURNING output both forces it to run first and makes
    -- the rest conditional on it. Without the gate, a primary that somehow
    -- vanished would leave us deleting the losers with nothing to merge them
    -- into, i.e. losing issues outright.
    repointed AS (
      UPDATE "IssueHash" h
      SET "issueId" = ${primaryId}::uuid, "state" = NULL, "lockedAt" = NULL
      WHERE h."tenancyId" = ${tenancyId}::uuid
        AND h."hash" = ANY(${[...lockedHashes]}::text[])
        AND h."state" = 'LOCKED'::"IssueHashState"
        AND h."lockedAt" = ${now}::timestamptz
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING h."hash"
    ),
    rewritten AS (
      UPDATE "IssueRedirect" r
      SET "toIssueId" = ${primaryId}::uuid
      WHERE r."tenancyId" = ${tenancyId}::uuid
        AND r."toIssueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING r."fromIssueId"
    ),
    inserted AS (
      INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
      SELECT ${tenancyId}::uuid, l."id", ${primaryId}::uuid, l."shortId"
      FROM losers l
      WHERE EXISTS (SELECT 1 FROM primary_updated)
      ON CONFLICT ("tenancyId", "fromIssueId") DO UPDATE SET "toIssueId" = EXCLUDED."toIssueId"
      RETURNING "fromIssueId"
    ),
    comments_moved AS (
      UPDATE "IssueComment" c
      SET "issueId" = ${primaryId}::uuid,
          -- Preserve retry keys unless another participant already owns the
          -- same key in the merged scope. Rewriting every key would make an
          -- ordinary post-merge retry create a duplicate comment.
          "idempotencyKey" = CASE WHEN EXISTS (
            SELECT 1 FROM "IssueComment" conflict
            WHERE conflict."tenancyId" = c."tenancyId"
              AND conflict."projectId" = c."projectId"
              AND conflict."branchId" = c."branchId"
              AND conflict."idempotencyKey" = c."idempotencyKey"
              AND conflict."issueId" = ANY(${[primaryId, ...loserIds]}::uuid[])
              AND (conflict."issueId" = ${primaryId}::uuid OR conflict."id"::text < c."id"::text)
          ) THEN 'merged:' || c."id"::text ELSE c."idempotencyKey" END
      WHERE c."tenancyId" = ${tenancyId}::uuid
        AND c."issueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING c."id"
    ),
    activities_moved AS (
      UPDATE "IssueActivity" a
      SET "issueId" = ${primaryId}::uuid,
          "idempotencyKey" = CASE WHEN EXISTS (
            SELECT 1 FROM "IssueActivity" conflict
            WHERE conflict."tenancyId" = a."tenancyId"
              AND conflict."projectId" = a."projectId"
              AND conflict."branchId" = a."branchId"
              AND conflict."idempotencyKey" = a."idempotencyKey"
              AND conflict."issueId" = ANY(${[primaryId, ...loserIds]}::uuid[])
              AND (conflict."issueId" = ${primaryId}::uuid OR conflict."id"::text < a."id"::text)
          ) THEN 'merged:' || a."id"::text ELSE a."idempotencyKey" END
      WHERE a."tenancyId" = ${tenancyId}::uuid
        AND a."issueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING a."id"
    ),
    bookmark_duplicates_deleted AS (
      DELETE FROM "IssueBookmark" b
      WHERE b."tenancyId" = ${tenancyId}::uuid
        AND b."issueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (
          SELECT 1
          FROM "IssueBookmark" keep
          WHERE keep."tenancyId" = b."tenancyId"
            AND keep."userId" = b."userId"
            AND keep."issueId" = ANY(${[primaryId, ...loserIds]}::uuid[])
            AND (keep."issueId" = ${primaryId}::uuid OR keep."issueId"::text < b."issueId"::text)
        )
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING b."issueId", b."userId"
    ),
    bookmarks_moved AS (
      UPDATE "IssueBookmark" b
      SET "issueId" = ${primaryId}::uuid
      WHERE b."tenancyId" = ${tenancyId}::uuid
        AND b."issueId" = ANY(${[...loserIds]}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM bookmark_duplicates_deleted d
          WHERE d."issueId" = b."issueId" AND d."userId" = b."userId"
        )
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING b."userId"
    ),
    subscription_duplicates_deleted AS (
      DELETE FROM "IssueSubscription" s
      WHERE s."tenancyId" = ${tenancyId}::uuid
        AND s."issueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (
          SELECT 1
          FROM "IssueSubscription" keep
          WHERE keep."tenancyId" = s."tenancyId"
            AND keep."subjectType" = s."subjectType"
            AND keep."subjectUserId" IS NOT DISTINCT FROM s."subjectUserId"
            AND keep."subjectTeamId" IS NOT DISTINCT FROM s."subjectTeamId"
            AND keep."issueId" = ANY(${[primaryId, ...loserIds]}::uuid[])
            AND (keep."issueId" = ${primaryId}::uuid OR keep."issueId"::text < s."issueId"::text)
        )
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING s."id"
    ),
    subscriptions_moved AS (
      UPDATE "IssueSubscription" s
      SET "issueId" = ${primaryId}::uuid
      WHERE s."tenancyId" = ${tenancyId}::uuid
        AND s."issueId" = ANY(${[...loserIds]}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM subscription_duplicates_deleted d WHERE d."id" = s."id"
        )
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING s."id"
    ),
    owner_duplicates_deleted AS (
      DELETE FROM "IssueOwner" o
      WHERE o."tenancyId" = ${tenancyId}::uuid
        AND o."issueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (
          SELECT 1
          FROM "IssueOwner" keep
          WHERE keep."tenancyId" = o."tenancyId"
            AND keep."ownerType" = o."ownerType"
            AND keep."ownerUserId" IS NOT DISTINCT FROM o."ownerUserId"
            AND keep."ownerTeamId" IS NOT DISTINCT FROM o."ownerTeamId"
            AND keep."source" = o."source"
            AND keep."issueId" = ANY(${[primaryId, ...loserIds]}::uuid[])
            AND (keep."issueId" = ${primaryId}::uuid OR keep."issueId"::text < o."issueId"::text)
        )
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING o."id"
    ),
    owners_moved AS (
      UPDATE "IssueOwner" o
      SET "issueId" = ${primaryId}::uuid
      WHERE o."tenancyId" = ${tenancyId}::uuid
        AND o."issueId" = ANY(${[...loserIds]}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM owner_duplicates_deleted d WHERE d."id" = o."id"
        )
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING o."id"
    ),
    deliveries_moved AS (
      UPDATE "IssueAlertDelivery" d
      SET "issueId" = ${primaryId}::uuid
      WHERE d."tenancyId" = ${tenancyId}::uuid
        AND d."issueId" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (SELECT 1 FROM primary_updated)
      RETURNING d."id"
    ),
    deleted AS (
      DELETE FROM "Issue" i
      WHERE i."tenancyId" = ${tenancyId}::uuid
        AND i."id" = ANY(${[...loserIds]}::uuid[])
        AND EXISTS (SELECT 1 FROM primary_updated)
        -- Force every hash and issue-scoped child move to complete before the
        -- parent delete can fire its cascades. The exact hash count also turns
        -- a partial repoint into a failed merge instead of silent data loss.
        AND (SELECT COUNT(*) FROM repointed) = ${lockedHashes.length}
        AND (SELECT COUNT(*) FROM comments_moved) >= 0
        AND (SELECT COUNT(*) FROM activities_moved) >= 0
        AND (SELECT COUNT(*) FROM bookmarks_moved) >= 0
        AND (SELECT COUNT(*) FROM subscriptions_moved) >= 0
        AND (SELECT COUNT(*) FROM owners_moved) >= 0
        AND (SELECT COUNT(*) FROM deliveries_moved) >= 0
      RETURNING i."id"
    )
    SELECT
      (SELECT COUNT(*)::int FROM primary_updated) AS "primaryUpdated",
      (SELECT COUNT(*)::int FROM repointed)       AS "repointedHashes",
      (SELECT COUNT(*)::int FROM rewritten)       AS "rewrittenRedirects",
      (SELECT COUNT(*)::int FROM inserted)        AS "insertedRedirects",
      (SELECT COUNT(*)::int FROM deleted)         AS "deletedIssues"
  `);
  return rows[0] ?? { primaryUpdated: 0, repointedHashes: 0, rewrittenRedirects: 0, insertedRedirects: 0, deletedIssues: 0 };
}

export type UnmergeIssueResult = {
  sourceIssueId: string,
  newIssueId: string,
  newIssueShortId: bigint,
  countersTruncatedAt: Date,
};

async function readWindowedCountersForHashes(options: {
  projectId: string,
  branchId: string,
  hashes: readonly string[],
  windowStart: Date,
}): Promise<{ occurrences: bigint, firstSeenAt: Date, lastSeenAt: Date } | null> {
  const client = getSharedClickhouseAdminClient();
  const result = await client.query({
    query: `
      SELECT
        sum(occurrences) AS occurrences,
        toUnixTimestamp64Milli(min(first_seen)) AS first_seen_millis,
        toUnixTimestamp64Milli(max(last_seen)) AS last_seen_millis
      FROM analytics_internal.issue_occurrence_rollup
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND issue_hash IN {hashes:Array(String)}
        AND bucket_start >= {windowStart:DateTime}
    `,
    query_params: {
      projectId: options.projectId,
      branchId: options.branchId,
      hashes: [...options.hashes],
      windowStart: Math.floor(options.windowStart.getTime() / 1000),
    },
    format: "JSONEachRow",
  });
  const rows = await result.json() as {
    occurrences: string | number,
    first_seen_millis: string | number,
    last_seen_millis: string | number,
  }[];
  if (rows.length === 0) return null;
  const row = rows[0];
  const occurrences = BigInt(row.occurrences);
  if (occurrences === 0n) return null;
  return {
    occurrences,
    firstSeenAt: new Date(Number(row.first_seen_millis)),
    lastSeenAt: new Date(Number(row.last_seen_millis)),
  };
}

export function validateUnmergeSubset(owned: readonly string[], requested: readonly string[]): string[] {
  const ownedSet = new Set(owned);
  const unique = [...new Set(requested)];
  if (unique.length === 0) {
    throw new StatusError(StatusError.BadRequest, "Specify at least one hash to split out.");
  }
  const foreign = unique.find((hash) => !ownedSet.has(hash));
  if (foreign !== undefined) {
    throw new StatusError(StatusError.BadRequest, `Hash ${foreign} is not owned by this issue.`);
  }
  if (unique.length >= ownedSet.size) {
    throw new StatusError(StatusError.BadRequest, "Splitting out every hash would leave the issue empty; there is nothing to unmerge.");
  }
  return unique;
}

export async function unmergeIssue(options: {
  tenancy: Tenancy,
  issueId: string,
  hashes: string[],
}): Promise<UnmergeIssueResult> {
  const { tenancy, issueId, hashes } = options;
  const prisma = await getPrismaClientForTenancy(tenancy);
  const tenancyId = tenancy.id;
  const now = new Date();

  const resolvedIds = [...(await resolveIssueIds(prisma, tenancyId, [issueId])).values()];
  const sourceId = resolvedIds.length === 0 ? issueId : resolvedIds[0];

  const preLockRows = await readIssuesWithHashes(prisma, tenancyId, [sourceId]);
  if (preLockRows.length === 0) {
    throw new StatusError(StatusError.NotFound, `Issue ${issueId} was not found in this project.`);
  }
  const preLock = preLockRows[0];
  validateUnmergeSubset(preLock.hashes, hashes);

  const lockedHashes = preLock.hashes;

  return await withHashLocks(prisma, tenancyId, lockedHashes, now, async () => {
    const sourceRows = await readIssuesWithHashes(prisma, tenancyId, [sourceId]);
    if (sourceRows.length === 0) {
      throw new StatusError(StatusError.NotFound, `Issue ${issueId} was not found in this project.`);
    }
    const source = sourceRows[0];
    const movedHashes = validateUnmergeSubset(source.hashes, hashes);

    const countersTruncatedAt = new Date(now.getTime() - ISSUE_COUNTER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const windowed = await readWindowedCountersForHashes({
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      hashes: movedHashes,
      windowStart: countersTruncatedAt,
    });

    const created = await applyUnmerge(prisma, {
      tenancyId,
      source,
      movedHashes,
      lockedHashes,
      assignedTeamId: source.assignedTeamId ?? getBillingTeamId(tenancy.project),
      timesSeen: windowed?.occurrences ?? 0n,
      firstSeenAt: windowed?.firstSeenAt ?? now,
      lastSeenAt: windowed?.lastSeenAt ?? now,
      countersTruncatedAt,
      now,
    });

    return {
      sourceIssueId: source.id,
      newIssueId: created.id,
      newIssueShortId: created.shortId,
      countersTruncatedAt,
    };
  });
}

async function applyUnmerge(
  prisma: TenancyPrismaClient,
  options: {
    tenancyId: string,
    source: IssueRow,
    movedHashes: readonly string[],
    lockedHashes: readonly string[],
    assignedTeamId: string | null,
    timesSeen: bigint,
    firstSeenAt: Date,
    lastSeenAt: Date,
    countersTruncatedAt: Date,
    now: Date,
  },
): Promise<{ id: string, shortId: bigint }> {
  const { tenancyId, source, movedHashes, lockedHashes, assignedTeamId, timesSeen, firstSeenAt, lastSeenAt, countersTruncatedAt, now } = options;
  const rows = await prisma.$queryRaw<{ id: string, shortId: bigint, reboundHashes: number }[]>(Prisma.sql`
    WITH lease AS (
      -- Locked, not merely read — same reasoning as applyMerge's lease CTE: a
      -- stale lease stolen mid-statement must fail the whole statement, not
      -- leave a freshly created issue whose hashes a thief already repointed.
      SELECT COUNT(*) = ${lockedHashes.length} AS "held"
      FROM (
        SELECT 1
        FROM "IssueHash"
        WHERE "tenancyId" = ${tenancyId}::uuid
          AND "hash" = ANY(${[...lockedHashes]}::text[])
          AND "state" = 'LOCKED'::"IssueHashState"
          AND "lockedAt" = ${now}::timestamptz
        ORDER BY "hash"
        FOR UPDATE
      ) AS locked_lease_rows
    ),
    counter AS (
      INSERT INTO "IssueCounter" ("tenancyId", "nextShortId")
      SELECT ${tenancyId}::uuid, 2::bigint
      FROM lease
      WHERE "held"
      ON CONFLICT ("tenancyId") DO UPDATE
        SET "nextShortId" = "IssueCounter"."nextShortId" + 1
      RETURNING "nextShortId" - 1 AS "shortId"
    ),
    created AS (
      INSERT INTO "Issue" (
        "id", "tenancyId", "shortId", "type", "value", "culprit", "platform",
        "handled", "synthetic",
        "status", "statusChangedAt", "resolvedAt", "ignoredUntil", "assigneeUserId", "assignedTeamId",
        "firstSeenAt", "lastSeenAt", "timesSeen", "countersTruncatedAt",
        "serviceName", "deploymentEnvironmentName", "firstSeenRelease", "lastSeenRelease",
        "updatedAt"
      )
      SELECT
        gen_random_uuid(), ${tenancyId}::uuid, c."shortId",
        ${source.type}, ${source.value}, ${source.culprit}, ${source.platform},
        ${source.handled}::boolean, ${source.synthetic}::boolean,
        ${source.status}::"IssueStatus", ${source.statusChangedAt}::timestamptz,
        ${source.resolvedAt}::timestamptz, ${source.ignoredUntil}::timestamptz,
        ${source.assigneeUserId}::uuid, ${assignedTeamId}::uuid,
        ${firstSeenAt}::timestamptz, ${lastSeenAt}::timestamptz,
        ${timesSeen.toString()}::bigint, ${countersTruncatedAt}::timestamptz,
        ${source.serviceName}, ${source.deploymentEnvironmentName},
        ${source.firstSeenRelease}, ${source.lastSeenRelease},
        ${now}::timestamptz
      FROM counter c, lease l
      WHERE l."held"
      RETURNING "id", "shortId"
    ),
    rebound AS (
      UPDATE "IssueHash" h
      SET "issueId" = CASE
            WHEN h."hash" = ANY(${[...movedHashes]}::text[]) THEN (SELECT "id" FROM created)
            ELSE h."issueId"
          END,
          "state" = NULL,
          "lockedAt" = NULL
      WHERE h."tenancyId" = ${tenancyId}::uuid
        AND h."hash" = ANY(${[...lockedHashes]}::text[])
        AND h."state" = 'LOCKED'::"IssueHashState"
        AND h."lockedAt" = ${now}::timestamptz
        AND EXISTS (SELECT 1 FROM created)
      RETURNING h."hash"
    )
    SELECT c."id", c."shortId", (SELECT COUNT(*)::int FROM rebound) AS "reboundHashes"
    FROM created c
  `);
  if (rows.length === 0) {
    throw new StatusError(StatusError.Conflict, "The issue changed while the unmerge was running. Try again.");
  }
  const row = rows[0];
  return { id: row.id, shortId: row.shortId };
}
