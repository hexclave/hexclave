import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IssueBatchDelta } from "./issue-materialization-contract";
import { deleteFromIssueOccurrenceRollup } from "./issue-rollup-storage";
import { materializeIssuesFromBatch } from "./issue-store";
import { DEFAULT_GROUPING_CONFIG_ID } from "./grouping-config";
import {
  ISSUE_COUNTER_WINDOW_DAYS,
  ISSUE_LOCK_LEASE_MS,
  mergeIssues,
  orderIssuesForMerge,
  resolveMergedMetadata,
  unmergeIssue,
  validateUnmergeSubset,
} from "./issue-merge";


describe("orderIssuesForMerge", () => {
  const issue = (id: string, firstSeenAt: string, timesSeen: bigint) => ({
    id, firstSeenAt: new Date(firstSeenAt), timesSeen,
  });

  it("prefers the oldest issue, which is the one carrying the most inbound links", () => {
    const ordered = orderIssuesForMerge([
      issue("b", "2026-02-01T00:00:00Z", 1000n),
      issue("a", "2026-01-01T00:00:00Z", 1n),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("breaks a firstSeenAt tie by timesSeen DESC, then by id ASC", () => {
    const ordered = orderIssuesForMerge([
      issue("c", "2026-01-01T00:00:00Z", 5n),
      issue("a", "2026-01-01T00:00:00Z", 5n),
      issue("b", "2026-01-01T00:00:00Z", 9n),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("compares timesSeen as BigInt, so the busiest issues still order deterministically", () => {
    const big = 9007199254740993n;
    const bigger = 9007199254740995n;
    const ordered = orderIssuesForMerge([
      issue("z", "2026-01-01T00:00:00Z", big),
      issue("a", "2026-01-01T00:00:00Z", bigger),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["a", "z"]);
  });

  it("does not mutate its input", () => {
    const input = [issue("b", "2026-02-01T00:00:00Z", 1n), issue("a", "2026-01-01T00:00:00Z", 1n)];
    orderIssuesForMerge(input);
    expect(input.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("resolveMergedMetadata", () => {
  it("takes the primary's value when it has one", () => {
    expect(resolveMergedMetadata([
      { assigneeUserId: "primary-user", firstSeenRelease: "1.0.0", lastSeenRelease: "1.2.0" },
      { assigneeUserId: "loser-user", firstSeenRelease: "0.9.0", lastSeenRelease: "0.9.1" },
    ])).toEqual({ assigneeUserId: "primary-user", firstSeenRelease: "1.0.0", lastSeenRelease: "1.2.0" });
  });

  it("falls through to the first non-null in merge order", () => {
    expect(resolveMergedMetadata([
      { assigneeUserId: null, firstSeenRelease: null, lastSeenRelease: null },
      { assigneeUserId: null, firstSeenRelease: "0.9.0", lastSeenRelease: null },
      { assigneeUserId: "third-user", firstSeenRelease: "0.8.0", lastSeenRelease: "0.8.1" },
    ])).toEqual({ assigneeUserId: "third-user", firstSeenRelease: "0.9.0", lastSeenRelease: "0.8.1" });
  });
});

describe("validateUnmergeSubset", () => {
  it("accepts a strict, non-empty subset and de-duplicates it", () => {
    expect(validateUnmergeSubset(["a", "b", "c"], ["b", "b"])).toEqual(["b"]);
  });

  it("rejects an empty selection", () => {
    expect(() => validateUnmergeSubset(["a", "b"], [])).toThrow(/at least one hash/);
  });

  it("rejects a hash the issue does not own", () => {
    expect(() => validateUnmergeSubset(["a", "b"], ["c"])).toThrow(/not owned/);
  });

  it("rejects splitting out every hash, which would leave the issue empty", () => {
    expect(() => validateUnmergeSubset(["a", "b"], ["a", "b"])).toThrow(/nothing to unmerge/);
  });
});


const RUN_PREFIX = `test-issue-merge-${randomUUID()}`;
let hashCounter = 0;
const freshHash = () => `${RUN_PREFIX}-${hashCounter++}`;

let tenancy: Tenancy;
let otherTenancy: Tenancy;
const createdIssueIds: string[] = [];
const createdBatchIds: string[] = [];

type SeedOptions = {
  firstSeenAt?: Date,
  lastSeenAt?: Date,
  timesSeen?: bigint,
  hashes?: string[],
  assigneeUserId?: string | null,
  firstSeenRelease?: string | null,
  lastSeenRelease?: string | null,
  handled?: boolean,
  synthetic?: boolean,
  tenancy?: Tenancy,
};

async function seedIssue(options: SeedOptions = {}): Promise<{ id: string, shortId: bigint, hashes: string[] }> {
  const target = options.tenancy ?? tenancy;
  const prisma = await getPrismaClientForTenancy(target);
  const hashes = options.hashes ?? [freshHash()];
  const firstSeenAt = options.firstSeenAt ?? new Date("2026-01-01T00:00:00Z");
  const lastSeenAt = options.lastSeenAt ?? firstSeenAt;

  const [{ shortId }] = await prisma.$queryRaw<{ shortId: bigint }[]>`
    INSERT INTO "IssueCounter" ("tenancyId", "nextShortId")
    VALUES (${target.id}::uuid, 2::bigint)
    ON CONFLICT ("tenancyId") DO UPDATE SET "nextShortId" = "IssueCounter"."nextShortId" + 1
    RETURNING "nextShortId" - 1 AS "shortId"
  `;

  const issueId = randomUUID();
  const [{ id }] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "Issue" (
      "id", "tenancyId", "shortId", "type", "value", "culprit", "platform",
      "handled", "synthetic",
      "firstSeenAt", "lastSeenAt", "timesSeen",
      "assigneeUserId", "firstSeenRelease", "lastSeenRelease", "updatedAt"
    ) VALUES (
      ${issueId}::uuid, ${target.id}::uuid, ${shortId.toString()}::bigint,
      'TypeError', 'x is not a function', 'app/page.tsx in render', 'javascript',
      ${options.handled ?? true}::boolean, ${options.synthetic ?? false}::boolean,
      ${firstSeenAt}::timestamptz, ${lastSeenAt}::timestamptz, ${(options.timesSeen ?? 0n).toString()}::bigint,
      ${options.assigneeUserId ?? null}::uuid, ${options.firstSeenRelease ?? null}, ${options.lastSeenRelease ?? null},
      NOW()
    )
    RETURNING "id"
  `;
  createdIssueIds.push(id);

  await prisma.$executeRaw`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    SELECT ${target.id}::uuid, h, ${id}::uuid, 'hexclave-js:2026-08-01', 'PRIMARY', 'app', '[]'::jsonb
    FROM unnest(${hashes}::text[]) AS h
  `;

  return { id, shortId, hashes };
}

type IssueSnapshot = {
  id: string, timesSeen: bigint, firstSeenAt: Date, lastSeenAt: Date,
  countersTruncatedAt: Date | null, assigneeUserId: string | null,
  firstSeenRelease: string | null, lastSeenRelease: string | null,
  handled: boolean, synthetic: boolean, status: string,
};

async function readIssue(issueId: string, target: Tenancy = tenancy): Promise<IssueSnapshot | null> {
  const prisma = await getPrismaClientForTenancy(target);
  const rows = await prisma.$queryRaw<IssueSnapshot[]>`
    SELECT "id", "timesSeen", "firstSeenAt", "lastSeenAt", "countersTruncatedAt",
           "assigneeUserId", "firstSeenRelease", "lastSeenRelease",
           "handled", "synthetic", "status"::text AS "status"
    FROM "Issue" WHERE "tenancyId" = ${target.id}::uuid AND "id" = ${issueId}::uuid
  `;
  return rows.at(0) ?? null;
}

async function readOwnedHashes(issueId: string): Promise<string[]> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$queryRaw<{ hash: string }[]>`
    SELECT "hash" FROM "IssueHash"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "issueId" = ${issueId}::uuid
    ORDER BY "hash"
  `;
  return rows.map((row) => row.hash);
}

async function readHashOwner(hash: string): Promise<string | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$queryRaw<{ issueId: string }[]>`
    SELECT "issueId"
    FROM "IssueHash"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "hash" = ${hash}
  `;
  return rows.at(0)?.issueId ?? null;
}

function materializationInput(ownerHash: string, count = 1): IssueBatchDelta {
  const eventAt = new Date("2026-08-06T12:00:00Z");
  return {
    ownerHash,
    aliasHashes: [],
    groupingConfigId: DEFAULT_GROUPING_CONFIG_ID,
    groupingProvenance: [{
      hash: ownerHash,
      role: "primary",
      configId: DEFAULT_GROUPING_CONFIG_ID,
      variant: "app",
      fingerprint: { type: "default", source: "default", tokens: [], resolvedTokens: [] },
    }],
    type: "TypeError",
    value: "x is not a function",
    culprit: "app/page.tsx in render",
    platform: "javascript",
    count,
    firstEventAt: eventAt,
    lastEventAt: eventAt,
    serviceName: "test-service",
    deploymentEnvironmentName: "test",
    release: "test-release",
    level: "error",
    handled: true,
    synthetic: false,
  };
}

async function readRedirectTarget(fromIssueId: string): Promise<string | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$queryRaw<{ toIssueId: string }[]>`
    SELECT "toIssueId" FROM "IssueRedirect"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "fromIssueId" = ${fromIssueId}::uuid
  `;
  return rows.at(0)?.toIssueId ?? null;
}

async function setHashLock(hash: string, lockedAt: Date | null): Promise<void> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  await prisma.$executeRaw`
    UPDATE "IssueHash"
    SET "state" = ${lockedAt === null ? null : "LOCKED"}::"IssueHashState", "lockedAt" = ${lockedAt}::timestamptz
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "hash" = ${hash}
  `;
}

async function readHashState(hash: string): Promise<{ state: string | null, lockedAt: Date | null } | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$queryRaw<{ state: string | null, lockedAt: Date | null }[]>`
    SELECT "state"::text AS "state", "lockedAt" FROM "IssueHash"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "hash" = ${hash}
  `;
  return rows.at(0) ?? null;
}

beforeAll(async () => {
  const rows = await globalPrismaClient.$queryRaw<Array<{ id: string }>>`
    SELECT t."id"::text AS "id"
    FROM "Tenancy" t
    LEFT JOIN "ProjectUser" u ON u."tenancyId" = t."id"
    GROUP BY t."id"
    ORDER BY count(u."projectUserId") DESC, t."id" ASC
    LIMIT 2
  `;
  const first = rows.at(0);
  const second = rows.at(1);
  if (first === undefined || second === undefined) {
    throw new Error("These tests need at least two tenancies in the development database; run `pnpm db:seed`.");
  }
  const resolvedFirst = await getTenancy(first.id);
  const resolvedSecond = await getTenancy(second.id);
  if (resolvedFirst === null || resolvedSecond === null) throw new Error("Tenancy disappeared between the two reads.");
  tenancy = resolvedFirst;
  otherTenancy = resolvedSecond;
});

afterAll(async () => {
  if (createdBatchIds.length > 0) {
    await globalPrismaClient.$executeRaw`
      DELETE FROM "IssueMaterialization"
      WHERE "tenancyId" = ${tenancy.id}::uuid AND "batchId"::text = ANY(${createdBatchIds}::text[])
    `;
  }
  if (createdIssueIds.length === 0) return;
  await globalPrismaClient.issueRedirect.deleteMany({
    where: { OR: [{ fromIssueId: { in: createdIssueIds } }, { toIssueId: { in: createdIssueIds } }] },
  });
  await globalPrismaClient.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  await globalPrismaClient.issueHash.deleteMany({ where: { hash: { startsWith: RUN_PREFIX } } });
});

describe("mergeIssues (real DB)", () => {
  it("picks the primary by (firstSeenAt, -timesSeen, id) rather than by caller order", async () => {
    const older = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await seedIssue({ firstSeenAt: new Date("2026-03-01T00:00:00Z") });

    const result = await mergeIssues({ tenancy, issueIds: [newer.id, older.id] });

    expect(result.primaryIssueId).toBe(older.id);
    expect(result.mergedIssueIds).toEqual([newer.id]);
    expect(await readIssue(newer.id)).toBeNull();
  });

  it("folds LIFETIME counters by summing the Postgres values, never by snapshotting ClickHouse", async () => {
    const older = await seedIssue({
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-01-05T00:00:00Z"),
      timesSeen: 10n,
    });
    const newer = await seedIssue({
      firstSeenAt: new Date("2026-02-01T00:00:00Z"),
      lastSeenAt: new Date("2026-04-01T00:00:00Z"),
      timesSeen: 5n,
    });

    await mergeIssues({ tenancy, issueIds: [older.id, newer.id] });

    const primary = await readIssue(older.id);
    expect(primary?.timesSeen).toBe(15n);
    expect(primary?.firstSeenAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(primary?.lastSeenAt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("moves every loser hash onto the primary and clears the lease", async () => {
    const older = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z"), hashes: [freshHash(), freshHash()] });
    const newer = await seedIssue({ firstSeenAt: new Date("2026-03-01T00:00:00Z"), hashes: [freshHash()] });

    await mergeIssues({ tenancy, issueIds: [older.id, newer.id] });

    expect(await readOwnedHashes(older.id)).toEqual([...older.hashes, ...newer.hashes].sort());
    for (const hash of [...older.hashes, ...newer.hashes]) {
      expect(await readHashState(hash)).toEqual({ state: null, lockedAt: null });
    }
  });

  it("takes the primary's assignee and release, falling through to the first non-null in merge order", async () => {
    const assignee = randomUUID();
    const older = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await seedIssue({
      firstSeenAt: new Date("2026-03-01T00:00:00Z"),
      assigneeUserId: assignee,
      firstSeenRelease: "0.9.0",
      lastSeenRelease: "0.9.1",
    });

    await mergeIssues({ tenancy, issueIds: [older.id, newer.id] });

    const primary = await readIssue(older.id);
    expect(primary?.assigneeUserId).toBe(assignee);
    expect(primary?.firstSeenRelease).toBe("0.9.0");
    expect(primary?.lastSeenRelease).toBe("0.9.1");
  });

  it("rewrites inbound redirects instead of chaining them (A->B then B->C)", async () => {
    const a = await seedIssue({ firstSeenAt: new Date("2026-03-01T00:00:00Z") });
    const b = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z") });
    const c = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });

    const first = await mergeIssues({ tenancy, issueIds: [a.id, b.id] });
    expect(first.primaryIssueId).toBe(b.id);
    expect(await readRedirectTarget(a.id)).toBe(b.id);

    const second = await mergeIssues({ tenancy, issueIds: [b.id, c.id] });
    expect(second.primaryIssueId).toBe(c.id);
    expect(await readRedirectTarget(b.id)).toBe(c.id);
    expect(await readRedirectTarget(a.id)).toBe(c.id);
  });

  it("follows a redirect, so merging an already-merged id targets its survivor", async () => {
    const a = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z") });
    const b = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    const c = await seedIssue({ firstSeenAt: new Date("2026-03-01T00:00:00Z") });

    await mergeIssues({ tenancy, issueIds: [a.id, b.id] });

    const second = await mergeIssues({ tenancy, issueIds: [a.id, c.id] });
    expect(second.primaryIssueId).toBe(b.id);
    expect(second.mergedIssueIds).toEqual([c.id]);
    expect(await readRedirectTarget(a.id)).toBe(b.id);
  });

  it("rejects a merge whose ids all collapse onto the same issue", async () => {
    const a = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z") });
    const b = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    await mergeIssues({ tenancy, issueIds: [a.id, b.id] });

    await expect(mergeIssues({ tenancy, issueIds: [a.id, b.id] })).resolves.toEqual({
      primaryIssueId: b.id,
      mergedIssueIds: [],
    });
  });

  it("is safe to retry concurrently: one merge wins and the other is a no-op", async () => {
    const older = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z"), timesSeen: 2n });
    const newer = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z"), timesSeen: 3n });

    const results = await Promise.all([
      mergeIssues({ tenancy, issueIds: [older.id, newer.id] }),
      mergeIssues({ tenancy, issueIds: [older.id, newer.id] }),
    ]);

    expect(results.every((result) => result.primaryIssueId === older.id)).toBe(true);
    expect((await readIssue(older.id))?.timesSeen).toBe(5n);
    expect(await readIssue(newer.id)).toBeNull();
  });

  it("preserves a non-conflicting comment retry key while moving it", async () => {
    const older = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z") });
    const author = await globalPrismaClient.projectUser.findFirst({
      where: { tenancyId: tenancy.id },
      select: { projectUserId: true },
    });
    if (author === null) throw new Error("Issue merge tests need a project user for comment coverage");
    await globalPrismaClient.issueComment.create({
      data: {
        tenancyId: tenancy.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        issueId: newer.id,
        authorUserId: author.projectUserId,
        body: "retry-stable merge comment",
        idempotencyKey: "merge-comment-retry-key",
      },
    });

    await mergeIssues({ tenancy, issueIds: [older.id, newer.id] });

    const moved = await globalPrismaClient.issueComment.findFirst({
      where: { tenancyId: tenancy.id, issueId: older.id, body: "retry-stable merge comment" },
      select: { idempotencyKey: true },
    });
    expect(moved?.idempotencyKey).toBe("merge-comment-retry-key");
  });

  it("keeps one loser bookmark when duplicate loser bookmarks merge without a primary bookmark", async () => {
    const primary = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z") });
    const loserOne = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z") });
    const loserTwo = await seedIssue({ firstSeenAt: new Date("2026-03-01T00:00:00Z") });
    const user = await globalPrismaClient.projectUser.findFirst({
      where: { tenancyId: tenancy.id },
      select: { projectUserId: true },
    });
    if (user === null) throw new Error("Issue merge tests need a project user for bookmark coverage");
    await globalPrismaClient.issueBookmark.createMany({
      data: [loserOne.id, loserTwo.id].map((issueId) => ({
        tenancyId: tenancy.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        issueId,
        userId: user.projectUserId,
      })),
    });

    await mergeIssues({ tenancy, issueIds: [primary.id, loserOne.id, loserTwo.id] });

    expect(await globalPrismaClient.issueBookmark.count({
      where: { tenancyId: tenancy.id, issueId: primary.id, userId: user.projectUserId },
    })).toBe(1);
  });

  it("requires at least two distinct issues", async () => {
    const a = await seedIssue();
    await expect(mergeIssues({ tenancy, issueIds: [a.id, a.id] })).rejects.toThrow(/at least two distinct/);
  });

  it("409s when a hash is held by a fresh lease, and leaves the merge untouched", async () => {
    const a = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z"), timesSeen: 3n });
    const b = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z"), timesSeen: 7n });
    await setHashLock(b.hashes[0]!, new Date());

    await expect(mergeIssues({ tenancy, issueIds: [a.id, b.id] })).rejects.toMatchObject({ statusCode: 409 });

    expect((await readIssue(a.id))?.timesSeen).toBe(3n);
    expect(await readIssue(b.id)).not.toBeNull();
    expect((await readHashState(a.hashes[0]!))?.state).toBeNull();
  });

  it("steals a stale lease, so a crashed merge recovers on its own", async () => {
    const a = await seedIssue({ firstSeenAt: new Date("2026-01-01T00:00:00Z"), timesSeen: 3n });
    const b = await seedIssue({ firstSeenAt: new Date("2026-02-01T00:00:00Z"), timesSeen: 7n });
    await setHashLock(b.hashes[0]!, new Date(Date.now() - ISSUE_LOCK_LEASE_MS - 60_000));

    const result = await mergeIssues({ tenancy, issueIds: [a.id, b.id] });

    expect(result.primaryIssueId).toBe(a.id);
    expect((await readIssue(a.id))?.timesSeen).toBe(10n);
  });

  it("cannot reach an issue in another tenancy", async () => {
    const mine = await seedIssue();
    const theirs = await seedIssue({ tenancy: otherTenancy });

    await expect(mergeIssues({ tenancy, issueIds: [mine.id, theirs.id] }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(await readIssue(theirs.id, otherTenancy)).not.toBeNull();
  });
});

describe("unmergeIssue (real DB)", () => {
  it("splits the selected hashes into a new issue and leaves the rest behind", async () => {
    const hashes = [freshHash(), freshHash(), freshHash()].sort();
    const source = await seedIssue({ hashes, timesSeen: 42n });

    const result = await unmergeIssue({ tenancy, issueId: source.id, hashes: [hashes[0]!] });

    createdIssueIds.push(result.newIssueId);
    expect(result.sourceIssueId).toBe(source.id);
    expect(await readOwnedHashes(result.newIssueId)).toEqual([hashes[0]]);
    expect(await readOwnedHashes(source.id)).toEqual([hashes[1], hashes[2]]);
  });

  it("sets countersTruncatedAt to the start of the retained window, and does not touch the source's counters", async () => {
    const hashes = [freshHash(), freshHash()].sort();
    const source = await seedIssue({ hashes, timesSeen: 42n });

    const before = Date.now();
    const result = await unmergeIssue({ tenancy, issueId: source.id, hashes: [hashes[0]!] });
    createdIssueIds.push(result.newIssueId);

    const windowMs = ISSUE_COUNTER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(result.countersTruncatedAt.getTime()).toBeGreaterThanOrEqual(before - windowMs - 5_000);
    expect(result.countersTruncatedAt.getTime()).toBeLessThanOrEqual(Date.now() - windowMs + 5_000);

    const created = await readIssue(result.newIssueId);
    expect(created?.countersTruncatedAt).not.toBeNull();
    expect((await readIssue(source.id))?.timesSeen).toBe(42n);
  });

  it("inherits the source's display identity and mechanism facts", async () => {
    const hashes = [freshHash(), freshHash()].sort();
    const source = await seedIssue({ hashes, handled: false, synthetic: true });

    const result = await unmergeIssue({ tenancy, issueId: source.id, hashes: [hashes[0]!] });
    createdIssueIds.push(result.newIssueId);

    const created = await readIssue(result.newIssueId);
    expect(created?.handled).toBe(false);
    expect(created?.synthetic).toBe(true);
    expect(created?.status).toBe("UNRESOLVED");
  });

  it("clears the lease on every hash it locked, moved or not", async () => {
    const hashes = [freshHash(), freshHash(), freshHash()].sort();
    const source = await seedIssue({ hashes });

    const result = await unmergeIssue({ tenancy, issueId: source.id, hashes: [hashes[0]!] });
    createdIssueIds.push(result.newIssueId);

    for (const hash of hashes) {
      expect(await readHashState(hash)).toEqual({ state: null, lockedAt: null });
    }
  });

  it("rejects splitting out every hash", async () => {
    const hashes = [freshHash(), freshHash()].sort();
    const source = await seedIssue({ hashes });
    await expect(unmergeIssue({ tenancy, issueId: source.id, hashes }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("409s while a hash is held by a fresh lease", async () => {
    const hashes = [freshHash(), freshHash()].sort();
    const source = await seedIssue({ hashes });
    await setHashLock(hashes[1]!, new Date());

    await expect(unmergeIssue({ tenancy, issueId: source.id, hashes: [hashes[0]!] }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("404s for an issue in another tenancy", async () => {
    const theirs = await seedIssue({ tenancy: otherTenancy, hashes: [freshHash(), freshHash()] });
    await expect(unmergeIssue({ tenancy, issueId: theirs.id, hashes: [theirs.hashes[0]!] }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("materializeIssuesFromBatch (real DB)", () => {
  it("defers the complete batch when one owner hash is locked", async () => {
    const lockedHash = freshHash();
    const missingHash = freshHash();
    const lockedIssue = await seedIssue({ hashes: [lockedHash] });
    await setHashLock(lockedHash, new Date());

    const batchId = randomUUID();
    createdBatchIds.push(batchId);
    const inputs = [materializationInput(lockedHash), materializationInput(missingHash, 2)];

    expect(await materializeIssuesFromBatch({ tenancy, batchId, inputs, receivedAt: new Date() })).toEqual([]);
    expect((await readIssue(lockedIssue.id))?.timesSeen).toBe(0n);
    expect(await readHashOwner(missingHash)).toBeNull();

    await setHashLock(lockedHash, null);
    const outcomes = await materializeIssuesFromBatch({ tenancy, batchId, inputs, receivedAt: new Date() });
    for (const outcome of outcomes) createdIssueIds.push(outcome.issueId);

    expect(outcomes.map((outcome) => outcome.ownerHash).sort()).toEqual([lockedHash, missingHash].sort());
    expect((await readIssue(lockedIssue.id))?.timesSeen).toBe(1n);
    const missingIssueId = await readHashOwner(missingHash);
    expect(missingIssueId).not.toBeNull();
    expect((await readIssue(missingIssueId!))?.timesSeen).toBe(2n);
  });

  it("materializes concurrent first sightings onto one issue without an orphan", async () => {
    const ownerHash = freshHash();
    const firstBatchId = randomUUID();
    const secondBatchId = randomUUID();
    createdBatchIds.push(firstBatchId, secondBatchId);
    const input = materializationInput(ownerHash);

    const [first, second] = await Promise.all([
      materializeIssuesFromBatch({ tenancy, batchId: firstBatchId, inputs: [input], receivedAt: new Date() }),
      materializeIssuesFromBatch({ tenancy, batchId: secondBatchId, inputs: [input], receivedAt: new Date() }),
    ]);
    for (const outcome of [...first, ...second]) createdIssueIds.push(outcome.issueId);

    const issueId = await readHashOwner(ownerHash);
    expect(issueId).not.toBeNull();
    const ownerRows = await globalPrismaClient.$queryRaw<{ id: string }[]>`
      SELECT i."id"
      FROM "Issue" i
      WHERE i."tenancyId" = ${tenancy.id}::uuid
        AND i."id" IN (
          SELECT "issueId" FROM "IssueHash"
          WHERE "tenancyId" = ${tenancy.id}::uuid AND "hash" = ${ownerHash}
        )
    `;
    expect(ownerRows).toHaveLength(1);
    expect((await readIssue(issueId!))?.timesSeen).toBe(2n);
  });
});

describe("unmerge counter seeding (real ClickHouse)", () => {
  const movedHash = `${RUN_PREFIX}-ch-moved`;
  const keptHash = `${RUN_PREFIX}-ch-kept`;

  afterAll(async () => {
    const client = getSharedClickhouseAdminClient();
    await client.command({
      query: `ALTER TABLE analytics_internal.events DELETE WHERE issue_hash IN ({moved:String}, {kept:String})`,
      query_params: { moved: movedHash, kept: keptHash },
    });
    await deleteFromIssueOccurrenceRollup(client, {
      whereSql: "issue_hash IN ({moved:String}, {kept:String})",
      queryParams: { moved: movedHash, kept: keptHash },
    });
  });

  it("seeds the new issue's lifetime counters from the retained window, and occurrences follow their owning hash", async () => {
    const client = getSharedClickhouseAdminClient();
    const eventAt = new Date(Date.now() - 60 * 60 * 1000);
    const batchId = randomUUID();
    await client.insert({
      table: "analytics_internal.events",
      values: [movedHash, movedHash, keptHash].map((issueHash, ordinal) => ({
        event_type: "$error",
        event_at: eventAt,
        message: "x is not a function",
        level: "error",
        data: {},
        producer: "sdk",
        runtime: "browser",
        project_id: tenancy.project.id,
        branch_id: tenancy.branchId,
        occurrence_id: `${batchId}-${ordinal}`,
        batch_id: batchId,
        issue_hash: issueHash,
        issue_hashes: [issueHash],
        issue_grouping_config: "hexclave-js:2026-08-01",
        error_type: "TypeError",
      })),
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort", async_insert: 0 },
    });

    const source = await seedIssue({ hashes: [movedHash, keptHash], timesSeen: 999n });
    const result = await unmergeIssue({ tenancy, issueId: source.id, hashes: [movedHash] });
    createdIssueIds.push(result.newIssueId);

    const created = await readIssue(result.newIssueId);
    expect(created?.timesSeen).toBe(2n);
    expect(created?.countersTruncatedAt).not.toBeNull();

    const newHashes = await readOwnedHashes(result.newIssueId);
    const occurrences = await client.query({
      query: `
        SELECT count() AS n FROM analytics_internal.events
        WHERE project_id = {projectId:String} AND branch_id = {branchId:String}
          AND event_type = '$error' AND issue_hash IN {hashes:Array(String)}
      `,
      query_params: { projectId: tenancy.project.id, branchId: tenancy.branchId, hashes: newHashes },
      format: "JSONEachRow",
    });
    expect(Number((await occurrences.json() as { n: string | number }[]).at(0)?.n)).toBe(2);
  });
});
