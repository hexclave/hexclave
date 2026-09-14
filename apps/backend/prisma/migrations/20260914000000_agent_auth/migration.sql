-- Agent auth: agents register with a project, a user approves the registration
-- on the app's confirm page, and the agent receives its own session on that user.
--
-- AgentAuthAttempt is a new, initially empty table, so plain CREATE TABLE is fine.
-- The unique (tenancyId, claimCode) index is what makes the short claim code safe
-- to look up per project; pollToken is a long random secret and unique globally.
CREATE TABLE "AgentAuthAttempt" (
    "tenancyId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentDescription" TEXT,
    "agentUrl" TEXT,
    "userHint" TEXT,
    "claimCode" TEXT NOT NULL,
    "pollToken" TEXT NOT NULL,
    "anonProjectUserId" UUID,
    "approvedByUserId" UUID,
    "approvedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "refreshToken" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAuthAttempt_pkey" PRIMARY KEY ("tenancyId","id")
);

CREATE UNIQUE INDEX "AgentAuthAttempt_pollToken_key" ON "AgentAuthAttempt"("pollToken");

CREATE UNIQUE INDEX "AgentAuthAttempt_tenancyId_claimCode_key" ON "AgentAuthAttempt"("tenancyId", "claimCode");

CREATE INDEX "AgentAuthAttempt_tenancyId_createdAt_id_idx" ON "AgentAuthAttempt"("tenancyId", "createdAt" DESC, "id" DESC);

-- Nullable column without a default: metadata-only change on Postgres, no table
-- rewrite even with millions of ProjectUserRefreshToken rows. Existing sessions
-- are all non-agent sessions, which NULL correctly represents.
ALTER TABLE "ProjectUserRefreshToken" ADD COLUMN "agentName" TEXT;
