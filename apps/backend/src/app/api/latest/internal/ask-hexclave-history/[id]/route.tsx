import {
  getAskHexclaveCall,
  toAskHexclaveHistoryApiCall,
} from "@/lib/ai/ask-hexclave-history";
import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import {
  adaptSchema,
  clientOrHigherAuthTypeSchema,
  yupMixed,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";

const INTERNAL_PROJECT_ID = "internal";

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

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      project: adaptSchema.defined(),
    }),
    params: yupObject({
      id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: CallSchema,
  }),
  handler: async (req) => {
    if (req.auth.user == null) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (req.auth.project.id !== INTERNAL_PROJECT_ID) {
      throw new KnownErrors.ExpectedInternalProject();
    }
    await ensurePlatformAdmin(req.auth.user);

    const call = await getAskHexclaveCall(req.params.id);
    if (call == null) {
      throw new StatusError(StatusError.NotFound, "No Ask Hexclave query found with that id");
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: toAskHexclaveHistoryApiCall(call),
    };
  },
});
