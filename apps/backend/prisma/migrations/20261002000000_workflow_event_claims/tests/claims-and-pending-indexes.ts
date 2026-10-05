import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { Sql } from "postgres";
import { expect } from "vitest";
import { createWorkflowTestTenancy } from "../../20260720000000_add_workflows/test-helpers";

// Two risks. A non-null default on `claimedUntil` would make every event that
// already exists look claimed, stalling dispatch for a lease after the deploy.
// And the indexes only help if they really are partial over unprocessed rows —
// a full index would grow with the processed history and put the backlog scan
// right back.

export const preMigration = async (sql: Sql) => {
  const tenancy = await createWorkflowTestTenancy(sql, "Workflow Event Claims Test");
  const eventId = randomUUID();
  await sql`
    INSERT INTO "WorkflowEvent" ("tenancyId", "id", "type", "payload")
    VALUES (${tenancy.tenancyId}::uuid, ${eventId}::uuid, 'custom.pre-existing', '{}'::jsonb)
  `;
  return { ...tenancy, eventId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const preExisting = await sql<{ claimedUntil: Date | null }[]>`
    SELECT "claimedUntil" FROM "WorkflowEvent"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "id" = ${ctx.eventId}::uuid
  `;
  expect(preExisting).toEqual([{ claimedUntil: null }]);

  const createdAfterId = randomUUID();
  await sql`
    INSERT INTO "WorkflowEvent" ("tenancyId", "id", "type", "payload")
    VALUES (${ctx.tenancyId}::uuid, ${createdAfterId}::uuid, 'custom.created-after', '{}'::jsonb)
  `;
  const createdAfter = await sql<{ claimedUntil: Date | null }[]>`
    SELECT "claimedUntil" FROM "WorkflowEvent"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "id" = ${createdAfterId}::uuid
  `;
  expect(createdAfter).toEqual([{ claimedUntil: null }]);

  const readIndexes = async () => await sql<{ indexname: string, indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname IN ('WorkflowEvent_pending_idx', 'WorkflowEvent_pending_claim_idx')
    ORDER BY indexname
  `;
  const indexes = await readIndexes();
  expect(indexes.map((index) => index.indexname)).toEqual(["WorkflowEvent_pending_claim_idx", "WorkflowEvent_pending_idx"]);
  expect(indexes[0].indexdef).toContain('("claimedUntil", "tenancyId")');
  expect(indexes[0].indexdef).toContain('WHERE (("processedAt" IS NULL) AND ("claimedUntil" IS NOT NULL))');
  expect(indexes[1].indexdef).toContain('("tenancyId", type, "scheduledAt")');
  expect(indexes[1].indexdef).toContain('WHERE ("processedAt" IS NULL)');

  // Re-running after an interrupted concurrent build must replace the invalid
  // remnant rather than keep it (IF NOT EXISTS alone would keep it).
  const migrationSql = fs.readFileSync(path.join(__dirname, "..", "migration.sql"), "utf8");
  const schemaRows = await sql<{ schema: string }[]>`SELECT current_schema() AS schema`;
  const schema = schemaRows[0].schema;
  await sql.unsafe(`
    UPDATE pg_index SET indisvalid = false
    WHERE indexrelid = (
      SELECT idx.oid FROM pg_class idx
      JOIN pg_namespace n ON n.oid = idx.relnamespace
      WHERE n.nspname = current_schema() AND idx.relname = 'WorkflowEvent_pending_idx'
    )
  `);
  for (const statement of migrationSql.split("SPLIT_STATEMENT_SENTINEL")) {
    await sql.unsafe(statement.replaceAll("/* SCHEMA_NAME_SENTINEL */", `"${schema.replaceAll('"', '""')}"`));
  }
  const valid = await sql`
    SELECT 1 FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = idx.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname IN ('WorkflowEvent_pending_idx', 'WorkflowEvent_pending_claim_idx')
      AND i.indisvalid AND i.indisready
  `;
  expect(valid).toHaveLength(2);
};
