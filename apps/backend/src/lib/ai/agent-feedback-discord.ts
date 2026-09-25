import { getDiscordWebhookUrlFromEnv, postDiscordWebhook, truncateForDiscord as truncate, type DiscordWebhookPayload } from "@/lib/discord-webhooks";
import type { AgentFeedbackCategory, AgentFeedbackSource } from "@hexclave/shared/dist/ai/agent-feedback";

const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 1_000;

export type AgentFeedbackNotification = {
  message: string,
  category: AgentFeedbackCategory,
  source: AgentFeedbackSource,
  context: string | null,
  agent: string | null,
  user: string | null,
  project: string | null,
  conversationId: string | null,
  requestIp: string | null,
  userAgent: string | null,
  requestHost: string | null,
};

const CATEGORY_LABELS: Record<AgentFeedbackCategory, string> = {
  "bug": "Bug",
  "docs-gap": "Docs gap",
  "agent-ux": "Agent UX",
  "suggestion": "Suggestion",
  "praise": "Praise",
  "other": "Other",
};

const CATEGORY_COLORS: Record<AgentFeedbackCategory, number> = {
  "bug": 0xEF4444,
  "docs-gap": 0xF59E0B,
  "agent-ux": 0x8B5CF6,
  "suggestion": 0x3B82F6,
  "praise": 0x22C55E,
  "other": 0x6B7280,
};

const SOURCE_LABELS: Record<AgentFeedbackSource, string> = {
  "skill-get": "Skill GET /feedback",
  "skill-post": "Skill POST /feedback",
  "cli": "CLI",
  "mcp": "MCP give_feedback",
  "api": "API",
};

export function buildAgentFeedbackDiscordPayload(feedback: AgentFeedbackNotification): DiscordWebhookPayload {
  const optionalFields = [
    ["Context", feedback.context],
    ["Agent", feedback.agent],
    ["User", feedback.user],
    ["Project", feedback.project],
    ["Conversation", feedback.conversationId],
    ["Request IP", feedback.requestIp],
    ["Host", feedback.requestHost],
    ["User agent", feedback.userAgent],
  ] as const;

  return {
    // Feedback is untrusted agent-controlled content; never let it ping users or roles.
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Agent feedback · ${CATEGORY_LABELS[feedback.category]}`,
      description: truncate(feedback.message, MAX_DESCRIPTION_LENGTH),
      color: CATEGORY_COLORS[feedback.category],
      fields: [
        { name: "Category", value: feedback.category, inline: true },
        { name: "Source", value: SOURCE_LABELS[feedback.source], inline: true },
        ...optionalFields.flatMap(([name, value]) => value == null || value.trim() === "" ? [] : [{
          name,
          value: truncate(value, MAX_FIELD_LENGTH),
          inline: name === "Request IP" || name === "Host" || name === "Conversation",
        }]),
      ],
    }],
  };
}

/**
 * Posts agent feedback to the Discord feedback channel. Returns false if no webhook is configured.
 */
export async function sendAgentFeedbackDiscordNotification(feedback: AgentFeedbackNotification): Promise<boolean> {
  const webhookUrl = getDiscordWebhookUrlFromEnv("HEXCLAVE_AGENT_FEEDBACK_DISCORD_WEBHOOK_URL", "agent-feedback-discord-webhook-url");
  if (webhookUrl == null) {
    return false;
  }
  await postDiscordWebhook(webhookUrl, buildAgentFeedbackDiscordPayload(feedback), "Failed to send agent feedback Discord notification.");
  return true;
}
