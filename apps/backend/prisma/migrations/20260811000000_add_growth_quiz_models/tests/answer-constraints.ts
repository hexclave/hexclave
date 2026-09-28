import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-quiz-answers-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth quiz answer migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;

  const [game] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizGame" ("projectId", "branchId", "status", "questionCount", "publishedAt", "updatedAt")
    VALUES (${projectId}, 'main', 'published', 8, NOW(), NOW())
    RETURNING "id"::text AS id
  `;

  const insertQuestion = async (orderIndex: number, overrides?: { questionText?: string, explanation?: string }) => await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizQuestion" ("gameId", "orderIndex", "metricId", "factKind", "questionText", "explanation", "options", "correctOptionId", "trueValue", "unit", "updatedAt")
    VALUES (
      ${game.id}::uuid, ${orderIndex}, 'new_users', 'window_sum',
      ${overrides?.questionText ?? "How many?"}, ${overrides?.explanation ?? "Because."},
      ${sql.json([{ id: "a", label: "1" }, { id: "b", label: "2" }])},
      'a', 42, 'count', NOW()
    )
    RETURNING "id"::text AS id
  `;

  const [question] = await insertQuestion(0);

  // One question per slot in a game: a retried write must collide rather than duplicate the slot.
  await expect(insertQuestion(0)).rejects.toThrow(/GrowthQuizQuestion_gameId_orderIndex_key/);
  await expect(insertQuestion(-1)).rejects.toThrow(/GrowthQuizQuestion_orderIndex_check/);

  // Staff can rewrite the wording during review, but not blank it — an empty prompt renders as a
  // card with four options and no question.
  await expect(insertQuestion(1, { questionText: "   " })).rejects.toThrow(/GrowthQuizQuestion_questionText_check/);
  await expect(insertQuestion(1, { explanation: "" })).rejects.toThrow(/GrowthQuizQuestion_explanation_check/);
  await expect(sql`UPDATE "GrowthQuizQuestion" SET "questionText" = '  ' WHERE "id" = ${question.id}::uuid`)
    .rejects.toThrow(/GrowthQuizQuestion_questionText_check/);

  const [round] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizRound" ("gameId", "projectId", "branchId", "updatedAt")
    VALUES (${game.id}::uuid, ${projectId}, 'main', NOW())
    RETURNING "id"::text AS id
  `;

  const insertAnswer = async (roundId: string, questionId: string, overrides?: { isCorrect?: boolean, pointsAwarded?: number }) => await sql`
    INSERT INTO "GrowthQuizAnswer" ("roundId", "questionId", "optionId", "isCorrect", "pointsAwarded")
    VALUES (${roundId}::uuid, ${questionId}::uuid, 'a', ${overrides?.isCorrect ?? true}, ${overrides?.pointsAwarded ?? 100})
  `;

  await insertAnswer(round.id, question.id);

  // Single-use per round. This index IS the concurrency guard behind submitQuizAnswer — a
  // double-clicked option must collide here rather than score twice.
  await expect(insertAnswer(round.id, question.id)).rejects.toThrow(/GrowthQuizAnswer_roundId_questionId_key/);

  // A wrong answer scores zero; it never subtracts, and it never quietly earns points.
  const [secondQuestion] = await insertQuestion(1);
  await expect(insertAnswer(round.id, secondQuestion.id, { isCorrect: false, pointsAwarded: 100 }))
    .rejects.toThrow(/GrowthQuizAnswer_wrong_scores_zero_check/);
  await expect(insertAnswer(round.id, secondQuestion.id, { isCorrect: true, pointsAwarded: -1 }))
    .rejects.toThrow(/GrowthQuizAnswer_pointsAwarded_check/);
  await insertAnswer(round.id, secondQuestion.id, { isCorrect: false, pointsAwarded: 0 });

  // A second round of the same game answers the same questions independently.
  await sql`UPDATE "GrowthQuizRound" SET "status" = 'completed', "completedAt" = NOW() WHERE "id" = ${round.id}::uuid`;
  const [secondRound] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthQuizRound" ("gameId", "projectId", "branchId", "updatedAt")
    VALUES (${game.id}::uuid, ${projectId}, 'main', NOW())
    RETURNING "id"::text AS id
  `;
  await insertAnswer(secondRound.id, question.id);

  // A completed round must record when it finished — the customer's banner shows it.
  await expect(sql`UPDATE "GrowthQuizRound" SET "status" = 'completed' WHERE "id" = ${secondRound.id}::uuid`)
    .rejects.toThrow(/GrowthQuizRound_completed_check/);
  await expect(sql`UPDATE "GrowthQuizRound" SET "status" = 'in_progress' WHERE "id" = ${secondRound.id}::uuid`)
    .rejects.toThrow(/GrowthQuizRound_status_check/);

  // Dropping a question during review takes its answers with it, so a round can never reference a
  // question that no longer exists.
  await sql`DELETE FROM "GrowthQuizQuestion" WHERE "id" = ${question.id}::uuid`;
  const orphaned = await sql`SELECT 1 FROM "GrowthQuizAnswer" WHERE "questionId" = ${question.id}::uuid`;
  expect(orphaned.length).toBe(0);

  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
};
