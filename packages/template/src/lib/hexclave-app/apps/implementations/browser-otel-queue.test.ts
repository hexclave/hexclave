import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserOtlpOfflineQueue, type BrowserOtlpQueueBatch } from "./browser-otel-queue";

type StoredValue = unknown;

class FakeIdbRequest {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: unknown;
  error: Error | null = null;
}

class FakeIdbTransaction {
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  oncomplete: (() => void) | null = null;
  error: Error | null = null;
  private _pending = 0;
  private _completed = false;

  constructor(private readonly _database: FakeIdbDatabase, private readonly _storeNames: string[]) {}

  objectStore(name: string): FakeIdbObjectStore {
    if (!this._storeNames.includes(name)) throw new Error(`NotFoundError: object store ${name} is not in this transaction`);
    const store = this._database.stores.get(name);
    if (store === undefined) throw new Error(`NotFoundError: object store ${name} does not exist`);
    return new FakeIdbObjectStore(this, store);
  }

  _run(produceResult: () => unknown): FakeIdbRequest {
    const request = new FakeIdbRequest();
    this._pending += 1;
    queueMicrotask(() => {
      request.result = produceResult();
      request.onsuccess?.();
      this._pending -= 1;
      if (this._pending === 0) {
        queueMicrotask(() => {
          if (this._pending === 0 && !this._completed) {
            this._completed = true;
            this.oncomplete?.();
          }
        });
      }
    });
    return request;
  }
}

type FakeStoreState = { data: Map<IDBValidKey, StoredValue>, nextKey: number };

class FakeIdbObjectStore {
  constructor(private readonly _transaction: FakeIdbTransaction, private readonly _state: FakeStoreState) {}

  add(value: StoredValue): FakeIdbRequest {
    return this._transaction._run(() => {
      const key = this._state.nextKey;
      this._state.nextKey += 1;
      this._state.data.set(key, value);
      return key;
    });
  }

  get(key: IDBValidKey): FakeIdbRequest {
    return this._transaction._run(() => this._state.data.get(key));
  }

  put(value: StoredValue, key?: IDBValidKey): FakeIdbRequest {
    return this._transaction._run(() => {
      const resolvedKey = key ?? (() => {
        throw new Error("fake put without key is not used by the queue");
      })();
      this._state.data.set(resolvedKey, value);
      return resolvedKey;
    });
  }

  delete(key: IDBValidKey): FakeIdbRequest {
    return this._transaction._run(() => {
      this._state.data.delete(key);
      return undefined;
    });
  }

  count(): FakeIdbRequest {
    return this._transaction._run(() => this._state.data.size);
  }

  getAll(): FakeIdbRequest {
    return this._transaction._run(() => [...this._state.data.values()]);
  }

  clear(): FakeIdbRequest {
    return this._transaction._run(() => {
      this._state.data.clear();
      return undefined;
    });
  }

  openCursor(): FakeIdbRequest {
    return this._transaction._run(() => {
      const first = this._state.data.entries().next();
      if (first.done) return null;
      return { primaryKey: first.value[0], value: first.value[1] };
    });
  }
}

class FakeIdbDatabase {
  readonly stores = new Map<string, FakeStoreState>();
  onversionchange: (() => void) | null = null;

  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };

  createObjectStore(name: string, _options?: { autoIncrement?: boolean }): void {
    this.stores.set(name, { data: new Map(), nextKey: 1 });
  }

  transaction(storeNames: string | string[], _mode: "readonly" | "readwrite"): FakeIdbTransaction {
    return new FakeIdbTransaction(this, Array.isArray(storeNames) ? storeNames : [storeNames]);
  }

  close(): void {}
}

function installFakeIndexedDb(): Map<string, FakeIdbDatabase> {
  const databases = new Map<string, FakeIdbDatabase>();
  vi.stubGlobal("indexedDB", {
    open: (name: string, _version: number) => {
      const request = new FakeIdbRequest() as FakeIdbRequest & {
        onupgradeneeded: (() => void) | null,
        onblocked: (() => void) | null,
      };
      request.onupgradeneeded = null;
      request.onblocked = null;
      queueMicrotask(() => {
        const isNew = !databases.has(name);
        const database = databases.get(name) ?? new FakeIdbDatabase();
        databases.set(name, database);
        request.result = database;
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  });
  return databases;
}

function batch(bodyBytes: number, kind?: "otlp" | "client_report"): BrowserOtlpQueueBatch {
  return {
    body: new Uint8Array(bodyBytes),
    itemCount: 1,
    bodyBytes,
    nextAttemptAt: 0,
    ...kind === undefined ? {} : { kind },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexedDB browser OTLP offline queue", () => {
  it("releases a removed client report's reserved bytes (no capacity leak)", async () => {
    installFakeIndexedDb();
    const queue = createBrowserOtlpOfflineQueue({
      dbName: "queue-test",
      storeName: "batches-logs",
      maxQueueSize: 10,
      maxQueueBytes: 100,
    });

    expect(await queue.enqueue(batch(60, "client_report"))).toEqual({ status: "queued" });
    const entry = await queue.peek() ?? (() => {
      throw new Error("expected the queued client report to be peekable");
    })();
    expect(entry.kind).toBe("client_report");
    await queue.remove(entry.id);

    expect(await queue.enqueue(batch(60))).toEqual({ status: "queued" });
    queue.close();
  });

  it("keeps client reports out of auth-rotation drop summaries but purges them", async () => {
    installFakeIndexedDb();
    const queue = createBrowserOtlpOfflineQueue({
      dbName: "queue-test-rotation",
      storeName: "batches-logs",
      maxQueueSize: 10,
      maxQueueBytes: 1000,
    });

    expect(await queue.enqueue(batch(10))).toEqual({ status: "queued" });
    expect(await queue.enqueue(batch(20, "client_report"))).toEqual({ status: "queued" });

    expect(await queue.advanceAuthGeneration()).toEqual({ queueEntryCount: 1, itemCount: 1, bodyBytes: 10 });
    expect(await queue.size()).toBe(0);
    expect(await queue.enqueue(batch(1000))).toEqual({ status: "queued" });
    queue.close();
  });

  it("rejects present-but-invalid persisted meta instead of silently defaulting", async () => {
    const databases = installFakeIndexedDb();
    const queue = createBrowserOtlpOfflineQueue({
      dbName: "queue-test-invalid-meta",
      storeName: "batches-logs",
      maxQueueSize: 10,
      maxQueueBytes: 100,
    });
    await queue.size();
    const database = databases.get("queue-test-invalid-meta");
    const meta = database?.stores.get("batches-logs-meta");
    if (meta === undefined) throw new Error("expected the queue meta store");
    meta.data.set("queue-bytes", -1);
    await expect(queue.enqueue(batch(10))).rejects.toThrow(/non-negative integer/);
    queue.close();
  });
});
