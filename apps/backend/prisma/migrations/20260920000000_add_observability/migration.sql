
-- If a previous attempt's CREATE INDEX CONCURRENTLY crashed mid-build, it
-- leaves an INVALID index behind. IF NOT EXISTS would then skip the rebuild,
-- and the composite foreign keys below would fail with "no unique constraint
-- matching given keys" on every retry, with no way to make progress without
-- manual intervention. Drop such a leftover so the retry rebuilds it. The DROP
-- takes a brief ACCESS EXCLUSIVE lock on Tenancy, but only in the
-- crashed-previous-attempt case; the happy path takes no lock at all.
-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DO $$
DECLARE
  invalid_index_oid oid;
BEGIN
  -- This block runs outside the migration transaction so the invalid-index
  -- cleanup can commit independently. Reapply the transaction-local timeout
  -- here; otherwise a crashed-attempt retry can wait indefinitely for the
  -- ACCESS EXCLUSIVE lock this DROP INDEX requires.
  PERFORM set_config('lock_timeout', '2s', true);
  SELECT i.indexrelid INTO invalid_index_oid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = '/* SCHEMA_NAME_SENTINEL */."Tenancy"'::regclass
    AND c.relname = 'Tenancy_id_projectId_branchId_key'
    AND NOT i.indisvalid;
  IF invalid_index_oid IS NOT NULL THEN
    EXECUTE 'DROP INDEX ' || invalid_index_oid::regclass;
  END IF;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Tenancy_id_projectId_branchId_key"
  ON /* SCHEMA_NAME_SENTINEL */."Tenancy" ("id", "projectId", "branchId");

-- SPLIT_STATEMENT_SENTINEL

-- The FK adds below take brief SHARE ROW EXCLUSIVE locks on hot referenced
-- tables (Tenancy, Project, ProjectUser). Fail fast instead of
-- queueing an exclusive lock request behind long-running production queries
-- for the lifetime of the deploy transaction. SET LOCAL is transaction-scoped,
-- so this covers the rest of this file.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "ReleaseStatus" AS ENUM ('OPEN', 'ARCHIVED');
CREATE TYPE "ReleaseArtifactStatus" AS ENUM ('REGISTERED', 'FINALIZED');

CREATE TABLE "Release" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" VARCHAR(250) NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'OPEN',
    "ref" VARCHAR(250),
    "url" TEXT,
    "data" JSONB,
    "dateAdded" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateStarted" TIMESTAMP(3),
    "dateReleased" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("tenancyId", "id")
);

CREATE TABLE "ReleaseDeployment" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "releaseId" UUID NOT NULL,
    "deploymentKey" VARCHAR(256) NOT NULL,
    "environment" VARCHAR(255) NOT NULL,
    "name" VARCHAR(64),
    "url" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseDeployment_pkey" PRIMARY KEY ("tenancyId", "id")
);

CREATE TABLE "ReleaseCommit" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "releaseId" UUID NOT NULL,
    "repository" VARCHAR(256) NOT NULL,
    "commitSha" VARCHAR(128) NOT NULL,
    "position" INTEGER NOT NULL,
    "message" TEXT,
    "authorName" VARCHAR(256),
    "authorEmail" VARCHAR(320),
    "committedAt" TIMESTAMP(3),
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseCommit_pkey" PRIMARY KEY ("tenancyId", "id")
);

CREATE TABLE "ReleaseArtifact" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "releaseId" UUID NOT NULL,
    "manifestSha256" VARCHAR(64) NOT NULL,
    "dist" VARCHAR(64),
    "environment" VARCHAR(255),
    "status" "ReleaseArtifactStatus" NOT NULL DEFAULT 'REGISTERED',
    "manifestObjectKey" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseArtifact_pkey" PRIMARY KEY ("tenancyId", "id")
);

