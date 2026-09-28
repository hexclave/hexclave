import {
  listAskHexclaveCalls,
  type AskHexclaveTransport,
} from "@/lib/ai/ask-hexclave-history";
import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import {
  adaptSchema,
  clientOrHigherAuthTypeSchema,
  yupArray,
  yupMixed,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const INTERNAL_PROJECT_ID = "internal";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const TransportSchema = yupString()
  .oneOf(["all", "skill-ask", "mcp-ask-hexclave"])
  .default("all");

const CallSchema = yupObject({
  id: yupString().defined(),
  created_at: yupString().defined(),
  transport: yupString().oneOf(["skill-ask", "mcp-ask-hexclave"]).defined(),
  conversation_id: yupString().defined(),
  question: yupString().defined(),
  response: yupString().defined(),
  reason: yupString().defined(),
  user_prompt: yupString().defined(),
  context: yupString().nullable().defined(),
  user: yupString().nullable().defined(),
  project: yupString().nullable().defined(),
  request_ip: yupString().nullable().defined(),
  request_ip_source: yupString().nullable().defined(),
  user_agent: yupString().nullable().defined(),
  request_host: yupString().nullable().defined(),
  mcp_protocol_version: yupString().nullable().defined(),
  model_id: yupString().defined(),
  step_count: yupNumber().integer().defined(),
  duration_ms: yupNumber().integer().defined(),
  inner_tool_calls: yupMixed<Exclude<Json, null>>().defined(),
}).defined();

function parseLimit(raw: string | undefined): number {
  if (raw == null || raw === "") {
    return DEFAULT_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new StatusError(StatusError.BadRequest, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function parseTransport(value: string): AskHexclaveTransport | "all" {
  if (value === "all" || value === "skill-ask" || value === "mcp-ask-hexclave") {
    return value;
  }
  throw new StatusError(StatusError.BadRequest, "Invalid transport");
}

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      project: adaptSchema.defined(),
    }),
    query: yupObject({
      query: yupString().max(500).optional(),
      transport: TransportSchema.optional(),
      cursor: yupString().optional(),
      limit: yupString().optional(),
    }).default({}),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      calls: yupArray(CallSchema).defined(),
      next_cursor: yupString().nullable().defined(),
    }).defined(),
  }),
  handler: async (req) => {
    if (req.auth.user == null) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (req.auth.project.id !== INTERNAL_PROJECT_ID) {
      throw new KnownErrors.ExpectedInternalProject();
    }
    await ensurePlatformAdmin(req.auth.user);

    const transport = parseTransport(await TransportSchema.validate(req.query.transport));
    const result = await listAskHexclaveCalls({
      query: req.query.query?.trim() ?? "",
      transport,
      cursor: req.query.cursor ?? null,
      limit: parseLimit(req.query.limit),
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        calls: result.calls.map((call) => ({
          id: call.id,
          created_at: call.createdAt,
          transport: call.transport,
          conversation_id: call.conversationId,
          question: call.question,
          response: call.response,
          reason: call.reason,
          user_prompt: call.userPrompt,
          context: call.context,
          user: call.user,
          project: call.project,
          request_ip: call.requestIp,
          request_ip_source: call.requestIpSource,
          user_agent: call.userAgent,
          request_host: call.requestHost,
          mcp_protocol_version: call.mcpProtocolVersion,
          model_id: call.modelId,
          step_count: call.stepCount,
          duration_ms: call.durationMs,
          inner_tool_calls: call.innerToolCalls,
        })),
        next_cursor: result.nextCursor,
      },
    };
  },
});
