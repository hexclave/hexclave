export type BrowserOtlpQueueItemKind = "otlp" | "client_report";

export type BrowserOtlpQueueBatch = {
  body: Uint8Array,
  itemCount: number,
  bodyBytes: number,
  nextAttemptAt: number,
  kind?: BrowserOtlpQueueItemKind,
};

export type BrowserOtlpQueueEntry = BrowserOtlpQueueBatch & {
  id: number,
  authGeneration: number,
  kind: BrowserOtlpQueueItemKind,
};

export type BrowserOtlpQueueDropSummary = {
  queueEntryCount: number,
  itemCount: number,
  bodyBytes: number,
};

export type BrowserOtlpQueueEnqueueResult =
  | { status: "queued" }
  | { status: "dropped", reason: "queue_overflow" };

export type BrowserOtlpOfflineQueueOptions = {
  dbName: string,
  storeName: string,
  maxQueueSize: number,
  maxQueueBytes: number,
};

export class BrowserOtlpQueuePersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BrowserOtlpQueuePersistenceError";
  }
}

export type BrowserOtlpOfflineQueue = {
  enqueue(batch: BrowserOtlpQueueBatch): Promise<BrowserOtlpQueueEnqueueResult>;
  peek(): Promise<BrowserOtlpQueueEntry | undefined>;
  remove(id: number): Promise<void>;
  reschedule(id: number, nextAttemptAt: number): Promise<void>;
  currentAuthGeneration(): Promise<number>;
  advanceAuthGeneration(): Promise<BrowserOtlpQueueDropSummary>;
  size(): Promise<number>;
  close(): void;
}

const AUTH_GENERATION_KEY = "auth-generation";
const QUEUE_BYTES_KEY = "queue-bytes";
const DATABASE_VERSION = 1;

function normalizeQueueNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`IndexedDB ${name} must be a non-negative integer, received ${String(value)}`);
  }
  return value;
}

function cloneBatch(batch: BrowserOtlpQueueBatch): BrowserOtlpQueueBatch {
  const body = new Uint8Array(batch.body.byteLength);
  body.set(batch.body);
  return {
    body,
    itemCount: batch.itemCount,
    bodyBytes: batch.bodyBytes,
    nextAttemptAt: batch.nextAttemptAt,
    kind: batch.kind,
  };
}

function summarizeBatch(batch: BrowserOtlpQueueBatch): BrowserOtlpQueueDropSummary {
  if ((batch.kind ?? "otlp") === "client_report") {
    return { queueEntryCount: 0, itemCount: 0, bodyBytes: 0 };
  }
  return {
    queueEntryCount: 1,
    itemCount: batch.itemCount,
    bodyBytes: batch.bodyBytes,
  };
}

