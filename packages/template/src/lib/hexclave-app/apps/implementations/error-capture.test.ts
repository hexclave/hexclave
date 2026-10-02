// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCapturedEventData,
  buildErrorEventData,
  buildLinkedExceptionValues,
  computeErrorFingerprint,
  createClientErrorCapturePolicy,
  DEFAULT_IGNORE_ERRORS,
  ERROR_EXCEPTION_VALUES_MAX_BYTES,
  generateErrorEventId,
  installClientErrorCapture,
  installServerErrorMonitor,
  normalizeCapturedError,
  normalizeErrorCaptureOptions,
  type ClientErrorCaptureDeps,
} from "./error-capture";
import { createErrorScope, runWithErrorScope } from "./error-scope";

function installWithDeps(overrides?: Partial<ClientErrorCaptureDeps>) {
  const emitted: Record<string, unknown>[] = [];
  const capture = installClientErrorCapture({
    emit: (data) => emitted.push(data),
    ignoreErrors: normalizeErrorCaptureOptions(undefined).ignoreErrors,
    release: "1.2.3",
    environment: "test",
    sdkVersion: "0.0.0-test",
    getCurrentPageViewSpanId: () => null,
    ...overrides,
  });
  if (capture === null) throw new Error("capture should install in jsdom");
  return { emitted, capture };
}

function fireOnError(error: Error, opts?: { url?: string, line?: number, col?: number }) {
  const handler = window.onerror;
  if (typeof handler !== "function") throw new Error("onerror not installed");
  return handler.call(window, error.message, opts?.url ?? "https://app.example.com/bundle.js", opts?.line ?? 10, opts?.col ?? 5, error);
}

function fireOnUnhandledRejection(event: unknown) {
  const handler = window.onunhandledrejection;
  if (typeof handler !== "function") throw new Error("onunhandledrejection not installed");
  return handler.call(window, event as PromiseRejectionEvent);
}

describe("normalizeErrorCaptureOptions", () => {
  it("defaults to enabled with the default ignores, merging user substrings", () => {
    expect(normalizeErrorCaptureOptions(undefined)).toMatchObject({ enabled: true, ignoreErrors: [...DEFAULT_IGNORE_ERRORS] });
    const normalized = normalizeErrorCaptureOptions({ enabled: false, ignoreErrors: ["ChunkLoadError"] });
    expect(normalized.enabled).toBe(false);
    expect(normalized.ignoreErrors).toEqual([...DEFAULT_IGNORE_ERRORS, "ChunkLoadError"]);
  });
});

