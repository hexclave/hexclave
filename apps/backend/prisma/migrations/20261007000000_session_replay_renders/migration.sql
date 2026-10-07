-- Session replay → MP4 renders. One row per render request; see
-- src/lib/session-replay-renders for the state machine that advances it.
-- A new table with no backfill, so nothing existing is locked or rewritten.

CREATE TYPE "SessionReplayRenderStatus" AS ENUM ('QUEUED', 'RENDERING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "SessionReplayRender" (
    "id" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "sessionReplayId" UUID NOT NULL,
    "sessionReplaySegmentId" TEXT,
    "status" "SessionReplayRenderStatus" NOT NULL DEFAULT 'QUEUED',
    "options" JSONB NOT NULL,
    "progress" DOUBLE PRECISION,
    "runtime" TEXT,
    "runtimeHandle" JSONB,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "callbackTokenHash" TEXT,
    "outputS3Key" TEXT,
    "outputByteLength" INTEGER,
    "outputWidth" INTEGER,
    "outputHeight" INTEGER,
    "outputDurationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SessionReplayRender_pkey" PRIMARY KEY ("tenancyId","id")
);

-- CreateIndex
CREATE INDEX "SessionReplayRender_tenancyId_sessionReplayId_createdAt_idx" ON "SessionReplayRender"("tenancyId", "sessionReplayId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionReplayRender_status_updatedAt_idx" ON "SessionReplayRender"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "SessionReplayRender" ADD CONSTRAINT "SessionReplayRender_tenancyId_sessionReplayId_fkey" FOREIGN KEY ("tenancyId", "sessionReplayId") REFERENCES "SessionReplay"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionReplayRender" ADD CONSTRAINT "SessionReplayRender_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

