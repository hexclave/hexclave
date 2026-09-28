// A minimal, dependency-free ustar (POSIX.1-1988) tarball writer/reader.
//
// Why hand-rolled: the `hexclave deploy` CLI packages a source directory into a
// tarball and the deployments runtime's builder unpacks it. Both ends
// are our own code, so we only need the ustar subset we produce ourselves
// (regular files + directories), and hand-rolling avoids adding an npm
// dependency to the CLI and backend. The reader is intentionally strict — it
// rejects anything our writer wouldn't produce (symlinks, PAX extensions,
// absolute or `..` paths) because on the backend it processes untrusted user
// uploads.

import { HexclaveAssertionError, StatusError } from "./errors";

const BLOCK_SIZE = 512;

export type TarEntry = {
  // Relative POSIX path, e.g. "src/index.ts". Directories end with "/".
  path: string,
  data: Uint8Array,
};

export type TarLimits = {
  maxEntries: number,
  maxTotalBytes: number,
};

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  if (value < 0 || !Number.isSafeInteger(value)) {
    throw new HexclaveAssertionError(`Invalid tar octal value: ${value}`);
  }
  const str = value.toString(8).padStart(length - 1, "0");
  if (str.length > length - 1) {
    throw new HexclaveAssertionError(`Tar octal value too large for field: ${value} (field length ${length})`);
  }
  for (let i = 0; i < str.length; i++) {
    header[offset + i] = str.charCodeAt(i);
  }
  // NUL terminator (field is left NUL-filled past the digits).
}

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) {
    throw new HexclaveAssertionError(`Tar string too long for field: ${value}`);
  }
  header.set(bytes, offset);
}

// Splits a path into (prefix, name) fitting ustar's 155+100 byte fields.
// Returns undefined if the path can't be represented.
function splitUstarPath(path: string): { prefix: string, name: string } | undefined {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length <= 100) {
    return { prefix: "", name: path };
  }
  // Find a "/" such that everything before it fits in prefix (<=155) and
  // everything after fits in name (<=100). Prefer the longest possible prefix.
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    const prefixLen = new TextEncoder().encode(prefix).length;
    const nameLen = new TextEncoder().encode(name).length;
    if (prefixLen <= 155 && nameLen > 0 && nameLen <= 100) {
      return { prefix, name };
    }
  }
  return undefined;
}

/**
 * Serializes entries into an (uncompressed) ustar tarball. Entries whose path
 * ends with "/" are written as directories and must have empty data.
 */
export function createTar(entries: TarEntry[]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..") || entry.path === "") {
      throw new HexclaveAssertionError(`Invalid tar entry path: ${JSON.stringify(entry.path)}`);
    }
    const isDirectory = entry.path.endsWith("/");
    if (isDirectory && entry.data.length > 0) {
      throw new HexclaveAssertionError(`Tar directory entry must have empty data: ${entry.path}`);
    }
    const split = splitUstarPath(entry.path) ?? throwPathTooLong(entry.path);
    const header = new Uint8Array(BLOCK_SIZE);
    writeString(header, 0, 100, split.name);
    writeOctal(header, 100, 8, isDirectory ? 0o755 : 0o644); // mode
    writeOctal(header, 108, 8, 0); // uid
    writeOctal(header, 116, 8, 0); // gid
    writeOctal(header, 124, 12, entry.data.length); // size
    writeOctal(header, 136, 12, 0); // mtime — fixed at 0 so tarballs are deterministic for identical input
    header[156] = isDirectory ? 0x35 /* '5' */ : 0x30 /* '0' */; // typeflag
    writeString(header, 257, 6, "ustar");
    header[263] = 0x30; // version "00"
    header[264] = 0x30;
    writeString(header, 345, 155, split.prefix);
    // Checksum: sum of all header bytes with the checksum field as spaces.
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.fill(0, 148, 156);
    writeOctal(header, 148, 7, checksum);
    header[155] = 0x20;
    chunks.push(header);
    if (entry.data.length > 0) {
      chunks.push(entry.data);
      const padding = (BLOCK_SIZE - (entry.data.length % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding > 0) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(2 * BLOCK_SIZE)); // end-of-archive marker
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function throwPathTooLong(path: string): never {
  throw new StatusError(400, `File path too long to be packaged: ${JSON.stringify(path)}`);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const str = readString(block, offset, length).trim();
  if (str === "") return 0;
  if (!/^[0-7]+$/.test(str)) {
    throw new StatusError(400, "Invalid tarball: malformed octal header field");
  }
  return parseInt(str, 8);
}

/**
 * Parses an (uncompressed) ustar tarball produced by `createTar` (or any tool
 * emitting the plain ustar subset). Strict by design — see module comment.
 * Directory entries are returned with a trailing "/" and empty data.
 *
 * Throws `StatusError(400, ...)` on malformed or unsafe input so backend routes
 * can surface it directly to the uploader.
 */
export function parseTar(bytes: Uint8Array, limits: TarLimits): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset + BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) {
      // End-of-archive marker (we accept a single zero block too).
      return entries;
    }
    const magic = readString(header, 257, 6);
    if (magic !== "ustar") {
      throw new StatusError(400, "Invalid tarball: not a ustar archive");
    }
    let expectedChecksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      expectedChecksum += (i >= 148 && i < 156) ? 0x20 : header[i];
    }
    if (readOctal(header, 148, 8) !== expectedChecksum) {
      throw new StatusError(400, "Invalid tarball: header checksum mismatch");
    }
    const typeflag = header[156];
    if (typeflag !== 0x30 && typeflag !== 0 && typeflag !== 0x35) {
      throw new StatusError(400, "Invalid tarball: only regular files and directories are supported");
    }
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (path === "" || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) {
      throw new StatusError(400, `Invalid tarball: unsafe entry path ${JSON.stringify(path)}`);
    }
    const size = readOctal(header, 124, 12);
    const isDirectory = typeflag === 0x35;
    if (isDirectory && size !== 0) {
      throw new StatusError(400, "Invalid tarball: directory entry with non-zero size");
    }
    offset += BLOCK_SIZE;
    if (offset + size > bytes.length) {
      throw new StatusError(400, "Invalid tarball: truncated file data");
    }
    totalBytes += size;
    if (entries.length + 1 > limits.maxEntries) {
      throw new StatusError(400, `Tarball contains too many files (max ${limits.maxEntries})`);
    }
    if (totalBytes > limits.maxTotalBytes) {
      throw new StatusError(400, `Tarball contents too large (max ${limits.maxTotalBytes} bytes)`);
    }
    entries.push({
      path: isDirectory && !path.endsWith("/") ? `${path}/` : path,
      data: bytes.slice(offset, offset + size),
    });
    offset += size + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
  }
  throw new StatusError(400, "Invalid tarball: missing end-of-archive marker");
}

