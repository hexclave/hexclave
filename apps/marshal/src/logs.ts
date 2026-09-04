import type { FlyClient, FlyLogEntry } from "./fly/client.js";
import type { LogLine } from "./types.js";

// Fly's logs API paginates with an opaque next_token that is in fact a nanosecond
// timestamp; a synthesized token (millis * 1e6) pages from that point in time
// (smoke-verified). That's what makes the contract's since_millis cursor stateless.

export function sinceMillisToNextToken(sinceMillis: number): string {
  // BigInt, not `millis * 1e6`: the product exceeds Number.MAX_SAFE_INTEGER, and for a large
  // millis it would render in exponential notation ("1e+21") that isn't a valid ns token.
  return (BigInt(Math.max(0, Math.floor(sinceMillis))) * 1_000_000n).toString();
}

export function flyEntryToLogLine(entry: FlyLogEntry, options?: { forceNullInstance?: boolean }): LogLine {
  const provider = entry.attributes.meta?.event?.provider;
  const isPlatformEvent = provider !== undefined && provider !== "app";
  // Guard NaN: an unparseable timestamp would otherwise poison the cursor (NaN+1 → JSON null
  // → the caller loses its place and replays from the start).
  const parsedMillis = Date.parse(entry.attributes.timestamp);
  return {
    at_millis: Number.isNaN(parsedMillis) ? 0 : parsedMillis,
    stream: isPlatformEvent ? "system" : entry.attributes.level === "error" ? "stderr" : "stdout",
    instance: options?.forceNullInstance || isPlatformEvent ? null : entry.attributes.instance,
    text: entry.attributes.message,
  };
}

export type LogPage = { lines: LogLine[], nextSinceMillis: number };

export async function fetchLogPage(fly: FlyClient, app: string, options: { sinceMillis?: number, instance?: string, forceNullInstance?: boolean }): Promise<LogPage> {
  const result = await fly.getLogs(app, {
    nextToken: options.sinceMillis !== undefined ? sinceMillisToNextToken(options.sinceMillis) : undefined,
    instance: options.instance,
  });
  const lines = result.entries.map((entry) => flyEntryToLogLine(entry, { forceNullInstance: options.forceNullInstance }));
  // MAX across the page, not the last line: flyEntryToLogLine maps an unparseable timestamp
  // to 0, so a single bad entry at the end of a page would set the cursor to 1 — and the
  // caller, having stored that, would replay the entire log history on the next poll and hit
  // the same rewind again, forever.
  const maxAtMillis = lines.length > 0 ? Math.max(...lines.map((line) => line.at_millis)) : undefined;
  return {
    // +1 so re-polling from next_since_millis doesn't replay the last line (millisecond
    // granularity can drop sub-ms siblings; acceptable for log polling).
    //
    // Clamped to never move BACKWARDS past where the caller already was, for the same reason.
    nextSinceMillis: maxAtMillis !== undefined
      ? Math.max(maxAtMillis + 1, options.sinceMillis ?? 0)
      : options.sinceMillis ?? Date.now(),
    lines,
  };
}

// Drain every page of an app's logs from a starting point — used once per build, at
// finalization, to persist the durable build log to the bucket.
export async function fetchAllLogs(fly: FlyClient, app: string, options: { sinceMillis: number, instance?: string }): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  let nextToken: string | undefined = sinceMillisToNextToken(options.sinceMillis);
  // 200 pages × 100 entries bounds this at 20k lines — plenty for a 15-minute build.
  for (let page = 0; page < 200; page++) {
    const result = await fly.getLogs(app, { nextToken, instance: options.instance });
    lines.push(...result.entries.map((entry) => flyEntryToLogLine(entry, { forceNullInstance: true })));
    if (result.nextToken === null || result.entries.length === 0) break;
    nextToken = result.nextToken;
  }
  return lines;
}
