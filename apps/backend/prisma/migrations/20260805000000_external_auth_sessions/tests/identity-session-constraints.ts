import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const firstUserId = randomUUID();
  const secondUserId = randomUUID();
  const thirdUserId = randomUUID();

  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'External Auth Migration Test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  await sql`
    INSERT INTO "ProjectUser" ("projectUserId", "tenancyId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "lastActiveAt")
    VALUES
      (${firstUserId}::uuid, ${tenancyId}::uuid, ${projectId}, 'main', NOW(), NOW(), NOW()),
      (${secondUserId}::uuid, ${tenancyId}::uuid, ${projectId}, 'main', NOW(), NOW(), NOW()),
      (${thirdUserId}::uuid, ${tenancyId}::uuid, ${projectId}, 'main', NOW(), NOW(), NOW())
  `;

  return { tenancyId, firstUserId, secondUserId, thirdUserId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('ExternalAuthMethod', 'ExternalAuthSession')
    ORDER BY table_name
  `;
  expect(Array.from(tables)).toMatchInlineSnapshot(`
    [
      {
        "table_name": "ExternalAuthMethod",
      },
      {
        "table_name": "ExternalAuthSession",
      },
    ]
  `);

  const firstAuthMethodId = randomUUID();
  const secondAuthMethodId = randomUUID();
  const duplicateIdentityAuthMethodId = randomUUID();
  const duplicateProviderAuthMethodId = randomUUID();
  const mismatchedUserAuthMethodId = randomUUID();
  await sql`
    INSERT INTO "AuthMethod" ("tenancyId", "id", "projectUserId", "createdAt", "updatedAt")
    VALUES
      (${ctx.tenancyId}::uuid, ${firstAuthMethodId}::uuid, ${ctx.firstUserId}::uuid, NOW(), NOW()),
      (${ctx.tenancyId}::uuid, ${secondAuthMethodId}::uuid, ${ctx.secondUserId}::uuid, NOW(), NOW()),
      (${ctx.tenancyId}::uuid, ${duplicateIdentityAuthMethodId}::uuid, ${ctx.thirdUserId}::uuid, NOW(), NOW()),
      (${ctx.tenancyId}::uuid, ${duplicateProviderAuthMethodId}::uuid, ${ctx.firstUserId}::uuid, NOW(), NOW()),
      (${ctx.tenancyId}::uuid, ${mismatchedUserAuthMethodId}::uuid, ${ctx.firstUserId}::uuid, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "ExternalAuthMethod" (
      "tenancyId", "authMethodId", "projectUserId", "providerConfigId", "issuer", "subject", "createdAt", "updatedAt"
    )
    VALUES
      (${ctx.tenancyId}::uuid, ${firstAuthMethodId}::uuid, ${ctx.firstUserId}::uuid, 'clerk-integration', 'https://clerk.example.com', 'user_1', NOW(), NOW()),
      (${ctx.tenancyId}::uuid, ${secondAuthMethodId}::uuid, ${ctx.secondUserId}::uuid, 'clerk-integration', 'https://clerk.example.com', 'user_2', NOW(), NOW())
  `;

  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  await sql`
    INSERT INTO "ExternalAuthSession" (
      "tenancyId", "id", "externalAuthMethodId", "providerSessionId", "updatedAt"
    )
    VALUES
      (${ctx.tenancyId}::uuid, ${firstSessionId}::uuid, ${firstAuthMethodId}::uuid, 'sess_1', NOW()),
      (${ctx.tenancyId}::uuid, ${secondSessionId}::uuid, ${secondAuthMethodId}::uuid, 'sess_2', NOW())
  `;

  // Postgres silently truncates identifiers to 63 characters, so the longer constraint names below
  // appear truncated in error messages (eg. "..._issuer_subjec_key" instead of "..._issuer_subject_key").
  await expect(sql`
    INSERT INTO "ExternalAuthMethod" (
      "tenancyId", "authMethodId", "projectUserId", "providerConfigId", "issuer", "subject", "createdAt", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${duplicateIdentityAuthMethodId}::uuid, ${ctx.thirdUserId}::uuid,
      'clerk-integration', 'https://clerk.example.com', 'user_1', NOW(), NOW()
    )
  `).rejects.toThrow(/ExternalAuthMethod_tenancyId_providerConfigId_issuer_subjec_key/);

  await expect(sql`
    INSERT INTO "ExternalAuthMethod" (
      "tenancyId", "authMethodId", "projectUserId", "providerConfigId", "issuer", "subject", "createdAt", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${duplicateProviderAuthMethodId}::uuid, ${ctx.firstUserId}::uuid,
      'clerk-integration', 'https://clerk.example.com', 'another-user', NOW(), NOW()
    )
  `).rejects.toThrow(/ExternalAuthMethod_tenancyId_projectUserId_providerConfigId_key/);

  await expect(sql`
    INSERT INTO "ExternalAuthMethod" (
      "tenancyId", "authMethodId", "projectUserId", "providerConfigId", "issuer", "subject", "createdAt", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${mismatchedUserAuthMethodId}::uuid, ${ctx.secondUserId}::uuid,
      'workos-integration', 'https://api.workos.com/user_management/client_migration_test', 'mismatched-user', NOW(), NOW()
    )
  `).rejects.toThrow(/ExternalAuthMethod_tenancyId_authMethodId_projectUserId_fkey/);

  await expect(sql`
    INSERT INTO "ExternalAuthSession" (
      "tenancyId", "id", "externalAuthMethodId", "providerSessionId", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${randomUUID()}::uuid, ${firstAuthMethodId}::uuid,
      'sess_1', NOW()
    )
  `).rejects.toThrow(/ExternalAuthSession_tenancyId_externalAuthMethodId_provider_key/);

  await expect(sql`
    INSERT INTO "ExternalAuthSession" (
      "tenancyId", "id", "externalAuthMethodId", "providerSessionId", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      'orphan-session', NOW()
    )
  `).rejects.toThrow(/ExternalAuthSession_tenancyId_externalAuthMethodId_fkey/);

  await sql`
    DELETE FROM "AuthMethod"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "id" = ${firstAuthMethodId}::uuid
  `;
  const firstUserRows = await sql<{ method_count: number, session_count: number }[]>`
    SELECT
      (SELECT count(*)::int FROM "ExternalAuthMethod" WHERE "projectUserId" = ${ctx.firstUserId}::uuid) AS method_count,
      (
        SELECT count(*)::int
        FROM "ExternalAuthSession" session
        JOIN "ExternalAuthMethod" method
          ON method."tenancyId" = session."tenancyId"
          AND method."authMethodId" = session."externalAuthMethodId"
        WHERE method."projectUserId" = ${ctx.firstUserId}::uuid
      ) AS session_count
  `;
  expect(firstUserRows[0]).toEqual({ method_count: 0, session_count: 0 });

  await sql`
    DELETE FROM "ProjectUser"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "projectUserId" = ${ctx.secondUserId}::uuid
  `;
  const remainingRows = await sql<{ method_count: number, session_count: number }[]>`
    SELECT
      (SELECT count(*)::int FROM "ExternalAuthMethod" WHERE "tenancyId" = ${ctx.tenancyId}::uuid) AS method_count,
      (SELECT count(*)::int FROM "ExternalAuthSession" WHERE "tenancyId" = ${ctx.tenancyId}::uuid) AS session_count
  `;
  expect(remainingRows[0]).toEqual({ method_count: 0, session_count: 0 });
};
