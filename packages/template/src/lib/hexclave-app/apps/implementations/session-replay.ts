import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { isBrowserLike } from "@hexclave/shared/dist/utils/env";
import { captureWarning, throwErr } from "@hexclave/shared/dist/utils/errors";
import { parseJson, type JsonObject } from "@hexclave/shared/dist/utils/json";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";

export type AnalyticsReplayOptions = {
  /**
   * Whether session replays are enabled.
   *
   * @default true
   */
  enabled?: boolean,
  /**
   * Whether to mask the content of all `<input>` elements.
   *
   * @default true
   */
  maskAllInputs?: boolean,
  /**
   * A CSS class name or RegExp. Elements with a matching class will be blocked
   * (replaced with a placeholder in the recording).
   *
   * @default undefined
   */
  blockClass?: string | RegExp,
  /**
   * A CSS selector string. Elements matching this selector will be blocked
   * (replaced with a placeholder in the recording).
   *
   * @default undefined
   */
  blockSelector?: string,
};

export type AnalyticsOptions = {
  /**
   * Whether SDK-managed analytics capture is enabled.
   *
   * @default true
   */
  enabled?: boolean,
  /**
   * Options for session replay recording. Replays are enabled by default;
   * set `enabled: false` to opt out.
   */
  replays?: AnalyticsReplayOptions,
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedRegexp(value: unknown): value is { __regexp: string, __flags: string } {
  if (!isJsonObject(value)) return false;
  return typeof value.__regexp === "string" && typeof value.__flags === "string";
}

export function getSessionReplayOptions(analyticsOptions: AnalyticsOptions | undefined): AnalyticsReplayOptions {
  return {
    ...analyticsOptions?.replays,
    enabled: analyticsOptions?.replays?.enabled ?? true,
  };
}

/**
 * Converts AnalyticsOptions to a JSON-safe representation.
 * RegExp blockClass values are serialized as `{ __regexp, __flags }` objects.
 * The return type is AnalyticsOptions to keep StackClientAppJson simple;
 * the actual runtime value is JSON-safe.
 */
export function analyticsOptionsToJson(options: AnalyticsOptions | undefined): AnalyticsOptions | undefined {
  if (!options?.replays?.blockClass) return options;
  const { blockClass, ...rest } = options.replays;
  if (!(blockClass instanceof RegExp)) return options;
  return {
    ...options,
    replays: {
      ...rest,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      blockClass: { __regexp: blockClass.source, __flags: blockClass.flags } as any,
    },
  };
}

/**
 * Reconstructs AnalyticsOptions from a JSON-deserialized value.
 * Converts `{ __regexp, __flags }` objects back to RegExp instances.
 */
export function analyticsOptionsFromJson(json: AnalyticsOptions | undefined): AnalyticsOptions | undefined {
  if (!json?.replays?.blockClass) return json;
  const { blockClass, ...rest } = json.replays;
  if (isSerializedRegexp(blockClass)) {
    return {
      ...json,
      replays: {
        ...rest,
        blockClass: new RegExp(blockClass.__regexp, blockClass.__flags),
      },
    };
  }
  return json;
}

// ---------- Recording internals ----------

// Hexclave rebrand: canonical localStorage prefix (colon delimiters preserved).
const LOCAL_STORAGE_PREFIX = "hexclave:session-replay:v1";
// Hexclave rebrand: legacy prefix — dual-read only, so a recording session active
// across an SDK upgrade is not orphaned. Never written.
const LEGACY_LOCAL_STORAGE_PREFIX = "stack:session-replay:v1";
const IDLE_TTL_MS = 3 * 60 * 1000;

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

export type StoredSession = {
  session_id: string,
  created_at_ms: number,
  last_activity_ms: number,
};

export function safeParseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  const parsed = parseJson(raw);
  if (parsed.status === "error" || !isJsonObject(parsed.data)) return null;
  const sessionId = parsed.data.session_id;
  const createdAtMs = parsed.data.created_at_ms;
  const lastActivityMs = parsed.data.last_activity_ms;
  if (typeof sessionId !== "string" || typeof createdAtMs !== "number" || typeof lastActivityMs !== "number") return null;
  return { session_id: sessionId, created_at_ms: createdAtMs, last_activity_ms: lastActivityMs };
}

