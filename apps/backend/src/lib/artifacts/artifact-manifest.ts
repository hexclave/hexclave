import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { createHash } from "node:crypto";
import { ArtifactServiceError } from "./artifact-errors";

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;

export const MAX_ARTIFACT_COUNT = 10_000;
export const MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const MAX_SOURCE_MAP_BYTES = 100 * 1024 * 1024;
export const MAX_SOURCE_MAP_GZIPPED_BYTES = 50 * 1024 * 1024;
export const MAX_METADATA_BYTES = 256;
// Match the release catalog's limits so a finalized manifest can always be projected.
export const MAX_RELEASE_BYTES = 250;
export const MAX_DIST_BYTES = 64;
export const MAX_ENVIRONMENT_BYTES = 255;
export const MAX_ARTIFACT_PATH_BYTES = 1_024;

const SHA256_RE = /^[a-f0-9]{64}$/;
export const DEBUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ArtifactScope = {
  tenantId: string,
  projectId: string,
  branchId: string,
};

export type ArtifactManifestArtifact = {
  debugId: string,
  codeFile: string,
  sourceMapFile: string | null,
  sourceMapInline: boolean,
  bundleSha256: string,
  bundleBytes: number,
  sourceMapSha256: string,
  sourceMapBytes: number,
  sourceMapGzippedBytes: number,
};

export type ArtifactManifest = {
  schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION,
  projectId: string,
  release: string | null,
  dist: string | null,
  environment: string | null,
  artifacts: readonly ArtifactManifestArtifact[],
};

