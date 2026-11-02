import { HexclaveAssertionError, captureError } from "@hexclave/shared/dist/utils/errors";
import { readSessionStorageItem, removeSessionStorageItem, writeSessionStorageItem } from "../../../../utils/session-storage";

/**
 * Last line of defense against redirect loops (most importantly in hosted components flows, where
 * redirects bounce between the app domain and the hosted domain and a bug anywhere in the chain
 * can bounce the user forever).
 *
 * Every SDK-driven redirect records a breadcrumb, and when the exact same redirect keeps repeating
 * within a short window, the redirect throws instead of navigating. The page that initiated the
 * redirect then renders its error state (eg. the auth page's error card), which both stops the
 * loop and surfaces the bug loudly.
 */

// sessionStorage (not module state) because most redirect loops involve full page loads, so each
// loop iteration runs in a fresh JS context. sessionStorage is also per-tab, which is exactly the
// scope of a redirect loop.
const breadcrumbsStorageKey = "hexclave-redirect-loop-breadcrumbs";

// A redirect loop cycles within a few seconds per iteration even with full cross-domain page
// loads, so a real loop reaches 5 identical redirects well within 30 seconds. A human bouncing
// between pages (eg. toggling sign-in <-> sign-up) produces the same (from, to) pair far less
// often, which keeps false positives implausible.
const loopWindowMillis = 30_000;
const maxIdenticalRedirectsPerWindow = 5;
const maxStoredBreadcrumbs = 50;

// One page load often asks for the same redirect several times before the browser actually
// navigates away: every component that calls `useUser({ or: "redirect" })` (and every re-render of
// it while suspended) starts its own redirect to the sign-in page. Those are one redirect, not a
// loop, so identical redirects from the same page load within this window are only counted once.
// The window matches the 2s `_redirectTo` itself waits for a navigation to take effect. Client-side
// (same page load) loops still get counted, once per window, so they're still caught.
const samePageLoadDuplicateWindowMillis = 2_000;

// Identifies this JS context, ie. this page load: a full page load (the usual loop iteration)
// starts a fresh one, so its redirects are always counted.
let currentPageLoadId = createPageLoadId();

function createPageLoadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type RedirectBreadcrumb = {
  from: string,
  to: string,
  /**
   * Wall-clock milliseconds (Date.now()). Although this is used to measure elapsed time (where we
   * would normally use performance.now()), breadcrumbs must be comparable across full page loads,
   * and performance.now() restarts at zero on every navigation.
   */
  at: number,
  /** The page load that recorded it (missing on breadcrumbs written by older SDK versions). */
  pageLoadId?: string,
};

function isRedirectBreadcrumb(value: unknown): value is RedirectBreadcrumb {
  return (
    typeof value === "object"
    && value !== null
    && "from" in value && typeof value.from === "string"
    && "to" in value && typeof value.to === "string"
    && "at" in value && typeof value.at === "number"
    && (!("pageLoadId" in value) || value.pageLoadId === undefined || typeof value.pageLoadId === "string")
  );
}

function readBreadcrumbs(): RedirectBreadcrumb[] {
  const raw = readSessionStorageItem(breadcrumbsStorageKey);
  if (raw == null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupted value (eg. written by an older SDK version) just means we lose loop protection
    // for this one redirect; start over with a fresh list.
    removeSessionStorageItem(breadcrumbsStorageKey);
    return [];
  }
  if (!Array.isArray(parsed)) {
    removeSessionStorageItem(breadcrumbsStorageKey);
    return [];
  }
  return parsed.filter(isRedirectBreadcrumb);
}

function writeBreadcrumbs(breadcrumbs: RedirectBreadcrumb[]): void {
  writeSessionStorageItem(breadcrumbsStorageKey, JSON.stringify(breadcrumbs));
}

/**
 * Loop iterations usually differ only in nonce-style query params (`code`, `state`,
 * `after_auth_return_to`, ...), so redirects are compared by origin + pathname only.
 */
function getComparableRedirectLocation(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function recordRedirectAndThrowIfLoopDetected(options: { currentUrl: URL, targetUrl: URL }): void {
  const from = getComparableRedirectLocation(options.currentUrl);
  const to = getComparableRedirectLocation(options.targetUrl);
  const now = Date.now();

  // Clock jumps backwards (eg. NTP sync) would make breadcrumbs appear to be from the future;
  // treat those as expired rather than counting them towards a loop.
  const recentBreadcrumbs = readBreadcrumbs().filter((b) => now - b.at >= 0 && now - b.at < loopWindowMillis);

  const isDuplicateFromThisPageLoad = recentBreadcrumbs.some((b) => (
    b.pageLoadId === currentPageLoadId
    && b.from === from
    && b.to === to
    && now - b.at < samePageLoadDuplicateWindowMillis
  ));
  if (isDuplicateFromThisPageLoad) {
    // Same redirect this page already started; let it through without counting it again.
    return;
  }

  const identicalRedirectCount = recentBreadcrumbs.filter((b) => b.from === from && b.to === to).length + 1;

  if (identicalRedirectCount >= maxIdenticalRedirectsPerWindow) {
    // Drop the matching breadcrumbs so a manual retry (eg. the user reloading and clicking sign-in
    // again) isn't instantly blocked by the history of the loop we just broke.
    writeBreadcrumbs(recentBreadcrumbs.filter((b) => !(b.from === from && b.to === to)));
    const error = new HexclaveAssertionError(
      `Redirect loop detected: the redirect ${from} -> ${to} was attempted ${identicalRedirectCount} times within ${loopWindowMillis / 1000}s, so it was blocked. This is a bug in the auth flow; the recent redirect chain is included in the error details.`,
      {
        from,
        to,
        currentUrl: options.currentUrl.toString(),
        targetUrl: options.targetUrl.toString(),
        recentRedirects: recentBreadcrumbs.map((b) => `${b.from} -> ${b.to}`),
      },
    );
    // Also captured (not just thrown) so the loop is reported even if a caller maps the thrown
    // error to UI without reporting it.
    captureError("redirect-loop-detected", error);
    throw error;
  }

  writeBreadcrumbs([...recentBreadcrumbs, { from, to, at: now, pageLoadId: currentPageLoadId }].slice(-maxStoredBreadcrumbs));
}

export const _forTesting = {
  /** Simulates a full page load (a fresh JS context), which is what most redirect loops go through. */
  startNewPageLoad() {
    currentPageLoadId = createPageLoadId();
  },
};
