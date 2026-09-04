import { isBrowserLike } from "@hexclave/shared/dist/utils/env";
import { CLICKMAP_ROOT_ID, DEV_TOOL_ROOT_ID } from "@hexclave/shared/dist/utils/dev-tool";
import { cssEscapeIdent } from "@hexclave/shared/dist/utils/dom";
import { buildElementsChain, ELEMENTS_CHAIN_MAX_DEPTH } from "@hexclave/shared/dist/utils/elements-chain";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { generateUuid, isAdBlockerNetworkError, isAnalyticsNotEnabledError } from "./session-replay";

const FLUSH_INTERVAL_MS = 10_000;
const MAX_EVENTS_PER_BATCH = 50;
const MAX_APPROX_BYTES_PER_BATCH = 64_000;

function hasScreenDimensions(value: unknown): value is { width: number, height: number } {
  if (value == null || typeof value !== "object") {
    return false;
  }
  if (!("width" in value) || !("height" in value)) {
    return false;
  }
  return typeof value.width === "number" && typeof value.height === "number";
}

function hasHistoryMethods(value: unknown): value is { pushState: History["pushState"], replaceState: History["replaceState"] } {
  if (value == null || typeof value !== "object") {
    return false;
  }
  if (!("pushState" in value) || !("replaceState" in value)) {
    return false;
  }
  return typeof value.pushState === "function" && typeof value.replaceState === "function";
}

function getTextSnippet(textContent: string | null): string {
  return textContent == null ? "" : textContent.trim().substring(0, 200);
}

// Pixel quantization factor for x/y/viewport in stored click events. Matches the
// SCALE_FACTOR used by the ClickHouse clickmap_events MV — keep them in sync.
const CLICKMAP_SCALE_FACTOR = 16;

// Dead-click detection (PostHog-style). Whether an element has a click handler
// is unknowable from page script, so a click is classified by its observable
// consequences instead: it is "alive" if the page scrolled, the text selection
// changed, or the tab visibility changed (a new tab opened) almost
// immediately, or if the DOM mutated within a couple of seconds — and "dead"
// if none of that happened by the absolute timeout.
//
// The $click event is buffered immediately like any other event (so
// event_at_ms, ordering, and every query are untouched) and the sweep sets
// data.dead=1 on it in place if nothing observable happened. _flush holds
// back clicks that are still unclassified — classification always finishes
// well within one FLUSH_INTERVAL_MS, so a held click rides the next flush at
// the latest. A keepalive flush (pagehide/stop) sends them unmarked: a click
// still pending when the page unloads led to that navigation, alive by
// definition.
//
// NOTE — blocker for any future real-time / "live clicks" view: a click that
// is still unclassified when its natural flush fires arrives up to one extra
// FLUSH_INTERVAL_MS late. A surface showing clicks as they happen must either
// accept that lag or emit a provisional $click plus a later dead-click
// reconciliation event.
const DEAD_CLICK_SCROLL_THRESHOLD_MS = 100;
const DEAD_CLICK_SELECTION_CHANGED_THRESHOLD_MS = 100;
const DEAD_CLICK_VISIBILITY_CHANGE_THRESHOLD_MS = 100;
const DEAD_CLICK_MUTATION_THRESHOLD_MS = 2_500;
// 1.1x the mutation threshold, mirroring posthog-js: every signal window has
// closed before a click is declared dead.
const DEAD_CLICK_ABSOLUTE_TIMEOUT_MS = 2_750;
const DEAD_CLICK_CHECK_INTERVAL_MS = 1_000;
// Backstop against click storms (e.g. rage clicks on a dead element): past the
// cap, clicks are simply not classified rather than not recorded.
const DEAD_CLICK_MAX_PENDING = 50;

function isPointerTargetFixed(element: Element): boolean {
  let current: Element | null = element;
  let depth = 0;
  while (current != null && depth < ELEMENTS_CHAIN_MAX_DEPTH * 2) {
    const style = window.getComputedStyle(current);
    if (style.position === "fixed" || style.position === "sticky") {
      return true;
    }
    current = current.parentElement;
    depth += 1;
  }
  return false;
}

// Clicks on Hexclave's own in-page UI (the dev tool and the standalone
// clickmap overlay) must never be ingested as analytics events.
function isInsideHexclaveUi(element: Element): boolean {
  return element.closest(`#${cssEscapeIdent(DEV_TOOL_ROOT_ID)}, #${cssEscapeIdent(CLICKMAP_ROOT_ID)}`) != null;
}