CREATE TABLE "ReleaseArtifactDebugId" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "releaseArtifactId" UUID NOT NULL,
    "debugId" VARCHAR(36) NOT NULL,
    "codeFile" TEXT NOT NULL,
    "sourceMapFile" TEXT,
    "sourceMapInline" BOOLEAN NOT NULL,
    "bundleSha256" VARCHAR(64) NOT NULL,
    "bundleBytes" INTEGER NOT NULL,
    "sourceMapSha256" VARCHAR(64) NOT NULL,
    "sourceMapBytes" INTEGER NOT NULL,
    "sourceMapGzippedBytes" INTEGER NOT NULL,
    "bundleObjectKey" TEXT,
    "sourceMapObjectKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseArtifactDebugId_pkey" PRIMARY KEY ("tenancyId", "id")
);

CREATE UNIQUE INDEX "Release_tenancyId_version_key" ON "Release"("tenancyId", "version");
CREATE INDEX "Release_scope_dateAdded_idx" ON "Release"("tenancyId", "projectId", "branchId", "dateAdded" DESC, "id" DESC);
CREATE INDEX "Release_tenancyId_status_dateReleased_idx" ON "Release"("tenancyId", "status", "dateReleased");
CREATE UNIQUE INDEX "ReleaseDeployment_tenancyId_deploymentKey_key" ON "ReleaseDeployment"("tenancyId", "deploymentKey");
CREATE INDEX "ReleaseDeployment_release_environment_finishedAt_idx" ON "ReleaseDeployment"("tenancyId", "releaseId", "environment", "finishedAt");
CREATE INDEX "ReleaseDeployment_environment_finishedAt_idx" ON "ReleaseDeployment"("tenancyId", "environment", "finishedAt");
CREATE UNIQUE INDEX "ReleaseCommit_release_repository_sha_key" ON "ReleaseCommit"("tenancyId", "releaseId", "repository", "commitSha");
CREATE UNIQUE INDEX "ReleaseCommit_release_position_key" ON "ReleaseCommit"("tenancyId", "releaseId", "position");
CREATE INDEX "ReleaseCommit_repository_sha_idx" ON "ReleaseCommit"("tenancyId", "repository", "commitSha");
CREATE UNIQUE INDEX "ReleaseArtifact_release_manifest_key" ON "ReleaseArtifact"("tenancyId", "releaseId", "manifestSha256");
CREATE INDEX "ReleaseArtifact_release_environment_dist_idx" ON "ReleaseArtifact"("tenancyId", "releaseId", "environment", "dist", "createdAt");
CREATE UNIQUE INDEX "ReleaseArtifactDebugId_artifact_debugId_key" ON "ReleaseArtifactDebugId"("tenancyId", "releaseArtifactId", "debugId");
CREATE INDEX "ReleaseArtifactDebugId_tenancyId_debugId_idx" ON "ReleaseArtifactDebugId"("tenancyId", "debugId");

CREATE TYPE "IssueStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'IGNORED');
CREATE TYPE "IssueHashState" AS ENUM ('LOCKED');
CREATE TYPE "IssueHashGroupingRole" AS ENUM ('PRIMARY', 'SECONDARY');
CREATE TYPE "IssuePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "IssueOwnerType" AS ENUM ('USER', 'TEAM');
CREATE TYPE "IssueOwnerSource" AS ENUM ('MANUAL', 'OWNERSHIP_RULE', 'CODEOWNERS', 'SUSPECT_COMMIT', 'SEER_SUGGESTED');
CREATE TYPE "IssueActivityType" AS ENUM ('COMMENT', 'STATUS_CHANGED', 'ASSIGNMENT_CHANGED', 'PRIORITY_CHANGED', 'TEAM_CHANGED', 'OWNER_CHANGED', 'SUBSCRIPTION_CHANGED', 'BOOKMARK_CHANGED', 'REGRESSED');
CREATE TYPE "IssueSubjectType" AS ENUM ('USER', 'TEAM');
CREATE TYPE "IssueAlertEventKind" AS ENUM ('NEW', 'REGRESSION', 'OCCURRENCE');
CREATE TYPE "IssueAlertDeliveryState" AS ENUM ('CLAIMED', 'SUPPRESSED', 'ENQUEUED', 'DELIVERED', 'FAILED', 'DROPPED');
CREATE TYPE "IssueAlertDeliveryOutcome" AS ENUM ('NONE', 'COOLDOWN_ACTIVE', 'WORKFLOW_ENQUEUED', 'WORKFLOW_DELIVERED', 'WORKFLOW_FAILED', 'WORKFLOW_DROPPED', 'INVALID_RULE');

