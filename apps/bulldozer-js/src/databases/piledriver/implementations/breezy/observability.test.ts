import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The tracer is the edge of the process: record which spans the code opens, then run the real code.
const tracedSpanNames: string[] = [];
vi.mock("../../../../otel.js", () => {
  const record = async <T,>(options: string | { description: string }, fn: (span: { setAttribute: () => void }) => Promise<T>) => {
    tracedSpanNames.push(typeof options === "string" ? options : options.description);
    return await fn({ setAttribute: () => {} });
  };
  return { traceSpan: record, traceSpanHot: async <T,>(_options: unknown, fn: (span: { setAttribute: () => void }) => Promise<T>) => await fn({ setAttribute: () => {} }) };
});
// Periodic logs are off under NODE_ENV=test; turn them on so the per-write timing log can be seen.
vi.mock("../../../../logging.js", () => ({ shouldSuppressPeriodicBulldozerLogs: false }));

const { asHeapObject } = await import("../../index.js");
const { declareBasePiledriverDatabase } = await import("../base.js");
const { declareInMemoryLowLevelDatabase } = await import("../../../low-level/implementations/in-memory.js");
const { declareBreezyLMDBPiledriverDatabase } = await import("../breezy-lmdb/index.js");
const { declareBreezylitePiledriverDatabase, openBreezyliteStorage } = await import("../breezylite/index.js");
const { declareBreezyDatabaseWithStorage } = await import("./core.js");
const { registerErrorSink, unregisterErrorSink } = await import("@hexclave/shared/dist/utils/errors");
type PiledriverDatabase = import("../../index.js").PiledriverDatabase;

const timingLogMessage = "bulldozer-js piledriver setRootObject timing";

/** Every operation the service calls on a Piledriver, once each, plus a second write. */
async function runServiceWorkload(db: PiledriverDatabase) {
  const key = new TextEncoder().encode("customer").buffer;
  const first = await db.setRootObject(key, asHeapObject({ items: asHeapObject({ seats: 3 }) }));
  await db.waitUntilAvailable(first.seq);
  await db.getRootObject(key);
  const second = await db.setRootObject(key, asHeapObject({ items: asHeapObject({ seats: 4 }) }));
  await db.waitUntilReplicated(second.seq);
  const deleted = await db.deleteRootObject(key);
  await db.waitUntilDurable(deleted.seq);
  await db.waitUntilConsistent(deleted.seq);
  await db.collectGarbage(db.getGarbageCollectionProcessStartedAtMillis() - 1);
  await db.debugSnapshot?.();
}

/** Runs the workload and returns the distinct span names and how many timing logs it emitted. */
async function observe(db: PiledriverDatabase) {
  tracedSpanNames.length = 0;
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  try {
    await runServiceWorkload(db);
  } finally {
    await db.close();
  }
  const timingLogs = debug.mock.calls.filter(([message]) => message === timingLogMessage).length;
  debug.mockRestore();
  return { spanNames: new Set(tracedSpanNames), timingLogs };
}

const garbageCollectionProcessStartedAtMillis = Date.now() - 60_000;
const temporaryDirectories: string[] = [];
const newDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), "breezy-observability-"));
  temporaryDirectories.push(path);
  return path;
};
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

for (const [name, declare] of [
  ["BreezyLMDB", (path: string) => declareBreezyLMDBPiledriverDatabase({ path }, { garbageCollectionProcessStartedAtMillis })],
  ["Breezylite", (path: string) => declareBreezylitePiledriverDatabase({ path }, { garbageCollectionProcessStartedAtMillis })],
] as const) {
  describe(name, () => {
    it("emits the same storage tracing spans as the default backend, so existing dashboards keep working", async () => {
      const base = await observe(declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()), { garbageCollectionProcessStartedAtMillis }));
      const breezy = await observe(declare(newDirectory()));
      expect(base.spanNames.size).toBeGreaterThan(0);
      expect([...breezy.spanNames].sort()).toEqual([...base.spanNames].sort());
    });

    it("logs one setRootObject timing line per write, like the default backend", async () => {
      const breezy = await observe(declare(newDirectory()));
      expect(breezy.timingLogs).toBe(2);
    });
  });
}

it("reports a failing activity log to the error sink instead of crashing the process", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const capturedErrors: unknown[] = [];
  const recordError = (_location: string, error: unknown) => {
    capturedErrors.push(error);
  };
  registerErrorSink(recordError);
  const storage = openBreezyliteStorage({ path: newDirectory() });
  // Stands in for any I/O error while reading file sizes (e.g. a disk fault).
  const failingStatStorage = {
    ...storage,
    fileSizesInBytes: () => {
      throw new Error("EIO: i/o error, stat");
    },
  };
  const db = declareBreezyDatabaseWithStorage(failingStatStorage, "test");
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  try {
    await db.setRootObject(new TextEncoder().encode("customer").buffer, { seats: 3 });
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    await vi.waitFor(() => expect(capturedErrors).toHaveLength(1));
    expect(String(capturedErrors[0])).toContain("EIO");
  } finally {
    debug.mockRestore();
    unregisterErrorSink(recordError);
    vi.useRealTimers();
    await db.close();
  }
});
