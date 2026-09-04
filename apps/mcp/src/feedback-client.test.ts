import { afterEach, expect, it, vi } from "vitest";
import { HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE, sendHexclaveFeedback } from "./feedback-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  { correlationId: "feedback-123" },
  null,
  {},
  { correlationId: 123 },
  [],
])("validates the upstream feedback response %j", async (body) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
  const onDiagnostic = vi.fn();
  const result = await sendHexclaveFeedback({
    internalToolBaseUrl: "https://feedback.example.test",
    ingestSecret: "test-only",
    category: "bug",
    message: "Example feedback",
    requestMetadata: {
      transport: "mcp-ask-hexclave",
      requestIp: null,
      requestIpSource: null,
      userAgent: null,
      requestHost: null,
      mcpProtocolVersion: null,
    },
    onDiagnostic,
  });
  if (body !== null && "correlationId" in body && body.correlationId === "feedback-123") {
    expect(result).toEqual({ correlationId: "feedback-123", status: "ok" });
    expect(onDiagnostic).not.toHaveBeenCalled();
  } else {
    expect(result).toEqual({ status: "error", message: HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE });
    expect(onDiagnostic).toHaveBeenCalledWith({ event: "malformed-json", error: expect.any(Error) });
  }
});