// Mutation-record targets can be text/comment nodes; resolve to the nearest
// element before asking whether the mutation came from Hexclave's own UI.
function isInsideHexclaveUiNode(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element != null && isInsideHexclaveUi(element);
}

export type EventTrackerDeps = {
  projectId: string,
  sendBatch: (body: string, options: { keepalive: boolean }) => Promise<Result<Response, Error>>,
};

type TrackedEvent = {
  event_type: string,
  event_at_ms: number,
  data: Record<string, unknown>,
  value?: number,
  team_id?: string,
};

type PendingEventBatch = {
  body: string,
};

export type TrackEventOptions = {
  properties?: Record<string, Json>,
  value?: number,
  /** Team assignment context for team-scoped experiments. Membership is verified by the server. */
  teamId?: string,
};

function validateEventPropertyValue(value: Json, depth = 0): void {
  if (depth > 5) throw new Error("Analytics event properties cannot be nested more than 5 levels.");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Analytics event property numbers must be finite.");
  if (Array.isArray(value)) {
    for (const item of value) validateEventPropertyValue(item, depth + 1);
  } else if (value != null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Analytics event properties must use plain JSON objects.");
    for (const item of Object.values(value)) validateEventPropertyValue(item, depth + 1);
  }
}

export function validateCustomerEvent(name: string, options?: TrackEventOptions): void {
  if (name.startsWith("$")) throw new Error("Analytics event names beginning with '$' are reserved by Hexclave.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) {
    throw new Error("Analytics event names must be 1-128 characters and contain only letters, numbers, periods, underscores, colons, or hyphens.");
  }
  if (options?.value != null && !Number.isFinite(options.value)) throw new Error("Analytics event values must be finite numbers.");
  const properties = options?.properties ?? {};
  if (Object.keys(properties).length > 50) throw new Error("Analytics events can contain at most 50 properties.");
  for (const [key, value] of Object.entries(properties)) {
    if (key.length === 0 || key.length > 64) throw new Error("Analytics event property names must be between 1 and 64 characters.");
    if (!isJsonSerializable(value)) throw new Error(`Analytics event property ${JSON.stringify(key)} must be JSON serializable.`);
    validateEventPropertyValue(value);
  }
  if (new TextEncoder().encode(JSON.stringify(properties)).byteLength > 16_384) throw new Error("Analytics event properties cannot exceed 16384 bytes.");
}

export class EventTracker {
  private _started = false;
  private _cancelled = false;
  private _disabled = false;
  private _detachListeners: (() => void) | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _events: TrackedEvent[] = [];
  private _approxBytes = 0;
  // A failed delivery remains separate from newly buffered events. Retrying the
  // exact serialized body preserves its batch id and makes server-side
  // idempotency effective even when the first response was lost.
  private _pendingBatch: PendingEventBatch | null = null;
  private _flushInFlight: Promise<void> | null = null;
  private _lastUrl: string | null = null;
  private readonly _sessionReplaySegmentId: string;
  private readonly _deps: EventTrackerDeps;
  private _teamId: string | null = null;

  private _originalPushState: History["pushState"] | null = null;
  private _originalReplaceState: History["replaceState"] | null = null;

  private _deadClickTimer: ReturnType<typeof setInterval> | null = null;
  private _deadClickMutationObserver: MutationObserver | null = null;
  // Buffered $click events still awaiting dead-click classification. Always a
  // subset of _events — _flush holds these back until the sweep resolves them.
  private _unclassifiedClicks = new Set<TrackedEvent>();
  private _lastMutationAtMs: number | null = null;
  private _lastScrollAtMs: number | null = null;
  private _lastSelectionChangedAtMs: number | null = null;
  private _lastVisibilityChangeAtMs: number | null = null;

  constructor(deps: EventTrackerDeps) {
    this._deps = deps;
    this._sessionReplaySegmentId = generateUuid();
  }

  start() {
    if (this._started) return;
    if (!isBrowserLike()) return;
    if (
      typeof window.addEventListener !== "function"
      || typeof window.removeEventListener !== "function"
      || typeof document.addEventListener !== "function"
      || typeof document.removeEventListener !== "function"
      || !hasScreenDimensions(window.screen)
    ) {
      return;
    }
    this._started = true;

    this._setupPageViewCapture();
    this._setupClickCapture();
    this._setupDeadClickDetection();
    this._setupPageHideListeners();

    this._flushTimer = setInterval(() => this._tick(), FLUSH_INTERVAL_MS);
  }

