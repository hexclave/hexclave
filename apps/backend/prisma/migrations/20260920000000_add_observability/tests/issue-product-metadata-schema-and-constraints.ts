import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const seedTenancy = async (sql: Sql, label: string) => {
  const projectId = `issue-product-${randomUUID()}`;
  const tenancyId = randomUUID();
  const branchId = "main";
  await sql`INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode") VALUES (${projectId}, NOW(), NOW(), ${label}, '', false)`;
  await sql`INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization") VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, ${branchId}, 'TRUE'::"BooleanTrue")`;
  return { projectId, tenancyId, branchId };
};

export const preMigration = async (sql: Sql) => ({ primary: await seedTenancy(sql, "Issue product persistence test"), other: await seedTenancy(sql, "Issue product scope test") });

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('IssueOwner', 'IssueActivity', 'IssueComment', 'IssueSubscription', 'IssueBookmark')
    ORDER BY table_name COLLATE "C"
  `;
  expect(tables.map((row) => row.table_name)).toEqual(["IssueActivity", "IssueBookmark", "IssueComment", "IssueOwner", "IssueSubscription"]);

  const issueId = randomUUID();
  const userId = randomUUID();
  const teamId = randomUUID();
  await sql`INSERT INTO "Issue" ("id", "tenancyId", "shortId", "type", "value", "culprit", "platform", "firstSeenAt", "lastSeenAt", "updatedAt") VALUES (${issueId}::uuid, ${ctx.primary.tenancyId}::uuid, 1, 'TypeError', 'boom', 'app.ts', 'node', NOW(), NOW(), NOW())`;
  await sql`INSERT INTO "ProjectUser" ("tenancyId", "projectUserId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "lastActiveAt", "signedUpAt") VALUES (${ctx.primary.tenancyId}::uuid, ${userId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, NOW(), NOW(), NOW(), NOW())`;
  await sql`INSERT INTO "Team" ("tenancyId", "teamId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "displayName") VALUES (${ctx.primary.tenancyId}::uuid, ${teamId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, NOW(), NOW(), 'Issue product team')`;

  await sql`INSERT INTO "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerUserId", "source") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, 'MANUAL')`;
  await expect(sql`INSERT INTO "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerUserId", "ownerTeamId", "source") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, ${teamId}::uuid, 'MANUAL')`).rejects.toThrow(/IssueOwner_owner_check/);
  await expect(sql`INSERT INTO "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerUserId", "source") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, 'MANUAL')`).rejects.toThrow(/IssueOwner_scope_natural_key/);
  await sql`INSERT INTO "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerTeamId", "source") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'TEAM', ${teamId}::uuid, 'MANUAL')`;
  await expect(sql`INSERT INTO "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerTeamId", "source") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'TEAM', ${teamId}::uuid, 'MANUAL')`).rejects.toThrow(/IssueOwner_scope_natural_key/);
  await sql`INSERT INTO "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerUserId", "source") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, 'CODEOWNERS')`;
  await expect(sql`INSERT INTO "IssueActivity" ("tenancyId", "projectId", "branchId", "issueId", "type", "idempotencyKey", "data", "occurredAt") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'COMMENT', 'large', ${JSON.stringify({ value: "x".repeat(66_000) })}::jsonb, NOW())`).rejects.toThrow(/IssueActivity_data_size_check/);
  await expect(sql`INSERT INTO "IssueComment" ("tenancyId", "projectId", "branchId", "issueId", "authorUserId", "body", "idempotencyKey") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, ${userId}::uuid, '', 'empty')`).rejects.toThrow(/IssueComment_body_size_check/);
  await sql`INSERT INTO "IssueSubscription" ("tenancyId", "projectId", "branchId", "issueId", "subjectType", "subjectUserId", "isActive") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, true)`;
  await expect(sql`INSERT INTO "IssueSubscription" ("tenancyId", "projectId", "branchId", "issueId", "subjectType", "subjectUserId", "subjectTeamId", "isActive") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, ${teamId}::uuid, true)`).rejects.toThrow(/IssueSubscription_subject_check/);
  await expect(sql`INSERT INTO "IssueSubscription" ("tenancyId", "projectId", "branchId", "issueId", "subjectType", "subjectUserId", "isActive") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${userId}::uuid, false)`).rejects.toThrow(/IssueSubscription_scope_natural_key/);

  const deletableUserId = randomUUID();
  await sql`INSERT INTO "ProjectUser" ("tenancyId", "projectUserId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "lastActiveAt", "signedUpAt") VALUES (${ctx.primary.tenancyId}::uuid, ${deletableUserId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, NOW(), NOW(), NOW(), NOW())`;
  await sql`INSERT INTO "IssueSubscription" ("tenancyId", "projectId", "branchId", "issueId", "subjectType", "subjectUserId", "isActive") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, 'USER', ${deletableUserId}::uuid, true)`;
  await sql`DELETE FROM "ProjectUser" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid AND "projectUserId" = ${deletableUserId}::uuid`;
  const subscriptionsAfterUserDelete = await sql<{ subjectUserId: string | null }[]>`
    SELECT "subjectUserId"::text AS "subjectUserId" FROM "IssueSubscription" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid ORDER BY "subjectUserId"
  `;
  expect(subscriptionsAfterUserDelete).toEqual([{ subjectUserId: userId }]);
  await sql`INSERT INTO "IssueBookmark" ("tenancyId", "projectId", "branchId", "issueId", "userId") VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${issueId}::uuid, ${userId}::uuid)`;
  await expect(sql`INSERT INTO "IssueBookmark" ("tenancyId", "projectId", "branchId", "issueId", "userId") VALUES (${ctx.other.tenancyId}::uuid, ${ctx.other.projectId}, ${ctx.other.branchId}, ${issueId}::uuid, ${userId}::uuid)`).rejects.toThrow(/IssueBookmark_issue_fkey|IssueBookmark_user_fkey|IssueBookmark_tenancy_scope_fkey/);

  const ownerTeamId = randomUUID();
  await sql`UPDATE "Issue" SET "assignedTeamId" = ${ownerTeamId}::uuid WHERE "id" = ${issueId}::uuid`;
  const assigned = await sql<{ assignedTeamId: string }[]>`SELECT "assignedTeamId" FROM "Issue" WHERE "id" = ${issueId}::uuid`;
  expect(assigned[0].assignedTeamId).toBe(ownerTeamId);
  const leakedTeamFks = await sql<{ constraint_name: string }[]>`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name IN ('Issue_assigned_team_fkey', 'IssueOwner_team_fkey', 'IssueSubscription_team_fkey')
    ORDER BY constraint_name COLLATE "C"
  `;
  expect(leakedTeamFks).toEqual([]);

  await sql`DELETE FROM "Project" WHERE "id" = ${ctx.primary.projectId}`;
  const remaining = await sql<{ table_name: string, count: number }[]>`
    SELECT table_name, count FROM (
      SELECT 'IssueOwner' AS table_name, count(*)::int AS count FROM "IssueOwner" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
      UNION ALL SELECT 'IssueActivity', count(*)::int FROM "IssueActivity" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
      UNION ALL SELECT 'IssueComment', count(*)::int FROM "IssueComment" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
      UNION ALL SELECT 'IssueSubscription', count(*)::int FROM "IssueSubscription" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
      UNION ALL SELECT 'IssueBookmark', count(*)::int FROM "IssueBookmark" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
    ) AS rows
  `;
  expect(remaining.every((row) => row.count === 0)).toBe(true);
};