CREATE TABLE "Issue" (
    "id" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "shortId" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "culprit" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT true,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "status" "IssueStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "priority" "IssuePriority",
    "statusChangedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "ignoredUntil" TIMESTAMP(3),
    "assigneeUserId" UUID,
    "assignedTeamId" UUID,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "regressedAt" TIMESTAMP(3),
    "timesSeen" BIGINT NOT NULL DEFAULT 0,
    "countersTruncatedAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "serviceName" TEXT,
    "deploymentEnvironmentName" TEXT,
    "firstSeenRelease" TEXT,
    "lastSeenRelease" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("tenancyId","id")
);

CREATE TABLE "IssueHash" (
    "tenancyId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "issueId" UUID NOT NULL,
    "groupingConfigId" TEXT NOT NULL,
    "groupingRole" "IssueHashGroupingRole" NOT NULL,
    "groupingVariant" VARCHAR(32) NOT NULL,
    "groupingProvenance" JSONB NOT NULL,
    "state" "IssueHashState",
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueHash_pkey" PRIMARY KEY ("tenancyId","hash")
);

CREATE TABLE "IssueMaterialization" (
    "tenancyId" UUID NOT NULL,
    "batchId" VARCHAR(512) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcomes" JSONB,
    "webhooksDispatchedAt" TIMESTAMP(3),
    "alertsDispatchedAt" TIMESTAMP(3),

    CONSTRAINT "IssueMaterialization_pkey" PRIMARY KEY ("tenancyId","batchId")
);

CREATE TABLE "IssueRedirect" (
    "tenancyId" UUID NOT NULL,
    "fromIssueId" UUID NOT NULL,
    "toIssueId" UUID NOT NULL,
    "fromShortId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueRedirect_pkey" PRIMARY KEY ("tenancyId","fromIssueId")
);

CREATE TABLE "IssueCounter" (
    "tenancyId" UUID NOT NULL,
    "nextShortId" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "IssueCounter_pkey" PRIMARY KEY ("tenancyId")
);

CREATE TABLE "IssueAlertRule" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ruleKey" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueAlertRule_pkey" PRIMARY KEY ("tenancyId", "id"),
    CONSTRAINT "IssueAlertRule_version_check" CHECK ("version" > 0),
    CONSTRAINT "IssueAlertRule_schemaVersion_check" CHECK ("schemaVersion" > 0),
    CONSTRAINT "IssueAlertRule_config_object_check" CHECK (jsonb_typeof("config") = 'object'),
    CONSTRAINT "IssueAlertRule_config_size_check" CHECK (octet_length("config"::text) <= 65536)
);

CREATE TABLE "IssueAlertCooldownClaim" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ruleId" UUID NOT NULL,
    "cooldownKey" VARCHAR(256) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastClaimedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueAlertCooldownClaim_pkey" PRIMARY KEY ("tenancyId", "id"),
    CONSTRAINT "IssueAlertCooldownClaim_key_check" CHECK (length("cooldownKey") > 0)
);

