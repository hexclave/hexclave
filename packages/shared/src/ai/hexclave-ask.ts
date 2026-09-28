export const HEXCLAVE_ASK_BACKEND_TIMEOUT_MS = 45_000;
export const HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE = "Hexclave AI is temporarily unavailable. Please try again later.";

type JsonRecord = Record<string, unknown>;

type AiTextContent = {
  type: "text",
  text: string,
};

type AiQueryResponse = {
  finalText?: string,
  content?: AiTextContent[],
  conversationId?: string | null,
};

export type HexclaveAskDiagnostic = {
  event: "timeout",
  timeoutMs: number,
} | {
  event: "upstream-error",
  status: number,
  body: string,
} | {
  event: "malformed-json",
  error: unknown,
} | {
  event: "request-error",
  error: unknown,
};

export type HexclaveAskResult = {
  status: "ok",
  text: string,
  conversationId?: string,
} | {
  status: "error",
  message: string,
};

export type HexclaveAskTransport = "skill-ask" | "mcp-ask-hexclave";

export type HexclaveAskRequestMetadata = {
  transport: HexclaveAskTransport,
  requestIp: string | null,
  requestIpSource: string | null,
  userAgent: string | null,
  requestHost: string | null,
  mcpProtocolVersion: string | null,
};

function getBoundedHeader(headers: Headers, name: string, maxLength: number): string | null {
  const value = headers.get(name)?.trim();
  return value == null || value === "" ? null : value.slice(0, maxLength);
}

function getRequestIp(headers: Headers): Pick<HexclaveAskRequestMetadata, "requestIp" | "requestIpSource"> {
  // These services run behind different deployment proxies. Keep the source next
  // to the value because forwarded headers are only as trustworthy as that ingress.
  const candidates = [
    ["x-vercel-forwarded-for", getBoundedHeader(headers, "x-vercel-forwarded-for", 500)?.split(",")[0]?.trim()],
    ["cf-connecting-ip", getBoundedHeader(headers, "cf-connecting-ip", 100)],
    ["x-forwarded-for", getBoundedHeader(headers, "x-forwarded-for", 500)?.split(",")[0]?.trim()],
    ["x-real-ip", getBoundedHeader(headers, "x-real-ip", 100)],
  ];
  const candidate = candidates.find((entry) => entry[1] != null && entry[1] !== "");
  return {
    requestIp: candidate?.[1]?.slice(0, 100) ?? null,
    requestIpSource: candidate?.[0] ?? null,
  };
}

export function getHexclaveAskRequestMetadata(
  request: Request,
  transport: HexclaveAskTransport,
): HexclaveAskRequestMetadata {
  const ip = getRequestIp(request.headers);
  return {
    transport,
    ...ip,
    userAgent: getBoundedHeader(request.headers, "user-agent", 1_000),
    requestHost: new URL(request.url).host.slice(0, 255),
    mcpProtocolVersion: getBoundedHeader(request.headers, "mcp-protocol-version", 100),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAiQueryResponse(value: unknown): AiQueryResponse {
  if (!isRecord(value)) {
    return {};
  }

  const parsed: AiQueryResponse = {};

  if (typeof value.finalText === "string") {
    parsed.finalText = value.finalText;
  }

  if (typeof value.conversationId === "string" || value.conversationId === null) {
    parsed.conversationId = value.conversationId;
  }

  if (Array.isArray(value.content)) {
    parsed.content = value.content.flatMap((contentItem) => {
      if (!isRecord(contentItem) || contentItem.type !== "text" || typeof contentItem.text !== "string") {
        return [];
      }

      const textContent: AiTextContent = {
        type: "text",
        text: contentItem.text,
      };
      return [textContent];
    });
  }

  return parsed;
}

function getAiResponseText(response: AiQueryResponse): string {
  const finalText = response.finalText;
  if (finalText != null && finalText.length > 0) {
    return finalText;
  }

  const contentText = response.content?.map((contentItem) => contentItem.text).join("\n\n");
  return contentText != null && contentText.length > 0 ? contentText : "(empty response)";
}

function getAskMessages(question: string, context?: string | null, project?: string | null): {
  role: "user",
  content: string,
}[] {
  const supplementalContext = [
    context == null ? null : `Context:\n${context}`,
    project == null ? null : `Project:\n${project}`,
  ].filter((value): value is string => value != null);

  if (supplementalContext.length === 0) {
    return [{ role: "user", content: question }];
  }

  return [
    { role: "user", content: question },
    {
      role: "user",
      content: `Supporting information for the preceding question:\n\n${supplementalContext.join("\n\n")}`,
    },
  ];
}

export async function callHexclaveAskAi(options: {
  backendApiBaseUrl: string,
  question: string,
  reason: string,
  userPrompt: string,
  context?: string | null,
  user?: string | null,
  project?: string | null,
  conversationId?: string | null,
  requestMetadata: HexclaveAskRequestMetadata,
  timeoutMs?: number,
  onDiagnostic?: (diagnostic: HexclaveAskDiagnostic) => void,
}): Promise<HexclaveAskResult> {
  const timeoutMs = options.timeoutMs ?? HEXCLAVE_ASK_BACKEND_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  // The timeout must stay armed until the body is fully consumed, not just until the headers
  // arrive: `fetch` resolves as soon as headers are received, so a backend that stalls
  // mid-body would otherwise hang forever. Aborting the signal also errors pending body
  // reads, which is why the AbortError classification lives in the outer catch below.
  try {
    let response: Response;
    try {
      response = await fetch(`${options.backendApiBaseUrl.replace(/\/$/, "")}/api/latest/ai/query/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quality: "smart",
          speed: "fast",
          tools: ["docs"],
          systemPrompt: "docs-ask-ai",
          messages: getAskMessages(options.question, options.context, options.project),
          mcpCallMetadata: {
            // Both the skill.hexclave.com/ask endpoint and the MCP server's ask_hexclave tool
            // are the same docs assistant exposed through two transports, so they share one
            // tool name — the backend keys its docs-context behavior on it.
            toolName: "ask_hexclave",
            reason: options.reason,
            userPrompt: options.userPrompt,
            context: options.context,
            user: options.user,
            project: options.project,
            conversationId: options.conversationId,
            requestMetadata: options.requestMetadata,
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }

      // Connection failures contain environment-specific details and must not cross either
      // public transport. Keep timeout handling in the outer catch so it remains diagnostic.
      options.onDiagnostic?.({ event: "request-error", error });
      return { status: "error", message: HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE };
    }

    if (!response.ok) {
      const body = await response.text();
      options.onDiagnostic?.({ event: "upstream-error", status: response.status, body });
      return { status: "error", message: HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE };
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        // A stalled body read aborted by our timeout is a timeout, not malformed JSON —
        // rethrow so the outer catch reports it as such.
        throw error;
      }
      options.onDiagnostic?.({ event: "malformed-json", error });
      return { status: "error", message: HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE };
    }

    const body = parseAiQueryResponse(responseJson);
    return {
      status: "ok",
      text: getAiResponseText(body),
      conversationId: body.conversationId ?? options.conversationId ?? undefined,
    };
  } catch (error) {
    // `controller.signal.aborted` is checked in addition to the DOMException, because some
    // fetch implementations surface aborted-mid-body reads as other error types (e.g.
    // undici's "terminated" TypeError) — if our timeout fired, it's a timeout either way.
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      options.onDiagnostic?.({ event: "timeout", timeoutMs });
      return { status: "error", message: HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
