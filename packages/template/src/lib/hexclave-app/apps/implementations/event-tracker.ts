import { createTraceState, metrics, ROOT_CONTEXT, SpanKind, trace as otelTrace, TraceFlags, type Context } from "@opentelemetry/api";
import { isBrowserLike } from "@hexclave/shared/dist/utils/env";
import { CLICKMAP_ROOT_ID, DEV_TOOL_ROOT_ID } from "@hexclave/shared/dist/utils/dev-tool";
import { cssEscapeIdent } from "@hexclave/shared/dist/utils/dom";
import { buildElementsChain, ELEMENTS_CHAIN_MAX_DEPTH } from "@hexclave/shared/dist/utils/elements-chain";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { uuidToW3cSpanId, type ClientSystemSpanType, type SystemEventType } from "@hexclave/shared/dist/utils/analytics-wire";
import { createOtelSpanFacade } from "./otel-span-facade";
import { emitHexclaveOtelEvent } from "./otel-log-facade";
import { assertValidSpanStartInput, getCustomTelemetryDataError, getCustomTelemetryNameError, preCaught, registerTelemetryBackgroundTask, rejectedPreCaught, resolveSpanParent, type Span, type SpanContext, type StartSpanOptions, type TrackOptions } from "./telemetry-core";
import { generateUuid } from "./telemetry-transport";
import type { TelemetryResource } from "./telemetry-config";
import { INTERNAL_SESSION_REPLAY_BLOCK_SELECTOR } from "./analytics-config";
import { buildAmbientSessionContext, getActiveOtelSpanContext } from "./otel-context";
import { buildPropagationHeaderValues, fetchWithSpanPropagation, type SpanPropagationContext } from "./span-propagation";
import { OtlpWebVitalsMetricRecorder, startWebVitalsCollector, type WebVitalsCollector } from "./web-vitals";

export {
  getCustomTelemetryDataError,
  getCustomTelemetryNameError,
  preCaught,
  registerTelemetryBackgroundTask,
  rejectedPreCaught,
  resolveEndedAtMs,
  resolveSpanParent,
  withSpanImpl,
  type ParentRef,
  type Span,
  type SpanContext,
  type StartSpanOptions,
  type TrackOptions,
} from "./telemetry-core";

const FLUSH_INTERVAL_MS = 10_000;
const MAX_EVENTS_PER_BATCH = 50;
const MAX_APPROX_BYTES_PER_BATCH = 64_000;
export const LIVE_SPAN_REGISTRY_SOFT_CAP = 1000;

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

export type KeystrokeCaptureOptions = {
  enabled: boolean,
  maskAllInputs: boolean,
  blockClass?: string | RegExp,
  blockSelector?: string,
};

export type EventTrackerDeps = {
  projectId: string,
  resource: TelemetryResource,
  clientVersion?: string,
  /** Present only when Hexclave owns the active LoggerProvider. */
  forceFlushOtel?: () => Promise<void>,
  sessionReplaySegmentId?: string,
  /** The authenticated refresh-token span: the stable root of browser telemetry. */
  sessionRootContext?: SpanContext,
  /** Whether the replay + per-tab lifecycle levels exist between the root and page views. */
  sessionReplayEnabled?: boolean,
  productAnalyticsEnabled?: boolean,
  keystrokeCapture?: KeystrokeCaptureOptions,
  registerBackgroundTask?: (promise: Promise<unknown>) => void,
  getPropagationPolicy?: () => { selfOrigin: string | null, allowedOrigins: readonly string[], allowLocalhost: boolean, correlationBaggage: boolean },
  integritySignals?: boolean,
};

type TrackedEvent = {
  event_type: string,
  event_at_ms: number,
  data: Record<string, unknown>,
  trace_id?: string,
  span_id?: string,
  trace_flags?: number,
  trace_state?: string,
  page_view_span_id?: string,
};

type SystemSpanHandle = {
  readonly traceId: string,
  readonly spanId: string,
  readonly traceFlags: number,
  readonly spanType: string,
  isEnded: () => boolean,
  setData: (data: Record<string, unknown>) => void,
  end: (endedAtMs?: number) => void,
};

type AwayReason = "tab-hidden" | "window-blur";

const RAGE_CLICK_WINDOW_MS = 1_000;
const RAGE_CLICK_RADIUS_PX = 30;
const RAGE_CLICK_MIN_CLICKS = 3;
const RESIZE_DEBOUNCE_MS = 500;
const KEYSTROKE_DEBOUNCE_MS = 500;
const FORM_FIELD_NAMES_MAX = 50;
const DOWNLOAD_EXTENSION_RE = /\.(pdf|zip|gz|tar|tgz|rar|7z|dmg|pkg|exe|msi|apk|csv|tsv|xls[xm]?|doc[xm]?|ppt[xm]?|mp3|wav|mp4|mov|avi|webm)$/i;

type PendingKeystrokeBatch = {
  target: Element,
  count: number,
  eventAtMs: number,
  startedAtPerformanceMs: number,
  lastAtPerformanceMs: number,
  url: string,
  path: string,
};

function classMatchesReplayBlock(element: Element, blockClass: string | RegExp): boolean {
  if (typeof blockClass === "string") return element.classList.contains(blockClass);
  for (const className of element.classList) {
    const lastIndex = blockClass.lastIndex;
    blockClass.lastIndex = 0;
    const matches = blockClass.test(className);
    blockClass.lastIndex = lastIndex;
    if (matches) return true;
  }
  return false;
}

function isInsideBlockedReplaySubtree(element: Element, options: KeystrokeCaptureOptions): boolean {
  const blockClass = options.blockClass ?? "rr-block";
  let current: Element | null = element;
  while (current !== null) {
    if (current.matches(INTERNAL_SESSION_REPLAY_BLOCK_SELECTOR)) return true;
    if (classMatchesReplayBlock(current, blockClass)) return true;
    if (options.blockSelector !== undefined && current.matches(options.blockSelector)) return true;
    current = current.parentElement;
  }
  return false;
}

function isMaskedReplayInput(element: Element, maskAllInputs: boolean): boolean {
  if (element instanceof HTMLInputElement) {
    return element.type.toLowerCase() === "password" || maskAllInputs;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return maskAllInputs;
  }
  return element.closest(".rr-mask") !== null;
}

