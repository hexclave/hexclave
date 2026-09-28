import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-quiz-answer-index-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth quiz answer index test', '', false)
  `;
  const [game] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizGame" ("projectId", "branchId", "questionCount", "updatedAt")
    VALUES (${projectId}, 'main', 1, NOW())
    RETURNING "id"::text AS id
  `;
  const [question] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizQuestion" (
      "gameId", "orderIndex", "metricId", "factKind", "questionText", "explanation",
      "options", "correctOptionId", "trueValue", "unit", "updatedAt"
    )
    VALUES (
      ${game.id}::uuid, 0, 'new_users', 'exact', 'How many?', 'One hundred',
      '[{"id":"a","label":"100"}]'::jsonb, 'a', 100, 'count', NOW()
    )
    RETURNING "id"::text AS id
  `;
  const [round] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizRound" ("gameId", "projectId", "branchId", "updatedAt")
    VALUES (${game.id}::uuid, ${projectId}, 'main', NOW())
    RETURNING "id"::text AS id
  `;
  const [answer] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizAnswer" ("roundId", "questionId", "optionId", "isCorrect", "pointsAwarded")
    VALUES (${round.id}::uuid, ${question.id}::uuid, 'a', true, 100)
    RETURNING "id"::text AS id
  `;
  return { projectId, questionId: question.id, answerId: answer.id };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const indexes = await sql<{ indexdef: string }[]>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'GrowthQuizAnswer_questionId_idx'
  `;
  expect(indexes).toHaveLength(1);
  expect(indexes[0].indexdef).toMatch(/\("?questionId"?\)/);

  await sql`DELETE FROM "GrowthQuizQuestion" WHERE "id" = ${context.questionId}::uuid`;
  const answers = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM "GrowthQuizAnswer"
    WHERE "id" = ${context.answerId}::uuid
  `;
  expect(answers).toEqual([{ count: 0 }]);

  await sql`DELETE FROM "Project" WHERE "id" = ${context.projectId}`;
};