CREATE TABLE "IssueAlertDelivery" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ruleId" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "occurrenceId" VARCHAR(256) NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "eventKind" "IssueAlertEventKind" NOT NULL,
    "deduplicationKey" VARCHAR(256) NOT NULL,
    "cooldownKey" VARCHAR(256) NOT NULL,
    "cooldownDurationSeconds" INTEGER NOT NULL,
    "cooldownExpiresAt" TIMESTAMP(3),
    "state" "IssueAlertDeliveryState" NOT NULL DEFAULT 'CLAIMED',
    "outcome" "IssueAlertDeliveryOutcome" NOT NULL DEFAULT 'NONE',
    "workflowEventId" UUID,
    "workflowPayload" JSONB,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastError" VARCHAR(8192),
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueuedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueAlertDelivery_pkey" PRIMARY KEY ("tenancyId", "id"),
    CONSTRAINT "IssueAlertDelivery_keys_check" CHECK (length("deduplicationKey") > 0 AND length("cooldownKey") > 0),
    CONSTRAINT "IssueAlertDelivery_cooldown_check" CHECK ("cooldownDurationSeconds" BETWEEN 0 AND 2592000),
    CONSTRAINT "IssueAlertDelivery_attempts_check" CHECK ("attemptCount" >= 0 AND "replayCount" >= 0)
);

CREATE TABLE "ErrorAttachment" (
  "tenancyId" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "eventId" VARCHAR(32) NOT NULL,
  "occurrenceId" VARCHAR(256),
  "idempotencyKey" VARCHAR(256) NOT NULL,
  "filename" VARCHAR(255) NOT NULL,
  "contentType" VARCHAR(255) NOT NULL,
  "attachmentType" VARCHAR(64) NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "storageKey" VARCHAR(1024) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ErrorAttachment_pkey" PRIMARY KEY ("tenancyId", "id"),
  CONSTRAINT "ErrorAttachment_byteLength_check" CHECK ("byteLength" > 0),
  CONSTRAINT "ErrorAttachment_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "IssueOwner" (
  "tenancyId" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "issueId" UUID NOT NULL,
  "ownerType" "IssueOwnerType" NOT NULL,
  "ownerUserId" UUID,
  "ownerTeamId" UUID,
  "source" "IssueOwnerSource" NOT NULL,
  "context" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueOwner_pkey" PRIMARY KEY ("tenancyId", "id"),
  CONSTRAINT "IssueOwner_owner_check" CHECK (
    ("ownerType" = 'USER' AND "ownerUserId" IS NOT NULL AND "ownerTeamId" IS NULL)
    OR ("ownerType" = 'TEAM' AND "ownerUserId" IS NULL AND "ownerTeamId" IS NOT NULL)
  ),
  CONSTRAINT "IssueOwner_context_size_check" CHECK ("context" IS NULL OR pg_column_size("context") <= 65536)
);

CREATE TABLE "IssueActivity" (
  "tenancyId" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "issueId" UUID NOT NULL,
  "actorUserId" UUID,
  "type" "IssueActivityType" NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueActivity_pkey" PRIMARY KEY ("tenancyId", "id"),
  CONSTRAINT "IssueActivity_data_size_check" CHECK (pg_column_size("data") <= 65536)
);

CREATE TABLE "IssueComment" (
  "tenancyId" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "issueId" UUID NOT NULL,
  "authorUserId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueComment_pkey" PRIMARY KEY ("tenancyId", "id"),
  CONSTRAINT "IssueComment_body_size_check" CHECK (char_length("body") BETWEEN 1 AND 10000)
);

CREATE TABLE "IssueSubscription" (
  "tenancyId" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "issueId" UUID NOT NULL,
  "subjectType" "IssueSubjectType" NOT NULL,
  "subjectUserId" UUID,
  "subjectTeamId" UUID,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "reason" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueSubscription_pkey" PRIMARY KEY ("tenancyId", "id"),
  CONSTRAINT "IssueSubscription_subject_check" CHECK (
    ("subjectType" = 'USER' AND "subjectUserId" IS NOT NULL AND "subjectTeamId" IS NULL)
    OR ("subjectType" = 'TEAM' AND "subjectUserId" IS NULL AND "subjectTeamId" IS NOT NULL)
  )
);

