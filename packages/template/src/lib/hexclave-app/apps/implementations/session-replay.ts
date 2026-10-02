import { isBrowserLike } from "@hexclave/shared/dist/utils/env";
import { captureWarning, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { generateUuid, isAdBlockerNetworkError, isAnalyticsNotEnabledError } from "./telemetry-transport";
import { getEffectiveSessionReplayBlockSelector, type AnalyticsReplayOptions } from "./analytics-config";
import type { TelemetryResource } from "./telemetry-config";


// ---------- Recording internals ----------

// Hexclave rebrand: canonical localStorage prefix (colon delimiters preserved).
const LOCAL_STORAGE_PREFIX = "hexclave:session-replay:v1";
// Hexclave rebrand: legacy prefix — dual-read only, so a recording session active
// across an SDK upgrade is not orphaned. Never written.
const LEGACY_LOCAL_STORAGE_PREFIX = "stack:session-replay:v1";
const IDLE_TTL_MS = 3 * 60 * 1000;
const MAX_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

const FLUSH_INTERVAL_MS = 5_000;
const MAX_EVENTS_PER_BATCH = 200;
const MAX_APPROX_BYTES_PER_BATCH = 512_000;
// Uncompressed per-batch target; the transport gzips before sending.
const MAX_BATCH_UNCOMPRESSED_BYTES = 900_000;
// The server gunzips the whole batch (envelope + events) and rejects anything
// whose decompressed size exceeds MAX_DECOMPRESSED_BYTES (8 MiB) in the backend
// route. Since a single oversized event is sent alone, reserve headroom for the
// JSON envelope (session/batch ids, timestamps, wrapper keys) so an event that
// passes this check can't render a batch that trips the server's cap by a few
// hundred bytes. Keep the server's MAX_DECOMPRESSED_BYTES >= this + the margin.
const BATCH_ENVELOPE_OVERHEAD_BYTES = 1024;
const MAX_SINGLE_EVENT_BYTES = 8 * 1024 * 1024 - BATCH_ENVELOPE_OVERHEAD_BYTES;

// Reused across the emit hot path to avoid per-event allocation.
const textEncoder = new TextEncoder();

const STYLESHEET_RESNAPSHOT_DEBOUNCE_MS = 1_000;

function isFullSnapshotEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && Reflect.get(event, "type") === 2;
}

/**
 * Whether rrweb would be able to inline this just-loaded stylesheet link into
 * a full snapshot: the sheet must exist, its rules must be readable (reading
 * `cssRules` of a cross-origin stylesheet served without CORS headers throws),
 * and it must be non-empty. Exported for tests.
 */
export function canInlineStylesheetLink(link: HTMLLinkElement): boolean {
  const sheet = link.sheet;
  if (sheet == null) return false;
  try {
    return sheet.cssRules.length > 0;
  } catch {
    return false;
  }
}

export type StoredSession = {
  session_id: string,
  created_at_ms: number,
  last_activity_ms: number,
};

export function safeParseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.session_id !== "string") return null;
    if (typeof parsed.created_at_ms !== "number") return null;
    if (typeof parsed.last_activity_ms !== "number") return null;
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

export function makeStorageKey(projectId: string) {
  return `${LOCAL_STORAGE_PREFIX}:${projectId}`;
}

// Hexclave rebrand: legacy key, dual-read only (never written).
export function makeLegacyStorageKey(projectId: string) {
  return `${LEGACY_LOCAL_STORAGE_PREFIX}:${projectId}`;
}

export function getOrRotateSession(options: { key: string, legacyKey?: string, nowMs: number }): StoredSession {
  // Hexclave rebrand: prefer the new key; fall back to the legacy key so a
  // recording session active across an SDK upgrade is not orphaned.
  const existing = safeParseStoredSession(localStorage.getItem(options.key))
    ?? (options.legacyKey ? safeParseStoredSession(localStorage.getItem(options.legacyKey)) : null);
  if (
    existing
    && options.nowMs - existing.last_activity_ms <= IDLE_TTL_MS
    && options.nowMs - existing.created_at_ms <= MAX_SESSION_DURATION_MS
  ) {
    return existing;
  }
  const next: StoredSession = {
    session_id: generateUuid(),
    created_at_ms: options.nowMs,
    last_activity_ms: options.nowMs,
  };
  localStorage.setItem(options.key, JSON.stringify(next));
  return next;
}