const TEST_LIMITS: TarLimits = { maxEntries: 1000, maxTotalBytes: 10 * 1024 * 1024 };

import.meta.vitest?.test("createTar/parseTar roundtrip", ({ expect }) => {
  const entries: TarEntry[] = [
    { path: "package.json", data: new TextEncoder().encode(`{"name":"x"}`) },
    { path: "src/", data: new Uint8Array(0) },
    { path: "src/index.ts", data: new TextEncoder().encode("export const a = 1;\n") },
    { path: "empty.txt", data: new Uint8Array(0) },
    { path: "binary.bin", data: new Uint8Array([0, 1, 2, 255, 254, 253]) },
  ];
  const tar = createTar(entries);
  expect(tar.length % 512).toBe(0);
  const parsed = parseTar(tar, TEST_LIMITS);
  expect(parsed.map((e) => e.path)).toEqual(entries.map((e) => e.path));
  for (let i = 0; i < entries.length; i++) {
    expect([...parsed[i].data]).toEqual([...entries[i].data]);
  }
});

import.meta.vitest?.test("createTar/parseTar long paths use the ustar prefix field", ({ expect }) => {
  const longDir = Array.from({ length: 12 }, (_, i) => `directory-number-${i}`).join("/");
  const path = `${longDir}/file.txt`;
  expect(path.length).toBeGreaterThan(100);
  const tar = createTar([{ path, data: new TextEncoder().encode("hello") }]);
  const parsed = parseTar(tar, TEST_LIMITS);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].path).toBe(path);
  expect(new TextDecoder().decode(parsed[0].data)).toBe("hello");
});

import.meta.vitest?.test("createTar rejects unsafe paths", ({ expect }) => {
  expect(() => createTar([{ path: "/etc/passwd", data: new Uint8Array(0) }])).toThrow();
  expect(() => createTar([{ path: "../escape", data: new Uint8Array(0) }])).toThrow();
  expect(() => createTar([{ path: "a/../b", data: new Uint8Array(0) }])).toThrow();
  expect(() => createTar([{ path: "", data: new Uint8Array(0) }])).toThrow();
});

import.meta.vitest?.test("parseTar rejects malformed and unsafe archives", ({ expect }) => {
  expect(() => parseTar(new Uint8Array(1024), TEST_LIMITS)).not.toThrow(); // all-zero = empty archive
  expect(() => parseTar(new TextEncoder().encode("too short to contain a single header block"), TEST_LIMITS)).toThrow("missing end-of-archive marker");
  const garbageBlock = new Uint8Array(512).fill(0x41 /* 'A' */);
  expect(() => parseTar(garbageBlock, TEST_LIMITS)).toThrow("not a ustar archive");

  // Corrupt a valid archive's checksum.
  const tar = createTar([{ path: "a.txt", data: new TextEncoder().encode("hi") }]);
  const corrupted = tar.slice();
  corrupted[0] ^= 0xff;
  expect(() => parseTar(corrupted, TEST_LIMITS)).toThrow("checksum mismatch");

  // Truncated data section.
  expect(() => parseTar(tar.subarray(0, 512), TEST_LIMITS)).toThrow("truncated");

  // Limits.
  expect(() => parseTar(tar, { maxEntries: 0, maxTotalBytes: 1000 })).toThrow("too many files");
  expect(() => parseTar(tar, { maxEntries: 10, maxTotalBytes: 1 })).toThrow("too large");
});
