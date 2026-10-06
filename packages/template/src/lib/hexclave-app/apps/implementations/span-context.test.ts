import { generateW3cSpanId, generateW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import { afterEach, describe, expect, it } from "vitest";
import { getAmbientSpanContexts, runWithSpanContext, runWithSpanFrame } from "./span-context";
import { syncStack } from "./span-context-state";
import { setAsyncContextModeForTesting } from "./span-context-state";
import type { SpanContext } from "./telemetry-core";

const labelsBySpanId = new Map<string, string>();

function ctx(label: string, traceId: string = generateW3cTraceId()): SpanContext {
  const context: SpanContext = { traceId, spanId: generateW3cSpanId() };
  labelsBySpanId.set(context.spanId, label);
  return context;
}

function ambientLabels(): string[] {
  return getAmbientSpanContexts().map((context) => labelsBySpanId.get(context.spanId) ?? context.spanId);
}

describe("span context (AsyncLocalStorage)", () => {
  afterEach(() => {
    setAsyncContextModeForTesting("auto");
  });

  it("propagates nested frames across await boundaries, outermost first", async () => {
    expect(getAmbientSpanContexts()).toEqual([]);
    await runWithSpanContext(ctx("a"), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ambientLabels()).toEqual(["a"]);
      await runWithSpanContext(ctx("b"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(ambientLabels()).toEqual(["a", "b"]);
      });
      expect(ambientLabels()).toEqual(["a"]);
    });
    expect(getAmbientSpanContexts()).toEqual([]);
  });

  it("isolates interleaved parallel flows — no cross-parenting under ALS", async () => {
    const seen: Record<string, string[]> = {};
    await Promise.all([
      runWithSpanContext(ctx("flow1"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.flow1 = ambientLabels();
      }),
      runWithSpanContext(ctx("flow2"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.flow2 = ambientLabels();
      }),
    ]);
    expect(seen.flow1).toEqual(["flow1"]);
    expect(seen.flow2).toEqual(["flow2"]);
  });

  it("frames carry the whole SpanContext, trace id included — not just the span id", async () => {
    const frame = ctx("child");
    await runWithSpanContext(frame, async () => {
      expect(getAmbientSpanContexts()).toEqual([{ traceId: frame.traceId, spanId: frame.spanId }]);
    });
  });

  it("waits for the first async-context probe before invoking a manual frame", async () => {
    setAsyncContextModeForTesting("auto");
    await runWithSpanFrame(ctx("first-manual"), async () => {
      await Promise.resolve();
      expect(ambientLabels()).toEqual(["first-manual"]);
    });
  });
});

describe("span context (sync-stack fallback)", () => {
  afterEach(() => {
    setAsyncContextModeForTesting("auto");
  });

  it("is correct for sequential nested flows and removes its own frame on settle", async () => {
    setAsyncContextModeForTesting("sync-stack");
    await runWithSpanContext(ctx("a"), async () => {
      expect(ambientLabels()).toEqual(["a"]);
      await runWithSpanContext(ctx("b"), async () => {
        expect(ambientLabels()).toEqual(["a", "b"]);
      });
      expect(ambientLabels()).toEqual([]);
    });
    expect(getAmbientSpanContexts()).toEqual([]);
  });

  it("removes its own frame even when it is no longer on top (interleaving-safe cleanup)", async () => {
    setAsyncContextModeForTesting("sync-stack");
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const flow1 = ctx("flow1");
    const first = runWithSpanContext(flow1, async () => {
      await firstBlocked;
    });
    expect(syncStack).toHaveLength(1);
    expect(syncStack[0]?.context.spanId).toBe(flow1.spanId);
    expect(syncStack[0]?.prologueOpen).toBe(false);
    expect(ambientLabels()).toEqual([]);
    await runWithSpanContext(ctx("flow2"), async () => {
      expect(ambientLabels()).toEqual(["flow2"]);
      expect(syncStack.map((frame) => labelsBySpanId.get(frame.context.spanId))).toEqual(["flow1", "flow2"]);
    });
    expect(ambientLabels()).toEqual([]);
    expect(syncStack).toHaveLength(1);
    expect(syncStack[0]?.context.spanId).toBe(flow1.spanId);
    releaseFirst();
    await first;
    expect(getAmbientSpanContexts()).toEqual([]);
    expect(syncStack).toHaveLength(0);
  });

  it("sees prologue-open frames only; suspended frames of another flow are never ambient", async () => {
    setAsyncContextModeForTesting("sync-stack");
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runWithSpanContext(ctx("flow1"), async () => {
      await firstBlocked;
    });
    expect(ambientLabels()).toEqual([]);
    await runWithSpanContext(ctx("flow2"), async () => {
      expect(ambientLabels()).toEqual(["flow2"]);
    });
    releaseFirst();
    await first;
    expect(getAmbientSpanContexts()).toEqual([]);
  });

  it("keeps outer frames ambient through SYNCHRONOUS nesting, and drops them after an await", async () => {
    setAsyncContextModeForTesting("sync-stack");
    await runWithSpanContext(ctx("a"), async () => {
      expect(ambientLabels()).toEqual(["a"]);
      await runWithSpanContext(ctx("b"), async () => {
        expect(ambientLabels()).toEqual(["a", "b"]);
      });
      expect(ambientLabels()).toEqual([]);
    });
  });

  it("runWithSpanFrame re-binds a frame exactly for a synchronous window", async () => {
    setAsyncContextModeForTesting("sync-stack");
    const result = await runWithSpanFrame(ctx("manual"), () => {
      expect(ambientLabels()).toEqual(["manual"]);
      return 42;
    });
    expect(result).toBe(42);
    expect(getAmbientSpanContexts()).toEqual([]);
  });

  it("runWithSpanFrame drops ambient after the prologue but keeps the frame until settle for cleanup", async () => {
    setAsyncContextModeForTesting("sync-stack");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = ctx("callback");
    const promise = runWithSpanFrame(callback, async () => {
      expect(ambientLabels()).toEqual(["callback"]);
      await blocked;
    });
    expect(ambientLabels()).toEqual([]);
    expect(syncStack).toHaveLength(1);
    expect(syncStack[0]?.context.spanId).toBe(callback.spanId);
    expect(syncStack[0]?.prologueOpen).toBe(false);
    release();
    await promise;
    await Promise.resolve();
    expect(getAmbientSpanContexts()).toEqual([]);
    expect(syncStack).toHaveLength(0);
  });

  it("runWithSpanFrame treats thenables as async for cleanup (not ambient after prologue)", async () => {
    setAsyncContextModeForTesting("sync-stack");
    const waiters: ((value: string) => void)[] = [];
    const thenable = {
      then: (resolve: (value: string) => void) => {
        waiters.push(resolve);
      },
    };

    const result = runWithSpanFrame(ctx("thenable"), () => thenable);
    expect(ambientLabels()).toEqual([]);
    expect(syncStack).toHaveLength(1);
    await Promise.resolve();
    for (const resolve of waiters) resolve("done");
    await expect(result).resolves.toBe("done");
    expect(getAmbientSpanContexts()).toEqual([]);
    expect(syncStack).toHaveLength(0);
  });
});
