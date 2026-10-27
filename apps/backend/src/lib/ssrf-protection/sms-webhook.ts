import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import dns from "node:dns";
import net from "node:net";
import {
  DnsLookupCallback,
  assertHostnameResolvesToPublicInternet,
  hostnameWithoutIpv6Brackets,
  isBlockedPrivateOrReservedIpAddress,
  publicInternetDnsLookup,
  requestWithDnsLookup,
} from "./core";

const SMS_WEBHOOK_SSRF_PROTECTION_ERROR = "SMS webhook URLs must use HTTPS and resolve only to public internet addresses.";

/**
 * SMS webhook URLs are provided by the project, so outside of development and tests (where they legitimately point at
 * localhost) we only allow HTTPS URLs on the public internet.
 */
function shouldEnforceSmsWebhookSsrfProtection(): boolean {
  return !["development", "test"].includes(getNodeEnvironment());
}

function safeSmsWebhookDnsLookup(hostname: string, options: dns.LookupOptions, callback: DnsLookupCallback): void {
  if (!shouldEnforceSmsWebhookSsrfProtection()) {
    dns.lookup(hostname, options, callback);
    return;
  }
  publicInternetDnsLookup(hostname, options, callback, new StatusError(StatusError.BadRequest, SMS_WEBHOOK_SSRF_PROTECTION_ERROR));
}

async function assertSafeSmsWebhookUrl(url: URL): Promise<void> {
  if (!shouldEnforceSmsWebhookSsrfProtection()) {
    return;
  }
  const hostname = hostnameWithoutIpv6Brackets(url.hostname);
  if (url.protocol !== "https:" || isBlockedPrivateOrReservedIpAddress(hostname)) {
    throw new StatusError(StatusError.BadRequest, SMS_WEBHOOK_SSRF_PROTECTION_ERROR);
  }
  if (net.isIP(hostname) === 0) {
    await assertHostnameResolvesToPublicInternet(hostname, new StatusError(StatusError.BadRequest, SMS_WEBHOOK_SSRF_PROTECTION_ERROR));
  }
}

/**
 * POSTs to a project-provided SMS webhook URL. The SSRF checks are applied to the address the socket actually connects
 * to (see `requestWithDnsLookup`), and redirects are never followed.
 */
export async function postToSmsWebhook(urlString: string, options: { headers: Headers, body: string, signal: AbortSignal }): Promise<Response> {
  const url = new URL(urlString);
  await assertSafeSmsWebhookUrl(url);
  return await requestWithDnsLookup(url, {
    method: "POST",
    headers: options.headers,
    body: options.body,
    signal: options.signal,
    lookup: safeSmsWebhookDnsLookup,
    // We only care about the status code. Rejecting large bodies instead would report a webhook that accepted the
    // message as a delivery failure, and the user would request a second code.
    responseBody: { type: "status-only" },
    description: "SMS webhook",
  });
}
