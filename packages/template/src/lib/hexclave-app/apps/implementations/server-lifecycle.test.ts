import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installServerLifecycle,
  type ServerLifecycleDeliveryOutcome,
  type ServerLifecycleHost,
} from "./server-lifecycle";
import { StackServerApp } from "../interfaces/server-app";
import { getServerAppInstrumentation } from "./server-app-impl";

type Listener = (...args: unknown[]) => void;

class FakeHost implements ServerLifecycleHost {
  private readonly listeners = new Map<string, Listener[]>();
  readonly exits: number[] = [];
  readonly kills: { pid: number, signal: "SIGTERM" | "SIGINT" }[] = [];
  readonly rethrows: unknown[] = [];
  readonly pid = 4242;

  on(event: string, listener: Listener): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  removeListener(event: string, listener: Listener): void {
    const current = this.listeners.get(event) ?? [];
    this.listeners.set(event, current.filter((candidate) => candidate !== listener));
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  kill(pid: number, signal: "SIGTERM" | "SIGINT"): void {
    this.kills.push({ pid, signal });
  }

  rethrow(error: unknown): void {
    this.rethrows.push(error);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...this.listeners.get(event) ?? []]) listener(...args);
  }

  count(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

let ownerCounter = 0;

function install(
  host: FakeHost,
  overrides?: Partial<Parameters<typeof installServerLifecycle>[0]>,
): { handle: NonNullable<ReturnType<typeof installServerLifecycle>>, outcomes: ServerLifecycleDeliveryOutcome[] } {
  const outcomes: ServerLifecycleDeliveryOutcome[] = [];
  const handle = installServerLifecycle({
    ownerKey: `server-lifecycle-test-${ownerCounter++}`,
    host,
    capture: async () => {},
    flush: async () => {},
    onOutcome: (outcome) => outcomes.push(outcome),
    ...overrides,
  });
  if (handle === null) throw new Error("Expected fake host lifecycle installation to be available");
  return { handle, outcomes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server lifecycle integration", () => {
  it("restores pre-existing handlers and is safe to uninstall twice", () => {
    const host = new FakeHost();
    const existing = () => {};
    host.on("uncaughtException", existing);

    const { handle } = install(host);
    expect(host.count("uncaughtException")).toBe(2);
    expect(host.count("SIGTERM")).toBe(1);

    handle.uninstall();
    handle.uninstall();

    expect(handle.active).toBe(false);
    expect(host.count("uncaughtException")).toBe(1);
    expect(host.count("SIGTERM")).toBe(0);
    expect(host.count("SIGINT")).toBe(0);
    expect(host.count("unhandledRejection")).toBe(0);
  });

  it("replaces a duplicate owner without stacking global listeners", () => {
    const host = new FakeHost();
    const first = installServerLifecycle({
      ownerKey: "same-owner",
      host,
      capture: async () => {},
      flush: async () => {},
    });
    const second = installServerLifecycle({
      ownerKey: "same-owner",
      host,
      capture: async () => {},
      flush: async () => {},
    });

    if (first === null || second === null) throw new Error("Expected fake host lifecycle installation to be available");
    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    expect(host.count("uncaughtException")).toBe(1);
    expect(host.count("unhandledRejection")).toBe(1);
    expect(host.count("SIGTERM")).toBe(1);
    expect(host.count("SIGINT")).toBe(1);

    second.uninstall();
    expect(host.count("uncaughtException")).toBe(0);
    expect(host.count("unhandledRejection")).toBe(0);
    expect(host.count("SIGTERM")).toBe(0);
    expect(host.count("SIGINT")).toBe(0);
  });

  it("keeps the shutdown deadline timer referenced (the only guaranteed event-loop handle)", async () => {
    const unref = vi.fn();
    const fakeTimers: unknown[] = [];
    vi.stubGlobal("setTimeout", (_callback: () => void, _ms?: number) => {
      const timer = { unref };
      fakeTimers.push(timer);
      return timer;
    });
    vi.stubGlobal("clearTimeout", () => {});

    const host = new FakeHost();
    const { handle, outcomes } = install(host);
    host.emit("uncaughtException", new Error("boom"));
    await handle.waitForIdle();

    expect(outcomes).toMatchObject([{ outcome: "accepted" }]);
    expect(fakeTimers.length).toBeGreaterThan(0);
    expect(unref).not.toHaveBeenCalled();
  });

  it("captures, flushes, and reports an accepted fatal event", async () => {
    const host = new FakeHost();
    const captured: { error: unknown, signal: string }[] = [];
    const { handle, outcomes } = install(host, {
      capture: async (error, info) => {
        captured.push({ error, signal: info.signal });
      },
    });
    const error = new Error("fatal");

    host.emit("uncaughtException", error);
    await handle.waitForIdle();

    expect(captured).toEqual([{ error, signal: "uncaughtException" }]);
    expect(outcomes).toEqual([{ signal: "uncaughtException", outcome: "accepted", reason: "accepted" }]);
    expect(host.rethrows).toEqual([error]);
    expect(host.count("uncaughtException")).toBe(0);
  });

  it("drops on the bounded deadline and still hands fatal ownership back to the host", async () => {
    const host = new FakeHost();
    const { handle, outcomes } = install(host, {
      deadlineMs: 5,
      capture: () => new Promise<void>(() => {}),
    });
    const error = new Error("slow fatal");

    host.emit("uncaughtException", error);
    await handle.waitForIdle();

    expect(outcomes).toEqual([{ signal: "uncaughtException", outcome: "dropped", reason: "deadline" }]);
    expect(host.rethrows).toEqual([error]);
    expect(host.count("uncaughtException")).toBe(0);
  });

  it("supports explicit SDK-owned fatal exit after delivery", async () => {
    const host = new FakeHost();
    const { handle } = install(host, { fatalErrorAction: "exit" });
    const error = new Error("exit-owned fatal");

    host.emit("unhandledRejection", error, Promise.resolve());
    await handle.waitForIdle();

    expect(host.exits).toEqual([1]);
    expect(host.rethrows).toHaveLength(0);
    expect(host.count("unhandledRejection")).toBe(0);
  });

  it("captures signals and re-emits host-owned termination semantics", async () => {
    const host = new FakeHost();
    const { handle, outcomes } = install(host);

    host.emit("SIGTERM");
    await handle.waitForIdle();

    expect(outcomes).toEqual([{ signal: "SIGTERM", outcome: "accepted", reason: "accepted" }]);
    expect(host.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(host.exits).toHaveLength(0);
    expect(host.count("SIGTERM")).toBe(0);
  });

  it("supports explicit SDK-owned signal exit and suppresses duplicate delivery", async () => {
    const host = new FakeHost();
    const { handle, outcomes } = install(host, { signalAction: "exit" });

    host.emit("SIGINT");
    host.emit("SIGINT");
    await handle.waitForIdle();

    expect(outcomes).toEqual([
      { signal: "SIGINT", outcome: "dropped", reason: "duplicate" },
      { signal: "SIGINT", outcome: "accepted", reason: "accepted" },
    ]);
    expect(host.exits).toEqual([130, 130]);
    expect(host.count("SIGINT")).toBe(0);
  });

  it("does not install when process APIs are unavailable", () => {
    vi.stubGlobal("process", {});
    const handle = installServerLifecycle({
      ownerKey: "no-process-api",
      capture: async () => {},
      flush: async () => {},
    });

    expect(handle).toBeNull();
  });

  it("is owned and idempotent at the server-app instrumentation boundary", () => {
    const host = new FakeHost();
    const app = new StackServerApp({
      projectId: "00000000-0000-4000-8000-000000000001",
      publishableClientKey: "pck_test",
      secretServerKey: "ssk_test",
      baseUrl: "https://api.example.test",
      tokenStore: "memory",
      noAutomaticPrefetch: true,
      observability: { enabled: true, openTelemetry: { provider: "existing-provider" } },
    });
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");

    try {
      const first = instrumentation.installServerLifecycle({ host });
      const second = instrumentation.installServerLifecycle({ host });
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(host.count("uncaughtException")).toBe(1);
      expect(host.count("SIGTERM")).toBe(1);
    } finally {
      instrumentation.uninstallErrorIntegrations();
    }

    expect(host.count("uncaughtException")).toBe(0);
    expect(host.count("unhandledRejection")).toBe(0);
    expect(host.count("SIGTERM")).toBe(0);
    expect(host.count("SIGINT")).toBe(0);
  });
});