export function makeStorageKey(projectId: string) {
  return `${LOCAL_STORAGE_PREFIX}:${projectId}`;
}

// Hexclave rebrand: legacy key, dual-read only (never written).
export function makeLegacyStorageKey(projectId: string) {
  return `${LEGACY_LOCAL_STORAGE_PREFIX}:${projectId}`;
}

export function generateUuid() {
  return crypto.randomUUID();
}

export function getOrRotateSession(options: { key: string, legacyKey?: string, nowMs: number }): StoredSession {
  // Hexclave rebrand: prefer the new key; fall back to the legacy key so a
  // recording session active across an SDK upgrade is not orphaned.
  const existing = safeParseStoredSession(localStorage.getItem(options.key))
    ?? (options.legacyKey ? safeParseStoredSession(localStorage.getItem(options.legacyKey)) : null);
  if (existing && options.nowMs - existing.last_activity_ms <= IDLE_TTL_MS) {
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
  sendBatch: (body: string, options: { keepalive: boolean }) => Promise<Result<Response, Error>>,
};

export function isAnalyticsNotEnabledError(error: unknown): boolean {
  return KnownErrors.AnalyticsNotEnabled.isInstance(error);
}

/**
 * Whether the error looks like a network failure caused by an ad blocker or
 * similar extension blocking analytics requests. These are expected in
 * production and should be silently ignored rather than logged as warnings.
 */
export function isAdBlockerNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("Failed to fetch")
      || error.message.includes("NetworkError")
      || error.message.includes("Load failed")
      || error.message.includes("network connection");
  }
  return false;
}

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
  private _rrwebModule: typeof import("rrweb") | null = null;
  private _lastBrowserSessionId: string | null = null;
  private _takingSnapshot = false;
  private _flushInProgress = false;
  private readonly _sessionReplaySegmentId: string;
  private readonly _storageKey: string;
  // Hexclave rebrand: legacy key used for dual-read fallback only.
  private readonly _legacyStorageKey: string;
  private readonly _deps: SessionRecorderDeps;
  private readonly _replayOptions: AnalyticsReplayOptions;

  constructor(deps: SessionRecorderDeps, replayOptions: AnalyticsReplayOptions) {
    this._deps = deps;
    this._replayOptions = replayOptions;
    this._sessionReplaySegmentId = generateUuid();
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
        offset = batchEnd;

        const batchId = generateUuid();
        const payload = {
          browser_session_id: stored.session_id,
          session_replay_segment_id: this._sessionReplaySegmentId,
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
      }
    } finally {
      this._flushInProgress = false;
    }
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
      const rrwebImport = await Result.fromPromise(import("rrweb"));
      if (rrwebImport.status === "error") {
        console.warn("SessionRecorder: rrweb import failed. Is rrweb installed?", rrwebImport.error);
        return;
      }
      this._rrwebModule = rrwebImport.data;
    }

    // cancelled may change during the await above
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this._cancelled) return;

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
          // Inject a FullSnapshot for the new session (calls emit synchronously)
          this._takingSnapshot = true;
          try {
            this._rrwebModule!.record.takeFullSnapshot();
          } finally {
            this._takingSnapshot = false;
          }
        }

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
      ...(this._replayOptions.blockSelector !== undefined ? { blockSelector: this._replayOptions.blockSelector } : {}),
    }) ?? null;

    this._recording = true;

    const onPageHide = () => {
      runAsynchronously(() => this._flush({ keepalive: true }));
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onPageHide);
    this._detachListeners = () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onPageHide);
    };
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
