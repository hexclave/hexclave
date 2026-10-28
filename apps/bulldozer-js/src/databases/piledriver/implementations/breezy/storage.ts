import { statSync } from "node:fs";
import { join } from "node:path";

/** Sizes of the given files in `directory`, skipping any that don't exist (yet). */
export function existingFileSizesInBytes(directory: string, fileNames: readonly string[]) {
  const sizes: Record<string, number> = {};
  for (const fileName of fileNames) {
    // One call, not existsSync + statSync, so a file deleted in between can't make this throw.
    const stats = statSync(join(directory, fileName), { throwIfNoEntry: false });
    if (stats !== undefined) sizes[fileName] = stats.size;
  }
  return sizes;
}

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
  /** Size of each of this engine's files on disk, by file name, for diagnostics. */
  fileSizesInBytes(): Record<string, number>,
  flush(): Promise<void>,
  close(): Promise<void>,
};
