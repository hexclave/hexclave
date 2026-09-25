import { cookies as rscCookies, headers as rscHeaders } from '@hexclave/sc/force-react-server'; // THIS_LINE_PLATFORM next
import { isBrowserLike } from '@hexclave/shared/dist/utils/env';
import { HexclaveAssertionError } from '@hexclave/shared/dist/utils/errors';
import * as tanstackStartServerContext from "@hexclave/tanstack-start/tanstack-start-server-context"; // THIS_LINE_PLATFORM tanstack-start
import Cookies from "js-cookie";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier, generateRandomState } from "oauth4webapi";


// INFO: This file is used to manage cookies. It also sets some cookie flags automatically, see this description.
//
// It provides asynchronous setCookie, getCookie, deleteCookie, etc. functions that can be used in various environments
// (browser + Next.js for now). Under the hood, they just get a CookieHelper object and then set the cookies there.
//
// The CookieHelper object is a simple object that lets you set, get and delete cookies synchronously. Acquiring one
// is asynchronous (except for browser environments, where they can be acquired synchronously), but once you have it,
// you can use it synchronously. This function is useful if you cannot await in the calling code, but otherwise you
// should prefer to await the functions directly.
//
// Some cookie flags are set automatically by the CookieHelper (and hence also the <xyz>Cookie functions).
// In particular:
//  - SameSite is set to `Lax` by default, which is already true in Chromium-based browsers, so this creates
//    compatibility with other browsers that use either Strict or None (particularly Safari and Firefox, and older
//    versions of Chrome). If Partitioned is automatically set (as described below), then this value is set to `None`
//    instead.
//  - Secure is set depending on whether we could successfully determine that the client is on HTTPS. For this, we use a
//    set of heuristics:
//     - In a browser environment, we check window.location.protocol which is always accurate
//     - In a Next.js server environment:
//        - First we check the `stack-is-https` cookie, which is set in various places on the
//          client with a Secure attribute. If that one is passed on to the server, we know that the client is on HTTPS
//          and we can set the Secure flag on the cookie. TODO: Should we also do this with a second cookie with a
//          __Host- prefix, so a malicious subdomain of the current domain cannot forcibly enable HTTPS mode and
//          therefore prevent new cookies from being set?
//        - Otherwise, we check the X-Forwarded-Proto header. If that one is `https`, we know that the client is
//          (pretending to be) on HTTPS and we can set the Secure flag on the cookie. Note that this header is
//          spoofable by malicious clients (so is the cookie actually), but since setting this value can only *increase*
//          security (and therefore prevent setting of a cookie), and requires a malicious client, this is still safe.
//        - If neither of the above is true, we don't set the Secure flag on the cookie.
//  - Partitioned is set depending on whether it is needed & supported. Unfortunately, the fact that Partitioned
//    cookies require SameSite=None, browsers that don't support it will still set them as normal third-party cookies,
//    which are fundamentally unsafe. Therefore, we need to take extra care that we only ever set Partitioned cookies
//    if we know for sure that the browser supports it.
//    - In a browser environment, we check:
//       - Whether `Secure` is set. If it's not, we don't set Partitioned.
//       - Whether we can set & retrieve cookies without Partitioned being set. If this is the case, we are likely in a
//         top-level context or a browser that partitions cookies by default (eg. Firefox). In this case, we don't need
//         Partitioned and can just proceed as normal.
//       - Whether CHIPS is supported. To prevent the case where CHIPS is not supported but third-party cookies are (in
//         which we would accidentally set SameSite=None without Partitioned as the latter requires the former), we
//         check this by running a simple test with document.cookie.
//       - Whether the browser supports Partitioned cookies. If yes, set Partitioned. Otherwise, don't set Partitioned.
//         Since there's no easy cross-compat way to do this (CookieStore and document.cookie do not return whether a
//         cookie is partitioned on some/all versions of Safari and Firefox), we use a heuristic; we run this test by
//         creating two cookies with the same name: One with Partitioned and one without. If there are two resulting
//         cookies, that means they were put into different jars, implying that the browser supports Partitioned cookies
//         (but doesn't partition cookies by default). If they result in just one cookie, that could mean that the
//         browser doesn't support Partitioned cookies, or that the browser doesn't put partitioned cookies into
//         different jars by default, in which case we still don't know. This heuristic works on Chrome, but may
//         incorrectly conclude that some other browsers don't support Partitioned. But from a security perspective,
//         that is better than accidentally setting SameSite=None without Partitioned. TODO: Find a better heuristic to
//         to determine whether the browser supports Partitioned cookies or not.
//    - In a Next.js server environment, right now we do nothing because of the complexity involved :( TODO: In the
//      future, we could improve this for example by setting hint cookies from the client, but we need to make sure that
//      no malicious actor (eg. on a malicious subdomain) can forcefully enable Partitioned cookies on a browser that
//      does not support it.


