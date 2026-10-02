import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `release-graph-${randomUUID()}`;
  const tenancyId = randomUUID();
  const branchId = "main";

  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Release graph migration test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, ${branchId}, 'TRUE'::"BooleanTrue")
  `;

  return { projectId, tenancyId, branchId };
};

export const postMigration = async (
  sql: Sql,
  ctx: Awaited<ReturnType<typeof preMigration>>,
) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('Release', 'ReleaseDeployment', 'ReleaseCommit', 'ReleaseArtifact', 'ReleaseArtifactDebugId')
    ORDER BY table_name COLLATE "C"
  `;
  expect(tables.map((row) => row.table_name)).toMatchInlineSnapshot(`
    [
      "Release",
      "ReleaseArtifact",
      "ReleaseArtifactDebugId",
      "ReleaseCommit",
      "ReleaseDeployment",
    ]
  `);

  const scopeIndex = await sql<{ indexname: string, indisvalid: boolean, indisunique: boolean }[]>`
    SELECT indexes.indexname, pg_index.indisvalid, pg_index.indisunique
    FROM pg_indexes AS indexes
    JOIN pg_class ON pg_class.relname = indexes.indexname
    JOIN pg_index ON pg_index.indexrelid = pg_class.oid
    WHERE indexes.schemaname = 'public'
      AND indexes.indexname = 'Tenancy_id_projectId_branchId_key'
  `;
  expect(scopeIndex).toHaveLength(1);
  expect(scopeIndex[0].indisvalid).toBe(true);
  expect(scopeIndex[0].indisunique).toBe(true);

  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('Release', 'ReleaseDeployment', 'ReleaseCommit', 'ReleaseArtifact', 'ReleaseArtifactDebugId')
    ORDER BY indexname COLLATE "C"
  `;
  expect(indexes.map((row) => row.indexname)).toMatchInlineSnapshot(`
    [
      "ReleaseArtifactDebugId_artifact_debugId_key",
      "ReleaseArtifactDebugId_pkey",
      "ReleaseArtifactDebugId_tenancyId_debugId_idx",
      "ReleaseArtifact_pkey",
      "ReleaseArtifact_release_environment_dist_idx",
      "ReleaseArtifact_release_manifest_key",
      "ReleaseCommit_pkey",
      "ReleaseCommit_release_position_key",
      "ReleaseCommit_release_repository_sha_key",
      "ReleaseCommit_repository_sha_idx",
      "ReleaseDeployment_environment_finishedAt_idx",
      "ReleaseDeployment_pkey",
      "ReleaseDeployment_release_environment_finishedAt_idx",
      "ReleaseDeployment_tenancyId_deploymentKey_key",
      "Release_pkey",
      "Release_scope_dateAdded_idx",
      "Release_tenancyId_status_dateReleased_idx",
      "Release_tenancyId_version_key",
    ]
  `);

  const releaseId = randomUUID();
  await sql`
    INSERT INTO "Release" ("tenancyId", "projectId", "branchId", "id", "version", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${releaseId}::uuid, '2026.08.06+test', NOW())
  `;

  await expect(sql`
    INSERT INTO "Release" ("tenancyId", "projectId", "branchId", "id", "version", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, '2026.08.06+test', NOW())
  `).rejects.toThrow(/duplicate key value violates unique constraint/);

  const deploymentId = randomUUID();
  await sql`
    INSERT INTO "ReleaseDeployment" ("tenancyId", "projectId", "branchId", "id", "releaseId", "deploymentKey", "environment", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${deploymentId}::uuid, ${releaseId}::uuid, 'vercel-deploy-1', 'production', NOW())
  `;

  await expect(sql`
    INSERT INTO "ReleaseDeployment" ("tenancyId", "projectId", "branchId", "id", "releaseId", "deploymentKey", "environment", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, ${releaseId}::uuid, 'vercel-deploy-1', 'production', NOW())
  `).rejects.toThrow(/duplicate key value violates unique constraint/);

  const commitId = randomUUID();
  const commitSha = "a".repeat(40);
  await sql`
    INSERT INTO "ReleaseCommit" ("tenancyId", "projectId", "branchId", "id", "releaseId", "repository", "commitSha", "position", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${commitId}::uuid, ${releaseId}::uuid, 'hexclave', ${commitSha}, 0, NOW())
  `;

  await expect(sql`
    INSERT INTO "ReleaseCommit" ("tenancyId", "projectId", "branchId", "id", "releaseId", "repository", "commitSha", "position", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, ${releaseId}::uuid, 'hexclave', ${commitSha}, 1, NOW())
  `).rejects.toThrow(/duplicate key value violates unique constraint/);

  await expect(sql`
    INSERT INTO "ReleaseCommit" ("tenancyId", "projectId", "branchId", "id", "releaseId", "repository", "commitSha", "position", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, ${releaseId}::uuid, 'hexclave', ${"b".repeat(40)}, 0, NOW())
  `).rejects.toThrow(/duplicate key value violates unique constraint/);

  const artifactId = randomUUID();
  const manifestSha256 = "b".repeat(64);
  await sql`
    INSERT INTO "ReleaseArtifact" ("tenancyId", "projectId", "branchId", "id", "releaseId", "manifestSha256", "dist", "environment", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${artifactId}::uuid, ${releaseId}::uuid, ${manifestSha256}, 'web', 'production', NOW())
  `;

  await sql`
    INSERT INTO "ReleaseArtifactDebugId" (
      "tenancyId", "projectId", "branchId", "id", "releaseArtifactId", "debugId", "codeFile",
      "sourceMapFile", "sourceMapInline", "bundleSha256", "bundleBytes", "sourceMapSha256",
      "sourceMapBytes", "sourceMapGzippedBytes", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, ${artifactId}::uuid,
      '00000000-0000-4000-8000-000000000001', 'static/app.js', 'static/app.js.map', false,
      ${"c".repeat(64)}, 12, ${"d".repeat(64)}, 24, 18, NOW()
    )
  `;

  await expect(sql`
    INSERT INTO "ReleaseArtifactDebugId" (
      "tenancyId", "projectId", "branchId", "id", "releaseArtifactId", "debugId", "codeFile",
      "sourceMapFile", "sourceMapInline", "bundleSha256", "bundleBytes", "sourceMapSha256",
      "sourceMapBytes", "sourceMapGzippedBytes", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, ${artifactId}::uuid,
      '00000000-0000-4000-8000-000000000001', 'static/other.js', 'static/other.js.map', false,
      ${"e".repeat(64)}, 12, ${"f".repeat(64)}, 24, 18, NOW()
    )
  `).rejects.toThrow(/duplicate key value violates unique constraint/);

  const lookup = await sql<{ version: string, dist: string, debug_id: string }[]>`
    SELECT release."version", artifact."dist", debug."debugId" AS debug_id
    FROM "ReleaseArtifactDebugId" AS debug
    JOIN "ReleaseArtifact" AS artifact
      ON artifact."tenancyId" = debug."tenancyId"
      AND artifact."id" = debug."releaseArtifactId"
    JOIN "Release" AS release
      ON release."tenancyId" = artifact."tenancyId"
      AND release."id" = artifact."releaseId"
    WHERE debug."tenancyId" = ${ctx.tenancyId}::uuid
      AND debug."debugId" = '00000000-0000-4000-8000-000000000001'
      AND artifact."dist" = 'web'
  `;
  expect(lookup).toEqual([{
    version: "2026.08.06+test",
    dist: "web",
    debug_id: "00000000-0000-4000-8000-000000000001",
  }]);

  await expect(sql`
    INSERT INTO "ReleaseArtifact" ("tenancyId", "projectId", "branchId", "id", "releaseId", "manifestSha256", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, ${ctx.branchId}, ${randomUUID()}::uuid, ${releaseId}::uuid, ${manifestSha256}, NOW())
  `).rejects.toThrow(/duplicate key value violates unique constraint/);

  await expect(sql`
    INSERT INTO "Release" ("tenancyId", "projectId", "branchId", "id", "version", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, ${ctx.projectId}, 'other-branch', ${randomUUID()}::uuid, 'wrong-scope', NOW())
  `).rejects.toThrow(/foreign key constraint/);

  await sql`DELETE FROM "Project" WHERE "id" = ${ctx.projectId}`;
  const remaining = await sql<{ table_name: string, count: number }[]>`
    SELECT table_name, count
    FROM (
      SELECT 'Release' AS table_name, count(*)::int AS count FROM "Release" WHERE "tenancyId" = ${ctx.tenancyId}::uuid
      UNION ALL
      SELECT 'ReleaseDeployment', count(*)::int FROM "ReleaseDeployment" WHERE "tenancyId" = ${ctx.tenancyId}::uuid
      UNION ALL
      SELECT 'ReleaseCommit', count(*)::int FROM "ReleaseCommit" WHERE "tenancyId" = ${ctx.tenancyId}::uuid
      UNION ALL
      SELECT 'ReleaseArtifact', count(*)::int FROM "ReleaseArtifact" WHERE "tenancyId" = ${ctx.tenancyId}::uuid
      UNION ALL
      SELECT 'ReleaseArtifactDebugId', count(*)::int FROM "ReleaseArtifactDebugId" WHERE "tenancyId" = ${ctx.tenancyId}::uuid
    ) AS counts
    ORDER BY table_name COLLATE "C"
  `;
  expect(remaining.every((row) => row.count === 0)).toBe(true);
};
