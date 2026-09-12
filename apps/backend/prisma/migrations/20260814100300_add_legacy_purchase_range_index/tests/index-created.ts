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

  const probeSchemas = ["cr6_unquoted", "cr6 quoted"];
  try {
    for (const probeSchema of probeSchemas) {
      const quotedSchema = probeSchema === "cr6_unquoted" ? probeSchema : `"${probeSchema}"`;
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await sql.unsafe(`CREATE SCHEMA ${quotedSchema}`);
      await sql.unsafe(`CREATE TYPE ${quotedSchema}."PurchaseCreationSource" AS ENUM ('PURCHASE_PAGE')`);
      await sql.unsafe(`CREATE TABLE ${quotedSchema}."PredicateProbe" ("creationSource" ${quotedSchema}."PurchaseCreationSource")`);
      await sql.unsafe(`CREATE INDEX CONCURRENTLY "PredicateProbe_${probeSchema === "cr6_unquoted" ? "unquoted" : "quoted"}" ON ${quotedSchema}."PredicateProbe" ("creationSource") WHERE "creationSource" = 'PURCHASE_PAGE'::${quotedSchema}."PurchaseCreationSource"`);
    }
    const predicateRows = await sql<{ schema: string, predicate: string }[]>`
      SELECT n.nspname AS schema, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname IN ('cr6_unquoted', 'cr6 quoted')
      ORDER BY n.nspname
    `;
    expect(predicateRows).toHaveLength(2);
    const unquotedPredicate = predicateRows.find((row) => row.schema === "cr6_unquoted")?.predicate;
    const quotedPredicate = predicateRows.find((row) => row.schema === "cr6 quoted")?.predicate;
    if (unquotedPredicate == null || quotedPredicate == null) throw new Error("Predicate probe indexes were not created.");
    const shippedPatterns = [...migrationSql.matchAll(/'([^']*\\\."PurchaseCreationSource"[^']*)'/g)].map((match) => match[1]);
    if (shippedPatterns.length === 0) throw new Error("Could not find the PurchaseCreationSource normalization pattern in migration SQL.");
    const shippedPattern = shippedPatterns[0];
    if (!shippedPatterns.every((pattern) => pattern === shippedPattern)) {
      throw new Error("PurchaseCreationSource normalization patterns differ within migration SQL.");
    }
    const normalize = async (predicate: string) => {
      const rows = await sql<{ normalized: string }[]>`
        SELECT regexp_replace(
          regexp_replace(${predicate}, ${shippedPattern}, '"PurchaseCreationSource"', 'g'),
          '[()\s]',
          '',
          'g'
        ) AS normalized
      `;
      return rows[0].normalized;
    };
    const normalizedUnquoted = await normalize(unquotedPredicate);
    const normalizedQuoted = await normalize(quotedPredicate);
    const normalizedCanonical = await normalize(`"creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource"`);
    expect(unquotedPredicate).toContain('cr6_unquoted."PurchaseCreationSource"');
    expect(normalizedUnquoted).toBe(normalizedQuoted);
    expect(normalizedUnquoted).toBe(normalizedCanonical);
  } finally {
    for (const probeSchema of probeSchemas) {
      const quotedSchema = probeSchema === "cr6_unquoted" ? probeSchema : `"${probeSchema}"`;
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
  }

  expect(await sql`
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = idx.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx'
      AND i.indisvalid
      AND i.indisready
  `).toHaveLength(1);

  try {
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx" ON "OneTimePurchase"("quantity")`);
    const preflight = statements.find((statement) => statement.includes("ALTER INDEX"));
    if (preflight == null) throw new Error("Expected migration preflight.");
    await expect(sql.unsafe(preflight)).rejects.toThrow(/unexpected definition/);

    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx" ON "OneTimePurchase"("tenancyId", "createdAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx')`);
    await executeMigration();
    expect(await sql`
      SELECT 1 FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid'
    `).toHaveLength(0);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx' AND i.indisvalid AND i.indisready
    `).toHaveLength(1);

    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx" ON "OneTimePurchase"("tenancyId", "createdAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx')`);
    await executeMigration();
    expect(await sql`
      SELECT 1 FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid'
    `).toHaveLength(0);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx' AND i.indisvalid AND i.indisready
    `).toHaveLength(1);

    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid" ON "OneTimePurchase"("tenancyId", "createdAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid')`);
    await executeMigration();
    expect(await sql`
      SELECT 1 FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid'
    `).toHaveLength(0);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx' AND i.indisvalid AND i.indisready
    `).toHaveLength(1);
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid" ON "OneTimePurchase"("tenancyId", "createdAt") INCLUDE ("quantity") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid')`);
    await expect(executeMigration()).rejects.toThrow(/refusing to drop it/);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid' AND NOT i.indisvalid
    `).toHaveLength(1);
    // A valid expected-name index with an INCLUDE column is not ours to drop.
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx" ON "OneTimePurchase"("tenancyId", "createdAt") INCLUDE ("quantity") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NULL`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false, indisready = true WHERE indexrelid = (SELECT indexrelid FROM pg_class idx JOIN pg_namespace n ON n.oid = idx.relnamespace JOIN pg_index i ON i.indexrelid = idx.oid WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx')`);
    await expect(executeMigration()).rejects.toThrow(/refusing to drop it/);
    expect(await sql`
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'temp_OneTimePurchase_legacyPurchasePage_createdAt_idx' AND NOT i.indisvalid AND i.indisready
    `).toHaveLength(1);
  } finally {
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx_invalid"');
    await sql.unsafe('DROP INDEX CONCURRENTLY IF EXISTS "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx"');
    await sql.unsafe(`CREATE INDEX CONCURRENTLY "temp_OneTimePurchase_legacyPurchasePage_createdAt_idx" ON "OneTimePurchase"("tenancyId", "createdAt") WHERE "creationSource" = 'PURCHASE_PAGE'::"PurchaseCreationSource" AND "paidAt" IS NULL`);
  }
};
