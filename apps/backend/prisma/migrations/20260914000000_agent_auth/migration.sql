-- Agent auth reuses the CLI device-flow table: an agent registration is a
-- CliAuthAttempt that also describes the agent and can be denied. All new
-- columns are nullable without defaults, which is a metadata-only change on
-- Postgres (no table rewrite, however many rows exist). Existing CLI rows read
-- back as non-agent attempts (agentName IS NULL) that were never denied.
ALTER TABLE "CliAuthAttempt"
  ADD COLUMN "deniedAt" TIMESTAMP(3),
  ADD COLUMN "agentName" TEXT,
  ADD COLUMN "agentDescription" TEXT,
  ADD COLUMN "agentUrl" TEXT,
  ADD COLUMN "userHint" TEXT;

-- Sessions minted for agents are tagged with the agent's name so they can be
-- told apart from browser sessions in listings. Same metadata-only reasoning.
ALTER TABLE "ProjectUserRefreshToken" ADD COLUMN "agentName" TEXT;
