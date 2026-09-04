-- CreateTable
CREATE TABLE "AuditLogEvent" (
    "tenancyId" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" UUID,
    "actorLabel" TEXT NOT NULL,
    "targetUserId" UUID NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "AuditLogEvent_pkey" PRIMARY KEY ("tenancyId","id")
);

-- CreateIndex
CREATE INDEX "AuditLogEvent_tenancyId_createdAt_idx" ON "AuditLogEvent"("tenancyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLogEvent_tenancyId_action_createdAt_idx" ON "AuditLogEvent"("tenancyId", "action", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AuditLogEvent" ADD CONSTRAINT "AuditLogEvent_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
