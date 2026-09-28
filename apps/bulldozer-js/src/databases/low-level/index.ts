import { Database, DatabaseSeq } from "../index.js";

/**
 * A low-level database that can create KV stores and KV dumps.
 *
 * Note that each KV store and KV dump is independent of the others; it may get ahead or fall behind in terms of seq
 * replication. It is therefore crucial to use `requiresSeq` correctly when doing a modification that relies on another
 * modification. It is *not* sufficient to just use `waitUntilAvailable` or `waitUntilDurable` between modifications if
 * they happen on different stores/dumps, as these only guarantee availability on the current client. It would
 * theoretically be enough to use `waitUntilReplicated` instead of `requiresSeq`, but this would incur a higher latency.
 */
export type LowLevelDatabase = Database & {
  declareKvStore(id: string): LowLevelKvStore;
  declareKvDump(id: string): LowLevelKvDump;
  debugSnapshot?(): Promise<LowLevelDatabaseDebugSnapshot>;
};

export type LowLevelDatabaseDebugEntry = {
  keyBase64: string,
  keyUtf8: string | null,
  keyHex: string,
  valueBase64: string,
  valueUtf8: string | null,
  valueByteLength: number,
};

export type LowLevelDatabaseDebugSnapshot = {
  stores: Record<string, LowLevelDatabaseDebugEntry[]>,
  dumps: Record<string, LowLevelDatabaseDebugEntry[]>,
};

export type LowLevelMutationOptions = {
  /**
   * Establishes a causal dependency from an earlier mutation to this one. The backend may
   * satisfy the dependency by committing both mutations atomically, but must not make or
   * replicate this mutation before the required mutation.
   *
   * Waiting locally between mutations is not equivalent:
   *
   *     const { seq: a } = await firstStore.setAll(firstEntries);
   *     await database.waitUntilAvailable(a);
   *     const { seq: b } = await secondStore.setAll(secondEntries);
   *     await database.waitUntilAvailable(b);
   *
   * Because stores replicate independently, another client could still observe `b` without
   * observing `a`. The causal relationship must be attached to the second mutation:
   *
   *     const { seq: a } = await firstStore.setAll(firstEntries);
   *     const { seq: b } = await secondStore.setAll(secondEntries, { requiresSeq: a });
   *     await database.waitUntilAvailable(b);
   *
   * An explicit wait is still necessary when application code must inspect the first
   * mutation's available result before it can construct the second mutation.
   */
  requiresSeq?: DatabaseSeq,
};

/**
 * A simple KV store.
 *
 * Keys must be <= 64 bytes and value must be <= 2 GB. These restrictions should be strictly enforced by the
 * implementation.
 *
 * Durability and replication of a mutation are guaranteed independently by `waitUntilDurable(seq)` and
 * `waitUntilReplicated(seq)`. Use `waitUntilConsistent(seq)` when both guarantees are required.
 *
 * Wrapped stores used by the instant-availability implementation must allocate their returned sequence (and dump
 * keys) locally, before any asynchronous commit or IO. Commit completion remains asynchronous and is represented by
 * the returned sequence's availability barrier.
 */
export type LowLevelKvStore = {
  get(key: ArrayBuffer): Promise<{ buffer: ArrayBuffer | null, seq: DatabaseSeq }>,
  /**
   * Lists at most `limit` entries in ascending bytewise key order (default 1000), beginning
   * strictly after `startAfter`. `hasMore` indicates that at least one entry exists after the
   * final returned entry, so callers can safely use that entry's key as the next cursor.
   */
  listEntries(options?: { startAfter?: ArrayBuffer, limit?: number }): Promise<{
    entries: Array<{ key: ArrayBuffer, value: ArrayBuffer }>,
    hasMore: boolean,
  }>,
  setAll(entries: Array<{ key: ArrayBuffer, value: ArrayBuffer }>, options?: LowLevelMutationOptions): Promise<{ seq: DatabaseSeq }>,
  deleteAll(keys: ArrayBuffer[], options?: LowLevelMutationOptions): Promise<{ seq: DatabaseSeq }>,

  /**
   * The returned sequence must cover every successful entry, not just one of them.
   * `results[i]` corresponds to `entries[i]`. Failed entries have no sequence because
   * they did not write. When nothing is written, the returned sequence is
   * `options.requiresSeq` or the store's initial sequence. `compare: null` succeeds
   * only when the key does not exist. A batch must not contain duplicate keys.
   */
  compareAndSetAll(entries: Array<{ key: ArrayBuffer, compare: ArrayBuffer | null, value: ArrayBuffer }>, options?: LowLevelMutationOptions): Promise<{
    results: Array<{ wasSet: true, seq: DatabaseSeq } | { wasSet: false, seq: null }>,
    seq: DatabaseSeq,
  }>,
  debugEntries?(): Promise<LowLevelDatabaseDebugEntry[]>,
}

/**
 * A KV dump. It is like a KV store, but values are immutable while their entries exist; therefore, instead of exposing
 * a `setAll` function, it exposes an `insertAll` function. Entries may still be removed with `deleteAll`, for example
 * when garbage collection proves that an immutable value is unreachable.
 *
 * If values are never modified, then a KV dump can be significantly more efficient than a KV store, especially in a
 * distributed setting.
 *
 *
 * Keys must be <= 64 bytes and value must be <= 2 GB. These restrictions should be strictly enforced by the
 * implementation.
 *
 * Note that durability of a modifying function is only guaranteed after `waitUntilDurable(seq)` for either the returned
 * `seq` or a `seq` that's greater (determined using `maxSeq`).
 */
export type LowLevelKvDump = Omit<LowLevelKvStore, "setAll" | "compareAndSetAll"> & {
  /**
   * Reserves unique keys without inserting values. Unused reservations may be abandoned.
   */
  reserveKeys(count: number): ArrayBuffer[],

  /**
   * Inserts the values and returns their keys in the same order.
   *
   * How the keys are assigned is implementation-dependent, although they must always be unique within a single KV dump.
   * Implementations are encouraged to use keys that make the insert operation as performant as possible.
   * Reserved keys may be supplied when values must refer to one another before insertion.
   */
  insertAll(values: ArrayBuffer[], options?: LowLevelMutationOptions & { keys?: ArrayBuffer[] }): Promise<{ keys: ArrayBuffer[], seq: DatabaseSeq }>,
}
