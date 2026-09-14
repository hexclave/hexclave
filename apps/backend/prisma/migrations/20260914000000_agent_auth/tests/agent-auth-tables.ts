import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const otherTenancyId = randomUUID();
  const userId = randomUUID();
  const refreshTokenId = randomUUID();

  await sql`INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode") VALUES (${projectId}, NOW(), NOW(), 'Test', '', false)`;
  await sql`INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization") VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")`;
  await sql`INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization") VALUES (${otherTenancyId}::uuid, NOW(), NOW(), ${projectId}, 'other', 'TRUE'::"BooleanTrue")`;
  await sql`INSERT INTO "ProjectUser" ("projectUserId", "tenancyId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "lastActiveAt") VALUES (${userId}::uuid, ${tenancyId}::uuid, ${projectId}, 'main', NOW(), NOW(), NOW())`;
  await sql`
    INSERT INTO "ProjectUserRefreshToken" ("id", "tenancyId", "projectUserId", "createdAt", "updatedAt", "lastActiveAt", "refreshToken")
    VALUES (${refreshTokenId}::uuid, ${tenancyId}::uuid, ${userId}::uuid, NOW(), NOW(), NOW(), ${`rt-${randomUUID()}`})
  `;

  return { tenancyId, otherTenancyId, refreshTokenId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  // Existing sessions are not agent sessions.
  const sessions = await sql`SELECT "agentName" FROM "ProjectUserRefreshToken" WHERE "id" = ${ctx.refreshTokenId}::uuid`;
  expect(sessions).toHaveLength(1);
  expect(sessions[0].agentName).toBeNull();

  const insertAttempt = (tenancyId: string, claimCode: string, pollToken: string) => sql`
    INSERT INTO "AgentAuthAttempt" ("tenancyId", "id", "agentName", "claimCode", "pollToken", "expiresAt", "updatedAt")
    VALUES (${tenancyId}::uuid, ${randomUUID()}::uuid, 'Test Agent', ${claimCode}, ${pollToken}, NOW() + INTERVAL '10 minutes', NOW())
  `;

  await insertAttempt(ctx.tenancyId, "ABCD-EFGH", `poll-${randomUUID()}`);

  // Claim codes are unique per tenancy...
  await expect(insertAttempt(ctx.tenancyId, "ABCD-EFGH", `poll-${randomUUID()}`)).rejects.toThrow(/AgentAuthAttempt_tenancyId_claimCode_key/);
  // ...but may repeat across tenancies.
  await insertAttempt(ctx.otherTenancyId, "ABCD-EFGH", `poll-${randomUUID()}`);

  // Poll tokens are unique globally.
  const pollToken = `poll-${randomUUID()}`;
  await insertAttempt(ctx.tenancyId, "WXYZ-1234", pollToken);
  await expect(insertAttempt(ctx.otherTenancyId, "WXYZ-1234", pollToken)).rejects.toThrow(/AgentAuthAttempt_pollToken_key/);

  const rows = await sql`
    SELECT "agentDescription", "agentUrl", "userHint", "anonProjectUserId", "approvedByUserId", "approvedAt", "deniedAt", "refreshToken", "usedAt"
    FROM "AgentAuthAttempt"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "claimCode" = 'ABCD-EFGH'
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    agentDescription: null,
    agentUrl: null,
    userHint: null,
    anonProjectUserId: null,
    approvedByUserId: null,
    approvedAt: null,
    deniedAt: null,
    refreshToken: null,
    usedAt: null,
  });
};