export type SessionRecorderDeps = {
  projectId: string,
  resource: TelemetryResource,
  sendBatch: (body: string, options: { keepalive: boolean }) => Promise<Result<Response, Error>>,
  sessionReplaySegmentId?: string,
  /** Rotate the shared tab span when the durable replay lifecycle rotates. */
  onSessionRotation?: () => void,
  /** The replay endpoint has materialized this segment and it is safe to parent under it. */
  onSessionReplaySegmentMaterialized?: (segmentId: string) => Promise<void>,
};

export class SessionRecorder {
  private _started = false;
  private _cancelled = false;
  private _disabled = false;
  private _stopRecording: (() => void) | null = null;
  private _detachListeners: (() => void) | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _events: unknown[] = [];
  private _eventSizes: number[] = [];
  private _approxBytes = 0;
  private _lastPersistActivity = 0;
  private _recording = false;
  private _rrwebModule: typeof import("@rrweb/record") | null = null;
  private _lastBrowserSessionId: string | null = null;
  private _takingSnapshot = false;
  private _needsFullSnapshot = false;
  private _hasMaterializedFullSnapshot = false;
  private _flushInProgress = false;
  private _resnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private _sessionReplaySegmentId: string;
  private readonly _storageKey: string;
  // Hexclave rebrand: legacy key used for dual-read fallback only.
  private readonly _legacyStorageKey: string;
  private readonly _deps: SessionRecorderDeps;
  private readonly _replayOptions: AnalyticsReplayOptions;

  constructor(deps: SessionRecorderDeps, replayOptions: AnalyticsReplayOptions) {
    this._deps = deps;
    this._replayOptions = replayOptions;
    this._sessionReplaySegmentId = deps.sessionReplaySegmentId ?? generateUuid();
    this._storageKey = makeStorageKey(deps.projectId);
    this._legacyStorageKey = makeLegacyStorageKey(deps.projectId);
  }

  /**
   * Starts recording. Idempotent — calling multiple times is safe.
   */
  start() {
    if (this._started) return;
    if (!isBrowserLike()) return;
    this._started = true;

    // Kick off rrweb recording
    runAsynchronously(() => this._startRecording(), { noErrorLogging: true });

    // Periodic flush
    this._flushTimer = setInterval(() => this._tick(), FLUSH_INTERVAL_MS);
  }

  stop() {
    this._cancelled = true;
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    // Flush remaining events before cleanup
    runAsynchronously(() => this._flush({ keepalive: true }));
    this._stopCurrentRecording();
  }

  clearBuffer() {
    this._events = [];
    this._eventSizes = [];
    this._approxBytes = 0;
  }

  /**
   * Replaces the per-tab id shared with the EventTracker. Called on sign-out
   * (paired with clearBuffer) so a subsequent same-tab sign-in as a different user
   * does not reuse the previous user's session_replay_segment_id — which would let
   * the two users' replays and events be correlated. The app rotates both trackers
   * to the SAME new id so they stay in sync.
   */
  setSessionReplaySegmentId(id: string) {
    this._sessionReplaySegmentId = id;
    this._needsFullSnapshot = true;
    this._hasMaterializedFullSnapshot = false;
  }

  /** Resume a rotated segment only after its authenticated session is live. */
  captureFullSnapshotForCurrentSegment(): void {
    if (!this._needsFullSnapshot || !this._recording || this._rrwebModule === null) return;
    if (this._takingSnapshot) return;
    this._takingSnapshot = true;
    try {
      this._rrwebModule.record.takeFullSnapshot();
      this._needsFullSnapshot = false;
    } catch (error) {
      captureWarning("SessionRecorder.fullSnapshot", error);
    } finally {
      this._takingSnapshot = false;
    }
  }

