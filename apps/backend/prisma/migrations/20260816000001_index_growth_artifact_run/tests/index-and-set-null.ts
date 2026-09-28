import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-artifact-run-index-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth artifact run index test', '', false)
  `;
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthAnalysisRun" ("projectId", "branchId", "trigger", "updatedAt")
    VALUES (${projectId}, 'main', 'initial', NOW())
    RETURNING "id"::text AS id
  `;
  const linkedArtifactId = randomUUID();
  const unlinkedArtifactId = randomUUID();
  await sql`
    INSERT INTO "GrowthArtifact" ("id", "projectId", "branchId", "runId", "kind", "title", "content")
    VALUES
      (${linkedArtifactId}::uuid, ${projectId}, 'main', ${run.id}::uuid, 'test', 'Linked', 'Content'),
      (${unlinkedArtifactId}::uuid, ${projectId}, 'main', NULL, 'test', 'Unlinked', 'Content')
  `;
  return { projectId, runId: run.id, linkedArtifactId, unlinkedArtifactId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const indexes = await sql<{ indexdef: string }[]>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'GrowthArtifact_runId_idx'
  `;
  expect(indexes).toHaveLength(1);
  expect(indexes[0].indexdef).toMatch(/\("?runId"?\)/);

  await sql`DELETE FROM "GrowthAnalysisRun" WHERE "id" = ${context.runId}::uuid`;
  const artifacts = await sql<{ id: string, runId: string | null }[]>`
    SELECT "id"::text AS id, "runId"::text AS "runId"
    FROM "GrowthArtifact"
    WHERE "id" IN (${context.linkedArtifactId}::uuid, ${context.unlinkedArtifactId}::uuid)
    ORDER BY "id"
  `;
  expect(artifacts).toHaveLength(2);
  expect(artifacts.every((artifact) => artifact.runId === null)).toBe(true);

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
};
