-- CreateEnum
CREATE TYPE "TvEventType" AS ENUM (
  'EMAIL_DELIVERY_DEGRADATION',
  'USER_MILESTONE'
);

-- CreateEnum
CREATE TYPE "TvEventPresentationClass" AS ENUM (
  'CELEBRATION',
  'INCIDENT',
  'CRITICAL_INCIDENT'
);

-- CreateEnum
CREATE TYPE "TvEventOccurrenceLifecycle" AS ENUM (
  'OCCURRED',
  'ACTIVE',
  'RESOLVED'
);

-- CreateEnum
CREATE TYPE "TvPresentationSupersededReason" AS ENUM (
  'NEWER_CELEBRATION',
  'EXPIRED_BEFORE_PRESENTATION',
  'POLICY_DISABLED',
  'OCCURRENCE_REPLACED'
);

-- CreateTable
CREATE TABLE "TvEventOccurrence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenancyId" UUID NOT NULL,
  "eventType" "TvEventType" NOT NULL,
  "presentationClass" "TvEventPresentationClass" NOT NULL,
  "lifecycle" "TvEventOccurrenceLifecycle" NOT NULL,
  "deduplicationKey" VARCHAR(200) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "summary" VARCHAR(480) NOT NULL,
  "metricLabel" VARCHAR(80) NOT NULL,
  "metricValue" VARCHAR(120) NOT NULL,
  "expectedRange" VARCHAR(160),
  "sourceLabel" VARCHAR(120) NOT NULL,
  "aggregateEvidence" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "escalatedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TvEventOccurrence_pkey"
    PRIMARY KEY ("tenancyId", "id"),

  CONSTRAINT "TvEventOccurrence_lifecycle_class_check"
    CHECK (
      (
        "presentationClass" = 'CELEBRATION'
        AND "lifecycle" = 'OCCURRED'
        AND "resolvedAt" IS NULL
      )
      OR
      (
        "presentationClass" IN ('INCIDENT', 'CRITICAL_INCIDENT')
        AND (
          ("lifecycle" = 'ACTIVE' AND "resolvedAt" IS NULL)
          OR ("lifecycle" = 'RESOLVED' AND "resolvedAt" IS NOT NULL)
        )
      )
    ),

  CONSTRAINT "TvEventOccurrence_event_type_class_check"
    CHECK (
      (
        "eventType" = 'USER_MILESTONE'
        AND "presentationClass" = 'CELEBRATION'
      )
      OR
      (
        "eventType" = 'EMAIL_DELIVERY_DEGRADATION'
        AND "presentationClass" IN ('INCIDENT', 'CRITICAL_INCIDENT')
      )
    )
);

-- CreateTable
CREATE TABLE "TvEventEvaluatorState" (
  "tenancyId" UUID NOT NULL,
  "evaluatorKey" VARCHAR(100) NOT NULL,
  "nextEvaluationAt" TIMESTAMP(3) NOT NULL,
  "breachCount" INTEGER NOT NULL DEFAULT 0,
  "criticalBreachCount" INTEGER NOT NULL DEFAULT 0,
  "recoveryCount" INTEGER NOT NULL DEFAULT 0,
  "milestoneBaseline" BIGINT,
  "typedState" JSONB NOT NULL,
  "activeOccurrenceId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TvEventEvaluatorState_pkey"
    PRIMARY KEY ("tenancyId", "evaluatorKey")
);

-- CreateTable
CREATE TABLE "TvProfileEventPresentation" (
  "tenancyId" UUID NOT NULL,
  "profileId" VARCHAR(128) NOT NULL,
  "occurrenceId" UUID NOT NULL,
  "takeoverStartedAt" TIMESTAMP(3),
  "takeoverEndsAt" TIMESTAMP(3),
  "highlightExpiresAt" TIMESTAMP(3),
  "animationExpiresAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "supersededReason" "TvPresentationSupersededReason",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TvProfileEventPresentation_pkey"
    PRIMARY KEY ("tenancyId", "profileId", "occurrenceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TvEventOccurrence_tenancy_deduplication_key"
ON "TvEventOccurrence"("tenancyId", "deduplicationKey");

-- CreateIndex
CREATE INDEX "TvEventOccurrence_active_lookup_idx"
ON "TvEventOccurrence"(
  "tenancyId",
  "lifecycle",
  "presentationClass",
  "activatedAt" DESC,
  "id"
);

-- CreateIndex
CREATE INDEX "TvProfileEventPresentation_active_lookup_idx"
ON "TvProfileEventPresentation"(
  "tenancyId",
  "profileId",
  "supersededAt",
  "highlightExpiresAt"
);

-- AddForeignKey
ALTER TABLE "TvEventOccurrence"
ADD CONSTRAINT "TvEventOccurrence_tenancyId_fkey"
FOREIGN KEY ("tenancyId")
REFERENCES "Tenancy"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvEventEvaluatorState"
ADD CONSTRAINT "TvEventEvaluatorState_tenancyId_fkey"
FOREIGN KEY ("tenancyId")
REFERENCES "Tenancy"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvEventEvaluatorState"
ADD CONSTRAINT "TvEventEvaluatorState_activeOccurrence_fkey"
FOREIGN KEY ("tenancyId", "activeOccurrenceId")
REFERENCES "TvEventOccurrence"("tenancyId", "id")
-- Preserve evaluator cadence and typed baseline state if an occurrence is
-- removed, while leaving the required tenancy key intact.
ON DELETE SET NULL ("activeOccurrenceId")
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvProfileEventPresentation"
ADD CONSTRAINT "TvProfileEventPresentation_tenancyId_fkey"
FOREIGN KEY ("tenancyId")
REFERENCES "Tenancy"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TvProfileEventPresentation"
ADD CONSTRAINT "TvProfileEventPresentation_occurrence_fkey"
FOREIGN KEY ("tenancyId", "occurrenceId")
REFERENCES "TvEventOccurrence"("tenancyId", "id")
ON DELETE CASCADE
ON UPDATE CASCADE;