CREATE TABLE "IssueBookmark" (
  "tenancyId" UUID NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "issueId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueBookmark_pkey" PRIMARY KEY ("tenancyId", "issueId", "userId")
);

CREATE TABLE "IssueSavedSearchView" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(128) NOT NULL,
    "nameKey" VARCHAR(128) NOT NULL,
    "visibility" VARCHAR(16) NOT NULL,
    "ownerUserId" UUID,
    "query" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueSavedSearchView_pkey" PRIMARY KEY ("tenancyId", "id"),
    CONSTRAINT "IssueSavedSearchView_schemaVersion_check" CHECK ("schemaVersion" > 0),
    CONSTRAINT "IssueSavedSearchView_name_check" CHECK (char_length("name") BETWEEN 1 AND 128),
    CONSTRAINT "IssueSavedSearchView_nameKey_check" CHECK (char_length("nameKey") BETWEEN 1 AND 128 AND "nameKey" = lower("nameKey")),
    CONSTRAINT "IssueSavedSearchView_visibility_check" CHECK ("visibility" IN ('private', 'project')),
    CONSTRAINT "IssueSavedSearchView_private_owner_check" CHECK ("visibility" <> 'private' OR "ownerUserId" IS NOT NULL),
    CONSTRAINT "IssueSavedSearchView_query_object_check" CHECK (jsonb_typeof("query") = 'object'),
    CONSTRAINT "IssueSavedSearchView_query_size_check" CHECK (octet_length("query"::text) <= 16384)
);

CREATE INDEX "Issue_tenancyId_status_lastSeenAt_idx" ON "Issue"("tenancyId", "status", "lastSeenAt");
CREATE INDEX "Issue_tenancyId_lastSeenAt_idx" ON "Issue"("tenancyId", "lastSeenAt");
CREATE INDEX "Issue_tenancyId_status_firstSeenAt_idx" ON "Issue"("tenancyId", "status", "firstSeenAt");
CREATE INDEX "Issue_tenancyId_status_timesSeen_idx" ON "Issue"("tenancyId", "status", "timesSeen");
CREATE UNIQUE INDEX "Issue_tenancyId_shortId_key" ON "Issue"("tenancyId", "shortId");
CREATE INDEX "IssueHash_tenancyId_issueId_idx" ON "IssueHash"("tenancyId", "issueId");
CREATE INDEX "IssueHash_tenancyId_state_idx" ON "IssueHash"("tenancyId", "state");
CREATE INDEX "IssueMaterialization_appliedAt_idx" ON "IssueMaterialization"("appliedAt");
CREATE UNIQUE INDEX "IssueRedirect_tenancyId_fromShortId_key" ON "IssueRedirect"("tenancyId", "fromShortId");

CREATE UNIQUE INDEX "IssueAlertRule_tenancyId_id_scope_key"
  ON "IssueAlertRule" ("tenancyId", "id", "projectId", "branchId");
CREATE UNIQUE INDEX "IssueAlertRule_scope_ruleKey_version_key"
  ON "IssueAlertRule" ("tenancyId", "projectId", "branchId", "ruleKey", "version");
CREATE INDEX "IssueAlertRule_active_scope_idx"
  ON "IssueAlertRule" ("tenancyId", "projectId", "branchId", "enabled", "ruleKey", "version");
CREATE UNIQUE INDEX "IssueAlertCooldownClaim_tenancyId_cooldownKey_key"
  ON "IssueAlertCooldownClaim" ("tenancyId", "cooldownKey");
CREATE UNIQUE INDEX "IssueAlertCooldownClaim_scope_key"
  ON "IssueAlertCooldownClaim" ("tenancyId", "cooldownKey", "projectId", "branchId");
CREATE INDEX "IssueAlertCooldownClaim_scope_expiresAt_idx"
  ON "IssueAlertCooldownClaim" ("tenancyId", "projectId", "branchId", "expiresAt");
