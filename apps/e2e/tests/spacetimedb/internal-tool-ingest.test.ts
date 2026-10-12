// Tests the internal tool's /api/backend/* ingest routes over HTTP — the layer
// between the Stack Auth backend loggers and SpacetimeDB. Focus: the
// JSON-string payload fields (innerToolCallsJson, stepsJson, ...) must be
// rejected at ingest when malformed, because the review UIs JSON.parse them
// with an empty-list fallback — a corrupted value stored here would silently
// render as "no tool calls" instead of failing anywhere visible.
//
// Auth: these routes require a backend assertion — a JWT signed with the Stack
// Auth project keys derived from STACK_SERVER_SECRET. We sign one exactly like
// apps/backend/src/lib/ai/internal-tool-client.ts does, using the committed
// dev secret (same one apps/backend/.env.development uses; dev-only, not a
// real secret) — mirroring how helpers.ts signs member tokens with the
// committed dev JWK.

import { signJWT } from "@hexclave/shared/dist/utils/jwt";
import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import { createCleanupScope, isSpacetimedbReachable, type CleanupScope } from "./helpers";

process.env.STACK_SERVER_SECRET ??= "23-wuNpik0gIW4mruTz25rbIvhuuvZFrLOLtL7J4tyo";

const ASSERTION_SUBJECT = "__internal_tool_backend__";
const ASSERTION_TOKEN_USE = "internal-tool-backend";
const INTERNAL_TOOL_PROJECT_ID = "internal";

function portPrefix(): string {
  return process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81";
}

function internalToolBase(): string {
  return (process.env.HEXCLAVE_INTERNAL_TOOL_URL ?? `http://localhost:${portPrefix()}41`).replace(/\/+$/, "");
}

function backendApiUrl(): string {
  return (process.env.HEXCLAVE_BACKEND_BASE_URL ?? `http://localhost:${portPrefix()}02`).replace(/\/+$/, "");
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (err) {
    const isAbort = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
    const isNetwork = err instanceof TypeError;
    if (isAbort || isNetwork) return false;
    throw err;
  }
}

async function isInternalToolReachable(): Promise<boolean> {
  return await isReachable(`${internalToolBase()}/.well-known/openid-configuration`);
}

// The ingest routes verify our assertion against the backend's public JWKS
// endpoint, so a running internal tool alone isn't enough — without the
// backend every request 401s, which would read as a test failure rather than
// an unavailable environment. Probe the exact JWKS URL the tool fetches.
async function isBackendJwksReachable(): Promise<boolean> {
  return await isReachable(`${backendApiUrl()}/api/v1/projects/${INTERNAL_TOOL_PROJECT_ID}/.well-known/jwks.json`);
}

async function mintBackendAssertion(): Promise<string> {
  return await signJWT({
    issuer: `${backendApiUrl()}/api/v1/projects/${INTERNAL_TOOL_PROJECT_ID}`,
    audience: INTERNAL_TOOL_PROJECT_ID,
    expirationTime: "5m",
    payload: {
      sub: ASSERTION_SUBJECT,
      token_use: ASSERTION_TOKEN_USE,
    },
  });
}

