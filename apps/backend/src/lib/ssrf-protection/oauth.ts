import { getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import {
  DnsLookupCallback,
  assertHostnameResolvesToPublicInternet,
  assertPublicInternetResolvedAddress,
  hostnameWithoutIpv6Brackets,
  isBlockedPrivateOrReservedIpAddress,
  publicInternetDnsLookup,
} from "./core";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
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
  const url = new URL(urlString);
  const request = url.protocol === "http:" ? http.request : https.request;

  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      headers: Object.fromEntries(options.headers.entries()),
      lookup: safeOAuthDnsLookup,
      method: options.method,
      signal: options.signal,
    }, (res) => {
      // Once response headers have arrived, Node emits mid-body connection failures as an `error`
      // event on the response, not the request. Without this listener such a failure would be an
      // unhandled `error` event (crashing the process) and the promise would never settle.
      res.on("error", reject);
      // Depending on the Node version and how the connection dies, a truncated body may only emit
      // `close` without `error`; reject then too (a no-op if we already resolved on `end`).
      res.on("close", () => {
        if (!res.complete) {
          reject(new Error("OAuth provider connection closed before the response completed."));
        }
      });
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > OAUTH_DOCUMENT_MAX_BYTES) {
          req.destroy(new Error("OAuth provider response exceeded the maximum allowed size."));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              responseHeaders.append(name, item);
            }
          } else if (value != null) {
            responseHeaders.set(name, value);
          }
        }
        // The Response constructor throws a TypeError for a body on null-body statuses, even an empty
        // one. This runs inside an event callback, so that throw would escape the promise as an
        // uncaught exception rather than reject it.
        const status = res.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
          headers: responseHeaders,
          status,
          statusText: res.statusMessage,
        }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}
