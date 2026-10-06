import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { gunzipSync } from "node:zlib";
import {
  assertManifestDigest,
  sha256Hex,
  validateArtifactMetadata,
  validateArtifactManifest,
  validateArtifactScope,
  validateDebugId,
  validateSha256,
  type ArtifactManifest,
  type ArtifactManifestArtifact,
  type ArtifactScope,
  type ValidatedArtifactManifest,
} from "./artifact-manifest";
import { ArtifactServiceError } from "./artifact-errors";
import { parseStandardSourceMap } from "../symbolication/javascript-symbolication";
import {
  createS3ArtifactObjectStorage,
  type ArtifactObjectStorage,
  type ArtifactStorageObject,
  type ArtifactUploadContentType,
} from "./artifact-storage";

const ARTIFACT_STORAGE_SCHEMA_VERSION = 1 as const;
const MANIFEST_CONTENT_TYPE: ArtifactUploadContentType = "application/json";
const BUNDLE_CONTENT_TYPE: ArtifactUploadContentType = "application/javascript";
const SOURCE_MAP_CONTENT_TYPE: ArtifactUploadContentType = "application/json";

export type ArtifactManifestRegistrationRequest = {
  manifest: unknown,
  manifestSha256: string,
};

export type ArtifactUploadDescriptor = {
  debugId: string,
  codeFile: string,
  sourceMapFile: string | null,
  bundleObjectKey: string,
  bundleUploadUrl: string,
  sourceMapObjectKey: string | null,
  sourceMapUploadUrl: string | null,
  alreadyFinalized: boolean,
};

export type ArtifactManifestRegistrationResult = {
  manifestSha256: string,
  status: "registered" | "already_registered",
  finalizePath: "/api/latest/source-maps/artifacts/finalize",
  artifacts: readonly ArtifactUploadDescriptor[],
};

export type ArtifactManifestFinalizeRequest = {
  manifestSha256: string,
};

export type ArtifactManifestFinalizeResult = {
  manifestSha256: string,
  status: "finalized" | "already_finalized",
  uploaded: readonly string[],
  alreadyUploaded: readonly string[],
};

