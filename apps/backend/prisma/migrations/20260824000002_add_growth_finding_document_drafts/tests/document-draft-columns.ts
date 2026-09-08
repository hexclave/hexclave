import type { Sql } from "postgres";
import { expect } from "vitest";

const columns = [
  "documentDraft",
  "documentDraftSourceJson",
  "documentDraftUpdatedAt",
  "documentPublishedAt",
  "documentPublishedByUserId",
];

async function readColumns(sql: Sql) {
  return await sql<{ column_name: string, is_nullable: string }[]>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'GrowthFinding'
      AND column_name IN (
        'documentDraft', 'documentDraftSourceJson', 'documentDraftUpdatedAt',
        'documentPublishedAt', 'documentPublishedByUserId'
      )
    ORDER BY column_name
  `;
}

export const preMigration = async (sql: Sql) => {
  expect(await readColumns(sql)).toEqual([]);
};

export const postMigration = async (sql: Sql) => {
  expect(await readColumns(sql)).toEqual(columns.map((column_name) => ({ column_name, is_nullable: "YES" })));
  const [constraint] = await sql<{ convalidated: boolean }[]>`
    SELECT convalidated FROM pg_constraint
    WHERE conname = 'GrowthFinding_document_draft_pair_check'
  `;
  expect(constraint).toEqual({ convalidated: false });
};
