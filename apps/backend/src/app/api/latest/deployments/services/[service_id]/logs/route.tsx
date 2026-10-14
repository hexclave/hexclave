import { getServiceRowOrThrow, marshalNamespaceForTenancy } from "@/lib/deployments";
import { getMarshalClientOrThrow, type MarshalLogLine } from "@/lib/deployments/marshal-client";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { SmartResponse } from "@/route-handlers/smart-response";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, userSpecifiedIdSchema, yupMixed, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";

// Unlike a build log, a runtime log never ends — so this follows until a cap and
// then closes, expecting the client to re-request from where it left off. Every
// line carries its own `at_millis`, so the client's cursor is simply the largest
// one it has seen: there is no separate cursor channel to keep in sync, and a
// reconnect resumes exactly rather than by matching content (see the build-log
// follower in packages/cli/src/lib/build-logs.ts for what the alternative costs).
const MAX_STREAM_MS = 3 * 60 * 1000;
// After a page that produced lines. A busy service should feel live.
const ACTIVE_POLL_INTERVAL_MS = 2000;
// An idle service backs off to this. Every poll is a provider logging API call, and a
// tab left open on a quiet service would otherwise bill one every two seconds
// for as long as someone leaves the browser running.
const MAX_IDLE_POLL_INTERVAL_MS = 10_000;

// How far back a request with no cursor starts. The runtime answers a cursor-less read
// with roughly its last hundred lines, which is the right thing for "open the
// tab and see what it's doing" — so this is deliberately NOT a synthesized
// `now - N minutes`, which would return nothing at all for a service that has
// been quiet for longer than N.
const NO_CURSOR = undefined;

/**
 * `since_millis` as a cursor, or undefined for "start at the tail".
 *
 * Anything unparseable is treated as absent rather than rejected — but it must
 * not be passed through, because providers can silently ignore a malformed cursor and
 * answers with its default window instead of erroring. Forwarding one would
 * replay a hundred lines the reader has already seen and look like a glitch.
 */