  stop() {
    this._cancelled = true;
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    runAsynchronously(() => this._flush({ keepalive: true }));
    this._teardown();
  }

  clearBuffer() {
    this._events = [];
    this._approxBytes = 0;
    this._pendingBatch = null;
    this._unclassifiedClicks.clear();
    this._teamId = null;
  }

  setTeamContext(teamId: string | null): void {
    this._teamId = teamId;
  }

  async trackEvent(name: string, options?: TrackEventOptions): Promise<void> {
    validateCustomerEvent(name, options);
    this._pushEvent({
      event_type: name,
      event_at_ms: Date.now(),
      data: options?.properties ?? {},
      ...(options?.teamId == null ? {} : { team_id: options.teamId }),
      ...(options?.value == null ? {} : { value: options.value }),
    });
  }

  private _pushEvent(event: TrackedEvent) {
    if (this._disabled) return;
    const contextualizedEvent = event.team_id !== undefined || this._teamId === null
      ? event
      : { ...event, team_id: this._teamId };
    this._events.push(contextualizedEvent);
    this._approxBytes += JSON.stringify(contextualizedEvent).length;
    if (this._events.length >= MAX_EVENTS_PER_BATCH || this._approxBytes >= MAX_APPROX_BYTES_PER_BATCH) {
      runAsynchronously(() => this._flush({ keepalive: false }));
    }
  }

  private _capturePageView(entryType: "initial" | "push" | "replace" | "pop") {
    const screenObject = window.screen;
    if (!hasScreenDimensions(screenObject)) {
      return;
    }

    const url = window.location.href;
    if (url === this._lastUrl && entryType !== "initial") return;
    this._lastUrl = url;

    this._pushEvent({
      event_type: "$page-view",
      event_at_ms: Date.now(),
      data: {
        url,
        path: window.location.pathname,
        referrer: document.referrer,
        title: document.title,
        entry_type: entryType,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        screen_width: screenObject.width,
        screen_height: screenObject.height,
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      },
    });
  }

  private _setupPageViewCapture() {
    // Fire initial page-view
    this._capturePageView("initial");
    const historyObject = window.history;
    if (!hasHistoryMethods(historyObject)) {
      return;
    }
    const originalPushState = historyObject.pushState;
    const originalReplaceState = historyObject.replaceState;

    // Monkey-patch history.pushState
    this._originalPushState = (...args: Parameters<History["pushState"]>) => originalPushState.apply(historyObject, args);
    historyObject.pushState = (...args: Parameters<History["pushState"]>) => {
      this._originalPushState!(...args);
      this._capturePageView("push");
    };

    // Monkey-patch history.replaceState
    this._originalReplaceState = (...args: Parameters<History["replaceState"]>) => originalReplaceState.apply(historyObject, args);
    historyObject.replaceState = (...args: Parameters<History["replaceState"]>) => {
      this._originalReplaceState!(...args);
      this._capturePageView("replace");
    };

    // Listen for popstate (back/forward navigation)
    window.addEventListener("popstate", this._onPopState);
  }

  private readonly _onPopState = () => {
    this._capturePageView("pop");
  };

