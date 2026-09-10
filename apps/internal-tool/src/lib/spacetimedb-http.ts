import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const WS_TO_HTTP_SCHEME = new Map([
  ["wss://", "https://"],
  ["ws://", "http://"],
]);

/**
 * `NEXT_PUBLIC_SPACETIMEDB_HOST` is a WebSocket URL because the browser client
 * subscribes over WS. SpacetimeDB serves its reducer/procedure/SQL endpoints on
 * the same origin over plain HTTP, so every caller that speaks the HTTP API has
 * to translate the scheme first.
 */
export function wsHostToHttpBase(host: string): string {
  for (const [wsScheme, httpScheme] of WS_TO_HTTP_SCHEME) {
    if (host.startsWith(wsScheme)) return httpScheme + host.slice(wsScheme.length);
  }
  return host;
}

/**
 * Origin for SpacetimeDB's HTTP API. Deliberately lives outside `lib/server/`
 * so non-Next callers (the demo-data seeder in `scripts/`) can reuse it — it
 * reads a public env var and holds no secrets.
 */
export function spacetimedbHttpBase(): string {
  const host = process.env.NEXT_PUBLIC_SPACETIMEDB_HOST;
  if (host == null || host.trim() === "" || host === "REPLACE_ME") {
    throw new HexclaveAssertionError("NEXT_PUBLIC_SPACETIMEDB_HOST is not configured for the internal tool.");
  }
  return wsHostToHttpBase(host);
}