async function postIngest(path: string, body: unknown): Promise<{ status: number, body: string }> {
  const res = await fetch(`${internalToolBase()}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${await mintBackendAssertion()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function validMcpCallBody(question: string) {
  return {
    correlationId: crypto.randomUUID(),
    toolName: "e2e-ingest-tool",
    reason: "e2e ingest validation",
    userPrompt: "prompt",
    question,
    response: "response",
    stepCount: 0,
    innerToolCallsJson: "[]",
    durationMs: 0,
    modelId: "e2e-model",
  };
}

function validAiQueryBody(correlationId: string) {
  return {
    correlationId,
    mode: "generate",
    systemPromptId: "e2e",
    quality: "unknown",
    speed: "unknown",
    modelId: "e2e-model",
    isAuthenticated: false,
    requestedToolsJson: "[]",
    messagesJson: "[]",
    stepsJson: "[]",
    finalText: "",
    stepCount: 0,
    durationMs: 0,
  };
}

// Matches the committed dev value in apps/internal-tool/.env.development, the
// same way this file already reuses the committed dev STACK_SERVER_SECRET.
const FEEDBACK_INGEST_SECRET =
  process.env.HEXCLAVE_FEEDBACK_INGEST_SECRET
  ?? "this-feedback-ingest-secret-is-for-local-development-only";

function validFeedbackBody() {
  return {
    category: "bug",
    message: "e2e ingest feedback",
    requestMetadata: {
      transport: "mcp-ask-hexclave",
      requestIp: null,
      requestIpSource: null,
      userAgent: null,
      requestHost: null,
      mcpProtocolVersion: null,
    },
  };
}

async function postFeedback(
  body: unknown,
  options?: { secret?: string | null },
): Promise<{ status: number, body: string }> {
  const secret = options === undefined ? FEEDBACK_INGEST_SECRET : options.secret;
  const res = await fetch(`${internalToolBase()}/api/public/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...secret == null ? {} : { "Authorization": `Bearer ${secret}` },
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

const canRun = await isInternalToolReachable() && await isBackendJwksReachable() && await isSpacetimedbReachable();

describe.skipIf(!canRun)("internal tool ingest validation", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("log-mcp-call rejects innerToolCallsJson that is not valid JSON", async ({ expect }) => {
    const res = await postIngest("/api/backend/log-mcp-call", {
      ...validMcpCallBody(uniqueMarker("ingest-invalid-json")),
      innerToolCallsJson: "not json at all {",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchInlineSnapshot(`
      {
        "error": "Invalid request body.",
        "issues": [
          {
            "message": "Must be a valid JSON string.",
            "path": "innerToolCallsJson",
          },
        ],
      }
    `);
  });

  it("log-mcp-call rejects innerToolCallsJson that is valid JSON but not an array", async ({ expect }) => {
    const res = await postIngest("/api/backend/log-mcp-call", {
      ...validMcpCallBody(uniqueMarker("ingest-non-array")),
      innerToolCallsJson: '{"toolName":"x"}',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchInlineSnapshot(`
      {
        "error": "Invalid request body.",
        "issues": [
          {
            "message": "Must be a JSON array.",
            "path": "innerToolCallsJson",
          },
        ],
      }
    `);
  });

  it("log-mcp-call accepts a well-formed JSON array payload", async ({ expect }) => {
    const marker = uniqueMarker("ingest-valid");
    scope.trackMcpQuestion(marker);
    const res = await postIngest("/api/backend/log-mcp-call", validMcpCallBody(marker));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchInlineSnapshot(`{ "success": true }`);
  });

  it("log-ai-query rejects malformed JSON payload fields", async ({ expect }) => {
    const correlationId = crypto.randomUUID();
    const res = await postIngest("/api/backend/log-ai-query", {
      ...validAiQueryBody(correlationId),
      stepsJson: "[unterminated",
      messagesJson: "42",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchInlineSnapshot(`
      {
        "error": "Invalid request body.",
        "issues": [
          {
            "message": "Must be a JSON array.",
            "path": "messagesJson",
          },
          {
            "message": "Must be a valid JSON string.",
            "path": "stepsJson",
          },
        ],
      }
    `);
  });

  it("log-ai-query accepts well-formed JSON array payloads", async ({ expect }) => {
    const correlationId = crypto.randomUUID();
    scope.trackAiQueryCorrelationId(correlationId);
    const res = await postIngest("/api/backend/log-ai-query", validAiQueryBody(correlationId));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchInlineSnapshot(`{ "success": true }`);
  });

  // Feedback ingest is a separate route with its own credential: the MCP server
  // calls it directly and cannot mint a backend assertion.
  it("public feedback accepts a well-formed payload and mints its own correlationId", async ({ expect }) => {
    const res = await postFeedback(validFeedbackBody());
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { success: boolean, correlationId: string };
    expect(body.success).toBe(true);
    // Server-minted, not client-supplied — it's the row's primary key, so a
    // caller that could choose it could collide with someone else's feedback.
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    scope.trackFeedbackCorrelationId(body.correlationId);
  });

  it("public feedback rejects a request with no credential", async ({ expect }) => {
    const res = await postFeedback(validFeedbackBody(), { secret: null });
    expect(res.status).toBe(401);
  });

  it("public feedback rejects a request with the wrong credential", async ({ expect }) => {
    const res = await postFeedback(validFeedbackBody(), { secret: "not-the-secret" });
    expect(res.status).toBe(401);
  });

  it("public feedback rejects a message over the length cap", async ({ expect }) => {
    const res = await postFeedback({ ...validFeedbackBody(), message: "x".repeat(10_001) });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchInlineSnapshot(`
      {
        "error": "Invalid request body.",
        "issues": [
          {
            "message": "String must contain at most 10000 character(s)",
            "path": "message",
          },
        ],
      }
    `);
  });

  it("public feedback rejects an unknown category", async ({ expect }) => {
    const res = await postFeedback({ ...validFeedbackBody(), category: "not-a-category" });
    expect(res.status).toBe(400);
  });

  it("public feedback rejects a payload missing required fields", async ({ expect }) => {
    const res = await postFeedback({ message: "no category, no requestMetadata" });
    expect(res.status).toBe(400);
  });
});
