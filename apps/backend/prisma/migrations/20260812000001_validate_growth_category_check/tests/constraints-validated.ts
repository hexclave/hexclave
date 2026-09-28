import type { Sql } from "postgres";
import { expect } from "vitest";

// 20260812000000 re-added all three constraints NOT VALID, so this pins that they end up validated
// again rather than silently staying in the not-yet-checked state (which would leave rows written
// between the two migrations unverified forever).
export const postMigration = async (sql: Sql) => {
  const rows = await sql<{ conname: string, convalidated: boolean }[]>`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'GrowthFinding_category_check',
      'GrowthActionItem_category_check',
      'GrowthCategoryScore_category_check'
    )
    ORDER BY conname
  `;
  expect(rows).toEqual([
    { conname: "GrowthActionItem_category_check", convalidated: true },
    { conname: "GrowthCategoryScore_category_check", convalidated: true },
    { conname: "GrowthFinding_category_check", convalidated: true },
  ]);
};
