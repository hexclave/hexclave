import type { SmartRequest } from "@/route-handlers/smart-request";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { loadIssueProductSnapshot, setIssueOwner } from "@/lib/issues/issue-product";
import { getBillingTeamId } from "@/lib/plan-entitlements";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as assignIssue } from "./assign/route";
import { POST as regressIssue } from "./regress/route";
import { POST as snoozeIssue } from "./snooze/route";
import { POST as statusIssue } from "./status/route";
import { POST as unassignIssue } from "./unassign/route";
import { POST as unsnoozeIssue } from "./unsnooze/route";
import { DELETE as clearIssueOwner } from "./owner/route";
import { IssueActionAuthSchema } from "./_shared";

const RUN_PREFIX = `issue-actions-${randomUUID()}`;
const createdIssues: Array<{ tenancy: Tenancy, id: string }> = [];
const createdRedirects: Array<{ tenancy: Tenancy, fromIssueId: string }> = [];

let tenancy: Tenancy;
let otherTenancy: Tenancy | null = null;
let assignableUserIds: string[];

function assignableUserId(index = 0): string {
  const userId = assignableUserIds.at(index % assignableUserIds.length);
  if (userId === undefined) throw new Error("Issue action route tests need a seeded project user.");
  return userId;
}

async function findObservabilityTenancies(): Promise<Tenancy[]> {
  const rows = await globalPrismaClient.$queryRaw<Array<{ id: string }>>`
    SELECT t."id"::text AS "id"
    FROM "Tenancy" t
    LEFT JOIN "ProjectUser" u ON u."tenancyId" = t."id"
    GROUP BY t."id"
    ORDER BY count(u."projectUserId") DESC, t."id" ASC
    LIMIT 2
  `;
  const result: Tenancy[] = [];
  for (const row of rows) {
    const candidate = await getTenancy(row.id);
    if (candidate !== null) result.push(withObservabilityEnabled(candidate));
  }
  return result;
}

function withObservabilityEnabled(target: Tenancy): Tenancy {
  return {
    ...target,
    config: {
      ...target.config,
      apps: {
        ...target.config.apps,
        installed: {
          ...target.config.apps.installed,
          observability: { ...target.config.apps.installed["observability"], enabled: true },
        },
      },
    },
  };
}

async function createIssue(target: Tenancy = tenancy): Promise<{ id: string, shortId: string }> {
  const prisma = await getPrismaClientForTenancy(target);
  const [{ shortId }] = await prisma.$queryRaw<Array<{ shortId: bigint }>>`
    INSERT INTO "IssueCounter" ("tenancyId", "nextShortId")
    VALUES (${target.id}::uuid, 2::bigint)
    ON CONFLICT ("tenancyId") DO UPDATE
      SET "nextShortId" = "IssueCounter"."nextShortId" + 1
    RETURNING "nextShortId" - 1 AS "shortId"
  `;
  const id = randomUUID();
  const seenAt = new Date("2026-08-06T11:00:00.000Z");
  await prisma.issue.create({
    data: {
      id,
      tenancyId: target.id,
      shortId,
      type: "TypeError",
      value: `${RUN_PREFIX}-value`,
      culprit: "actions.test.ts in test",
      platform: "javascript",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      timesSeen: 1n,
    },
  });
  createdIssues.push({ tenancy: target, id });
  return { id, shortId: shortId.toString() };
}

async function createRedirect(target: Tenancy, source: { id: string, shortId: string }, survivor: { id: string }): Promise<void> {
  const prisma = await getPrismaClientForTenancy(target);
  await prisma.$executeRaw`
    INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
    VALUES (${target.id}::uuid, ${source.id}::uuid, ${survivor.id}::uuid, ${source.shortId}::bigint)
  `;
  await prisma.issue.delete({ where: { tenancyId_id: { tenancyId: target.id, id: source.id } } });
  createdRedirects.push({ tenancy: target, fromIssueId: source.id });
}

function request(target: Tenancy, issueId: string, body: unknown, type: "client" | "server" | "admin" = "server"): SmartRequest {
  return {
    auth: {
      type,
      project: target.project,
      branchId: target.branchId,
      tenancy: target,
    },
    url: `http://localhost/api/latest/issues/${issueId}/actions`,
    method: "POST",
    body,
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: {},
    params: { issue_id: issueId },
    clientVersion: undefined,
  };
}

