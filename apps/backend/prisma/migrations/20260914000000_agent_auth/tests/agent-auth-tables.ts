import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const userId = randomUUID();
  const refreshTokenId = randomUUID();
  const cliAttemptId = randomUUID();

  await sql`INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode") VALUES (${projectId}, NOW(), NOW(), 'Test', '', false)`;
  await sql`INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization") VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")`;
  await sql`INSERT INTO "ProjectUser" ("projectUserId", "tenancyId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "lastActiveAt") VALUES (${userId}::uuid, ${tenancyId}::uuid, ${projectId}, 'main', NOW(), NOW(), NOW())`;
  await sql`
    INSERT INTO "ProjectUserRefreshToken" ("id", "tenancyId", "projectUserId", "createdAt", "updatedAt", "lastActiveAt", "refreshToken")
    VALUES (${refreshTokenId}::uuid, ${tenancyId}::uuid, ${userId}::uuid, NOW(), NOW(), NOW(), ${`rt-${randomUUID()}`})
  `;
  // A CLI attempt created by the previous release, before the agent columns existed.
  await sql`
    INSERT INTO "CliAuthAttempt" ("tenancyId", "id", "pollingCode", "loginCode", "expiresAt", "updatedAt")
    VALUES (${tenancyId}::uuid, ${cliAttemptId}::uuid, ${`poll-${randomUUID()}`}, ${`login-${randomUUID()}`}, NOW() + INTERVAL '10 minutes', NOW())
  `;

  return { tenancyId, refreshTokenId, cliAttemptId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  // Existing sessions are not agent sessions.
  const sessions = await sql`SELECT "agentName" FROM "ProjectUserRefreshToken" WHERE "id" = ${ctx.refreshTokenId}::uuid`;
  expect(sessions).toHaveLength(1);
  expect(sessions[0].agentName).toBeNull();

  // Existing CLI attempts are plain, never-denied device attempts.
  const cliRows = await sql`
    SELECT "deniedAt", "agentName", "agentDescription", "agentUrl", "userHint", "refreshToken", "usedAt"
    FROM "CliAuthAttempt"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "id" = ${ctx.cliAttemptId}::uuid
  `;
  expect(cliRows).toHaveLength(1);
  expect(cliRows[0]).toMatchObject({
    deniedAt: null,
    agentName: null,
    agentDescription: null,
    agentUrl: null,
    userHint: null,
    refreshToken: null,
    usedAt: null,
  });

  // Agent attempts live in the same table with the agent columns filled in.
  const loginCode = "ABCD-EFGH";
  const pollingCode = `poll-${randomUUID()}`;
  await sql`
    INSERT INTO "CliAuthAttempt" ("tenancyId", "id", "pollingCode", "loginCode", "agentName", "agentDescription", "agentUrl", "userHint", "expiresAt", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${randomUUID()}::uuid, ${pollingCode}, ${loginCode}, 'Test Agent', 'Triage tickets', 'https://example.com', 'alice@example.com', NOW() + INTERVAL '10 minutes', NOW())
  `;
  const agentRows = await sql`SELECT "agentName", "agentDescription", "agentUrl", "userHint", "deniedAt" FROM "CliAuthAttempt" WHERE "loginCode" = ${loginCode}`;
  expect(agentRows).toHaveLength(1);
  expect(agentRows[0]).toMatchObject({
    agentName: "Test Agent",
    agentDescription: "Triage tickets",
    agentUrl: "https://example.com",
    userHint: "alice@example.com",
    deniedAt: null,
  });

  // The pre-existing uniqueness of both codes still holds.
  await expect(sql`
    INSERT INTO "CliAuthAttempt" ("tenancyId", "id", "pollingCode", "loginCode", "expiresAt", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${randomUUID()}::uuid, ${`poll-${randomUUID()}`}, ${loginCode}, NOW() + INTERVAL '10 minutes', NOW())
  `).rejects.toThrow(/CliAuthAttempt_loginCode_key/);
  await expect(sql`
    INSERT INTO "CliAuthAttempt" ("tenancyId", "id", "pollingCode", "loginCode", "expiresAt", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${randomUUID()}::uuid, ${pollingCode}, ${`login-${randomUUID()}`}, NOW() + INTERVAL '10 minutes', NOW())
  `).rejects.toThrow(/CliAuthAttempt_pollingCode_key/);

  // Denial is recorded on the row itself.
  await sql`UPDATE "CliAuthAttempt" SET "deniedAt" = NOW() WHERE "loginCode" = ${loginCode}`;
  const denied = await sql`SELECT "deniedAt" FROM "CliAuthAttempt" WHERE "loginCode" = ${loginCode}`;
  expect(denied[0].deniedAt).not.toBeNull();
};
