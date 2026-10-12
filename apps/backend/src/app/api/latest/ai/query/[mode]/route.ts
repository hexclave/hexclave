import {
  assertProjectAccess,
  getStepLimit,
  handleGenerateMode,
  handleStreamMode,
} from "@/lib/ai/ai-query-handlers";
import type { CommonLogFields, ModeContext } from "@/lib/ai/types";
import { selectModel } from "@/lib/ai/models";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { requestBodySchema } from "@/lib/ai/schema";
import { getTools } from "@/lib/ai/tools";
import { SmartResponse } from "@/route-handlers/smart-response";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { validateImageAttachments } from "@hexclave/shared/dist/ai/image-limits";
import { yupMixed, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import type { ModelMessage } from "ai";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    params: yupObject({
      mode: yupString().oneOf(["stream", "generate"]).defined(),
    }),
    body: requestBodySchema,
  }),
  response: yupMixed<SmartResponse>().defined(),
  async handler({ params, body }, fullReq) {
    const { mode } = params;
    const isAuthenticated = fullReq.auth?.user != null;
    const { quality, speed, systemPrompt: systemPromptId, tools: toolNames, messages, projectId } = body;

    if (projectId != null) {
      await assertProjectAccess(projectId, fullReq.auth);
    }
    validateImageAttachments(messages);

    const authenticatedApiKey = isAuthenticated
      ? getEnvVariable("STACK_OPENROUTER_AUTHENTICATED_API_KEY", "")
      : "";
    const model = selectModel(quality, speed, isAuthenticated, authenticatedApiKey || undefined);
    const systemPrompt = await buildSystemPrompt(systemPromptId, body.mcpCallMetadata?.toolName);
    const tools = await getTools(toolNames, {
      auth: fullReq.auth,
      targetProjectId: projectId,
      mcpToolName: body.mcpCallMetadata?.toolName,
    });
    const toolsArg = Object.keys(tools).length > 0 ? tools : undefined;
    const stepLimit = getStepLimit(systemPromptId, toolsArg != null);

    const correlationId = crypto.randomUUID();
    const conversationIdForLog = body.mcpCallMetadata
      ? body.mcpCallMetadata.conversationId ?? crypto.randomUUID()
      : undefined;
    const common: CommonLogFields = {
      correlationId,
      mode,
      systemPromptId,
      quality,
      speed,
      modelId: String(model.modelId),
      isAuthenticated,
      projectId: projectId ?? undefined,
      userId: fullReq.auth?.user?.id,
      requestedToolsJson: JSON.stringify(toolNames),
      messagesJson: JSON.stringify(messages),
      conversationId: conversationIdForLog,
    };
    const startedAt = performance.now();

    const isAnthropic = model.modelId.startsWith("anthropic/");
    // Can be optimized: only opt into prompt caching for routes that are hit
    // frequently enough to amortize the write.
    const systemMessage: ModelMessage = {
      role: "system",
      content: systemPrompt,
      ...(isAnthropic && {
        providerOptions: {
          openrouter: { cacheControl: { type: "ephemeral" } },
        },
      }),
    };
    // Cast: the schema narrows role and leaves content as unknown, but the
    // AI SDK accepts a superset (role: "system" etc.). We've intentionally
    // excluded `system` at the schema layer to prevent prompt-injection via
    // client-supplied system messages — see schema.ts.
    const modelMessages = messages as unknown as ModelMessage[];
    const messagesWithCachedSystemPrompt: ModelMessage[] = [systemMessage, ...modelMessages];

    const ctx: ModeContext = { model, messagesWithCachedSystemPrompt, toolsArg, stepLimit, common, startedAt };
    const extras = {
      messages,
      mcpCallMetadata: body.mcpCallMetadata ?? undefined,
      correlationId,
      conversationIdForLog,
    };

    if (mode === "stream") {
      return handleStreamMode({ ...ctx, ...extras });
    }
    return await handleGenerateMode({ ...ctx, ...extras });
  },
});
