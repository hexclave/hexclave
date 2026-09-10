import { CLOUD_HOST_PAIRS } from "@hexclave/shared/dist/utils/cloud-hosts";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

/**
 * The stack-auth ↔ hexclave cloud host pairs live in stack-shared
 * (`utils/cloud-hosts.ts`) so the dashboard and OAuth callback logic can share
 * them. Re-exported here because `tokens.tsx` imports it from this module to
 * build `issuerHostAliases` (and the source-of-truth comment lives with the
 * pairs themselves).
 */
export { CLOUD_HOST_PAIRS };

/**
 * Cloud hosts where this backend serves customer SDK traffic. Each request
 * that arrives on one of these hosts is treated as "branded" to its canonical
 * API host: the JWT `iss` claim and the OAuth `redirect_uri` we send to
 * providers (Google, GitHub, ...) both use the same brand the SDK targeted.
 * That way a customer whose SDK is on `api.stack-auth.com` continues to
 * receive `iss: api.stack-auth.com/...` tokens and OAuth redirect URIs
 * registered with their provider apps as
 * `https://api.stack-auth.com/api/v1/auth/oauth/callback/<provider>`, and a
 * customer whose SDK is on `api.hexclave.com` gets the hexclave-branded
 * equivalents.
 *
 * Fallback/analytics hosts (`api1`, `api2`, `api3`, `r`) map back to the
 * canonical `api` host for the same brand/environment. We should never stamp
 * those load-balancing or recording hosts into customer-facing OAuth callback
 * URLs or JWT issuers.
 *
 * Hosts NOT in this map (localhost, vercel preview URLs, self-host custom
 * domains) fall back to `NEXT_PUBLIC_STACK_API_URL` so single-host deployments
 * keep behaving exactly as before.
 *
 * Trust model: on Vercel, `x-forwarded-host` is set by the edge from the
 * customer-facing hostname and cannot be spoofed by a client. The blast
 * radius of any host-header manipulation is bounded to the allowlist above
 * — a spoofed host that isn't in the list falls back to the env-var default,
 * and the resulting `iss` would still validate via `issuerHostAliases`. The
 * helper does NOT gate on a trusted-proxy signal; it assumes the deployment's
 * proxy chain sets `x-forwarded-host` from a trusted source.
 */
function apiHostAliasesForCanonicalHost(canonicalHost: string): string[] {
  const suffix = canonicalHost.slice("api.".length);
  return [
    canonicalHost,
    `api1.${suffix}`,
    `api2.${suffix}`,
    `api3.${suffix}`,
    `r.${suffix}`,
    ...suffix.startsWith("dev.") ? [`app.${suffix}`] : [],
  ];
}

const CLOUD_API_HOST_BY_REQUEST_HOST = new Map<string, string>(
  CLOUD_HOST_PAIRS
    .flat()
    .flatMap((canonicalHost) => (
      apiHostAliasesForCanonicalHost(canonicalHost).map((requestHost) => [requestHost, canonicalHost] as const)
    )),
);

/**
 * DNS hostnames are at most 253 characters. Longer values are junk (or a
 * spoofed header dumping a blob into logs/Sentry), not a hostname.
 */
const MAX_INBOUND_REQUEST_HOST_LENGTH = 253;

/**
 * Parse a Host / X-Forwarded-Host value into a lowercase hostname with no port.
 * Does not map failover hosts (`api2`) to the canonical `api` host — callers
 * that need branding should use `getApiUrlForHost`.
 *
 * Rejects URL-like junk before stripping the port so `https://evil.example`
 * cannot collapse to `https`.
 */
export function normalizeRequestHost(host: string | undefined | null): string | undefined {
  if (!host) return undefined;
  const firstHost = host.split(",")[0]?.trim();
  if (!firstHost) return undefined;
  // URL pieces in a host header are not a hostname. Check before port-stripping
  // because `https://evil.example` would otherwise become `https`.
  if (
    firstHost.includes("://")
    || firstHost.includes("/")
    || firstHost.includes("?")
    || firstHost.includes("#")
    || firstHost.includes("@")
    || /\s/.test(firstHost)
  ) {
    return undefined;
  }
  let hostname: string | undefined;
  if (firstHost.startsWith("[")) {
    const closingBracketIndex = firstHost.indexOf("]");
    if (closingBracketIndex > 1) {
      hostname = firstHost.slice(1, closingBracketIndex).toLowerCase();
    }
  } else if ((firstHost.match(/:/g) ?? []).length > 1) {
    // Unbracketed IPv6 (what `URL.hostname` returns). A Host header with a port
    // must use bracket form (`[::1]:8102`); more than one colon here is the
    // address itself, not `host:port`.
    hostname = firstHost.toLowerCase();
  } else {
    hostname = firstHost.split(":")[0]?.toLowerCase();
  }
  if (!hostname || hostname.length > MAX_INBOUND_REQUEST_HOST_LENGTH) {
    return undefined;
  }
  return hostname;
}

/**
 * True when `host` is already a normalized inbound hostname we are willing to
 * put in logs or Sentry. Used by the Sentry scrubber as a default-deny check
 * so a crafted `stack-request.host` cannot smuggle a URL through.
 */
export function isSafeInboundRequestHost(host: unknown): host is string {
  return typeof host === "string" && normalizeRequestHost(host) === host;
}

/**
 * The hostname the client actually targeted (`api2.hexclave.com`, not the
 * canonical brand host). Prefer `x-forwarded-host` (edge-set on Vercel / Cloud
 * Run) over `host` over `request.url`, and never collapse failover aliases.
 */
