import fs from "fs";
import path from "path";
import type { Sql } from "postgres";
import { expect } from "vitest";

const EXPECTED_INDEXES = new Map([
  ["SubscriptionInvoice_tenancyId_createdAt_idx", "SubscriptionInvoice"],
  ["Subscription_tenancyId_createdAt_idx", "Subscription"],
  ["EmailOutbox_tenancyId_createdAt_idx", "EmailOutbox"],
]);

export const postMigration = async (sql: Sql) => {
  const indexes = await sql`
    SELECT
      index_relation.relname AS index_name,
      table_relation.relname AS table_name,
      pg_get_indexdef(index_relation.oid) AS index_definition,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique,
      index_metadata.indpred IS NULL AS has_no_predicate,
      access_method.amname AS access_method,
      (
        SELECT array_agg(table_attribute.attname::text ORDER BY index_key.ordinality)
        FROM unnest(index_metadata.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attribute_number, ordinality)
        JOIN pg_attribute table_attribute
          ON table_attribute.attrelid = index_metadata.indrelid
          AND table_attribute.attnum = index_key.attribute_number
        WHERE index_key.ordinality <= index_metadata.indnkeyatts
      ) AS key_columns
    FROM pg_index index_metadata
    JOIN pg_class index_relation
      ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class table_relation
      ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE table_namespace.nspname = current_schema()
      AND index_relation.relname IN (
        'SubscriptionInvoice_tenancyId_createdAt_idx',
        'Subscription_tenancyId_createdAt_idx',
        'EmailOutbox_tenancyId_createdAt_idx'
      )
    ORDER BY index_relation.relname
  `;

  expect(indexes).toHaveLength(EXPECTED_INDEXES.size);
  for (const index of indexes) {
    const expectedTable = EXPECTED_INDEXES.get(index.index_name);
    expect(expectedTable).toBeDefined();
    expect(index).toMatchObject({
      table_name: expectedTable,
      indisvalid: true,
      indisready: true,
      indisunique: false,
      has_no_predicate: true,
      access_method: "btree",
      key_columns: ["tenancyId", "createdAt"],
    });
    expect(index.index_definition).toContain('("tenancyId", "createdAt")');
  }

  // Exercise the actual production guards against the failure mode that
  // CREATE INDEX CONCURRENTLY IF NOT EXISTS cannot detect on its own.
  try {
    await sql.unsafe(
      'DROP INDEX CONCURRENTLY IF EXISTS "Subscription_tenancyId_createdAt_idx"',
    );
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY "Subscription_tenancyId_createdAt_idx"
        ON "Subscription"("createdAt", "tenancyId")
    `);

    const migrationSql = fs.readFileSync(
      path.join(__dirname, "..", "migration.sql"),
      "utf8",
    );
    const migrationStatements = migrationSql.split("SPLIT_STATEMENT_SENTINEL");
    const ownershipStatement = migrationStatements[0];
    const preflightStatement = migrationStatements.find((statement) => statement.includes("ALTER INDEX"));
    if (preflightStatement == null) {
      throw new Error("Expected the TV snapshot index migration to contain a preflight statement.");
    }
    const postconditionStatement = migrationStatements.at(-1);
    if (postconditionStatement == null) {
      throw new Error("Expected the TV snapshot index migration to contain a postcondition statement.");
    }

    await expect(sql.unsafe(preflightStatement)).rejects.toThrow(
      /already exists but is invalid or has an unexpected definition/,
    );
    await expect(sql.unsafe(postconditionStatement)).rejects.toThrow(
      /did not finish with the expected valid definition/,
    );

    await sql.unsafe(
      'DROP INDEX CONCURRENTLY IF EXISTS "Subscription_tenancyId_createdAt_idx"',
    );
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY "Subscription_tenancyId_createdAt_idx"
        ON "Subscription"("tenancyId", "createdAt")
    `);
    await sql.unsafe(`
      UPDATE pg_index
      SET indisvalid = false
      WHERE indexrelid = (
        SELECT index_relation.oid
        FROM pg_class index_relation
        JOIN pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        WHERE index_namespace.nspname = current_schema()
          AND index_relation.relname = 'Subscription_tenancyId_createdAt_idx'
      )
    `);

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY "Subscription_tenancyId_createdAt_idx_invalid"
        ON "Subscription"("tenancyId", "createdAt")
    `);
    await sql.unsafe(`
      UPDATE pg_index
      SET indisvalid = false
      WHERE indexrelid = (
        SELECT index_relation.oid
        FROM pg_class index_relation
        JOIN pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        WHERE index_namespace.nspname = current_schema()
          AND index_relation.relname = 'Subscription_tenancyId_createdAt_idx_invalid'
      )
    `);
    const schemaRows = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
    const schema = schemaRows[0].schema;
    for (const statement of migrationStatements) {
      await sql.unsafe(statement.replaceAll(
        "/* SCHEMA_NAME_SENTINEL */",
        `"${schema.replaceAll('"', '""')}"`,
      ));
    }
    const repairedIndexes = await sql`
      SELECT
        index_relation.relname AS index_name,
        index_metadata.indisvalid,
        index_metadata.indisready
      FROM pg_index index_metadata
      JOIN pg_class index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      WHERE index_namespace.nspname = current_schema()
        AND index_relation.relname IN (
          'SubscriptionInvoice_tenancyId_createdAt_idx',
          'Subscription_tenancyId_createdAt_idx',
          'EmailOutbox_tenancyId_createdAt_idx'
        )
      ORDER BY index_relation.relname
    `;
    expect(repairedIndexes).toEqual([
      {
        index_name: "EmailOutbox_tenancyId_createdAt_idx",
        indisvalid: true,
        indisready: true,
      },
      {
        index_name: "SubscriptionInvoice_tenancyId_createdAt_idx",
        indisvalid: true,
        indisready: true,
      },
      {
        index_name: "Subscription_tenancyId_createdAt_idx",
        indisvalid: true,
        indisready: true,
      },
    ]);
    expect(await sql`
      SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      WHERE index_namespace.nspname = current_schema()
        AND index_relation.relname IN (
          'SubscriptionInvoice_tenancyId_createdAt_idx_invalid',
          'Subscription_tenancyId_createdAt_idx_invalid',
          'EmailOutbox_tenancyId_createdAt_idx_invalid'
        )
    `).toHaveLength(0);

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY "Subscription_tenancyId_createdAt_idx_invalid"
        ON "Subscription"("createdAt")
    `);
    await expect(sql.unsafe(ownershipStatement)).rejects.toThrow(
      /unexpected definition; refusing to drop it/,
    );
    expect(await sql`
      SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      WHERE index_namespace.nspname = current_schema()
        AND index_relation.relname = 'Subscription_tenancyId_createdAt_idx_invalid'
    `).toHaveLength(1);
  } finally {
    await sql.unsafe(
      'DROP INDEX CONCURRENTLY IF EXISTS "Subscription_tenancyId_createdAt_idx_invalid"',
    );
    await sql.unsafe(
      'DROP INDEX CONCURRENTLY IF EXISTS "Subscription_tenancyId_createdAt_idx"',
    );
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY "Subscription_tenancyId_createdAt_idx"
        ON "Subscription"("tenancyId", "createdAt")
    `);
  }
};
