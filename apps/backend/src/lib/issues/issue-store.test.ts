import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, getPrismaClientForTenancy } from "@/prisma-client";
import { IssueHashState } from "@/generated/prisma/enums";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeIssuesFromBatch } from "./issue-store";
import type { GroupingHashProvenance } from "./types";

const RUN_PREFIX = "test-issue-store-" + randomUUID();
let tenancy: Tenancy | undefined;
const createdBatchIds: string[] = [];

function getTestTenancy(): Tenancy {
  if (tenancy === undefined) throw new Error("The issue-store test tenancy is not initialized.");
  return tenancy;
}

function makeGroupingProvenance(ownerHash: string, aliasHashes: readonly string[]): GroupingHashProvenance[] {
  const fingerprint = {
    type: "default",
    source: "default",
    tokens: [],
    resolvedTokens: [],
  } as const;
  return [
    {
      hash: ownerHash,
      role: "primary",
      configId: "hexclave-js:2026-08-01",
      variant: "app",
      fingerprint,
    },
    ...aliasHashes.map((hash): GroupingHashProvenance => ({
      hash,
      role: "secondary",
      configId: "hexclave-js:2026-08-01",
      variant: "system",
      fingerprint,
    })),
  ];
}

function makeInput(ownerHash: string, overrides: {
  aliasHashes?: string[],
  value?: string,
} = {}) {
  return {
    ownerHash,
    aliasHashes: overrides.aliasHashes ?? [],
    groupingConfigId: "hexclave-js:2026-08-01" as const,
    groupingProvenance: makeGroupingProvenance(ownerHash, overrides.aliasHashes ?? []),
    type: "TestMaterializationError",
    value: overrides.value ?? RUN_PREFIX + "-" + ownerHash,
    culprit: "issue-store.test.ts in materializer",
    platform: "node",
    count: 1,
    firstEventAt: new Date("2026-08-06T00:00:00Z"),
    lastEventAt: new Date("2026-08-06T00:00:01Z"),
    serviceName: "issue-store-test",
    deploymentEnvironmentName: "test",
    release: "issue-store-test",
    level: "error",
    handled: true,
    synthetic: false,
  };
}

async function allocateShortId(target: Tenancy): Promise<bigint> {
  const prisma = await getPrismaClientForTenancy(target);
  const counter = await prisma.issueCounter.upsert({
    where: { tenancyId: target.id },
    create: { tenancyId: target.id, nextShortId: 2n },
    update: { nextShortId: { increment: 1n } },
    select: { nextShortId: true },
  });
  return counter.nextShortId - 1n;
}

async function seedIssue(hash: string, options: { timesSeen?: bigint, value?: string } = {}): Promise<string> {
  const target = getTestTenancy();
  const prisma = await getPrismaClientForTenancy(target);
  const id = randomUUID();
  const shortId = await allocateShortId(target);
  await prisma.issue.create({
    data: {
      id,
      tenancyId: target.id,
      shortId,
      type: "TestMaterializationError",
      value: options.value ?? RUN_PREFIX + "-" + hash,
      culprit: "issue-store.test.ts in seed",
      platform: "node",
      firstSeenAt: new Date("2026-08-05T00:00:00Z"),
      lastSeenAt: new Date("2026-08-05T00:00:01Z"),
      timesSeen: options.timesSeen ?? 0n,
      serviceName: "issue-store-test",
      deploymentEnvironmentName: "test",
      firstSeenRelease: "issue-store-test",
      lastSeenRelease: "issue-store-test",
    },
  });
  await prisma.issueHash.create({
    data: {
      tenancyId: target.id,
      hash,
      issueId: id,
      groupingConfigId: "hexclave-js:2026-08-01",
      groupingRole: "PRIMARY",
      groupingVariant: "app",
      groupingProvenance: [],
    },
  });
  return id;
}

async function readTimesSeen(issueId: string): Promise<bigint> {
  const prisma = await getPrismaClientForTenancy(getTestTenancy());
  const row = await prisma.issue.findFirst({
    where: { tenancyId: getTestTenancy().id, id: issueId },
    select: { timesSeen: true },
  });
  if (row === null) throw new Error("Issue disappeared during the test.");
  return row.timesSeen;
}

