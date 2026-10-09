/** Binary, versioned stores sharing one atomic write transaction and durability barrier. */
export type BreezyStore = {
  get(key: Uint8Array): Buffer | undefined,
  getEntry(key: Uint8Array): { value: Buffer, version: number } | undefined,
  doesExist(key: Uint8Array): boolean,
  put(key: Uint8Array, value: Buffer, version: number): Promise<boolean>,
  remove(key: Uint8Array): Promise<boolean>,
  /** Unsigned bytewise order; end is exclusive. */
  getRange(options?: { end?: Uint8Array, limit?: number }): Iterable<{ key: Uint8Array, value: Buffer }>,
};

export type BreezyStorage = {
  backend: string,
  openStore(name: string): BreezyStore,
  /** Callback is synchronous. See storage.test.ts for engine rollback guarantees. */
  transaction<T>(action: (version: number) => T): Promise<T>,
  lastTransactionId(): number,
  refreshReads(): void,
  flush(): Promise<void>,
  close(): Promise<void>,
};
