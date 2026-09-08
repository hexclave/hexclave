import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const [constraint] = await sql<{ convalidated: boolean }[]>`
    SELECT convalidated FROM pg_constraint
    WHERE conname = 'GrowthActionItem_document_draft_pair_check'
  `;
  expect(constraint).toEqual({ convalidated: true });
};