  private _buildSelector(element: Element): string {
    const parts: string[] = [];
    let current: Element | null = element;
    let depth = 0;

    while (current && depth < 8 && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      let testIdAttr = "data-testid";
      let testId = current.getAttribute("data-testid");
      if (testId == null) {
        testIdAttr = "data-test-id";
        testId = current.getAttribute("data-test-id");
      }
      if (testId != null && testId.trim() !== "") {
        part += `[${testIdAttr}="${testId.replace(/"/g, '\\"')}"]`;
        parts.unshift(part);
        break;
      }
      if (current.id !== "") {
        part += `#${cssEscapeIdent(current.id)}`;
        parts.unshift(part);
        break;
      }
      if (current.className && typeof current.className === "string") {
        const classes = current.className.trim().split(/\s+/).filter(Boolean).slice(0, 4);
        if (classes.length > 0) {
          part += `.${classes.map(cssEscapeIdent).join(".")}`;
        }
      }
      const parent: Element | null = current.parentElement;
      if (parent != null) {
        const tagName = current.tagName;
        const siblings = Array.from(parent.children).filter((child) => child.tagName === tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
      depth++;
    }

    return parts.join(" > ");
  }

  private _findNearestAnchorHref(element: Element): string | null {
    let current: Element | null = element;
    while (current) {
      if (current.tagName === "A" && current.hasAttribute("href")) {
        return current.getAttribute("href");
      }
      current = current.parentElement;
    }
    return null;
  }

  private readonly _onClickCapture = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (isInsideHexclaveUi(target)) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const pointerTargetFixed = isPointerTargetFixed(target);
    // Pre-scale at ingest so old + new rows land in identical buckets in CH.
    const xScaled = Math.round(event.pageX / CLICKMAP_SCALE_FACTOR);
    const yScaled = Math.round(event.pageY / CLICKMAP_SCALE_FACTOR);
    const clientYScaled = Math.round(event.clientY / CLICKMAP_SCALE_FACTOR);
    const relativeX = viewportWidth > 0 ? event.clientX / viewportWidth : 0;

    const clickEvent: TrackedEvent = {
      event_type: "$click",
      event_at_ms: Date.now(),
      data: {
        tag_name: target.tagName.toLowerCase(),
        text: getTextSnippet(target.textContent),
        href: this._findNearestAnchorHref(target),
        selector: this._buildSelector(target),
        elements_chain: buildElementsChain(target),
        pointer_target_fixed: pointerTargetFixed ? 1 : 0,
        url: window.location.href,
        path: window.location.pathname,
        title: document.title,
        x: event.clientX,
        y: event.clientY,
        page_x: event.pageX,
        page_y: event.pageY,
        x_scaled: xScaled,
        y_scaled: yScaled,
        client_y_scaled: clientYScaled,
        pointer_relative_x: relativeX,
        viewport_width: viewportWidth,
        viewport_height: viewportHeight,
        scale_factor: CLICKMAP_SCALE_FACTOR,
      },
    };

    // Register for dead-click classification before buffering, so a
    // size-triggered flush from this very push already holds the click back.
    if (this._deadClickTimer !== null && this._unclassifiedClicks.size < DEAD_CLICK_MAX_PENDING) {
      this._unclassifiedClicks.add(clickEvent);
    }
    this._pushEvent(clickEvent);
  };

  private _setupClickCapture() {
    document.addEventListener("click", this._onClickCapture, { capture: true });
  }

  private readonly _onDeadClickScroll = () => {
    this._lastScrollAtMs = Date.now();
  };

  private readonly _onDeadClickSelectionChange = () => {
    this._lastSelectionChangedAtMs = Date.now();
  };

  private readonly _onDeadClickVisibilityChange = () => {
    this._lastVisibilityChangeAtMs = Date.now();
  };

  private _setupDeadClickDetection() {
    if (typeof MutationObserver !== "function") return;

    this._deadClickMutationObserver = new MutationObserver((mutations) => {
      // The dev tool and the clickmap overlay rewrite their own DOM constantly
      // while open; their mutations must not mark host-page clicks as alive.
      if (mutations.every((mutation) => isInsideHexclaveUiNode(mutation.target))) {
        return;
      }
      this._lastMutationAtMs = Date.now();
    });
    this._deadClickMutationObserver.observe(document.documentElement, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
    });

    // Capture phase so scrolls inside nested scroll containers count, not just
    // the document itself (scroll events don't bubble).
    document.addEventListener("scroll", this._onDeadClickScroll, { capture: true, passive: true });
    document.addEventListener("selectionchange", this._onDeadClickSelectionChange);
    document.addEventListener("visibilitychange", this._onDeadClickVisibilityChange);

    this._deadClickTimer = setInterval(() => this._checkDeadClicks(), DEAD_CLICK_CHECK_INTERVAL_MS);
  }

  private _checkDeadClicks() {
    const nowMs = Date.now();
    for (const click of this._unclassifiedClicks) {
      const signalWithin = (signalAtMs: number | null, thresholdMs: number) =>
        signalAtMs != null && signalAtMs >= click.event_at_ms && signalAtMs - click.event_at_ms < thresholdMs;

      const isAlive = signalWithin(this._lastScrollAtMs, DEAD_CLICK_SCROLL_THRESHOLD_MS)
        || signalWithin(this._lastSelectionChangedAtMs, DEAD_CLICK_SELECTION_CHANGED_THRESHOLD_MS)
        || signalWithin(this._lastVisibilityChangeAtMs, DEAD_CLICK_VISIBILITY_CHANGE_THRESHOLD_MS)
        || signalWithin(this._lastMutationAtMs, DEAD_CLICK_MUTATION_THRESHOLD_MS);
      if (isAlive) {
        this._unclassifiedClicks.delete(click);
      } else if (nowMs - click.event_at_ms >= DEAD_CLICK_ABSOLUTE_TIMEOUT_MS) {
        // The already-buffered event is marked in place — no second event.
        click.data.dead = 1;
        this._unclassifiedClicks.delete(click);
      }
    }
  }