export function getInboundRequestHost(request: Request): string | undefined {
  let urlHostname: string | undefined;
  try {
    urlHostname = new URL(request.url).hostname;
  } catch {
    urlHostname = undefined;
  }
  for (const candidate of [request.headers.get("x-forwarded-host"), request.headers.get("host"), urlHostname]) {
    const normalized = normalizeRequestHost(candidate);
    if (isSafeInboundRequestHost(normalized)) {
      return normalized;
    }
  }
  return undefined;
}

/**
 * Map a request's host header to the canonical API URL to use for any outward-
 * facing identifier produced for that request (JWT issuer, OAuth redirect URI,
 * etc.). Pass the bare hostname (no scheme, no port).
 */
export function getApiUrlForHost(host: string | undefined | null): string {
  const normalizedHost = normalizeRequestHost(host);
  if (normalizedHost) {
    const apiHost = CLOUD_API_HOST_BY_REQUEST_HOST.get(normalizedHost);
    if (apiHost) {
      return `https://${apiHost}`;
    }
  }
  return getEnvVariable("NEXT_PUBLIC_STACK_API_URL");
}

/**
 * Resolve the API URL for the host the incoming request is targeting. Prefers
 * `x-forwarded-host` (set by Vercel's edge proxy) over `host` so we see the
 * customer-facing hostname rather than the internal one.
 *
 * The `headers` shape matches what `smart-route-handler` exposes as `fullReq`:
 * a record of lowercase header names to value arrays.
 */
export function getApiUrlForRequest(req: { headers: Record<string, string[] | undefined> }): string {
  const host = req.headers["x-forwarded-host"]?.[0] ?? req.headers["host"]?.[0];
  return getApiUrlForHost(host);
}

import.meta.vitest?.test("getApiUrlForHost maps cloud sibling hosts to canonical API hosts", ({ expect }) => {
  for (const [stackAuthHost, hexclaveHost] of CLOUD_HOST_PAIRS) {
    for (const canonicalHost of [stackAuthHost, hexclaveHost]) {
      const suffix = canonicalHost.slice("api.".length);
      for (const prefix of ["api", "api1", "api2", "api3", "r"]) {
        expect(getApiUrlForHost(`${prefix}.${suffix}`)).toBe(`https://${canonicalHost}`);
        expect(getApiUrlForHost(`${prefix.toUpperCase()}.${suffix}:443`)).toBe(`https://${canonicalHost}`);
      }
    }
  }
});

import.meta.vitest?.test("getApiUrlForHost maps app.dev sibling hosts to canonical dev API hosts", ({ expect }) => {
  expect(getApiUrlForHost("app.dev.stack-auth.com")).toBe("https://api.dev.stack-auth.com");
  expect(getApiUrlForHost("app.dev.hexclave.com")).toBe("https://api.dev.hexclave.com");
});

import.meta.vitest?.test("getApiUrlForHost falls back for non-cloud hosts without reporting", ({ expect }) => {
  const fallbackApiUrl = getEnvVariable("NEXT_PUBLIC_STACK_API_URL");
  expect(getApiUrlForHost("localhost:8102")).toBe(fallbackApiUrl);
  expect(getApiUrlForHost("p93.localhost:9302")).toBe(fallbackApiUrl);
  expect(getApiUrlForHost("[::1]:8102")).toBe(fallbackApiUrl);
  expect(getApiUrlForHost("customer.example.com")).toBe(fallbackApiUrl);
});

import.meta.vitest?.test("normalizeRequestHost keeps failover hosts and strips ports", ({ expect }) => {
  expect(normalizeRequestHost("api2.hexclave.com")).toBe("api2.hexclave.com");
  expect(normalizeRequestHost("API2.hexclave.com:443")).toBe("api2.hexclave.com");
  expect(normalizeRequestHost("api2.hexclave.com, api.hexclave.com")).toBe("api2.hexclave.com");
  expect(normalizeRequestHost("[::1]:8102")).toBe("::1");
  expect(normalizeRequestHost("::1")).toBe("::1");
});

import.meta.vitest?.test("normalizeRequestHost drops URL-like and oversized junk", ({ expect }) => {
  expect(normalizeRequestHost("https://evil.example")).toBeUndefined();
  expect(normalizeRequestHost("api.hexclave.com/users")).toBeUndefined();
  expect(normalizeRequestHost("api.hexclave.com?x=1")).toBeUndefined();
  expect(normalizeRequestHost("user@api.hexclave.com")).toBeUndefined();
  expect(normalizeRequestHost("api.hexclave.com extra")).toBeUndefined();
  expect(normalizeRequestHost("")).toBeUndefined();
  expect(normalizeRequestHost("a".repeat(254))).toBeUndefined();
});

import.meta.vitest?.test("getInboundRequestHost prefers x-forwarded-host and does not collapse api2", ({ expect }) => {
  const request = new Request("https://api.hexclave.com/api/latest/users/user-secret?secret=do-not-log", {
    headers: {
      "x-forwarded-host": "api2.hexclave.com",
      host: "internal.example:8102",
    },
  });
  expect(getInboundRequestHost(request)).toBe("api2.hexclave.com");
});

import.meta.vitest?.test("getInboundRequestHost falls back to host then URL hostname", ({ expect }) => {
  expect(getInboundRequestHost(new Request("https://api.hexclave.com/x", {
    headers: { host: "api1.hexclave.com:443" },
  }))).toBe("api1.hexclave.com");
  expect(getInboundRequestHost(new Request("https://api.hexclave.com/x"))).toBe("api.hexclave.com");
});

import.meta.vitest?.test("getInboundRequestHost skips malformed forwarded hosts", ({ expect }) => {
  const request = new Request("https://api.hexclave.com/x", {
    headers: {
      "x-forwarded-host": "https://evil.example",
      host: "api2.hexclave.com",
    },
  });
  expect(getInboundRequestHost(request)).toBe("api2.hexclave.com");
});