function hashTextLocal(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export class EventTracker {
  private _started = false;
  private _cancelled = false;
  private _detachListeners: (() => void) | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _events: TrackedEvent[] = [];
  private _approxBytes = 0;
  private _lastUrl: string | null = null;
  private _sessionReplaySegmentId: string;
  private readonly _deps: EventTrackerDeps;
  private _sessionRootContext: SpanContext | null;
  private readonly _sessionReplayEnabled: boolean;
  private _sessionReplaySegmentMaterialized = false;

  private _originalPushState: History["pushState"] | null = null;
  private _originalReplaceState: History["replaceState"] | null = null;

  private _globalSpans = new Set<Span>();
  private _liveSpanControls = new Set<{ markInert: () => void }>();
  private readonly _liveSpanControlBySpan = new WeakMap<Span, { markInert: () => void }>();
  private _warnedLiveSpanRegistryCap = false;

  private _pageViewSpan: SystemSpanHandle | null = null;
  private _ambientOtelContextCache: { anchorKey: string, sessionReplaySegmentId: string, context: Context } | null = null;
  private _maxScrollDepthPx = 0;
  private _maxScrollDepthRatio = 0;
  private _webVitals: WebVitalsCollector | null = null;
  private readonly _webVitalsMetricRecorder: OtlpWebVitalsMetricRecorder;
  private _webVitalsSpanId: string | null = null;
  private _recentClicks: { x: number, y: number, atMs: number }[] = [];
  private _resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _keystrokeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingKeystrokes: PendingKeystrokeBatch | null = null;
  private _awaySpan: SystemSpanHandle | null = null;
  private _awayReasons = new Set<AwayReason>();
  private _awaySpanSeenReasons = new Set<AwayReason>();
  private _offlineSpan: SystemSpanHandle | null = null;
  private _lastCopyHash: number | null = null;
  private _wasFullscreen = false;
  private _detachAutocaptureListeners: (() => void) | null = null;
  private _detachIntegrityListeners: (() => void) | null = null;

  private _deadClickTimer: ReturnType<typeof setInterval> | null = null;
  private _deadClickMutationObserver: MutationObserver | null = null;
  // Buffered $click events still awaiting dead-click classification. Always a
  // subset of _events — _flush holds these back until the sweep resolves them.
  private _unclassifiedClicks = new Set<TrackedEvent>();
  private _lastMutationAtMs: number | null = null;
  private _lastScrollAtMs: number | null = null;
  private _lastSelectionChangedAtMs: number | null = null;
  private _lastVisibilityChangeAtMs: number | null = null;

  private readonly _keystrokeCapture: KeystrokeCaptureOptions;

  constructor(deps: EventTrackerDeps) {
    this._deps = deps;
    this._sessionReplaySegmentId = deps.sessionReplaySegmentId ?? generateUuid();
    this._sessionRootContext = deps.sessionRootContext ?? null;
    this._sessionReplayEnabled = deps.sessionReplayEnabled === true;
    this._keystrokeCapture = deps.keystrokeCapture ?? { enabled: false, maskAllInputs: true };
    this._webVitalsMetricRecorder = new OtlpWebVitalsMetricRecorder(metrics.getMeter("@hexclave/browser-web-vitals", "1"));
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

    if (this._deps.productAnalyticsEnabled !== false) {
      this._setupPageViewCapture();
      this._setupClickCapture();
      this._setupDeadClickDetection();
      this._setupAutocaptureListeners();
      if (this._deps.integritySignals === true) {
        this._setupIntegritySignals();
      }
    }
    this._setupPageHideListeners();

    this._flushTimer = setInterval(() => this._tick(), FLUSH_INTERVAL_MS);
  }

  stop() {
    this._cancelled = true;
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._flushPendingKeystrokes();
    this._endPageViewSpan();
    this._endOpenPresenceSpans();
    this._flushInBackground({ keepalive: true });
    this._teardown();
  }

  clearBuffer() {
    this._clearPendingKeystrokes();
    this._settleAllPending("analytics buffer cleared");
    this._events = [];
    this._approxBytes = 0;
    this._unclassifiedClicks.clear();
    this._disconnectDeadClickMutationObserverIfIdle();
  }

  private _settleAllPending(reason: string) {
    void reason;
    for (const control of this._liveSpanControls) {
      control.markInert();
    }
    this._liveSpanControls.clear();
    this._globalSpans.clear();
  }

  /**
   * Replaces the per-tab id shared with the SessionRecorder. Called on sign-out
   * (paired with clearBuffer) so a subsequent same-tab sign-in as a different user
   * does not reuse the previous user's session_replay_segment_id — which would let
   * the two users' analytics be correlated. The app rotates both trackers to the
   * SAME new id so they stay in sync.
   */
  setSessionReplaySegmentId(id: string) {
    this._sessionReplaySegmentId = id;
    this._sessionReplaySegmentMaterialized = false;
    if (this._deps.productAnalyticsEnabled !== false && this._started && !this._cancelled) {
      this._capturePageView("rotation");
      this._restartPresenceSpans();
    }
  }

  /**
   * Installs the authenticated refresh-token root after startup. Identity
   * resolution is intentionally asynchronous so click/page capture never waits
   * for anonymous sign-up or token refresh.
   */
  setSessionRootContext(sessionRootContext: SpanContext): void {
    this._updateSessionHierarchy(sessionRootContext, false);
  }

  private _updateSessionHierarchy(sessionRootContext: SpanContext, markSegmentMaterialized: boolean): void {
    const previousParent = this._pageViewLifecycleParent();
    this._sessionRootContext = sessionRootContext;
    if (markSegmentMaterialized) this._sessionReplaySegmentMaterialized = true;
    const nextParent = this._pageViewLifecycleParent();
    const parentChanged = previousParent === null
      ? nextParent !== null
      : nextParent === null
        || previousParent.traceId !== nextParent.traceId
        || previousParent.spanId !== nextParent.spanId;
    if (
      parentChanged
      && this._deps.productAnalyticsEnabled !== false
      && this._started
      && !this._cancelled
    ) {
      this._capturePageView("rotation");
      this._restartPresenceSpans();
    }
  }

  /**
   * Marks the current tab segment as a usable parent after the replay endpoint
   * has durably materialized it. The callback also refreshes the session root:
   * auth can rotate while this lazy tracker stays mounted, and combining an old
   * trace id with a segment written under the new refresh token creates a
   * cross-trace missing parent. A stale acknowledgement for a pre-rotation
   * segment is ignored.
   */
  markSessionReplaySegmentMaterialized(segmentId: string, sessionRootContext: SpanContext): void {
    if (segmentId !== this._sessionReplaySegmentId) return;
    this._updateSessionHierarchy(sessionRootContext, true);
  }

  /** The current per-tab id (reflects sign-out rotation) — used by cross-tier span propagation. */
  getSessionReplaySegmentId(): string {
    return this._sessionReplaySegmentId;
  }

  /**
   * The current `$page-view` span id (null before start / after teardown).
   * Stamped on every buffered event/span and carried by cross-tier propagation,
   * so all telemetry from this page — including backend spans — nests under it.
   */
  getCurrentPageViewSpanId(): string | null {
    return this._pageViewSpan?.spanId ?? null;
  }

  /**
   * The OTel Context the managed browser SDK uses as its context manager's
   * BASE (see AmbientBaseStackContextManager): the ambient anchor plus the
   * same correlation baggage a public startSpan() would stamp. This is what
   * parents spans started outside any explicit `context.with(...)` frame —
   * most importantly the official fetch/XHR instrumentation's request spans —
   * into the session trace, instead of letting them mint parentless one-span
   * traces in the inbox.
   *
   * Anchor precedence:
   * - the LIVE `$page-view` span: everything on the page nests under it;
   * - no page view yet (product analytics disabled, or the instant before the
   *   first capture): the refresh-token session root, so bootstrap requests
   *   like users/me still join the session trace as direct session children;
   * - an ENDED page view: null. Navigation replaces the span in the same
   *   synchronous block (_capturePageView), so the only observable ended
   *   state is the sign-out window between inert-ification and rotation — and
   *   a fetch racing that window must not stitch the previous user's session
   *   trace id into a span that exports under the next user's credentials.
   *   The session root is deliberately NOT a fallback here for that reason.
   */
  getAmbientOtelContext(): Context | null {
    const livePageView = this._pageViewSpan !== null && !this._pageViewSpan.isEnded() ? this._currentPageViewContext() : null;
    const anchor = livePageView ?? (this._pageViewSpan === null && !this._cancelled ? this._sessionRootContext : null);
    if (anchor === null) return null;
    const anchorKey = `${anchor.traceId}/${anchor.spanId}`;
    const cache = this._ambientOtelContextCache;
    if (cache !== null && cache.anchorKey === anchorKey && cache.sessionReplaySegmentId === this._sessionReplaySegmentId) {
      return cache.context;
    }
    const ambient = buildAmbientSessionContext({
      anchor,
      sessionReplaySegmentId: this._sessionReplaySegmentId,
      ...livePageView === null ? {} : { pageViewSpanId: livePageView.spanId },
    });
    this._ambientOtelContextCache = { anchorKey, sessionReplaySegmentId: this._sessionReplaySegmentId, context: ambient };
    return ambient;
  }

  /**
   * Emits a custom analytics event through the active OTel LoggerProvider. In
   * managed mode the returned promise resolves after a provider flush; an
   * existing-provider integration owns its own export lifecycle.
   *
   * `internalOptions.eventAtMs` is the adoption path for events captured before
   * this lazily-loaded module arrived (ClientAnalytics buffers them with their
   * real timestamps) — deliberately NOT part of the public TrackOptions, since
   * user-supplied timestamps would need server-side plausibility validation.
   */
  trackCustomEvent(eventType: string, data?: Record<string, unknown>, options?: TrackOptions, internalOptions?: { eventAtMs?: number }): Promise<void> {
    const nameError = getCustomTelemetryNameError("event", eventType);
    if (nameError) return rejectedPreCaught(nameError);
    const dataError = getCustomTelemetryDataError(data);
    if (dataError) return rejectedPreCaught(dataError);
    const enclosing = this._resolveEnclosingSpan(options);
    if ("error" in enclosing) return rejectedPreCaught(enclosing.error);
    const pageViewSpanId = this.getCurrentPageViewSpanId();
    this._emitTrackedEvent({
      event_type: eventType,
      event_at_ms: internalOptions?.eventAtMs ?? Date.now(),
      data: { ...data ?? {} },
      ...enclosing.span !== null ? {
        trace_id: enclosing.span.traceId,
        span_id: enclosing.span.spanId,
        ...enclosing.span.traceFlags === undefined ? {} : { trace_flags: enclosing.span.traceFlags },
        ...enclosing.span.traceState === undefined ? {} : { trace_state: enclosing.span.traceState },
      } : {},
      ...pageViewSpanId !== null ? { page_view_span_id: pageViewSpanId } : {},
    });
    return preCaught(this._deps.forceFlushOtel?.() ?? Promise.resolve());
  }

  startSpan(spanType: string, options?: StartSpanOptions): Span {
    assertValidSpanStartInput(spanType, options);
    const resolved = resolveSpanParent({
      explicit: options?.parent,
      ambient: this._ambientSpanContexts(),
      fallbackParent: this._currentPageViewContext(),
      links: options?.links,
      root: options?.root,
    });
    if ("error" in resolved) {
      throw new Error(`Hexclave analytics: ${resolved.error}`);
    }
    const pageViewSpanId = this.getCurrentPageViewSpanId();
    const parent = resolved.parentSpanId === null
      ? undefined
      : {
        traceId: resolved.traceId,
        spanId: resolved.parentSpanId,
        ...resolved.traceFlags === undefined ? {} : { traceFlags: resolved.traceFlags },
        ...resolved.traceState === undefined ? {} : { traceState: resolved.traceState },
      };
    return createOtelSpanFacade({
      tracer: otelTrace.getTracer("@hexclave/sdk-browser"),
      spanType,
      startOptions: {
        ...options,
        ...parent === undefined ? { root: true } : { parent, root: false },
        links: resolved.links,
      },
      ...this._deps.getPropagationPolicy === undefined ? {} : { correlationBaggage: this._deps.getPropagationPolicy().correlationBaggage },
      correlationAttributes: {
        "hexclave.session_replay.segment.id": this._sessionReplaySegmentId,
        ...pageViewSpanId === null ? {} : { "hexclave.page_view.span_id": pageViewSpanId },
      },
      capabilities: {
        trackEvent: (eventType, data, trackOptions) => this.trackCustomEvent(eventType, data, trackOptions),
        getSpanPropagationHeaders: (span) => this._spanPropagationHeaders(span, pageViewSpanId),
        fetch: (span, input, init) => this._spanFetch(span, input, init),
        onStarted: (startedSpan) => {
          const control = {
            markInert: () => runAsynchronously(async () => await startedSpan.end(), { noErrorLogging: true }),
          };
          this._liveSpanControls.add(control);
          this._liveSpanControlBySpan.set(startedSpan, control);
          this._capLiveSpanRegistries();
        },
        onEnded: (endedSpan) => {
          this._globalSpans.delete(endedSpan);
          const endedControl = this._liveSpanControlBySpan.get(endedSpan);
          if (endedControl !== undefined) {
            this._liveSpanControls.delete(endedControl);
          }
        },
      },
    });
  }

  /**
   * Starts a client-minted SYSTEM span ($page-view, $away, $offline). Unlike the
   * public startSpan: no name/data validation (callers are internal), no ambient
   * parenting, and no public capabilities. Registered in _liveSpanControls, so
   * sign-out inert-ifies it like any live span (a span started under user A must
   * never be re-written under user B).
   *
   * Parenting is EXPLICIT here rather than ambient, because `$page-view` must
   * pick up the lifecycle parent (segment when replay is enabled, refresh token
   * otherwise), never whichever custom span happens to be ambient.
   * `$away`/`$offline` pass the current page-view context explicitly for the
   * same reason the ambient chain would give them anyway — stated outright
   * because these fire from lifecycle listeners with no ambient frame at all.
   */
  private _startSystemSpan(spanType: ClientSystemSpanType, opts?: { data?: Record<string, unknown>, parent?: SpanContext | null, pageViewSpanId?: string }): SystemSpanHandle {
    const parentContext = opts?.parent == null
      ? ROOT_CONTEXT
      : otelTrace.setSpanContext(ROOT_CONTEXT, {
        traceId: opts.parent.traceId,
        spanId: opts.parent.spanId,
        traceFlags: opts.parent.traceFlags ?? TraceFlags.SAMPLED,
        isRemote: false,
        ...opts.parent.traceState === undefined ? {} : { traceState: createTraceState(opts.parent.traceState) },
      });
    let accumulatedData = { ...opts?.data ?? {} };
    const span = otelTrace.getTracer("@hexclave/sdk-browser-system").startSpan(spanType, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "hexclave.signal.type": "system_span",
        "hexclave.data": JSON.stringify(accumulatedData),
        ...opts?.pageViewSpanId === undefined ? {} : { "hexclave.page_view.span_id": opts.pageViewSpanId },
      },
    }, parentContext);
    let ended = false;
    const finish = (endedAtMs?: number) => {
      if (ended) return;
      ended = true;
      span.end(endedAtMs);
      this._liveSpanControls.delete(control);
    };
    const control = { markInert: () => finish() };
    this._liveSpanControls.add(control);
    this._capLiveSpanRegistries();
    const spanContext = span.spanContext();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      spanType,
      isEnded: () => ended,
      setData: (data: Record<string, unknown>) => {
        if (ended) return;
        accumulatedData = { ...accumulatedData, ...data };
        span.setAttribute("hexclave.data", JSON.stringify(accumulatedData));
      },
      end: finish,
    };
  }

  /** The correlation context pinned to exactly `span`: its frozen page correlation
   * plus the per-tab segment identity. Hierarchy is NOT here — it rides the
   * `traceparent` built by _spanPropagationHeaders. */
  private _spanPropagationContext(pageViewSpanId: string | null): SpanPropagationContext {
    return {
      sessionReplaySegmentId: this._sessionReplaySegmentId,
      ...pageViewSpanId !== null ? { pageViewSpanId } : {},
    };
  }

  /**
   * Correlation is always safe to expose to an allowed origin. Hierarchy is
   * pinned only when the deterministic trace decision guarantees this span's
   * row will survive a healthy flush.
   */
  private _spanPropagationHeaders(span: Span, pageViewSpanId: string | null): Record<string, string> {
    if (this._deps.getPropagationPolicy?.().correlationBaggage === false) return {};
    return buildPropagationHeaderValues({
      traceparent: null,
      context: this._spanPropagationContext(pageViewSpanId),
    });
  }

  private _spanFetch(span: Span, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const policy = this._deps.getPropagationPolicy?.() ?? {
      selfOrigin: typeof window !== "undefined" ? window.location.origin : null,
      allowedOrigins: [],
      allowLocalhost: false,
    };
    return fetchWithSpanPropagation({
      input,
      init,
      headerValues: span.getSpanPropagationHeaders(),
      selfOrigin: policy.selfOrigin,
      allowedOrigins: policy.allowedOrigins,
      allowLocalhost: policy.allowLocalhost,
    });
  }

  /**
   * Registers a span as an ambient parent for all subsequently created custom
   * events and spans. Ending the span automatically unregisters it.
   *
   * The nearest ambient context wins as parent. Any other global span in a
   * different trace is recorded as a link.
   */
  setGlobalSpan(span: Span): void {
    if (span.isEnded) {
      console.warn("Hexclave analytics: setGlobalSpan() called with an already-ended span; ignoring");
      return;
    }
    this._globalSpans.add(span);
    this._capLiveSpanRegistries();
  }

  clearGlobalSpan(span: Span): void {
    this._globalSpans.delete(span);
  }

  /**
   * Soft-caps the live-span registries: both grow one entry per never-ended
   * span, so an app that starts spans in a loop and never ends them would leak
   * without bound. Beyond the cap the OLDEST entry is evicted (Sets iterate in
   * insertion order): an evicted live-control is inert-ified first — its open
   * row remains valid server-side, only local mutability is lost — and an
   * evicted global span simply stops being an ambient parent. Trade-off:
   * pathological span usage degrades gracefully instead of leaking; the warning
   * fires once per tracker so a hot loop cannot spam the console.
   */
  private _capLiveSpanRegistries(): void {
    let evicted = false;
    if (this._liveSpanControls.size > LIVE_SPAN_REGISTRY_SOFT_CAP) {
      const oldest = this._liveSpanControls.values().next();
      if (!oldest.done) {
        oldest.value.markInert();
        this._liveSpanControls.delete(oldest.value);
        evicted = true;
      }
    }
    if (this._globalSpans.size > LIVE_SPAN_REGISTRY_SOFT_CAP) {
      const oldest = this._globalSpans.values().next();
      if (!oldest.done) {
        this._globalSpans.delete(oldest.value);
        evicted = true;
      }
    }
    if (evicted && !this._warnedLiveSpanRegistryCap) {
      this._warnedLiveSpanRegistryCap = true;
      console.warn(`Hexclave analytics: more than ${LIVE_SPAN_REGISTRY_SOFT_CAP} live spans are registered; dropping the oldest ones from the local registry (their open rows remain valid, but local mutability/ambient parenting is lost). End spans you no longer need.`);
    }
  }

  /**
   * Sends everything buffered right now and settles all in-flight sends. This is
   * the "send now" escape hatch — awaiting trackEvent alone waits for the
   * regular flush cadence.
   */
  async flush(): Promise<void> {
    await this._flush({ keepalive: false });
  }

  private _ambientSpanContexts(): SpanContext[] {
    const contexts: SpanContext[] = [];
    for (const span of this._globalSpans) {
      if (!span.isEnded) contexts.push(span.spanContext());
    }
    const activeOtelSpanContext = getActiveOtelSpanContext();
    if (activeOtelSpanContext !== null) contexts.push(activeOtelSpanContext);
    return contexts;
  }

  /**
   * The enclosing span a new EVENT belongs to: an explicit `parent`, else the
   * nearest ambient context (which in a browser bottoms out at the current
   * `$page-view` — see _ambientSpanContexts), else none. Events are instants, so
   * unlike spans they never mint a trace of their own: an event with nothing
   * enclosing it (before the tab's first page view, or under `root: true`)
   * carries no trace/span id at all, and is then reachable only by its
   * correlation columns.
   */
  private _resolveEnclosingSpan(options: TrackOptions | undefined): { span: SpanContext | null } | { error: string } {
    const resolved = resolveSpanParent({
      explicit: options?.parent,
      ambient: this._ambientSpanContexts(),
      fallbackParent: this._currentPageViewContext(),
      root: options?.root,
    });
    if ("error" in resolved) return resolved;
    return { span: resolved.parentSpanId === null ? null : {
      traceId: resolved.traceId,
      spanId: resolved.parentSpanId,
      ...resolved.traceFlags === undefined ? {} : { traceFlags: resolved.traceFlags },
      ...resolved.traceState === undefined ? {} : { traceState: resolved.traceState },
    } };
  }

  /** The current `$page-view` span's context, or null before the first page view. */
  private _currentPageViewContext(): SpanContext | null {
    const span = this._pageViewSpan;
    return span === null ? null : { traceId: span.traceId, spanId: span.spanId, traceFlags: span.traceFlags };
  }

  /**
   * The old session hierarchy expressed with the new scalar W3C schema. Early
   * pages remain direct children of the refresh root until replay ingestion
   * confirms the segment row exists in this exact trace. This preserves the old
   * server-resolved behavior and prevents cross-trace phantom segment parents.
   */
  private _pageViewLifecycleParent(): SpanContext | null {
    if (this._sessionRootContext === null) return null;
    if (!this._sessionReplayEnabled || !this._sessionReplaySegmentMaterialized) return this._sessionRootContext;
    return {
      traceId: this._sessionRootContext.traceId,
      spanId: uuidToW3cSpanId(this._sessionReplaySegmentId),
    };
  }

  /**
   * The ambient contexts every new event/span would get right now — live global
   * spans first, then enclosing withSpan() frames (outermost first), so the LAST
   * entry is the nearest. Used by cross-tier propagation so an outgoing request
   * joins the same trace a locally-tracked span would.
   */
  getAmbientSpanContexts(): SpanContext[] {
    return this._ambientSpanContexts();
  }

  /**
   * The ancestor of last resort for anything started on this page — see
   * `resolveSpanParent`'s `fallbackParent`. Exposed (alongside the ambient list)
   * so a manually-instrumented transport propagates the same hierarchy the
   * auto-instrumented one would.
   */
  getPageViewSpanContext(): SpanContext | null {
    return this._currentPageViewContext();
  }

  private _maybeTriggerSizeFlush() {
    if (this._events.length >= MAX_EVENTS_PER_BATCH || this._approxBytes >= MAX_APPROX_BYTES_PER_BATCH) {
      this._flushInBackground({ keepalive: false });
    }
  }

  private _pushEvent(event: TrackedEvent) {
    this._events.push(event);
    this._approxBytes += JSON.stringify(event).length;
    this._maybeTriggerSizeFlush();
  }

  private _pushSystemEvent(eventType: SystemEventType, data: Record<string, unknown>, internalOptions?: { eventAtMs?: number }) {
    const dataError = getCustomTelemetryDataError(data);
    if (dataError !== null) {
      console.warn(`Hexclave analytics: dropping ${eventType}: ${dataError}`);
      return;
    }
    const pageViewSpanId = this.getCurrentPageViewSpanId();
    const enclosing = this._currentPageViewContext();
    this._pushEvent({
      event_type: eventType,
      event_at_ms: internalOptions?.eventAtMs ?? Date.now(),
      data,
      ...enclosing !== null ? {
        trace_id: enclosing.traceId,
        span_id: enclosing.spanId,
        ...enclosing.traceFlags === undefined ? {} : { trace_flags: enclosing.traceFlags },
        ...enclosing.traceState === undefined ? {} : { trace_state: enclosing.traceState },
      } : {},
      ...pageViewSpanId !== null ? { page_view_span_id: pageViewSpanId } : {},
    });
  }

  private _capturePageView(entryType: "initial" | "push" | "replace" | "pop" | "restore" | "rotation") {
    const screenObject = window.screen;
    if (!hasScreenDimensions(screenObject)) {
      return;
    }

    const url = window.location.href;
    const isForcedRestart = entryType === "initial" || entryType === "restore" || entryType === "rotation";
    if (url === this._lastUrl && !isForcedRestart) return;
    this._flushPendingKeystrokes();
    this._lastUrl = url;

    this._endPageViewSpan();

    const pageViewData = {
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
    };

    const span = this._startSystemSpan("$page-view", {
      data: pageViewData,
      parent: this._pageViewLifecycleParent(),
    });
    this._pageViewSpan = span;
    this._resetScrollDepth();
    this._recentClicks = [];
    if (this._webVitals !== null) {
      this._webVitals.disconnect();
      this._webVitals = null;
      this._webVitalsSpanId = null;
    }
    let collector: WebVitalsCollector | null = null;
    collector = startWebVitalsCollector(
      (snapshot) => {
        if (collector !== null && !span.isEnded()) {
          span.setData({ web_vitals: snapshot });
        }
      },
      entryType === "initial"
        ? { mode: "initial" }
        : { mode: "soft-nav", navStartTime: performance.now() },
    );
    if (collector !== null) {
      this._webVitals = collector;
      this._webVitalsSpanId = span.spanId;
    }
  }

  /**
   * Ends the current $page-view span, absorbing the final scroll depth and the
   * span's web-vitals snapshot so the single deduped wire row carries both the
   * data and the end time.
   */
  private _endPageViewSpan() {
    const span = this._pageViewSpan;
    if (span === null || span.isEnded()) return;
    this._sampleScrollDepth();
    span.setData({
      scroll_depth_px: Math.round(this._maxScrollDepthPx),
      scroll_depth_ratio: Math.round(this._maxScrollDepthRatio * 1000) / 1000,
    });
    if (this._webVitals !== null && this._webVitalsSpanId === span.spanId) {
      const snapshot = this._webVitals.snapshot();
      span.setData({ web_vitals: snapshot });
      this._webVitalsMetricRecorder.record(snapshot);
      this._webVitals.disconnect();
      this._webVitals = null;
      this._webVitalsSpanId = null;
    }
    span.end();
  }

  private _resetScrollDepth() {
    this._maxScrollDepthPx = 0;
    this._maxScrollDepthRatio = 0;
    this._sampleScrollDepth();
  }

  private _sampleScrollDepth() {
    const bottom = window.scrollY + window.innerHeight;
    const height = Math.max(document.scrollingElement?.scrollHeight ?? 0, window.innerHeight);
    if (bottom > this._maxScrollDepthPx) this._maxScrollDepthPx = bottom;
    const ratio = height > 0 ? Math.min(bottom / height, 1) : 0;
    if (ratio > this._maxScrollDepthRatio) this._maxScrollDepthRatio = ratio;
  }

  private readonly _onScrollDepth = () => {
    this._sampleScrollDepth();
  };

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

  private _findNearestAnchor(element: Element): Element | null {
    let current: Element | null = element;
    while (current) {
      if (current.tagName === "A" && current.hasAttribute("href")) {
        return current;
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

    const nowMs = Date.now();
    this._recentClicks = this._recentClicks.filter((click) => nowMs - click.atMs < RAGE_CLICK_WINDOW_MS);
    this._recentClicks.push({ x: event.clientX, y: event.clientY, atMs: nowMs });
    const burstSize = this._recentClicks.filter((click) =>
      Math.abs(click.x - event.clientX) <= RAGE_CLICK_RADIUS_PX && Math.abs(click.y - event.clientY) <= RAGE_CLICK_RADIUS_PX,
    ).length;

    const anchor = this._findNearestAnchor(target);
    const href = anchor?.getAttribute("href") ?? null;
    let outbound = false;
    let download = anchor !== null && anchor.hasAttribute("download");
    if (href !== null) {
      try {
        const hrefUrl = new URL(href, window.location.href);
        outbound = (hrefUrl.protocol === "http:" || hrefUrl.protocol === "https:") && hrefUrl.origin !== window.location.origin;
        download = download || DOWNLOAD_EXTENSION_RE.test(hrefUrl.pathname);
      } catch {
      }
    }

    const pageViewSpanId = this.getCurrentPageViewSpanId();
    const enclosing = this._currentPageViewContext();
    const clickEvent: TrackedEvent = {
      event_type: "$click",
      event_at_ms: nowMs,
      data: {
        tag_name: target.tagName.toLowerCase(),
        text: getTextSnippet(target.textContent),
        href,
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
        ...burstSize >= RAGE_CLICK_MIN_CLICKS ? { rage: 1 } : {},
        ...outbound ? { outbound: 1 } : {},
        ...download ? { download: 1 } : {},
      },
      ...enclosing !== null ? {
        trace_id: enclosing.traceId,
        span_id: enclosing.spanId,
        ...enclosing.traceFlags === undefined ? {} : { trace_flags: enclosing.traceFlags },
        ...enclosing.traceState === undefined ? {} : { trace_state: enclosing.traceState },
      } : {},
      ...pageViewSpanId !== null ? { page_view_span_id: pageViewSpanId } : {},
    };

    // Register for dead-click classification before buffering, so a
    // size-triggered flush from this very push already holds the click back.
    if (this._deadClickTimer !== null && this._unclassifiedClicks.size < DEAD_CLICK_MAX_PENDING) {
      this._connectDeadClickMutationObserver();
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

    document.addEventListener("scroll", this._onDeadClickScroll, { capture: true, passive: true });
    document.addEventListener("selectionchange", this._onDeadClickSelectionChange);
    document.addEventListener("visibilitychange", this._onDeadClickVisibilityChange);

    this._deadClickTimer = setInterval(() => this._checkDeadClicks(), DEAD_CLICK_CHECK_INTERVAL_MS);
  }

  /**
   * Connects the dead-click MutationObserver for the duration of pending click
   * classification. Called SYNCHRONOUSLY from the click handler, before any
   * classification window opens: MutationObserver.observe() registers
   * synchronously, so DOM mutations caused by this very click (delivered on the
   * following microtask) are still observed. Classification semantics are
   * unchanged — only post-click mutations count anyway (`signalWithin` filters
   * `signalAtMs >= click.event_at_ms`), so a stale `_lastMutationAtMs` from a
   * previous observation window can never mark a later click alive.
   */
  private _connectDeadClickMutationObserver() {
    if (this._deadClickMutationObserver !== null) return;
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
  }

  private _disconnectDeadClickMutationObserverIfIdle() {
    if (this._unclassifiedClicks.size > 0) return;
    if (this._deadClickMutationObserver !== null) {
      this._deadClickMutationObserver.disconnect();
      this._deadClickMutationObserver = null;
    }
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
    this._disconnectDeadClickMutationObserverIfIdle();
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


  private readonly _onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this._capturePageView("restore");
      this._restartPresenceSpans();
    }
  };

  private readonly _onFormSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (isInsideHexclaveUi(form)) return;

    const fieldNames: string[] = [];
    for (const element of Array.from(form.elements)) {
      const name = element.getAttribute("name");
      if (name !== null && name !== "" && !fieldNames.includes(name)) {
        fieldNames.push(name);
        if (fieldNames.length >= FORM_FIELD_NAMES_MAX) break;
      }
    }

    let actionPath: string | null = null;
    try {
      const actionUrl = new URL(form.action, window.location.href);
      actionPath = actionUrl.origin === window.location.origin ? actionUrl.pathname : `${actionUrl.origin}${actionUrl.pathname}`;
    } catch {
      actionPath = null;
    }

    this._pushSystemEvent("$form-submit", {
      selector: this._buildSelector(form),
      elements_chain: buildElementsChain(form),
      form_id: form.id === "" ? null : form.id,
      form_name: form.getAttribute("name"),
      method: form.method,
      action_path: actionPath,
      field_names: fieldNames,
      url: window.location.href,
      path: window.location.pathname,
      title: document.title,
    });
  };

  private readonly _onWindowResize = () => {
    if (this._resizeDebounceTimer !== null) clearTimeout(this._resizeDebounceTimer);
    this._resizeDebounceTimer = setTimeout(() => {
      this._resizeDebounceTimer = null;
      const screenObject = window.screen;
      this._pushSystemEvent("$window-resize", {
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        screen_width: hasScreenDimensions(screenObject) ? screenObject.width : null,
        screen_height: hasScreenDimensions(screenObject) ? screenObject.height : null,
        url: window.location.href,
        path: window.location.pathname,
      });
    }, RESIZE_DEBOUNCE_MS);
  };

  private readonly _onKeyDownCapture = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      this._flushPendingKeystrokes();
      return;
    }
    if (
      isInsideHexclaveUi(target)
      || isInsideBlockedReplaySubtree(target, this._keystrokeCapture)
      || isMaskedReplayInput(target, this._keystrokeCapture.maskAllInputs)
    ) {
      this._flushPendingKeystrokes();
      return;
    }

    const eventAtMs = Date.now();
    const nowPerformanceMs = performance.now();
    if (this._pendingKeystrokes !== null && this._pendingKeystrokes.target !== target) {
      this._flushPendingKeystrokes();
    }
    if (this._pendingKeystrokes === null) {
      this._pendingKeystrokes = {
        target,
        count: 1,
        eventAtMs,
        startedAtPerformanceMs: nowPerformanceMs,
        lastAtPerformanceMs: nowPerformanceMs,
        url: window.location.href,
        path: window.location.pathname,
      };
    } else {
      this._pendingKeystrokes.count += 1;
      this._pendingKeystrokes.lastAtPerformanceMs = nowPerformanceMs;
    }

    if (this._keystrokeDebounceTimer !== null) clearTimeout(this._keystrokeDebounceTimer);
    this._keystrokeDebounceTimer = setTimeout(() => {
      this._keystrokeDebounceTimer = null;
      this._flushPendingKeystrokes();
    }, KEYSTROKE_DEBOUNCE_MS);
  };

  private _flushPendingKeystrokes() {
    if (this._keystrokeDebounceTimer !== null) {
      clearTimeout(this._keystrokeDebounceTimer);
      this._keystrokeDebounceTimer = null;
    }
    const pending = this._pendingKeystrokes;
    this._pendingKeystrokes = null;
    if (pending === null) return;
    this._pushSystemEvent("$keystroke", {
      count: pending.count,
      duration_ms: pending.lastAtPerformanceMs - pending.startedAtPerformanceMs,
      url: pending.url,
      path: pending.path,
    }, { eventAtMs: pending.eventAtMs });
  }

  private _clearPendingKeystrokes() {
    if (this._keystrokeDebounceTimer !== null) {
      clearTimeout(this._keystrokeDebounceTimer);
      this._keystrokeDebounceTimer = null;
    }
    this._pendingKeystrokes = null;
  }

  private readonly _onOffline = () => {
    if (this._offlineSpan !== null && !this._offlineSpan.isEnded()) return;
    this._offlineSpan = this._startSystemSpan("$offline", { parent: this._currentPageViewContext(), pageViewSpanId: this.getCurrentPageViewSpanId() ?? undefined });
  };

  private readonly _onOnline = () => {
    this._offlineSpan?.end();
    this._offlineSpan = null;
  };

  private _setupAutocaptureListeners() {
    window.addEventListener("scroll", this._onScrollDepth, { passive: true });
    window.addEventListener("pageshow", this._onPageShow);
    document.addEventListener("submit", this._onFormSubmit, { capture: true });
    window.addEventListener("resize", this._onWindowResize);
    window.addEventListener("offline", this._onOffline);
    window.addEventListener("online", this._onOnline);
    if (this._keystrokeCapture.enabled) {
      document.addEventListener("keydown", this._onKeyDownCapture, { capture: true });
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this._onOffline();
    }
    this._detachAutocaptureListeners = () => {
      window.removeEventListener("scroll", this._onScrollDepth);
      window.removeEventListener("pageshow", this._onPageShow);
      document.removeEventListener("submit", this._onFormSubmit, { capture: true });
      window.removeEventListener("resize", this._onWindowResize);
      window.removeEventListener("offline", this._onOffline);
      window.removeEventListener("online", this._onOnline);
      document.removeEventListener("keydown", this._onKeyDownCapture, { capture: true });
      this._clearPendingKeystrokes();
      if (this._resizeDebounceTimer !== null) {
        clearTimeout(this._resizeDebounceTimer);
        this._resizeDebounceTimer = null;
      }
    };
  }


  private readonly _onIntegrityVisibilityChange = () => {
    this._setAwayReason("tab-hidden", document.visibilityState === "hidden");
  };

  private readonly _onWindowBlur = () => {
    this._setAwayReason("window-blur", true);
  };

  private readonly _onWindowFocus = () => {
    this._setAwayReason("window-blur", false);
  };

  private _currentAwayReasons(): Set<AwayReason> {
    const reasons = new Set<AwayReason>();
    if (document.visibilityState === "hidden") reasons.add("tab-hidden");
    if (typeof document.hasFocus === "function" && !document.hasFocus()) reasons.add("window-blur");
    return reasons;
  }

  private _setAwayReason(reason: AwayReason, active: boolean) {
    if (active) {
      this._awayReasons.add(reason);
    } else {
      this._awayReasons.delete(reason);
    }
    this._reconcileAwaySpan();
  }

  private _reconcileAwaySpan() {
    if (this._awayReasons.size === 0) {
      this._awaySpan?.end();
      this._awaySpan = null;
      return;
    }
    if (this._awaySpan === null || this._awaySpan.isEnded()) {
      this._awaySpanSeenReasons = new Set(this._awayReasons);
      this._awaySpan = this._startSystemSpan("$away", {
        data: { reasons: [...this._awaySpanSeenReasons] },
        parent: this._currentPageViewContext(),
        pageViewSpanId: this.getCurrentPageViewSpanId() ?? undefined,
      });
      return;
    }
    const unseen = [...this._awayReasons].filter((reason) => !this._awaySpanSeenReasons.has(reason));
    if (unseen.length > 0) {
      for (const reason of unseen) {
        this._awaySpanSeenReasons.add(reason);
      }
      this._awaySpan.setData({ reasons: [...this._awaySpanSeenReasons] });
    }
  }

  private readonly _onCopyCapture = (event: ClipboardEvent) => {
    this._recordClipboardCopy("$copy", event);
  };

  private readonly _onCutCapture = (event: ClipboardEvent) => {
    this._recordClipboardCopy("$cut", event);
  };

  private _recordClipboardCopy(eventType: "$copy" | "$cut", event: ClipboardEvent) {
    const target = event.target;
    if (target instanceof Element && isInsideHexclaveUi(target)) return;
    const selection = typeof document.getSelection === "function" ? document.getSelection()?.toString() ?? "" : "";
    if (selection !== "") this._lastCopyHash = hashTextLocal(selection);
    this._pushSystemEvent(eventType, {
      selection_length: selection.length,
      url: window.location.href,
      path: window.location.pathname,
    });
  }

  private readonly _onPasteCapture = (event: ClipboardEvent) => {
    const target = event.target;
    if (target instanceof Element && isInsideHexclaveUi(target)) return;
    const text = event.clipboardData?.getData("text/plain");
    const data: { url: string, path: string, tag_name?: string, selector?: string, length?: number, same_page_origin?: 0 | 1 } = {
      url: window.location.href,
      path: window.location.pathname,
    };
    if (target instanceof Element) {
      data.tag_name = target.tagName.toLowerCase();
      data.selector = this._buildSelector(target);
    }
    if (typeof text === "string") {
      data.length = text.length;
      data.same_page_origin = this._lastCopyHash !== null && text !== "" && hashTextLocal(text) === this._lastCopyHash ? 1 : 0;
    }
    this._pushSystemEvent("$paste", data);
  };

  private readonly _onContextMenuCapture = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (isInsideHexclaveUi(target)) return;
    this._pushSystemEvent("$context-menu", {
      tag_name: target.tagName.toLowerCase(),
      selector: this._buildSelector(target),
      x: event.clientX,
      y: event.clientY,
      url: window.location.href,
      path: window.location.pathname,
    });
  };

  private readonly _onBeforePrint = () => {
    this._pushSystemEvent("$print", {
      url: window.location.href,
      path: window.location.pathname,
    });
  };

  private readonly _onFullscreenChange = () => {
    const isFullscreen = document.fullscreenElement != null;
    if (this._wasFullscreen && !isFullscreen) {
      this._pushSystemEvent("$fullscreen-exit", {
        url: window.location.href,
        path: window.location.pathname,
      });
    }
    this._wasFullscreen = isFullscreen;
  };

  private _setupIntegritySignals() {
    document.addEventListener("visibilitychange", this._onIntegrityVisibilityChange);
    window.addEventListener("blur", this._onWindowBlur);
    window.addEventListener("focus", this._onWindowFocus);
    document.addEventListener("copy", this._onCopyCapture, { capture: true });
    document.addEventListener("cut", this._onCutCapture, { capture: true });
    document.addEventListener("paste", this._onPasteCapture, { capture: true });
    document.addEventListener("contextmenu", this._onContextMenuCapture, { capture: true });
    window.addEventListener("beforeprint", this._onBeforePrint);
    document.addEventListener("fullscreenchange", this._onFullscreenChange);
    this._wasFullscreen = document.fullscreenElement != null;
    this._setAwayReason("tab-hidden", document.visibilityState === "hidden");
    this._detachIntegrityListeners = () => {
      document.removeEventListener("visibilitychange", this._onIntegrityVisibilityChange);
      window.removeEventListener("blur", this._onWindowBlur);
      window.removeEventListener("focus", this._onWindowFocus);
      document.removeEventListener("copy", this._onCopyCapture, { capture: true });
      document.removeEventListener("cut", this._onCutCapture, { capture: true });
      document.removeEventListener("paste", this._onPasteCapture, { capture: true });
      document.removeEventListener("contextmenu", this._onContextMenuCapture, { capture: true });
      window.removeEventListener("beforeprint", this._onBeforePrint);
      document.removeEventListener("fullscreenchange", this._onFullscreenChange);
    };
  }

  private _endOpenPresenceSpans() {
    for (const span of [this._awaySpan, this._offlineSpan]) {
      if (span !== null && !span.isEnded()) span.end();
    }
    this._awaySpan = null;
    this._offlineSpan = null;
  }

  private _restartPresenceSpans() {
    this._awaySpan = null;
    this._offlineSpan = null;
    if (this._deps.integritySignals === true) {
      this._awayReasons = this._currentAwayReasons();
      this._reconcileAwaySpan();
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this._offlineSpan = this._startSystemSpan("$offline", { parent: this._currentPageViewContext(), pageViewSpanId: this.getCurrentPageViewSpanId() ?? undefined });
    }
  }


  private readonly _onPageHide = () => {
    this._flushPendingKeystrokes();
    this._endPageViewSpan();
    this._endOpenPresenceSpans();
    this._flushInBackground({ keepalive: true });
  };

  private readonly _onVisibilityChangeFlush = () => {
    this._flushPendingKeystrokes();
    this._flushInBackground({ keepalive: true });
  };

  private _setupPageHideListeners() {
    window.addEventListener("pagehide", this._onPageHide);
    document.addEventListener("visibilitychange", this._onVisibilityChangeFlush);
    this._detachListeners = () => {
      window.removeEventListener("pagehide", this._onPageHide);
      document.removeEventListener("visibilitychange", this._onVisibilityChangeFlush);
    };
  }

  private _teardown() {
    if (this._detachListeners) {
      this._detachListeners();
      this._detachListeners = null;
    }
    if (this._detachAutocaptureListeners) {
      this._detachAutocaptureListeners();
      this._detachAutocaptureListeners = null;
    }
    if (this._detachIntegrityListeners) {
      this._detachIntegrityListeners();
      this._detachIntegrityListeners = null;
    }
    if (this._webVitals !== null) {
      this._webVitals.disconnect();
      this._webVitals = null;
      this._webVitalsSpanId = null;
    }
    this._pageViewSpan = null;
    this._awaySpan = null;
    this._awayReasons.clear();
    this._awaySpanSeenReasons.clear();
    this._offlineSpan = null;
    this._recentClicks = [];
    this._lastCopyHash = null;

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

    this._settleAllPending("analytics tracker stopped");
    this._events = [];
    this._approxBytes = 0;
  }

  private async _flush(options: { keepalive: boolean }) {
    // A keepalive flush means the page is unloading — a click still awaiting
    // dead-click classification led to that unload, so it is alive by
    // definition and ships unmarked.
    if (options.keepalive) {
      this._unclassifiedClicks.clear();
      this._disconnectDeadClickMutationObserverIfIdle();
    }

    // Clicks still awaiting classification stay buffered so the sweep can
    // mark them dead in place; classification finishes well within one flush
    // interval, so they ride the next flush at the latest.
    const bufferedEvents = this._events.filter((event) => !this._unclassifiedClicks.has(event));
    if (bufferedEvents.length === 0) return;
    this._events = this._events.filter((event) => this._unclassifiedClicks.has(event));
    this._approxBytes = this._events.reduce((total, event) => total + JSON.stringify(event).length, 0);
    for (const event of bufferedEvents) this._emitTrackedEvent(event);
    const flush = this._deps.forceFlushOtel?.() ?? Promise.resolve();
    if (options.keepalive) {
      registerTelemetryBackgroundTask(this._deps.registerBackgroundTask, flush, "EventTracker OTel flush");
    }
    await flush;
  }

  /**
   * Browser telemetry delivery is best-effort. A transport failure can happen
   * while the page is unloading or the user is offline; it must not be
   * re-reported as an uncaught application error (which would be captured and
   * exported again through the same unavailable transport).
   */
  private _flushInBackground(options: { keepalive: boolean }): void {
    runAsynchronously(() => this._flush(options), { noErrorLogging: true });
  }

  private _emitTrackedEvent(event: TrackedEvent): void {
    emitHexclaveOtelEvent({
      eventName: event.event_type,
      data: event.data,
      clientVersion: this._deps.clientVersion ?? "unknown",
      timestamp: event.event_at_ms,
      parent: event.trace_id === undefined || event.span_id === undefined ? null : {
        traceId: event.trace_id,
        spanId: event.span_id,
        ...event.trace_flags === undefined ? {} : { traceFlags: event.trace_flags },
        ...event.trace_state === undefined ? {} : { traceState: event.trace_state },
      },
      correlationAttributes: {
        "hexclave.session_replay.segment.id": this._sessionReplaySegmentId,
        ...event.page_view_span_id === undefined ? {} : { "hexclave.page_view.span_id": event.page_view_span_id },
      },
    });
  }

  private _tick() {
    if (this._cancelled) return;
    if (this._events.length > 0) {
      this._flushInBackground({ keepalive: false });
    }
  }
}
