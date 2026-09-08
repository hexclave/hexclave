import type { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { getGrowthMetricsOverviewBody } from "../metrics-overview";
import { authoredQuestionLeaksAnswer, authorQuizQuestions } from "./quiz-agent";
import { buildQuizFacts, DEFAULT_QUIZ_QUESTION_COUNT } from "./quiz-facts";
import {
  readOptions,
  toAdminWireQuestion,
  toWireGame,
  toWireRoundSummary,
  type QuizQuestionRow,
} from "./quiz-wire";

/**
 * The STAFF side of Growth games: generating a quiz for a customer project, reviewing it, and
 * publishing it.
 *
 * Every function here takes an already-resolved `Tenancy` for the TARGET project. Resolving it —
 * and checking that the caller is a Hexclave platform admin — is `requireGrowthAdminTenancy` in
 * ../admin.ts, at the route boundary. Nothing in this module authorizes anything, exactly like the
 * other admin lib functions it sits alongside.
 */

export const GROWTH_QUIZ_GAME_KEY = "know_your_users";

/** Rounds shown in the admin results block. */
const ADMIN_RESULT_ROUNDS = 10;

type GameSelection = { id: string, status: string };

async function requireGameInTenancy(tenancy: Tenancy, gameId: string) {
  // A non-UUID id can never match a row, but Prisma would turn it into a Postgres cast error (a 500)
  // instead of a clean miss — so pre-check and 404 early.
  if (!isUuid(gameId)) throw new StatusError(404, "Quiz not found.");
  const game = await globalPrismaClient.growthQuizGame.findFirst({
    where: { id: gameId, projectId: tenancy.project.id, branchId: tenancy.branchId },
  });
  if (game == null) throw new StatusError(404, "Quiz not found.");
  return game;
}

/** Draft-only operations refuse anything else: a published game's wording is already in front of a customer. */
function requireDraft(game: GameSelection): void {
  if (game.status !== "draft") {
    throw new StatusError(409, game.status === "published"
      ? "This quiz is already published. Archive it and generate a new one to make changes."
      : "Only a draft quiz can be edited.");
  }
}

/**
 * Generates a fresh draft for the target project.
 *
 * Ordering matters. The game row is inserted FIRST, before the (slow, failure-prone) authoring call,
 * because that insert is what claims the one-draft-per-project slot — doing it last would let two
 * staff members both build a full question set and only then discover the conflict. A crash between
 * the insert and the questions leaves a `generating` game with none, which the next generate call
 * discards.
 */
export async function generateQuizGame(tenancy: Tenancy, options: {
  generatedByUserId: string | null,
  now: Date,
}) {
  const projectId = tenancy.project.id;
  const branchId = tenancy.branchId;

  const overview = await getGrowthMetricsOverviewBody(tenancy, options.now);
  const built = buildQuizFacts(overview, {
    seed: `${projectId}:${branchId}:${options.now.getTime()}`,
    questionCount: DEFAULT_QUIZ_QUESTION_COUNT,
  });
  if (built.status === "insufficient") {
    throw new StatusError(409, `This project doesn't have enough metric history for a quiz yet — ${built.answerableCount} of the ${built.required} questions needed could be asked. Try again once its daily rollup has a couple more weeks of data.`);
  }

  await discardUnreviewedDraft(projectId, branchId);

  let game;
  try {
    game = await globalPrismaClient.growthQuizGame.create({
      data: {
        projectId,
        branchId,
        gameKey: GROWTH_QUIZ_GAME_KEY,
        status: "generating",
        textSource: "template",
        questionCount: built.facts.length,
        metricsAsOf: built.metricsAsOf,
        generatedByUserId: options.generatedByUserId,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StatusError(409, "A draft quiz is already under review for this project. Publish or discard it first.");
    }
    throw error;
  }

  const onboarding = await globalPrismaClient.growthOnboarding.findFirst({
    where: { projectId, branchId },
    select: { websiteUrl: true, companySummary: true, additionalNotes: true },
  });
  const authored = await authorQuizQuestions({
    projectId,
    branchId,
    roundId: game.id,
    facts: built.facts,
    product: {
      websiteUrl: onboarding?.websiteUrl ?? null,
      companySummary: onboarding?.companySummary ?? null,
      additionalNotes: onboarding == null ? null : onboarding.additionalNotes,
    },
  });

  await globalPrismaClient.growthQuizQuestion.createMany({
    data: built.facts.map((fact, orderIndex) => {
      const written = authored?.get(fact.factId);
      return {
        gameId: game.id,
        orderIndex,
        metricId: fact.metricId,
        factKind: fact.kind,
        questionText: written?.text ?? fact.templateText,
        explanation: written?.explanation ?? fact.templateExplanation,
        options: fact.options,
        correctOptionId: fact.correctOptionId,
        trueValue: fact.trueValue,
        unit: fact.unit,
      };
    }),
  });

  await globalPrismaClient.growthQuizGame.update({
    where: { id: game.id },
    data: { status: "draft", textSource: authored == null ? "template" : "agent" },
  });

  return await getAdminGamesBody(tenancy);
}

function isUniqueViolation(error: unknown): boolean {
  // Matched structurally rather than via `instanceof Prisma.PrismaClientKnownRequestError` so this
  // module does not have to import the generated Prisma namespace just for one error check.
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Clears an unreviewed draft so it cannot wedge the review slot forever.
 *
 * "Regenerate" is the common path here: staff looked at a draft, did not like it, and asked for
 * another. Since a draft has never been seen by a customer, replacing it wholesale is safe — unlike
 * a published game, which is archived rather than deleted so its rounds keep their questions.
 */
async function discardUnreviewedDraft(projectId: string, branchId: string): Promise<void> {
  await globalPrismaClient.growthQuizGame.deleteMany({
    where: { projectId, branchId, gameKey: GROWTH_QUIZ_GAME_KEY, status: { in: ["generating", "draft"] } },
  });
}

/**
 * Rewrites one question's prose during review.
 *
 * Only `text` and `explanation` are writable — there is deliberately no path here that touches
 * `options`, `correctOptionId`, or `trueValue`. Those come from real rolled-up rows, and the whole
 * premise of the section is that its numbers are true, so a human must not be able to edit them any
 * more than the agent can.
 *
 * The staff's text goes through the SAME leak check as the agent's, because a person can paste the
 * answer into the question just as easily as a model can — more easily, in fact, since they can see it.
 */
export async function updateQuizQuestion(tenancy: Tenancy, gameId: string, orderIndex: number, input: {
  text: string,
  explanation: string,
}) {
  const game = await requireGameInTenancy(tenancy, gameId);
  requireDraft(game);

  const question = await globalPrismaClient.growthQuizQuestion.findFirst({
    where: { gameId: game.id, orderIndex },
  });
  if (question == null) throw new StatusError(404, "Question not found.");

  const text = input.text.trim();
  const explanation = input.explanation.trim();
  if (text.length === 0 || explanation.length === 0) {
    throw new StatusError(400, "A question needs both a prompt and an explanation.");
  }

  if (authoredQuestionLeaksAnswer(text, {
    // Only `options` is read by the leak check; the rest of the fact shape is not reachable from a
    // stored row and is not needed to answer "does this sentence name one of the options".
    options: readOptions(question.options, question.id),
  })) {
    throw new StatusError(400, "That wording gives the answer away — it contains one of the question's own options.");
  }

  await globalPrismaClient.growthQuizQuestion.update({
    where: { id: question.id },
    data: { questionText: text, explanation },
  });
  return await getAdminGamesBody(tenancy);
}

/**
 * Drops a weak question from a draft.
 *
 * The remaining questions are re-packed so `orderIndex` stays a contiguous 0..n-1 sequence: the
 * customer's play loop treats "answers so far" and "current question index" as the same number, so a
 * gap would make the round unfinishable.
 */
export async function removeQuizQuestion(tenancy: Tenancy, gameId: string, orderIndex: number) {
  const game = await requireGameInTenancy(tenancy, gameId);
  requireDraft(game);

  await retryTransaction(globalPrismaClient, async (tx) => {
    const questions = await tx.growthQuizQuestion.findMany({
      where: { gameId: game.id },
      orderBy: { orderIndex: "asc" },
      select: { id: true, orderIndex: true },
    });
    const target = questions.find((question) => question.orderIndex === orderIndex);
    if (target == null) throw new StatusError(404, "Question not found.");
    if (questions.length <= 1) throw new StatusError(409, "A quiz needs at least one question. Regenerate it instead.");

    await tx.growthQuizQuestion.delete({ where: { id: target.id } });
    // Re-packed in two passes through a negative scratch range: the (gameId, orderIndex) unique
    // index would otherwise collide mid-shift, since question n-1 moves onto n-2's slot while n-2
    // still holds it.
    const remaining = questions.filter((question) => question.id !== target.id);
    for (const [index, question] of remaining.entries()) {
      await tx.growthQuizQuestion.update({ where: { id: question.id }, data: { orderIndex: -(index + 1) } });
    }
    for (const [index, question] of remaining.entries()) {
      await tx.growthQuizQuestion.update({ where: { id: question.id }, data: { orderIndex: index } });
    }
    await tx.growthQuizGame.update({ where: { id: game.id }, data: { questionCount: remaining.length } });
  });

  return await getAdminGamesBody(tenancy);
}

/**
 * Publishes a reviewed draft, archiving whatever was live before it.
 *
 * Both writes are in one transaction because the `GrowthQuizGame_published_slot` unique index
 * forbids two live games — promoting before archiving would violate it, and archiving before
 * promoting would leave the customer with no quiz if the second write failed.
 */
export async function publishQuizGame(tenancy: Tenancy, gameId: string, options: {
  publishedByUserId: string | null,
  now: Date,
}) {
  const game = await requireGameInTenancy(tenancy, gameId);
  requireDraft(game);

  const questionCount = await globalPrismaClient.growthQuizQuestion.count({ where: { gameId: game.id } });
  if (questionCount === 0) throw new StatusError(409, "This quiz has no questions left. Regenerate it before publishing.");

  await retryTransaction(globalPrismaClient, async (tx) => {
    await tx.growthQuizGame.updateMany({
      where: {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        gameKey: GROWTH_QUIZ_GAME_KEY,
        status: "published",
      },
      data: { status: "archived" },
    });
    await tx.growthQuizGame.update({
      where: { id: game.id },
      data: {
        status: "published",
        questionCount,
        publishedAt: options.now,
        publishedByUserId: options.publishedByUserId,
      },
    });
  });

  return await getAdminGamesBody(tenancy);
}

/**
 * Takes the live quiz down. Archived rather than deleted so completed rounds keep the questions they
 * were played against — a score with no questions behind it is not a result, it is a number.
 */
export async function archiveQuizGame(tenancy: Tenancy, gameId: string) {
  const game = await requireGameInTenancy(tenancy, gameId);
  if (game.status !== "published") throw new StatusError(409, "Only a published quiz can be archived.");
  await globalPrismaClient.growthQuizGame.update({ where: { id: game.id }, data: { status: "archived" } });
  return await getAdminGamesBody(tenancy);
}

/**
 * Everything the admin Games card renders: the draft under review, the published game, and how the
 * customer actually did on it.
 *
 * The results are the real product signal here — a question the customer got wrong names a metric
 * they misunderstand, which is worth a finding or an action item on the very same page.
 */
export async function getAdminGamesBody(tenancy: Tenancy) {
  const where = { projectId: tenancy.project.id, branchId: tenancy.branchId, gameKey: GROWTH_QUIZ_GAME_KEY };

  const [draft, published] = await Promise.all([
    globalPrismaClient.growthQuizGame.findFirst({ where: { ...where, status: { in: ["generating", "draft"] } } }),
    globalPrismaClient.growthQuizGame.findFirst({ where: { ...where, status: "published" } }),
  ]);

  const loadQuestions = async (gameId: string): Promise<QuizQuestionRow[]> =>
    await globalPrismaClient.growthQuizQuestion.findMany({ where: { gameId }, orderBy: { orderIndex: "asc" } });

  const [draftQuestions, publishedQuestions] = await Promise.all([
    draft == null ? Promise.resolve([]) : loadQuestions(draft.id),
    published == null ? Promise.resolve([]) : loadQuestions(published.id),
  ]);

  const rounds = published == null ? [] : await globalPrismaClient.growthQuizRound.findMany({
    where: { gameId: published.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ADMIN_RESULT_ROUNDS,
    include: { answers: true },
  });

  return {
    draft: draft == null ? null : {
      ...toWireGame(draft),
      questions: draftQuestions.map(toAdminWireQuestion),
    },
    published: published == null ? null : {
      ...toWireGame(published),
      questions: publishedQuestions.map(toAdminWireQuestion),
    },
    results: rounds.map((round) => {
      const answersByQuestionId = new Map(round.answers.map((answer) => [answer.questionId, answer]));
      return {
        ...toWireRoundSummary(round, publishedQuestions.length),
        // Per-question correctness, in the published game's own order, so the card can line the
        // customer's result up against the question they saw.
        answers: publishedQuestions.map((question) => {
          const answer = answersByQuestionId.get(question.id);
          return {
            order_index: question.orderIndex,
            metric_id: question.metricId,
            answered: answer != null,
            is_correct: answer?.isCorrect ?? null,
          };
        }),
      };
    }),
  };
}
