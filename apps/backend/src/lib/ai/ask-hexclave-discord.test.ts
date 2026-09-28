import { afterEach, describe, expect, it, vi } from "vitest";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { globalVar } from "@hexclave/shared/dist/utils/globals";

import {
  buildAskHexclaveDiscordPayload,
  sendAskHexclaveDiscordNotification,
} from "./ask-hexclave-discord";

const baseOptions = {
  conversationId: "conversation-123",
  question: "How do I configure OAuth?",
  response: "Use the OAuth provider configuration in your project settings.",
  reason: "User asked about OAuth",
  userPrompt: "Help me set up OAuth with GitHub",
  context: "Adding authentication to an existing dashboard",
  user: "Ada Lovelace",
  project: "Analytical Engine dashboard, TypeScript and Next.js",
  requestMetadata: {
    transport: "skill-ask" as const,
    requestIp: "203.0.113.10",
    requestIpSource: "x-forwarded-for",
    userAgent: "skill-test-agent/1.0",
    requestHost: "skill.hexclave.com",
    mcpProtocolVersion: null,
  },
  modelId: "test-model",
  stepCount: 2,
  durationMs: 1234,
};

describe("ask Hexclave Discord notifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("puts a truncated question and answer in the message body and metadata in the embed", () => {
    const payload = buildAskHexclaveDiscordPayload({
      ...baseOptions,
      question: "Q".repeat(300),
      response: "R".repeat(4_000),
    });

    expect(payload.content).toHaveLength(2_000);
    expect(payload.content).toMatch(/^\*\*Q+\*\*\n\nR+…$/);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].title).toBe("Ask Hexclave · Skill /ask");
    expect(payload.embeds[0].fields).toEqual(expect.arrayContaining([
      { name: "Context", value: "Adding authentication to an existing dashboard" },
      { name: "User", value: "Ada Lovelace" },
      { name: "Project", value: "Analytical Engine dashboard, TypeScript and Next.js" },
      { name: "Request IP", value: "203.0.113.10 (x-forwarded-for)", inline: true },
      { name: "Host", value: "skill.hexclave.com", inline: true },
      { name: "Conversation", value: "conversation-123", inline: true },
    ]));
  });

  it("does nothing when the webhook URL env var is unset", async () => {
    vi.stubEnv("HEXCLAVE_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL", "");
    vi.stubEnv("STACK_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sendAskHexclaveDiscordNotification(baseOptions);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the Discord payload when a valid webhook URL is configured", async () => {
    vi.stubEnv("HEXCLAVE_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/123/abc");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendAskHexclaveDiscordNotification(baseOptions);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? throwErr("Expected Discord webhook fetch to be called");
    expect(String(url)).toBe("https://discord.com/api/webhooks/123/abc");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      content: "**How do I configure OAuth?**\n\nUse the OAuth provider configuration in your project settings.",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "Ask Hexclave · Skill /ask",
      }],
    });
  });

  it("rejects non-Discord webhook hosts without fetching", async () => {
    globalVar.hexclaveCapturedErrors = [];
    vi.stubEnv("HEXCLAVE_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL", "https://example.com/api/webhooks/123/abc");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await sendAskHexclaveDiscordNotification(baseOptions);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(globalVar.hexclaveCapturedErrors?.at(-1)).toMatchObject({
      location: "ask-hexclave-discord-webhook-url",
    });
  });
});
