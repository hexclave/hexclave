import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import {
  DnsLookupCallback,
  assertHostnameResolvesToPublicInternet,
  assertPublicInternetResolvedAddress,
  hostnameWithoutIpv6Brackets,
  isBlockedPrivateOrReservedIpAddress,
  publicInternetDnsLookup,
  requestWithDnsLookup,
} from "./core";
import dns from "node:dns";
import net from "node:net";

const OAUTH_SSRF_PROTECTION_ERROR = "OAuth provider URLs must use HTTPS and resolve only to public internet addresses.";
const OAUTH_DOCUMENT_MAX_BYTES = 1024 * 1024;

function shouldEnforceOAuthSsrfProtection(): boolean {
  return !["development", "test"].includes(getNodeEnvironment());
}

export function isBlockedOAuthIpAddress(address: string): boolean {
  return isBlockedPrivateOrReservedIpAddress(address);
}

export function assertSafeOAuthUrlWithoutDns(urlString: string): URL {
  let url;
  try {
    url = new URL(urlString);
  } catch (error) {
    throw new StatusError(StatusError.BadRequest, "OAuth provider URL is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new StatusError(StatusError.BadRequest, OAUTH_SSRF_PROTECTION_ERROR);
  }

  if (isBlockedOAuthIpAddress(url.hostname)) {
    throw new StatusError(StatusError.BadRequest, OAUTH_SSRF_PROTECTION_ERROR);
  }

  return url;
}

export async function assertSafeOAuthUrl(urlString: string): Promise<void> {
  if (!shouldEnforceOAuthSsrfProtection()) {
    return;
  }

  const url = assertSafeOAuthUrlWithoutDns(urlString);
  const hostname = hostnameWithoutIpv6Brackets(url.hostname);
  if (net.isIP(hostname) !== 0) {
    return;
  }

  await assertHostnameResolvesToPublicInternet(hostname, new StatusError(StatusError.BadRequest, OAUTH_SSRF_PROTECTION_ERROR));
}

export function assertSafeOAuthResolvedAddress(address: string): void {
  assertPublicInternetResolvedAddress(address, new StatusError(StatusError.BadRequest, OAUTH_SSRF_PROTECTION_ERROR));
}

export function safeOAuthDnsLookup(hostname: string, options: dns.LookupOptions, callback: DnsLookupCallback): void {
  if (!shouldEnforceOAuthSsrfProtection()) {
    dns.lookup(hostname, options, callback);
    return;
  }

  publicInternetDnsLookup(
    hostname,
    options,
    callback,
    new StatusError(StatusError.BadRequest, OAUTH_SSRF_PROTECTION_ERROR),
  );
}

/**
 * Fetches a provider-owned document while applying the same DNS checks to the address that the
 * socket actually connects to. A separate URL check alone would leave a DNS-rebinding window.
 */
export async function safeOAuthFetch(
  urlString: string,
  options: {
    headers: Headers,
    method: "GET",
    redirect: "manual",
    signal: AbortSignal,
  },
): Promise<Response> {
  await assertSafeOAuthUrl(urlString);
  return await requestWithDnsLookup(new URL(urlString), {
    headers: options.headers,
    method: options.method,
    signal: options.signal,
    lookup: safeOAuthDnsLookup,
    maxResponseBytes: OAUTH_DOCUMENT_MAX_BYTES,
    description: "OAuth provider",
  });
}
