import { yupArray, yupMixed, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { ModelMessage } from "ai";
import { InferType } from "yup";
import { MODEL_QUALITIES, MODEL_SPEEDS } from "./models";
import { SYSTEM_PROMPT_IDS } from "./prompts";
import { TOOL_NAMES, validateToolNames } from "./tools";

export const requestBodySchema = yupObject({
  quality: yupString().oneOf(MODEL_QUALITIES).defined(),
  speed: yupString().oneOf(MODEL_SPEEDS).defined(),
  tools: yupArray(yupString().oneOf(TOOL_NAMES).defined())
    .test("valid-tool-names", "Invalid tool name", validateToolNames)
    .defined(),
  systemPrompt: yupString().oneOf(SYSTEM_PROMPT_IDS).defined(),
  messages: yupArray(
    yupObject({
      role: yupString().oneOf(["user", "assistant", "tool"]).defined(),
      content: yupMixed<ModelMessage["content"]>().defined(),
    }).defined()
  ).defined().min(1),
  projectId: yupString().optional().nullable(),
  mcpCallMetadata: yupObject({
    toolName: yupString().defined(),
    reason: yupString().defined(),
    userPrompt: yupString().defined(),
    context: yupString().optional().nullable(),
    user: yupString().optional().nullable(),
    project: yupString().optional().nullable(),
    conversationId: yupString().optional().nullable(),
    requestMetadata: yupObject({
      transport: yupString().oneOf(["skill-ask", "mcp-ask-hexclave"]).defined(),
      requestIp: yupString().max(100).nullable().defined(),
      requestIpSource: yupString().max(100).nullable().defined(),
      userAgent: yupString().max(1_000).nullable().defined(),
      requestHost: yupString().max(255).nullable().defined(),
      mcpProtocolVersion: yupString().max(100).nullable().defined(),
    }).defined(),
  }).optional().nullable(),
});

export type RequestBody = InferType<typeof requestBodySchema>;
