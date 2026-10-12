-- CreateEnum
CREATE TYPE "TvPresentationMode" AS ENUM ('GENERAL');

-- CreateEnum
CREATE TYPE "TvFinancialVisibility" AS ENUM ('REDACTED', 'EXACT');

-- CreateTable
CREATE TABLE "TvPresentationProfile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenancyId" UUID NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "normalizedDisplayName" VARCHAR(80) NOT NULL,
    "description" VARCHAR(240) NOT NULL DEFAULT '',
    "mode" "TvPresentationMode" NOT NULL DEFAULT 'GENERAL',
    "defaultDurationSeconds" INTEGER NOT NULL,
    "playlist" JSONB NOT NULL,
    "interruptionPreferences" JSONB NOT NULL,
    "financialVisibility" "TvFinancialVisibility" NOT NULL DEFAULT 'REDACTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TvPresentationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TvPresentationProfile_tenancy_name_key"
ON "TvPresentationProfile"("tenancyId", "normalizedDisplayName");

-- CreateIndex
CREATE INDEX "TvPresentationProfile_tenancy_updatedAt_id_idx"
ON "TvPresentationProfile"("tenancyId", "updatedAt" DESC, "id");

-- AddForeignKey
ALTER TABLE "TvPresentationProfile"
ADD CONSTRAINT "TvPresentationProfile_tenancyId_fkey"
FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
