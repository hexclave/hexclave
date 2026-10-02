import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyIssueOccurrenceLifecycle,
  assignIssue,
  deriveIssueOccurrenceTransition,
  deriveIssueStatusTransition,
  type IssueLifecycleState,
  IssueNotFoundError,
  parseIssueLifecycleStatus,
  transitionIssueStatus,
} from "./issue-lifecycle";

const TEST_PREFIX = `issue-lifecycle-${randomUUID()}`;
let ACTOR_USER_ID: string;
let ASSIGNEE_USER_ID: string;
const TEAM_ID = "00000000-0000-4000-8000-000000000003";

const unresolvedState: IssueLifecycleState = {
  status: "unresolved",
  statusChangedAt: null,
  resolvedAt: null,
  ignoredUntil: null,
  regressedAt: null,
  assigneeUserId: null,
};

describe("issue lifecycle transition contracts", () => {
  it("accepts the stored statuses and rejects unknown values", () => {
    expect(parseIssueLifecycleStatus("resolved")).toBe("resolved");
    expect(() => parseIssueLifecycleStatus("pending")).toThrow(/status must be/);
  });

  it("preserves the resolve timestamp when manually reopening an issue", () => {
    const resolvedAt = new Date("2026-08-06T12:00:00.000Z");
    const resolved = deriveIssueStatusTransition({
      current: unresolvedState,
      mutation: { status: "resolved" },
      at: resolvedAt,
    });
    const reopened = deriveIssueStatusTransition({
      current: resolved,
      mutation: { status: "unresolved" },
      at: new Date("2026-08-06T12:01:00.000Z"),
    });

    expect(resolved.kind).toBe("status_changed");
    expect(reopened.kind).toBe("status_changed");
    expect(reopened.resolvedAt).toEqual(resolvedAt);
    expect(reopened.ignoredUntil).toBeNull();
  });

  it("does not regress on a same-millisecond occurrence, but regresses after it", () => {
    const resolvedAt = new Date("2026-08-06T12:00:00.000Z");
    const resolved: IssueLifecycleState = {
      ...unresolvedState,
      status: "resolved",
      statusChangedAt: resolvedAt,
      resolvedAt,
    };

    expect(deriveIssueOccurrenceTransition({ current: resolved, receivedAt: resolvedAt }).kind)
      .toBe("occurrence_unchanged");
    const regression = deriveIssueOccurrenceTransition({
      current: resolved,
      receivedAt: new Date("2026-08-06T12:00:00.001Z"),
    });
    expect(regression.kind).toBe("regressed");
    expect(regression.status).toBe("unresolved");
    expect(regression.regressedAt).toEqual(new Date("2026-08-06T12:00:00.001Z"));
  });

  it("reopens only an expired time-bounded ignore", () => {
    const ignoredUntil = new Date("2026-08-06T12:10:00.000Z");
    const ignored: IssueLifecycleState = {
      ...unresolvedState,
      status: "ignored",
      statusChangedAt: new Date("2026-08-06T12:00:00.000Z"),
      ignoredUntil,
    };

    expect(deriveIssueOccurrenceTransition({ current: ignored, receivedAt: ignoredUntil }).kind)
      .toBe("occurrence_unchanged");
    expect(deriveIssueOccurrenceTransition({
      current: ignored,
      receivedAt: new Date("2026-08-06T12:10:00.001Z"),
    }).kind).toBe("reopened");
    expect(deriveIssueOccurrenceTransition({
      current: { ...ignored, ignoredUntil: null },
      receivedAt: new Date("2026-08-07T12:00:00.000Z"),
    }).kind).toBe("occurrence_unchanged");
  });
});

let tenancy: Tenancy;
let otherTenancy: Tenancy | null = null;
const createdIssueIds: Array<{ tenancyId: string, issueId: string }> = [];

