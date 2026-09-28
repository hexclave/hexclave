import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callHexclaveAskAi,
  HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE,
  type HexclaveAskRequestMetadata,
} from "./hexclave-ask";

const TEST_REQUEST_METADATA: HexclaveAskRequestMetadata = {
  transport: "skill-ask",
  requestIp: null,
  requestIpSource: null,
  userAgent: "test-agent",
  requestHost: "skill.hexclave.test",
  mcpProtocolVersion: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callHexclaveAskAi", () => {
  it("includes the caller's context and project in the model message", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      finalText: "Use the Next.js SDK.",
    })));
    vi.stubGlobal("fetch", fetchMock);

    await callHexclaveAskAi({
      backendApiBaseUrl: "https://api.hexclave.test",
      question: "Which SDK should I use?",
      reason: "test",
      userPrompt: "Help me choose an SDK",
      context: "The user is integrating authentication.",
      project: "A Next.js application written in TypeScript.",
      requestMetadata: TEST_REQUEST_METADATA,
    });

    const requestInit = fetchMock.mock.calls[0]?.[1];
    const body = typeof requestInit?.body === "string" ? JSON.parse(requestInit.body) : null;
    expect(body?.messages).toMatchInlineSnapshot(`
      [
        {
          "content": "Which SDK should I use?",
          "role": "user",
        },
        {
          "content": "Supporting information for the preceding question:

      Context:
      The user is integrating authentication.

      Project:
      A Next.js application written in TypeScript.",
          "role": "user",
        },
      ]
    `);
  });

  it("returns the safe public error when the backend connection fails", async () => {
    const requestError = new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8102");
    const onDiagnostic = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw requestError;
    }));

    await expect(callHexclaveAskAi({
      backendApiBaseUrl: "http://localhost:8102",
      question: "How do I configure OAuth?",
      reason: "test",
      userPrompt: "How do I configure OAuth?",
      requestMetadata: TEST_REQUEST_METADATA,
      onDiagnostic,
    })).resolves.toEqual({
      status: "error",
      message: HEXCLAVE_ASK_PUBLIC_ERROR_MESSAGE,
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith({
      event: "request-error",
      error: requestError,
    });
  });

  it("does not synthesize a conversation ID when the backend omits one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      finalText: "Use the OAuth provider configuration.",
    }))));

    await expect(callHexclaveAskAi({
      backendApiBaseUrl: "https://api.hexclave.test",
      question: "How do I configure OAuth?",
      reason: "test",
      userPrompt: "How do I configure OAuth?",
      requestMetadata: TEST_REQUEST_METADATA,
    })).resolves.toEqual({
      status: "ok",
      text: "Use the OAuth provider configuration.",
      conversationId: undefined,
    });
  });
});
