import type { Sql } from "postgres";
import { expect } from "vitest";

async function readAdditionalNotesColumn(sql: Sql) {
  return await sql<Array<{ is_nullable: string, column_default: string | null }>>`
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'GrowthOnboarding'
      AND column_name = 'additionalNotes'
  `;
}

export const preMigration = async (sql: Sql) => {
  expect(await readAdditionalNotesColumn(sql)).toEqual([]);
};

export const postMigration = async (sql: Sql) => {
  expect(await readAdditionalNotesColumn(sql)).toEqual([{ is_nullable: "YES", column_default: null }]);
};
