import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentFeedbackDiscordPayload, sendAgentFeedbackDiscordNotification, type AgentFeedbackNotification } from "./agent-feedback-discord";

const baseFeedback: AgentFeedbackNotification = {
  message: "The OAuth docs say `urls.afterSignIn` but the SDK only accepts `afterSignInUrl`. @everyone",
  category: "docs-gap",
  source: "skill-get",
  context: "Setting up Google OAuth in a Next.js app",
  agent: "Claude Code",
  user: null,
  project: "  ",
  conversationId: null,
  requestIp: "203.0.113.1",
  userAgent: "curl/8.0",
  requestHost: "skill.hexclave.com",
};

describe("agent feedback Discord notifications", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds a payload that omits empty fields and disables mentions", () => {
    expect(buildAgentFeedbackDiscordPayload(baseFeedback)).toMatchInlineSnapshot(`
      {
        "allowed_mentions": {
          "parse": [],
        },
        "embeds": [
          {
            "color": 16096779,
            "description": "The OAuth docs say \`urls.afterSignIn\` but the SDK only accepts \`afterSignInUrl\`. @everyone",
            "fields": [
              {
                "inline": true,
                "name": "Category",
                "value": "docs-gap",
              },
              {
                "inline": true,
                "name": "Source",
                "value": "Skill GET /feedback",
              },
              {
                "inline": false,
                "name": "Context",
                "value": "Setting up Google OAuth in a Next.js app",
              },
              {
                "inline": false,
                "name": "Agent",
                "value": "Claude Code",
              },
              {
                "inline": true,
                "name": "Request IP",
                "value": "203.0.113.1",
              },
              {
                "inline": true,
                "name": "Host",
                "value": "skill.hexclave.com",
              },
              {
                "inline": false,
                "name": "User agent",
                "value": "curl/8.0",
              },
            ],
            "title": "Agent feedback · Docs gap",
          },
        ],
      }
    `);
  });

  it("truncates long messages to fit in a Discord embed", () => {
    const payload = buildAgentFeedbackDiscordPayload({ ...baseFeedback, message: "a".repeat(10_000) });
    expect(payload.embeds[0]?.description?.length).toBe(4_000);
  });

  it("does nothing when the webhook URL env var is unset", async () => {
    vi.stubEnv("HEXCLAVE_AGENT_FEEDBACK_DISCORD_WEBHOOK_URL", "");
    vi.stubEnv("STACK_AGENT_FEEDBACK_DISCORD_WEBHOOK_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendAgentFeedbackDiscordNotification(baseFeedback)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the configured webhook", async () => {
    vi.stubEnv("HEXCLAVE_AGENT_FEEDBACK_DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/123/abc");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendAgentFeedbackDiscordNotification(baseFeedback)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? throwErr("Expected Discord webhook fetch to be called");
    expect(String(url)).toBe("https://discord.com/api/webhooks/123/abc");
    expect(JSON.parse(String(init?.body))).toMatchObject({ embeds: [{ title: "Agent feedback · Docs gap" }] });
  });

  it("throws when Discord rejects the webhook call", async () => {
    vi.stubEnv("HEXCLAVE_AGENT_FEEDBACK_DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/123/abc");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    await expect(sendAgentFeedbackDiscordNotification(baseFeedback)).rejects.toThrow("Failed to send agent feedback Discord notification.");
  });
});
