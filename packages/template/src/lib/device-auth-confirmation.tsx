import { useCallback, useMemo, useRef, useState } from "react";
import type { StackClientApp } from "./hexclave-app/apps/interfaces/client-app";
import { hexclaveAppInternalsSymbol } from "./hexclave-app/common";

/**
 * Building blocks shared by the "confirm on this device" pages — CLI login
 * (`/handler/cli-auth-confirm`) and agent sign-in (`/handler/agent-auth-confirm`).
 *
 * Both pages follow the same shape: read a one-time code from the URL, make
 * sure a *full* user is signed in (restricted users get sent to finish
 * onboarding / sign-up first), then POST that code back to the backend. Only
 * the endpoint, the code's query-param name and what happens on success differ,
 * so those stay in the individual pages.
 */

/** Reads a query parameter once on mount; null during SSR or when missing. */
export function useUrlQueryParam(name: string): string | null {
  const [value] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get(name);
  });
  return value;
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Status + error state for a confirmation page, plus `run`, which executes one
 * user-triggered step at a time: a second click while a step is in flight is
 * ignored (so a double-click cannot POST twice), and any failure lands in the
 * `error` status with the error kept for display and `retry`.
 */
export function useConfirmationFlow<Status extends string>(initialStatus: Status) {
  const [status, setStatus] = useState<Status | "error">(initialStatus);
  const [error, setError] = useState<Error | null>(null);
  const inProgressRef = useRef(false);

  const run = useCallback(async (step: () => Promise<void>) => {
    if (inProgressRef.current) return;
    inProgressRef.current = true;
    try {
      setError(null);
      await step();
    } catch (err) {
      setError(toError(err));
      setStatus("error");
    } finally {
      inProgressRef.current = false;
    }
  }, []);

  const reset = useCallback((nextStatus: Status) => {
    setError(null);
    setStatus(nextStatus);
  }, []);

  // Memoized so pages can list `flow` as a hook dependency without re-running
  // effects on every render.
  return useMemo(() => ({ status, setStatus, error, run, reset }), [status, error, run, reset]);
}

export function getStringField(data: unknown, fieldName: string): string | undefined {
  if (typeof data !== "object" || data === null || !(fieldName in data)) return undefined;
  const value: unknown = data[fieldName as keyof typeof data];
  return typeof value === "string" ? value : undefined;
}

/**
 * A restricted user (anonymous, or signed in but not yet through onboarding)
 * must not be able to hand out access to their account. Sends them to the
 * page that turns them into a full user; the SDK brings them back here after.
 */
export async function redirectRestrictedUserToCompleteSignIn(app: StackClientApp, user: { isAnonymous: boolean }): Promise<void> {
  await (
    user.isAnonymous
      ? app.redirectToSignUp({ replace: true })
      : app.redirectToOnboarding({ replace: true })
  );
}

/**
 * POSTs JSON to a backend endpoint with the current session. `sendRequest`
 * already throws on any non-2xx (known errors as `KnownError`, whose messages
 * are written for end users and safe to render; everything else as an
 * assertion error), so callers only need to handle the parsed success body.
 */
export async function postConfirmationRequest(app: StackClientApp, options: {
  endpoint: string,
  body: Record<string, unknown>,
}): Promise<unknown> {
  const response = await app[hexclaveAppInternalsSymbol].sendRequest(options.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body),
  });
  return await response.json();
}
