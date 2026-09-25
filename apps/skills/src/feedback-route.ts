import {
  AGENT_FEEDBACK_CATEGORIES,
  isAgentFeedbackCategory,
  sendAgentFeedback,
  type AgentFeedbackBody,
  type AgentFeedbackCategory,
  type AgentFeedbackDiagnostic,
} from "../../../packages/shared/src/ai/agent-feedback";
import { getHexclaveAskRequestMetadata } from "../../../packages/shared/src/ai/hexclave-ask";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getBackendApiBaseUrl, QueryArgumentError } from "./ask-route";

const FEEDBACK_ROUTE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const MAX_DIAGNOSTIC_BODY_LENGTH = 4_000;

const FEEDBACK_USAGE = `Usage: GET https://skill.hexclave.com/feedback?message=<...>&category=<${AGENT_FEEDBACK_CATEGORIES.join("|")}>&context=<...>&agent=<...>&user=<...>&project=<...>

Only \`message\` is required. For longer reports, POST the same fields as a JSON body (or text/plain body for just the message) to https://skill.hexclave.com/feedback, or run \`npx @hexclave/cli@latest feedback "<message>" --category <category>\`.`;

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      ...FEEDBACK_ROUTE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseFeedbackFields(get: (name: string) => unknown): Omit<AgentFeedbackBody, "source" | "request_ip" | "user_agent" | "request_host"> {
  const message = nonEmptyString(get("message")) ?? nonEmptyString(get("feedback"));
  if (message == null) {
    throw new QueryArgumentError(`Missing \`message\`.\n\n${FEEDBACK_USAGE}`);
  }
  const rawCategory = nonEmptyString(get("category"));
  let category: AgentFeedbackCategory | undefined;
  if (rawCategory != null) {
    if (!isAgentFeedbackCategory(rawCategory)) {
      throw new QueryArgumentError(`Invalid \`category\`: must be one of ${AGENT_FEEDBACK_CATEGORIES.join(", ")}.\n\n${FEEDBACK_USAGE}`);
    }
    category = rawCategory;
  }
  return {
    message,
    category,
    context: nonEmptyString(get("context")),
    agent: nonEmptyString(get("agent")),
    user: nonEmptyString(get("user")),
    project: nonEmptyString(get("project")),
    conversation_id: nonEmptyString(get("conversationId")) ?? nonEmptyString(get("conversation_id")),
  };
}

async function parsePostBody(req: Request): Promise<(name: string) => unknown> {
  const text = await req.text();
  const contentType = req.headers.get("content-type") ?? "";
  const isPlainText = contentType.includes("text/plain");
  if (contentType.includes("application/json") || (!isPlainText && text.trimStart().startsWith("{"))) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new QueryArgumentError(`Request body is not valid JSON.\n\n${FEEDBACK_USAGE}`);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new QueryArgumentError(`Request body must be a JSON object.\n\n${FEEDBACK_USAGE}`);
    }
    const record = new Map(Object.entries(json));
    return (name) => record.get(name);
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    return (name) => params.get(name);
  }
  // Plain-text body: the whole body is the message; other fields may still come from the query string.
  const query = new URL(req.url).searchParams;
  return (name) => name === "message" ? text : query.get(name);
}

function logFeedbackDiagnostic(diagnostic: AgentFeedbackDiagnostic): void {
  switch (diagnostic.event) {
    case "timeout": {
      captureError("skill-site-feedback-timeout", new HexclaveAssertionError("Hexclave agent feedback endpoint timed out", {
        timeoutMs: diagnostic.timeoutMs,
      }));
      break;
    }
    case "upstream-error": {
      captureError("skill-site-feedback-upstream-error", new HexclaveAssertionError("Hexclave agent feedback endpoint returned an upstream error", {
        status: diagnostic.status,
        body: diagnostic.body.slice(0, MAX_DIAGNOSTIC_BODY_LENGTH),
      }));
      break;
    }
    case "request-error": {
      captureError("skill-site-feedback-request-error", new HexclaveAssertionError("Hexclave agent feedback endpoint request failed", {
        cause: diagnostic.error,
      }));
      break;
    }
    default: {
      const _exhaustive: never = diagnostic;
      throw new Error(`Unhandled feedback diagnostic: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export async function handleFeedbackRoute(req: Request): Promise<Response> {
  try {
    if (req.method === "HEAD") {
      return textResponse("");
    }

    const searchParams = new URL(req.url).searchParams;
    const getField = req.method === "POST"
      ? await parsePostBody(req)
      : (name: string) => searchParams.get(name);
    const fields = parseFeedbackFields(getField);
    const requestMetadata = getHexclaveAskRequestMetadata(req, "skill-ask");

    const result = await sendAgentFeedback({
      backendApiBaseUrl: getBackendApiBaseUrl(req),
      body: {
        ...fields,
        source: req.method === "POST" ? "skill-post" : "skill-get",
        request_ip: requestMetadata.requestIp,
        user_agent: requestMetadata.userAgent,
        request_host: requestMetadata.requestHost,
      },
      onDiagnostic: logFeedbackDiagnostic,
    });

    if (result.status === "error") {
      const isClientError = result.httpStatus != null && result.httpStatus >= 400 && result.httpStatus < 500;
      return textResponse(isClientError ? `${result.message}\n\n${FEEDBACK_USAGE}` : result.message, isClientError ? 400 : 502);
    }

    return textResponse("Thanks! Your feedback was sent to the Hexclave team. Don't send the same feedback again.");
  } catch (error) {
    if (error instanceof QueryArgumentError) {
      return textResponse(error.message, 400);
    }
    throw error;
  }
}

export function handleFeedbackOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: FEEDBACK_ROUTE_HEADERS,
  });
}
