import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// Proves the migration applies with pre-existing run/phase rows (index build covers them) and that
// those rows stay readable afterwards.
export const preMigration = async (sql: Sql) => {
  const projectId = `growth-engine-indexes-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth engine indexes migration test', '', false)
  `;
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthAnalysisRun" ("projectId", "branchId", "trigger", "status", "updatedAt")
    VALUES (${projectId}, 'main', 'initial', 'RUNNING', NOW())
    RETURNING "id"::text AS id
  `;
  const [phase] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthAnalysisPhase" ("runId", "phaseKey", "status", "heartbeatAt", "updatedAt")
    VALUES (${run.id}::uuid, 'website-research', 'RUNNING', NOW() - INTERVAL '1 hour', NOW())
    RETURNING "id"::text AS id
  `;
  // A phase with a NULL heartbeat too — the composite index must accept NULLs in its second column.
  await sql`
    INSERT INTO "GrowthAnalysisPhase" ("runId", "phaseKey", "status", "updatedAt")
    VALUES (${run.id}::uuid, 'data-analysis', 'DISPATCHED', NOW())
  `;
  return { projectId, runId: run.id, phaseId: phase.id };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const indexes = await sql<{ indexname: string, indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname IN ('GrowthAnalysisRun_status_idx', 'GrowthAnalysisPhase_status_heartbeatAt_idx')
  `;
  const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));
  expect([...byName.keys()].sort()).toEqual(["GrowthAnalysisPhase_status_heartbeatAt_idx", "GrowthAnalysisRun_status_idx"]);
  // pg_get_indexdef only quotes identifiers when needed; both spellings describe the same index.
  expect(byName.get("GrowthAnalysisRun_status_idx")).toMatch(/\("?status"?\)/);
  expect(byName.get("GrowthAnalysisPhase_status_heartbeatAt_idx")).toMatch(/\("?status"?, "?heartbeatAt"?\)/);

  // Pre-existing rows are still readable and covered by the reaper-shaped query.
  const stuckPhases = await sql<{ id: string }[]>`
    SELECT "id"::text AS id
    FROM "GrowthAnalysisPhase"
    WHERE "runId" = ${context.runId}::uuid
      AND "status" = 'RUNNING'
      AND "heartbeatAt" < NOW() - INTERVAL '15 minutes'
  `;
  expect(stuckPhases.map((row) => row.id)).toEqual([context.phaseId]);
  const dispatchedPhases = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "GrowthAnalysisPhase"
    WHERE "runId" = ${context.runId}::uuid AND "status" = 'DISPATCHED' AND "heartbeatAt" IS NULL
  `;
  expect(dispatchedPhases[0].count).toBe("1");

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
};
