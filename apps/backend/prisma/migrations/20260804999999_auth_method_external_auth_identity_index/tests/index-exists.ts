import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  // Simulate the leftover of a previously failed CREATE INDEX CONCURRENTLY run (eg. crash or statement
  // timeout): the index exists but is marked INVALID in the catalog. The migration must drop and rebuild
  // it instead of silently keeping it via IF NOT EXISTS, since an invalid unique index does not enforce
  // uniqueness — which the external-auth race handling relies on.
  await sql`
    CREATE UNIQUE INDEX "AuthMethod_tenancyId_id_projectUserId_key"
      ON "AuthMethod"("tenancyId", "id", "projectUserId")
  `;
  await sql`
    UPDATE pg_index SET indisvalid = false
    WHERE indexrelid = '"AuthMethod_tenancyId_id_projectUserId_key"'::regclass
  `;
  return {};
};

export const postMigration = async (sql: Sql) => {
  const indexes = await sql<{ indexname: string, indisvalid: boolean, indisready: boolean }[]>`
    SELECT c.relname AS indexname, i.indisvalid, i.indisready
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'AuthMethod_tenancyId_id_projectUserId_key'
  `;
  expect(Array.from(indexes)).toMatchInlineSnapshot(`
    [
      {
        "indexname": "AuthMethod_tenancyId_id_projectUserId_key",
        "indisready": true,
        "indisvalid": true,
      },
    ]
  `);
};
