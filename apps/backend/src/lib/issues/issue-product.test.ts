import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addIssueComment,
  appendIssueActivity,
  clearManualIssueOwners,
  listIssueActivity,
  loadIssueProductSnapshot,
  setIssueBookmark,
  setIssueOwner,
  setIssuePriority,
  setIssueSubscription,
} from "./issue-product";
import { assignIssueToTeam } from "./issue-lifecycle";

let tenancy: Tenancy;
let issueId: string;
let userId: string;
let otherUserId: string;
let ownerTeamId: string;

beforeAll(async () => {
  const projects = await globalPrismaClient.project.findMany({
    where: { ownerTeamId: { not: null }, id: { not: "internal" } },
    select: { id: true, ownerTeamId: true },
    orderBy: { id: "asc" },
  });
  let picked: { tenancy: Tenancy, ownerTeamId: string, userIds: [string, string] } | null = null;
  for (const project of projects) {
    if (project.ownerTeamId === null) continue;
    const tenancyRow = await globalPrismaClient.tenancy.findFirst({
      where: { projectId: project.id },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (tenancyRow === null) continue;
    const resolved = await getTenancy(tenancyRow.id);
    if (resolved === null) continue;
    const prisma = await getPrismaClientForTenancy(resolved);
    const users = await prisma.projectUser.findMany({ where: { tenancyId: resolved.id }, select: { projectUserId: true }, take: 2 });
    const user = users.at(0);
    const otherUser = users.at(1);
    if (user === undefined || otherUser === undefined) continue;
    picked = { tenancy: resolved, ownerTeamId: project.ownerTeamId, userIds: [user.projectUserId, otherUser.projectUserId] };
    break;
  }
  if (picked === null) throw new Error("Issue product tests need a seeded owner-team project whose branch has two users.");
  tenancy = picked.tenancy;
  ownerTeamId = picked.ownerTeamId;
  userId = picked.userIds[0];
  otherUserId = picked.userIds[1];
  const prisma = await getPrismaClientForTenancy(tenancy);
  const [{ shortId }] = await prisma.$queryRaw<Array<{ shortId: bigint }>>`
    INSERT INTO "IssueCounter" ("tenancyId", "nextShortId")
    VALUES (${tenancy.id}::uuid, 2::bigint)
    ON CONFLICT ("tenancyId") DO UPDATE SET "nextShortId" = "IssueCounter"."nextShortId" + 1
    RETURNING "nextShortId" - 1 AS "shortId"
  `;
  issueId = randomUUID();
  const seenAt = new Date("2026-08-06T12:00:00.000Z");
  await prisma.issue.create({ data: { id: issueId, tenancyId: tenancy.id, shortId, type: "TypeError", value: `issue-product-${issueId}`, culprit: "issue-product.test.ts", platform: "javascript", firstSeenAt: seenAt, lastSeenAt: seenAt, timesSeen: 1n } });
});

afterAll(async () => {
  const prisma = await getPrismaClientForTenancy(tenancy);
  await prisma.issue.delete({ where: { tenancyId_id: { tenancyId: tenancy.id, id: issueId } } });
});

describe("durable issue product metadata", () => {
  it("persists priority, owner-team assignment, owner, comment, subscription, bookmark, and activity state", async () => {
    const at = new Date("2026-08-06T12:01:00.000Z");
    await expect(setIssuePriority({ tenancy, issueId, priority: "high", actorUserId: userId, occurredAt: at })).resolves.toMatchObject({ previousPriority: null, priority: "high", changed: true });
    await expect(assignIssueToTeam({ tenancy, issueId, teamId: null, actorUserId: userId, changedAt: at })).resolves.toMatchObject({ previousTeamId: null, teamId: ownerTeamId, changed: true });
    await expect(assignIssueToTeam({ tenancy, issueId, teamId: ownerTeamId, actorUserId: userId, changedAt: at })).resolves.toMatchObject({ previousTeamId: ownerTeamId, teamId: ownerTeamId, changed: false });
    const comment = await addIssueComment({ tenancy, issueId, actorUserId: userId, body: "Investigating the next release.", idempotencyKey: "comment-issue-product-1", occurredAt: at });
    await expect(addIssueComment({ tenancy, issueId, actorUserId: userId, body: "Investigating the next release.", idempotencyKey: "comment-issue-product-1", occurredAt: at })).resolves.toMatchObject({ id: comment.id });
    await expect(setIssueSubscription({ tenancy, issueId, subject: { type: "user", id: otherUserId }, subscribed: true, reason: "manual", actorUserId: userId, idempotencyKey: "subscription-issue-product-1", occurredAt: at })).resolves.toMatchObject({ type: "user", id: otherUserId, isActive: true });
    await expect(setIssueSubscription({ tenancy, issueId, subject: { type: "user", id: otherUserId }, subscribed: false, reason: "manual", actorUserId: userId, idempotencyKey: "subscription-issue-product-2", occurredAt: new Date(at.getTime() + 1) })).resolves.toMatchObject({ isActive: false });
    await expect(setIssueBookmark({ tenancy, issueId, userId: otherUserId, bookmarked: true, actorUserId: userId, idempotencyKey: "bookmark-issue-product-1", occurredAt: at })).resolves.toMatchObject({ bookmarked: true, changed: true });
    await expect(setIssueBookmark({ tenancy, issueId, userId: otherUserId, bookmarked: false, actorUserId: userId, idempotencyKey: "bookmark-issue-product-2", occurredAt: new Date(at.getTime() + 2) })).resolves.toMatchObject({ bookmarked: false, changed: true });
    await expect(setIssueOwner({ tenancy, issueId, owner: { type: "user", userId: otherUserId, source: "manual", context: { rule: "test" } }, actorUserId: userId, occurredAt: at })).resolves.toMatchObject({ type: "user", userId: otherUserId, source: "manual" });
    await expect(appendIssueActivity({ tenancy, issueId, type: "regressed", actorUserId: null, idempotencyKey: "activity-issue-product-1", data: { received_at: at.toISOString() }, occurredAt: at })).resolves.toMatchObject({ type: "regressed" });

    const snapshot = await loadIssueProductSnapshot({ tenancy, issueId });
    expect(snapshot).toMatchObject({ priority: "high", teamId: ownerTeamId, assigneeUserId: null });
    expect(snapshot.comments).toHaveLength(1);
    expect(snapshot.subscriptions).toEqual(expect.arrayContaining([expect.objectContaining({ id: otherUserId, isActive: false })]));
    expect(snapshot.owners).toEqual(expect.arrayContaining([expect.objectContaining({ userId: otherUserId, source: "manual" })]));
    expect(snapshot.bookmarkedUserIds).not.toContain(otherUserId);
    expect((await listIssueActivity({ tenancy, issueId, limit: 100 })).length).toBeGreaterThanOrEqual(6);
  });

  it("clears manual owners without deleting non-manual provenance", async () => {
    await setIssueOwner({ tenancy, issueId, owner: { type: "user", userId, source: "manual" }, actorUserId: userId });
    await setIssueOwner({ tenancy, issueId, owner: { type: "team", teamId: ownerTeamId, source: "codeowners" }, actorUserId: userId });
    const cleared = await clearManualIssueOwners({ tenancy, issueId, actorUserId: userId });
    expect(cleared.deletedCount).toBeGreaterThan(0);
    const snapshot = await loadIssueProductSnapshot({ tenancy, issueId });
    expect(snapshot.owners.some((owner) => owner.source === "manual")).toBe(false);
    expect(snapshot.owners.some((owner) => owner.source === "codeowners")).toBe(true);
  });

  it("rejects a customer-tenancy team and malformed ownership", async () => {
    const foreignTeamId = randomUUID();
    await expect(assignIssueToTeam({ tenancy, issueId, teamId: foreignTeamId, actorUserId: userId })).rejects.toThrow(/owner team/);
    await expect(setIssueOwner({ tenancy, issueId, owner: { type: "team", teamId: foreignTeamId, source: "manual" } })).rejects.toThrow(/owner team/);
    await expect(setIssueOwner({ tenancy, issueId, owner: { type: "user", teamId: foreignTeamId, source: "manual" } })).rejects.toThrow(/requires only userId/);
    await expect(loadIssueProductSnapshot({ tenancy, issueId: randomUUID() })).rejects.toThrow(/not found/);
  });

  it("replays subscription and bookmark results without reapplying stale mutations", async () => {
    const firstAt = new Date("2026-08-06T12:02:00.000Z");
    const secondAt = new Date("2026-08-06T12:03:00.000Z");
    const subscriptionOptions: Parameters<typeof setIssueSubscription>[0] = {
      tenancy,
      issueId,
      subject: { type: "user", id: otherUserId },
      subscribed: true,
      reason: "manual",
      actorUserId: userId,
      idempotencyKey: "subscription-replay-original",
      occurredAt: firstAt,
    };
    const firstSubscription = await setIssueSubscription(subscriptionOptions);
    await setIssueSubscription({
      ...subscriptionOptions,
      subscribed: false,
      idempotencyKey: "subscription-replay-opposite",
      occurredAt: secondAt,
    });
    await expect(setIssueSubscription(subscriptionOptions)).resolves.toEqual(firstSubscription);

    const bookmarkOptions = {
      tenancy,
      issueId,
      userId: otherUserId,
      bookmarked: true,
      actorUserId: userId,
      idempotencyKey: "bookmark-replay-original",
      occurredAt: firstAt,
    };
    const firstBookmark = await setIssueBookmark(bookmarkOptions);
    await setIssueBookmark({
      ...bookmarkOptions,
      bookmarked: false,
      idempotencyKey: "bookmark-replay-opposite",
      occurredAt: secondAt,
    });
    await expect(setIssueBookmark(bookmarkOptions)).resolves.toEqual(firstBookmark);

    const snapshot = await loadIssueProductSnapshot({ tenancy, issueId });
    expect(snapshot.subscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: otherUserId, isActive: false }),
    ]));
    expect(snapshot.bookmarkedUserIds).not.toContain(otherUserId);
  });

  it("serializes concurrent priority changes before deriving activity history", async () => {
    const firstAt = new Date("2026-08-06T12:04:00.000Z");
    const secondAt = new Date("2026-08-06T12:04:00.001Z");
    await setIssuePriority({ tenancy, issueId, priority: "high", actorUserId: userId, occurredAt: new Date(firstAt.getTime() - 1) });

    await Promise.all([
      setIssuePriority({ tenancy, issueId, priority: "medium", actorUserId: userId, occurredAt: firstAt }),
      setIssuePriority({ tenancy, issueId, priority: "low", actorUserId: userId, occurredAt: secondAt }),
    ]);

    const prisma = await getPrismaClientForTenancy(tenancy);
    const activities = await prisma.issueActivity.findMany({
      where: {
        tenancyId: tenancy.id,
        issueId,
        type: "PRIORITY_CHANGED",
        occurredAt: { in: [firstAt, secondAt] },
      },
      select: { data: true },
    });
    expect(activities).toHaveLength(2);
    expect(activities.filter((activity) => JSON.stringify(activity.data).includes('"from":"high"'))).toHaveLength(1);
  });
});
