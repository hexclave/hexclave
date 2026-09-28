-- Growth games: the staff-curated "How well do you know your users?" quiz.
--
-- A GAME is the reviewed set of questions Hexclave staff publish to one project; a ROUND is one
-- customer playing it. They are separate tables because the review flow needs a "written but not yet
-- visible" state, and because a customer's answers must be storable without touching the answer key.
--
-- All four tables are created empty by this migration, so the CHECK constraints below are added
-- inline rather than split into a NOT VALID migration plus a later VALIDATE CONSTRAINT one (the
-- pattern 20260806110000 / 20260806110001 had to use). Validating a constraint on a table with zero
-- rows is instant and takes no long lock — the split exists to avoid scanning millions of existing
-- rows, and there are none here. Any LATER migration that adds a constraint to these tables must
-- still split.

-- CreateTable
-- NOTE: "isUnpublished" and "isPublished" are hand-written GENERATED ALWAYS AS ... STORED columns
-- (Prisma cannot express generated columns; the schema declares them as dbgenerated() defaults kept
-- in sync with these expressions). Each is TRUE in exactly one phase of the lifecycle and NULL
-- otherwise, so the two unique indexes below enforce "at most one game under review" and "at most
-- one game live" as ordinary unique indexes (NULLs never collide) — the same technique as
-- GrowthAnalysisRun.isActive.
CREATE TABLE "GrowthQuizGame" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "gameKey" TEXT NOT NULL DEFAULT 'know_your_users',
    "status" TEXT NOT NULL DEFAULT 'generating',
    "textSource" TEXT NOT NULL DEFAULT 'template',
    "questionCount" INTEGER NOT NULL,
    "metricsAsOf" TEXT,
    "generatedByUserId" TEXT,
    "publishedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "generationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isUnpublished" BOOLEAN GENERATED ALWAYS AS (
        CASE
            WHEN "status" IN ('generating', 'draft') THEN TRUE
            ELSE NULL
        END
    ) STORED,
    "isPublished" BOOLEAN GENERATED ALWAYS AS (
        CASE
            WHEN "status" = 'published' THEN TRUE
            ELSE NULL
        END
    ) STORED,

    CONSTRAINT "GrowthQuizGame_pkey" PRIMARY KEY ("id"),
    -- The status vocabulary is enforced in the database as well as in the code: a game in an unknown
    -- status would silently fall out of BOTH generated columns, so it would be neither reviewable
    -- nor visible nor blocking the slot — an invisible row, which is the worst possible failure for
    -- a review queue.
    CONSTRAINT "GrowthQuizGame_status_check" CHECK ("status" IN ('generating', 'draft', 'published', 'archived', 'failed')),
    CONSTRAINT "GrowthQuizGame_textSource_check" CHECK ("textSource" IN ('agent', 'template')),
    CONSTRAINT "GrowthQuizGame_questionCount_check" CHECK ("questionCount" > 0),
    -- A published game must record who published it and when. Publishing is the one irreversible-ish
    -- staff action here (it puts words in front of a customer), so it must never be anonymous.
    CONSTRAINT "GrowthQuizGame_published_attribution_check" CHECK (
        "status" <> 'published' OR "publishedAt" IS NOT NULL
    )
);

-- CreateTable
CREATE TABLE "GrowthQuizQuestion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gameId" UUID NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "metricId" TEXT NOT NULL,
    "factKind" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctOptionId" TEXT NOT NULL,
    "trueValue" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthQuizQuestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GrowthQuizQuestion_orderIndex_check" CHECK ("orderIndex" >= 0),
    -- Staff can rewrite the wording during review; they cannot blank it. An empty question renders
    -- as a card with four options and no prompt.
    CONSTRAINT "GrowthQuizQuestion_questionText_check" CHECK (length(btrim("questionText")) > 0),
    CONSTRAINT "GrowthQuizQuestion_explanation_check" CHECK (length(btrim("explanation")) > 0)
);

-- CreateTable
-- One customer playthrough. "isActive" is the same generated-column trick as the two slots above:
-- TRUE while the round is still playable, so a double-clicked "Play" cannot mint two rounds and
-- orphan the first.
CREATE TABLE "GrowthQuizRound" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gameId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "score" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "playedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "isActive" BOOLEAN GENERATED ALWAYS AS (
        CASE
            WHEN "status" = 'ready' THEN TRUE
            ELSE NULL
        END
    ) STORED,

    CONSTRAINT "GrowthQuizRound_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GrowthQuizRound_status_check" CHECK ("status" IN ('ready', 'completed', 'abandoned')),
    CONSTRAINT "GrowthQuizRound_score_check" CHECK ("score" >= 0),
    CONSTRAINT "GrowthQuizRound_correctCount_check" CHECK ("correctCount" >= 0),
    CONSTRAINT "GrowthQuizRound_bestStreak_check" CHECK ("bestStreak" >= 0),
    CONSTRAINT "GrowthQuizRound_completed_check" CHECK ("status" <> 'completed' OR "completedAt" IS NOT NULL)
);

-- CreateTable
-- The existence of a row here IS the record that its question has been answered. There is no
-- "unanswered" row, which is why the customer-facing redaction can key off a simple left join.
CREATE TABLE "GrowthQuizAnswer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "roundId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "optionId" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "pointsAwarded" INTEGER NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthQuizAnswer_pkey" PRIMARY KEY ("id"),
    -- A wrong answer scores zero; it never subtracts.
    CONSTRAINT "GrowthQuizAnswer_pointsAwarded_check" CHECK ("pointsAwarded" >= 0),
    CONSTRAINT "GrowthQuizAnswer_wrong_scores_zero_check" CHECK ("isCorrect" OR "pointsAwarded" = 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthQuizGame_unpublished_slot" ON "GrowthQuizGame"("projectId", "branchId", "gameKey", "isUnpublished");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthQuizGame_published_slot" ON "GrowthQuizGame"("projectId", "branchId", "gameKey", "isPublished");

-- CreateIndex
CREATE INDEX "GrowthQuizGame_projectId_branchId_gameKey_createdAt_id_idx" ON "GrowthQuizGame"("projectId", "branchId", "gameKey", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthQuizQuestion_gameId_orderIndex_key" ON "GrowthQuizQuestion"("gameId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthQuizRound_active_round" ON "GrowthQuizRound"("gameId", "isActive");

-- CreateIndex
CREATE INDEX "GrowthQuizRound_projectId_branchId_createdAt_id_idx" ON "GrowthQuizRound"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
-- Single-use per round: this is the concurrency guard against a double-clicked answer, not just a
-- data-integrity nicety.
CREATE UNIQUE INDEX "GrowthQuizAnswer_roundId_questionId_key" ON "GrowthQuizAnswer"("roundId", "questionId");

-- AddForeignKey
ALTER TABLE "GrowthQuizGame" ADD CONSTRAINT "GrowthQuizGame_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthQuizQuestion" ADD CONSTRAINT "GrowthQuizQuestion_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "GrowthQuizGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthQuizRound" ADD CONSTRAINT "GrowthQuizRound_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "GrowthQuizGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthQuizRound" ADD CONSTRAINT "GrowthQuizRound_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthQuizAnswer" ADD CONSTRAINT "GrowthQuizAnswer_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "GrowthQuizRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthQuizAnswer" ADD CONSTRAINT "GrowthQuizAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "GrowthQuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
