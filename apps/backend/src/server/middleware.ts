import apiVersions from "@/generated/api-versions.json";
import routes from "@/generated/routes.json";
import { RoutePatternIndex } from "./route-pattern-index";

const migrationRouteIndexes = new Map<string, RoutePatternIndex<(typeof routes)[number]>>();
for (const version of apiVersions) {
  if (version.migrationFolder == null) {
    continue;
  }
  const migrationFolder = version.migrationFolder;
  migrationRouteIndexes.set(migrationFolder, new RoutePatternIndex(
    routes.filter((route) => (route.normalizedPath + "/").startsWith(migrationFolder + "/")),
    (route) => route.normalizedPath,
  ));
}

const corsAllowedRequestHeaders = [
  "content-type",
  "authorization",
  "x-stack-project-id",
  "x-stack-branch-id",
  "x-stack-override-error-status",
  "x-stack-random-nonce",
  "x-stack-client-version",
  "x-stack-disable-artificial-development-delay",
  "x-stack-access-type",
  "x-stack-publishable-client-key",
  "x-stack-secret-server-key",
  "x-stack-super-secret-admin-key",
  "x-stack-admin-access-token",
  "x-stack-refresh-token",
  "x-stack-access-token",
  "x-stack-allow-restricted-user",
  "x-stack-allow-anonymous-user",
  "baggage",
  "sentry-trace",
  "x-vercel-protection-bypass",
  "ngrok-skip-browser-warning",
];

const corsAllowedResponseHeaders = [
  "content-type",
  "x-stack-actual-status",
  "x-stack-known-error",
  // Needed so browser SDKs can tell smart-wrapped 4xx from Next/proxy junk and avoid false failover.
  "x-stack-request-id",
];

function withHexclaveHeaderAliases(headers: string[]): string[] {
  return headers.flatMap((header) => header.startsWith("x-stack-")
    ? [header, `x-hexclave-${header.slice("x-stack-".length)}`]
    : [header]);
}

const corsAllowedRequestHeadersWithAliases = withHexclaveHeaderAliases(corsAllowedRequestHeaders);
const corsAllowedResponseHeadersWithAliases = withHexclaveHeaderAliases(corsAllowedResponseHeaders);

export function getCorsHeadersInit(request: Request): HeadersInit | undefined {
  return new URL(request.url).pathname.startsWith("/api/") ? {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Headers": corsAllowedRequestHeadersWithAliases.join(", "),
    "Access-Control-Expose-Headers": corsAllowedResponseHeadersWithAliases.join(", "),
    "Vary": corsAllowedRequestHeadersWithAliases.join(", "),
  } : undefined;
}

export type PipelineResult = {
  corsHeadersInit?: HeadersInit,
  dispatchPath: string,
  mergedHeaders: Headers,
  originalUrl: string,
  shortCircuitResponse?: Response,
};

export async function runRequestPipeline(request: Request): Promise<PipelineResult> {
  const url = new URL(request.url);

  // Next.js canonicalized URLs with a 308 redirect before any handler ran: `/api/v1/`
  // → 308 `Location: /api/v1`, and duplicate slashes like `/api//v1/users` → 308 to the
  // normalized path. The Elysia cutover initially dropped this — trailing-slash paths
  // were served directly (the route matcher strips trailing slashes) and duplicate-slash
  // paths 404'd — which is a wire-contract change: mixed old/new deployments would see
  // nondeterministic behavior and noncanonical integrations would break. This restores
  // the previous contract so signed URLs, caches, and integrations relying on
  // canonicalization behave identically across old and new deployments. Existing e2e
  // tests fetch `/api/v1/` and assert a 200 because their fetch follows redirects — that
  // held on Next (308→200) and holds again now. This runs before the OPTIONS short-circuit
  // (Next redirected all methods, including OPTIONS). A 308 (not 301/307) preserves the
  // method and body, exactly as Next did.
  const canonicalPathname = getCanonicalPathname(url.pathname);
  if (canonicalPathname !== url.pathname) {
    return {
      corsHeadersInit: getCorsHeadersInit(request),
      dispatchPath: canonicalPathname,
      mergedHeaders: mergeHexclaveHeaderAliases(request.headers),
      originalUrl: request.url,
      shortCircuitResponse: new Response(null, {
        status: 308,
        headers: {
          // The query string is preserved verbatim. Because runs of leading slashes
          // collapse to a single `/`, the Location always starts with exactly one `/`
          // followed by a non-slash character, so it can never be interpreted as a
          // protocol-relative `//host` redirect — which is why this relative redirect
          // is safe against open-redirect abuse.
          "Location": canonicalPathname + url.search,
        },
      }),
    };
  }

  const mergedHeaders = mergeHexclaveHeaderAliases(request.headers);
  ensureForwardedForHeader(mergedHeaders, request);

  const isApiRequest = url.pathname.startsWith("/api/");
  const corsHeadersInit = getCorsHeadersInit(request);

  if (request.method === "OPTIONS" && isApiRequest) {
    return {
      corsHeadersInit,
      dispatchPath: url.pathname,
      mergedHeaders,
      originalUrl: request.url,
      shortCircuitResponse: new Response(null, {
        headers: corsHeadersInit,
      }),
    };
  }

  const dispatchPath = getDispatchPath(url.pathname);
  return {
    corsHeadersInit,
    dispatchPath,
    mergedHeaders,
    originalUrl: request.url,
  };
}

