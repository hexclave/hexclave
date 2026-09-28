import type { AskHexclaveRequestMetadata } from "@/lib/ai/ask-hexclave-history";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);
const MAX_CONTENT_LENGTH = 2_000;
const MAX_FIELD_LENGTH = 1_000;
const MAX_QUESTION_CONTENT_LENGTH = 500;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatTransport(transport: AskHexclaveRequestMetadata["transport"]): string {
  return transport === "skill-ask" ? "Skill /ask" : "MCP ask_hexclave";
}

function formatMessageBody(question: string, response: string): string {
  const formattedQuestion = `**${truncate(question, MAX_QUESTION_CONTENT_LENGTH)}**`;
  const responseMaxLength = MAX_CONTENT_LENGTH - formattedQuestion.length - 2;
  return `${formattedQuestion}\n\n${truncate(response, responseMaxLength)}`;
}

function getDiscordWebhookUrl(): string | null {
  const webhookUrl = getEnvVariable("HEXCLAVE_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL", "").trim();
  if (webhookUrl === "") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch (error) {
    captureError("ask-hexclave-discord-webhook-url", new HexclaveAssertionError(
      "HEXCLAVE_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL is not a valid URL",
      { cause: error },
    ));
    return null;
  }

  // Discord webhooks are public HTTPS endpoints. Reject anything else so a bad
  // env value cannot turn this notifier into an SSRF footgun.
  if (parsed.protocol !== "https:" || !DISCORD_WEBHOOK_HOSTS.has(parsed.hostname) || !parsed.pathname.startsWith("/api/webhooks/")) {
    captureError("ask-hexclave-discord-webhook-url", new HexclaveAssertionError(
      "HEXCLAVE_ASK_HEXCLAVE_DISCORD_WEBHOOK_URL must be an https://discord.com/api/webhooks/... URL",
      { hostname: parsed.hostname },
    ));
    return null;
  }

  return webhookUrl;
}

export function buildAskHexclaveDiscordPayload(options: {
  conversationId: string,
  question: string,
  response: string,
  reason: string,
  userPrompt: string,
  context: string | null,
  user: string | null,
  project: string | null,
  requestMetadata: AskHexclaveRequestMetadata,
  modelId: string,
  stepCount: number,
  durationMs: number,
}): {
  content: string,
  allowed_mentions: { parse: [] },
  embeds: Array<{
    title: string,
    color: number,
    fields: Array<{ name: string, value: string, inline?: boolean }>,
  }>,
} {
  const transportLabel = formatTransport(options.requestMetadata.transport);
  const ipValue = options.requestMetadata.requestIp == null
    ? "—"
    : options.requestMetadata.requestIpSource == null
      ? options.requestMetadata.requestIp
      : `${options.requestMetadata.requestIp} (${options.requestMetadata.requestIpSource})`;

  return {
    content: formatMessageBody(options.question, options.response),
    // Question and answer are user-controlled message content. Keep them from
    // notifying Discord users or roles when they contain mention syntax.
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Ask Hexclave · ${transportLabel}`,
      color: options.requestMetadata.transport === "skill-ask" ? 0x3B82F6 : 0x8B5CF6,
      fields: [
        { name: "Reason", value: truncate(options.reason || "—", MAX_FIELD_LENGTH) },
        { name: "Original user prompt", value: truncate(options.userPrompt || "—", MAX_FIELD_LENGTH) },
        { name: "Context", value: truncate(options.context ?? "—", MAX_FIELD_LENGTH) },
        { name: "User", value: truncate(options.user ?? "—", MAX_FIELD_LENGTH) },
        { name: "Project", value: truncate(options.project ?? "—", MAX_FIELD_LENGTH) },
        { name: "Transport", value: transportLabel, inline: true },
        { name: "Duration", value: `${options.durationMs.toLocaleString()} ms`, inline: true },
        { name: "Steps", value: String(options.stepCount), inline: true },
        { name: "Model", value: truncate(options.modelId || "—", MAX_FIELD_LENGTH), inline: true },
        { name: "Request IP", value: truncate(ipValue, MAX_FIELD_LENGTH), inline: true },
        { name: "Host", value: truncate(options.requestMetadata.requestHost ?? "—", MAX_FIELD_LENGTH), inline: true },
        { name: "Conversation", value: truncate(options.conversationId, MAX_FIELD_LENGTH), inline: true },
        { name: "User agent", value: truncate(options.requestMetadata.userAgent ?? "—", MAX_FIELD_LENGTH) },
        ...(options.requestMetadata.mcpProtocolVersion == null ? [] : [{
          name: "MCP protocol",
          value: truncate(options.requestMetadata.mcpProtocolVersion, MAX_FIELD_LENGTH),
          inline: true,
        }]),
      ],
    }],
  };
}

export async function sendAskHexclaveDiscordNotification(options: {
  conversationId: string,
  question: string,
  response: string,
  reason: string,
  userPrompt: string,
  context: string | null,
  user: string | null,
  project: string | null,
  requestMetadata: AskHexclaveRequestMetadata,
  modelId: string,
  stepCount: number,
  durationMs: number,
}): Promise<void> {
  const webhookUrl = getDiscordWebhookUrl();
  if (webhookUrl == null) {
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildAskHexclaveDiscordPayload(options)),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HexclaveAssertionError("Failed to send Ask Hexclave Discord notification.", {
      status: response.status,
      body: body.slice(0, 2_000),
    });
  }
}
