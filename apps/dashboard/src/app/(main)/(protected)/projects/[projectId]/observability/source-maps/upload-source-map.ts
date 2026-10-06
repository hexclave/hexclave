import { parseJson, type Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";

const DEBUG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUNDLE_EXTENSION_PATTERN = /\.(?:js|mjs|cjs)$/i;
const SOURCE_MAP_EXTENSION_PATTERN = /\.map$/i;
const URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const DEBUG_ID_IDENTIFIER_PREFIX = "hexclave-dbid-";
const INJECTED_DEBUG_ID_IDENTIFIER_PATTERN = new RegExp(`${DEBUG_ID_IDENTIFIER_PREFIX}[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`);
const SNIPPET_START_MARKER = "// hexclave:debug-id-injection:start";
const SNIPPET_END_MARKER = "// hexclave:debug-id-injection:end";
const SOURCE_MAPPING_URL_LINE_PATTERN = "^[ \\t]*\\/\\/[#@][ \\t]*sourceMappingURL=([^\\s]*)[ \\t]*$";
const MAX_ARTIFACT_PATH_BYTES = 1_024;
const MAX_METADATA_BYTES = 256;

export type SourceMapArtifactManifest = {
  debugId: string,
  codeFile: string,
  sourceMapFile: string,
  sourceMapInline: false,
  bundleSha256: string,
  bundleBytes: number,
  sourceMapSha256: string,
  sourceMapBytes: number,
  sourceMapGzippedBytes: number,
};

export type SourceMapUploadManifest = {
  schemaVersion: 1,
  projectId: string,
  release: string | null,
  dist: null,
  environment: string | null,
  artifacts: [SourceMapArtifactManifest],
};

export type PreparedSourceMapUpload = {
  debugId: string,
  codeFile: string,
  sourceMapFile: string,
  bundleSource: string,
  sourceMapJson: string,
  bundleUploadBody: Blob,
  sourceMapUploadBody: Blob,
  manifest: SourceMapUploadManifest,
  manifestJson: string,
  manifestSha256: string,
};

export async function prepareSourceMapUpload(input: {
  projectId: string,
  release: string | null,
  environment: string | null,
  codeFile: string,
  sourceMapFile: string,
  bundleSource: string,
  sourceMapSource: string,
}): Promise<PreparedSourceMapUpload> {
  const projectId = validateMetadata(input.projectId, "Project ID");
  const release = input.release === null ? null : validateMetadata(input.release, "Release");
  const environment = input.environment === null ? null : validateMetadata(input.environment, "Environment");
  const codeFile = normalizeArtifactPath(input.codeFile, "Bundle file");
  const sourceMapFile = normalizeArtifactPath(input.sourceMapFile, "Source map file");
  if (!BUNDLE_EXTENSION_PATTERN.test(codeFile)) {
    throw new Error("Bundle file must end in .js, .mjs, or .cjs.");
  }
  if (!SOURCE_MAP_EXTENSION_PATTERN.test(sourceMapFile)) {
    throw new Error("Source map file must end in .map.");
  }
  if (codeFile === sourceMapFile) {
    throw new Error("Bundle file and source map file must be different.");
  }
  if (input.bundleSource.length === 0) {
    throw new Error("Bundle file must not be empty.");
  }
  if (input.bundleSource.includes(SNIPPET_START_MARKER) || INJECTED_DEBUG_ID_IDENTIFIER_PATTERN.test(input.bundleSource)) {
    throw new Error("Bundle already contains a Hexclave debug ID. Choose the original bundle before debug-ID injection.");
  }

  const parsedSourceMap = parseSourceMap(input.sourceMapSource);
  if ("debug_id" in parsedSourceMap || "debugId" in parsedSourceMap) {
    throw new Error("Source map already contains a debug ID. Choose the original map before debug-ID injection.");
  }

  const encoder = new TextEncoder();
  const debugId = await deriveDebugId(
    encoder.encode(input.bundleSource),
    encoder.encode(input.sourceMapSource),
  );
  const sourceMapJson = JSON.stringify({
    ...parsedSourceMap,
    debug_id: debugId,
    debugId,
  });
  const bundleSource = appendDebugIdSnippet(input.bundleSource, debugId);
  const bundleBytes = encoder.encode(bundleSource);
  const sourceMapBytes = encoder.encode(sourceMapJson);
  const sourceMapGzipped = await gzip(sourceMapBytes);
  const artifact: SourceMapArtifactManifest = {
    debugId,
    codeFile,
    sourceMapFile,
    sourceMapInline: false,
    bundleSha256: await sha256Hex(bundleBytes),
    bundleBytes: bundleBytes.byteLength,
    sourceMapSha256: await sha256Hex(sourceMapBytes),
    sourceMapBytes: sourceMapBytes.byteLength,
    sourceMapGzippedBytes: sourceMapGzipped.byteLength,
  };
  const manifest: SourceMapUploadManifest = {
    schemaVersion: 1,
    projectId,
    release,
    dist: null,
    environment,
    artifacts: [artifact],
  };
  const manifestJson = JSON.stringify(manifest);

  return {
    debugId,
    codeFile,
    sourceMapFile,
    bundleSource,
    sourceMapJson,
    bundleUploadBody: new Blob([bundleSource], { type: "application/javascript" }),
    sourceMapUploadBody: new Blob([sourceMapGzipped], { type: "application/gzip" }),
    manifest,
    manifestJson,
    manifestSha256: await sha256Hex(encoder.encode(manifestJson)),
  };
}

export type PresignedArtifactPutResult = "uploaded" | "already-uploaded";

export async function putPresignedArtifact(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  what: string,
): Promise<PresignedArtifactPutResult> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "If-None-Match": "*" },
    body,
    credentials: "omit",
  });
  if (response.status === 412) return "already-uploaded";
  if (!response.ok) {
    throw new Error(`${what} failed with status ${response.status}`);
  }
  return "uploaded";
}

