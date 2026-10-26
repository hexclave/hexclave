import { AsyncLocalStorage } from "node:async_hooks";

export type CookieWrite = {
  name: string,
  value: string,
  options: ResponseCookieOptions,
};

export type ResponseCookieOptions = {
  expires?: Date,
  httpOnly?: boolean,
  maxAge?: number,
  path?: string,
  secure?: boolean,
  sameSite?: "strict" | "lax" | "none",
};

export type RequestContext = {
  /** The inbound client signal. This is deliberately independent of deployment-duration limits. */
  abortSignal: AbortSignal,
  headers: Headers,
  incomingCookies: Map<string, string>,
  pendingSetCookies: CookieWrite[],
  deletedCookies: CookieWrite[],
  /**
   * The matched route pattern (e.g. `/api/latest/users/[user_id]`), NOT the concrete
   * request path. Concrete paths must not be logged or sent to Sentry in production
   * because their params can contain customer identifiers; the pattern carries no
   * customer data, so observability code may use it freely.
   */
  normalizedPath: string,
};

export const requestContextALS = new AsyncLocalStorage<RequestContext>();

export function getRequestContext() {
  const context = requestContextALS.getStore();
  if (context == null) {
    throw new Error("Backend request context is only available while handling a backend request");
  }
  return context;
}

export function getOptionalRequestAbortSignal(): AbortSignal | undefined {
  return requestContextALS.getStore()?.abortSignal;
}

/**
 * The outbound path (`serializeSetCookie` in headers.tsx) percent-encodes values with
 * `encodeURIComponent`, and the pre-ElysiaJS (Next.js) backend decoded on read — so a
 * value written as `a b` must read back as `a b`, not `a%20b`. This helper mirrors that.
 *
 * The try/catch here is a deliberate, narrow exception to the no-catch-all rule: a client
 * may send a cookie we never wrote, containing literal `%` characters that are not valid
 * percent-encodings (`decodeURIComponent` throws a URIError on those). Next.js's cookie
 * parser tolerated such values by falling back to the raw string, and rejecting the whole
 * request over a malformed third-party cookie would be wrong — so we only catch around
 * the `decodeURIComponent` call itself and preserve the raw value.
 */
function decodeCookieValue(rawValue: string): string {
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

export function parseCookieHeader(cookieHeader: string | null) {
  const cookies = new Map<string, string>();
  if (cookieHeader == null || cookieHeader === "") {
    return cookies;
  }
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name === "") {
      continue;
    }
    const rawValue = part.slice(separatorIndex + 1).trim();
    cookies.set(name, decodeCookieValue(rawValue));
  }
  return cookies;
}

import.meta.vitest?.test("parseCookieHeader decodes percent-encoded values", ({ expect }) => {
  expect(parseCookieHeader("foo=a%20b")).toEqual(new Map([["foo", "a b"]]));
});

import.meta.vitest?.test("parseCookieHeader keeps malformed percent-encodings as raw values", ({ expect }) => {
  // e.g. a third-party cookie with a literal "%" that is not a valid encoding
  expect(parseCookieHeader("progress=100%; ratio=50%25")).toEqual(new Map([
    ["progress", "100%"],
    ["ratio", "50%"],
  ]));
});
