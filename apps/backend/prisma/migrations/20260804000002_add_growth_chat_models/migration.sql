-- Growth chat storage: project-scoped conversations between a project's admins and the growth
-- assistant, plus their message transcripts.

-- CreateTable
CREATE TABLE "GrowthChatConversation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthChatMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversationId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthChatMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GrowthChatMessage_role_check" CHECK ("role" IN ('user', 'assistant')),
    CONSTRAINT "GrowthChatMessage_position_check" CHECK ("position" >= 0)
);

-- CreateIndex
CREATE INDEX "GrowthChatConversation_projectId_branchId_updatedAt_id_idx" ON "GrowthChatConversation"("projectId", "branchId", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthChatMessage_conversationId_position_key" ON "GrowthChatMessage"("conversationId", "position");

-- AddForeignKey
ALTER TABLE "GrowthChatConversation" ADD CONSTRAINT "GrowthChatConversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthChatMessage" ADD CONSTRAINT "GrowthChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "GrowthChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