  private _teardownDeadClickDetection() {
    if (this._deadClickTimer !== null) {
      clearInterval(this._deadClickTimer);
      this._deadClickTimer = null;
    }
    if (this._deadClickMutationObserver !== null) {
      this._deadClickMutationObserver.disconnect();
      this._deadClickMutationObserver = null;
    }
    document.removeEventListener("scroll", this._onDeadClickScroll, { capture: true });
    document.removeEventListener("selectionchange", this._onDeadClickSelectionChange);
    document.removeEventListener("visibilitychange", this._onDeadClickVisibilityChange);
    this._unclassifiedClicks.clear();
  }

  private readonly _onPageHide = () => {
    runAsynchronously(() => this._flush({ keepalive: true }));
  };

  private _setupPageHideListeners() {
    window.addEventListener("pagehide", this._onPageHide);
    document.addEventListener("visibilitychange", this._onPageHide);
    this._detachListeners = () => {
      window.removeEventListener("pagehide", this._onPageHide);
      document.removeEventListener("visibilitychange", this._onPageHide);
    };
  }

  private _teardown() {
    if (this._detachListeners) {
      this._detachListeners();
      this._detachListeners = null;
    }

    // Restore history methods
    const historyObject = window.history;
    if (hasHistoryMethods(historyObject)) {
      if (this._originalPushState) {
        historyObject.pushState = this._originalPushState;
      }
      if (this._originalReplaceState) {
        historyObject.replaceState = this._originalReplaceState;
      }
    }
    this._originalPushState = null;
    this._originalReplaceState = null;

    window.removeEventListener("popstate", this._onPopState);
    document.removeEventListener("click", this._onClickCapture, { capture: true });
    this._teardownDeadClickDetection();

    this._events = [];
    this._approxBytes = 0;
  }

  private async _flush(options: { keepalive: boolean }) {
    if (this._flushInFlight != null) {
      await this._flushInFlight;
      // An unload flush must drain whatever the ordinary in-flight request did
      // not deliver; returning here would strand newer events as the page exits.
      if (options.keepalive) await this._flush(options);
      return;
    }
    const flush = this._flushOnce(options);
    this._flushInFlight = flush;
    try {
      await flush;
    } finally {
      if (this._flushInFlight === flush) this._flushInFlight = null;
    }
  }

  private async _flushOnce(options: { keepalive: boolean }) {
    if (this._disabled) return;

    // A keepalive flush means the page is unloading — a click still awaiting
    // dead-click classification led to that unload, so it is alive by
    // definition and ships unmarked.
    if (options.keepalive) {
      this._unclassifiedClicks.clear();
    }

    // Clicks still awaiting classification stay buffered so the sweep can
    // mark them dead in place; classification finishes well within one flush
    // interval, so they ride the next flush at the latest.
    if (this._pendingBatch == null) {
      const events = this._events.filter((event) => !this._unclassifiedClicks.has(event));
      if (events.length === 0) return;
      this._events = this._events.filter((event) => this._unclassifiedClicks.has(event));
      this._approxBytes = this._events.reduce((total, event) => total + JSON.stringify(event).length, 0);
      this._pendingBatch = {
        body: JSON.stringify({
          session_replay_segment_id: this._sessionReplaySegmentId,
          batch_id: generateUuid(),
          sent_at_ms: Date.now(),
          events,
        }),
      };
    }
    const pendingBatch = this._pendingBatch;

    const res = await this._deps.sendBatch(
      pendingBatch.body,
      { keepalive: options.keepalive },
    );

    if (res.status === "error") {
      if (isAnalyticsNotEnabledError(res.error)) {
        this._disable();
        return;
      }
      // Ad blockers commonly block analytics endpoints, causing network
      // errors. These are expected and should not pollute the console.
      if (isAdBlockerNetworkError(res.error)) {
        this._pendingBatch = null;
        return;
      }
      console.warn("EventTracker flush failed:", res.error);
      return;
    }

    if (!res.data.ok) {
      console.warn("EventTracker flush failed:", res.data.status, await res.data.text());
      return;
    }
    if (this._pendingBatch === pendingBatch) this._pendingBatch = null;
  }

  private _disable() {
    this._disabled = true;
    this._pendingBatch = null;
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._teardown();
  }

  private _tick() {
    if (this._cancelled) return;
    if (this._pendingBatch != null || this._events.length > 0) {
      runAsynchronously(() => this._flush({ keepalive: false }));
    }
  }
}