async function createTestIssue(target: Tenancy = tenancy): Promise<string> {
  const prisma = await getPrismaClientForTenancy(target);
  const hash = `${TEST_PREFIX}-${randomUUID()}`;
  const [{ shortId }] = await prisma.$queryRaw<{ shortId: bigint }[]>`
    INSERT INTO "IssueCounter" ("tenancyId", "nextShortId")
    VALUES (${target.id}::uuid, 2::bigint)
    ON CONFLICT ("tenancyId") DO UPDATE
      SET "nextShortId" = "IssueCounter"."nextShortId" + 1
    RETURNING "nextShortId" - 1 AS "shortId"
  `;
  const issueId = randomUUID();
  const firstSeenAt = new Date("2026-08-06T11:00:00.000Z");
  await prisma.issue.create({
    data: {
      id: issueId,
      tenancyId: target.id,
      shortId,
      type: "TypeError",
      value: `${TEST_PREFIX}-value`,
      culprit: "test.ts in test",
      platform: "javascript",
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      timesSeen: 1n,
    },
  });
  await prisma.$executeRaw`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${target.id}::uuid, ${hash}, ${issueId}::uuid, 'test:issue-lifecycle', 'PRIMARY', 'app', '[]'::jsonb)
  `;
  createdIssueIds.push({ tenancyId: target.id, issueId });
  return issueId;
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
  if (first === undefined) throw new Error("Issue lifecycle integration tests need a seeded tenancy.");
  const resolved = await getTenancy(first.id);
  if (resolved === null) throw new Error("The primary test tenancy disappeared.");
  tenancy = resolved;
  const users = await globalPrismaClient.projectUser.findMany({
    where: { tenancyId: tenancy.id },
    orderBy: { projectUserId: "asc" },
    take: 2,
    select: { projectUserId: true },
  });
  const actor = users.at(0);
  const assignee = users.at(1);
  if (actor === undefined || assignee === undefined) throw new Error("Issue lifecycle integration tests need a tenancy with two users.");
  ACTOR_USER_ID = actor.projectUserId;
  ASSIGNEE_USER_ID = assignee.projectUserId;
  const second = rows.at(1);
  if (second !== undefined) otherTenancy = await getTenancy(second.id);
});

afterAll(async () => {
  for (const created of createdIssueIds) {
    const target = created.tenancyId === tenancy.id ? tenancy : otherTenancy;
    if (target === null) continue;
    const prisma = await getPrismaClientForTenancy(target);
    await prisma.issue.deleteMany({ where: { tenancyId: created.tenancyId, id: created.issueId } });
  }
});

describe("tenant-scoped persisted issue lifecycle", () => {
  it("assigns, reassigns, and unassigns through the existing assignee column", async () => {
    const issueId = await createTestIssue();
    const assigned = await assignIssue({
      tenancy,
      issueId,
      assigneeUserId: ASSIGNEE_USER_ID,
      actorUserId: ACTOR_USER_ID,
      changedAt: new Date("2026-08-06T12:00:00.000Z"),
    });
    expect(assigned).toMatchObject({
      tenancyId: tenancy.id,
      issueId,
      previousAssigneeUserId: null,
      assigneeUserId: ASSIGNEE_USER_ID,
      actorUserId: ACTOR_USER_ID,
      changed: true,
    });

    const repeated = await assignIssue({
      tenancy,
      issueId,
      assigneeUserId: ASSIGNEE_USER_ID,
      changedAt: new Date("2026-08-06T12:01:00.000Z"),
    });
    expect(repeated.changed).toBe(false);

    const unassigned = await assignIssue({
      tenancy,
      issueId,
      assigneeUserId: null,
      changedAt: new Date("2026-08-06T12:02:00.000Z"),
    });
    expect(unassigned).toMatchObject({ previousAssigneeUserId: ASSIGNEE_USER_ID, assigneeUserId: null, changed: true });
  });

  it("persists status transitions and regression reopening atomically", async () => {
    const issueId = await createTestIssue();
    const resolvedAt = new Date("2026-08-06T12:00:00.000Z");
    const resolved = await transitionIssueStatus({
      tenancy,
      issueId,
      mutation: { status: "resolved" },
      changedAt: resolvedAt,
    });
    expect(resolved.kind).toBe("status_changed");
    expect(resolved.current.status).toBe("resolved");

    const sameMillisecond = await applyIssueOccurrenceLifecycle({ tenancy, issueId, receivedAt: resolvedAt });
    expect(sameMillisecond.kind).toBe("occurrence_unchanged");

    const regressedAt = new Date("2026-08-06T12:00:00.001Z");
    const regressed = await applyIssueOccurrenceLifecycle({ tenancy, issueId, receivedAt: regressedAt });
    expect(regressed.kind).toBe("regressed");
    expect(regressed.current.status).toBe("unresolved");
    expect(regressed.current.regressedAt).toEqual(regressedAt);

    const ignoredUntil = new Date("2026-08-06T12:10:00.000Z");
    await transitionIssueStatus({
      tenancy,
      issueId,
      mutation: { status: "ignored", ignoredUntil },
      changedAt: new Date("2026-08-06T12:05:00.000Z"),
    });
    expect((await applyIssueOccurrenceLifecycle({ tenancy, issueId, receivedAt: ignoredUntil })).kind)
      .toBe("occurrence_unchanged");
    expect((await applyIssueOccurrenceLifecycle({
      tenancy,
      issueId,
      receivedAt: new Date("2026-08-06T12:10:00.001Z"),
    })).kind).toBe("reopened");
  });

  it("does not allow a tenant to mutate another tenant's issue", async () => {
    if (otherTenancy === null) return;
    const foreignIssueId = await createTestIssue(otherTenancy);
    await expect(assignIssue({
      tenancy,
      issueId: foreignIssueId,
      assigneeUserId: ASSIGNEE_USER_ID,
    })).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});
