import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  OBSERVABILITY_DEMO_CODE_FILE,
  OBSERVABILITY_DEMO_SOURCE_MAP_FILE,
  OBSERVABILITY_DEMO_SOURCE_PATH,
  OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY,
} from "../../observability-lab-contract";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DEBUG_ID_IDENTIFIER_PREFIX = "hexclave-dbid-";
const SNIPPET_START_MARKER = "// hexclave:debug-id-injection:start";
const SNIPPET_END_MARKER = "// hexclave:debug-id-injection:end";
const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;

export const OBSERVABILITY_DEMO_ORIGINAL_SOURCE = [
  "export function throwSymbolicatedChargeError(): never {",
  "  const reason = \"card_declined\";",
  "  throw new Error(\"Symbolicated charge failed: \" + reason);",
  "}",
  "",
].join("\n");

const MINIFIED_FUNCTION = "function throwSymbolicatedChargeError(){var reason=\"card_declined\";throw new Error(\"Symbolicated charge failed: \"+reason)}";

export type ObservabilityDemoArtifactManifest = {
  schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION,
  projectId: string,
  release: string,
  dist: null,
  environment: string,
  artifacts: readonly [{
    debugId: string,
    codeFile: string,
    sourceMapFile: string,
    sourceMapInline: false,
    bundleSha256: string,
    bundleBytes: number,
    sourceMapSha256: string,
    sourceMapBytes: number,
    sourceMapGzippedBytes: number,
  }],
};

export type ObservabilityDemoBundle = {
  originalSource: string,
  minifiedFunction: string,
  bundleSource: string,
  bundleBytes: Uint8Array,
  sourceMapJson: string,
  sourceMapBytes: Uint8Array,
  sourceMapGzipped: Uint8Array,
  debugId: string,
  throwColumn: number,
  manifest: ObservabilityDemoArtifactManifest,
  manifestJson: string,
  manifestSha256: string,
};