export type FinalizedManifestArtifact = {
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

export type FinalizedManifest = {
  manifestSha256: string,
  release: string | null,
  dist: string | null,
  environment: string | null,
  artifacts: readonly FinalizedManifestArtifact[],
};

export type ArtifactLookup = {
  manifestSha256: string,
  release: string | null,
  dist: string | null,
  environment: string | null,
  artifact: ArtifactManifestArtifact,
  bundleObjectKey: string,
  sourceMapObjectKey: string | null,
};

type StoredManifestRecord = {
  schemaVersion: typeof ARTIFACT_STORAGE_SCHEMA_VERSION,
  scope: ArtifactScope,
  manifestSha256: string,
  manifest: ArtifactManifest,
};

type StoredArtifactIndexRecord = {
  schemaVersion: typeof ARTIFACT_STORAGE_SCHEMA_VERSION,
  scope: ArtifactScope,
  manifestSha256: string,
  release: string | null,
  dist: string | null,
  environment: string | null,
  artifact: ArtifactManifestArtifact,
  bundleObjectKey: string,
  sourceMapObjectKey: string | null,
};

type StoredFinalizeRecord = {
  schemaVersion: typeof ARTIFACT_STORAGE_SCHEMA_VERSION,
  manifestSha256: string,
  artifactDebugIds: readonly string[],
};

export class ArtifactUploadService {
  public constructor(private readonly storage: ArtifactObjectStorage) {}

  public static production(): ArtifactUploadService {
    return new ArtifactUploadService(createS3ArtifactObjectStorage());
  }

  public async registerManifest(
    scopeInput: ArtifactScope,
    request: ArtifactManifestRegistrationRequest,
  ): Promise<ArtifactManifestRegistrationResult> {
    const scope = validateArtifactScope(scopeInput);
    const validated = validateArtifactManifest(request.manifest, scope);
    assertManifestDigest(request.manifestSha256, validated);

    const manifestKey = getManifestObjectKey(scope, validated.manifestSha256);
    const manifestRecord = createManifestRecord(scope, validated);
    const manifestBody = jsonBytes(manifestRecord);
    const wasCreated = await putImmutableAndVerify(this.storage, {
      key: manifestKey,
      body: manifestBody,
      contentType: MANIFEST_CONTENT_TYPE,
    });
    const finalizeKey = getFinalizeObjectKey(scope, validated.manifestSha256);
    const alreadyFinalized = await this.storage.headObject(finalizeKey) !== null;

    const artifacts = await Promise.all(validated.manifest.artifacts.map(async (artifact) => {
      const bundleObjectKey = getContentObjectKey(scope, "bundle", artifact.bundleSha256);
      const sourceMapObjectKey = artifact.sourceMapInline
        ? null
        : getContentObjectKey(scope, "source-map", artifact.sourceMapSha256);
      const [bundleUploadUrl, sourceMapUploadUrl] = await Promise.all([
        this.storage.createUploadUrl({
          key: bundleObjectKey,
          contentType: BUNDLE_CONTENT_TYPE,
        }),
        sourceMapObjectKey === null
          ? Promise.resolve(null)
          : this.storage.createUploadUrl({
            key: sourceMapObjectKey,
            contentType: SOURCE_MAP_CONTENT_TYPE,
            contentEncoding: "gzip",
          }),
      ]);
      return {
        debugId: artifact.debugId,
        codeFile: artifact.codeFile,
        sourceMapFile: artifact.sourceMapFile,
        bundleObjectKey,
        bundleUploadUrl,
        sourceMapObjectKey,
        sourceMapUploadUrl,
        alreadyFinalized,
      } satisfies ArtifactUploadDescriptor;
    }));

    return {
      manifestSha256: validated.manifestSha256,
      status: wasCreated ? "registered" : "already_registered",
      finalizePath: "/api/latest/source-maps/artifacts/finalize",
      artifacts,
    };
  }

  public async finalizeManifest(
    scopeInput: ArtifactScope,
    request: ArtifactManifestFinalizeRequest,
  ): Promise<ArtifactManifestFinalizeResult> {
    const scope = validateArtifactScope(scopeInput);
    const manifestSha256 = validateSha256(request.manifestSha256, "manifestSha256");
    const manifestKey = getManifestObjectKey(scope, manifestSha256);
    const manifestBytes = await this.storage.readObject(manifestKey);
    if (manifestBytes === null) {
      throw new ArtifactServiceError("manifest_not_found", "Artifact manifest has not been registered.");
    }

    const storedManifest = readStoredManifestRecord(manifestBytes, scope);
    if (storedManifest.manifestSha256 !== manifestSha256) {
      throw new ArtifactServiceError("manifest_conflict", "Stored artifact manifest identity does not match the requested digest.");
    }
    const validated = validateArtifactManifest(storedManifest.manifest, scope);
    assertManifestDigest(manifestSha256, validated);

    const finalizeKey = getFinalizeObjectKey(scope, manifestSha256);
    const wasAlreadyFinalized = await this.storage.headObject(finalizeKey) !== null;
    for (const artifact of validated.manifest.artifacts) {
      const bundleObjectKey = getContentObjectKey(scope, "bundle", artifact.bundleSha256);
      const bundleBytes = await this.readAndVerifyObject(bundleObjectKey, artifact.bundleBytes, artifact.bundleSha256, "bundle");
      if (artifact.sourceMapInline) {
        const inlineMapBytes = readInlineSourceMap(bundleBytes);
        if (inlineMapBytes === null) {
          throw new ArtifactServiceError("integrity_mismatch", `Artifact ${artifact.debugId} does not contain its declared inline source map.`);
        }
        if (inlineMapBytes.byteLength !== artifact.sourceMapBytes || sha256Hex(inlineMapBytes) !== artifact.sourceMapSha256) {
          throw new ArtifactServiceError("integrity_mismatch", `Artifact ${artifact.debugId} inline source map does not match its manifest.`);
        }
        const inlineMapText = decodeStrictUtf8(inlineMapBytes);
        if (inlineMapText === null) {
          throw new ArtifactServiceError("integrity_mismatch", `Artifact ${artifact.debugId} inline source map is not valid UTF-8.`);
        }
        verifySourceMap(inlineMapText, artifact);
      } else {
        const sourceMapObjectKey = getContentObjectKey(scope, "source-map", artifact.sourceMapSha256);
        const compressedSourceMap = await this.readAndVerifyLengthOnly(sourceMapObjectKey, artifact.sourceMapGzippedBytes, "source map");
        let sourceMapBytes: Buffer;
        try {
          sourceMapBytes = gunzipSync(compressedSourceMap, { maxOutputLength: artifact.sourceMapBytes });
        } catch {
          throw new ArtifactServiceError("integrity_mismatch", `Artifact ${artifact.debugId} has an invalid compressed source map.`);
        }
        if (sourceMapBytes.byteLength !== artifact.sourceMapBytes || sha256Hex(sourceMapBytes) !== artifact.sourceMapSha256) {
          throw new ArtifactServiceError("integrity_mismatch", `Artifact ${artifact.debugId} source map digest does not match its manifest.`);
        }
        verifySourceMap(new TextDecoder().decode(sourceMapBytes), artifact);
      }
    }

    for (const artifact of validated.manifest.artifacts) {
      const bundleObjectKey = getContentObjectKey(scope, "bundle", artifact.bundleSha256);
      const sourceMapObjectKey = artifact.sourceMapInline
        ? null
        : getContentObjectKey(scope, "source-map", artifact.sourceMapSha256);
      const indexKey = getDebugIdIndexObjectKey(scope, artifact.debugId, validated.manifest.release, validated.manifest.dist);
      const indexRecord: StoredArtifactIndexRecord = {
        schemaVersion: ARTIFACT_STORAGE_SCHEMA_VERSION,
        scope,
        manifestSha256,
        release: validated.manifest.release,
        dist: validated.manifest.dist,
        environment: validated.manifest.environment,
        artifact,
        bundleObjectKey,
        sourceMapObjectKey,
      };
      await putImmutableAndVerify(this.storage, {
        key: indexKey,
        body: jsonBytes(indexRecord),
        contentType: MANIFEST_CONTENT_TYPE,
      }, "artifact_conflict");
    }

    const finalizeRecord: StoredFinalizeRecord = {
      schemaVersion: ARTIFACT_STORAGE_SCHEMA_VERSION,
      manifestSha256,
      artifactDebugIds: validated.manifest.artifacts.map((artifact) => artifact.debugId),
    };
    await putImmutableAndVerify(this.storage, {
      key: finalizeKey,
      body: jsonBytes(finalizeRecord),
      contentType: MANIFEST_CONTENT_TYPE,
    });

    const debugIds = validated.manifest.artifacts.map((artifact) => artifact.debugId);
    return {
      manifestSha256,
      status: wasAlreadyFinalized ? "already_finalized" : "finalized",
      uploaded: wasAlreadyFinalized ? [] : debugIds,
      alreadyUploaded: wasAlreadyFinalized ? debugIds : [],
    };
  }

  public async lookupArtifact(
    scopeInput: ArtifactScope,
    query: { debugId: string, release: string | null, dist: string | null },
  ): Promise<ArtifactLookup | null> {
    const scope = validateArtifactScope(scopeInput);
    const debugId = validateDebugId(query.debugId);
    const release = validateArtifactMetadata(query.release, "release");
    const dist = validateArtifactMetadata(query.dist, "dist");
    const indexKey = getDebugIdIndexObjectKey(scope, debugId, release, dist);
    const bytes = await this.storage.readObject(indexKey);
    if (bytes === null) return null;
    const record = readStoredIndexRecord(bytes, scope);
    if (record.manifestSha256.length === 0 || record.artifact.debugId !== debugId) {
      throw new ArtifactServiceError("integrity_mismatch", "Stored artifact debug-ID index is invalid.");
    }
    if (record.release !== release || record.dist !== dist) {
      throw new ArtifactServiceError("integrity_mismatch", "Stored artifact release lookup does not match the request.");
    }
    const finalizeBytes = await this.storage.readObject(getFinalizeObjectKey(scope, record.manifestSha256));
    if (finalizeBytes === null) return null;
    const finalizeRecord = readStoredFinalizeRecord(finalizeBytes);
    if (finalizeRecord.manifestSha256 !== record.manifestSha256
      || !finalizeRecord.artifactDebugIds.includes(debugId)) {
      throw new ArtifactServiceError("integrity_mismatch", "Stored artifact finalize marker does not match its debug-ID index.");
    }
    return {
      manifestSha256: record.manifestSha256,
      release: record.release,
      dist: record.dist,
      environment: record.environment,
      artifact: record.artifact,
      bundleObjectKey: record.bundleObjectKey,
      sourceMapObjectKey: record.sourceMapObjectKey,
    };
  }

  public async readFinalizedManifest(
    scopeInput: ArtifactScope,
    manifestSha256Input: string,
  ): Promise<FinalizedManifest> {
    const scope = validateArtifactScope(scopeInput);
    const manifestSha256 = validateSha256(manifestSha256Input, "manifestSha256");
    const finalizeBytes = await this.storage.readObject(getFinalizeObjectKey(scope, manifestSha256));
    if (finalizeBytes === null) {
      throw new ArtifactServiceError("manifest_not_found", "Artifact manifest has not been finalized.");
    }
    const finalizeRecord = readStoredFinalizeRecord(finalizeBytes);
    if (finalizeRecord.manifestSha256 !== manifestSha256) {
      throw new ArtifactServiceError("integrity_mismatch", "Stored artifact finalize marker does not match the requested manifest.");
    }
    const manifestBytes = await this.storage.readObject(getManifestObjectKey(scope, manifestSha256));
    if (manifestBytes === null) {
      throw new ArtifactServiceError("integrity_mismatch", "Finalized artifact manifest is missing.");
    }
    const storedManifest = readStoredManifestRecord(manifestBytes, scope);
    if (storedManifest.manifestSha256 !== manifestSha256) {
      throw new ArtifactServiceError("integrity_mismatch", "Finalized artifact manifest identity is invalid.");
    }
    const artifactDebugIds = new Set(finalizeRecord.artifactDebugIds);
    if (artifactDebugIds.size !== storedManifest.manifest.artifacts.length
      || storedManifest.manifest.artifacts.some((artifact) => !artifactDebugIds.has(artifact.debugId))) {
      throw new ArtifactServiceError("integrity_mismatch", "Finalized artifact marker does not cover the complete manifest.");
    }
    return {
      manifestSha256,
      release: storedManifest.manifest.release,
      dist: storedManifest.manifest.dist,
      environment: storedManifest.manifest.environment,
      artifacts: storedManifest.manifest.artifacts.map((artifact) => ({
        debugId: artifact.debugId,
        codeFile: artifact.codeFile,
        sourceMapFile: artifact.sourceMapFile,
        sourceMapInline: artifact.sourceMapInline,
        bundleSha256: artifact.bundleSha256,
        bundleBytes: artifact.bundleBytes,
        sourceMapSha256: artifact.sourceMapSha256,
        sourceMapBytes: artifact.sourceMapBytes,
        sourceMapGzippedBytes: artifact.sourceMapGzippedBytes,
      })),
    };
  }

  private async readAndVerifyObject(key: string, expectedBytes: number, expectedSha256: string, kind: string): Promise<Uint8Array> {
    const bytes = await this.readAndVerifyLengthOnly(key, expectedBytes, kind);
    if (sha256Hex(bytes) !== expectedSha256) {
      throw new ArtifactServiceError("integrity_mismatch", `Uploaded ${kind} digest does not match its manifest.`);
    }
    return bytes;
  }

  private async readAndVerifyLengthOnly(key: string, expectedBytes: number, kind: string): Promise<Uint8Array> {
    const info = await this.storage.headObject(key);
    if (info === null) {
      throw new ArtifactServiceError("artifact_not_found", `Uploaded ${kind} is missing.`);
    }
    if (info.byteLength !== expectedBytes) {
      throw new ArtifactServiceError("integrity_mismatch", `Uploaded ${kind} byte length does not match its manifest.`);
    }
    const bytes = await this.storage.readObject(key, info.eTag);
    if (bytes === null) {
      throw new ArtifactServiceError("artifact_not_found", `Uploaded ${kind} is missing.`);
    }
    if (bytes.byteLength !== expectedBytes) {
      throw new ArtifactServiceError("integrity_mismatch", `Uploaded ${kind} byte length changed while it was being read.`);
    }
    return bytes;
  }
}

function createManifestRecord(scope: ArtifactScope, validated: ValidatedArtifactManifest): StoredManifestRecord {
  return {
    schemaVersion: ARTIFACT_STORAGE_SCHEMA_VERSION,
    scope,
    manifestSha256: validated.manifestSha256,
    manifest: validated.manifest,
  };
}

async function putImmutableAndVerify(
  storage: ArtifactObjectStorage,
  object: ArtifactStorageObject,
  conflictCode: "manifest_conflict" | "artifact_conflict" = "manifest_conflict",
): Promise<boolean> {
  const created = await storage.putImmutableObject(object);
  if (created) return true;
  const existing = await storage.readObject(object.key);
  if (existing === null || !bytesEqual(existing, object.body)) {
    throw new ArtifactServiceError(conflictCode, "An immutable artifact object already exists with different contents.");
  }
  return false;
}

function getScopePrefix(scopeInput: ArtifactScope): string {
  const scope = validateArtifactScope(scopeInput);
  return `artifact-registry/v1/tenants/${encodeURIComponent(scope.tenantId)}/projects/${encodeURIComponent(scope.projectId)}/branches/${encodeURIComponent(scope.branchId)}`;
}

function getManifestObjectKey(scope: ArtifactScope, manifestSha256: string): string {
  return `${getScopePrefix(scope)}/manifests/${validateSha256(manifestSha256, "manifestSha256")}.json`;
}

function getFinalizeObjectKey(scope: ArtifactScope, manifestSha256: string): string {
  return `${getScopePrefix(scope)}/finalized/${validateSha256(manifestSha256, "manifestSha256")}.json`;
}

function getContentObjectKey(scope: ArtifactScope, kind: "bundle" | "source-map", digest: string): string {
  return `${getScopePrefix(scope)}/objects/${kind}/${validateSha256(digest, `${kind} digest`)}.` + (kind === "source-map" ? "json.gz" : "js");
}

function getDebugIdIndexObjectKey(scope: ArtifactScope, debugId: string, release: string | null, dist: string | null): string {
  const bindingDigest = sha256Hex(new TextEncoder().encode(`${release ?? ""}\u0000${dist ?? ""}`));
  return `${getScopePrefix(scope)}/debug-ids/${validateDebugId(debugId)}/${bindingDigest}.json`;
}

function jsonBytes(value: StoredManifestRecord | StoredArtifactIndexRecord | StoredFinalizeRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readStoredManifestRecord(bytes: Uint8Array, scope: ArtifactScope): StoredManifestRecord {
  const record = parseJsonRecord(bytes, "Stored artifact manifest");
  if (record.schemaVersion !== ARTIFACT_STORAGE_SCHEMA_VERSION || typeof record.manifestSha256 !== "string" || record.manifest === undefined) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact manifest record is invalid.");
  }
  const manifestSha256 = validateStoredSha256(record.manifestSha256, "Stored artifact manifest digest");
  const storedScope = readStoredScope(record.scope);
  if (!sameScope(storedScope, scope)) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact manifest scope is invalid.");
  }
  const manifest = validateStoredManifest(record.manifest, scope, "Stored artifact manifest");
  return {
    schemaVersion: ARTIFACT_STORAGE_SCHEMA_VERSION,
    scope: storedScope,
    manifestSha256,
    manifest,
  };
}

