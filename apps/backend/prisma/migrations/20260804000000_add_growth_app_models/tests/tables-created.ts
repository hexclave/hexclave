import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// All tables in this migration are new, so preMigration only has to prove that the migration applies on a
// database with pre-existing data (a project row) without touching it.
export const preMigration = async (sql: Sql) => {
  const projectId = `growth-models-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth models migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'GrowthOnboarding', 'GrowthAnalysisRun', 'GrowthAnalysisPhase', 'GrowthFinding', 'GrowthArtifact',
        'GrowthInterview', 'GrowthInterviewQuestion', 'GrowthReport', 'GrowthActionItem',
        'GrowthMetricSnapshot', 'GrowthDailyMetrics', 'GrowthBrief', 'GrowthDelivery',
        'GrowthMilestone', 'GrowthMilestoneEvent'
      )
  `;
  expect(tables.map((row) => row.table_name).sort()).toEqual([
    "GrowthActionItem", "GrowthAnalysisPhase", "GrowthAnalysisRun", "GrowthArtifact", "GrowthBrief",
    "GrowthDailyMetrics", "GrowthDelivery", "GrowthFinding", "GrowthInterview", "GrowthInterviewQuestion",
    "GrowthMetricSnapshot", "GrowthMilestone", "GrowthMilestoneEvent", "GrowthOnboarding", "GrowthReport",
  ]);

  // The scheduled-task tables were removed pre-deployment when scheduled tasks migrated to
  // customer workflows — this migration must never create them.
  const scheduledTaskTables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('GrowthScheduledTask', 'GrowthScheduledTaskRun')
  `;
  expect(scheduledTaskTables).toEqual([]);

  // The agent-authored workflow columns on GrowthActionItem (added in the same pre-deployment
  // rework) must all exist and be nullable — an action item without a workflow is the common case.
  const workflowColumns = await sql<{ column_name: string, is_nullable: string }[]>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'GrowthActionItem'
      AND column_name IN (
        'workflowId', 'workflowSource', 'workflowManifest',
        'workflowExplanation', 'workflowRollbackNote', 'workflowDeployedAt'
      )
  `;
  expect(workflowColumns.map((row) => row.column_name).sort()).toEqual([
    "workflowDeployedAt", "workflowExplanation", "workflowId",
    "workflowManifest", "workflowRollbackNote", "workflowSource",
  ]);
  expect(workflowColumns.every((row) => row.is_nullable === "YES")).toBe(true);

  const [run] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthAnalysisRun" ("projectId", "branchId", "trigger", "status", "updatedAt")
    VALUES (${context.projectId}, 'main', 'initial', 'COMPOSING_REPORT', NOW())
    RETURNING "id"::text AS id
  `;

  // The staff release gate on GrowthInterview. The assertion that matters is the boring-looking one:
  // a plan lands HELD. If these columns ever gained a DEFAULT (now() being the tempting one), every
  // generated plan would count as staff-approved and customers would answer questions nobody read.
  const [interview] = await sql<{ releasedAt: Date | null, releasedByUserId: string | null }[]>`
    INSERT INTO "GrowthInterview" ("runId", "projectId", "branchId", "status", "updatedAt")
    VALUES (${run.id}::uuid, ${context.projectId}, 'main', 'pending', NOW())
    RETURNING "releasedAt", "releasedByUserId"
  `;
  expect(interview.releasedAt).toBeNull();
  expect(interview.releasedByUserId).toBeNull();

  const gateColumns = await sql<{ column_name: string, is_nullable: string, data_type: string, column_default: string | null }[]>`
    SELECT column_name, is_nullable, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'GrowthInterview'
      AND column_name IN ('releasedAt', 'releasedByUserId')
    ORDER BY column_name
  `;
  expect(gateColumns).toEqual([
    { column_name: "releasedAt", is_nullable: "YES", data_type: "timestamp without time zone", column_default: null },
    { column_name: "releasedByUserId", is_nullable: "YES", data_type: "text", column_default: null },
  ]);

  // GrowthReport carries no gate of its own — upsertGrowthReport stamps publishedAt on create — but
  // the column stays nullable so unpublishGrowthReport can pull a report back, and a row inserted
  // without it must not acquire a timestamp from the database.
  const [report] = await sql<{ publishedAt: Date | null, publishedByUserId: string | null }[]>`
    INSERT INTO "GrowthReport" ("runId", "projectId", "branchId", "title", "summary", "contentMd")
    VALUES (${run.id}::uuid, ${context.projectId}, 'main', 'Fresh report', 'Just written', '# Report')
    RETURNING "publishedAt", "publishedByUserId"
  `;
  expect(report.publishedAt).toBeNull();
  expect(report.publishedByUserId).toBeNull();

  // And the index the gate's once-per-request lookup rides on.
  const [releaseIndex] = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'GrowthReport_projectId_branchId_publishedAt_idx'
  `;
  expect(releaseIndex).toBeDefined();
  // pg_get_indexdef only quotes identifiers when it has to; both spellings describe the same index.
  expect(releaseIndex.indexdef).toMatch(/\("?projectId"?, "?branchId"?, "?publishedAt"? DESC\)/);

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
};
