import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// The five stages every write path validates against today (lib/growth/categories.ts).
const JOURNEY_CATEGORIES = ["product", "reach", "conversion", "retention", "revenue"];
// The pre-journey taxonomy. Still readable (normalizeStoredGrowthCategory maps it), so rows holding
// these values must stay valid.
const LEGACY_CATEGORIES = ["acquisition", "activation", "engagement", "content", "ads"];

const insertProject = async (sql: Sql, label: string) => {
  const projectId = `growth-category-${label}-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth category constraint migration test', '', false)
  `;
  return projectId;
};

const insertFinding = (sql: Sql, projectId: string, category: string) => sql`
  INSERT INTO "GrowthFinding" ("projectId", "branchId", "source", "kind", "title", "body", "category")
  VALUES (${projectId}, 'main', 'test', 'note', 'Finding', 'Body', ${category})
`;

const insertActionItem = (sql: Sql, projectId: string, category: string) => sql`
  INSERT INTO "GrowthActionItem" ("projectId", "branchId", "typeId", "title", "description", "watchedMetrics", "category", "updatedAt")
  VALUES (${projectId}, 'main', 'custom', 'Action', 'Description', ${sql.json([])}, ${category}, NOW())
`;

const insertCategoryScore = (sql: Sql, projectId: string, category: string) => sql`
  INSERT INTO "GrowthCategoryScore" ("projectId", "branchId", "category", "score", "updatedAt")
  VALUES (${projectId}, 'main', ${category}, 50, NOW())
`;

export const preMigration = async (sql: Sql) => {
  const projectId = await insertProject(sql, "pre");

  // The bug this migration fixes: the application validates writes against the five-stage journey,
  // but the database still only accepted the old seven-part taxonomy, so publishing a report with a
  // "conversion" action item failed with a 23514 check violation.
  await expect(insertActionItem(sql, projectId, "conversion")).rejects.toThrow(/GrowthActionItem_category_check/);
  await expect(insertFinding(sql, projectId, "product")).rejects.toThrow(/GrowthFinding_category_check/);
  await expect(insertCategoryScore(sql, projectId, "reach")).rejects.toThrow(/GrowthCategoryScore_category_check/);

  // Legacy rows that predate the taxonomy change. These must survive the constraint swap, which is
  // why the widened vocabulary is the union rather than just the five current stages.
  await insertFinding(sql, projectId, "acquisition");
  await insertActionItem(sql, projectId, "engagement");
  await insertCategoryScore(sql, projectId, "ads");

  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;

  // The legacy rows inserted before the swap are untouched and still present.
  const survivors = await sql<{ category: string }[]>`
    SELECT "category" FROM "GrowthFinding" WHERE "projectId" = ${projectId}
  `;
  expect(survivors.map((row) => row.category)).toEqual(["acquisition"]);

  const freshProjectId = await insertProject(sql, "post");

  // Every stage the application can now write is accepted on all three tables.
  for (const category of JOURNEY_CATEGORIES) {
    await insertFinding(sql, freshProjectId, category);
    await insertActionItem(sql, freshProjectId, category);
    await insertCategoryScore(sql, freshProjectId, category);
  }

  // ...and so is every legacy value, so a deployment holding pre-journey rows stays writable while
  // the read-side mapping is still in place.
  for (const category of LEGACY_CATEGORIES) {
    await insertFinding(sql, freshProjectId, category);
    await insertActionItem(sql, freshProjectId, category);
    await insertCategoryScore(sql, freshProjectId, category);
  }

  // Widening is not the same as removing: an unknown value is still rejected by the database, so a
  // faulty backfill or a route that skips schema validation cannot poison the taxonomy.
  await expect(insertFinding(sql, freshProjectId, "general")).rejects.toThrow(/GrowthFinding_category_check/);
  await expect(insertActionItem(sql, freshProjectId, "general")).rejects.toThrow(/GrowthActionItem_category_check/);
  await expect(insertCategoryScore(sql, freshProjectId, "general")).rejects.toThrow(/GrowthCategoryScore_category_check/);

  // The two nullable columns still accept NULL (a finding need not be categorised); the score's
  // column is NOT NULL and must keep rejecting it.
  await insertFinding(sql, freshProjectId, null as unknown as string);
  await expect(insertCategoryScore(sql, freshProjectId, null as unknown as string)).rejects.toThrow(/null value in column "category"/);

  for (const id of [projectId, freshProjectId]) {
    await sql`DELETE FROM "Project" WHERE "id" = ${id}`;
  }
};