function readStoredIndexRecord(bytes: Uint8Array, scope: ArtifactScope): StoredArtifactIndexRecord {
  const record = parseJsonRecord(bytes, "Stored artifact debug-ID index");
  if (
    record.schemaVersion !== ARTIFACT_STORAGE_SCHEMA_VERSION
    || typeof record.manifestSha256 !== "string"
  ) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact debug-ID index is invalid.");
  }
  const manifestSha256 = validateStoredSha256(record.manifestSha256, "Stored artifact manifest digest");
  const storedScope = readStoredScope(record.scope);
  const release = readNullableStoredMetadata(record.release, "Stored artifact release");
  const dist = readNullableStoredMetadata(record.dist, "Stored artifact dist");
  const environment = readNullableStoredMetadata(record.environment, "Stored artifact environment");
  const artifactRecord = record.artifact;
  const validated = validateStoredManifest({
    schemaVersion: 1,
    projectId: scope.projectId,
    release,
    dist,
    environment,
    artifacts: [artifactRecord],
  }, scope, "Stored artifact debug-ID index");
  if (!sameScope(storedScope, scope) || validated.artifacts.length !== 1) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact debug-ID index scope is invalid.");
  }
  const artifact = validated.artifacts[0];
  const bundleObjectKey = readRequiredStoredString(record.bundleObjectKey, "Stored artifact bundle object key");
  const sourceMapObjectKey = record.sourceMapObjectKey === null
    ? null
    : readRequiredStoredString(record.sourceMapObjectKey, "Stored artifact source-map object key");
  const expectedBundleObjectKey = getContentObjectKey(scope, "bundle", artifact.bundleSha256);
  const expectedSourceMapObjectKey = artifact.sourceMapInline
    ? null
    : getContentObjectKey(scope, "source-map", artifact.sourceMapSha256);
  if (bundleObjectKey !== expectedBundleObjectKey || sourceMapObjectKey !== expectedSourceMapObjectKey) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact object keys do not match the authenticated scope.");
  }
  return {
    schemaVersion: ARTIFACT_STORAGE_SCHEMA_VERSION,
    scope: storedScope,
    manifestSha256,
    release,
    dist,
    environment,
    artifact,
    bundleObjectKey,
    sourceMapObjectKey,
  };
}