type SetCookieOptions = { maxAge: number | "session", noOpIfServerComponent?: boolean, domain?: string, secure?: boolean };
type DeleteCookieOptions = { noOpIfServerComponent?: boolean, domain?: string };

// IF_PLATFORM tanstack-start
let tanStackStartCookieHelperPromise: Promise<CookieHelper> | null = null;

function getTanStackStartServerContext() {
  const {
    deleteCookie,
    getCookie,
    getCookies,
    getRequestHeader,
    setCookie,
  } = tanstackStartServerContext;
  if (
    deleteCookie == null
    || getCookie == null
    || getCookies == null
    || getRequestHeader == null
    || setCookie == null
  ) {
    throw new HexclaveAssertionError("TanStack Start server context is only available during server rendering");
  }
  return {
    deleteCookie,
    getCookie,
    getCookies,
    getRequestHeader,
    setCookie,
  };
}
// END_PLATFORM

function ensureClient() {
  if (!isBrowserLike()) {
    throw new Error("cookieClient functions can only be called in a browser environment, yet window is undefined");
  }
}

export type CookieHelper = {
  /**
   * Stable for the browser or server request that owns this helper. Consumers use this to share request-local state
   * even when multiple helper wrappers are created for the same underlying cookie store.
   */
  readonly identity: object,
  get: (name: string) => string | null,
  getAll: () => Record<string, string>,
  set: (name: string, value: string, options: SetCookieOptions) => void,
  setOrDelete: (name: string, value: string | null, options: SetCookieOptions & DeleteCookieOptions) => void,
  delete: (name: string, options: DeleteCookieOptions) => void,
};

const placeholderCookieHelperIdentity = { "placeholder cookie helper identity": true };
export async function createPlaceholderCookieHelper(): Promise<CookieHelper> {
  function throwError(): never {
    throw new HexclaveAssertionError("Throwing cookie helper is just a placeholder. This should never be called");
  }
  return {
    identity: placeholderCookieHelperIdentity,
    get: throwError,
    getAll: throwError,
    set: throwError,
    setOrDelete: throwError,
    delete: throwError,
  };
}

function requiresSecureAttribute(name: string): boolean {
  return name.startsWith("__Host-");
}

function validateCookieOptions(name: string, options: DeleteCookieOptions | SetCookieOptions) {
  if (requiresSecureAttribute(name) && options.domain !== undefined) {
    throw new HexclaveAssertionError("__Host- cookies must not specify a Domain attribute");
  }
}

export async function createCookieHelper(): Promise<CookieHelper> {
  if (isBrowserLike()) {
    return createBrowserCookieHelper();
  } else {
    // IF_PLATFORM next
    return createNextCookieHelper(
      await rscCookies(),
      await rscHeaders(),
    );
    // ELSE_IF_PLATFORM tanstack-start
    if (import.meta.env?.SSR) {
      const cookieHelperPromise = tanStackStartCookieHelperPromise
        ?? Promise.resolve(createTanStackStartCookieHelper(getTanStackStartServerContext()));
      tanStackStartCookieHelperPromise = cookieHelperPromise;
      return await cookieHelperPromise;
    }
    return await createPlaceholderCookieHelper();
    // ELSE_PLATFORM
    return await createPlaceholderCookieHelper();
    // END_PLATFORM
  }
}

export function createCookieHelperSync(): CookieHelper {
  if (isBrowserLike()) {
    return createBrowserCookieHelper();
  }
  function throwError(): never {
    throw new HexclaveAssertionError("Synchronous server cookie helpers are not available on this platform");
  }
  return {
    identity: placeholderCookieHelperIdentity,
    get: throwError,
    getAll: throwError,
    set: throwError,
    setOrDelete: throwError,
    delete: throwError,
  };
}

