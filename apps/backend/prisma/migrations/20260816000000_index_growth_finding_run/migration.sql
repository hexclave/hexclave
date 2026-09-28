-- GrowthFinding outlives its analysis run, so deleting a run SET NULLs runId. Without this
-- runId-leading index, PostgreSQL scans the entire accumulated findings table for every deleted run.
-- This is intentionally a plain index build: the migration runner keeps an outer transaction open,
-- which makes CREATE INDEX CONCURRENTLY wait for its own old snapshot until statement timeout.
CREATE INDEX "GrowthFinding_runId_idx" ON "GrowthFinding"("runId");