function addSummaries(left: BrowserOtlpQueueDropSummary, right: BrowserOtlpQueueDropSummary): BrowserOtlpQueueDropSummary {
  return {
    queueEntryCount: left.queueEntryCount + right.queueEntryCount,
    itemCount: left.itemCount + right.itemCount,
    bodyBytes: left.bodyBytes + right.bodyBytes,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistenceError(operation: string, error: unknown): BrowserOtlpQueuePersistenceError {
  return new BrowserOtlpQueuePersistenceError(`IndexedDB ${operation} failed: ${errorMessage(error)}`, error);
}

function readStoredBatch(value: unknown, id: IDBValidKey): BrowserOtlpQueueEntry {
  if (
    typeof value !== "object"
    || value === null
    || !("body" in value)
    || !(value.body instanceof Uint8Array)
    || !("itemCount" in value)
    || typeof value.itemCount !== "number"
    || !Number.isSafeInteger(value.itemCount)
    || value.itemCount < 0
    || !("bodyBytes" in value)
    || typeof value.bodyBytes !== "number"
    || !Number.isSafeInteger(value.bodyBytes)
    || value.bodyBytes < 0
    || !("nextAttemptAt" in value)
    || typeof value.nextAttemptAt !== "number"
    || !Number.isFinite(value.nextAttemptAt)
    || !("authGeneration" in value)
    || typeof value.authGeneration !== "number"
    || !Number.isSafeInteger(value.authGeneration)
    || value.authGeneration < 0
    || typeof id !== "number"
  ) {
    throw new Error("IndexedDB contained an invalid browser OTLP queue entry");
  }

  const kind = "kind" in value && value.kind !== undefined ? value.kind : "otlp";
  if (kind !== "otlp" && kind !== "client_report") {
    throw new Error("IndexedDB contained an invalid browser OTLP queue item kind");
  }

  return {
    id,
    body: new Uint8Array(value.body),
    itemCount: value.itemCount,
    bodyBytes: value.bodyBytes,
    nextAttemptAt: value.nextAttemptAt,
    authGeneration: value.authGeneration,
    kind,
  };
}

function readStoredBatchAccounting(value: unknown): { dropSummary: BrowserOtlpQueueDropSummary, storedBodyBytes: number } {
  if (
    typeof value !== "object"
    || value === null
    || !("itemCount" in value)
    || typeof value.itemCount !== "number"
    || !Number.isSafeInteger(value.itemCount)
    || value.itemCount < 0
    || !("bodyBytes" in value)
    || typeof value.bodyBytes !== "number"
    || !Number.isSafeInteger(value.bodyBytes)
    || value.bodyBytes < 0
  ) {
    throw new Error("IndexedDB contained an invalid browser OTLP queue entry");
  }

  const kind = "kind" in value && value.kind !== undefined ? value.kind : "otlp";
  if (kind !== "otlp" && kind !== "client_report") {
    throw new Error("IndexedDB contained an invalid browser OTLP queue item kind");
  }
  if (kind === "client_report") {
    return { dropSummary: { queueEntryCount: 0, itemCount: 0, bodyBytes: 0 }, storedBodyBytes: value.bodyBytes };
  }

  return {
    dropSummary: {
      queueEntryCount: 1,
      itemCount: value.itemCount,
      bodyBytes: value.bodyBytes,
    },
    storedBodyBytes: value.bodyBytes,
  };
}

function readStoredBatchSummary(value: unknown): BrowserOtlpQueueDropSummary {
  return readStoredBatchAccounting(value).dropSummary;
}

function readMetaNumber(value: unknown, fallback: number, name: string): number {
  return normalizeQueueNumber(value, fallback, name);
}

function getTransactionError(transaction: IDBTransaction): Error {
  return transaction.error ?? new Error("IndexedDB transaction failed without an error");
}

function openDatabase(options: BrowserOtlpOfflineQueueOptions): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(options.dbName, DATABASE_VERSION);
    } catch (error) {
      reject(persistenceError("open", error));
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      const storeNames = new Set([options.storeName, "batches-traces", "batches-logs", "batches-metrics"]);
      for (const storeName of storeNames) {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { autoIncrement: true });
        }
        const metaStoreName = `${storeName}-meta`;
        if (!database.objectStoreNames.contains(metaStoreName)) {
          database.createObjectStore(metaStoreName);
        }
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(persistenceError("open", request.error));
  });
}

class IndexedDbBrowserOtlpOfflineQueue implements BrowserOtlpOfflineQueue {
  private _database: IDBDatabase | null = null;
  private _databasePromise: Promise<IDBDatabase> | null = null;
  private _closed = false;

  constructor(private readonly _options: BrowserOtlpOfflineQueueOptions) {}

  private async database(): Promise<IDBDatabase> {
    if (this._closed) throw new BrowserOtlpQueuePersistenceError("operation attempted after queue close");
    if (this._database !== null) return this._database;
    if (this._databasePromise === null) {
      const pending = openDatabase(this._options);
      this._databasePromise = pending.catch((error: unknown) => {
        this._databasePromise = null;
        throw error;
      });
    }
    this._database = await this._databasePromise;
    return this._database;
  }