function getCanonicalPathname(pathname: string): string {
  // Mirrors Next.js's URL canonicalization: collapse runs of literal `/` into one and
  // strip the trailing slash (except the root path `/` itself). Operates on the
  // percent-encoded pathname, so encoded characters — including `%2F` — are left
  // untouched; only literal slashes are normalized. Note: WHATWG URL parsing already
  // converts backslashes to forward slashes in special-scheme URLs (http/https), so by
  // the time we have `url.pathname` backslashes are gone — that's why there's no
  // explicit backslash handling here.
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

import.meta.vitest?.test("getCanonicalPathname normalizes literal slashes only", ({ expect }) => {
  expect(getCanonicalPathname("/api/v1/")).toBe("/api/v1");
  expect(getCanonicalPathname("/api//v1//users")).toBe("/api/v1/users");
  expect(getCanonicalPathname("/")).toBe("/");
  expect(getCanonicalPathname("//")).toBe("/");
  expect(getCanonicalPathname("/api/v1")).toBe("/api/v1");
  // Percent-encoded slashes are data, not path separators — they must survive untouched.
  expect(getCanonicalPathname("/api/v1/users/foo%2Fbar")).toBe("/api/v1/users/foo%2Fbar");
});

import.meta.vitest?.test("runRequestPipeline 308-redirects noncanonical paths", async ({ expect }) => {
  const redirected = await runRequestPipeline(new Request("http://localhost/api/v1/?foo=bar"));
  expect(redirected.shortCircuitResponse?.status).toBe(308);
  expect(redirected.shortCircuitResponse?.headers.get("Location")).toBe("/api/v1?foo=bar");

  const canonical = await runRequestPipeline(new Request("http://localhost/api/v1?foo=bar"));
  expect(canonical.shortCircuitResponse).toBe(undefined);
});

function mergeHexclaveHeaderAliases(headers: Headers) {
  const newRequestHeaders = new Headers(headers);
  for (const [name, value] of headers) {
    if (name.startsWith("x-hexclave-")) {
      newRequestHeaders.set(`x-stack-${name.slice("x-hexclave-".length)}`, value);
    }
  }
  return newRequestHeaders;
}

import.meta.vitest?.test("Hexclave header aliases merge into Stack headers", ({ expect }) => {
  const mergedHeaders = mergeHexclaveHeaderAliases(new Headers({
    "x-hexclave-access-token": "test-access-token",
  }));

  expect(mergedHeaders.get("x-stack-access-token")).toBe("test-access-token");
});

const clientIpForwardingHeaders = ["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", "cf-connecting-ip"];

function ensureForwardedForHeader(headers: Headers, request: Request) {
  // Direct connections (local dev, proxy-less self-host) arrive without any forwarding
  // header, so getEndUserIp() finds no client IP and warns on every request. The Node
  // adapter still knows the socket's remote address, so synthesize x-forwarded-for from
  // it — mirroring what the old Next.js dev server did. Behind a real proxy (e.g. Vercel)
  // one of these headers is already set, so this stays a no-op there.
  if (clientIpForwardingHeaders.some((header) => headers.has(header))) {
    return;
  }
  const socketIp = readClientSocketIp(request);
  if (socketIp == null) {
    return;
  }
  headers.set("x-forwarded-for", normalizeClientIp(socketIp));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readClientSocketIp(request: Request): string | undefined {
  // The Node adapter (srvx) augments the web Request with the resolved client IP and
  // the underlying Node socket, neither of which exist on the standard Request type.
  // Read them defensively at runtime instead of casting; on other runtimes (e.g. the
  // Vercel serverless entry) these are simply absent and we fall through to undefined.
  const directIp: unknown = request["ip"];
  if (typeof directIp === "string" && directIp !== "") {
    return directIp;
  }
  const runtime: unknown = request["runtime"];
  const node: unknown = isRecord(runtime) ? runtime.node : undefined;
  const req: unknown = isRecord(node) ? node.req : undefined;
  const socket: unknown = isRecord(req) ? req.socket : undefined;
  const remoteAddress: unknown = isRecord(socket) ? socket.remoteAddress : undefined;
  return typeof remoteAddress === "string" && remoteAddress !== "" ? remoteAddress : undefined;
}

function normalizeClientIp(ip: string): string {
  // Node sockets report IPv4 clients as IPv4-mapped IPv6 (e.g. "::ffff:127.0.0.1").
  // Normalize to the plain IPv4 form so it matches what proxies put in x-forwarded-for.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : ip;
}

import.meta.vitest?.test("ensureForwardedForHeader synthesizes the client IP for direct connections", ({ expect }) => {
  // Uses the adapter-provided client IP when no forwarding header is present.
  const fromIp = new Headers();
  ensureForwardedForHeader(fromIp, Object.assign(new Request("http://localhost/api/v1"), { ip: "203.0.113.7" }));
  expect(fromIp.get("x-forwarded-for")).toBe("203.0.113.7");

  // Falls back to the raw Node socket and normalizes IPv4-mapped IPv6 to plain IPv4.
  const fromSocket = new Headers();
  ensureForwardedForHeader(fromSocket, Object.assign(new Request("http://localhost/api/v1"), {
    runtime: { node: { req: { socket: { remoteAddress: "::ffff:127.0.0.1" } } } },
  }));
  expect(fromSocket.get("x-forwarded-for")).toBe("127.0.0.1");

  // Never overwrites an existing forwarding header (e.g. behind a trusted proxy like Vercel).
  const existing = new Headers({ "x-forwarded-for": "198.51.100.1" });
  ensureForwardedForHeader(existing, Object.assign(new Request("http://localhost/api/v1"), { ip: "203.0.113.7" }));
  expect(existing.get("x-forwarded-for")).toBe("198.51.100.1");

  // No socket info available (e.g. an unusual runtime) → leaves headers untouched.
  const none = new Headers();
  ensureForwardedForHeader(none, new Request("http://localhost/api/v1"));
  expect(none.get("x-forwarded-for")).toBe(null);
});

function getDispatchPath(originalPathname: string) {
  let pathname = originalPathname;
  outer: for (let i = 0; i < apiVersions.length - 1; i++) {
    const version = apiVersions[i];
    const nextVersion = apiVersions[i + 1];
    if (!nextVersion.migrationFolder) {
      throw new Error(`No migration folder found for version ${nextVersion.name}. This is a bug because every version except the first should have a migration folder.`);
    }
    if ((pathname + "/").startsWith(version.servedRoute + "/")) {
      const nextPathname = pathname.replace(version.servedRoute, nextVersion.servedRoute);
      const migrationPathname = nextPathname.replace(nextVersion.servedRoute, nextVersion.migrationFolder);
      const migrationRouteIndex = migrationRouteIndexes.get(nextVersion.migrationFolder);
      if (migrationRouteIndex == null) {
        throw new Error(`No route index found for migration folder ${JSON.stringify(nextVersion.migrationFolder)}`);
      }
      if (migrationRouteIndex.hasMatch(migrationPathname)) {
        pathname = migrationPathname;
        break outer;
      }
      pathname = nextPathname;
    }
  }
  return pathname;
}
