-- CreateEnum
CREATE TYPE "GrowthRunStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_INTERVIEW', 'COMPOSING_REPORT', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GrowthPhaseStatus" AS ENUM ('PENDING', 'DISPATCHED', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "GrowthOnboarding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "websiteUrl" VARCHAR(2048) NOT NULL,
    "companySummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- NOTE: "isActive" is a hand-written GENERATED ALWAYS AS ... STORED column (Prisma cannot express
-- generated columns; the schema declares it as a dbgenerated() default kept in sync with this
-- expression). It is TRUE while the run is in a non-terminal status and NULL otherwise, so the
-- "GrowthAnalysisRun_active_run" unique index enforces at most one active run per project branch
-- (NULLs never collide) — the same technique as WorkflowRun.isActive.
CREATE TABLE "GrowthAnalysisRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "milestoneEventId" UUID,
    "status" "GrowthRunStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "isActive" BOOLEAN GENERATED ALWAYS AS (
        CASE
            WHEN "status" IN ('PENDING', 'RUNNING', 'AWAITING_INTERVIEW', 'COMPOSING_REPORT') THEN TRUE
            ELSE NULL
        END
    ) STORED,

    CONSTRAINT "GrowthAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthAnalysisPhase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId" UUID NOT NULL,
    "phaseKey" TEXT NOT NULL,
    "status" "GrowthPhaseStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "dispatchedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "eveSessionId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthAnalysisPhase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthFinding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "runId" UUID,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthArtifact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "runId" UUID,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthInterview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messages" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,

    CONSTRAINT "GrowthInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthInterviewQuestion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "interviewId" UUID NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "questionKey" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'single',
    "options" JSONB NOT NULL,
    "allowSkip" BOOLEAN NOT NULL DEFAULT true,
    "origin" TEXT NOT NULL DEFAULT 'planned',
    "answerOptionIds" JSONB,
    "answerFreeText" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthInterviewQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthReport" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "runId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "contentMd" TEXT NOT NULL,
    "sections" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,

    CONSTRAINT "GrowthReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthActionItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "reportId" UUID,
    "briefId" UUID,
    "typeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "watchedMetrics" JSONB NOT NULL,
    "workflowId" TEXT,
    "workflowSource" TEXT,
    "workflowManifest" JSONB,
    "workflowExplanation" TEXT,
    "workflowRollbackNote" TEXT,
    "workflowDeployedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthMetricSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actionItemId" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "GrowthMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthDailyMetrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthDailyMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthBrief" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "summary" TEXT NOT NULL,
    "contentMd" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "briefId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthMilestone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "metricId" TEXT NOT NULL,
    "comparator" TEXT NOT NULL DEFAULT 'gte',
    "threshold" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'armed',
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthMilestoneEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "milestoneId" UUID NOT NULL,
    "reachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metricValue" DOUBLE PRECISION NOT NULL,
    "analysisRunId" UUID,

    CONSTRAINT "GrowthMilestoneEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthOnboarding_projectId_branchId_key" ON "GrowthOnboarding"("projectId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthAnalysisRun_active_run" ON "GrowthAnalysisRun"("projectId", "branchId", "isActive");

-- CreateIndex
CREATE INDEX "GrowthAnalysisRun_projectId_branchId_createdAt_id_idx" ON "GrowthAnalysisRun"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthAnalysisPhase_runId_phaseKey_key" ON "GrowthAnalysisPhase"("runId", "phaseKey");

-- CreateIndex
CREATE INDEX "GrowthFinding_projectId_branchId_kind_createdAt_idx" ON "GrowthFinding"("projectId", "branchId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GrowthFinding_projectId_branchId_createdAt_id_idx" ON "GrowthFinding"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "GrowthArtifact_projectId_branchId_createdAt_id_idx" ON "GrowthArtifact"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthInterview_runId_key" ON "GrowthInterview"("runId");

-- CreateIndex
CREATE INDEX "GrowthInterview_projectId_branchId_idx" ON "GrowthInterview"("projectId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthInterviewQuestion_interviewId_orderIndex_key" ON "GrowthInterviewQuestion"("interviewId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthReport_runId_key" ON "GrowthReport"("runId");

-- CreateIndex
CREATE INDEX "GrowthReport_projectId_branchId_createdAt_id_idx" ON "GrowthReport"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
-- Covers the released-gate lookup ("has this branch published any report?"), which runs once per
-- request on every locked customer growth route.
CREATE INDEX "GrowthReport_projectId_branchId_publishedAt_idx" ON "GrowthReport"("projectId", "branchId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "GrowthActionItem_projectId_branchId_status_createdAt_idx" ON "GrowthActionItem"("projectId", "branchId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GrowthActionItem_projectId_branchId_createdAt_id_idx" ON "GrowthActionItem"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "GrowthMetricSnapshot_actionItemId_capturedAt_idx" ON "GrowthMetricSnapshot"("actionItemId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthDailyMetrics_projectId_branchId_date_key" ON "GrowthDailyMetrics"("projectId", "branchId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthBrief_projectId_branchId_date_key" ON "GrowthBrief"("projectId", "branchId", "date");

-- CreateIndex
CREATE INDEX "GrowthBrief_projectId_branchId_createdAt_id_idx" ON "GrowthBrief"("projectId", "branchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthDelivery_briefId_channel_key" ON "GrowthDelivery"("briefId", "channel");

-- CreateIndex
CREATE INDEX "GrowthMilestone_projectId_branchId_status_idx" ON "GrowthMilestone"("projectId", "branchId", "status");

-- AddForeignKey
ALTER TABLE "GrowthOnboarding" ADD CONSTRAINT "GrowthOnboarding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthAnalysisRun" ADD CONSTRAINT "GrowthAnalysisRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthAnalysisPhase" ADD CONSTRAINT "GrowthAnalysisPhase_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GrowthAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthFinding" ADD CONSTRAINT "GrowthFinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthFinding" ADD CONSTRAINT "GrowthFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GrowthAnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthArtifact" ADD CONSTRAINT "GrowthArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthArtifact" ADD CONSTRAINT "GrowthArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GrowthAnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthInterview" ADD CONSTRAINT "GrowthInterview_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GrowthAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthInterviewQuestion" ADD CONSTRAINT "GrowthInterviewQuestion_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "GrowthInterview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthReport" ADD CONSTRAINT "GrowthReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GrowthAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthActionItem" ADD CONSTRAINT "GrowthActionItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthMetricSnapshot" ADD CONSTRAINT "GrowthMetricSnapshot_actionItemId_fkey" FOREIGN KEY ("actionItemId") REFERENCES "GrowthActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthDailyMetrics" ADD CONSTRAINT "GrowthDailyMetrics_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthBrief" ADD CONSTRAINT "GrowthBrief_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthDelivery" ADD CONSTRAINT "GrowthDelivery_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "GrowthBrief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthMilestone" ADD CONSTRAINT "GrowthMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthMilestoneEvent" ADD CONSTRAINT "GrowthMilestoneEvent_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "GrowthMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