export function buildObservabilityDemoBundle(options: {
  projectId: string,
  release: string,
  environment: string,
}): ObservabilityDemoBundle {
  const minifiedFunction = MINIFIED_FUNCTION;
  const throwColumn = minifiedFunction.indexOf("throw new Error");
  if (throwColumn < 0) {
    throw new Error("The observability demo minified fixture no longer contains the throw expression.");
  }
  const functionNameColumn = minifiedFunction.indexOf("throwSymbolicatedChargeError");
  const reasonColumn = minifiedFunction.indexOf("reason=");
  if (functionNameColumn < 0 || reasonColumn < 0) {
    throw new Error("The observability demo minified fixture is missing expected tokens.");
  }

  const originalFunctionNameColumn = OBSERVABILITY_DEMO_ORIGINAL_SOURCE.indexOf("throwSymbolicatedChargeError");
  const originalReasonColumn = OBSERVABILITY_DEMO_ORIGINAL_SOURCE.split("\n")[1]?.indexOf("reason") ?? -1;
  const originalThrowColumn = OBSERVABILITY_DEMO_ORIGINAL_SOURCE.split("\n")[2]?.indexOf("throw") ?? -1;
  if (originalFunctionNameColumn < 0 || originalReasonColumn < 0 || originalThrowColumn < 0) {
    throw new Error("The observability demo original source is missing expected tokens.");
  }

  const mappings = encodeMappingLine([
    {
      generatedColumn: functionNameColumn,
      sourceIndex: 0,
      originalLine: 0,
      originalColumn: originalFunctionNameColumn,
      nameIndex: 0,
    },
    {
      generatedColumn: reasonColumn,
      sourceIndex: 0,
      originalLine: 1,
      originalColumn: originalReasonColumn,
      nameIndex: 1,
    },
    {
      generatedColumn: throwColumn,
      sourceIndex: 0,
      originalLine: 2,
      originalColumn: originalThrowColumn,
    },
  ]);

  const sourceMapBeforeDebugId = JSON.stringify({
    version: 3,
    file: OBSERVABILITY_DEMO_CODE_FILE,
    sources: [OBSERVABILITY_DEMO_SOURCE_PATH],
    names: ["throwSymbolicatedChargeError", "reason"],
    sourcesContent: [OBSERVABILITY_DEMO_ORIGINAL_SOURCE],
    mappings,
  });

  const debugId = deriveDebugId(
    Buffer.from(minifiedFunction, "utf8"),
    Buffer.from(sourceMapBeforeDebugId, "utf8"),
  );

  const sourceMapJson = JSON.stringify({
    version: 3,
    file: OBSERVABILITY_DEMO_CODE_FILE,
    sources: [OBSERVABILITY_DEMO_SOURCE_PATH],
    names: ["throwSymbolicatedChargeError", "reason"],
    sourcesContent: [OBSERVABILITY_DEMO_ORIGINAL_SOURCE],
    mappings,
    debug_id: debugId,
    debugId,
  });
  const sourceMapBytes = Buffer.from(sourceMapJson, "utf8");
  const sourceMapGzipped = gzipSync(sourceMapBytes);

  const assignment = `globalThis[${JSON.stringify(OBSERVABILITY_DEMO_THROWER_GLOBAL_KEY)}]=throwSymbolicatedChargeError;`;
  const bundleWithoutSnippet = `${minifiedFunction}\n${assignment}\n`;
  const bundleSource = appendDebugIdSnippet(bundleWithoutSnippet, debugId);
  const bundleBytes = Buffer.from(bundleSource, "utf8");

  const artifact = {
    debugId,
    codeFile: OBSERVABILITY_DEMO_CODE_FILE,
    sourceMapFile: OBSERVABILITY_DEMO_SOURCE_MAP_FILE,
    sourceMapInline: false as const,
    bundleSha256: sha256Hex(bundleBytes),
    bundleBytes: bundleBytes.byteLength,
    sourceMapSha256: sha256Hex(sourceMapBytes),
    sourceMapBytes: sourceMapBytes.byteLength,
    sourceMapGzippedBytes: sourceMapGzipped.byteLength,
  };
  const manifest: ObservabilityDemoArtifactManifest = {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    projectId: options.projectId,
    release: options.release,
    dist: null,
    environment: options.environment,
    artifacts: [artifact],
  };
  const manifestJson = JSON.stringify(manifest);

  return {
    originalSource: OBSERVABILITY_DEMO_ORIGINAL_SOURCE,
    minifiedFunction,
    bundleSource,
    bundleBytes,
    sourceMapJson,
    sourceMapBytes,
    sourceMapGzipped,
    debugId,
    throwColumn,
    manifest,
    manifestJson,
    manifestSha256: sha256Hex(Buffer.from(manifestJson, "utf8")),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function deriveDebugId(minified: Uint8Array, map: Uint8Array): string {
  const digest = createHash("sha256")
    .update(createHash("sha256").update(minified).digest())
    .update(createHash("sha256").update(map).digest())
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type MappingSegment = {
  generatedColumn: number,
  sourceIndex: number,
  originalLine: number,
  originalColumn: number,
  nameIndex?: number,
};

export function encodeVlq(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) | 1 : (value << 1);
  let encoded = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += BASE64.charAt(digit);
  } while (vlq > 0);
  return encoded;
}

function encodeMappingLine(segments: readonly MappingSegment[]): string {
  let prevGeneratedColumn = 0;
  let prevSourceIndex = 0;
  let prevOriginalLine = 0;
  let prevOriginalColumn = 0;
  let prevNameIndex = 0;
  const encoded: string[] = [];
  for (const segment of segments) {
    let token = encodeVlq(segment.generatedColumn - prevGeneratedColumn)
      + encodeVlq(segment.sourceIndex - prevSourceIndex)
      + encodeVlq(segment.originalLine - prevOriginalLine)
      + encodeVlq(segment.originalColumn - prevOriginalColumn);
    if (segment.nameIndex !== undefined) {
      token += encodeVlq(segment.nameIndex - prevNameIndex);
      prevNameIndex = segment.nameIndex;
    }
    encoded.push(token);
    prevGeneratedColumn = segment.generatedColumn;
    prevSourceIndex = segment.sourceIndex;
    prevOriginalLine = segment.originalLine;
    prevOriginalColumn = segment.originalColumn;
  }
  return encoded.join(",");
}

function appendDebugIdSnippet(source: string, debugId: string): string {
  const snippet = `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:typeof window!=="undefined"?window:typeof global!=="undefined"?global:typeof self!=="undefined"?self:{};var s=new g.Error().stack;if(s){g._hexclaveDebugIds=g._hexclaveDebugIds||{};g._hexclaveDebugIds[s]=${JSON.stringify(debugId)};g._hexclaveDebugIdIdentifier=${JSON.stringify(`${DEBUG_ID_IDENTIFIER_PREFIX}${debugId}`)};}}catch(e){}})();`;
  const block = `${SNIPPET_START_MARKER}\n${snippet}\n//# debugId=${debugId}\n${SNIPPET_END_MARKER}\n`;
  return source.endsWith("\n") ? `${source}${block}` : `${source}\n${block}`;
}
