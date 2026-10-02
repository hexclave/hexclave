// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { computeErrorFingerprint } from "./error-capture";
import { createLogger, installConsoleCapture, type LogEmitItem } from "./logs";


describe("createLogger", () => {
  it("stamps the level verbatim, defaults origin to 'logger', and passes structured data through", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });

    logger.trace("t");
    logger.debug("d");
    logger.info("i", { a: 1 });
    logger.warn("w");
    logger.error("e");

    expect(emitted.map((item) => item.level)).toEqual(["trace", "debug", "info", "warn", "error"]);
    expect(emitted.every((item) => item.origin === "logger")).toBe(true);
    expect(emitted[2].message).toBe("i");
    expect(emitted[2].data).toEqual({ a: 1 });
  });

  it("stamps origin 'console' when constructed for the console mirror", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
      origin: "console",
    });
    logger.warn("mirrored");
    expect(emitted[0].origin).toBe("console");
  });

  it("truncates the message to the 8KB wire cap without splitting code points", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });
    logger.info("é".repeat(10_000));
    expect(new TextEncoder().encode(emitted[0].message).length).toBeLessThanOrEqual(8_192);
    expect(emitted[0].message.endsWith("é")).toBe(true);
  });

  it("drops logs with invalid structured data (warn, no emit) and never throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.warn("bad", circular)).not.toThrow();
    expect(emitted).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropping warn log"));
    warnSpy.mockRestore();
  });

  it("coerces non-string messages instead of dropping them", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });
    logger.info({ oops: true } as unknown as string);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].message).toContain("oops");
  });

  it("warns exactly once when the environment has no delivery path", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger({ emit: () => "unavailable" });
    logger.info("one");
    logger.info("two");
    expect(warnSpy.mock.calls.filter(([message]) => typeof message === "string" && message.includes("unavailable")).length).toBe(1);
    warnSpy.mockRestore();
  });
});