// IF_PLATFORM tanstack-start
function determineSecureFromTanStackStartContext(api: ReturnType<typeof getTanStackStartServerContext>): boolean {
  return api.getRequestHeader("x-forwarded-proto") === "https"
    // Hexclave rebrand: dual-read the is-https hint cookie, preferring the new name
    || (api.getCookie("hexclave-is-https") !== undefined)
    || (api.getCookie("stack-is-https") !== undefined);
}

function refreshTanStackStartIsHttpsCookie(api: ReturnType<typeof getTanStackStartServerContext>) {
  // Hexclave rebrand: dual-write the is-https hint cookie under both names
  for (const cookieName of ["hexclave-is-https", "stack-is-https"]) {
    api.setCookie(cookieName, "true", {
      secure: true,
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      path: "/",
    });
  }
}

function createTanStackStartCookieHelper(api: ReturnType<typeof getTanStackStartServerContext>): CookieHelper {
  const helper: CookieHelper = {
    identity: api,
    get: (name: string) => {
      const all = helper.getAll();
      return all[name] ?? null;
    },
    getAll: () => {
      // set a helper cookie, see comment in `NextCookieHelper.set` below
      refreshTanStackStartIsHttpsCookie(api);
      return api.getCookies();
    },
    set: (name: string, value: string, options: SetCookieOptions) => {
      validateCookieOptions(name, options);
      api.setCookie(name, value, {
        secure: requiresSecureAttribute(name) || (options.secure ?? determineSecureFromTanStackStartContext(api)),
        maxAge: options.maxAge === "session" ? undefined : options.maxAge,
        domain: options.domain,
        sameSite: "lax",
        path: "/",
      });
    },
    setOrDelete: (name, value, options) => {
      if (value === null) helper.delete(name, options);
      else helper.set(name, value, options);
    },
    delete: (name: string, options: DeleteCookieOptions) => {
      validateCookieOptions(name, options);
      const secure = requiresSecureAttribute(name) || determineSecureFromTanStackStartContext(api);
      api.deleteCookie(name, {
        secure,
        domain: options.domain,
        path: "/",
      });
    },
  };
  return helper;
}
// END_PLATFORM

const browserCookieHelperIdentity = { "browser cookie helper identity": true };
export function createBrowserCookieHelper(): CookieHelper {
  return {
    identity: browserCookieHelperIdentity,
    get: getCookieClient,
    getAll: getAllCookiesClient,
    set: setCookieClient,
    setOrDelete: setOrDeleteCookieClient,
    delete: deleteCookieClient,
  };
}

function handleCookieError(e: unknown, options: DeleteCookieOptions | SetCookieOptions) {
  if (e instanceof Error && e.message.includes("Cookies can only be modified in")) {
    if (options.noOpIfServerComponent) {
      // ignore
    } else {
      throw new HexclaveAssertionError("Attempted to set cookie in server component. Pass { noOpIfServerComponent: true } in the options of Stack's cookie functions if this is intentional and you want to ignore this error. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options");
    }
  } else {
    throw e;
  }
}

// IF_PLATFORM next
function createNextCookieHelper(
  rscCookiesAwaited: Awaited<ReturnType<typeof rscCookies>>,
  rscHeadersAwaited: Awaited<ReturnType<typeof rscHeaders>>,
): CookieHelper {
  const cookieHelper = {
    identity: rscCookiesAwaited,
    get: (name: string) => {
      const all = cookieHelper.getAll();
      return all[name] ?? null;
    },
    getAll: () => {
      // set a helper cookie, see comment in `NextCookieHelper.set` below
      try {
        // Hexclave rebrand: dual-write the is-https hint cookie under both names
        rscCookiesAwaited.set("hexclave-is-https", "true", { secure: true, expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365) });
        rscCookiesAwaited.set("stack-is-https", "true", { secure: true, expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365) });
      } catch (e) {
        if (
          typeof e === 'object'
          && e !== null
          && 'message' in e
          && typeof e.message === 'string'
          && e.message.includes('Cookies can only be modified in a Server Action or Route Handler')
        ) {
          // ignore
        } else {
          throw e;
        }
      }
      const all = rscCookiesAwaited.getAll();
      return all.reduce((acc, entry) => {
        acc[entry.name] = entry.value;
        return acc;
      }, {} as Record<string, string>);
    },
    set: (name: string, value: string, options: SetCookieOptions) => {
      validateCookieOptions(name, options);
      // Whenever the client is on HTTPS, we want to set the Secure flag on the cookie.
      //
      // This is not easy to find out on a Next.js server, so see the algorithm at the top of this file.
      //
      // Note that malicious clients could theoretically manipulate the `stack-is-https` cookie or
      // the `X-Forwarded-Proto` header; that wouldn't cause any trouble except for themselves,
      // though.
      const isSecureCookie = determineSecureFromServerContext(rscCookiesAwaited, rscHeadersAwaited);

      try {
        rscCookiesAwaited.set(name, value, {
          secure: requiresSecureAttribute(name) || isSecureCookie,
          maxAge: options.maxAge === "session" ? undefined : options.maxAge,
          domain: options.domain,
          sameSite: "lax",
          path: "/",
        });
      } catch (e) {
        handleCookieError(e, options);
      }
    },
    setOrDelete(name: string, value: string | null, options: SetCookieOptions & DeleteCookieOptions) {
      if (value === null) {
        this.delete(name, options);
      } else {
        this.set(name, value, options);
      }
    },
    delete(name: string, options: DeleteCookieOptions) {
      try {
        validateCookieOptions(name, options);
        if (options.domain !== undefined) {
          rscCookiesAwaited.delete({ name, domain: options.domain, path: "/" });
        } else {
          rscCookiesAwaited.delete({ name, path: "/" });
        }
      } catch (e) {
        handleCookieError(e, options);
      }
    },
  };
  return cookieHelper;
}
// END_PLATFORM

