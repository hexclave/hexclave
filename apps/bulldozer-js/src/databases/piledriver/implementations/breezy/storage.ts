import { statSync } from "node:fs";
import { join } from "node:path";

/** Sizes of the given files in `directory`, skipping any that don't exist (yet). */
export function existingFileSizesInBytes(directory: string, fileNames: readonly string[]) {
  const fileNameToSizeInBytes = new Map<string, number>();
  for (const fileName of fileNames) {
    // One call, not existsSync + statSync, so a file deleted in between can't make this throw.
    const stats = statSync(join(directory, fileName), { throwIfNoEntry: false });
    if (stats !== undefined) fileNameToSizeInBytes.set(fileName, stats.size);
  }
  // A plain object, so /diagnostics and the activity log serialize it as JSON (a Map prints as {}).
  return Object.fromEntries(fileNameToSizeInBytes);
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

/** How much of an engine's file is free pages: space deleted data left behind that the file still holds. */
export type BreezyFreePageStats = {
  pageSizeBytes: number,
  totalPages: number,
  freePages: number,
  /** False when the file's format can't give free pages back without a full rebuild. */
  canRelease: boolean,
};

/** Giving free pages back to the operating system, which shrinks the file. Reading stats is O(1). */
export type BreezyFreePages = {
  stats(): BreezyFreePageStats,
  /** Synchronously gives back up to `maxPages` free pages and returns how many it gave back. */
  release(maxPages: number): number,
  /** Applies logged writes to the main file, which is when the file actually gets shorter. */
  checkpoint(): { busy: boolean, logFrames: number, checkpointedFrames: number },
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
  /** Null when the engine has no way to give free pages back. */
  freePages: BreezyFreePages | null,
  flush(): Promise<void>,
  close(): Promise<void>,
};
