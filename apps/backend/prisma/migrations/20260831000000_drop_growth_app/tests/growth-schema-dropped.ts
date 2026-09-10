import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `drop-growth-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Drop Growth migration test', '', false)
  `;

  await sql`
    INSERT INTO "GtmNote" ("projectId", "branchId", "updatedAt", "domain", "category", "title", "body")
    VALUES (${projectId}, 'main', NOW(), 'users', 'audience', 'Legacy GTM note', 'Populated before removal.')
  `;

  const [run] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthAnalysisRun" ("projectId", "branchId", "trigger", "status", "updatedAt")
    VALUES (${projectId}, 'main', 'initial', 'COMPLETED', NOW())
    RETURNING "id"
  `;

  await sql`
    INSERT INTO "GrowthAnalysisPhase" ("runId", "phaseKey", "status", "updatedAt")
    VALUES (${run.id}, 'website-research', 'COMPLETED', NOW())
  `;

  const [interview] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthInterview" ("runId", "projectId", "branchId", "status", "updatedAt")
    VALUES (${run.id}, ${projectId}, 'main', 'pending', NOW())
    RETURNING "id"
  `;

  await sql`
    INSERT INTO "GrowthInterviewQuestion" (
      "interviewId", "orderIndex", "questionKey", "prompt", "options", "updatedAt"
    )
    VALUES (${interview.id}, 0, 'business-goal', 'What is the primary goal?', '[]', NOW())
  `;

  await sql`
    INSERT INTO "GrowthReport" ("runId", "projectId", "branchId", "title", "summary", "contentMd")
    VALUES (${run.id}, ${projectId}, 'main', 'Legacy report', 'Summary', '# Legacy report')
  `;

  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'GtmAction',
        'GtmInsight',
        'GtmNote',
        'GtmOnboarding',
        'GrowthActionItem',
        'GrowthAnalysisPhase',
        'GrowthAnalysisRun',
        'GrowthArtifact',
        'GrowthBrief',
        'GrowthCategoryScore',
        'GrowthChatConversation',
        'GrowthChatMessage',
        'GrowthDailyMetrics',
        'GrowthDelivery',
        'GrowthFinding',
        'GrowthInterview',
        'GrowthInterviewQuestion',
        'GrowthMetricSnapshot',
        'GrowthMilestone',
        'GrowthMilestoneEvent',
        'GrowthOnboarding',
        'GrowthQuizAnswer',
        'GrowthQuizGame',
        'GrowthQuizQuestion',
        'GrowthQuizRound',
        'GrowthReport'
      )
  `;
  expect(tables).toHaveLength(0);

  const enumTypes = await sql<{ typname: string }[]>`
    SELECT type.typname
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = current_schema()
      AND type.typname IN ('GrowthPhaseStatus', 'GrowthRunStatus')
  `;
  expect(enumTypes).toHaveLength(0);

  const projects = await sql<{ id: string }[]>`
    SELECT "id"
    FROM "Project"
    WHERE "id" = ${context.projectId}
  `;
  expect(projects).toEqual([{ id: context.projectId }]);
};
