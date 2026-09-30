-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('POSTGRES');

-- CreateEnum
CREATE TYPE "DataSourceStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'FAILED');

-- CreateEnum
CREATE TYPE "DataSourceStreamMode" AS ENUM ('CURSOR', 'CDC');

-- CreateEnum
CREATE TYPE "DataSourceStreamStatus" AS ENUM ('PENDING', 'SNAPSHOTTING', 'ACTIVE', 'FAILED');

-- CreateTable
CREATE TABLE "DataSource" (
    "id" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "type" "DataSourceType" NOT NULL DEFAULT 'POSTGRES',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "sslMode" TEXT NOT NULL DEFAULT 'require',
    "encryptedPassword" JSONB NOT NULL,
    "status" "DataSourceStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "syncIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "capabilities" JSONB,
    "replicationSlotName" TEXT,
    "publicationName" TEXT,
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncFinishedAt" TIMESTAMP(3),

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSourceStream" (
    "id" UUID NOT NULL,
    "dataSourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "schemaName" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "mode" "DataSourceStreamMode" NOT NULL,
    "cursorColumn" TEXT,
    "primaryKeyColumns" TEXT[],
    "destinationTable" TEXT NOT NULL,
    "status" "DataSourceStreamStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "syncCursor" JSONB,
    "rowsSynced" BIGINT NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "DataSourceStream_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataSource_tenancyId_idx" ON "DataSource"("tenancyId");

-- CreateIndex
CREATE INDEX "DataSource_status_lastSyncFinishedAt_idx" ON "DataSource"("status", "lastSyncFinishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DataSourceStream_dataSourceId_schemaName_tableName_key" ON "DataSourceStream"("dataSourceId", "schemaName", "tableName");

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSourceStream" ADD CONSTRAINT "DataSourceStream_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
