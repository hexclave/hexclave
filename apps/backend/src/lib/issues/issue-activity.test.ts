import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildIssueActivity,
  buildIssueBookmark,
  buildIssueComment,
  buildIssueSubscription,
  ISSUE_ACTIVITY_IDEMPOTENCY_KEY_MAX_LENGTH,
  ISSUE_COMMENT_MAX_LENGTH,
} from "./issue-activity";
import { IssueLifecycleInputError } from "./issue-lifecycle";

const ISSUE_ID = "00000000-0000-4000-8000-000000000004";
const ACTOR_USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "00000000-0000-4000-8000-000000000003";
let tenancy: Tenancy;

beforeAll(async () => {
  const row = await globalPrismaClient.tenancy.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  if (row === null) throw new Error("Issue activity contract tests need a seeded tenancy.");
  const resolved = await getTenancy(row.id);
  if (resolved === null) throw new Error("The activity test tenancy disappeared.");
  tenancy = resolved;
});

describe("issue activity contract", () => {
  it("builds bounded, tenant-scoped commands with explicit retry keys", () => {
    const occurredAt = new Date("2026-08-06T12:00:00.000Z");
    expect(buildIssueComment({ tenancy, issueId: ISSUE_ID, actorUserId: ACTOR_USER_ID, body: "The next deploy contains the fix.", idempotencyKey: "comment-1", occurredAt })).toMatchObject({ operation: "comment", tenancyId: tenancy.id, issueId: ISSUE_ID, idempotencyKey: "comment-1" });
    expect(buildIssueActivity({ tenancy, issueId: ISSUE_ID, type: "status_changed", actorUserId: ACTOR_USER_ID, idempotencyKey: "status-1", occurredAt, data: { from: "resolved", to: "unresolved", ignoredUntil: null } })).toMatchObject({ tenancyId: tenancy.id, issueId: ISSUE_ID, type: "status_changed" });
    expect(buildIssueSubscription({ tenancy, issueId: ISSUE_ID, subject: { type: "team", id: TEAM_ID }, subscribed: true, actorUserId: ACTOR_USER_ID, idempotencyKey: "subscription-1" })).toMatchObject({ operation: "subscription", subject: { type: "team", id: TEAM_ID } });
    expect(buildIssueBookmark({ tenancy, issueId: ISSUE_ID, userId: OTHER_USER_ID, bookmarked: true, idempotencyKey: "bookmark-1" })).toMatchObject({ operation: "bookmark", userId: OTHER_USER_ID, bookmarked: true });
  });

  it("rejects empty or oversized comments and retry keys", () => {
    expect(() => buildIssueComment({ tenancy, issueId: ISSUE_ID, actorUserId: ACTOR_USER_ID, body: "   ", idempotencyKey: "comment-empty" })).toThrow(IssueLifecycleInputError);
    expect(() => buildIssueComment({ tenancy, issueId: ISSUE_ID, actorUserId: ACTOR_USER_ID, body: "x".repeat(ISSUE_COMMENT_MAX_LENGTH + 1), idempotencyKey: "comment-large" })).toThrow(/comment body must be at most/);
    expect(() => buildIssueBookmark({ tenancy, issueId: ISSUE_ID, userId: OTHER_USER_ID, bookmarked: true, idempotencyKey: "x".repeat(ISSUE_ACTIVITY_IDEMPOTENCY_KEY_MAX_LENGTH + 1) })).toThrow(/idempotencyKey must contain/);
  });
});