  private _persistActivity(nowMs: number): StoredSession {
    const stored = getOrRotateSession({ key: this._storageKey, legacyKey: this._legacyStorageKey, nowMs });
    if (nowMs - this._lastPersistActivity < 5_000) return stored;
    this._lastPersistActivity = nowMs;
    const updated: StoredSession = { ...stored, last_activity_ms: nowMs };
    localStorage.setItem(this._storageKey, JSON.stringify(updated));
    return stored;
  }

  private async _flush(options: { keepalive: boolean }) {
    if (this._disabled) return;
    if (this._events.length === 0) return;
    // Prevent concurrent in-flight HTTP requests. When a flush is already
    // in-flight, a second batch could race on the server (both call
    // findRecentSessionReplay before either upsert commits) and create
    // duplicate SessionReplay records. Events stay in _events and will be
    // picked up by the next tick or batch-size check.
    if (this._flushInProgress) return;

    // A segment is not usable until its FullSnapshot has reached the server.
    // If an earlier first-batch attempt failed, never upload the dependent
    // mutations by themselves; replace them with a fresh reconstruction root.
    if (this._recording && !this._hasMaterializedFullSnapshot && !this._events.some(isFullSnapshotEvent)) {
      this._restartUnmaterializedSegment(this._sessionReplaySegmentId);
      if (this._events.length === 0) return;
    }

    const nowMs = Date.now();
    const stored = getOrRotateSession({ key: this._storageKey, legacyKey: this._legacyStorageKey, nowMs });

    // Capture all buffered events upfront (before any await) so that
    // stop() / _stopCurrentRecording() clearing this._events cannot race
    // with the async send loop below and silently discard overflow batches.
    const allEvents = this._events;
    const allSizes = this._eventSizes;
    this._events = [];
    this._eventSizes = [];
    this._approxBytes = 0;
    const sessionReplaySegmentId = this._sessionReplaySegmentId;

    // Non-keepalive flushes gzip before sending, so a single event up to the
    // server's decompressed budget can be sent alone. Keepalive flushes
    // (pagehide/visibilitychange/stop) skip async gzip to dispatch before page
    // tear-down, so they're bound by the server's raw ~1MB body limit; cap their
    // single-event size at the uncompressed batch target so an oversized event
    // is dropped rather than 413-ing the flush and losing the events behind it.
    const maxSingleEventBytes = options.keepalive ? MAX_BATCH_UNCOMPRESSED_BYTES : MAX_SINGLE_EVENT_BYTES;

    this._flushInProgress = true;
    try {
      let offset = 0;
      while (offset < allEvents.length) {
        // A single event over the limit can't be sent (rrweb events aren't
        // splittable); drop it and move on to the rest of the buffer.
        const firstSize = allSizes[offset] ?? throwErr("_eventSizes out of sync with _events — this should never happen");
        if (firstSize > maxSingleEventBytes) {
          captureWarning(
            "SessionRecorder.flush",
            new Error(`Dropping oversized session replay event (${firstSize} bytes > ${maxSingleEventBytes} byte limit); it cannot be sent without exceeding the server's body limit.`),
          );
          offset += 1;
          continue;
        }

        let batchBytes = 0;
        let batchEnd = offset;
        for (let i = offset; i < allEvents.length; i++) {
          const nextSize = allSizes[i] ?? throwErr("_eventSizes out of sync with _events — this should never happen");
          if (batchBytes + nextSize > MAX_BATCH_UNCOMPRESSED_BYTES && batchEnd > offset) break;
          batchBytes += nextSize;
          batchEnd = i + 1;
        }

        const batchEvents = allEvents.slice(offset, batchEnd);
        const batchHasFullSnapshot = batchEvents.some(isFullSnapshotEvent);
        offset = batchEnd;

        const batchId = generateUuid();
        const payload = {
          schema_version: 2,
          resource: this._deps.resource,
          browser_session_id: stored.session_id,
          session_replay_segment_id: sessionReplaySegmentId,
          batch_id: batchId,
          started_at_ms: stored.created_at_ms,
          sent_at_ms: nowMs,
          events: batchEvents,
        };

        const res = await this._deps.sendBatch(
          JSON.stringify(payload),
          { keepalive: options.keepalive },
        );

        if (res.status === "error") {
          if (isAnalyticsNotEnabledError(res.error)) {
            this._disable();
            return;
          }
          this._restartUnmaterializedSegment(sessionReplaySegmentId);
          // Ad blockers commonly block analytics endpoints, causing network
          // errors. These are expected and should not pollute the console.
          if (isAdBlockerNetworkError(res.error)) {
            return;
          }
          captureWarning("SessionRecorder.flush", res.error);
          return;
        }

        if (!res.data.ok) {
          // On any non-2xx we stop the loop, so this batch and every event still
          // buffered behind it are dropped (not retried). Count them for the log.
          const droppedCount = batchEvents.length + (allEvents.length - offset);
          this._restartUnmaterializedSegment(sessionReplaySegmentId);
          if (res.data.status === 413) {
            // The payload exceeded the server's body limit despite the client-side
            // size caps — most likely a single poorly-compressible event (e.g. an
            // embedded image/canvas) that gzipped above the wire limit. Distinct
            // from other failures because the caps are supposed to prevent it.
            captureWarning(
              "SessionRecorder.flush",
              new Error(`Session replay batch rejected with 413 (payload too large) despite client-side size caps; dropping ${droppedCount} buffered event(s). A poorly-compressible event likely exceeded the server's body limit after gzip.`),
            );
            return;
          }
          captureWarning("SessionRecorder.flush", new Error(`SessionRecorder flush failed (dropping ${droppedCount} buffered event(s)): ${res.data.status} ${await res.data.text()}`));
          return;
        }
        if (batchHasFullSnapshot && sessionReplaySegmentId === this._sessionReplaySegmentId) {
          this._hasMaterializedFullSnapshot = true;
        }
        await this._deps.onSessionReplaySegmentMaterialized?.(sessionReplaySegmentId);
      }
    } finally {
      this._flushInProgress = false;
    }
  }

