import {
  callHexclaveAskAi,
  getHexclaveAskRequestMetadata,
  type HexclaveAskDiagnostic,
} from "../../../packages/shared/src/ai/hexclave-ask";
import { remindersPrompt } from "@hexclave/shared/dist/ai/unified-prompts/reminders";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const ASK_ROUTE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const ASK_ROUTE_REASON = "skill-site ask endpoint";
const MAX_DIAGNOSTIC_BODY_LENGTH = 4_000;

class QueryArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryArgumentError";
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1" || hostname.endsWith(".localhost");
}

function getBackendApiBaseUrl(req: Request): string {
  const configured =
    process.env.NEXT_PUBLIC_SERVER_HEXCLAVE_API_URL ??
    process.env.NEXT_PUBLIC_SERVER_STACK_API_URL ??
    process.env.NEXT_PUBLIC_HEXCLAVE_API_URL ??
    process.env.NEXT_PUBLIC_STACK_API_URL;

  if (configured != null && configured.trim() !== "") {
    return configured.replace(/\/$/, "");
  }

  const url = new URL(req.url);
  if (url.hostname === "skill.hexclave.com") {
    return "https://api.hexclave.com";
  }

  if (isLocalHostname(url.hostname) && url.port.endsWith("45")) {
    url.port = `${url.port.slice(0, -2)}02`;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  throw new QueryArgumentError("Unable to derive Hexclave API URL for this skill host.");
}

function getStringQueryParam(searchParams: URLSearchParams, name: string): string | null {
  const value = searchParams.get(name);
  if (value == null || value.trim() === "") {
    return null;
  }
  return value;
}

function getAskQuestion(searchParams: URLSearchParams): string {
  const question = getStringQueryParam(searchParams, "question") ?? getStringQueryParam(searchParams, "query");
  if (question == null) {
    throw new QueryArgumentError("Missing query parameters. The format for the ask endpoint is: /ask?question=...&context=...&user=...&project=...\n\n" + remindersPrompt);
  }
  return question;
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      ...ASK_ROUTE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function getDiagnosticBody(body: string): string {
  return body.length > MAX_DIAGNOSTIC_BODY_LENGTH
    ? `${body.slice(0, MAX_DIAGNOSTIC_BODY_LENGTH)}…`
    : body;
}

function logAskDiagnostic(diagnostic: HexclaveAskDiagnostic): void {
  switch (diagnostic.event) {
    case "timeout": {
      captureError("skill-site-ask-timeout", new HexclaveAssertionError("Hexclave AI ask endpoint timed out", {
        timeoutMs: diagnostic.timeoutMs,
      }));
      break;
    }
    case "upstream-error": {
      captureError("skill-site-ask-upstream-error", new HexclaveAssertionError("Hexclave AI ask endpoint returned an upstream error", {
        status: diagnostic.status,
        body: getDiagnosticBody(diagnostic.body),
      }));
      break;
    }
    case "malformed-json": {
      captureError("skill-site-ask-malformed-json", new HexclaveAssertionError("Hexclave AI ask endpoint returned malformed JSON", {
        cause: diagnostic.error,
      }));
      break;
    }
    case "request-error": {
      captureError("skill-site-ask-request-error", new HexclaveAssertionError("Hexclave AI ask endpoint request failed", {
        cause: diagnostic.error,
      }));
      break;
    }
    default: {
      const _exhaustive: never = diagnostic;
      throw new Error(`Unhandled ask diagnostic: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function callUnifiedAiEndpoint(req: Request): Promise<Response> {
  const searchParams = new URL(req.url).searchParams;
  const question = getAskQuestion(searchParams);
  const context = getStringQueryParam(searchParams, "context");
  const user = getStringQueryParam(searchParams, "user");
  const project = getStringQueryParam(searchParams, "project");
  const userPrompt = getStringQueryParam(searchParams, "userPrompt") ?? context ?? question;
  const conversationId = getStringQueryParam(searchParams, "conversationId");

  const result = await callHexclaveAskAi({
    backendApiBaseUrl: getBackendApiBaseUrl(req),
    question,
    reason: ASK_ROUTE_REASON,
    userPrompt,
    context,
    user,
    project,
    conversationId,
    requestMetadata: getHexclaveAskRequestMetadata(req, "skill-ask"),
    onDiagnostic: logAskDiagnostic,
  });

  if (result.status === "error") {
    return textResponse(result.message, 502);
  }

  const continuationGuidance = result.conversationId == null
    ? ""
    : `\n\n[conversationId: ${result.conversationId} - pass this value as the conversationId parameter in your next /ask request to continue this conversation]`;
  return textResponse(`${result.text}${continuationGuidance}\n\n---\n\n${remindersPrompt}`);
}

export async function handleAskToolRoute(req: Request): Promise<Response> {
  try {
    if (req.method === "HEAD") {
      return textResponse("");
    }

    return await callUnifiedAiEndpoint(req);
  } catch (error) {
    if (error instanceof QueryArgumentError) {
      return textResponse(error.message, 400);
    }

    throw error;
  }
}

export function handleAskToolOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: ASK_ROUTE_HEADERS,
  });
}
