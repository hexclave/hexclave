import fs from "fs";
import path from "path";
import type { Sql } from "postgres";
import { expect } from "vitest";

const INDEX_NAME = "Team_tenancyId_createdAt_teamId_idx";

const getIndexes = async (sql: Sql) => {
  const rows = await sql<{ tablename: string, indisvalid: boolean, indisready: boolean, indexdef: string }[]>`
    SELECT t.relname AS tablename, i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS indexdef
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = ${INDEX_NAME}
  `;
  return rows.map((row) => ({ ...row, indexdef: row.indexdef.replace(/ON \S+\.(".+?")/, "ON $1") }));
};

export const preMigration = async (sql: Sql) => {
  // Simulate the leftover of a previously failed CREATE INDEX CONCURRENTLY run: the index exists but is
  // INVALID. The migration must rebuild it instead of silently keeping it via IF NOT EXISTS, since the
  // planner never uses an invalid index.
  await sql.unsafe(`CREATE INDEX "${INDEX_NAME}" ON "Team"("tenancyId", "createdAt", "teamId")`);
  await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${INDEX_NAME}"'::regclass`);
  return {};
};

export const postMigration = async (sql: Sql) => {
  expect(await getIndexes(sql)).toMatchInlineSnapshot(`
    [
      {
        "indexdef": "CREATE INDEX "Team_tenancyId_createdAt_teamId_idx" ON "Team" USING btree ("tenancyId", "createdAt", "teamId")",
        "indisready": true,
        "indisvalid": true,
        "tablename": "Team",
      },
    ]
  `);

  // The remnant cleanup only drops indexes on Team; a broken same-named index on another table is not ours
  // and must survive a re-run of the migration.
  const migrationSql = fs.readFileSync(path.join(__dirname, "..", "migration.sql"), "utf8");
  const schemaRows = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
  const quotedSchema = `"${schemaRows[0].schema.replaceAll('"', '""')}"`;
  try {
    await sql.unsafe(`DROP INDEX "${INDEX_NAME}"`);
    await sql.unsafe(`CREATE INDEX "${INDEX_NAME}" ON "TeamMember"("tenancyId", "createdAt", "teamId")`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${INDEX_NAME}"'::regclass`);
    for (const statement of migrationSql.split("SPLIT_STATEMENT_SENTINEL")) {
      await sql.unsafe(statement.replaceAll("/* SCHEMA_NAME_SENTINEL */", quotedSchema));
    }
    expect((await getIndexes(sql)).map((index) => [index.tablename, index.indisvalid])).toEqual([["TeamMember", false]]);
  } finally {
    await sql.unsafe(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
    await sql.unsafe(`CREATE INDEX "${INDEX_NAME}" ON "Team"("tenancyId", "createdAt", "teamId")`);
  }
};