function parseSinceMillis(value: string | undefined): number | undefined {
  if (value == null || value === "") return NO_CURSOR;
  const parsed = Number(value);
  // Bounded well below the point where `millis * 1e6` stops being exactly
  // representable, since that product is what becomes the nanosecond cursor.
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 9_000_000_000_000) return NO_CURSOR;
  return parsed;
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Stream deployment service runtime logs",
    description: "Streams a service's runtime (not build) logs as newline-delimited JSON. Each line is `{ at_millis, stream, instance, text }`. With no `since_millis` the stream starts at the tail; pass the largest `at_millis` seen to resume. Follows until a few minutes pass, then closes — re-request to keep following, or pass `follow=false` for a single page. Runtime logs are NOT redacted: whatever the service printed is what you get.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      service_id: userSpecifiedIdSchema("serviceId").defined(),
    }).defined(),
    query: yupObject({
      since_millis: yupString().optional(),
      // "false" returns whatever is available right now and closes. A runtime log
      // has no end, so the default follow is unbounded from the caller's side —
      // which is right for a live view and wrong for anything that reads the whole
      // body before doing anything (curl, a test, a one-shot script).
      follow: yupString().optional(),
    }).defined(),
  }),
  response: yupMixed<SmartResponse>().defined(),
  handler: async ({ auth, params, query }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const row = await getServiceRowOrThrow(prisma, auth.tenancy, params.service_id);
    // A service the runtime has never applied has no resource to read logs from, and
    // providers answer a missing runtime with an empty page — which would render as a
    // silent, permanently-empty stream. Say why instead.
    if (row.provisionedAt == null) {
      throw new StatusError(400, "This service has not been deployed yet, so it has no runtime logs. Run `hexclave deploy` first.");
    }

    const client = getMarshalClientOrThrow();
    const ns = marshalNamespaceForTenancy(auth.tenancy);

    // The first page is fetched BEFORE the response starts, so a misconfigured
    // or unreachable runtime is an honest error status rather than a 200 whose
    // body happens to begin with an error line.
    const firstPage = await client.getServiceLogs(ns, row.serviceId, { sinceMillis: parseSinceMillis(query.since_millis) });

    const follow = query.follow !== "false";
    const encoder = new TextEncoder();
    const encodeLine = (line: MarshalLogLine) => encoder.encode(`${JSON.stringify(line)}\n`);
    // Flipped by cancel() when the reader goes away: the poll loop must stop
    // hitting the runtime, and a disconnect is not an error worth capturing.
    const reader = { cancelled: false };
    // Read through a call, never by touching the flag directly. The loop tests it
    // again after an await, and TypeScript's control-flow analysis — which cannot
    // see cancel() run — would otherwise keep it narrowed to whatever the loop
    // condition implied and report the later checks as unreachable.
    const isCancelled = () => reader.cancelled;

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          // Flush the response headers before waiting on anything. Node sends
          // them with the first body chunk, so a service that is not printing
          // right now would otherwise leave the client with no response at all
          // until a line finally arrived — up to the full follow cap. The reader
          // then cannot tell "quiet" from "still connecting", and the dashboard
          // sits on a spinner instead of saying the service is idle.
          //
          // A blank line rather than a status object: both parsers skip empty
          // lines, so this costs the protocol nothing. Only in follow mode —
          // a single-page response completes on its own.
          if (follow) controller.enqueue(encoder.encode("\n"));
          const startedAt = performance.now();
          let page = firstPage;
          // Seeded with the caller's cursor so the monotonic guard below has a floor
          // from the very first page rather than only from the second.
          let sinceMillis: number | undefined = parseSinceMillis(query.since_millis);
          let idleIntervalMs = ACTIVE_POLL_INTERVAL_MS;

          while (!isCancelled()) {
            for (const line of page.lines) {
              controller.enqueue(encodeLine(line));
            }
            // Keep the cursor strictly monotonic. Out-of-order timestamps can
            // make the runtime hand back a LOWER next_since_millis, and storing
            // that verbatim would re-emit the same lines on every poll instead
            // of making forward progress.
            // Annotated because `sinceMillis` feeds the call below, so letting
            // TS infer these through the assignment is a circular reference.
            const previousSinceMillis: number | undefined = sinceMillis;
            const cursorAdvanced: boolean = previousSinceMillis === undefined || page.next_since_millis > previousSinceMillis;
            // `?? page.next_since_millis` is unreachable — cursorAdvanced is true
            // whenever previousSinceMillis is undefined — but the narrowing does
            // not survive the boolean, and the fallback is the honest one anyway.
            const nextSinceMillis: number = cursorAdvanced ? page.next_since_millis : (previousSinceMillis ?? page.next_since_millis) + 1;
            sinceMillis = nextSinceMillis;

            if (!follow) break;
            if (performance.now() - startedAt > MAX_STREAM_MS) break;

            // Back off while nothing is being printed, and snap back to live the
            // moment it is. A quiet service settles at one call per ten seconds;
            // a chatty one stays at two.
            if (page.lines.length === 0) {
              idleIntervalMs = Math.min(idleIntervalMs * 2, MAX_IDLE_POLL_INTERVAL_MS);
            } else {
              idleIntervalMs = ACTIVE_POLL_INTERVAL_MS;
            }
            await wait(idleIntervalMs);
            if (isCancelled()) break;
            page = await client.getServiceLogs(ns, row.serviceId, { sinceMillis });
          }
          if (!isCancelled()) controller.close();
        } catch (error) {
          if (isCancelled()) {
            // Enqueueing after the reader went away throws; that is the normal
            // disconnect path, not a fault.
            return;
          }
          // The response has already begun, so the status is spent. Emit one
          // final control line — real log lines always carry `at_millis`, so a
          // client can tell them apart without a discriminator on every line —
          // and say nothing about the underlying cause.
          captureError("deployment-service-log-stream", error);
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify({ _error: "The log stream ended unexpectedly. Reload to continue following." })}\n`));
            controller.close();
          } catch {
            // Controller may already be closed or errored; nothing left to do.
          }
        }
      },
      cancel: () => {
        reader.cancelled = true;
      },
    });

    return {
      statusCode: 200,
      bodyType: "response" as const,
      body: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          // no-transform keeps the compression layer (server/compression.ts)
          // from piping this through CompressionStream("gzip"), whose internal
          // buffering would stall the incremental delivery this route is for.
          "cache-control": "no-store, no-transform",
        },
      }),
    };
  },
});
