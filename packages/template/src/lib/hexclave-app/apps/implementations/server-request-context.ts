import { loadAsyncLocalStorage, type AsyncLocalStorageLike } from "@hexclave/shared/dist/utils/async-local-storage";
import type { SpanContext } from "./telemetry-core";

/**
 * Ambient server request context for `withSpan({ request })` / `trackEvent({ request })`.
 *
 * Resolved ONCE from an incoming request — the caller's refresh token + user
 * (server-trusted, from the session), the incoming W3C `traceparent` (which trace
 * this request belongs to), and the client-propagated correlation context
 * (untrusted labels, from the `baggage` header) — then made
 * ambient for the duration of the callback so every span/event created inside,
 * including bare `serverApp.trackEvent(...)` calls, joins the same trace and
 * session without threading the context by hand.
 *
 * AsyncLocalStorage-backed (see span-context.ts for the same rationale) so
 * concurrent requests sharing one app instance never cross-contaminate. If an
 * exact async-context primitive is unavailable, this fails closed and does not
 * expose ambient request context rather than risking cross-request attribution.
 */

/** The resolved request context. */
export type ServerRequestSpanContext = {
  userId: string | null,
  refreshTokenId: string | null,
  sessionReplayId: string | null,
  sessionReplaySegmentId: string | null,
  pageViewSpanId: string | null,
  /**
   * HIERARCHY: the span named by the incoming `traceparent` — normally the
   * caller's OTel HTTP client span. This is the OUTERMOST ambient parent for
   * everything the request does, which is what puts the client fetch and the
   * backend work it triggered in ONE trace. Null when the request arrived with no
   * usable traceparent, in which case the request itself roots a new trace.
   */
  incomingParent: SpanContext | null,
};

/**
 * Applies an explicit server-side user attribution to request context. Session
 * ancestry is only valid when the authenticated request user matches; if the
 * identity differs (including an anonymous request), detach every request-
 * derived id instead of creating mixed-user telemetry.
 */
export function withExplicitServerUser(
  context: ServerRequestSpanContext,
  explicitUserId: string | null,
): ServerRequestSpanContext {
  if (explicitUserId == null || explicitUserId === context.userId) {
    return { ...context, userId: explicitUserId ?? context.userId };
  }
  return {
    userId: explicitUserId,
    refreshTokenId: null,
    sessionReplayId: null,
    sessionReplaySegmentId: null,
    pageViewSpanId: null,
    incomingParent: null,
  };
}

let als: AsyncLocalStorageLike<ServerRequestSpanContext> | null = null;

/** The ambient request context, or null when not inside a `{ request }` scope. */
export function getServerRequestContext(): ServerRequestSpanContext | null {
  return als?.getStore() ?? null;
}

/** Runs `fn` with `context` ambient. Awaits the ALS load first so the very first
 * call gets per-request isolation rather than racing the module load. */
export async function runWithServerRequestContext<T>(context: ServerRequestSpanContext, fn: () => Promise<T>): Promise<T> {
  als ??= await loadAsyncLocalStorage<ServerRequestSpanContext>("server-request-context");
  if (als) {
    return await als.run(context, fn);
  }
  return await fn();
}