beforeAll(async () => {
  const candidates = await findObservabilityTenancies();
  const first = candidates.at(0);
  if (first === undefined) throw new Error("Issue action route tests need a tenancy in the development database.");
  tenancy = first;
  otherTenancy = candidates.find((candidate) => candidate.id !== tenancy.id) ?? null;
  const prisma = await getPrismaClientForTenancy(tenancy);
  assignableUserIds = (await prisma.projectUser.findMany({
    where: { tenancyId: tenancy.id },
    select: { projectUserId: true },
    take: 8,
  })).map((user) => user.projectUserId);
  assignableUserId();
});

afterAll(async () => {
  for (const redirect of createdRedirects) {
    const prisma = await getPrismaClientForTenancy(redirect.tenancy);
    await prisma.$executeRaw`
      DELETE FROM "IssueRedirect"
      WHERE "tenancyId" = ${redirect.tenancy.id}::uuid
        AND "fromIssueId" = ${redirect.fromIssueId}::uuid
    `;
  }
  for (const created of createdIssues) {
    const prisma = await getPrismaClientForTenancy(created.tenancy);
    await prisma.issue.deleteMany({ where: { tenancyId: created.tenancy.id, id: created.id } });
  }
});

describe("authenticated issue lifecycle action routes", () => {
  it("assigns, unassigns, resolves, ignores, reopens, regresses, snoozes, and unsnoozes", async () => {
    const issue = await createIssue();
    const assigneeUserId = assignableUserId();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    try {
      const assigned = await assignIssue.invoke(request(tenancy, issue.id, { assignee_user_id: assigneeUserId }));
      expect(assigned.body).toMatchObject({
        action: "assign",
        issue_id: issue.id,
        changed: true,
        assignee_user_id: assigneeUserId,
        previous_assignee_user_id: null,
      });

      const unassigned = await unassignIssue.invoke(request(tenancy, issue.id, {}));
      expect(unassigned.body).toMatchObject({
        action: "unassign",
        issue_id: issue.id,
        changed: true,
        assignee_user_id: null,
        previous_assignee_user_id: assigneeUserId,
      });

      const resolved = await statusIssue.invoke(request(tenancy, issue.id, { status: "resolved" }));
      expect(resolved.body).toMatchObject({ action: "resolve", status: "resolved", transition_kind: "status_changed", changed: true });

      const ignored = await statusIssue.invoke(request(tenancy, issue.id, { status: "ignored" }));
      expect(ignored.body).toMatchObject({ action: "ignore", status: "ignored", ignored_until_millis: null, changed: true });

      const reopened = await statusIssue.invoke(request(tenancy, issue.id, { status: "unresolved" }));
      expect(reopened.body).toMatchObject({ action: "unresolve", status: "unresolved", transition_kind: "status_changed", changed: true });

      const resolvedAgain = await statusIssue.invoke(request(tenancy, issue.id, { status: "resolved" }));
      expect(resolvedAgain.body).toMatchObject({ status: "resolved" });
      vi.setSystemTime(new Date("2026-08-06T12:00:00.001Z"));

      const regressed = await regressIssue.invoke(request(tenancy, issue.id, {}));
      expect(regressed.body).toMatchObject({ action: "regress", status: "unresolved", transition_kind: "regressed", changed: true });
      expect(regressed.body).toMatchObject({ regressed_at_millis: expect.any(Number) });

      vi.setSystemTime(new Date("2026-08-06T12:01:00.000Z"));
      const snoozeUntil = new Date("2026-08-06T12:02:00.000Z").getTime();
      const snoozed = await snoozeIssue.invoke(request(tenancy, issue.id, { ignored_until_millis: snoozeUntil }));
      expect(snoozed.body).toMatchObject({ action: "snooze", status: "ignored", ignored_until_millis: snoozeUntil });

      const unsnoozed = await unsnoozeIssue.invoke(request(tenancy, issue.id, {}));
      expect(unsnoozed.body).toMatchObject({ action: "unsnooze", status: "unresolved", ignored_until_millis: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a merged issue id and reports the canonical survivor", async () => {
    const survivor = await createIssue();
    const source = await createIssue();
    await createRedirect(tenancy, source, survivor);

    const assigneeUserId = assignableUserId();
    const response = await assignIssue.invoke(request(tenancy, source.id, { assignee_user_id: assigneeUserId }));

    expect(response.body).toMatchObject({
      action: "assign",
      issue_id: survivor.id,
      redirected: true,
      redirected_from_issue_id: source.id,
      assignee_user_id: assigneeUserId,
    });
  });

  it("clears only manual owners through the owner action route", async () => {
    const issue = await createIssue();
    const ownerTeamId = getBillingTeamId(tenancy.project);
    if (ownerTeamId === null) throw new Error("Issue owner route tests need a project owner team.");
    await setIssueOwner({ tenancy, issueId: issue.id, owner: { type: "team", teamId: ownerTeamId, source: "manual" } });
    await setIssueOwner({ tenancy, issueId: issue.id, owner: { type: "team", teamId: ownerTeamId, source: "codeowners" } });

    const response = await clearIssueOwner.invoke({ ...request(tenancy, issue.id, {}), method: "DELETE" });

    expect(response.body).toMatchObject({ issue_id: issue.id, deleted_count: 1, updated_at_millis: expect.any(Number) });
    const snapshot = await loadIssueProductSnapshot({ tenancy, issueId: issue.id });
    expect(snapshot.owners.some((owner) => owner.source === "manual")).toBe(false);
    expect(snapshot.owners.some((owner) => owner.source === "codeowners")).toBe(true);
  });

  it("rejects client access, cross-tenant ids, missing issues, malformed ids, and unknown JSON", async () => {
    const issue = await createIssue();
    const assigneeUserId = assignableUserId();

    expect(await IssueActionAuthSchema.isValid({ type: "client", tenancy })).toBe(false);
    await expect(assignIssue.invoke(request(tenancy, issue.id, { assignee_user_id: assigneeUserId }, "client")))
      .rejects.toMatchObject({ name: "HexclaveAssertionError" });
    await expect(assignIssue.invoke(request(tenancy, randomUUID(), { assignee_user_id: assigneeUserId })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 404, message: "Issue not found" });
    await expect(assignIssue.invoke(request(tenancy, "not-an-issue-id", { assignee_user_id: assigneeUserId })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 400 });
    await expect(assignIssue.invoke(request(tenancy, issue.id, { assignee_user_id: assigneeUserId, unexpected: true })))
      .rejects.toMatchObject({ name: "HexclaveAssertionError" });

    if (otherTenancy !== null) {
      const foreignIssue = await createIssue(otherTenancy);
      await expect(assignIssue.invoke(request(tenancy, foreignIssue.id, { assignee_user_id: assigneeUserId })))
        .rejects.toMatchObject({ name: "StatusError", statusCode: 404, message: "Issue not found" });
    }
  });

  it("rejects expired snoozes before touching the issue", async () => {
    const issue = await createIssue();
    await expect(snoozeIssue.invoke(request(tenancy, issue.id, { ignored_until_millis: 1 })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 400, message: "ignored_until_millis must be in the future" });

    const prisma = await getPrismaClientForTenancy(tenancy);
    const stored = await prisma.issue.findUnique({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: issue.id } },
      select: { status: true, ignoredUntil: true },
    });
    expect(stored).toMatchObject({ status: "UNRESOLVED", ignoredUntil: null });
  });

  it("serializes concurrent assignments through the lifecycle lock", async () => {
    const issue = await createIssue();
    const assignments = Array.from({ length: 8 }, (_, index) => assignableUserId(index));
    const responses = await Promise.all(assignments.map((assigneeUserId) => assignIssue.invoke(
      request(tenancy, issue.id, { assignee_user_id: assigneeUserId }),
    )));

    expect(responses).toHaveLength(assignments.length);
    expect(responses.every((response) => response.body.issue_id === issue.id)).toBe(true);
    const prisma = await getPrismaClientForTenancy(tenancy);
    const stored = await prisma.issue.findUnique({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: issue.id } },
      select: { assigneeUserId: true },
    });
    expect(stored?.assigneeUserId === null || (stored?.assigneeUserId !== undefined && assignments.includes(stored.assigneeUserId))).toBe(true);
  });
});