CREATE UNIQUE INDEX "IssueAlertDelivery_tenancyId_deduplicationKey_key"
  ON "IssueAlertDelivery" ("tenancyId", "deduplicationKey");
CREATE INDEX "IssueAlertDelivery_retry_idx"
  ON "IssueAlertDelivery" ("tenancyId", "projectId", "branchId", "state", "nextRetryAt");
CREATE INDEX "IssueAlertDelivery_scope_createdAt_idx"
  ON "IssueAlertDelivery" ("tenancyId", "projectId", "branchId", "createdAt");
CREATE INDEX "IssueAlertDelivery_workflowEvent_idx"
  ON "IssueAlertDelivery" ("tenancyId", "workflowEventId");

CREATE UNIQUE INDEX "ErrorAttachment_scope_idempotency_key"
  ON "ErrorAttachment" ("tenancyId", "projectId", "branchId", "idempotencyKey");
CREATE UNIQUE INDEX "ErrorAttachment_scope_event_digest_filename_key"
  ON "ErrorAttachment" ("tenancyId", "projectId", "branchId", "eventId", "sha256", "filename");
CREATE INDEX "ErrorAttachment_scope_event_createdAt_idx"
  ON "ErrorAttachment" ("tenancyId", "projectId", "branchId", "eventId", "createdAt" DESC);

-- NULLS NOT DISTINCT is load-bearing: the owner CHECK constraint guarantees
-- exactly one of ownerUserId/ownerTeamId is NULL on EVERY row, so with default
-- NULLS-DISTINCT semantics this index would never reject anything and the
-- read-then-create mutation path would have no database conflict winner under
-- concurrency. Requires PostgreSQL 15+ (our minimum). Prisma cannot express
-- this clause, so schema.prisma's @@unique is intentionally weaker — the SQL
-- here is authoritative.
CREATE UNIQUE INDEX "IssueOwner_scope_natural_key"
  ON "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "ownerType", "ownerUserId", "ownerTeamId", "source")
  NULLS NOT DISTINCT;
CREATE INDEX "IssueOwner_scope_issue_updatedAt_idx"
  ON "IssueOwner" ("tenancyId", "projectId", "branchId", "issueId", "updatedAt");
CREATE UNIQUE INDEX "IssueActivity_scope_issue_idempotency_key"
  ON "IssueActivity" ("tenancyId", "projectId", "branchId", "issueId", "idempotencyKey");