function readStoredFinalizeRecord(bytes: Uint8Array): StoredFinalizeRecord {
  const record = parseJsonRecord(bytes, "Stored artifact finalize marker");
  if (record.schemaVersion !== ARTIFACT_STORAGE_SCHEMA_VERSION
    || typeof record.manifestSha256 !== "string"
    || !Array.isArray(record.artifactDebugIds)) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact finalize marker is invalid.");
  }
  const artifactDebugIds: string[] = [];
  for (const debugId of record.artifactDebugIds) {
    if (typeof debugId !== "string") {
      throw new ArtifactServiceError("integrity_mismatch", "Stored artifact finalize marker is invalid.");
    }
    artifactDebugIds.push(debugId);
  }
  return {
    schemaVersion: ARTIFACT_STORAGE_SCHEMA_VERSION,
    manifestSha256: validateStoredSha256(record.manifestSha256, "Stored finalize manifest digest"),
    artifactDebugIds,
  };
}

function parseJsonRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new ArtifactServiceError("integrity_mismatch", `${label} is not valid JSON.`);
  }
}

function readStoredScope(value: unknown): ArtifactScope {
  if (!isRecord(value)) {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact scope is invalid.");
  }
  if (typeof value.tenantId !== "string" || typeof value.projectId !== "string" || typeof value.branchId !== "string") {
    throw new ArtifactServiceError("integrity_mismatch", "Stored artifact scope is invalid.");
  }
  try {
    return validateArtifactScope({ tenantId: value.tenantId, projectId: value.projectId, branchId: value.branchId });
  } catch (error) {
    if (error instanceof ArtifactServiceError && error.code === "invalid_manifest") {
      throw new ArtifactServiceError("integrity_mismatch", "Stored artifact scope is invalid.");
    }
    throw error;
  }
}

function readRequiredStoredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactServiceError("integrity_mismatch", `${label} is invalid.`);
  }
  return value;
}

function readNullableStoredMetadata(value: unknown, label: string): string | null {
  if (value === undefined) {
    throw new ArtifactServiceError("integrity_mismatch", `${label} is missing.`);
  }
  try {
    return validateArtifactMetadata(value, label);
  } catch (error) {
    if (error instanceof ArtifactServiceError && error.code === "invalid_manifest") {
      throw new ArtifactServiceError("integrity_mismatch", `${label} is invalid.`);
    }
    throw error;
  }
}

function validateStoredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ArtifactServiceError("integrity_mismatch", `${label} is invalid.`);
  }
  return value;
}

function validateStoredManifest(value: unknown, scope: ArtifactScope, label: string): ArtifactManifest {
  try {
    return validateArtifactManifest(value, scope).manifest;
  } catch (error) {
    if (error instanceof ArtifactServiceError && error.code === "invalid_manifest") {
      throw new ArtifactServiceError("integrity_mismatch", `${label} is invalid.`);
    }
    throw error;
  }
}


function sameScope(left: ArtifactScope, right: ArtifactScope): boolean {
  return left.tenantId === right.tenantId && left.projectId === right.projectId && left.branchId === right.branchId;
}

