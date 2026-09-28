import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-overview-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth overview migration test', '', false)
  `;
  const findingId = randomUUID();
  const actionId = randomUUID();
  await sql`
    INSERT INTO "GrowthFinding" ("id", "projectId", "branchId", "source", "kind", "title", "body")
    VALUES (${findingId}::uuid, ${projectId}, 'main', 'daily-brief', 'legacy', 'Legacy finding', 'Body')
  `;
  await sql`
    INSERT INTO "GrowthActionItem" (
      "id", "projectId", "branchId", "typeId", "title", "description", "watchedMetrics", "updatedAt"
    ) VALUES (${actionId}::uuid, ${projectId}, 'main', 'custom', 'Legacy action', 'Description', '[]'::jsonb, NOW())
  `;
  return { projectId, findingId, actionId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const legacy = await sql<{ findingCategory: string | null, findingTags: string[], actionCategory: string | null, actionTags: string[] }[]>`
    SELECT f."category" AS "findingCategory", f."tags" AS "findingTags",
           a."category" AS "actionCategory", a."tags" AS "actionTags"
    FROM "GrowthFinding" f, "GrowthActionItem" a
    WHERE f."id" = ${context.findingId}::uuid AND a."id" = ${context.actionId}::uuid
  `;
  expect(legacy).toEqual([{ findingCategory: null, findingTags: [], actionCategory: null, actionTags: [] }]);

  await sql`UPDATE "GrowthFinding" SET "category" = 'acquisition', "tags" = ARRAY['seo'] WHERE "id" = ${context.findingId}::uuid`;
  await sql`UPDATE "GrowthActionItem" SET "category" = 'revenue', "tags" = ARRAY['pricing'] WHERE "id" = ${context.actionId}::uuid`;
  await expect(sql`UPDATE "GrowthFinding" SET "category" = 'unknown' WHERE "id" = ${context.findingId}::uuid`).rejects.toThrow(/GrowthFinding_category_check/);
  await expect(sql`UPDATE "GrowthActionItem" SET "category" = 'unknown' WHERE "id" = ${context.actionId}::uuid`).rejects.toThrow(/GrowthActionItem_category_check/);

  await sql`
    INSERT INTO "GrowthCategoryScore" ("projectId", "branchId", "category", "score", "updatedAt")
    VALUES (${context.projectId}, 'main', 'acquisition', 73, NOW())
  `;
  await expect(sql`
    INSERT INTO "GrowthCategoryScore" ("projectId", "branchId", "category", "score", "updatedAt")
    VALUES (${context.projectId}, 'main', 'acquisition', 60, NOW())
  `).rejects.toThrow();
  await expect(sql`
    INSERT INTO "GrowthCategoryScore" ("projectId", "branchId", "category", "score", "updatedAt")
    VALUES (${context.projectId}, 'other', 'unknown', 50, NOW())
  `).rejects.toThrow(/GrowthCategoryScore_category_check/);
  await expect(sql`
    INSERT INTO "GrowthCategoryScore" ("projectId", "branchId", "category", "score", "updatedAt")
    VALUES (${context.projectId}, 'other', 'ads', 101, NOW())
  `).rejects.toThrow(/GrowthCategoryScore_score_check/);

  const fk = await sql<{ convalidated: boolean }[]>`
    SELECT convalidated FROM pg_constraint WHERE conname = 'GrowthCategoryScore_projectId_fkey'
  `;
  expect(fk).toEqual([{ convalidated: false }]);

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
  const remaining = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "GrowthCategoryScore" WHERE "projectId" = ${context.projectId}
  `;
  expect(remaining).toEqual([{ count: 0 }]);
};
