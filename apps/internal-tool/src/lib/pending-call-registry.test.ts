import { describe, expect, it } from "vitest";
import { createPendingCallRegistry } from "./pending-call-registry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPendingCallRegistry", () => {
  it("passes through resolution and cleans up its bookkeeping", async () => {
    const registry = createPendingCallRegistry();
    const call = deferred<string>();

    const tracked = registry.track(call.promise);
    expect(registry.pendingCount).toBe(1);

    call.resolve("done");
    await expect(tracked).resolves.toBe("done");
    expect(registry.pendingCount).toBe(0);
  });

  it("passes through rejection and cleans up its bookkeeping", async () => {
    const registry = createPendingCallRegistry();
    const call = deferred<string>();

    const tracked = registry.track(call.promise);
    call.reject(new Error("server said no"));
    await expect(tracked).rejects.toThrow("server said no");
    expect(registry.pendingCount).toBe(0);
  });

  it("rejectAll rejects every pending call with the given error", async () => {
    const registry = createPendingCallRegistry();
    const first = registry.track(deferred<void>().promise);
    const second = registry.track(deferred<void>().promise);
    expect(registry.pendingCount).toBe(2);

    registry.rejectAll(new Error("connection torn down"));
    await expect(first).rejects.toThrow("connection torn down");
    await expect(second).rejects.toThrow("connection torn down");
    expect(registry.pendingCount).toBe(0);
  });

  it("rejectAll does not affect calls that already settled", async () => {
    const registry = createPendingCallRegistry();
    const call = deferred<string>();
    const tracked = registry.track(call.promise);
    call.resolve("landed");
    await expect(tracked).resolves.toBe("landed");

    registry.rejectAll(new Error("connection torn down"));
    // The tracked promise stays settled with its original value.
    await expect(tracked).resolves.toBe("landed");
  });

  it("stays usable for the next connection generation after rejectAll", async () => {
    const registry = createPendingCallRegistry();
    registry.rejectAll(new Error("first teardown"));

    const call = deferred<string>();
    const tracked = registry.track(call.promise);
    expect(registry.pendingCount).toBe(1);
    call.resolve("fresh connection works");
    await expect(tracked).resolves.toBe("fresh connection works");
  });

  it("rejects a pending call even when the underlying promise settles later", async () => {
    const registry = createPendingCallRegistry();
    const call = deferred<string>();
    const tracked = registry.track(call.promise);

    registry.rejectAll(new Error("connection torn down"));
    await expect(tracked).rejects.toThrow("connection torn down");

    // A late reply from the (dead) connection must be a harmless no-op —
    // this mirrors the SDK settling a promise after we already gave up on it.
    call.resolve("too late");
    await expect(tracked).rejects.toThrow("connection torn down");
  });
});
