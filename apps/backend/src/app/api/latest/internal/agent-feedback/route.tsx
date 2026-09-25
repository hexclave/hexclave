import { sendAgentFeedbackDiscordNotification } from "@/lib/ai/agent-feedback-discord";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  AGENT_FEEDBACK_CATEGORIES,
  AGENT_FEEDBACK_FIELD_MAX_LENGTH,
  AGENT_FEEDBACK_MESSAGE_MAX_LENGTH,
  AGENT_FEEDBACK_SOURCES,
  type AgentFeedbackCategory,
  type AgentFeedbackSource,
} from "@hexclave/shared/dist/ai/agent-feedback";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

const THANK_YOU_MESSAGE = "Thanks! Your feedback was sent to the Hexclave team. Don't send the same feedback again.";

// GET (query) and POST (body) accept the same fields so agents can use whichever is easier.
// Query parameters can't be null, so only the body schema accepts nulls.
const requiredFields = {
  message: yupString().defined().nonEmpty().max(AGENT_FEEDBACK_MESSAGE_MAX_LENGTH),
  category: yupString().oneOf(AGENT_FEEDBACK_CATEGORIES).optional(),
  source: yupString().oneOf(AGENT_FEEDBACK_SOURCES).optional(),
};
const optionalFieldMaxLengths = {
  context: AGENT_FEEDBACK_FIELD_MAX_LENGTH,
  agent: 200,
  user: AGENT_FEEDBACK_FIELD_MAX_LENGTH,
  project: AGENT_FEEDBACK_FIELD_MAX_LENGTH,
  conversation_id: 100,
  request_ip: 100,
  user_agent: 1_000,
  request_host: 255,
} as const;
type OptionalFieldName = keyof typeof optionalFieldMaxLengths;

function mapOptionalFields<T>(createField: (maxLength: number) => T): Record<OptionalFieldName, T> {
  return {
    context: createField(optionalFieldMaxLengths.context),
    agent: createField(optionalFieldMaxLengths.agent),
    user: createField(optionalFieldMaxLengths.user),
    project: createField(optionalFieldMaxLengths.project),
    conversation_id: createField(optionalFieldMaxLengths.conversation_id),
    request_ip: createField(optionalFieldMaxLengths.request_ip),
    user_agent: createField(optionalFieldMaxLengths.user_agent),
    request_host: createField(optionalFieldMaxLengths.request_host),
  };
}

const queryFieldsSchema = yupObject({
  ...requiredFields,
  ...mapOptionalFields((maxLength) => yupString().max(maxLength).optional()),
}).defined();

const bodyFieldsSchema = yupObject({
  ...requiredFields,
  ...mapOptionalFields((maxLength) => yupString().max(maxLength).optional().nullable()),
}).defined();

const responseSchema = yupObject({
  statusCode: yupNumber().oneOf([200]).defined(),
  bodyType: yupString().oneOf(["json"]).defined(),
  body: yupObject({
    success: yupBoolean().oneOf([true]).defined(),
    message: yupString().defined(),
  }).defined(),
});

type FeedbackFields = {
  message: string,
  category?: AgentFeedbackCategory,
  context?: string | null,
  agent?: string | null,
  user?: string | null,
  project?: string | null,
  conversation_id?: string | null,
  source?: AgentFeedbackSource,
  request_ip?: string | null,
  user_agent?: string | null,
  request_host?: string | null,
};

async function handleFeedback(fields: FeedbackFields, defaultSource: AgentFeedbackSource) {
  await sendAgentFeedbackDiscordNotification({
    message: fields.message,
    category: fields.category ?? "other",
    source: fields.source ?? defaultSource,
    context: fields.context ?? null,
    agent: fields.agent ?? null,
    user: fields.user ?? null,
    project: fields.project ?? null,
    conversationId: fields.conversation_id ?? null,
    requestIp: fields.request_ip ?? null,
    userAgent: fields.user_agent ?? null,
    requestHost: fields.request_host ?? null,
  });

  return {
    statusCode: 200,
    bodyType: "json",
    body: {
      success: true,
      message: THANK_YOU_MESSAGE,
    },
  } as const;
}

const metadata = {
  summary: "Submit agent feedback",
  description: "Report an issue, docs gap, agent-UX problem, or suggestion from an AI agent. The feedback is forwarded to the Hexclave team's Discord feedback channel. No authentication required.",
  tags: ["Internal"],
  hidden: true,
};

export const GET = createSmartRouteHandler({
  metadata,
  request: yupObject({
    query: queryFieldsSchema,
    method: yupString().oneOf(["GET"]).defined(),
  }),
  response: responseSchema,
  async handler({ query }) {
    return await handleFeedback(query, "api");
  },
});

export const POST = createSmartRouteHandler({
  metadata,
  request: yupObject({
    body: bodyFieldsSchema,
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: responseSchema,
  async handler({ body }) {
    return await handleFeedback(body, "api");
  },
});
