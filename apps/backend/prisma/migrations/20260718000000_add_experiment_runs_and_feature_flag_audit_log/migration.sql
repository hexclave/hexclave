-- All tables created here are brand-new (guaranteed empty), so plain CREATE
-- TABLE / CREATE INDEX statements are safe regardless of overall database size
-- — no batching or concurrent index builds needed.
--
-- The folder name still mentions an audit log: an earlier revision of this
-- (never-released) migration also created a FeatureFlagAuditLog table, which
-- was dropped in favor of the general admin audit trail. Migrations are
-- identified by folder name, so it was kept to avoid re-running the file on
-- development databases that had already applied it.

-- CreateEnum
CREATE TYPE "ExperimentRunState" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED');

-- CreateTable
CREATE TABLE "ExperimentRun" (
    "id" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "configRevisionHash" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "state" "ExperimentRunState" NOT NULL DEFAULT 'DRAFT',
    "scheduledStartAt" TIMESTAMP(3),
    "scheduledEndAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExperimentRun_pkey" PRIMARY KEY ("id")
);

-- Small Postgres idempotency ledger; telemetry payloads remain in ClickHouse.
CREATE TABLE "FeatureFlagExposureReceipt" (
    "id" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "evaluationId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "batchPayloadHash" TEXT NOT NULL,
    "ingestionNonce" UUID NOT NULL,
    "processingStartedAt" TIMESTAMP(3),
    "billingNonce" UUID,
    "billingStartedAt" TIMESTAMP(3),
    "billingCompletedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlagExposureReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExperimentRun_project_experiment_createdAt_idx" ON "ExperimentRun"("projectId", "branchId", "experimentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExperimentRun_state_scheduledStartAt_idx" ON "ExperimentRun"("state", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "ExperimentRun_state_scheduledEndAt_idx" ON "ExperimentRun"("state", "scheduledEndAt");

-- Scheduler fairness rotates blocked rows by updatedAt, then preserves stable
-- schedule/id ordering inside the bounded page.
CREATE INDEX "ExperimentRun_schedule_start_rotation_idx" ON "ExperimentRun"("state", "updatedAt", "scheduledStartAt", "id");
CREATE INDEX "ExperimentRun_schedule_end_rotation_idx" ON "ExperimentRun"("state", "updatedAt", "scheduledEndAt", "id");

-- Partial unique index: at most one RUNNING or PAUSED run may exist per
-- project+branch+experiment at any time. This is the database-level backstop
-- for the application-level state machine (concurrent "start" calls can't both
-- succeed), and is not expressible in the Prisma schema.
CREATE UNIQUE INDEX "ExperimentRun_active_run_key" ON "ExperimentRun"("projectId", "branchId", "experimentId") WHERE "state" IN ('RUNNING', 'PAUSED');

-- Different experiment definitions may reference the same feature flag. They
-- must not both become active: the evaluator can serve only one immutable
-- allocation for a flag at a time. Snapshots always store the internal flag id,
-- so the JSONB expression is stable across public-key renames.
CREATE UNIQUE INDEX "ExperimentRun_active_flag_key" ON "ExperimentRun"("projectId", "branchId", ("configSnapshot"->>'flag_id')) WHERE "state" IN ('RUNNING', 'PAUSED');

CREATE UNIQUE INDEX "FeatureFlagExposureReceipt_project_event_key" ON "FeatureFlagExposureReceipt"("projectId", "eventId");
CREATE UNIQUE INDEX "FeatureFlagExposureReceipt_project_evaluation_key" ON "FeatureFlagExposureReceipt"("projectId", "evaluationId");
CREATE INDEX "FeatureFlagExposureReceipt_ingestionNonce_idx" ON "FeatureFlagExposureReceipt"("ingestionNonce");
CREATE INDEX "FeatureFlagExposureReceipt_processingStartedAt_idx" ON "FeatureFlagExposureReceipt"("processingStartedAt");
CREATE INDEX "FeatureFlagExposureReceipt_createdAt_idx" ON "FeatureFlagExposureReceipt"("createdAt");
CREATE INDEX "FeatureFlagExposureReceipt_project_createdAt_idx" ON "FeatureFlagExposureReceipt"("projectId", "branchId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ExperimentRun" ADD CONSTRAINT "ExperimentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeatureFlagExposureReceipt" ADD CONSTRAINT "FeatureFlagExposureReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
