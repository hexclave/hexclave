import fs from "fs";
import path from "path";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const migrationSql = fs.readFileSync(path.join(__dirname, "..", "migration.sql"), "utf8");
  const statements = migrationSql.split("SPLIT_STATEMENT_SENTINEL");
  const schemaRows = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
  const schema = schemaRows[0].schema;
  const executeMigration = async () => {
    for (const statement of statements) {
      await sql.unsafe(statement.replaceAll("/* SCHEMA_NAME_SENTINEL */", `"${schema.replaceAll('"', '""')}"`));
    }
  };

  expect(await sql`
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = idx.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx'
      AND i.indisvalid
      AND i.indisready
  `).toHaveLength(1);

  try {
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "OneTimePurchase_purchasePage_paidAt_idx" ON "OneTimePurchase"("quantity")`);
    const preflight = statements.find((statement) => statement.includes("ALTER INDEX"));
    if (preflight == null) throw new Error("Expected migration preflight.");
    await expect(sql.unsafe(preflight)).rejects.toThrow(/unexpected definition/);

    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "OneTimePurchase_purchasePage_paidAt_idx" ON "OneTimePurchase"("tenancyId", "paidAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NOT NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx')`);
    await executeMigration();
    expect(await sql`
      SELECT 1 FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx_invalid'
    `).toHaveLength(0);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx' AND i.indisvalid AND i.indisready
    `).toHaveLength(1);

    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "OneTimePurchase_purchasePage_paidAt_idx" ON "OneTimePurchase"("tenancyId", "paidAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NOT NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx')`);
    await executeMigration();
    expect(await sql`
      SELECT 1 FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx_invalid'
    `).toHaveLength(0);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx' AND i.indisvalid AND i.indisready
    `).toHaveLength(1);

    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "OneTimePurchase_purchasePage_paidAt_idx_invalid" ON "OneTimePurchase"("tenancyId", "paidAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NOT NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx_invalid')`);
    await executeMigration();
    expect(await sql`
      SELECT 1 FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx_invalid'
    `).toHaveLength(0);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx' AND i.indisvalid AND i.indisready
    `).toHaveLength(1);
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "OneTimePurchase_purchasePage_paidAt_idx_invalid" ON "OneTimePurchase"("tenancyId", "paidAt") INCLUDE ("createdAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NOT NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx_invalid')`);
    await expect(executeMigration()).rejects.toThrow(/refusing to drop it/);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'OneTimePurchase_purchasePage_paidAt_idx_invalid' AND NOT i.indisvalid
    `).toHaveLength(1);
  } finally {
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "OneTimePurchase_purchasePage_paidAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "OneTimePurchase_purchasePage_paidAt_idx" ON "OneTimePurchase"("tenancyId", "paidAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NOT NULL`);
  }
};
