import type { Sql } from "postgres";
import { expect } from "vitest";

const growthDocumentTables = ["GrowthActionItem", "GrowthBrief", "GrowthFinding", "GrowthReport"];

async function readDocumentColumns(sql: Sql) {
  return await sql<Array<{ table_name: string, is_nullable: string, column_default: string | null }>>`
    SELECT table_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'document'
      AND table_name IN ('GrowthFinding', 'GrowthReport', 'GrowthActionItem', 'GrowthBrief')
    ORDER BY table_name
  `;
}

export const preMigration = async (sql: Sql) => {
  expect(await readDocumentColumns(sql)).toEqual([]);
};

export const postMigration = async (sql: Sql) => {
  expect(await readDocumentColumns(sql)).toEqual(growthDocumentTables.map((table_name) => ({
    table_name,
    is_nullable: "YES",
    column_default: null,
  })));
};