describe("normalizeCapturedError + buildErrorEventData", () => {
  it("generates lowercase dashless 32-character event IDs", () => {
    const first = generateErrorEventId();
    const second = generateErrorEventId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it("keeps Error identity and bounds message/stack to 8KB", () => {
    const error = new Error(`boom ${"x".repeat(20_000)}`);
    const data = buildErrorEventData(error, {
      mechanismType: "captured",
      handled: true,
      release: "r1",
      environment: "prod",
      sdkVersion: "9.9.9",
    });
    expect(data.name).toBe("Error");
    expect((data.message as string).length).toBeLessThanOrEqual(8_192);
    expect((data.message as string).startsWith("boom ")).toBe(true);
    expect(data.mechanism_type).toBe("captured");
    expect(data.handled).toBe(true);
    expect(data.synthetic).toBeUndefined();
    expect(typeof data.fingerprint).toBe("string");
    expect(data.release).toBe("r1");
    expect(data.environment).toBe("prod");
    expect(data.sdk_version).toBe("9.9.9");
  });

  it("describes plain objects by their keys and synthesizes a capture-time stack", () => {
    const normalized = normalizeCapturedError({ b: 2, a: 1 });
    expect(normalized.message).toBe("Object captured as exception with keys: a, b");
    expect(normalized.synthetic).toBe(true);
    expect(typeof normalized.stack).toBe("string");
  });

  it("stringifies primitives as synthetic and stackless", () => {
    expect(normalizeCapturedError("oops")).toEqual({ name: "Error", message: "oops", stack: null, synthetic: true });
    expect(normalizeCapturedError(null).synthetic).toBe(true);
  });

  it("fingerprints on name + message + first stack frame only", () => {
    const stackA = "Error: x\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)";
    const stackB = "Error: x\n    at foo (a.js:1:1)\n    at OTHER (c.js:9:9)";
    expect(computeErrorFingerprint("Error", "x", stackA)).toBe(computeErrorFingerprint("Error", "x", stackB));
    expect(computeErrorFingerprint("Error", "x", stackA)).not.toBe(computeErrorFingerprint("Error", "y", stackA));
  });

  it("keeps Error.cause and AggregateError children in one bounded, root-last chain", () => {
    const cause = new Error("database cause");
    const root = new Error("request failed");
    Object.defineProperty(root, "cause", { value: cause, enumerable: false });
    const values = buildLinkedExceptionValues(root);
    expect(values.map((value) => value.value)).toEqual(["database cause", "request failed"]);
    expect(values[0]?.mechanism).toMatchObject({ type: "chained", data: { source: "cause" } });

    const first = new Error("first child");
    const second = new Error("second child");
    const aggregate = new Error("many failures");
    Object.defineProperty(aggregate, "errors", { value: [first, second], enumerable: false });
    const aggregateValues = buildLinkedExceptionValues(aggregate);
    expect(aggregateValues.map((value) => value.value)).toEqual(["first child", "second child", "many failures"]);

    const data = buildErrorEventData(root, {
      mechanismType: "captured.exception",
      handled: true,
      release: null,
      environment: null,
      sdkVersion: "test",
    });
    expect(data.exception?.values).toHaveLength(2);
    expect(data.exception?.values.at(-1)?.mechanism).toMatchObject({ type: "captured.exception", handled: true });
  });

  it("trims a deep cause chain to the aggregate exception byte budget, keeping the root last", () => {
    const root = new Error(`root ${"r".repeat(7_000)}`);
    root.stack = `Error: root\n    at f (https://app.example.com/a.js:1:1)\n${"x".repeat(7_000)}`;
    let current = root;
    for (let i = 0; i < 9; i++) {
      const cause = new Error(`cause ${i} ${"c".repeat(7_000)}`);
      cause.stack = `Error: cause ${i}\n    at g (https://app.example.com/b.js:2:2)\n${"y".repeat(7_000)}`;
      Object.defineProperty(current, "cause", { value: cause, enumerable: false });
      current = cause;
    }
    const data = buildErrorEventData(root, {
      mechanismType: "captured.exception",
      handled: true,
      release: null,
      environment: null,
      sdkVersion: "test",
      getDebugImages: () => [],
    });
    const values = data.exception?.values ?? [];
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThan(10);
    expect(values.at(-1)?.value?.startsWith("root ")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(values)).length).toBeLessThanOrEqual(ERROR_EXCEPTION_VALUES_MAX_BYTES);
  });

  it("bounds adapter-supplied captureEvent exception values like every other path", () => {
    const data = buildCapturedEventData({
      handled: true,
      exception: {
        values: [{
          type: "AdapterError",
          value: `boom ${"v".repeat(20_000)}`,
          stacktrace: { raw: `Error: boom\n    at f (https://app.example.com/a.js:1:1)\n${"s".repeat(20_000)}` },
        }],
      },
    }, {
      eventId: generateErrorEventId(),
      release: null,
      environment: null,
      sdkVersion: "test",
    });
    const value = data.exception?.values.at(-1);
    expect(new TextEncoder().encode(value?.value ?? "").length).toBeLessThanOrEqual(8_192);
    expect(new TextEncoder().encode(value?.stacktrace?.raw ?? "").length).toBeLessThanOrEqual(8_192);
    expect(typeof data.stack).toBe("string");
    expect((data.stack as string).startsWith("Error: boom")).toBe(true);
    expect(new TextEncoder().encode(data.stack as string).length).toBeLessThanOrEqual(8_192);
  });

  it("persists captureEvent frames with the envelope/Sentry snake_case keys", () => {
    const data = buildCapturedEventData({
      handled: true,
      exception: {
        values: [{
          type: "Error",
          value: "adapter",
          stacktrace: {
            frames: [{
              filename: "src/pay.ts",
              abs_path: "https://app.example.com/src/pay.ts",
              function: "charge",
              lineno: 12,
              colno: 3,
              in_app: true,
              context_line: "throw new Error(\"adapter\");",
            }],
          },
        }],
      },
    }, {
      eventId: generateErrorEventId(),
      release: null,
      environment: null,
      sdkVersion: "test",
    });
    expect(data.exception?.values[0]?.stacktrace?.frames).toEqual([{
      filename: "src/pay.ts",
      abs_path: "https://app.example.com/src/pay.ts",
      function: "charge",
      lineno: 12,
      colno: 3,
      in_app: true,
      context_line: "throw new Error(\"adapter\");",
    }]);
    expect(data.stack).toBe("    at charge (https://app.example.com/src/pay.ts:12:3)");
  });

  it("uses exception stacktrace.raw as the top-level stack when no stack or frames are supplied", () => {
    const raw = "Error: adapter\n    at f (https://app.example.com/a.js:1:1)";
    const data = buildCapturedEventData({
      handled: true,
      exception: { values: [{ type: "Error", value: "adapter", stacktrace: { raw } }] },
    }, {
      eventId: generateErrorEventId(),
      release: null,
      environment: null,
      sdkVersion: "test",
    });
    expect(data.stack).toBe(raw);
  });

  it("rejects captureEvent input that omits handled instead of inventing true", () => {
    expect(() => buildCapturedEventData({
      message: "captured",
    }, {
      eventId: generateErrorEventId(),
      release: null,
      environment: null,
      sdkVersion: "test",
    })).toThrow(/boolean handled field/);
  });
});

describe("createClientErrorCapturePolicy", () => {
  function makePolicy(overrides?: { ignoreErrors?: readonly string[], getCurrentPageViewSpanId?: () => string | null }) {
    return createClientErrorCapturePolicy({
      ignoreErrors: overrides?.ignoreErrors ?? normalizeErrorCaptureOptions(undefined).ignoreErrors,
      getCurrentPageViewSpanId: overrides?.getCurrentPageViewSpanId ?? (() => null),
    });
  }

  it("admits an error once and rejects the same OBJECT afterwards (captured marker)", () => {
    const policy = makePolicy();
    const error = new Error("only once");
    expect(policy.admit(error)).not.toBeNull();
    expect(policy.admit(error)).toBeNull();
  });

  it("drops identical back-to-back signatures but keeps alternating errors", () => {
    const policy = makePolicy();
    const stack = "Error: same\n    at f (https://app.example.com/a.js:1:1)";
    const first = new Error("same");
    first.stack = stack;
    const duplicate = new Error("same");
    duplicate.stack = stack;
    const other = new Error("different");
    expect(policy.admit(first)).not.toBeNull();
    expect(policy.admit(duplicate)).toBeNull();
    expect(policy.admit(other)).not.toBeNull();
  });

  it("drops messages matching the ignore substrings", () => {
    const policy = makePolicy();
    expect(policy.admit(new Error("ResizeObserver loop completed with undelivered notifications"))).toBeNull();
  });

  it("caps admissions per fingerprint and resets on page-view rollover", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let pageViewSpanId: string | null = "page-1";
    const policy = makePolicy({ getCurrentPageViewSpanId: () => pageViewSpanId });
    let floodIndex = 0;
    const admitFlood = () => {
      const error = new Error("flood");
      floodIndex += 1;
      error.stack = `Error: flood\n    at f (https://app.example.com/a.js:1:1)\n    at g (https://app.example.com/b.js:${floodIndex}:1)`;
      return policy.admit(error);
    };
    let admitted = 0;
    for (let i = 0; i < 15; i++) {
      if (admitFlood() !== null) admitted += 1;
    }
    expect(admitted).toBe(10);
    pageViewSpanId = "page-2";
    expect(admitFlood()).not.toBeNull();
    vi.restoreAllMocks();
  });
});

