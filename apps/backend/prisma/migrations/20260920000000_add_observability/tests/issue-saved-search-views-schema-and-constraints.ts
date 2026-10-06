import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const seedTenancy = async (sql: Sql, label: string) => {
  const projectId = `saved-view-${randomUUID()}`;
  const tenancyId = randomUUID();
  const branchId = "main";
  const ownerUserId = randomUUID();

  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), ${label}, '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, ${branchId}, 'TRUE'::"BooleanTrue")
  `;
  await sql`
    INSERT INTO "ProjectUser" (
      "tenancyId", "projectUserId", "mirroredProjectId", "mirroredBranchId",
      "createdAt", "updatedAt", "lastActiveAt", "signedUpAt"
    ) VALUES (
      ${tenancyId}::uuid, ${ownerUserId}::uuid, ${projectId}, ${branchId}, NOW(), NOW(), NOW(), NOW()
    )
  `;

  return { projectId, tenancyId, branchId, ownerUserId };
};

export const preMigration = async (sql: Sql) => ({
  primary: await seedTenancy(sql, "Saved issue search view test"),
  other: await seedTenancy(sql, "Saved issue search view scope test"),
});

export const postMigration = async (
  sql: Sql,
  ctx: Awaited<ReturnType<typeof preMigration>>,
) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'IssueSavedSearchView'
  `;
  expect(tables).toEqual([{ table_name: "IssueSavedSearchView" }]);

  const query = JSON.stringify({ version: 1, filters: { record: "issue", hours: "24", limit: "50" } });
  const viewId = randomUUID();
  await sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "id", "name", "nameKey", "visibility", "ownerUserId", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${viewId}::uuid,
      'My Errors', 'my errors', 'private', ${ctx.primary.ownerUserId}::uuid, ${query}::text::jsonb
    )
  `;

  await expect(sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "name", "nameKey", "visibility", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId},
      'Duplicate', 'my errors', 'project', ${query}::text::jsonb
    )
  `).rejects.toThrow(/IssueSavedSearchView_scope_name_key/);

  await expect(sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "name", "nameKey", "visibility", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId},
      'Private Without Owner', 'private without owner', 'private', ${query}::text::jsonb
    )
  `).rejects.toThrow(/IssueSavedSearchView_private_owner_check/);

  await expect(sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "name", "nameKey", "visibility", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId},
      'Oversized', 'oversized', 'project', ${JSON.stringify({ value: "x".repeat(17_000) })}::text::jsonb
    )
  `).rejects.toThrow(/IssueSavedSearchView_query_size_check/);

  await expect(sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "name", "nameKey", "visibility", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.other.projectId}, ${ctx.other.branchId},
      'Wrong Scope', 'wrong scope', 'project', ${query}::text::jsonb
    )
  `).rejects.toThrow(/IssueSavedSearchView_tenancy_scope_fkey/);

  await expect(sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "name", "nameKey", "visibility", "ownerUserId", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId},
      'Wrong Owner Scope', 'wrong owner scope', 'private', ${ctx.other.ownerUserId}::uuid, ${query}::text::jsonb
    )
  `).rejects.toThrow(/IssueSavedSearchView_owner_fkey/);

  await sql`
    INSERT INTO "IssueSavedSearchView" (
      "tenancyId", "projectId", "branchId", "name", "nameKey", "visibility", "query"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId},
      'Project View', 'project view', 'project', ${query}::text::jsonb
    )
  `;

  const rows = await sql<{ visibility: string, ownerUserId: string | null }[]>`
    SELECT "visibility", "ownerUserId"::text AS "ownerUserId"
    FROM "IssueSavedSearchView"
    WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
    ORDER BY "nameKey" COLLATE "C"
  `;
  expect(rows).toEqual([
    { visibility: "private", ownerUserId: ctx.primary.ownerUserId },
    { visibility: "project", ownerUserId: null },
  ]);
};
