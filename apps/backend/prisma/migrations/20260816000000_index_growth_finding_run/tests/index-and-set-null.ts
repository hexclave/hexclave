import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-finding-run-index-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth finding run index test', '', false)
  `;
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthAnalysisRun" ("projectId", "branchId", "trigger", "updatedAt")
    VALUES (${projectId}, 'main', 'initial', NOW())
    RETURNING "id"::text AS id
  `;
  const linkedFindingId = randomUUID();
  const unlinkedFindingId = randomUUID();
  await sql`
    INSERT INTO "GrowthFinding" ("id", "projectId", "branchId", "runId", "source", "kind", "title", "body")
    VALUES
      (${linkedFindingId}::uuid, ${projectId}, 'main', ${run.id}::uuid, 'test', 'test', 'Linked', 'Body'),
      (${unlinkedFindingId}::uuid, ${projectId}, 'main', NULL, 'test', 'test', 'Unlinked', 'Body')
  `;
  return { projectId, runId: run.id, linkedFindingId, unlinkedFindingId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const indexes = await sql<{ indexdef: string }[]>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'GrowthFinding_runId_idx'
  `;
  expect(indexes).toHaveLength(1);
  expect(indexes[0].indexdef).toMatch(/\("?runId"?\)/);

  await sql`DELETE FROM "GrowthAnalysisRun" WHERE "id" = ${context.runId}::uuid`;
  const findings = await sql<{ id: string, runId: string | null }[]>`
    SELECT "id"::text AS id, "runId"::text AS "runId"
    FROM "GrowthFinding"
    WHERE "id" IN (${context.linkedFindingId}::uuid, ${context.unlinkedFindingId}::uuid)
    ORDER BY "id"
  `;
  expect(findings).toHaveLength(2);
  expect(findings.every((finding) => finding.runId === null)).toBe(true);

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
};
