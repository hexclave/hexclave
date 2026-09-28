-- GrowthQuizAnswer's existing (roundId, questionId) unique index cannot support the reverse
-- questionId lookup used by the question FK's cascade. Add the reverse leading index explicitly.
-- This is intentionally a plain index build: the migration runner keeps an outer transaction open,
-- which makes CREATE INDEX CONCURRENTLY wait for its own old snapshot until statement timeout.
CREATE INDEX "GrowthQuizAnswer_questionId_idx" ON "GrowthQuizAnswer"("questionId");
