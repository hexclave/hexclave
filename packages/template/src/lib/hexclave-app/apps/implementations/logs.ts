import { LOG_LEVELS, TELEMETRY_MAX_LOG_MESSAGE_BYTES, type LogLevel } from "@hexclave/shared/dist/utils/analytics-wire";
import { nicify } from "@hexclave/shared/dist/utils/strings";
import { computeErrorFingerprint, ERROR_TEXT_MAX_BYTES, normalizeCapturedError } from "./error-capture";
import { getCustomTelemetryDataError, truncateUtf8Bytes } from "./telemetry-core";

/**
 * Native logs (`app.logger`) are an ergonomic facade over OTel LogRecords.
 * This module owns input validation, console mirroring, redaction, and flood
 * control only; the injected environment sink emits through the active OTel
 * LoggerProvider, which owns context correlation, buffering, and delivery.
 */

/** One validated log call, ready to become an OTel LogRecord. */
export type LogEmitItem = {
  message: string,
  level: LogLevel,
  data: Record<string, unknown> | undefined,
  origin: "logger" | "console",
};

export type Logger = {
  [K in LogLevel]: (message: string, data?: Record<string, unknown>) => void
};

export type CreateLoggerDeps = {
  /**
   * Delivers one log item. Returns "unavailable" when this environment cannot
   * deliver logs at all (analytics disabled, unsupported environment) — the
   * logger then warns ONCE and keeps dropping silently; actual delivery
   * failures are handled (and pre-caught) inside the sink like every other
   * telemetry send.
   */
  emit: (item: LogEmitItem) => "ok" | "unavailable",
  /** Stamped on every emitted item — see LogEmitItem.origin. @default "logger" */
  origin?: "logger" | "console",
};

/**
 * Builds the `{ trace, debug, info, warn, error }` logger. Every method is
 * fire-and-forget and NEVER throws into user code: invalid structured data is
 * dropped with a warning (same validation as event data), non-string messages
 * are coerced, and unavailability warns once.
 */
export function createLogger(deps: CreateLoggerDeps): Logger {
  let warnedUnavailable = false;
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    const messageText = typeof message === "string" ? message : nicify(message, { maxDepth: 4 });
    const dataError = getCustomTelemetryDataError(data);
    if (dataError !== null) {
      console.warn(`Hexclave analytics: dropping ${level} log: ${dataError}`);
      return;
    }
    const result = deps.emit({
      message: truncateUtf8Bytes(messageText, TELEMETRY_MAX_LOG_MESSAGE_BYTES),
      level,
      data,
      origin: deps.origin ?? "logger",
    });
    if (result === "unavailable" && !warnedUnavailable) {
      warnedUnavailable = true;
      console.warn("Hexclave analytics: app.logger is unavailable in this environment (analytics disabled or unsupported); logs will be dropped");
    }
  };
  // SAFETY: Object.fromEntries types its result with plain string keys; the
  // entries are built from LOG_LEVELS, so every LogLevel method is present.
  return Object.fromEntries(LOG_LEVELS.map((level) => [level, (message: string, data?: Record<string, unknown>) => log(level, message, data)])) as Logger;
}


export type ConsoleCaptureLevel = "log" | "warn" | "error" | "info" | "debug";

const CONSOLE_LEVEL_LOG_LEVELS = new Map<ConsoleCaptureLevel, LogLevel>([
  ["log", "info"],
  ["info", "info"],
  ["debug", "debug"],
  ["warn", "warn"],
  ["error", "error"],
]);

const CONSOLE_CAPTURE_BUCKET_BURST = 100;
const CONSOLE_CAPTURE_BUCKET_REFILL_PER_SEC = 10;

type ConsoleCaptureSink = {
  levels: Set<ConsoleCaptureLevel>,
  logger: Logger,
  projectId: string,
  serviceName: string,
  captureError?: (error: Error) => void,
};

type ConsoleCaptureGlobalState = {
  sinksByIdentity: Map<string, ConsoleCaptureSink>,
  patched: Map<ConsoleCaptureLevel, { original: (...args: unknown[]) => void, patched: (...args: unknown[]) => void }>,
  suppressed: boolean,
  buckets: Map<ConsoleCaptureLevel, { tokens: number, lastRefillMs: number, warnedDry: boolean }>,
  warnedFailure: boolean,
};

const CONSOLE_CAPTURE_STATE_KEY = Symbol.for("hexclave.analytics.console-capture.v2");

function getConsoleCaptureState(): ConsoleCaptureGlobalState {
  // SAFETY: the symbol slot is owned exclusively by this module (only written
  // below), so a present value is a ConsoleCaptureGlobalState; the widened
  // view only declares that owned, possibly-absent slot.
  const holder = globalThis as { [CONSOLE_CAPTURE_STATE_KEY]?: ConsoleCaptureGlobalState };
  holder[CONSOLE_CAPTURE_STATE_KEY] ??= {
    sinksByIdentity: new Map(),
    patched: new Map(),
    suppressed: false,
    buckets: new Map(),
    warnedFailure: false,
  };
  return holder[CONSOLE_CAPTURE_STATE_KEY];
}

function getActiveConsoleCaptureSink(state: ConsoleCaptureGlobalState): ConsoleCaptureSink | null {
  if (state.sinksByIdentity.size !== 1) return null;
  return state.sinksByIdentity.values().next().value ?? null;
}

const SENSITIVE_KEY_RE = /authorization|cookie|passw|secret|token|api[-_]?key|session[-_]?id|private[-_]?key/i;
const REDACTION_MAX_DEPTH = 4;

