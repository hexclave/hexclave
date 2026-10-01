import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { globalVar } from "@hexclave/shared/dist/utils/globals";

import {
  buildAskHexclaveDiscordPayload,
  sendAskHexclaveDiscordNotification,
} from "./ask-hexclave-discord";

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const DASHBOARD_URL = `https://app.hexclave.com/projects/internal/ask-hexclave-history?call=${CALL_ID}`;

const baseOptions = {
  id: CALL_ID,
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

function textContents(payload: ReturnType<typeof buildAskHexclaveDiscordPayload>): string[] {
  return payload.components.flatMap((component) => "content" in component ? [component.content] : []);
}

describe("ask Hexclave Discord notifications", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "https://app.hexclave.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_DASHBOARD_URL", "https://app.hexclave.com");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders the question and answer as message text, with the dashboard link on a button", () => {
    const payload = buildAskHexclaveDiscordPayload({
      ...baseOptions,
      question: "Q".repeat(300),
      response: "R".repeat(5_000),
    });
    const [body, meta] = textContents(payload);

    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("embeds");
    expect(payload.flags).toBe(1 << 15);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(body?.startsWith(`**${"Q".repeat(300)}**\n\n`)).toBe(true);
    expect(body?.endsWith("…")).toBe(true);
    expect(meta).toContain("Skill /ask");
    expect(meta).toContain("Ada Lovelace");
    expect(meta).toContain("Analytical Engine dashboard, TypeScript and Next.js");
    expect(meta).toContain("203.0.113.10 (x-forwarded-for)");
    expect(meta).toContain("conversation-123");
    expect(textContents(payload).join("").length).toBeLessThanOrEqual(4_000);
    expect(payload.components.at(-1)).toEqual({
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: "Open in dashboard",
        url: DASHBOARD_URL,
      }],
    });
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
    expect(String(url)).toBe("https://discord.com/api/webhooks/123/abc?with_components=true");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      flags: 1 << 15,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 10,
          content: "### How do I configure OAuth?\n\nUse the OAuth provider configuration in your project settings.",
        },
        { type: 14, divider: false, spacing: 1 },
        {
          type: 10,
          content: [
            "-# Ada Lovelace · Analytical Engine dashboard, TypeScript and Next.js",
            "-# Skill /ask · 1,234 ms · 2 steps · test-model",
            "-# skill.hexclave.com · 203.0.113.10 (x-forwarded-for)",
            "-# Reason: User asked about OAuth",
            "-# Prompt: Help me set up OAuth with GitHub",
            "-# Context: Adding authentication to an existing dashboard",
            "-# conversation-123 · skill-test-agent/1.0",
          ].join("\n"),
        },
        {
          type: 1,
          components: [{
            type: 2,
            style: 5,
            label: "Open in dashboard",
            url: DASHBOARD_URL,
          }],
        },
      ],
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
