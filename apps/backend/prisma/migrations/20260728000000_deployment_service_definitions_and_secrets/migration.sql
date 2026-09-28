-- Two changes that arrive together because the same rework introduced them:
--
-- 1. Service definitions move out of the branch config and into
--    DeploymentService rows (synced from the config file's `services` export by
--    `hexclave deploy`), so the rows gain the definition-only field the config
--    used to hold: the env var definitions. (The config file's `devCommand`
--    deliberately gets no column: it is consumed locally by `hexclave dev` and
--    the backend never acts on it.)
-- 2. ProjectSecret, a per-project write-only store for KMS-encrypted credential
--    values. Deployments' `secret()` env vars are its first consumer, but it is
--    deliberately not scoped or named after them.
--
-- Both tables involved are small (the Deployments app is in alpha), and PG11+
-- adds columns with constant defaults without a table rewrite, so no batching
-- sentinel is needed here.

-- AlterTable
-- definitionSyncedAt and definitionSyncId stay NULL for pre-existing rows on
-- purpose: their definitions lived in the (now-dropped) branch config section
-- and are NOT backfilled here, so deploys must refuse them until a
-- `hexclave deploy` syncs a real definition.
ALTER TABLE "DeploymentService" ADD COLUMN "definitionSyncedAt" TIMESTAMP(3),
ADD COLUMN     "definitionSyncId" UUID,
ADD COLUMN     "env" JSONB NOT NULL DEFAULT '{}';

-- A run-specific, KMS-encrypted list of the sensitive values injected into the
-- build. Build logs are fetched from Vercel on demand, so current project
-- secrets are insufficient for redaction after a value is rotated/deleted, and
-- request-only secret defaults never enter the project secret store at all.
-- Existing runs stay NULL and fail closed when logs are requested.
ALTER TABLE "DeploymentRun" ADD COLUMN "redactionSecretsEncrypted" JSONB;

-- CreateTable
CREATE TABLE "ProjectSecret" (
    "projectId" TEXT NOT NULL,
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "key" TEXT NOT NULL,
    "encrypted" JSONB NOT NULL,

    CONSTRAINT "ProjectSecret_pkey" PRIMARY KEY ("projectId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSecret_projectId_key_key" ON "ProjectSecret"("projectId", "key");

-- AddForeignKey
ALTER TABLE "ProjectSecret" ADD CONSTRAINT "ProjectSecret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
