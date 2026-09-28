import "server-only";

import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { spacetimeDbName } from "../spacetimedb-constants";

const SPACETIMEDB_FETCH_TIMEOUT_MS = 10_000;
const WS_TO_HTTP_SCHEME = new Map([
  ["wss://", "https://"],
  ["ws://", "http://"],
]);

function wsHostToHttpBase(host: string): string {
  for (const [wsScheme, httpScheme] of WS_TO_HTTP_SCHEME) {
    if (host.startsWith(wsScheme)) return httpScheme + host.slice(wsScheme.length);
  }
  return host;
}

function httpBase(): string {
  const host = process.env.NEXT_PUBLIC_SPACETIMEDB_HOST;
  if (host == null || host.trim() === "" || host === "REPLACE_ME") {
    throw new HexclaveAssertionError("NEXT_PUBLIC_SPACETIMEDB_HOST is not configured for the internal tool.");
  }
  return wsHostToHttpBase(host);
}

export async function callReducerStrict(accessToken: string, reducer: string, args: unknown[]): Promise<void> {
  const base = httpBase();
  const res = await fetch(`${base}/v1/database/${encodeURIComponent(spacetimeDbName())}/call/${encodeURIComponent(reducer)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(args, (_, value) => {
      if (typeof value !== "bigint") return value;
      const max = BigInt(Number.MAX_SAFE_INTEGER);
      if (value <= max && value >= -max) return Number(value);
      return value.toString();
    }),
    signal: AbortSignal.timeout(SPACETIMEDB_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const preview = (await res.text()).slice(0, 200);
    throw spacetimeDbError(`Reducer ${reducer} failed`, res.status, preview);
  }
}

function spacetimeDbError(label: string, status: number, preview: string): Error {
  if (status >= 500) return new StatusError(StatusError.BadGateway, `${label} (upstream ${status}): ${preview}`);
  return new HexclaveAssertionError(`${label} (upstream ${status}): ${preview}`);
}

export function opt<T>(value: T | null | undefined): { some: T } | { none: [] } {
  return value == null ? { none: [] } : { some: value };
}

export async function callSql(accessToken: string, sql: string): Promise<Record<string, unknown>[]> {
  const base = httpBase();
  const res = await fetch(`${base}/v1/database/${encodeURIComponent(spacetimeDbName())}/sql`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}` },
    body: sql,
    signal: AbortSignal.timeout(SPACETIMEDB_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const preview = (await res.text()).slice(0, 200);
    throw spacetimeDbError("SQL query failed", res.status, preview);
  }
  const parsed = await res.json() as Array<{
    schema: { elements: Array<{ name: { some?: string } | null }> },
    rows: unknown[][],
  }>;
  if (parsed.length === 0) return [];
  const first = parsed[0];
  const cols = first.schema.elements.map(e => e.name?.some ?? "");
  return first.rows.map(row => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}
