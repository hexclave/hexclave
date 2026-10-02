import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNodeTelemetrySuppressed,
  registerNodeTelemetrySuppressionRunner,
  resetNodeTelemetrySuppressionRunnerForTesting,
  runWithNodeTelemetrySuppressed,
} from "./node-telemetry-suppression";

describe("Node telemetry suppression runner", () => {
  afterEach(() => {
    resetNodeTelemetrySuppressionRunnerForTesting();
  });

  it("fails loudly before instrumentation publishes its runner", async () => {
    await expect(runWithNodeTelemetrySuppressed(async () => "never"))
      .rejects
      .toThrow("requires Node instrumentation to be registered first");
  });

  it("invokes the exact runner closure published by instrumentation", async () => {
    let suppressed = false;
    const invocation = vi.fn();
    const runner = async <T>(fn: () => Promise<T>): Promise<T> => {
      invocation();
      suppressed = true;
      try {
        return await fn();
      } finally {
        suppressed = false;
      }
    };
    registerNodeTelemetrySuppressionRunner(runner);
    expect(isNodeTelemetrySuppressed()).toBe(false);

    await expect(runWithNodeTelemetrySuppressed(async () => {
      expect(suppressed).toBe(true);
      await Promise.resolve();
      expect(isNodeTelemetrySuppressed()).toBe(true);
      return "result";
    })).resolves.toBe("result");
    expect(invocation).toHaveBeenCalledOnce();
    expect(suppressed).toBe(false);
    expect(isNodeTelemetrySuppressed()).toBe(false);
  });

  it("survives a module re-evaluation like separate Next.js server chunks", async () => {
    const invocation = vi.fn();
    const runner = async <T>(fn: () => Promise<T>): Promise<T> => {
      invocation();
      return await fn();
    };
    registerNodeTelemetrySuppressionRunner(runner);

    vi.resetModules();
    const reloaded = await import("./node-telemetry-suppression");

    await expect(reloaded.runWithNodeTelemetrySuppressed(async () => {
      expect(isNodeTelemetrySuppressed()).toBe(true);
      expect(reloaded.isNodeTelemetrySuppressed()).toBe(true);
      return 42;
    }))
      .resolves
      .toBe(42);
    expect(invocation).toHaveBeenCalledOnce();
  });
});