describe("installClientErrorCapture", () => {
  afterEach(() => {
    window.onerror = null;
    window.onunhandledrejection = null;
    vi.restoreAllMocks();
  });

  it("patches the property slots, chains the previous handler, and forwards its return value", () => {
    const previous = vi.fn((..._args: unknown[]) => true);
    window.onerror = previous;
    const { emitted, capture } = installWithDeps();

    const error = new Error("boom");
    const returned = fireOnError(error);

    expect(returned).toBe(true);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous.mock.calls[0][4]).toBe(error);
    expect(emitted).toHaveLength(1);

    capture.uninstall();
    expect(window.onerror).toBe(previous);
  });

  it("raises Error.stackTraceLimit at install and restores it on uninstall", () => {
    const errorCtor = Error as ErrorConstructor & { stackTraceLimit?: number };
    const before = errorCtor.stackTraceLimit;
    if (typeof before !== "number") return;
    const { capture } = installWithDeps();
    expect(errorCtor.stackTraceLimit).toBe(50);
    capture.uninstall();
    expect(errorCtor.stackTraceLimit).toBe(before);
  });

  it("captures onerror payloads with location fields, url/path, and release metadata", () => {
    window.history.replaceState(null, "", "/oauth/callback?code=secret-code#fragment");
    const { emitted, capture } = installWithDeps();
    fireOnError(new Error("boom"), { url: "https://app.example.com/x.js", line: 3, col: 7 });

    expect(emitted).toHaveLength(1);
    const data = emitted[0];
    expect(data.message).toBe("boom");
    expect(data.name).toBe("Error");
    expect(typeof data.stack).toBe("string");
    expect(data.mechanism_type).toBe("global.onerror");
    expect(data.handled).toBe(false);
    expect(data.filename).toBe("https://app.example.com/x.js");
    expect(data.lineno).toBe(3);
    expect(data.colno).toBe(7);
    expect(data.url).toBe(`${window.location.origin}/oauth/callback`);
    expect(data.url).not.toContain("secret-code");
    expect(data.path).toBe(window.location.pathname);
    expect(data.release).toBe("1.2.3");
    expect(data.environment).toBe("test");
    expect(data.sdk_version).toBe("0.0.0-test");
    capture.uninstall();
    window.history.replaceState(null, "", "/");
  });

  it("applies the active scope to automatic browser captures", () => {
    const { emitted, capture } = installWithDeps();
    const scope = createErrorScope();
    scope.setUser({ id: "automatic-user" });
    scope.setTag("surface", "global-handler");
    runWithErrorScope(scope, () => fireOnError(new Error("scoped automatic error")));

    expect(emitted[0]).toMatchObject({
      event_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      user: { id: "automatic-user" },
      tags: { surface: "global-handler" },
    });
    capture.uninstall();
  });

  it("synthesizes a single url:line:col frame when onerror has no error object", () => {
    const { emitted, capture } = installWithDeps();
    const handler = window.onerror;
    if (typeof handler !== "function") throw new Error("onerror not installed");
    handler.call(window, "Uncaught Error: weird", "https://app.example.com/legacy.js", 42, 8, undefined);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].message).toBe("Uncaught Error: weird");
    expect(emitted[0].stack).toContain("at ? (https://app.example.com/legacy.js:42:8)");
    expect(emitted[0].synthetic).toBe(1);
    capture.uninstall();
  });

  it("extracts rejection reasons 3-way: .reason, .detail.reason, and primitive events", () => {
    const { emitted, capture } = installWithDeps();

    const reasonError = new Error("from reason");
    fireOnUnhandledRejection({ reason: reasonError });
    expect(emitted[0].message).toBe("from reason");
    expect(emitted[0].mechanism_type).toBe("global.unhandledrejection");

    const detailError = new Error("from detail");
    fireOnUnhandledRejection({ detail: { reason: detailError } });
    expect(emitted[1].message).toBe("from detail");

    fireOnUnhandledRejection(42);
    expect(emitted[2].message).toBe("Non-Error promise rejection captured with value: 42");
    expect(emitted[2].synthetic).toBe(1);
    capture.uninstall();
  });

  it("describes plain-object rejections by their keys", () => {
    const { emitted, capture } = installWithDeps();
    fireOnUnhandledRejection({ reason: { code: 500, details: "x" } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].message).toBe("Object captured as exception with keys: code, details");
    expect(emitted[0].synthetic).toBe(1);
    capture.uninstall();
  });

  it("shares an injected policy so a pre-admitted error (console promotion) is not double-captured", () => {
    const policy = createClientErrorCapturePolicy({ ignoreErrors: [], getCurrentPageViewSpanId: () => null });
    const { emitted, capture } = installWithDeps({ policy });
    const error = new Error("promoted via console.error first");
    expect(policy.admit(error)).not.toBeNull();
    fireOnError(error);
    expect(emitted).toHaveLength(0);
    capture.uninstall();
  });

  it("drops messages matching the default ignores (cross-origin noise)", () => {
    const { emitted, capture } = installWithDeps();
    fireOnError(new Error("Script error."));
    fireOnError(new Error("ResizeObserver loop completed with undelivered notifications."));
    expect(emitted).toHaveLength(0);
    capture.uninstall();
  });

  it("never captures the same error OBJECT twice (marker), even across both hooks", () => {
    const { emitted, capture } = installWithDeps();
    const error = new Error("boom once");
    fireOnError(error);
    fireOnUnhandledRejection({ reason: error });
    expect(emitted).toHaveLength(1);
    capture.uninstall();
  });

  it("drops an identical back-to-back signature (single-slot dedupe) but keeps alternating errors", () => {
    const { emitted, capture } = installWithDeps();
    const a1 = new Error("same");
    const a2 = new Error("same");
    a2.stack = a1.stack;
    fireOnError(a1);
    fireOnError(a2);
    expect(emitted).toHaveLength(1);
    fireOnError(new Error("other"));
    const a3 = new Error("same");
    a3.stack = a1.stack;
    fireOnError(a3);
    expect(emitted).toHaveLength(3);
    capture.uninstall();
  });

  it("caps captures per fingerprint per page view and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let pageViewSpanId: string | null = "11111111-1111-4111-8111-111111111111";
    const { emitted, capture } = installWithDeps({ getCurrentPageViewSpanId: () => pageViewSpanId });

    const stack = "Error: looped\n    at loop (a.js:1:1)";
    const otherStack = "Error: breaker\n    at other (b.js:2:2)";
    for (let i = 0; i < 15; i++) {
      const error = new Error("looped");
      error.stack = stack;
      fireOnError(error);
      const breaker = new Error("breaker");
      breaker.stack = otherStack;
      fireOnError(breaker);
    }
    const loopedCount = emitted.filter((data) => data.message === "looped").length;
    const breakerCount = emitted.filter((data) => data.message === "breaker").length;
    expect(loopedCount).toBe(10);
    expect(breakerCount).toBe(10);
    expect(warnSpy.mock.calls.filter(([message]) => typeof message === "string" && message.includes("rate cap")).length).toBe(1);

    pageViewSpanId = "22222222-2222-4222-8222-222222222222";
    const fresh = new Error("looped");
    fresh.stack = stack;
    fireOnError(fresh);
    expect(emitted.filter((data) => data.message === "looped").length).toBe(11);
    capture.uninstall();
  });

  it("caps total captures per page view", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitted, capture } = installWithDeps();
    for (let i = 0; i < 120; i++) {
      fireOnError(new Error(`unique ${i}`));
    }
    expect(emitted).toHaveLength(100);
    expect(warnSpy).toHaveBeenCalled();
    capture.uninstall();
  });

  it("warns once and never recurses when the emit sink itself throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const capture = installClientErrorCapture({
      emit: () => {
        throw new Error("sink exploded");
      },
      ignoreErrors: [],
      release: null,
      environment: null,
      sdkVersion: "0.0.0-test",
      getCurrentPageViewSpanId: () => null,
    });
    if (capture === null) throw new Error("capture should install in jsdom");
    fireOnError(new Error("boom 1"));
    fireOnError(new Error("boom 2"));
    expect(warnSpy.mock.calls.filter(([message]) => typeof message === "string" && message.includes("error capture failed")).length).toBe(1);
    capture.uninstall();
  });
});

describe("installServerErrorMonitor", () => {
  it("registers an uncaughtExceptionMonitor listener with replace semantics per project", () => {
    const baseline = process.listenerCount("uncaughtExceptionMonitor");
    const captured: unknown[] = [];
    const uninstall1 = installServerErrorMonitor({ projectId: "p1", capture: (error) => captured.push(error) });
    expect(uninstall1).not.toBeNull();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline + 1);

    const uninstall2 = installServerErrorMonitor({ projectId: "p1", capture: (error) => captured.push(error) });
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline + 1);

    const error = new Error("server crash");
    process.emit("uncaughtExceptionMonitor", error);
    expect(captured).toEqual([error]);

    uninstall2?.();
    uninstall1?.();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(baseline);
  });

  it("warns instead of throwing when capture fails mid-crash", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const uninstall = installServerErrorMonitor({
      projectId: "p2",
      capture: () => {
        throw new Error("reporting failed");
      },
    });
    expect(() => process.emit("uncaughtExceptionMonitor", new Error("crash"))).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    uninstall?.();
    warnSpy.mockRestore();
  });
});
