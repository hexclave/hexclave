import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { MarshalError, badRequest } from "./errors.js";

const TAR_BLOCK_SIZE = 512;
const MAX_SOURCE_ENTRIES = 50_000;
export const MAX_UNCOMPRESSED_SOURCE_BYTES = 256 * 1024 * 1024;

// How much zero padding may follow the two-block end marker. GNU tar's default block factor
// is 20 blocks (10KiB); 1MiB is generous for any archiver while keeping the terminal all-zero
// scan short enough not to matter. See the check in validateUncompressedSourceTar.
const MAX_TERMINAL_PADDING_BYTES = 1024 * 1024;

// How many archives may be inflated at once, process-wide.
//
// Marshal is a single shared process serving every tenant, and an inflation holds
// both the compressed upload and its expansion in memory at the same time — up to
// MAX_UPLOAD_BYTES + MAX_UNCOMPRESSED_SOURCE_BYTES each. Unbounded concurrency
// let a handful of simultaneous but entirely VALID deploys add up to gigabytes,
// which is a resource fault rather than a rejected request: the reconciliation
// lease heartbeats and every other tenant's requests are served by this process.
// Two at a time bounds the peak while still overlapping the S3 reads around them.
const MAX_CONCURRENT_INFLATIONS = 2;
// Requests wait before downloading their source object, so queued work retains only a
// callback rather than a compressed archive. The queue is still bounded: otherwise a burst
// of distinct deployment sources can occupy every HTTP request slot indefinitely even
// though the inflation memory itself is bounded.
const MAX_QUEUED_INFLATIONS = 25;

const gunzipAsync = promisify(gunzip);

let activeInflations = 0;
const waitingInflations: (() => void)[] = [];

async function acquireInflationSlot(): Promise<void> {
  if (activeInflations < MAX_CONCURRENT_INFLATIONS) {
    activeInflations++;
    return;
  }
  if (waitingInflations.length >= MAX_QUEUED_INFLATIONS) {
    throw new MarshalError(503, "source_validation_saturated", "source archive validation is saturated; retry the deployment shortly");
  }
  await new Promise<void>((resolve) => waitingInflations.push(resolve));
  // releaseInflationSlot transfers an existing permit directly to this waiter. Incrementing
  // here would briefly advertise a free slot before this continuation ran, letting a new
  // caller take it and then pushing active work above MAX_CONCURRENT_INFLATIONS.
}

function releaseInflationSlot(): void {
  const next = waitingInflations.shift();
  if (next !== undefined) {
    next();
    return;
  }
  activeInflations--;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const value = readString(block, offset, length).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) throw badRequest("invalid source archive: malformed tar header");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw badRequest("invalid source archive: tar field is too large");
  return parsed;
}

function validateEntryPath(path: string): void {
  // Only accept the normalized relative paths emitted by the Hexclave CLI. Rejecting every
  // extension/link type makes extraction safe even though the builder container runs as root.
  // eslint-disable-next-line no-control-regex
  if (path === "" || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f]/.test(path)
    || path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    throw badRequest(`invalid source archive: unsafe entry path ${JSON.stringify(path)}`);
  }
}

export function validateUncompressedSourceTar(bytes: Uint8Array): void {
  let offset = 0;
  let entries = 0;
  let totalBytes = 0;
  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every(byte => byte === 0)) {
      // The trailing padding is BOUNDED before it is scanned. A tar ends in two zero blocks,
      // and archivers pad to a block factor beyond that — but a zero run compresses to almost
      // nothing, so a ~50KB upload can legitimately inflate to MAX_UNCOMPRESSED_SOURCE_BYTES
      // of zeros. Verifying it with `.every` over all of that is a synchronous per-byte walk
      // on the event loop, which stalls every other tenant's request in this process. There
      // is no reason to accept it: refuse the oversized padding outright and only then scan.
      const trailing = bytes.length - offset;
      if (trailing > MAX_TERMINAL_PADDING_BYTES) {
        throw badRequest(`invalid source archive: more than ${MAX_TERMINAL_PADDING_BYTES} bytes follow the end marker`);
      }
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw badRequest("invalid source archive: data follows the end marker");
      return;
    }
    if (readString(header, 257, 6) !== "ustar") throw badRequest("invalid source archive: not a ustar archive");

    let expectedChecksum = 0;
    for (let index = 0; index < TAR_BLOCK_SIZE; index++) {
      expectedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (readOctal(header, 148, 8) !== expectedChecksum) throw badRequest("invalid source archive: tar header checksum mismatch");

    const type = header[156];
    if (type !== 0 && type !== 0x30 && type !== 0x35) {
      throw badRequest("invalid source archive: only regular files and directories are supported");
    }
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    validateEntryPath(type === 0x35 && path.endsWith("/") ? path.slice(0, -1) : path);

    const size = readOctal(header, 124, 12);
    if (type === 0x35 && size !== 0) throw badRequest("invalid source archive: directory entry has data");
    entries++;
    totalBytes += size;
    if (entries > MAX_SOURCE_ENTRIES) throw badRequest(`source archive contains too many entries (maximum ${MAX_SOURCE_ENTRIES})`);
    if (totalBytes > MAX_UNCOMPRESSED_SOURCE_BYTES) throw badRequest(`source archive contents exceed ${MAX_UNCOMPRESSED_SOURCE_BYTES} bytes`);

    offset += TAR_BLOCK_SIZE;
    if (offset + size > bytes.length) throw badRequest("invalid source archive: truncated file data");
    offset += size + ((TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
  }
  throw badRequest("invalid source archive: missing end marker");
}

/**
 * Inflates and structurally validates an uploaded source archive.
 *
 * ASYNC, and deliberately so: the previous gunzipSync ran the whole inflation —
 * as much as MAX_UNCOMPRESSED_SOURCE_BYTES of it — on the event loop, so one
 * large but perfectly valid archive stalled reconciliation, lease heartbeats and
 * every concurrent request for its duration. zlib's callback form does the work
 * on the libuv threadpool instead. The slot acquired around it bounds how many
 * can be in flight at once; see MAX_CONCURRENT_INFLATIONS.
 */
async function validateSourceArchiveWithAcquiredSlot(bytes: Uint8Array): Promise<void> {
  let uncompressed: Buffer;
  try {
    uncompressed = await gunzipAsync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_SOURCE_BYTES });
  } catch (error) {
    if (error instanceof Error) throw badRequest("invalid source archive: gzip decompression failed or exceeded the size limit");
    throw error;
  }
  validateUncompressedSourceTar(uncompressed);
}

export async function validateSourceArchive(bytes: Uint8Array): Promise<void> {
  await acquireInflationSlot();
  try {
    await validateSourceArchiveWithAcquiredSlot(bytes);
  } finally {
    releaseInflationSlot();
  }
}

/**
 * Loads an uploaded archive only after reserving the process-wide inflation capacity.
 * Keeping the slot around both the S3 read and decompression prevents queued requests from
 * each retaining a complete compressed upload while they wait for a decompressor.
 */
export async function loadAndValidateSourceArchive(load: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  await acquireInflationSlot();
  try {
    const bytes = await load();
    if (bytes === null) return null;
    await validateSourceArchiveWithAcquiredSlot(bytes);
    return bytes;
  } finally {
    releaseInflationSlot();
  }
}
