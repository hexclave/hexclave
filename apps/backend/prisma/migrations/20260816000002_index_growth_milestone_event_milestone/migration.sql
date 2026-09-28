-- Deleting a milestone cascades to its event history. This leading index lets PostgreSQL find the
-- child rows directly instead of scanning every project's milestone events for each parent row.
-- This is intentionally a plain index build: the migration runner keeps an outer transaction open,
-- which makes CREATE INDEX CONCURRENTLY wait for its own old snapshot until statement timeout.
CREATE INDEX "GrowthMilestoneEvent_milestoneId_idx" ON "GrowthMilestoneEvent"("milestoneId");
