import type { AskHexclaveRequestMetadata } from "@/lib/ai/ask-hexclave-history";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);
// Discord rejects Components V2 messages whose text displays sum past this.
const DISCORD_TEXT_LIMIT = 4_000;
// A long answer should keep most of the budget. The small print can shrink first.
const DISCORD_META_BUDGET = 800;
// IS_COMPONENTS_V2. Setting it disables top-level content and embeds, which is
// the point: those render as a colored card, and this channel reads as a post.
const DISCORD_COMPONENTS_V2_FLAG = 1 << 15;
const DISCORD_TEXT_DISPLAY = 10;
const DISCORD_SEPARATOR = 14;
const DISCORD_ACTION_ROW = 1;
const DISCORD_BUTTON = 2;
const DISCORD_LINK_BUTTON = 5;

type DiscordTextDisplay = { type: typeof DISCORD_TEXT_DISPLAY, content: string };
type DiscordSeparator = { type: typeof DISCORD_SEPARATOR, divider: false, spacing: 1 };
type DiscordLinkRow = {
  type: typeof DISCORD_ACTION_ROW,
  components: Array<{
    type: typeof DISCORD_BUTTON,
    style: typeof DISCORD_LINK_BUTTON,
    label: string,
    url: string,
  }>,
};

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatTransport(transport: AskHexclaveRequestMetadata["transport"]): string {
  return transport === "skill-ask" ? "Skill /ask" : "MCP ask_hexclave";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function subtext(value: string): string | null {
  const line = singleLine(value);
  if (line === "") {
    return null;
  }
  // `-#` is Discord's small-print markdown. It has to be the start of the line.
  return `-# ${line}`;
}

function formatQuestion(question: string): string {
  // Headings only style the first line, and a paragraph-length heading wraps
  // into a banner. Bold keeps a long or multiline question as normal text.
  if (!question.includes("\n") && question.length <= 180) {
    return `### ${question}`;
  }
  return `**${question}**`;
}

function fitMessage(body: string, meta: string): { body: string, meta: string } {
  if (body.length + meta.length <= DISCORD_TEXT_LIMIT) {
    return { body, meta };
  }
  const metaBudget = Math.min(meta.length, DISCORD_META_BUDGET);
  const fittedBody = truncate(body, DISCORD_TEXT_LIMIT - metaBudget);
  return {
    body: fittedBody,
    meta: truncate(meta, DISCORD_TEXT_LIMIT - fittedBody.length),
  };
}

function buildAskHexclaveDashboardUrl(callId: string): string {
  const dashboardBaseUrl = getEnvVariable("NEXT_PUBLIC_STACK_DASHBOARD_URL", "https://app.hexclave.com").trim();
  const url = new URL("/projects/internal/ask-hexclave-history", dashboardBaseUrl);
  // The history page opens this call directly. Discord messages link here.
  url.searchParams.set("call", callId);
  return url.toString();
}

function buildMeta(options: {
  conversationId: string,
  reason: string,
  userPrompt: string,
  context: string | null,
  user: string | null,
  project: string | null,
  requestMetadata: AskHexclaveRequestMetadata,
  modelId: string,
  stepCount: number,
  durationMs: number,
}): string {
  const transportLabel = formatTransport(options.requestMetadata.transport);
  const ipValue = options.requestMetadata.requestIp == null
    ? null
    : options.requestMetadata.requestIpSource == null
      ? options.requestMetadata.requestIp
      : `${options.requestMetadata.requestIp} (${options.requestMetadata.requestIpSource})`;
  const lines = [
    subtext([options.user, options.project].filter((part) => part != null && part !== "").join(" · ")),
    subtext(`${transportLabel} · ${new Intl.NumberFormat("en-US").format(options.durationMs)} ms · ${options.stepCount} steps · ${options.modelId || "—"}`),
    subtext([options.requestMetadata.requestHost, ipValue].filter((part) => part != null && part !== "").join(" · ")),
    options.reason === "" ? null : subtext(`Reason: ${options.reason}`),
    options.userPrompt === "" ? null : subtext(`Prompt: ${options.userPrompt}`),
    options.context == null || options.context === "" ? null : subtext(`Context: ${options.context}`),
    subtext([options.conversationId, options.requestMetadata.userAgent].filter((part) => part != null && part !== "").join(" · ")),
    options.requestMetadata.mcpProtocolVersion == null
      ? null
      : subtext(`MCP protocol: ${options.requestMetadata.mcpProtocolVersion}`),
  ];
  return lines.filter((line) => line != null).join("\n");
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

function webhookUrlWithComponents(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  // Webhook execution drops components unless this query param is set.
  url.searchParams.set("with_components", "true");
  return url.toString();
}

export function buildAskHexclaveDiscordPayload(options: {
  id: string,
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
  flags: typeof DISCORD_COMPONENTS_V2_FLAG,
  allowed_mentions: { parse: [] },
  components: Array<DiscordTextDisplay | DiscordSeparator | DiscordLinkRow>,
} {
  const dashboardUrl = buildAskHexclaveDashboardUrl(options.id);
  const fitted = fitMessage(
    `${formatQuestion(options.question)}\n\n${options.response}`,
    buildMeta(options),
  );
  const components: Array<DiscordTextDisplay | DiscordSeparator | DiscordLinkRow> = [{
    type: DISCORD_TEXT_DISPLAY,
    content: fitted.body,
  }];
  if (fitted.meta !== "") {
    components.push(
      { type: DISCORD_SEPARATOR, divider: false, spacing: 1 },
      { type: DISCORD_TEXT_DISPLAY, content: fitted.meta },
    );
  }
  components.push({
    type: DISCORD_ACTION_ROW,
    components: [{
      type: DISCORD_BUTTON,
      style: DISCORD_LINK_BUTTON,
      label: "Open in dashboard",
      url: dashboardUrl,
    }],
  });

  return {
    flags: DISCORD_COMPONENTS_V2_FLAG,
    // Question and answer are user-controlled. Keep them from notifying Discord
    // users or roles when they contain mention syntax.
    allowed_mentions: { parse: [] },
    components,
  };
}

export async function sendAskHexclaveDiscordNotification(options: {
  id: string,
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

  const response = await fetch(webhookUrlWithComponents(webhookUrl), {
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
