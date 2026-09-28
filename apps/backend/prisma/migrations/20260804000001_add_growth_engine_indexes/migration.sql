-- Engine-tick scan indexes. The growth tables were created in 20260804000000 (same release train,
-- never deployed separately), so they are empty on every environment this migration can run
-- against — plain CREATE INDEX inside the migration transaction is safe here; no CONCURRENTLY /
-- run-outside-transaction sentinel needed.

-- Every engine sub-step starts from "all runs in an active status".
CREATE INDEX "GrowthAnalysisRun_status_idx" ON "GrowthAnalysisRun"("status");

-- Reaper scan: DISPATCHED/RUNNING phases with stale (or missing) heartbeats.
CREATE INDEX "GrowthAnalysisPhase_status_heartbeatAt_idx" ON "GrowthAnalysisPhase"("status", "heartbeatAt");
