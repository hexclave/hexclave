-- Platform-wide switches for the Deployments app, as a singleton row.
--
-- A table of its own rather than a column on ExternalDbSyncMetadata: the two
-- features share nothing but the singleton pattern, and a deployments fusebox
-- living in a table named after the DB-sync pipeline is exactly the confusion an
-- emergency switch must not cause during the incident it exists for.
--
-- `deploymentsEnabled` defaults to true and NO ROW IS INSERTED here: the reader
-- treats a missing row as the defaults, so this migration cannot turn deploys
-- off, and the row appears the first time an operator flips something.
--
-- The unique index is created inline rather than CONCURRENTLY in a migration of
-- its own (as the external-db-sync indexes were): the table is empty by
-- construction, so there is nothing to lock.
CREATE TABLE "DeploymentsPlatformConfig" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "singleton" "BooleanTrue" NOT NULL DEFAULT 'TRUE'::"BooleanTrue",
    "deploymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentsPlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentsPlatformConfig_singleton_key" ON "DeploymentsPlatformConfig"("singleton");
