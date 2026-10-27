import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const blockedAddressRanges = new net.BlockList();
for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const) {
  blockedAddressRanges.addSubnet(address, prefix, type);
}

export type DnsLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

export function hostnameWithoutIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function normalizeIpv6Address(address: string): string {
  const hostname = hostnameWithoutIpv6Brackets(address);
  try {
    return hostnameWithoutIpv6Brackets(new URL(`http://[${hostname}]/`).hostname).toLowerCase();
  } catch (error) {
    return hostname.toLowerCase();
  }
}

function getIpv4MappedAddress(address: string): string | null {
  const prefix = "::ffff:";
  const normalizedAddress = normalizeIpv6Address(address);
  if (!normalizedAddress.startsWith(prefix)) {
    return null;
  }

  const mappedAddress = normalizedAddress.slice(prefix.length);
  if (net.isIP(mappedAddress) === 4) {
    return mappedAddress;
  }

  const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mappedAddress);
  if (!hexMatch) {
    return null;
  }

  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff) {
    return null;
  }

  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

export function isBlockedPrivateOrReservedIpAddress(address: string): boolean {
  const normalizedAddress = hostnameWithoutIpv6Brackets(address);
  const ipVersion = net.isIP(normalizedAddress);
  if (ipVersion === 4) {
    return blockedAddressRanges.check(normalizedAddress, "ipv4");
  }
  if (ipVersion === 6) {
    const mappedAddress = getIpv4MappedAddress(normalizedAddress);
    if (mappedAddress !== null) {
      return blockedAddressRanges.check(mappedAddress, "ipv4");
    }
    return blockedAddressRanges.check(normalizedAddress, "ipv6");
  }
  return false;
}

export function assertPublicInternetResolvedAddress(address: string, error: Error): void {
  if (isBlockedPrivateOrReservedIpAddress(address)) {
    throw error;
  }
}

export async function assertHostnameResolvesToPublicInternet(hostname: string, error: Error): Promise<void> {
  const addresses = await dns.promises.lookup(hostnameWithoutIpv6Brackets(hostname), { all: true, verbatim: true });
  for (const address of addresses) {
    assertPublicInternetResolvedAddress(address.address, error);
  }
}

function getLookupValidationError(validate: () => void, fallbackMessage: string): NodeJS.ErrnoException | null {
  try {
    validate();
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    return new Error(fallbackMessage);
  }
}

export function publicInternetDnsLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: DnsLookupCallback,
  error: Error,
): void {
  if (options.all) {
    const lookupOptions: dns.LookupAllOptions = { ...options, all: true };
    dns.lookup(hostname, lookupOptions, (lookupError, addresses) => {
      if (lookupError) {
        callback(lookupError, []);
        return;
      }

      const validationError = getLookupValidationError(() => {
        for (const address of addresses) {
          assertPublicInternetResolvedAddress(address.address, error);
        }
      }, "DNS lookup failed while validating resolved addresses.");
      if (validationError !== null) {
        callback(validationError, []);
        return;
      }
      callback(null, addresses);
    });
    return;
  }

  const lookupOptions: dns.LookupOneOptions = { ...options, all: false };
  dns.lookup(hostname, lookupOptions, (lookupError, address, family) => {
    if (lookupError) {
      callback(lookupError, "", 0);
      return;
    }

    const validationError = getLookupValidationError(
      () => assertPublicInternetResolvedAddress(address, error),
      "DNS lookup failed while validating resolved address.",
    );
    if (validationError !== null) {
      callback(validationError, "", 0);
      return;
    }
    callback(null, address, family);
  });
}

/**
 * Performs an HTTP(S) request (without following redirects) that resolves the hostname with the given DNS lookup
 * function. Passing an SSRF-checking lookup (eg. one built on `publicInternetDnsLookup`) makes the check apply to the
 * address that the socket actually connects to; validating the URL separately before a plain `fetch` would leave a
 * DNS-rebinding window.
 *
 * With `responseBody: { type: "buffered" }`, the response body is buffered and capped at `maxBytes`. Callers that only
 * care about the status code should use `{ type: "status-only" }` instead, which resolves as soon as the response
 * headers arrive (with a null body) and discards the body. That matters when the request has side effects: eg. a webhook
 * that accepted a message but replied with a large body must not be reported as a failed request, or the caller would
 * retry and cause the side effect twice.
 */
export async function requestWithDnsLookup(
  url: URL,
  options: {
    method: "GET" | "POST",
    headers: Headers,
    body?: string,
    signal: AbortSignal,
    lookup: (hostname: string, options: dns.LookupOptions, callback: DnsLookupCallback) => void,
    responseBody: { type: "buffered", maxBytes: number } | { type: "status-only" },
    // used in error messages, eg. "OAuth provider"
    description: string,
  },
): Promise<Response> {
  const request = url.protocol === "http:" ? http.request : https.request;

  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      headers: Object.fromEntries(options.headers.entries()),
      lookup: options.lookup,
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
          reject(new Error(`${options.description} connection closed before the response completed.`));
        }
      });
      // Node accepts status codes outside the Fetch Response range. Reject them before constructing a
      // Response inside this event callback, where throws cannot reject our promise.
      const status = res.statusCode;
      if (status === undefined || status < 200 || status > 599) {
        reject(new Error(`${options.description} returned an unsupported HTTP status.`));
        res.destroy();
        return;
      }
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

      const responseBody = options.responseBody;
      if (responseBody.type === "status-only") {
        resolve(new Response(null, { headers: responseHeaders, status, statusText: res.statusMessage }));
        // We don't need the body, so stop receiving it. The resulting `close` event's rejection is a no-op, as the
        // promise has already resolved.
        res.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > responseBody.maxBytes) {
          req.destroy(new Error(`${options.description} response exceeded the maximum allowed size.`));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        // The Response constructor throws a TypeError for a body on null-body statuses, even an empty
        // one. This runs inside an event callback, so that throw would escape the promise as an
        // uncaught exception rather than reject it.
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
          headers: responseHeaders,
          status,
          statusText: res.statusMessage,
        }));
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}