  async enqueue(batch: BrowserOtlpQueueBatch): Promise<BrowserOtlpQueueEnqueueResult> {
    const database = await this.database();
    return await new Promise<BrowserOtlpQueueEnqueueResult>((resolve, reject) => {
      let result: BrowserOtlpQueueEnqueueResult | null = null;
      let generation: number | null = null;
      let queueBytes: number | null = null;
      let queueSize: number | null = null;
      let addStarted = false;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([this._options.storeName, `${this._options.storeName}-meta`], "readwrite");
      } catch (error) {
        reject(persistenceError("enqueue", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("enqueue", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result ?? { status: "queued" });
      };

      const store = transaction.objectStore(this._options.storeName);
      const meta = transaction.objectStore(`${this._options.storeName}-meta`);
      const generationRequest = meta.get(AUTH_GENERATION_KEY);
      const queueBytesRequest = meta.get(QUEUE_BYTES_KEY);
      const countRequest = store.count();
      generationRequest.onerror = () => fail(generationRequest.error);
      queueBytesRequest.onerror = () => fail(queueBytesRequest.error);
      countRequest.onerror = () => fail(countRequest.error);
      const maybeAdd = (): void => {
        if (generation === null || queueBytes === null || queueSize === null || addStarted || settled) return;
        addStarted = true;
        if (
          queueSize >= this._options.maxQueueSize
          || queueBytes > this._options.maxQueueBytes - batch.bodyBytes
        ) {
          result = { status: "dropped", reason: "queue_overflow" };
          return;
        }
        const addRequest = store.add({
          body: cloneBatch(batch).body,
          itemCount: batch.itemCount,
          bodyBytes: batch.bodyBytes,
          nextAttemptAt: batch.nextAttemptAt,
          authGeneration: generation,
          kind: batch.kind ?? "otlp",
        });
        addRequest.onerror = () => fail(addRequest.error);
        const nextBytes = queueBytes + batch.bodyBytes;
        const updateBytesRequest = meta.put(nextBytes, QUEUE_BYTES_KEY);
        updateBytesRequest.onerror = () => fail(updateBytesRequest.error);
      };
      generationRequest.onsuccess = () => {
        try {
          generation = readMetaNumber(generationRequest.result, 0, AUTH_GENERATION_KEY);
        } catch (error) {
          fail(error);
          return;
        }
        maybeAdd();
      };
      queueBytesRequest.onsuccess = () => {
        try {
          queueBytes = readMetaNumber(queueBytesRequest.result, 0, QUEUE_BYTES_KEY);
        } catch (error) {
          fail(error);
          return;
        }
        maybeAdd();
      };
      countRequest.onsuccess = () => {
        queueSize = countRequest.result;
        maybeAdd();
      };
    });
  }

  async peek(): Promise<BrowserOtlpQueueEntry | undefined> {
    const database = await this.database();
    return await new Promise<BrowserOtlpQueueEntry | undefined>((resolve, reject) => {
      let result: BrowserOtlpQueueEntry | undefined;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this._options.storeName, "readonly");
      } catch (error) {
        reject(persistenceError("peek", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("peek", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = transaction.objectStore(this._options.storeName).openCursor();
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) return;
        try {
          result = readStoredBatch(cursor.value, cursor.primaryKey);
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  async remove(id: number): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      let stored: unknown;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([this._options.storeName, `${this._options.storeName}-meta`], "readwrite");
      } catch (error) {
        reject(persistenceError("remove", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("remove", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const store = transaction.objectStore(this._options.storeName);
      const meta = transaction.objectStore(`${this._options.storeName}-meta`);
      const getRequest = store.get(id);
      getRequest.onerror = () => fail(getRequest.error);
      getRequest.onsuccess = () => {
        stored = getRequest.result;
        if (stored === undefined) return;
        let storedBodyBytes: number;
        try {
          storedBodyBytes = readStoredBatchAccounting(stored).storedBodyBytes;
        } catch (error) {
          fail(error);
          return;
        }
        const bytesRequest = meta.get(QUEUE_BYTES_KEY);
        bytesRequest.onerror = () => fail(bytesRequest.error);
        bytesRequest.onsuccess = () => {
          let currentBytes: number;
          try {
            currentBytes = readMetaNumber(bytesRequest.result, 0, QUEUE_BYTES_KEY);
          } catch (error) {
            fail(error);
            return;
          }
          const nextBytes = Math.max(0, currentBytes - storedBodyBytes);
          const updateBytesRequest = meta.put(nextBytes, QUEUE_BYTES_KEY);
          updateBytesRequest.onerror = () => fail(updateBytesRequest.error);
          const deleteRequest = store.delete(id);
          deleteRequest.onerror = () => fail(deleteRequest.error);
        };
      };
    });
  }

  async reschedule(id: number, nextAttemptAt: number): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this._options.storeName, "readwrite");
      } catch (error) {
        reject(persistenceError("reschedule", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("reschedule", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const store = transaction.objectStore(this._options.storeName);
      const getRequest = store.get(id);
      getRequest.onerror = () => fail(getRequest.error);
      getRequest.onsuccess = () => {
        const value = getRequest.result;
        if (value === undefined) return;
        if (typeof value !== "object" || value === null || !("nextAttemptAt" in value)) {
          fail(new Error("IndexedDB contained an invalid browser OTLP queue entry"));
          return;
        }
        value.nextAttemptAt = nextAttemptAt;
        const putRequest = store.put(value, id);
        putRequest.onerror = () => fail(putRequest.error);
      };
    });
  }

  async currentAuthGeneration(): Promise<number> {
    const database = await this.database();
    return await new Promise<number>((resolve, reject) => {
      let result = 0;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(`${this._options.storeName}-meta`, "readonly");
      } catch (error) {
        reject(persistenceError("read auth generation", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("read auth generation", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = transaction.objectStore(`${this._options.storeName}-meta`).get(AUTH_GENERATION_KEY);
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        try {
          result = readMetaNumber(request.result, 0, AUTH_GENERATION_KEY);
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  async advanceAuthGeneration(): Promise<BrowserOtlpQueueDropSummary> {
    const database = await this.database();
    return await new Promise<BrowserOtlpQueueDropSummary>((resolve, reject) => {
      let result: BrowserOtlpQueueDropSummary = { queueEntryCount: 0, itemCount: 0, bodyBytes: 0 };
      let generation = 0;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction([this._options.storeName, `${this._options.storeName}-meta`], "readwrite");
      } catch (error) {
        reject(persistenceError("advance auth generation", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("advance auth generation", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const store = transaction.objectStore(this._options.storeName);
      const meta = transaction.objectStore(`${this._options.storeName}-meta`);
      const generationRequest = meta.get(AUTH_GENERATION_KEY);
      const entriesRequest = store.getAll();
      generationRequest.onerror = () => fail(generationRequest.error);
      entriesRequest.onerror = () => fail(entriesRequest.error);
      let entries: unknown[] | null = null;
      const maybeAdvance = (): void => {
        if (entries === null || settled) return;
        const nextGeneration = generation + 1;
        try {
          result = entries.reduce<BrowserOtlpQueueDropSummary>(
            (summary, entry) => addSummaries(summary, readStoredBatchSummary(entry)),
            result,
          );
        } catch (error) {
          fail(error);
          return;
        }
        const putGenerationRequest = meta.put(nextGeneration, AUTH_GENERATION_KEY);
        putGenerationRequest.onerror = () => fail(putGenerationRequest.error);
        const clearRequest = store.clear();
        clearRequest.onerror = () => fail(clearRequest.error);
        const resetBytesRequest = meta.put(0, QUEUE_BYTES_KEY);
        resetBytesRequest.onerror = () => fail(resetBytesRequest.error);
      };
      generationRequest.onsuccess = () => {
        try {
          generation = readMetaNumber(generationRequest.result, 0, AUTH_GENERATION_KEY);
        } catch (error) {
          fail(error);
          return;
        }
        maybeAdvance();
      };
      entriesRequest.onsuccess = () => {
        entries = entriesRequest.result;
        maybeAdvance();
      };
    });
  }

  async size(): Promise<number> {
    const database = await this.database();
    return await new Promise<number>((resolve, reject) => {
      let result = 0;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this._options.storeName, "readonly");
      } catch (error) {
        reject(persistenceError("count", error));
        return;
      }
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(persistenceError("count", error));
      };
      transaction.onerror = () => fail(getTransactionError(transaction));
      transaction.onabort = () => fail(getTransactionError(transaction));
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = transaction.objectStore(this._options.storeName).count();
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        result = request.result;
      };
    });
  }

  close(): void {
    this._closed = true;
    this._database?.close();
    this._database = null;
  }
}

class InMemoryBrowserOtlpOfflineQueue implements BrowserOtlpOfflineQueue {
  private readonly _entries: BrowserOtlpQueueEntry[] = [];
  private _nextId = 1;
  private _authGeneration = 0;
  private _queueBytes = 0;
  private _closed = false;

  constructor(private readonly _options: BrowserOtlpOfflineQueueOptions) {}

  private ensureOpen(): void {
    if (this._closed) throw new BrowserOtlpQueuePersistenceError("operation attempted after queue close");
  }

  async enqueue(batch: BrowserOtlpQueueBatch): Promise<BrowserOtlpQueueEnqueueResult> {
    this.ensureOpen();
    if (
      this._entries.length >= this._options.maxQueueSize
      || this._queueBytes > this._options.maxQueueBytes - batch.bodyBytes
    ) {
      return { status: "dropped", reason: "queue_overflow" };
    }
    this._entries.push({ ...cloneBatch(batch), id: this._nextId, authGeneration: this._authGeneration, kind: batch.kind ?? "otlp" });
    this._nextId += 1;
    this._queueBytes += batch.bodyBytes;
    return { status: "queued" };
  }

  async peek(): Promise<BrowserOtlpQueueEntry | undefined> {
    this.ensureOpen();
    const entry = this._entries.at(0);
    if (entry == null) return undefined;
    return { ...cloneBatch(entry), id: entry.id, authGeneration: entry.authGeneration, kind: entry.kind };
  }

  async remove(id: number): Promise<void> {
    this.ensureOpen();
    const index = this._entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = this._entries.at(index);
    if (entry == null) throw new Error("In-memory browser OTLP queue lost its selected entry");
    this._entries.splice(index, 1);
    this._queueBytes = Math.max(0, this._queueBytes - entry.bodyBytes);
  }

  async reschedule(id: number, nextAttemptAt: number): Promise<void> {
    this.ensureOpen();
    const entry = this._entries.find((candidate) => candidate.id === id);
    if (entry !== undefined) entry.nextAttemptAt = nextAttemptAt;
  }

  async currentAuthGeneration(): Promise<number> {
    this.ensureOpen();
    return this._authGeneration;
  }

  async advanceAuthGeneration(): Promise<BrowserOtlpQueueDropSummary> {
    this.ensureOpen();
    const result = this._entries.reduce<BrowserOtlpQueueDropSummary>(
      (summary, entry) => addSummaries(summary, summarizeBatch(entry)),
      { queueEntryCount: 0, itemCount: 0, bodyBytes: 0 },
    );
    this._entries.length = 0;
    this._queueBytes = 0;
    this._authGeneration += 1;
    return result;
  }

  async size(): Promise<number> {
    this.ensureOpen();
    return this._entries.length;
  }

  close(): void {
    this._closed = true;
  }
}

export function createBrowserOtlpOfflineQueue(options: BrowserOtlpOfflineQueueOptions): BrowserOtlpOfflineQueue {
  if (!Number.isSafeInteger(options.maxQueueSize) || options.maxQueueSize <= 0) {
    throw new Error("Browser OTLP offline queue maxQueueSize must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxQueueBytes) || options.maxQueueBytes <= 0) {
    throw new Error("Browser OTLP offline queue maxQueueBytes must be a positive safe integer");
  }
  return typeof indexedDB === "undefined"
    ? new InMemoryBrowserOtlpOfflineQueue(options)
    : new IndexedDbBrowserOtlpOfflineQueue(options);
}