function redactSensitiveKeys(value: unknown, depth: number): unknown {
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveKeys(item, depth - 1));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
    key,
    SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redactSensitiveKeys(entryValue, depth - 1),
  ]));
}

function serializeConsoleArgs(args: unknown[]): string {
  return args.map((arg) => typeof arg === "string" ? arg : nicify(redactSensitiveKeys(arg, REDACTION_MAX_DEPTH), { maxDepth: 4 })).join(" ");
}

function takeConsoleCaptureToken(state: ConsoleCaptureGlobalState, level: ConsoleCaptureLevel): "ok" | "dry" | "newly-dry" {
  let bucket = state.buckets.get(level);
  const nowMs = performance.now();
  if (bucket === undefined) {
    bucket = { tokens: CONSOLE_CAPTURE_BUCKET_BURST, lastRefillMs: nowMs, warnedDry: false };
    state.buckets.set(level, bucket);
  }
  bucket.tokens = Math.min(
    CONSOLE_CAPTURE_BUCKET_BURST,
    bucket.tokens + ((nowMs - bucket.lastRefillMs) / 1000) * CONSOLE_CAPTURE_BUCKET_REFILL_PER_SEC,
  );
  bucket.lastRefillMs = nowMs;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    bucket.warnedDry = false;
    return "ok";
  }
  if (bucket.warnedDry) return "dry";
  bucket.warnedDry = true;
  return "newly-dry";
}

/**
 * Patches the requested console methods to MIRROR calls into `logger` as
 * `$log` events. The original method always runs FIRST (and unconditionally —
 * capture must never eat or delay the developer's own console output);
 * re-entrancy is guarded so the logger's/serializer's own console use cannot
 * loop; messages starting with "Hexclave" (the SDK's own warns) are skipped so
 * telemetry warnings never report themselves; and a per-level token bucket
 * bounds runaway logging loops.
 *
 * Returns the uninstaller. Uninstall restores a method only when it is still
 * OUR patch (someone else patched on top otherwise), and always detaches the
 * sink.
 */
export function installConsoleCapture(opts: {
  levels: readonly ConsoleCaptureLevel[],
  logger: Logger,
  projectId: string,
  serviceName: string,
  captureError?: (error: Error) => void,
}): () => void {
  const state = getConsoleCaptureState();
  const levels = new Set(opts.levels);
  const sink: ConsoleCaptureSink = {
    levels,
    logger: opts.logger,
    projectId: opts.projectId,
    serviceName: opts.serviceName,
    captureError: opts.captureError,
  };
  const identity = `${opts.projectId}\u0000${opts.serviceName}`;
  const conflictingIdentities = [...state.sinksByIdentity.keys()].filter((registeredIdentity) => registeredIdentity !== identity);
  if (conflictingIdentities.length > 0) {
    console.warn("Hexclave analytics: automatic console capture is disabled because multiple telemetry services share this runtime; use each app's explicit logger or configure console capture on only one service");
  }
  state.sinksByIdentity.set(identity, sink);
  state.buckets.clear();

  for (const level of levels) {
    if (state.patched.has(level)) continue;
    const original = console[level].bind(console);
    const patched = (...args: unknown[]): void => {
      original(...args);
      const currentSink = getActiveConsoleCaptureSink(state);
      if (currentSink === null || !currentSink.levels.has(level) || state.suppressed) return;
      const first = args[0];
      if (typeof first === "string" && first.startsWith("Hexclave")) return;
      state.suppressed = true;
      try {
        const logLevel = CONSOLE_LEVEL_LOG_LEVELS.get(level);
        if (logLevel === undefined) return;
        const token = takeConsoleCaptureToken(state, level);
        if (token === "dry") return;
        if (token === "newly-dry") {
          currentSink.logger.warn(`Hexclave console capture is dropping console.${level} calls (rate limit: burst ${CONSOLE_CAPTURE_BUCKET_BURST}, ${CONSOLE_CAPTURE_BUCKET_REFILL_PER_SEC}/s)`, { console_level: level, rate_limited: true });
          return;
        }
        const errorArg = args.find((arg): arg is Error => arg instanceof Error);
        let errorExtras: { error_name: string, error_fingerprint: string } | undefined;
        if (errorArg !== undefined) {
          const normalized = normalizeCapturedError(errorArg);
          const errorMessage = truncateUtf8Bytes(normalized.message, ERROR_TEXT_MAX_BYTES);
          const errorStack = normalized.stack !== null ? truncateUtf8Bytes(normalized.stack, ERROR_TEXT_MAX_BYTES) : null;
          errorExtras = {
            error_name: normalized.name,
            error_fingerprint: computeErrorFingerprint(normalized.name, errorMessage, errorStack),
          };
        }
        currentSink.logger[logLevel](serializeConsoleArgs(args), { console_level: level, ...errorExtras });
        if (level === "error" && errorArg !== undefined) {
          currentSink.captureError?.(errorArg);
        }
      } catch (error) {
        if (!state.warnedFailure) {
          state.warnedFailure = true;
          console.warn("Hexclave analytics: console capture failed:", error);
        }
      } finally {
        state.suppressed = false;
      }
    };
    state.patched.set(level, { original, patched });
    console[level] = patched;
  }

  return () => {
    if (state.sinksByIdentity.get(identity) !== sink) return;
    state.sinksByIdentity.delete(identity);
    for (const [level, entry] of state.patched) {
      const levelStillUsed = [...state.sinksByIdentity.values()].some((registeredSink) => registeredSink.levels.has(level));
      if (levelStillUsed) continue;
      if (console[level] === entry.patched) {
        console[level] = entry.original;
        state.patched.delete(level);
      }
    }
  };
}