export type ValidatedArtifactManifest = {
  manifest: ArtifactManifest,
  manifestJson: string,
  manifestSha256: string,
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateArtifactScope(scope: ArtifactScope): ArtifactScope {
  return {
    tenantId: validateScopePart(scope.tenantId, "tenantId"),
    projectId: validateScopePart(scope.projectId, "projectId"),
    branchId: validateScopePart(scope.branchId, "branchId"),
  };
}

export function normalizeArtifactPath(value: string, label = "Artifact path"): string {
  if (value.length === 0 || value.length > MAX_ARTIFACT_PATH_BYTES) {
    throw invalidManifest(`${label} must be between 1 and ${MAX_ARTIFACT_PATH_BYTES} characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_PATH_BYTES) {
    throw invalidManifest(`${label} must be at most ${MAX_ARTIFACT_PATH_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidManifest(`${label} must not contain control characters.`);
  }
  if (value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:\//u.test(value)) {
    throw invalidManifest(`${label} must be a relative POSIX path.`);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(value)) {
    throw invalidManifest(`${label} must not be a URL.`);
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidManifest(`${label} must not contain empty, ".", or ".." path segments.`);
  }
  return value;
}

export function validateArtifactManifest(input: unknown, scopeInput: ArtifactScope): ValidatedArtifactManifest {
  const scope = validateArtifactScope(scopeInput);
  const record = asRecord(input, "Artifact manifest");
  const schemaVersion = readRequiredInteger(record, "schemaVersion", "Artifact manifest schemaVersion");
  if (schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    throw invalidManifest(`Unsupported artifact manifest schema version ${schemaVersion}.`);
  }

  const projectId = readRequiredString(record, "projectId", "Artifact manifest projectId");
  if (projectId !== scope.projectId) {
    throw invalidManifest("Artifact manifest projectId does not match the authenticated project.");
  }

  const release = validateArtifactMetadata(record.release, "Artifact manifest release", MAX_RELEASE_BYTES);
  if (release !== null && (release === "." || release === ".." || release.toLowerCase() === "latest")) {
    throw invalidManifest("Artifact manifest release must not be '.', '..', or 'latest'.");
  }
  const dist = validateArtifactMetadata(record.dist, "Artifact manifest dist", MAX_DIST_BYTES);
  const environment = validateArtifactMetadata(record.environment, "Artifact manifest environment", MAX_ENVIRONMENT_BYTES);
  if (dist !== null && release === null) {
    throw invalidManifest("Artifact manifest dist requires a release.");
  }

  const artifactsValue = record.artifacts;
  if (!Array.isArray(artifactsValue) || artifactsValue.length === 0) {
    throw invalidManifest("Artifact manifest artifacts must be a non-empty array.");
  }
  if (artifactsValue.length > MAX_ARTIFACT_COUNT) {
    throw invalidManifest(`Artifact manifest contains too many artifacts (max ${MAX_ARTIFACT_COUNT}).`);
  }

  const artifacts: ArtifactManifestArtifact[] = [];
  const codeFiles = new Set<string>();
  const debugIds = new Set<string>();
  let totalBytes = 0;
  for (const [index, value] of artifactsValue.entries()) {
    const artifact = validateArtifact(value, index);
    if (codeFiles.has(artifact.codeFile)) {
      throw invalidManifest(`Duplicate artifact codeFile ${JSON.stringify(artifact.codeFile)}.`);
    }
    if (debugIds.has(artifact.debugId)) {
      throw invalidManifest(`Duplicate artifact debugId ${artifact.debugId}.`);
    }
    codeFiles.add(artifact.codeFile);
    debugIds.add(artifact.debugId);
    totalBytes += artifact.bundleBytes + artifact.sourceMapBytes + artifact.sourceMapGzippedBytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      throw invalidManifest(`Artifact manifest contents exceed ${MAX_TOTAL_ARTIFACT_BYTES} bytes.`);
    }
    artifacts.push(artifact);
  }

  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    projectId,
    release,
    dist,
    environment,
    artifacts,
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestSha256 = sha256Hex(new TextEncoder().encode(manifestJson));
  return { manifest, manifestJson, manifestSha256 };
}

export function assertManifestDigest(expected: string, validated: ValidatedArtifactManifest): void {
  if (!SHA256_RE.test(expected) || expected !== validated.manifestSha256) {
    throw new ArtifactServiceError("manifest_conflict", "Artifact manifest digest does not match its canonical contents.");
  }
}

export function validateSha256(value: string, label: string): string {
  if (!SHA256_RE.test(value)) {
    throw invalidManifest(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function validateArtifactMetadata(value: unknown, label: string, maxBytes = MAX_METADATA_BYTES): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidManifest(`${label} must be a non-empty value of at most ${maxBytes} UTF-8 bytes without control characters.`);
  }
  return value;
}

export function validateDebugId(value: string, label = "debugId"): string {
  if (!DEBUG_ID_RE.test(value)) {
    throw invalidManifest(`${label} must be a lowercase hyphenated UUID.`);
  }
  return value;
}

function validateArtifact(value: unknown, index: number): ArtifactManifestArtifact {
  const record = asRecord(value, `Artifact manifest artifact ${index}`);
  const debugId = validateDebugId(readRequiredString(record, "debugId", `Artifact ${index} debugId`), `Artifact ${index} debugId`);
  const codeFile = normalizeArtifactPath(readRequiredString(record, "codeFile", `Artifact ${index} codeFile`), `Artifact ${index} codeFile`);
  const sourceMapFileValue = record.sourceMapFile;
  const sourceMapFile = sourceMapFileValue === null
    ? null
    : normalizeArtifactPath(readRequiredString(record, "sourceMapFile", `Artifact ${index} sourceMapFile`), `Artifact ${index} sourceMapFile`);
  const sourceMapInline = readRequiredBoolean(record, "sourceMapInline", `Artifact ${index} sourceMapInline`);
  if (sourceMapInline !== (sourceMapFile === null)) {
    throw invalidManifest(`Artifact ${index} sourceMapInline does not match sourceMapFile.`);
  }
  if (sourceMapFile === codeFile) {
    throw invalidManifest(`Artifact ${index} sourceMapFile must differ from codeFile.`);
  }

  const bundleSha256 = validateSha256(readRequiredString(record, "bundleSha256", `Artifact ${index} bundleSha256`), `Artifact ${index} bundleSha256`);
  const bundleBytes = readPositiveSafeInteger(record, "bundleBytes", `Artifact ${index} bundleBytes`, MAX_BUNDLE_BYTES);
  const sourceMapSha256 = validateSha256(readRequiredString(record, "sourceMapSha256", `Artifact ${index} sourceMapSha256`), `Artifact ${index} sourceMapSha256`);
  const sourceMapBytes = readPositiveSafeInteger(record, "sourceMapBytes", `Artifact ${index} sourceMapBytes`, MAX_SOURCE_MAP_BYTES);
  const sourceMapGzippedBytes = readPositiveSafeInteger(record, "sourceMapGzippedBytes", `Artifact ${index} sourceMapGzippedBytes`, MAX_SOURCE_MAP_GZIPPED_BYTES);

  return {
    debugId,
    codeFile,
    sourceMapFile,
    sourceMapInline,
    bundleSha256,
    bundleBytes,
    sourceMapSha256,
    sourceMapBytes,
    sourceMapGzippedBytes,
  };
}

function validateScopePart(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_METADATA_BYTES) {
    throw invalidManifest(`Artifact ${label} must be a non-empty value of at most ${MAX_METADATA_BYTES} characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_METADATA_BYTES || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    throw invalidManifest(`Artifact ${label} contains unsafe characters.`);
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw invalidManifest(`${label} must be a non-empty string.`);
  return value;
}

function readRequiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw invalidManifest(`${label} must be a boolean.`);
  return value;
}

function readRequiredInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidManifest(`${label} must be a safe integer.`);
  return value;
}

function readPositiveSafeInteger(record: Record<string, unknown>, key: string, label: string, max: number): number {
  const value = readRequiredInteger(record, key, label);
  if (value <= 0 || value > max) throw invalidManifest(`${label} must be between 1 and ${max}.`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidManifest(`${label} must be an object.`);
  }
  return value;
}


function invalidManifest(message: string): ArtifactServiceError {
  return new ArtifactServiceError("invalid_manifest", message);
}