  private _restartUnmaterializedSegment(segmentId: string): void {
    if (segmentId !== this._sessionReplaySegmentId || this._hasMaterializedFullSnapshot) return;
    this.clearBuffer();
    this._needsFullSnapshot = true;
    this.captureFullSnapshotForCurrentSegment();
  }

  private _disable() {
    this._disabled = true;
    this.clearBuffer();
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._stopCurrentRecording();
  }

  private async _startRecording() {
    if (this._recording || this._cancelled) return;

    if (!this._rrwebModule) {
      const rrwebImport = await Result.fromPromise(import("@rrweb/record"));
      if (rrwebImport.status === "error") {
        console.warn("SessionRecorder: @rrweb/record import failed. Is @rrweb/record installed?", rrwebImport.error);
        return;
      }
      this._rrwebModule = rrwebImport.data;
    }

    // cancelled may change during the await above
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this._cancelled) return;

    // rrweb only inlines a `<link rel="stylesheet">` into a snapshot when
    // its CSS is already loaded and readable at serialization time. Two paths
    // systematically miss that window: (1) the initial full snapshot is taken
    // as soon as the SDK boots, which can be before head stylesheets finish
    // loading (async SDK scripts are not blocked by pending stylesheets), and
    // (2) links inserted later (e.g. Next.js App Router route CSS on client
    // navigation) are serialized by the mutation observer at insert time,
    // before their CSS has loaded. In both cases only the href is recorded, so
    // playback depends on re-fetching the original asset URL — which 404s once
    // hashed assets are redeployed — and the replay renders as unstyled raw
    // HTML. Fix: whenever a stylesheet link finishes loading while recording,
    // re-take a debounced full snapshot; the sheet is now loaded, so rrweb
    // inlines it and the recording becomes self-contained. Stylesheets that
    // were already inlined never fire another load event, so this adds no
    // snapshots in the steady state. Attached BEFORE record() so a stylesheet
    // finishing between the initial snapshot and listener setup is not missed
    // (the resulting extra snapshot is harmless). Resource load events don't
    // bubble, but they do pass document in the capture phase.
    const onResourceLoad = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLLinkElement)) return;
      if (!target.relList.contains("stylesheet")) return;
      // If rrweb couldn't inline this sheet anyway (cross-origin without CORS,
      // empty sheet), a new snapshot wouldn't help — skip the cost.
      if (!canInlineStylesheetLink(target)) return;
      if (this._resnapshotTimer !== null) clearTimeout(this._resnapshotTimer);
      this._resnapshotTimer = setTimeout(() => {
        this._resnapshotTimer = null;
        if (this._cancelled || !this._recording || !this._rrwebModule) return;
        if (this._takingSnapshot) return;
        this._takingSnapshot = true;
        try {
          this._rrwebModule.record.takeFullSnapshot();
        } finally {
          this._takingSnapshot = false;
        }
      }, STYLESHEET_RESNAPSHOT_DEBOUNCE_MS);
    };
    document.addEventListener("load", onResourceLoad, true);

    try {
      this._startRrwebRecording();
    } catch (e) {
      document.removeEventListener("load", onResourceLoad, true);
      throw e;
    }

    this._recording = true;

    const onPageHide = () => {
      runAsynchronously(() => this._flush({ keepalive: true }));
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onPageHide);
    this._detachListeners = () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onPageHide);
      document.removeEventListener("load", onResourceLoad, true);
      if (this._resnapshotTimer !== null) {
        clearTimeout(this._resnapshotTimer);
        this._resnapshotTimer = null;
      }
    };
  }

  private _startRrwebRecording() {
    if (!this._rrwebModule) throwErr("_startRrwebRecording called before rrweb was imported — this should never happen");
    this._stopRecording = this._rrwebModule.record({
      emit: (event) => {
        const nowMs = Date.now();
        const stored = this._persistActivity(nowMs);

        // Detect session rotation: after 3+ minutes idle, getOrRotateSession
        // creates a new session ID. We need to inject a FullSnapshot so the
        // new server-side SessionReplay record is playable.
        if (this._lastBrowserSessionId === null) {
          this._lastBrowserSessionId = stored.session_id;
        } else if (stored.session_id !== this._lastBrowserSessionId && !this._takingSnapshot) {
          this._lastBrowserSessionId = stored.session_id;
          this._deps.onSessionRotation?.();
          this._needsFullSnapshot = true;
          this.captureFullSnapshotForCurrentSegment();
        }

        // While a rotated segment waits for its fresh FullSnapshot, drop
        // everything EXCEPT the FullSnapshot (type 2) and Meta (type 4):
        // rrweb's takeFullSnapshot emits a Meta event immediately before the
        // snapshot, and the replayer keeps its iframe hidden (display: none)
        // until it has seen a Meta to size it — a segment whose Meta was
        // dropped plays back as a blank white frame. Meta events are only ever
        // emitted as part of a snapshot, so letting them through cannot leak
        // pre-rotation activity into the new segment.
        if (this._needsFullSnapshot && event.type !== 2 && event.type !== 4) return;
        if (event.type === 2) this._needsFullSnapshot = false;

        // Measure UTF-8 byte length to match the server's byte limit (.length counts UTF-16 units, undercounting multibyte content).
        const eventSize = textEncoder.encode(JSON.stringify(event)).byteLength;
        this._events.push(event);
        this._eventSizes.push(eventSize);
        this._approxBytes += eventSize;
        if (this._events.length >= MAX_EVENTS_PER_BATCH || this._approxBytes >= MAX_APPROX_BYTES_PER_BATCH) {
          runAsynchronously(() => this._flush({ keepalive: false }));
        }
      },
      maskAllInputs: this._replayOptions.maskAllInputs ?? true,
      ...(this._replayOptions.blockClass !== undefined ? { blockClass: this._replayOptions.blockClass } : {}),
      blockSelector: getEffectiveSessionReplayBlockSelector(this._replayOptions.blockSelector),
    }) ?? null;
  }

  private _stopCurrentRecording() {
    if (this._detachListeners) {
      this._detachListeners();
      this._detachListeners = null;
    }
    if (this._stopRecording) {
      this._stopRecording();
      this._stopRecording = null;
    }
    this._events = [];
    this._eventSizes = [];
    this._approxBytes = 0;
    this._recording = false;
  }

  private _tick() {
    if (this._cancelled) return;
    if (this._events.length > 0) {
      runAsynchronously(() => this._flush({ keepalive: false }));
    }
  }
}