describe("installConsoleCapture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the original first, mirrors into the logger with console_level, and uninstalls cleanly", () => {
    const calls: { level: string, message: string, data?: Record<string, unknown> }[] = [];
    const logger = createLogger({
      emit: (item) => {
        calls.push({ level: item.level, message: item.message, data: item.data });
        return "ok";
      },
    });
    const originalWarn = console.warn;
    const originalSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const uninstall = installConsoleCapture({ levels: ["warn"], logger, projectId: "internal", serviceName: "dashboard" });

    console.warn("plain", { user: "u1" });
    expect(originalSpy).toHaveBeenCalledWith("plain", { user: "u1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warn");
    expect(calls[0].message).toContain("plain");
    expect(calls[0].message).toContain("u1");
    expect(calls[0].data).toEqual({ console_level: "warn" });

    uninstall();
    console.warn("after uninstall");
    expect(calls).toHaveLength(1);
    originalSpy.mockRestore();
    expect(console.warn).toBe(originalWarn);
  });

  it("skips the SDK's own Hexclave-prefixed warnings (no self-reporting loops)", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });
    const originalSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const uninstall = installConsoleCapture({ levels: ["warn"], logger, projectId: "internal", serviceName: "dashboard" });

    console.warn("Hexclave analytics: something internal");
    expect(originalSpy).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(0);

    uninstall();
    originalSpy.mockRestore();
  });

  it("guards re-entrancy: a logger sink that logs to console cannot loop", () => {
    let emits = 0;
    const logger = createLogger({
      emit: () => {
        emits += 1;
        console.log("nested output");
        return "ok";
      },
    });
    const originalSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const uninstall = installConsoleCapture({ levels: ["log"], logger, projectId: "internal", serviceName: "dashboard" });

    console.log("outer");
    expect(emits).toBe(1);
    expect(originalSpy).toHaveBeenCalledTimes(2);

    uninstall();
    originalSpy.mockRestore();
  });

  it("redacts credential-shaped keys in logged objects (bounded depth)", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });
    const originalSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const uninstall = installConsoleCapture({ levels: ["error"], logger, projectId: "internal", serviceName: "dashboard" });

    console.error("auth failed", { headers: { Authorization: "Bearer abc123", accept: "json" }, apiKey: "sk_live_1" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].message).not.toContain("abc123");
    expect(emitted[0].message).not.toContain("sk_live_1");
    expect(emitted[0].message).toContain("[redacted]");
    expect(emitted[0].message).toContain("json");

    uninstall();
    originalSpy.mockRestore();
  });

  it("promotes console.error(err) to the handled error pipeline and keeps the log context", () => {
    const emitted: LogEmitItem[] = [];
    const captured: Error[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });
    const originalSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const uninstall = installConsoleCapture({
      levels: ["error"],
      logger,
      projectId: "internal",
      serviceName: "dashboard",
      captureError: (error) => captured.push(error),
    });

    const error = new Error("payment declined");
    console.error("checkout blew up", error);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data?.error_name).toBe("Error");
    expect(emitted[0].data?.error_fingerprint).toBe(computeErrorFingerprint("Error", error.message, error.stack ?? null));
    expect(captured).toEqual([error]);

    uninstall();
    originalSpy.mockRestore();
  });

  it("rate-limits a runaway level (burst then drop) and reports the drop exactly once per dry spell", () => {
    vi.useFakeTimers();
    try {
      const emitted: LogEmitItem[] = [];
      const logger = createLogger({
        emit: (item) => {
          emitted.push(item);
          return "ok";
        },
      });
      const originalSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const uninstall = installConsoleCapture({ levels: ["warn"], logger, projectId: "internal", serviceName: "dashboard" });

      for (let i = 0; i < 150; i++) console.warn(`spam ${i}`);
      const rateLimited = emitted.filter((item) => item.data?.rate_limited === true);
      expect(rateLimited).toHaveLength(1);
      expect(emitted.length).toBe(101);
      expect(originalSpy).toHaveBeenCalledTimes(150);

      uninstall();
      originalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stop capture when the wall clock moves backwards", () => {
    const emitted: LogEmitItem[] = [];
    const logger = createLogger({
      emit: (item) => {
        emitted.push(item);
        return "ok";
      },
    });
    const originalSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100_000)
      .mockReturnValue(-100_000);
    const uninstall = installConsoleCapture({ levels: ["warn"], logger, projectId: "internal", serviceName: "dashboard" });

    console.warn("before clock correction");
    console.warn("after clock correction");
    expect(emitted.map((item) => item.message)).toEqual([
      "before clock correction",
      "after clock correction",
    ]);

    uninstall();
    originalSpy.mockRestore();
  });

  it("disables ambiguous capture while different services in one project share the console", () => {
    const originalSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const emittedByA: LogEmitItem[] = [];
    const emittedByB: LogEmitItem[] = [];
    const loggerA = createLogger({ emit: (item) => {
      emittedByA.push(item);
      return "ok";
    } });
    const loggerB = createLogger({ emit: (item) => {
      emittedByB.push(item);
      return "ok";
    } });
    const uninstallA = installConsoleCapture({ levels: ["error"], logger: loggerA, projectId: "project-a", serviceName: "dashboard" });
    const uninstallB = installConsoleCapture({ levels: ["error"], logger: loggerB, projectId: "project-a", serviceName: "api" });

    console.error("must not guess a service");
    expect(emittedByA).toEqual([]);
    expect(emittedByB).toEqual([]);
    expect(originalSpy.mock.calls.some(([message]) => typeof message === "string" && message.includes("console capture is disabled because multiple telemetry services share this runtime"))).toBe(true);

    uninstallB();
    console.error("project-a owns capture again");
    expect(emittedByA.map((item) => item.message)).toEqual(["project-a owns capture again"]);
    expect(emittedByB).toEqual([]);

    uninstallA();
    originalErrorSpy.mockRestore();
    originalSpy.mockRestore();
  });

  it("replaces the sink for the same project and service during HMR", () => {
    const originalErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first: LogEmitItem[] = [];
    const replacement: LogEmitItem[] = [];
    const uninstallFirst = installConsoleCapture({
      levels: ["error"],
      logger: createLogger({ emit: (item) => {
        first.push(item);
        return "ok";
      } }),
      projectId: "project-a",
      serviceName: "dashboard",
    });
    const uninstallReplacement = installConsoleCapture({
      levels: ["error"],
      logger: createLogger({ emit: (item) => {
        replacement.push(item);
        return "ok";
      } }),
      projectId: "project-a",
      serviceName: "dashboard",
    });

    console.error("new module owns the sink");
    expect(first).toEqual([]);
    expect(replacement.map((item) => item.message)).toEqual(["new module owns the sink"]);

    uninstallFirst();
    console.error("replacement remains installed");
    expect(replacement.map((item) => item.message)).toEqual([
      "new module owns the sink",
      "replacement remains installed",
    ]);

    uninstallReplacement();
    originalErrorSpy.mockRestore();
  });
});