function verifySourceMap(sourceMapText: string, artifact: ArtifactManifestArtifact): void {
  const parsed = parseStandardSourceMap(sourceMapText);
  if (parsed.ok) return;
  const code = parsed.diagnostic.code === "unsupported_source_map" ? "unsupported_source_map" : "integrity_mismatch";
  throw new ArtifactServiceError(code, `Artifact ${artifact.debugId} source map is invalid: ${parsed.diagnostic.message}`);
}

function readInlineSourceMap(bundleBytes: Uint8Array): Uint8Array | null {
  const source = decodeStrictUtf8(bundleBytes);
  if (source === null) {
    throw new ArtifactServiceError("integrity_mismatch", "The uploaded bundle is not valid UTF-8.");
  }
  const matcher = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\s]*)[ \t]*$/gmu;
  let lastUrl: string | null = null;
  let match = matcher.exec(source);
  while (match !== null) {
    lastUrl = match[1];
    match = matcher.exec(source);
  }
  if (lastUrl === null || !/^data:/iu.test(lastUrl)) return null;
  const commaIndex = lastUrl.indexOf(",");
  if (commaIndex < 0) return null;
  const metadata = lastUrl.slice(0, commaIndex);
  const payload = lastUrl.slice(commaIndex + 1);
  if (/;base64$/iu.test(metadata)) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 === 1) return null;
    return new Uint8Array(Buffer.from(payload, "base64"));
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
