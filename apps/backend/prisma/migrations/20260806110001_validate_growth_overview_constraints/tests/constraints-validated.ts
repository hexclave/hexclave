import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const rows = await sql<{ conname: string, convalidated: boolean }[]>`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'GrowthFinding_category_check',
      'GrowthActionItem_category_check',
      'GrowthCategoryScore_projectId_fkey'
    )
    ORDER BY conname
  `;
  expect(rows).toEqual([
    { conname: "GrowthActionItem_category_check", convalidated: true },
    { conname: "GrowthCategoryScore_projectId_fkey", convalidated: true },
    { conname: "GrowthFinding_category_check", convalidated: true },
  ]);
};
