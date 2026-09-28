import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// All four tables in this migration are new, so preMigration only has to prove that the migration
// applies on a database with pre-existing data (a project row) without touching it.
export const preMigration = async (sql: Sql) => {
  const projectId = `growth-quiz-tables-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth quiz models migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;

  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('GrowthQuizGame', 'GrowthQuizQuestion', 'GrowthQuizRound', 'GrowthQuizAnswer')
  `;
  expect(tables.map((row) => row.table_name).sort()).toEqual([
    "GrowthQuizAnswer", "GrowthQuizGame", "GrowthQuizQuestion", "GrowthQuizRound",
  ]);

  const columnsOf = async (table: string) => (await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `).map((row) => row.column_name);

  expect(await columnsOf("GrowthQuizGame")).toEqual([
    "branchId", "createdAt", "gameKey", "generatedByUserId", "generationError", "id", "isPublished",
    "isUnpublished", "metricsAsOf", "projectId", "publishedAt", "publishedByUserId", "questionCount",
    "status", "textSource", "updatedAt",
  ]);
  // The answer columns that used to live on the question row are gone — a question now carries only
  // the prompt and its answer key, and a customer's answer is a row in GrowthQuizAnswer.
  expect(await columnsOf("GrowthQuizQuestion")).toEqual([
    "correctOptionId", "createdAt", "explanation", "factKind", "gameId", "id", "metricId", "options",
    "orderIndex", "questionText", "trueValue", "unit", "updatedAt",
  ]);
  expect(await columnsOf("GrowthQuizRound")).toEqual([
    "bestStreak", "branchId", "completedAt", "correctCount", "createdAt", "gameId", "id", "isActive",
    "playedByUserId", "projectId", "score", "status", "updatedAt",
  ]);
  expect(await columnsOf("GrowthQuizAnswer")).toEqual([
    "answeredAt", "id", "isCorrect", "optionId", "pointsAwarded", "questionId", "roundId",
  ]);

  // A game is insertable with only the columns the code actually supplies; the rest default.
  const [game] = await sql<{ id: string, gameKey: string, status: string, textSource: string }[]>`
    INSERT INTO "GrowthQuizGame" ("projectId", "branchId", "questionCount", "updatedAt")
    VALUES (${projectId}, 'main', 8, NOW())
    RETURNING "id"::text AS id, "gameKey", "status", "textSource"
  `;
  expect(game.gameKey).toBe("know_your_users");
  expect(game.status).toBe("generating");
  expect(game.textSource).toBe("template");

  const [question] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizQuestion" ("gameId", "orderIndex", "metricId", "factKind", "questionText", "explanation", "options", "correctOptionId", "trueValue", "unit", "updatedAt")
    VALUES (${game.id}::uuid, 0, 'new_users', 'window_sum', 'How many?', 'Because.', ${sql.json([{ id: "a", label: "1" }])}, 'a', 1, 'count', NOW())
    RETURNING "id"::text AS id
  `;
  const [round] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizRound" ("gameId", "projectId", "branchId", "updatedAt")
    VALUES (${game.id}::uuid, ${projectId}, 'main', NOW())
    RETURNING "id"::text AS id
  `;
  await sql`
    INSERT INTO "GrowthQuizAnswer" ("roundId", "questionId", "optionId", "isCorrect", "pointsAwarded")
    VALUES (${round.id}::uuid, ${question.id}::uuid, 'a', true, 100)
  `;

  // Deleting the project cascades all the way down: game → question → answer, and game → round.
  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
  for (const table of ["GrowthQuizGame", "GrowthQuizQuestion", "GrowthQuizRound", "GrowthQuizAnswer"]) {
    const leftover = await sql`SELECT 1 FROM ${sql(table)}`;
    expect(leftover.length, `${table} should have been cascaded away`).toBe(0);
  }
};
