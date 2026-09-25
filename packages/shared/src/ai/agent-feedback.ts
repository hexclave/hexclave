export const AGENT_FEEDBACK_CATEGORIES = ["bug", "docs-gap", "agent-ux", "suggestion", "praise", "other"] as const;
export type AgentFeedbackCategory = typeof AGENT_FEEDBACK_CATEGORIES[number];

export const AGENT_FEEDBACK_SOURCES = ["skill-get", "skill-post", "cli", "mcp", "api"] as const;
export type AgentFeedbackSource = typeof AGENT_FEEDBACK_SOURCES[number];

export const AGENT_FEEDBACK_MESSAGE_MAX_LENGTH = 10_000;
export const AGENT_FEEDBACK_FIELD_MAX_LENGTH = 2_000;
export const AGENT_FEEDBACK_TIMEOUT_MS = 10_000;
export const AGENT_FEEDBACK_PUBLIC_ERROR_MESSAGE = "Feedback could not be recorded right now. Please try again later.";
export const AGENT_FEEDBACK_BACKEND_PATH = "/api/latest/internal/agent-feedback";

export type AgentFeedbackBody = {
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

export type AgentFeedbackDiagnostic = {
  event: "timeout",
  timeoutMs: number,
} | {
  event: "upstream-error",
  status: number,
  body: string,
} | {
  event: "request-error",
  error: unknown,
};

export type AgentFeedbackResult = {
  status: "ok",
} | {
  status: "error",
  httpStatus: number | null,
  message: string,
};

export function isAgentFeedbackCategory(value: string): value is AgentFeedbackCategory {
  return (AGENT_FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Sends agent feedback to the Hexclave backend, which forwards it to the team's Discord feedback channel.
 * Never throws for network/upstream failures; those are reported through `onDiagnostic` and a generic result.
 */
export async function sendAgentFeedback(options: {
  backendApiBaseUrl: string,
  body: AgentFeedbackBody,
  timeoutMs?: number,
  onDiagnostic?: (diagnostic: AgentFeedbackDiagnostic) => void,
}): Promise<AgentFeedbackResult> {
  const timeoutMs = options.timeoutMs ?? AGENT_FEEDBACK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${options.backendApiBaseUrl.replace(/\/$/, "")}${AGENT_FEEDBACK_BACKEND_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        options.onDiagnostic?.({ event: "timeout", timeoutMs });
        return { status: "error", httpStatus: null, message: AGENT_FEEDBACK_PUBLIC_ERROR_MESSAGE };
      }
      options.onDiagnostic?.({ event: "request-error", error });
      return { status: "error", httpStatus: null, message: AGENT_FEEDBACK_PUBLIC_ERROR_MESSAGE };
    }

    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        options.onDiagnostic?.(controller.signal.aborted ? { event: "timeout", timeoutMs } : { event: "request-error", error });
        return { status: "error", httpStatus: response.status, message: AGENT_FEEDBACK_PUBLIC_ERROR_MESSAGE };
      }
      options.onDiagnostic?.({ event: "upstream-error", status: response.status, body });
      // 4xx responses are validation errors about the feedback itself and are safe to surface to the caller.
      const isClientError = response.status >= 400 && response.status < 500;
      return {
        status: "error",
        httpStatus: response.status,
        message: isClientError ? body.slice(0, 2_000) : AGENT_FEEDBACK_PUBLIC_ERROR_MESSAGE,
      };
    }
    return { status: "ok" };
  } finally {
    clearTimeout(timeoutId);
  }
}
