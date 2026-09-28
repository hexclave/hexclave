CREATE TABLE "AskHexclaveCall" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transport" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "requestIp" TEXT,
    "requestIpSource" TEXT,
    "userAgent" TEXT,
    "requestHost" TEXT,
    "mcpProtocolVersion" TEXT,
    "modelId" TEXT NOT NULL,
    "stepCount" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "innerToolCalls" JSONB NOT NULL,

    CONSTRAINT "AskHexclaveCall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AskHexclaveCall_transport_check"
      CHECK ("transport" IN ('skill-ask', 'mcp-ask-hexclave')),
    CONSTRAINT "AskHexclaveCall_stepCount_check" CHECK ("stepCount" >= 1),
    CONSTRAINT "AskHexclaveCall_durationMs_check" CHECK ("durationMs" >= 0)
);

CREATE INDEX "AskHexclaveCall_createdAt_id_idx"
  ON "AskHexclaveCall"("createdAt" DESC, "id" DESC);

CREATE INDEX "AskHexclaveCall_transport_createdAt_id_idx"
  ON "AskHexclaveCall"("transport", "createdAt" DESC, "id" DESC);

CREATE INDEX "AskHexclaveCall_conversationId_createdAt_id_idx"
  ON "AskHexclaveCall"("conversationId", "createdAt" ASC, "id" ASC);
