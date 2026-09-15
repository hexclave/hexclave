import { useState } from "react";
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
 * assertion error), so callers only need to handle the success body.
 */
export async function postConfirmationRequest(app: StackClientApp, options: {
  endpoint: string,
  body: Record<string, unknown>,
}): Promise<Response> {
  return await app[hexclaveAppInternalsSymbol].sendRequest(options.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body),
  });
}