export function getCookieClient(name: string): string | null {
  const all = getAllCookiesClient();
  return all[name] ?? null;
}

export function getAllCookiesClient(): Record<string, string> {
  ensureClient();
  // set a helper cookie, see comment in `NextCookieHelper.set` above
  // Hexclave rebrand: dual-write the is-https hint cookie under both names
  Cookies.set("hexclave-is-https", "true", { secure: true, expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365) });
  Cookies.set("stack-is-https", "true", { secure: true, expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365) });
  return Cookies.get();
}

export async function getCookie(name: string): Promise<string | null> {
  const cookieHelper = await createCookieHelper();
  return cookieHelper.get(name);
}

export async function isSecure(): Promise<boolean> {
  if (isBrowserLike()) {
    return determineSecureFromClientContext();
  }
  // IF_PLATFORM next
  return determineSecureFromServerContext(await rscCookies(), await rscHeaders());
  // ELSE_IF_PLATFORM tanstack-start
  if (import.meta.env?.SSR) {
    return determineSecureFromTanStackStartContext(getTanStackStartServerContext());
  }
  // END_PLATFORM
  return false;
}

function determineSecureFromClientContext(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}
// IF_PLATFORM next
function determineSecureFromServerContext(
  cookies: Awaited<ReturnType<typeof rscCookies>>,
  headers: Awaited<ReturnType<typeof rscHeaders>>,
): boolean {
  // see the algorithm at the top of this file
  // TODO: We should probably also check that the stack-is-https cookie has a Secure attribute itself,
  // TODO: We should consider adding another cookie __Host-stack-is-https, see the comment in the algorithm at the top of this file
  // Hexclave rebrand: dual-read the is-https hint cookie, preferring the new name
  return cookies.has("hexclave-is-https") || cookies.has("stack-is-https") || headers.get("x-forwarded-proto") === "https";
}
// END_PLATFORM


let _shouldSetPartitionedClientCache: boolean | undefined = undefined;
function shouldSetPartitionedClient() {
  return _shouldSetPartitionedClientCache ??= _internalShouldSetPartitionedClient();
}
function _internalShouldSetPartitionedClient() {
  ensureClient();

  if (!(determineSecureFromClientContext())) {
    return false;
  }

  // check whether we can set & retrieve normal cookies (either because we're on a top-level/same-origin context or the browser partitions cookies by default)
  const cookie1Name = "__Host-stack-temporary-chips-test-" + Math.random().toString(36).substring(2, 15);
  document.cookie = `${cookie1Name}=value1; Secure; path=/`;
  const cookies1 = document.cookie.split("; ");
  document.cookie = `${cookie1Name}=delete1; Secure; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;`;
  if (cookies1.some((c) => c.startsWith(cookie1Name + "="))) {
    return false;
  }


  // check whether Partitioned cookies are supported by the browser
  // TODO: See comment at the top. Feels like we should find a better way to do this
  const cookie2Name = "__Host-stack-temporary-chips-test-" + Math.random().toString(36).substring(2, 15);

  // just to be safe, delete the cookie first to avoid weird RNG-prediction attacks
  // I don't know what they look like (since this is a host cookie) but better safe than sorry
  // (this function should be 100% bulletproof so we don't accidentally fall back to non-partitioned third party cookies on unsupported browsers)
  document.cookie = `${cookie2Name}=delete1; Secure; SameSite=None; Partitioned; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
  document.cookie = `${cookie2Name}=delete2; Secure; SameSite=None; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;

  // set the cookie, once partitioned and once not partitioned
  document.cookie = `${cookie2Name}=set1; Secure; SameSite=None; Partitioned; path=/`;
  document.cookie = `${cookie2Name}=set2; Secure; SameSite=None; path=/`;

  // check if there are two cookies
  const cookies2 = document.cookie.split("; ");
  const numberOfCookiesWithThisName = cookies2.filter((c) => c.startsWith(cookie2Name + "=")).length;

  // clean up
  document.cookie = `${cookie2Name}=delete3; Secure; SameSite=None; Partitioned; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
  document.cookie = `${cookie2Name}=delete4; Secure; SameSite=None; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;

  return numberOfCookiesWithThisName === 2;
}

