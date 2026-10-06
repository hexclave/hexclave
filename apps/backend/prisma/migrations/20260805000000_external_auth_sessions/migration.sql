CREATE TABLE "ExternalAuthMethod" (
    "tenancyId" UUID NOT NULL,
    "authMethodId" UUID NOT NULL,
    "projectUserId" UUID NOT NULL,
    "providerConfigId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalAuthMethod_pkey" PRIMARY KEY ("tenancyId", "authMethodId")
);

CREATE TABLE "ExternalAuthSession" (
    "tenancyId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "externalAuthMethodId" UUID NOT NULL,
    "providerSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalAuthSession_pkey" PRIMARY KEY ("tenancyId", "id")
);

CREATE UNIQUE INDEX "ExternalAuthMethod_tenancyId_providerConfigId_issuer_subjec_key"
    ON "ExternalAuthMethod"("tenancyId", "providerConfigId", "issuer", "subject");

CREATE UNIQUE INDEX "ExternalAuthMethod_tenancyId_authMethodId_projectUserId_key"
    ON "ExternalAuthMethod"("tenancyId", "authMethodId", "projectUserId");

CREATE UNIQUE INDEX "ExternalAuthMethod_tenancyId_projectUserId_providerConfigId_key"
    ON "ExternalAuthMethod"("tenancyId", "projectUserId", "providerConfigId");

CREATE UNIQUE INDEX "ExternalAuthSession_tenancyId_externalAuthMethodId_provider_key"
    ON "ExternalAuthSession"("tenancyId", "externalAuthMethodId", "providerSessionId");

CREATE INDEX "ExternalAuthSession_tenancyId_externalAuthMethodId_createdA_idx"
    ON "ExternalAuthSession"("tenancyId", "externalAuthMethodId", "createdAt");

ALTER TABLE "ExternalAuthMethod"
    ADD CONSTRAINT "ExternalAuthMethod_tenancyId_authMethodId_projectUserId_fkey"
    FOREIGN KEY ("tenancyId", "authMethodId", "projectUserId")
    REFERENCES "AuthMethod"("tenancyId", "id", "projectUserId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExternalAuthSession"
    ADD CONSTRAINT "ExternalAuthSession_tenancyId_externalAuthMethodId_fkey"
    FOREIGN KEY ("tenancyId", "externalAuthMethodId")
    REFERENCES "ExternalAuthMethod"("tenancyId", "authMethodId")
    ON DELETE CASCADE ON UPDATE CASCADE;
