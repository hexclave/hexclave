-- CreateEnum
CREATE TYPE "DataWarehouseStatus" AS ENUM ('PROVISIONING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "DataWarehouse" (
    "tenancyId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "databaseName" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "status" "DataWarehouseStatus" NOT NULL DEFAULT 'PROVISIONING',
    "error" TEXT,
    "encryptedPassword" JSONB,
    "passwordUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "DataWarehouse_pkey" PRIMARY KEY ("tenancyId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataWarehouse_userName_key" ON "DataWarehouse"("userName");

-- AddForeignKey
ALTER TABLE "DataWarehouse" ADD CONSTRAINT "DataWarehouse_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