CREATE INDEX "IssueActivity_scope_issue_occurredAt_idx"
  ON "IssueActivity" ("tenancyId", "projectId", "branchId", "issueId", "occurredAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "IssueComment_scope_issue_idempotency_key"
  ON "IssueComment" ("tenancyId", "projectId", "branchId", "issueId", "idempotencyKey");
CREATE INDEX "IssueComment_scope_issue_createdAt_idx"
  ON "IssueComment" ("tenancyId", "projectId", "branchId", "issueId", "createdAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "IssueSubscription_scope_natural_key"
  ON "IssueSubscription" ("tenancyId", "projectId", "branchId", "issueId", "subjectType", "subjectUserId", "subjectTeamId")
  NULLS NOT DISTINCT;
CREATE INDEX "IssueSubscription_scope_issue_active_idx"
  ON "IssueSubscription" ("tenancyId", "projectId", "branchId", "issueId", "isActive");
CREATE INDEX "IssueBookmark_scope_user_createdAt_idx"
  ON "IssueBookmark" ("tenancyId", "projectId", "branchId", "userId", "createdAt" DESC);

CREATE UNIQUE INDEX "IssueSavedSearchView_scope_name_key"
  ON "IssueSavedSearchView" ("tenancyId", "projectId", "branchId", "nameKey");
CREATE INDEX "IssueSavedSearchView_scope_updatedAt_idx"
  ON "IssueSavedSearchView" ("tenancyId", "projectId", "branchId", "visibility", "ownerUserId", "updatedAt" DESC, "id" DESC);

CREATE TABLE "ErrorIngestClientReport" (
    "tenancyId" UUID NOT NULL,
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "protocol" VARCHAR(32) NOT NULL,
    "bucket" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(256) NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorIngestClientReport_pkey" PRIMARY KEY ("tenancyId", "id"),
    CONSTRAINT "ErrorIngestClientReport_quantity_check" CHECK ("quantity" > 0 AND "quantity" <= 1000000000),
    CONSTRAINT "ErrorIngestClientReport_text_check" CHECK (
      length("protocol") > 0 AND length("bucket") > 0 AND length("reason") > 0 AND length("category") > 0 AND length("idempotencyKey") > 0
    )
);

CREATE UNIQUE INDEX "ErrorIngestClientReport_scope_idempotency_key"
  ON "ErrorIngestClientReport" ("tenancyId", "projectId", "branchId", "idempotencyKey", "bucket", "reason", "category");
CREATE INDEX "ErrorIngestClientReport_scope_reportedAt_idx"
  ON "ErrorIngestClientReport" ("tenancyId", "projectId", "branchId", "reportedAt" DESC, "id" DESC);

ALTER TABLE "Release" ADD CONSTRAINT "Release_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Release" ADD CONSTRAINT "Release_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReleaseDeployment" ADD CONSTRAINT "ReleaseDeployment_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseDeployment" ADD CONSTRAINT "ReleaseDeployment_release_fkey"
  FOREIGN KEY ("tenancyId", "releaseId") REFERENCES "Release"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReleaseCommit" ADD CONSTRAINT "ReleaseCommit_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseCommit" ADD CONSTRAINT "ReleaseCommit_release_fkey"
  FOREIGN KEY ("tenancyId", "releaseId") REFERENCES "Release"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_release_fkey"
  FOREIGN KEY ("tenancyId", "releaseId") REFERENCES "Release"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReleaseArtifactDebugId" ADD CONSTRAINT "ReleaseArtifactDebugId_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReleaseArtifactDebugId" ADD CONSTRAINT "ReleaseArtifactDebugId_artifact_fkey"
  FOREIGN KEY ("tenancyId", "releaseArtifactId") REFERENCES "ReleaseArtifact"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Issue" ADD CONSTRAINT "Issue_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueHash" ADD CONSTRAINT "IssueHash_tenancyId_issueId_fkey" FOREIGN KEY ("tenancyId", "issueId") REFERENCES "Issue"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueHash" ADD CONSTRAINT "IssueHash_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueRedirect" ADD CONSTRAINT "IssueRedirect_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueCounter" ADD CONSTRAINT "IssueCounter_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueAlertRule" ADD CONSTRAINT "IssueAlertRule_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy" ("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueAlertRule" ADD CONSTRAINT "IssueAlertRule_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueAlertCooldownClaim" ADD CONSTRAINT "IssueAlertCooldownClaim_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy" ("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueAlertCooldownClaim" ADD CONSTRAINT "IssueAlertCooldownClaim_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueAlertCooldownClaim" ADD CONSTRAINT "IssueAlertCooldownClaim_rule_scope_fkey"
  FOREIGN KEY ("tenancyId", "ruleId", "projectId", "branchId")
  REFERENCES "IssueAlertRule" ("tenancyId", "id", "projectId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IssueAlertDelivery" ADD CONSTRAINT "IssueAlertDelivery_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy" ("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueAlertDelivery" ADD CONSTRAINT "IssueAlertDelivery_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueAlertDelivery" ADD CONSTRAINT "IssueAlertDelivery_rule_scope_fkey"
  FOREIGN KEY ("tenancyId", "ruleId", "projectId", "branchId")
  REFERENCES "IssueAlertRule" ("tenancyId", "id", "projectId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IssueAlertDelivery" ADD CONSTRAINT "IssueAlertDelivery_issue_fkey"
  FOREIGN KEY ("tenancyId", "issueId")
  REFERENCES "Issue" ("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueAlertDelivery" ADD CONSTRAINT "IssueAlertDelivery_cooldown_scope_fkey"
  FOREIGN KEY ("tenancyId", "cooldownKey", "projectId", "branchId")
  REFERENCES "IssueAlertCooldownClaim" ("tenancyId", "cooldownKey", "projectId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ErrorAttachment" ADD CONSTRAINT "ErrorAttachment_tenancyId_projectId_branchId_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErrorAttachment" ADD CONSTRAINT "ErrorAttachment_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueOwner" ADD CONSTRAINT "IssueOwner_tenancy_scope_fkey" FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueOwner" ADD CONSTRAINT "IssueOwner_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueOwner" ADD CONSTRAINT "IssueOwner_issue_fkey" FOREIGN KEY ("tenancyId", "issueId") REFERENCES "Issue"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueOwner" ADD CONSTRAINT "IssueOwner_user_fkey" FOREIGN KEY ("tenancyId", "ownerUserId") REFERENCES "ProjectUser"("tenancyId", "projectUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueActivity" ADD CONSTRAINT "IssueActivity_tenancy_scope_fkey" FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueActivity" ADD CONSTRAINT "IssueActivity_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueActivity" ADD CONSTRAINT "IssueActivity_issue_fkey" FOREIGN KEY ("tenancyId", "issueId") REFERENCES "Issue"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_tenancy_scope_fkey" FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_issue_fkey" FOREIGN KEY ("tenancyId", "issueId") REFERENCES "Issue"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_author_fkey" FOREIGN KEY ("tenancyId", "authorUserId") REFERENCES "ProjectUser"("tenancyId", "projectUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueSubscription" ADD CONSTRAINT "IssueSubscription_tenancy_scope_fkey" FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueSubscription" ADD CONSTRAINT "IssueSubscription_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueSubscription" ADD CONSTRAINT "IssueSubscription_issue_fkey" FOREIGN KEY ("tenancyId", "issueId") REFERENCES "Issue"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE, not RESTRICT: DELETE ProjectUser is the account-delete path and has
-- no sibling cascade the way DELETE Project does. RESTRICT would 500 that path
-- as soon as the user has an issue subscription. Matches IssueOwner/Comment/Bookmark.
ALTER TABLE "IssueSubscription" ADD CONSTRAINT "IssueSubscription_user_fkey" FOREIGN KEY ("tenancyId", "subjectUserId") REFERENCES "ProjectUser"("tenancyId", "projectUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueBookmark" ADD CONSTRAINT "IssueBookmark_tenancy_scope_fkey" FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy"("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueBookmark" ADD CONSTRAINT "IssueBookmark_project_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueBookmark" ADD CONSTRAINT "IssueBookmark_issue_fkey" FOREIGN KEY ("tenancyId", "issueId") REFERENCES "Issue"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueBookmark" ADD CONSTRAINT "IssueBookmark_user_fkey" FOREIGN KEY ("tenancyId", "userId") REFERENCES "ProjectUser"("tenancyId", "projectUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssueSavedSearchView"
  ADD CONSTRAINT "IssueSavedSearchView_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy" ("id", "projectId", "branchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueSavedSearchView"
  ADD CONSTRAINT "IssueSavedSearchView_project_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueSavedSearchView"
  ADD CONSTRAINT "IssueSavedSearchView_owner_fkey"
  FOREIGN KEY ("tenancyId", "ownerUserId")
  REFERENCES "ProjectUser" ("tenancyId", "projectUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ErrorIngestClientReport" ADD CONSTRAINT "ErrorIngestClientReport_tenancy_scope_fkey"
  FOREIGN KEY ("tenancyId", "projectId", "branchId")
  REFERENCES "Tenancy" ("id", "projectId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErrorIngestClientReport" ADD CONSTRAINT "ErrorIngestClientReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
