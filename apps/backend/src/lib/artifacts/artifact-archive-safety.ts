import { gunzipSync } from "node:zlib";
import { parseTar, type TarEntry } from "@hexclave/shared/dist/utils/tar";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { ArtifactServiceError } from "./artifact-errors";
import { MAX_ARTIFACT_PATH_BYTES } from "./artifact-manifest";

export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export type ArtifactArchiveEntry = {
  path: string,
  kind: "file" | "directory",
  byteLength: number,
};

export type ValidatedArtifactArchiveEntry = ArtifactArchiveEntry & {
  path: string,
};

export function validateArtifactArchiveEntries(
  entries: readonly ArtifactArchiveEntry[],
  limits: { maxEntries?: number, maxBytes?: number } = {},
): readonly ValidatedArtifactArchiveEntry[] {
  const maxEntries = limits.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const maxBytes = limits.maxBytes ?? MAX_ARCHIVE_BYTES;
  if (entries.length > maxEntries) {
    throw invalidArchive(`Artifact archive contains too many entries (max ${maxEntries}).`);
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  const validated: ValidatedArtifactArchiveEntry[] = [];
  for (const entry of entries) {
    const kind = String(entry.kind);
    if (kind !== "file" && kind !== "directory") {
      throw invalidArchive("Artifact archives may contain only regular files and directories.");
    }
    const path = normalizeArchivePath(entry.path, kind === "directory");
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      throw invalidArchive(`Artifact archive entry ${JSON.stringify(path)} has an invalid byte length.`);
    }
    if (kind === "directory" && entry.byteLength !== 0) {
      throw invalidArchive(`Artifact archive directory ${JSON.stringify(path)} has non-zero contents.`);
    }
    if (paths.has(path)) {
      throw invalidArchive(`Artifact archive contains duplicate entry ${JSON.stringify(path)}.`);
    }
    paths.add(path);
    totalBytes += entry.byteLength;
    if (totalBytes > maxBytes) {
      throw invalidArchive(`Artifact archive contents exceed ${maxBytes} bytes.`);
    }
    validated.push({ path, kind: kind === "directory" ? "directory" : "file", byteLength: entry.byteLength });
  }
  return validated;
}

export function validateGzipTarArtifactArchive(
  bytes: Uint8Array,
  limits: { maxEntries?: number, maxBytes?: number } = {},
): readonly ValidatedArtifactArchiveEntry[] {
  const maxBytes = limits.maxBytes ?? MAX_ARCHIVE_BYTES;
  let tarBytes: Buffer;
  try {
    tarBytes = gunzipSync(bytes, { maxOutputLength: maxBytes });
  } catch {
    throw invalidArchive("Artifact archive is not a valid gzip stream or exceeds the unpacked size limit.");
  }

  let entries: TarEntry[];
  try {
    entries = parseTar(tarBytes, {
      maxEntries: limits.maxEntries ?? MAX_ARCHIVE_ENTRIES,
      maxTotalBytes: maxBytes,
    });
  } catch (error) {
    if (error instanceof StatusError && error.statusCode === 400) {
      const safeMessages = new Set([
        "Invalid tarball: not a ustar archive",
        "Invalid tarball: header checksum mismatch",
        "Invalid tarball: malformed octal header field",
        "Invalid tarball: missing end-of-archive marker",
        "Invalid tarball: only regular files and directories are supported",
        "Invalid tarball: directory entry with non-zero size",
      ]);
      if (safeMessages.has(error.message)) throw invalidArchive(`Artifact archive is not a safe ustar archive: ${error.message}`);
      if (/^(?:Tarball contains too many files|Tarball contents too large|Invalid tarball: truncated)/u.test(error.message)) {
        throw invalidArchive(`Artifact archive is not a safe ustar archive: ${error.message}`);
      }
    }
    throw invalidArchive("Artifact archive is not a safe ustar archive.");
  }
  return validateArtifactArchiveEntries(entries.map((entry) => ({
    path: entry.path,
    kind: entry.path.endsWith("/") ? "directory" : "file",
    byteLength: entry.data.byteLength,
  })), limits);
}

function normalizeArchivePath(value: string, directory: boolean): string {
  const withoutDirectoryMarker = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (withoutDirectoryMarker.length === 0 || withoutDirectoryMarker.length > MAX_ARTIFACT_PATH_BYTES) {
    throw invalidArchive("Artifact archive entry path is empty or too long.");
  }
  if (Buffer.byteLength(withoutDirectoryMarker, "utf8") > MAX_ARTIFACT_PATH_BYTES) {
    throw invalidArchive("Artifact archive entry path is too long.");
  }
  if (withoutDirectoryMarker.includes("\\") || withoutDirectoryMarker.startsWith("/") || /^[a-zA-Z]:\//u.test(withoutDirectoryMarker)) {
    throw invalidArchive(`Artifact archive entry path ${JSON.stringify(value)} is not relative POSIX.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(withoutDirectoryMarker)) {
    throw invalidArchive("Artifact archive entry path contains control characters.");
  }
  const segments = withoutDirectoryMarker.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidArchive(`Artifact archive entry path ${JSON.stringify(value)} contains unsafe segments.`);
  }
  return withoutDirectoryMarker;
}

function invalidArchive(message: string): ArtifactServiceError {
  return new ArtifactServiceError("invalid_archive", message);
}