function setCookieClientInternal(name: string, value: string, options: SetCookieOptions) {
  validateCookieOptions(name, options);
  const secure = requiresSecureAttribute(name) || (options.secure ?? determineSecureFromClientContext());
  const partitioned = shouldSetPartitionedClient();
  Cookies.set(name, value, {
    expires: options.maxAge === "session" ? undefined : new Date(Date.now() + (options.maxAge) * 1000),
    domain: options.domain,
    secure,
    path: "/",
    sameSite: "Lax",
    ...(partitioned ? {
      partitioned,
      sameSite: "None",
    } : {}),
  });
}

function deleteCookieClientInternal(name: string, options: DeleteCookieOptions) {
  validateCookieOptions(name, options);
  for (const partitioned of [true, false]) {
    if (options.domain !== undefined) {
      Cookies.remove(name, { domain: options.domain, secure: determineSecureFromClientContext(), partitioned, path: "/" });
    }
    Cookies.remove(name, { secure: requiresSecureAttribute(name) || determineSecureFromClientContext(), partitioned, path: "/" });
  }
}

export function setOrDeleteCookieClient(name: string, value: string | null, options: SetCookieOptions & DeleteCookieOptions) {
  ensureClient();
  if (value === null) {
    deleteCookieClientInternal(name, options);
  } else {
    setCookieClientInternal(name, value, options);
  }
}

export async function setOrDeleteCookie(name: string, value: string | null, options: SetCookieOptions & DeleteCookieOptions) {
  const cookieHelper = await createCookieHelper();
  cookieHelper.setOrDelete(name, value, options);
}

export function deleteCookieClient(name: string, options: DeleteCookieOptions) {
  ensureClient();
  deleteCookieClientInternal(name, options);
}

export async function deleteCookie(name: string, options: DeleteCookieOptions) {
  const cookieHelper = await createCookieHelper();
  cookieHelper.delete(name, options);
}

export function setCookieClient(name: string, value: string, options: SetCookieOptions) {
  ensureClient();
  setCookieClientInternal(name, value, options);
}

export async function setCookie(name: string, value: string, options: SetCookieOptions) {
  const cookieHelper = await createCookieHelper();
  cookieHelper.set(name, value, options);
}

export async function saveVerifierAndState() {
  const codeVerifier = generateRandomCodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = generateRandomState();

  // Hexclave rebrand: dual-write the OAuth outer-state cookie under both names
  await setCookie("hexclave-oauth-outer-" + state, codeVerifier, { maxAge: 60 * 60 });
  await setCookie("stack-oauth-outer-" + state, codeVerifier, { maxAge: 60 * 60 });

  return {
    codeChallenge,
    state,
  };
}

export function consumeVerifierAndStateCookie(state: string) {
  ensureClient();
  // Hexclave rebrand: dual-read the OAuth outer-state cookie, preferring the new name; delete both.
  const hexclaveCookieName = "hexclave-oauth-outer-" + state;
  const stackCookieName = "stack-oauth-outer-" + state;
  const codeVerifier = getCookieClient(hexclaveCookieName) ?? getCookieClient(stackCookieName);
  if (!codeVerifier) {
    return null;
  }
  deleteCookieClient(hexclaveCookieName, {});
  deleteCookieClient(stackCookieName, {});
  return {
    codeVerifier,
  };
}