async function readIssueRowsForValue(value: string): Promise<{ id: string, timesSeen: bigint, hashCount: number }[]> {
  const prisma = await getPrismaClientForTenancy(getTestTenancy());
  const rows = await prisma.issue.findMany({
    where: { tenancyId: getTestTenancy().id, value },
    select: { id: true, timesSeen: true, _count: { select: { hashes: true } } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => ({ id: row.id, timesSeen: row.timesSeen, hashCount: row._count.hashes }));
}

async function setHashState(hash: string, state: "LOCKED" | null): Promise<void> {
  const prisma = await getPrismaClientForTenancy(getTestTenancy());
  await prisma.issueHash.updateMany({
    where: { tenancyId: getTestTenancy().id, hash },
    data: {
      state: state === null ? null : IssueHashState.LOCKED,
      lockedAt: state === null ? null : new Date(),
    },
  });
}

beforeAll(async () => {
  const row = await globalPrismaClient.tenancy.findFirst({
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (row === null) throw new Error("The issue-store integration test needs a seeded tenancy.");
  const resolved = await getTenancy(row.id);
  if (resolved === null) throw new Error("The test tenancy disappeared before setup completed.");
  tenancy = resolved;
});

afterAll(async () => {
  if (tenancy === undefined) return;
  const prisma = await getPrismaClientForTenancy(tenancy);
  if (createdBatchIds.length > 0) {
    await prisma.issueMaterialization.deleteMany({
      where: { tenancyId: tenancy.id, batchId: { in: createdBatchIds } },
    });
  }
  await prisma.issueHash.deleteMany({
    where: { tenancyId: tenancy.id, hash: { startsWith: RUN_PREFIX } },
  });
  await prisma.issue.deleteMany({
    where: { tenancyId: tenancy.id, value: { startsWith: RUN_PREFIX } },
  });
});

describe("materializeIssuesFromBatch", () => {
  it("defers the entire batch when any owner hash is locked", async () => {
    const target = getTestTenancy();
    const unlockedHash = RUN_PREFIX + "-unlocked";
    const lockedHash = RUN_PREFIX + "-locked";
    const unlockedIssueId = await seedIssue(unlockedHash, { timesSeen: 5n });
    await seedIssue(lockedHash, { timesSeen: 7n });
    await setHashState(lockedHash, "LOCKED");

    const batchId = randomUUID();
    createdBatchIds.push(batchId);
    const receivedAt = new Date("2026-08-06T12:00:00Z");
    const inputs = [makeInput(unlockedHash), makeInput(lockedHash)];

    expect(await materializeIssuesFromBatch({ tenancy: target, batchId, inputs, receivedAt })).toEqual([]);
    expect(await readTimesSeen(unlockedIssueId)).toBe(5n);

    const prisma = await getPrismaClientForTenancy(target);
    expect(await prisma.issueMaterialization.count({
      where: { tenancyId: target.id, batchId },
    })).toBe(0);

    await setHashState(lockedHash, null);
    const applied = await materializeIssuesFromBatch({ tenancy: target, batchId, inputs, receivedAt });
    expect(applied).toHaveLength(2);
    expect(await readTimesSeen(unlockedIssueId)).toBe(6n);
  });

  it("coalesces concurrent first sightings and removes the losing candidate", async () => {
    const target = getTestTenancy();
    const ownerHash = RUN_PREFIX + "-race-owner";
    const aliasOne = RUN_PREFIX + "-race-alias-one";
    const aliasTwo = RUN_PREFIX + "-race-alias-two";
    const value = RUN_PREFIX + "-race-value";
    const firstBatchId = randomUUID();
    const secondBatchId = randomUUID();
    createdBatchIds.push(firstBatchId, secondBatchId);

    const [first, second] = await Promise.all([
      materializeIssuesFromBatch({
        tenancy: target,
        batchId: firstBatchId,
        inputs: [makeInput(ownerHash, { aliasHashes: [aliasOne], value })],
        receivedAt: new Date("2026-08-06T12:01:00Z"),
      }),
      materializeIssuesFromBatch({
        tenancy: target,
        batchId: secondBatchId,
        inputs: [makeInput(ownerHash, { aliasHashes: [aliasTwo], value })],
        receivedAt: new Date("2026-08-06T12:01:01Z"),
      }),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.issueId).toBe(second[0]?.issueId);
    expect([first[0]?.isNew, second[0]?.isNew].sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
    const rows = await readIssueRowsForValue(value);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timesSeen).toBe(2n);
    expect(rows[0]?.hashCount).toBe(2);

    const repeated = await materializeIssuesFromBatch({
      tenancy: target,
      batchId: firstBatchId,
      inputs: [makeInput(ownerHash, { aliasHashes: [aliasOne], value })],
      receivedAt: new Date("2026-08-06T12:02:00Z"),
    });
    expect(repeated).toEqual(first);
    expect((await readIssueRowsForValue(value))[0]?.timesSeen).toBe(2n);
  });

  it("retains new-issue semantics when creation committed before the batch claim", async () => {
    const target = getTestTenancy();
    const ownerHash = RUN_PREFIX + "-unclaimed-created";
    const issueId = await seedIssue(ownerHash, { timesSeen: 0n });
    const batchId = randomUUID();
    createdBatchIds.push(batchId);

    const [outcome] = await materializeIssuesFromBatch({
      tenancy: target,
      batchId,
      inputs: [makeInput(ownerHash)],
      receivedAt: new Date("2026-08-06T12:02:30Z"),
    });

    expect(outcome).toMatchObject({ issueId, isNew: true });
    expect(await readTimesSeen(issueId)).toBe(1n);
  });

  it("persists primary and secondary grouping provenance supplied by canonical ingest", async () => {
    const target = getTestTenancy();
    const ownerHash = RUN_PREFIX + "-provenance-owner";
    const aliasHash = RUN_PREFIX + "-provenance-alias";
    const batchId = randomUUID();
    createdBatchIds.push(batchId);

    await materializeIssuesFromBatch({
      tenancy: target,
      batchId,
      inputs: [makeInput(ownerHash, { aliasHashes: [aliasHash] })],
      receivedAt: new Date("2026-08-06T12:03:00Z"),
    });

    const prisma = await getPrismaClientForTenancy(target);
    const rows = await prisma.$queryRaw<{
      hash: string,
      groupingRole: string | null,
      groupingVariant: string | null,
      groupingProvenance: unknown,
    }[]>`
      SELECT "hash", "groupingRole"::text AS "groupingRole", "groupingVariant", "groupingProvenance"
      FROM "IssueHash"
      WHERE "tenancyId" = ${target.id}::uuid
        AND "hash" IN (${ownerHash}, ${aliasHash})
      ORDER BY "hash" COLLATE "C"
    `;

    expect(rows).toEqual([
      {
        hash: aliasHash,
        groupingRole: "SECONDARY",
        groupingVariant: "system",
        groupingProvenance: [expect.objectContaining({ hash: aliasHash, role: "secondary" })],
      },
      {
        hash: ownerHash,
        groupingRole: "PRIMARY",
        groupingVariant: "app",
        groupingProvenance: [expect.objectContaining({ hash: ownerHash, role: "primary" })],
      },
    ]);
  });

  it("stamps the project owner team on first sighting", async () => {
    const target = getTestTenancy();
    const ownerHash = RUN_PREFIX + "-owner-team";
    const batchId = randomUUID();
    createdBatchIds.push(batchId);

    const applied = await materializeIssuesFromBatch({
      tenancy: target,
      batchId,
      inputs: [makeInput(ownerHash)],
      receivedAt: new Date("2026-08-06T12:04:00Z"),
    });
    expect(applied).toHaveLength(1);
    const issueId = applied[0].issueId;

    const prisma = await getPrismaClientForTenancy(target);
    const row = await prisma.issue.findUnique({
      where: { tenancyId_id: { tenancyId: target.id, id: issueId } },
      select: { assignedTeamId: true },
    });
    expect(row?.assignedTeamId).toBe(target.project.owner_team_id);
  });
});
