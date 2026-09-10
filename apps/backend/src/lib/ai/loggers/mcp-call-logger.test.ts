import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepResult, ToolSet } from "ai";

const backgroundTasks = vi.hoisted(() => ({
  scheduled: new Array<Promise<unknown>>(),
}));

vi.mock("@/utils/background-tasks", () => ({
  runAsynchronouslyAndWaitUntil: vi.fn((promiseOrFunction: Promise<unknown> | (() => Promise<unknown>)) => {
    const promise = typeof promiseOrFunction === "function" ? promiseOrFunction() : promiseOrFunction;
    backgroundTasks.scheduled.push(Promise.resolve(promise).catch(() => undefined));
  }),
}));

vi.mock("../internal-tool-client", () => ({
  callInternalTool: vi.fn(async () => ({ success: true })),
}));

import type { AskHexclaveRequestMetadata } from "@/lib/ai/ask-hexclave-history";
import { callInternalTool } from "../internal-tool-client";
import { logIfMcpToolCall } from "./mcp-call-logger";

const REQUEST_METADATA: AskHexclaveRequestMetadata = {
  transport: "mcp-ask-hexclave",
  requestIp: null,
  requestIpSource: null,
  userAgent: null,
  requestHost: null,
  mcpProtocolVersion: null,
};

describe("logIfMcpToolCall", () => {
  beforeEach(() => {
    backgroundTasks.scheduled.length = 0;
    vi.mocked(callInternalTool).mockClear();
  });

  afterEach(async () => {
    await Promise.all(backgroundTasks.scheduled);
  });

  it("falls back to a safe MCP log payload when nested tool data is not JSON-serializable", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // The AI SDK StepResult has a wide surface; this test only needs the fields
    // read by mcp-call-logger, so the cast keeps the fixture intentionally small.
    const steps = [{
      text: "",
      toolCalls: [{
        toolName: "queryAnalytics",
        toolCallId: "call-1",
        input: circular,
      }],
      toolResults: [{
        toolName: "queryAnalytics",
        toolCallId: "call-1",
        output: circular,
      }],
    }] as unknown as ReadonlyArray<StepResult<ToolSet>>;

    expect(() => logIfMcpToolCall({
      mcpCallMetadata: {
        toolName: "queryAnalytics",
        reason: "review",
        userPrompt: "show usage",
        requestMetadata: REQUEST_METADATA,
      },
      conversationIdForLog: "conversation-1",
      correlationId: "correlation-1",
      messages: [{ role: "user", content: circular }],
      steps,
      text: "done",
      startedAt: performance.now(),
      modelId: "model-1",
    })).not.toThrow();

    await Promise.all(backgroundTasks.scheduled);

    expect(callInternalTool).toHaveBeenCalledTimes(2);
    const [logPath, logOptions] = vi.mocked(callInternalTool).mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(logPath).toBe("/api/backend/log-mcp-call");
    expect(typeof logOptions.body.durationMs).toBe("number");
    expect({ ...logOptions.body, durationMs: "<duration>" }).toMatchInlineSnapshot(`
      {
        "conversationId": "conversation-1",
        "correlationId": "correlation-1",
        "durationMs": "<duration>",
        "errorMessage": undefined,
        "innerToolCallsJson": "[{"type":"tool-call","toolName":"_serializationFailed","toolCallId":"_serializationFailed","args":{"stepCount":1},"argsText":"{\\"stepCount\\":1}","result":null}]",
        "modelId": "model-1",
        "question": "{"_serializationFailed":true}",
        "reason": "review",
        "response": "done",
        "stepCount": 1,
        "toolName": "queryAnalytics",
        "userPrompt": "show usage",
      }
    `);

    // The QA review trigger fires only after the log write resolved.
    const [reviewPath, reviewOptions] = vi.mocked(callInternalTool).mock.calls[1] as [string, { body: Record<string, unknown> }];
    expect(reviewPath).toBe("/api/backend/review-mcp-call");
    expect(reviewOptions.body).toEqual({
      correlationId: "correlation-1",
      question: '{"_serializationFailed":true}',
      reason: "review",
      response: "done",
    });
  });

  it("logs an errored MCP call but does not trigger a QA review", async () => {
    logIfMcpToolCall({
      mcpCallMetadata: {
        toolName: "queryAnalytics",
        reason: "review",
        userPrompt: "show usage",
        requestMetadata: REQUEST_METADATA,
      },
      conversationIdForLog: "conversation-1",
      correlationId: "correlation-1",
      messages: [{ role: "user", content: "show usage" }],
      steps: [],
      text: "",
      startedAt: performance.now(),
      modelId: "model-1",
      errorMessage: "Error: upstream failed",
    });

    await Promise.all(backgroundTasks.scheduled);

    // Only the log write fires — no review-mcp-call for an errored response.
    expect(callInternalTool).toHaveBeenCalledTimes(1);
    const [logPath, logOptions] = vi.mocked(callInternalTool).mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(logPath).toBe("/api/backend/log-mcp-call");
    expect(logOptions.body.errorMessage).toBe("Error: upstream failed");
    expect(logOptions.body.response).toBe("");
  });
});