export async function deriveDebugId(
  minified: Uint8Array<ArrayBuffer>,
  sourceMap: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const minifiedHash = await sha256(minified);
  const sourceMapHash = await sha256(sourceMap);
  const pair = new Uint8Array(minifiedHash.byteLength + sourceMapHash.byteLength);
  pair.set(minifiedHash, 0);
  pair.set(sourceMapHash, minifiedHash.byteLength);
  const digest = await sha256(pair);
  const bytes = digest.slice(0, 16);
  const versionByte = bytes.at(6);
  const variantByte = bytes.at(8);
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("SHA-256 digest was unexpectedly too short to create a debug ID.");
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  const debugId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  if (!DEBUG_ID_PATTERN.test(debugId)) {
    throw new Error("Derived debug ID is not a canonical UUID.");
  }
  return debugId;
}

export function appendDebugIdSnippet(source: string, debugId: string): string {
  if (!DEBUG_ID_PATTERN.test(debugId)) {
    throw new Error("Debug ID must be a lowercase UUID v4.");
  }
  const snippet = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:typeof window!=="undefined"?window:typeof global!=="undefined"?global:typeof self!=="undefined"?self:{};var s=new g.Error().stack;if(s){g._hexclaveDebugIds=g._hexclaveDebugIds||{};g._hexclaveDebugIds[s]=${JSON.stringify(debugId)};g._hexclaveDebugIdIdentifier=${JSON.stringify(`${DEBUG_ID_IDENTIFIER_PREFIX}${debugId}`)};}}catch(e){}})();`;
  const block = `${SNIPPET_START_MARKER}\n${snippet}\n//# debugId=${debugId}\n${SNIPPET_END_MARKER}\n`;
  const sourceMappingUrl = findLastSourceMappingUrl(source);
  if (sourceMappingUrl === null) {
    return source.endsWith("\n") ? `${source}${block}` : `${source}\n${block}`;
  }
  return `${source.slice(0, sourceMappingUrl.lineStart)}${block}${source.slice(sourceMappingUrl.lineStart)}`;
}

export function normalizeArtifactPath(value: string, label = "Artifact path"): string {
  if (value.length === 0 || value.length > MAX_ARTIFACT_PATH_BYTES || new TextEncoder().encode(value).byteLength > MAX_ARTIFACT_PATH_BYTES) {
    throw new Error(`${label} must be between 1 and ${MAX_ARTIFACT_PATH_BYTES} UTF-8 bytes.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:\//u.test(value) || URL_PATTERN.test(value)) {
    throw new Error(`${label} must be a relative POSIX path, not a URL or absolute path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, ".", or ".." path segments.`);
  }
  return value;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(await sha256(bytes));
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  // All current evergreen browsers ship CompressionStream; a JS gzip fallback
  // would mean vendoring a compression library for browsers we don't support.
  // Failing with a clear compatibility message beats the bare ReferenceError
  // the constructor call would otherwise surface in the upload error alert.
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser does not support gzip compression (CompressionStream), which source map uploads require. Please use a current version of Chrome, Edge, Firefox, or Safari.");
  }
  const compression = new CompressionStream("gzip");
  const compressed = new Response(compression.readable).arrayBuffer();
  const writer = compression.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return await compressed;
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseSourceMap(source: string): Record<string, Json> {
  const parsed = parseJson(source);
  if (parsed.status === "error") {
    throw new Error("Source map must contain valid JSON.");
  }
  const sourceMap = parsed.data;
  if (!isRecord(sourceMap)) {
    throw new Error("Source map must be a JSON object.");
  }
  if (sourceMap.version !== 3) {
    throw new Error("Source map must use version 3.");
  }
  if (typeof sourceMap.mappings !== "string" && !Array.isArray(sourceMap.sections)) {
    throw new Error("Source map must contain mappings or sections.");
  }
  return sourceMap;
}

function validateMetadata(value: string, label: string): string {
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_METADATA_BYTES || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} must be a non-empty value of at most ${MAX_METADATA_BYTES} UTF-8 bytes without control characters.`);
  }
  return value;
}

function findLastSourceMappingUrl(source: string): { lineStart: number } | null {
  let last: { lineStart: number } | null = null;
  const pattern = new RegExp(SOURCE_MAPPING_URL_LINE_PATTERN, "gm");
  let match = pattern.exec(source);
  while (match !== null) {
    last = { lineStart: match.index };
    match = pattern.exec(source);
  }
  return last;
}
