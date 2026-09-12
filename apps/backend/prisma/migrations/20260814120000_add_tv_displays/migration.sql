CREATE TYPE "TvDisplayPairingState" AS ENUM ('PENDING', 'APPROVED', 'CONSUMED', 'REJECTED');

CREATE TABLE "TvDisplay" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenancyId" UUID NOT NULL,
  "profileId" VARCHAR(128) NOT NULL,
  "displayName" VARCHAR(80) NOT NULL,
  "pairedByAdminUserId" UUID NOT NULL,
  "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  "financialVisibilityAcknowledgedAt" TIMESTAMP(3),
  "financialVisibilityAcknowledgedByAdminUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TvDisplay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TvDisplay_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TvDisplay_tenancy_updatedAt_id_idx" ON "TvDisplay"("tenancyId", "updatedAt" DESC, "id");
CREATE INDEX "TvDisplay_profile_assignment_idx" ON "TvDisplay"("tenancyId", "profileId");

CREATE TABLE "TvDisplayPairingChallenge" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "pairingCode" VARCHAR(8) NOT NULL,
  "deviceSecretHash" VARCHAR(64) NOT NULL,
  "state" "TvDisplayPairingState" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastPolledAt" TIMESTAMP(3),
  "invalidAttempts" INTEGER NOT NULL DEFAULT 0,
  "approvedTenancyId" UUID,
  "approvedProfileId" VARCHAR(128),
  "approvedDisplayName" VARCHAR(80),
  "approvedByAdminUserId" UUID,
  "approvedAt" TIMESTAMP(3),
  "financialVisibilityAcknowledgedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TvDisplayPairingChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TvDisplayPairingChallenge_pairingCode_key" ON "TvDisplayPairingChallenge"("pairingCode");
CREATE UNIQUE INDEX "TvDisplayPairingChallenge_deviceSecretHash_key" ON "TvDisplayPairingChallenge"("deviceSecretHash");
CREATE INDEX "TvDisplayPairingChallenge_expiresAt_idx" ON "TvDisplayPairingChallenge"("expiresAt");

CREATE TABLE "TvDisplayCredential" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "displayId" UUID NOT NULL,
  "familyId" UUID NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "parentId" UUID,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "replacementId" UUID,
  CONSTRAINT "TvDisplayCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TvDisplayCredential_displayId_fkey" FOREIGN KEY ("displayId") REFERENCES "TvDisplay"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TvDisplayCredential_tokenHash_key" ON "TvDisplayCredential"("tokenHash");
CREATE INDEX "TvDisplayCredential_family_idx" ON "TvDisplayCredential"("displayId", "familyId", "revokedAt");

CREATE TABLE "TvDisplayPairingRateLimitBucket" (
  "keyHash" VARCHAR(64) NOT NULL,
  "operation" VARCHAR(40) NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TvDisplayPairingRateLimitBucket_pkey" PRIMARY KEY ("keyHash", "operation", "windowStart")
);

CREATE INDEX "TvDisplayPairingRateLimitBucket_expiresAt_idx" ON "TvDisplayPairingRateLimitBucket"("expiresAt");
