import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);

export type DiscordEmbedField = { name: string, value: string, inline?: boolean };

export type DiscordWebhookPayload = {
  content?: string,
  allowed_mentions: { parse: [] },
  embeds: Array<{
    title: string,
    description?: string,
    color: number,
    fields: DiscordEmbedField[],
  }>,
};

export function truncateForDiscord(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Reads and validates a Discord webhook URL from the given env var. Returns null when the env var is empty
 * (sending disabled) or invalid (reported to Sentry under `errorLocation`).
 */
export function getDiscordWebhookUrlFromEnv(envVarName: string, errorLocation: string): string | null {
  const webhookUrl = getEnvVariable(envVarName, "").trim();
  if (webhookUrl === "") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch (error) {
    captureError(errorLocation, new HexclaveAssertionError(
      `${envVarName} is not a valid URL`,
      { cause: error },
    ));
    return null;
  }

  // Discord webhooks are public HTTPS endpoints. Reject anything else so a bad
  // env value cannot turn this notifier into an SSRF footgun.
  if (parsed.protocol !== "https:" || !DISCORD_WEBHOOK_HOSTS.has(parsed.hostname) || !parsed.pathname.startsWith("/api/webhooks/")) {
    captureError(errorLocation, new HexclaveAssertionError(
      `${envVarName} must be an https://discord.com/api/webhooks/... URL`,
      { hostname: parsed.hostname },
    ));
    return null;
  }

  return webhookUrl;
}

export async function postDiscordWebhook(webhookUrl: string, payload: DiscordWebhookPayload, errorMessage: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HexclaveAssertionError(errorMessage, {
      status: response.status,
      body: body.slice(0, 2_000),
    });
  }
}
