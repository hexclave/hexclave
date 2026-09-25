import type { Sql } from "postgres";
import { expect } from "vitest";
import { createWorkflowTestTenancy } from "../../20260720000000_add_workflows/test-helpers";

// The whole risk of this migration is a deployment that silently changes
// behavior for workflows that already exist: `pausedAt` gates run creation, so
// a non-null default (or a NOT NULL column) would pause every deployed
// workflow the moment the migration lands.

export const preMigration = async (sql: Sql) => {
  const tenancy = await createWorkflowTestTenancy(sql, "Workflow Pause Test");
  await sql`
    INSERT INTO "WorkflowDefinition" ("tenancyId", "workflowId", "displayName", "latestVersion", "updatedAt")
    VALUES (${tenancy.tenancyId}::uuid, 'pre-existing', 'Deployed before pausing existed', 1, NOW())
  `;
  return tenancy;
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const columns = await sql<{ column_name: string, is_nullable: string, column_default: string | null, data_type: string }[]>`
    SELECT column_name, is_nullable, column_default, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'WorkflowDefinition' AND column_name = 'pausedAt'
  `;
  expect(columns).toEqual([{
    column_name: "pausedAt",
    is_nullable: "YES",
    column_default: null,
    data_type: "timestamp without time zone",
  }]);

  // A workflow that predates the migration must come out unpaused.
  const preExisting = await sql<{ workflowId: string, pausedAt: Date | null }[]>`
    SELECT "workflowId", "pausedAt" FROM "WorkflowDefinition"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "workflowId" = 'pre-existing'
  `;
  expect(preExisting).toEqual([{ workflowId: "pre-existing", pausedAt: null }]);

  // So must a workflow inserted afterwards without naming the column — the
  // engine treats NULL as "accepting runs", so an accidental default here
  // would stop new workflows from ever running.
  await sql`
    INSERT INTO "WorkflowDefinition" ("tenancyId", "workflowId", "displayName", "latestVersion", "updatedAt")
    VALUES (${ctx.tenancyId}::uuid, 'created-after', 'Created after the migration', 1, NOW())
  `;
  const createdAfter = await sql<{ pausedAt: Date | null }[]>`
    SELECT "pausedAt" FROM "WorkflowDefinition"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "workflowId" = 'created-after'
  `;
  expect(createdAfter).toEqual([{ pausedAt: null }]);

  // Pausing and resuming round-trip through the column.
  const paused = await sql<{ pausedAt: Date | null }[]>`
    UPDATE "WorkflowDefinition" SET "pausedAt" = NOW()
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "workflowId" = 'pre-existing'
    RETURNING "pausedAt"
  `;
  expect(paused[0].pausedAt).toBeInstanceOf(Date);
  const resumed = await sql<{ pausedAt: Date | null }[]>`
    UPDATE "WorkflowDefinition" SET "pausedAt" = NULL
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "workflowId" = 'pre-existing'
    RETURNING "pausedAt"
  `;
  expect(resumed).toEqual([{ pausedAt: null }]);

  await sql`DELETE FROM "Project" WHERE "id" = ${ctx.projectId}`;
};
