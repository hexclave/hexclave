import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-milestone-event-index-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth milestone event index test', '', false)
  `;
  const [milestone] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthMilestone" ("projectId", "branchId", "metricId", "threshold", "updatedAt")
    VALUES (${projectId}, 'main', 'new_users', 100, NOW())
    RETURNING "id"::text AS id
  `;
  const [event] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthMilestoneEvent" ("milestoneId", "metricValue")
    VALUES (${milestone.id}::uuid, 101)
    RETURNING "id"::text AS id
  `;
  return { projectId, milestoneId: milestone.id, eventId: event.id };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const indexes = await sql<{ indexdef: string }[]>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'GrowthMilestoneEvent_milestoneId_idx'
  `;
  expect(indexes).toHaveLength(1);
  expect(indexes[0].indexdef).toMatch(/\("?milestoneId"?\)/);

  await sql`DELETE FROM "GrowthMilestone" WHERE "id" = ${context.milestoneId}::uuid`;
  const events = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM "GrowthMilestoneEvent"
    WHERE "id" = ${context.eventId}::uuid
  `;
  expect(events).toEqual([{ count: 0 }]);

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
};
