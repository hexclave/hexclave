-- Drop the removed Growth app's tables in dependency order so no CASCADE can
-- affect schema objects outside the app.
DROP TABLE IF EXISTS "GrowthQuizAnswer";
DROP TABLE IF EXISTS "GrowthQuizRound";
DROP TABLE IF EXISTS "GrowthQuizQuestion";
DROP TABLE IF EXISTS "GrowthQuizGame";

DROP TABLE IF EXISTS "GrowthMetricSnapshot";
DROP TABLE IF EXISTS "GrowthActionItem";
DROP TABLE IF EXISTS "GrowthDelivery";
DROP TABLE IF EXISTS "GrowthBrief";

DROP TABLE IF EXISTS "GrowthInterviewQuestion";
DROP TABLE IF EXISTS "GrowthInterview";
DROP TABLE IF EXISTS "GrowthReport";
DROP TABLE IF EXISTS "GrowthAnalysisPhase";
DROP TABLE IF EXISTS "GrowthFinding";
DROP TABLE IF EXISTS "GrowthArtifact";
DROP TABLE IF EXISTS "GrowthAnalysisRun";

DROP TABLE IF EXISTS "GrowthMilestoneEvent";
DROP TABLE IF EXISTS "GrowthMilestone";
DROP TABLE IF EXISTS "GrowthChatMessage";
DROP TABLE IF EXISTS "GrowthChatConversation";
DROP TABLE IF EXISTS "GrowthDailyMetrics";
DROP TABLE IF EXISTS "GrowthCategoryScore";
DROP TABLE IF EXISTS "GrowthOnboarding";

DROP TABLE IF EXISTS "GtmInsight";
DROP TABLE IF EXISTS "GtmAction";
DROP TABLE IF EXISTS "GtmNote";
DROP TABLE IF EXISTS "GtmOnboarding";

DROP TYPE IF EXISTS "GrowthPhaseStatus";
DROP TYPE IF EXISTS "GrowthRunStatus";
