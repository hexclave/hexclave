import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstanceRecycler, maxDrainWaitMs, parseInstanceRecyclingConfig, readinessPropagationDelayMs, type InstanceRecyclingLogEvent } from "./instance-recycling";

describe("parseInstanceRecyclingConfig", () => {
  it("is disabled when unset", () => {
    expect(parseInstanceRecyclingConfig("")).toBeUndefined();
    expect(parseInstanceRecyclingConfig("  ")).toBeUndefined();
  });

  it("parses seconds", () => {
    expect(parseInstanceRecyclingConfig("1800")).toEqual({ lifetimeMs: 1_800_000 });
  });

  it.each(["30", "-1", "abc", "NaN", "Infinity"])("rejects %j", (value) => {
    expect(() => parseInstanceRecyclingConfig(value)).toThrowError(`HEXCLAVE_MAX_INSTANCE_LIFETIME_SECONDS must be a number of seconds >= 60, got: ${JSON.stringify(value)}`);
  });
});

describe("createInstanceRecycler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(random = 0) {
    const recycler = createInstanceRecycler({ random: () => random, now: () => Date.now() });
    const onDrained = vi.fn();
    const events: InstanceRecyclingLogEvent[] = [];
    recycler.start({ config: { lifetimeMs: 60_000 }, onDrained, log: (event) => events.push(event) });
    return { recycler, onDrained, events };
  }

  it("is ready until the lifetime elapses, then fails readiness", async () => {
    const { recycler } = setup();
    expect(recycler.createReadinessResponse().status).toBe(200);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(recycler.isDraining()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(recycler.isDraining()).toBe(true);
    const response = recycler.createReadinessResponse();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "draining" });
  });

  it("adds up to 25% jitter to the lifetime", async () => {
    const { recycler, events } = setup(0.999);
    expect(events[0]).toEqual({ event: "backend.instance-recycling.scheduled", lifetimeMs: 74_985 });
    await vi.advanceTimersByTimeAsync(74_984);
    expect(recycler.isDraining()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(recycler.isDraining()).toBe(true);
  });

  it("waits for the readiness propagation delay even when idle", async () => {
    const { onDrained } = setup();
    await vi.advanceTimersByTimeAsync(60_000 + readinessPropagationDelayMs - 1000);
    expect(onDrained).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDrained).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight requests to finish before reporting drained", async () => {
    const { recycler, onDrained, events } = setup();
    let finishRequest!: () => void;
    const request = recycler.trackRequest(async () => await new Promise<void>((resolve) => {
      finishRequest = resolve;
    }));
    expect(recycler.getInFlightRequestCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000 + readinessPropagationDelayMs + 10_000);
    expect(onDrained).not.toHaveBeenCalled();

    finishRequest();
    await request;
    expect(recycler.getInFlightRequestCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ event: "backend.instance-recycling.drained", inFlightRequests: 0, timedOut: false });
  });

  it("gives up waiting on stuck requests after the max drain time", async () => {
    const { recycler, onDrained, events } = setup();
    runStuckRequest(recycler);
    await vi.advanceTimersByTimeAsync(60_000 + maxDrainWaitMs - 500);
    expect(onDrained).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onDrained).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ event: "backend.instance-recycling.drained", inFlightRequests: 1, timedOut: true });
  });

  it("decrements the in-flight count when a request throws", async () => {
    const recycler = createInstanceRecycler();
    await expect(recycler.trackRequest(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(recycler.getInFlightRequestCount()).toBe(0);
  });

  it("refuses to start twice", () => {
    const { recycler } = setup();
    expect(() => recycler.start({ config: { lifetimeMs: 60_000 }, onDrained: () => {}, log: () => {} })).toThrowError("Instance recycling was started twice");
  });
});

function runStuckRequest(recycler: ReturnType<typeof createInstanceRecycler>) {
  // The promise intentionally never settles; it models a hung request.
  recycler.trackRequest(async () => await new Promise<never>(() => {})).then(
    () => { throw new Error("stuck request should never resolve"); },
    (error: unknown) => { throw error; },
  );
}
