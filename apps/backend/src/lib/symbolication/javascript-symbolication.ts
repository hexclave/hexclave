import { gunzipSync } from "node:zlib";
import { ArtifactServiceError } from "../artifacts/artifact-errors";
import {
  sha256Hex,
  validateArtifactMetadata,
  validateArtifactScope,
  validateDebugId,
  type ArtifactScope,
} from "../artifacts/artifact-manifest";
import {
  type ArtifactObjectStorage,
  type ArtifactStorageObjectInfo,
} from "../artifacts/artifact-storage";
import type { ArtifactLookup } from "../artifacts/artifact-upload-service";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { utf8ByteLength } from "@/lib/utf8";

type ArtifactLookupService = {
  lookupArtifact(scope: ArtifactScope, query: { debugId: string, release: string | null, dist: string | null }): Promise<ArtifactLookup | null>,
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INLINE_SOURCE_MAP_PATTERN = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\s]*)[ \t]*$/gmu;
const SOURCE_MAP_VERSION = 3;
const SOURCE_MAP_SNIP_MARKER = "{snip}";

export type JavaScriptSymbolicationLimits = Readonly<{
  maxFrames: number,
  maxBundleBytes: number,
  maxSourceMapBytes: number,
  maxSourceMapGzippedBytes: number,
  maxSources: number,
  maxNames: number,
  maxPathBytes: number,
  maxNameBytes: number,
  maxMappingSegments: number,
  maxMappingLines: number,
  maxSourceContentBytes: number,
  maxContextLines: number,
  maxContextLineBytes: number,
}>;

export const DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS: JavaScriptSymbolicationLimits = {
  maxFrames: 50,
  maxBundleBytes: 32 * 1024 * 1024,
  maxSourceMapBytes: 16 * 1024 * 1024,
  maxSourceMapGzippedBytes: 8 * 1024 * 1024,
  maxSources: 4_096,
  maxNames: 16_384,
  maxPathBytes: 4_096,
  maxNameBytes: 2_048,
  maxMappingSegments: 200_000,
  maxMappingLines: 1_000_000,
  maxSourceContentBytes: 128 * 1024,
  maxContextLines: 5,
  maxContextLineBytes: 512,
};

export type RawJavaScriptFrame = Readonly<{
  codeFile: string,
  debugId: string | null,
  lineno: number | null,
  colno: number | null,
  function: string | null,
}>;

export type JavaScriptSymbolicationRequest = Readonly<{
  scope: ArtifactScope,
  release: string | null,
  dist: string | null,
  frames: readonly RawJavaScriptFrame[],
  applySourceContext?: boolean,
  contextLines?: number,
}>;

export type SymbolicationDiagnosticCode =
  | "frame_limit_exceeded"
  | "invalid_frame"
  | "invalid_frame_location"
  | "missing_debug_id"
  | "invalid_debug_id"
  | "invalid_artifact"
  | "missing_artifact"
  | "artifact_mismatch"
  | "artifact_integrity_mismatch"
  | "artifact_storage_unavailable"
  | "missing_bundle"
  | "bundle_too_large"
  | "missing_source_map"
  | "source_map_too_large"
  | "invalid_source_map"
  | "unsupported_source_map"
  | "no_mapping"
  | "missing_source_content"
  | "source_content_too_large"
  | "source_context_unavailable";

export type SymbolicationDiagnostic = Readonly<{
  code: SymbolicationDiagnosticCode,
  message: string,
  debugId?: string,
  codeFile?: string,
  line?: number | null,
  column?: number | null,
  source?: string,
}>;

export type SymbolicationSourceContext = Readonly<{
  pre: readonly string[],
  line: string,
  post: readonly string[],
}>;

export type SymbolicatedJavaScriptLocation = Readonly<{
  source: string,
  line: number,
  column: number,
  name: string | null,
  sourceContext?: SymbolicationSourceContext,
  artifact: Readonly<{
    manifestSha256: string,
    debugId: string,
    codeFile: string,
  }>,
}>;

export type SymbolicatedJavaScriptFrame = Readonly<{
  raw: RawJavaScriptFrame,
  location: SymbolicatedJavaScriptLocation | null,
  diagnostics: readonly SymbolicationDiagnostic[],
}>;

export type JavaScriptSymbolicationResult = Readonly<{
  frames: readonly SymbolicatedJavaScriptFrame[],
  diagnostics: readonly SymbolicationDiagnostic[],
  truncatedFrameCount: number,
}>;

type MappingSegment = Readonly<{
  generatedColumn: number,
  sourceIndex: number | null,
  originalLine: number | null,
  originalColumn: number | null,
  nameIndex: number | null,
}>;

export type ParsedSourceMap = Readonly<{
  sourceRoot: string,
  sources: readonly string[],
  names: readonly string[],
  sourcesContent: readonly (string | null)[],
  sourceContentTooLarge: readonly boolean[],
  mappings: readonly (readonly MappingSegment[])[],
}>;

export type SourceMapParseResult =
  | Readonly<{ ok: true, map: ParsedSourceMap }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

type ArtifactReadResult =
  | Readonly<{ ok: true, bytes: Uint8Array }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

type LoadedArtifact =
  | Readonly<{ ok: true, lookup: ArtifactLookup, map: ParsedSourceMap }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

type FrameWorkContext = Readonly<{
  scope: ArtifactScope,
  release: string | null,
  dist: string | null,
  applySourceContext: boolean,
  contextLines: number,
}>;

export class JavaScriptSymbolicationService {
  private readonly limits: JavaScriptSymbolicationLimits;

  public constructor(
    private readonly artifacts: ArtifactLookupService,
    private readonly storage: ArtifactObjectStorage,
    limits: Partial<JavaScriptSymbolicationLimits> = {},
  ) {
    this.limits = resolveLimits(limits);
  }

  public async symbolicate(request: JavaScriptSymbolicationRequest): Promise<JavaScriptSymbolicationResult> {
    const scope = validateArtifactScope(request.scope);
    const release = validateArtifactMetadata(request.release, "release");
    const dist = validateArtifactMetadata(request.dist, "dist");
    const frames = request.frames.slice(0, this.limits.maxFrames);
    const truncatedFrameCount = Math.max(0, request.frames.length - frames.length);
    const diagnostics: SymbolicationDiagnostic[] = truncatedFrameCount > 0
      ? [{
        code: "frame_limit_exceeded",
        message: `Symbolication processed only the first ${this.limits.maxFrames} frames.`,
      }]
      : [];
    const context: FrameWorkContext = {
      scope,
      release,
      dist,
      applySourceContext: request.applySourceContext !== false,
      contextLines: boundedContextLines(request.contextLines, this.limits.maxContextLines),
    };
    const artifactCache = new Map<string, LoadedArtifact>();
    const symbolicatedFrames: SymbolicatedJavaScriptFrame[] = [];

    for (const frame of frames) {
      symbolicatedFrames.push(await this.symbolicateFrame(frame, context, artifactCache));
    }

    return {
      frames: symbolicatedFrames,
      diagnostics,
      truncatedFrameCount,
    };
  }

  private async symbolicateFrame(
    raw: RawJavaScriptFrame,
    context: FrameWorkContext,
    artifactCache: Map<string, LoadedArtifact>,
  ): Promise<SymbolicatedJavaScriptFrame> {
    const frameDiagnostics: SymbolicationDiagnostic[] = [];
    if (raw.codeFile.length === 0 || utf8ByteLength(raw.codeFile) > this.limits.maxPathBytes) {
      return frameFailure(raw, [{
        code: "invalid_frame",
        message: "JavaScript frame codeFile must be non-empty and within the bounded path limit.",
      }]);
    }
    if (raw.lineno === null || !Number.isSafeInteger(raw.lineno) || raw.lineno < 1) {
      return frameFailure(raw, [{
        code: "invalid_frame_location",
        message: "JavaScript frame line must be a positive one-based integer.",
        line: raw.lineno,
        column: raw.colno,
      }]);
    }
    if (raw.colno !== null && (!Number.isSafeInteger(raw.colno) || raw.colno < 0)) {
      return frameFailure(raw, [{
        code: "invalid_frame_location",
        message: "JavaScript frame column must be a non-negative integer.",
        line: raw.lineno,
        column: raw.colno,
      }]);
    }
    if (raw.debugId === null) {
      return frameFailure(raw, [{
        code: "missing_debug_id",
        message: "JavaScript symbolication requires the exact artifact debug ID.",
        codeFile: raw.codeFile,
        line: raw.lineno,
        column: raw.colno,
      }]);
    }

    let debugId: string;
    try {
      debugId = validateDebugId(raw.debugId, "frame.debugId");
    } catch (error) {
      if (!(error instanceof ArtifactServiceError) || error.code !== "invalid_manifest") throw error;
      return frameFailure(raw, [{
        code: "invalid_debug_id",
        message: "JavaScript frame debug ID is not a lowercase hyphenated UUID.",
        debugId: raw.debugId,
        codeFile: raw.codeFile,
        line: raw.lineno,
        column: raw.colno,
      }]);
    }

    const cacheKey = `${debugId}\u0000${context.release ?? ""}\u0000${context.dist ?? ""}\u0000${raw.codeFile}`;
    let loaded = artifactCache.get(cacheKey);
    if (loaded === undefined) {
      loaded = await this.loadArtifact(context.scope, context.release, context.dist, debugId, raw.codeFile);
      artifactCache.set(cacheKey, loaded);
    }
    if (!loaded.ok) return frameFailure(raw, [loaded.diagnostic]);

    const oneBasedColumn = raw.colno !== null && raw.colno >= 1 ? raw.colno : null;
    const generatedColumn = oneBasedColumn === null ? 0 : oneBasedColumn - 1;
    if (oneBasedColumn === null) {
      frameDiagnostics.push({
        code: "invalid_frame_location",
        message: "JavaScript frame has no usable one-based column; the first generated column was used.",
        line: raw.lineno,
        column: raw.colno,
      });
    }
    const segment = findMapping(loaded.map, raw.lineno, generatedColumn);
    if (segment === null || segment.sourceIndex === null || segment.originalLine === null || segment.originalColumn === null) {
      frameDiagnostics.push({
        code: "no_mapping",
        message: "The uploaded source map has no mapping for this generated location.",
        debugId,
        codeFile: raw.codeFile,
        line: raw.lineno,
        column: raw.colno,
      });
      return frameFailure(raw, frameDiagnostics);
    }

    const source = loaded.map.sources.at(segment.sourceIndex);
    if (source === undefined) throw new Error("Validated source-map segment references a missing source.");
    const originalSource = resolveSourcePath(loaded.map.sourceRoot, source);
    const sourceContext = this.resolveSourceContext(
      loaded.map,
      segment.sourceIndex,
      segment.originalLine + 1,
      segment.originalColumn + 1,
      originalSource,
      context,
      debugId,
      raw.codeFile,
      frameDiagnostics,
    );
    const name = segment.nameIndex === null ? null : loaded.map.names[segment.nameIndex] ?? null;

    // The sourceContext key stays absent (not `undefined`) when there is no context, so
    // serialized frames don't grow a null-ish field; `SymbolicatedJavaScriptLocation` is
    // Readonly, hence two complete literals instead of a conditional assignment.
    const locationBase = {
      source: originalSource,
      line: segment.originalLine + 1,
      column: segment.originalColumn + 1,
      name,
      artifact: {
        manifestSha256: loaded.lookup.manifestSha256,
        debugId,
        codeFile: raw.codeFile,
      },
    };
    return {
      raw,
      location: sourceContext === undefined ? locationBase : { ...locationBase, sourceContext },
      diagnostics: frameDiagnostics,
    };
  }

  private async loadArtifact(
    scope: ArtifactScope,
    release: string | null,
    dist: string | null,
    debugId: string,
    codeFile: string,
  ): Promise<LoadedArtifact> {
    let lookup: ArtifactLookup | null;
    try {
      lookup = await this.artifacts.lookupArtifact(scope, { debugId, release, dist });
    } catch (error) {
      if (!(error instanceof ArtifactServiceError)) throw error;
      switch (error.code) {
        case "storage_unavailable": {
          return { ok: false, diagnostic: artifactDiagnostic("artifact_storage_unavailable", "Artifact storage is unavailable.", debugId, codeFile) };
        }
        case "integrity_mismatch": {
          return { ok: false, diagnostic: artifactDiagnostic("artifact_integrity_mismatch", "The stored artifact lookup record failed integrity validation.", debugId, codeFile) };
        }
        case "invalid_manifest": {
          return { ok: false, diagnostic: artifactDiagnostic("invalid_artifact", "The stored artifact lookup record is invalid.", debugId, codeFile) };
        }
        default: {
          throw error;
        }
      }
    }
    if (lookup === null) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("missing_artifact", "No finalized artifact matches the exact debug ID, release, and distribution.", debugId, codeFile),
      };
    }
    if (
      lookup.artifact.debugId !== debugId
      || lookup.release !== release
      || lookup.dist !== dist
      || !artifactCodeFileMatchesFrame(lookup.artifact.codeFile, codeFile)
      || lookup.artifact.sourceMapInline !== (lookup.sourceMapObjectKey === null)
    ) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("artifact_mismatch", "The resolved artifact does not match the frame's exact debug-image contract.", debugId, codeFile),
      };
    }

    const bundle = await this.readVerifiedObject(
      lookup.bundleObjectKey,
      lookup.artifact.bundleBytes,
      lookup.artifact.bundleSha256,
      this.limits.maxBundleBytes,
      "bundle",
      lookup,
    );
    if (!bundle.ok) return bundle;

    let sourceMapBytes: Uint8Array;
    if (lookup.artifact.sourceMapInline) {
      const inlineSourceMap = readInlineSourceMap(bundle.bytes, this.limits.maxSourceMapBytes);
      if (!inlineSourceMap.ok) return { ok: false, diagnostic: withArtifact(inlineSourceMap.diagnostic, lookup) };
      sourceMapBytes = inlineSourceMap.bytes;
      if (
        sourceMapBytes.byteLength !== lookup.artifact.sourceMapBytes
        || sha256Hex(sourceMapBytes) !== lookup.artifact.sourceMapSha256
      ) {
        return {
          ok: false,
          diagnostic: artifactDiagnostic("artifact_integrity_mismatch", "The inline source map does not match its artifact manifest.", debugId, codeFile),
        };
      }
    } else {
      const sourceMapKey = lookup.sourceMapObjectKey;
      if (sourceMapKey === null) {
        return {
          ok: false,
          diagnostic: artifactDiagnostic("artifact_mismatch", "The external source-map object is missing from the artifact index.", debugId, codeFile),
        };
      }
      if (lookup.artifact.sourceMapBytes > this.limits.maxSourceMapBytes) {
        return {
          ok: false,
          diagnostic: artifactDiagnostic("source_map_too_large", "The uploaded source map exceeds the symbolication read limit.", debugId, codeFile),
        };
      }
      const compressed = await this.readVerifiedObject(
        sourceMapKey,
        lookup.artifact.sourceMapGzippedBytes,
        undefined,
        this.limits.maxSourceMapGzippedBytes,
        "source map",
        lookup,
      );
      if (!compressed.ok) return compressed;
      try {
        sourceMapBytes = gunzipSync(compressed.bytes, { maxOutputLength: this.limits.maxSourceMapBytes });
      } catch {
        return {
          ok: false,
          diagnostic: artifactDiagnostic("invalid_source_map", "The uploaded source map is not valid gzip data.", debugId, codeFile),
        };
      }
      if (
        sourceMapBytes.byteLength !== lookup.artifact.sourceMapBytes
        || sha256Hex(sourceMapBytes) !== lookup.artifact.sourceMapSha256
      ) {
        return {
          ok: false,
          diagnostic: artifactDiagnostic("artifact_integrity_mismatch", "The uploaded source map does not match its artifact manifest.", debugId, codeFile),
        };
      }
    }

    const sourceMapText = decodeUtf8(sourceMapBytes);
    if (sourceMapText === null) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("invalid_source_map", "The uploaded source map is not valid UTF-8.", debugId, codeFile),
      };
    }
    const parsed = parseStandardSourceMap(sourceMapText, this.limits);
    if (!parsed.ok) return { ok: false, diagnostic: withArtifact(parsed.diagnostic, lookup) };
    return { ok: true, lookup, map: parsed.map };
  }

  private async readVerifiedObject(
    key: string,
    expectedBytes: number,
    expectedSha256: string | undefined,
    maxBytes: number,
    kind: "bundle" | "source map",
    lookup: ArtifactLookup,
  ): Promise<ArtifactReadResult> {
    let info: ArtifactStorageObjectInfo | null;
    try {
      info = await this.storage.headObject(key);
    } catch (error) {
      if (!(error instanceof ArtifactServiceError) || error.code !== "storage_unavailable") throw error;
      return { ok: false, diagnostic: artifactDiagnostic("artifact_storage_unavailable", "Artifact storage is unavailable.", lookup.artifact.debugId, lookup.artifact.codeFile) };
    }
    if (info === null) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic(kind === "bundle" ? "missing_bundle" : "missing_source_map", `The finalized ${kind} object is missing.`, lookup.artifact.debugId, lookup.artifact.codeFile),
      };
    }
    if (!Number.isSafeInteger(info.byteLength) || info.byteLength < 0) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("artifact_integrity_mismatch", `The uploaded ${kind} reports an invalid size.`, lookup.artifact.debugId, lookup.artifact.codeFile),
      };
    }
    if (expectedBytes > maxBytes || info.byteLength > maxBytes) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic(kind === "bundle" ? "bundle_too_large" : "source_map_too_large", `The uploaded ${kind} exceeds the symbolication read limit.`, lookup.artifact.debugId, lookup.artifact.codeFile),
      };
    }
    if (info.byteLength !== expectedBytes) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("artifact_integrity_mismatch", `The uploaded ${kind} length does not match its manifest.`, lookup.artifact.debugId, lookup.artifact.codeFile),
      };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.storage.readObject(key, info.eTag);
    } catch (error) {
      if (!(error instanceof ArtifactServiceError) || error.code !== "storage_unavailable") throw error;
      return { ok: false, diagnostic: artifactDiagnostic("artifact_storage_unavailable", "Artifact storage is unavailable.", lookup.artifact.debugId, lookup.artifact.codeFile) };
    }
    if (bytes === null || bytes.byteLength !== expectedBytes) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("artifact_integrity_mismatch", `The uploaded ${kind} changed after its size check.`, lookup.artifact.debugId, lookup.artifact.codeFile),
      };
    }
    if (expectedSha256 !== undefined && sha256Hex(bytes) !== expectedSha256) {
      return {
        ok: false,
        diagnostic: artifactDiagnostic("artifact_integrity_mismatch", `The uploaded ${kind} digest does not match its manifest.`, lookup.artifact.debugId, lookup.artifact.codeFile),
      };
    }
    return { ok: true, bytes };
  }

  private resolveSourceContext(
    map: ParsedSourceMap,
    sourceIndex: number,
    line: number,
    column: number,
    source: string,
    context: FrameWorkContext,
    debugId: string,
    codeFile: string,
    diagnostics: SymbolicationDiagnostic[],
  ): SymbolicationSourceContext | undefined {
    if (!context.applySourceContext) return undefined;
    if (map.sourceContentTooLarge[sourceIndex] === true) {
      diagnostics.push({
        code: "source_content_too_large",
        message: "The mapped source content exceeds the bounded source-context limit.",
        debugId,
        codeFile,
        source,
      });
      return undefined;
    }
    const sourceContent = map.sourcesContent.at(sourceIndex);
    if (sourceContent === null || sourceContent === undefined) {
      diagnostics.push({
        code: "missing_source_content",
        message: "The source map does not contain uploaded source content for this source.",
        debugId,
        codeFile,
        source,
      });
      return undefined;
    }
    const sourceContext = extractSourceContext(sourceContent, line, column, context.contextLines, this.limits.maxContextLineBytes);
    if (sourceContext === null) {
      diagnostics.push({
        code: "source_context_unavailable",
        message: "The mapped source line is outside the uploaded source content.",
        debugId,
        codeFile,
        source,
        line,
        column,
      });
      return undefined;
    }
    return sourceContext;
  }
}

export function parseStandardSourceMap(
  sourceMapText: string,
  limitsInput: Partial<JavaScriptSymbolicationLimits> = {},
): SourceMapParseResult {
  const limits = resolveLimits(limitsInput);
  if (utf8ByteLength(sourceMapText) > limits.maxSourceMapBytes) {
    return { ok: false, diagnostic: { code: "source_map_too_large", message: "The source map exceeds the symbolication read limit." } };
  }
  let value: unknown;
  try {
    value = JSON.parse(sourceMapText);
  } catch {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map is not valid JSON." } };
  }
  if (!isRecord(value)) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map must be a JSON object." } };
  }
  if (value.sections !== undefined) {
    return { ok: false, diagnostic: { code: "unsupported_source_map", message: "Indexed source maps are not supported by this bounded VLQ reader." } };
  }
  if (value.version !== SOURCE_MAP_VERSION) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "Only version-3 source maps are supported." } };
  }
  const sources = readBoundedStringArray(value.sources, "sources", limits.maxSources, limits.maxPathBytes);
  if (!sources.ok) return sources;
  const names = readBoundedStringArray(value.names, "names", limits.maxNames, limits.maxNameBytes);
  if (!names.ok) return names;
  if (typeof value.mappings !== "string") {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map mappings field must be a string." } };
  }
  const sourceRoot = value.sourceRoot === undefined ? "" : value.sourceRoot;
  if (typeof sourceRoot !== "string" || utf8ByteLength(sourceRoot) > limits.maxPathBytes) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map sourceRoot is invalid or too large." } };
  }

  const sourceContentResult = readSourceContents(value.sourcesContent, sources.values.length, limits);
  if (!sourceContentResult.ok) return sourceContentResult;
  const mappings = parseMappings(value.mappings, sources.values.length, names.values.length, limits.maxMappingSegments, limits.maxMappingLines);
  if (!mappings.ok) return mappings;
  return {
    ok: true,
    map: {
      sourceRoot,
      sources: sources.values,
      names: names.values,
      sourcesContent: sourceContentResult.values,
      sourceContentTooLarge: sourceContentResult.tooLarge,
      mappings: mappings.values,
    },
  };
}

type BoundedStringArrayResult =
  | Readonly<{ ok: true, values: string[] }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

function readBoundedStringArray(
  value: unknown,
  label: string,
  maxCount: number,
  maxStringBytes: number,
): BoundedStringArrayResult {
  if (!Array.isArray(value) || value.length > maxCount) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: `The source map ${label} array is missing or exceeds its limit.` } };
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || utf8ByteLength(item) > maxStringBytes) {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: `The source map ${label} contains an invalid or oversized string.` } };
    }
    values.push(item);
  }
  return { ok: true, values };
}

type SourceContentsResult =
  | Readonly<{ ok: true, values: (string | null)[], tooLarge: boolean[] }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

function readSourceContents(
  value: unknown,
  sourceCount: number,
  limits: JavaScriptSymbolicationLimits,
): SourceContentsResult {
  if (value === undefined) {
    return { ok: true, values: Array.from({ length: sourceCount }, () => null), tooLarge: Array.from({ length: sourceCount }, () => false) };
  }
  if (!Array.isArray(value) || value.length > sourceCount) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map sourcesContent array is invalid." } };
  }
  const values: (string | null)[] = [];
  const tooLarge: boolean[] = [];
  for (let index = 0; index < sourceCount; index++) {
    const item = value[index];
    if (item === null || item === undefined) {
      values.push(null);
      tooLarge.push(false);
      continue;
    }
    if (typeof item !== "string") {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map sourcesContent array contains a non-string entry." } };
    }
    if (utf8ByteLength(item) > limits.maxSourceContentBytes) {
      values.push(null);
      tooLarge.push(true);
      continue;
    }
    values.push(item);
    tooLarge.push(false);
  }
  return { ok: true, values, tooLarge };
}

type MappingParseResult =
  | Readonly<{ ok: true, values: (readonly MappingSegment[])[] }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

const EMPTY_MAPPING_LINE: readonly MappingSegment[] = Object.freeze([]);

function parseMappings(
  mappings: string,
  sourceCount: number,
  nameCount: number,
  maxSegments: number,
  maxLines: number,
): MappingParseResult {
  const lines: (readonly MappingSegment[])[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  let segmentCount = 0;

  let position = 0;
  while (true) {
    const lineSeparator = mappings.indexOf(";", position);
    const lineEnd = lineSeparator === -1 ? mappings.length : lineSeparator;
    if (lines.length >= maxLines) {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains too many generated lines." } };
    }
    let generatedColumn = 0;
    let line: MappingSegment[] | null = null;
    let segmentStart = position;
    while (segmentStart < lineEnd) {
      let segmentEnd = segmentStart;
      while (segmentEnd < lineEnd && mappings.charCodeAt(segmentEnd) !== 0x2c) segmentEnd += 1;
      const segmentText = mappings.slice(segmentStart, segmentEnd);
      segmentStart = segmentEnd + 1;
      if (segmentText === "") continue;
      segmentCount += 1;
      if (segmentCount > maxSegments) {
        return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains too many mapping segments." } };
      }
      const decoded = decodeVlqValues(segmentText);
      if (!decoded.ok) return decoded;
      const values = decoded.values;
      if (values.length !== 1 && values.length !== 4 && values.length !== 5) {
        return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains a malformed VLQ segment." } };
      }
      const nextGeneratedColumn = generatedColumn + values[0];
      if (values[0] < 0 || nextGeneratedColumn < 0 || !Number.isSafeInteger(nextGeneratedColumn)) {
        return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an invalid generated column delta." } };
      }
      generatedColumn = nextGeneratedColumn;
      if (values.length === 1) {
        (line ??= []).push({ generatedColumn, sourceIndex: null, originalLine: null, originalColumn: null, nameIndex: null });
        continue;
      }
      const nextSourceIndex = sourceIndex + values[1];
      const nextOriginalLine = originalLine + values[2];
      const nextOriginalColumn = originalColumn + values[3];
      if (
        nextSourceIndex < 0
        || nextSourceIndex >= sourceCount
        || nextOriginalLine < 0
        || nextOriginalColumn < 0
        || !Number.isSafeInteger(nextSourceIndex)
        || !Number.isSafeInteger(nextOriginalLine)
        || !Number.isSafeInteger(nextOriginalColumn)
      ) {
        return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an invalid original-location delta." } };
      }
      sourceIndex = nextSourceIndex;
      originalLine = nextOriginalLine;
      originalColumn = nextOriginalColumn;
      let mappedNameIndex: number | null = null;
      if (values.length === 5) {
        const nextNameIndex = nameIndex + values[4];
        if (nextNameIndex < 0 || nextNameIndex >= nameCount || !Number.isSafeInteger(nextNameIndex)) {
          return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an invalid name delta." } };
        }
        nameIndex = nextNameIndex;
        mappedNameIndex = nameIndex;
      }
      (line ??= []).push({
        generatedColumn,
        sourceIndex,
        originalLine,
        originalColumn,
        nameIndex: mappedNameIndex,
      });
    }
    lines.push(line ?? EMPTY_MAPPING_LINE);
    if (lineSeparator === -1) break;
    position = lineSeparator + 1;
  }
  return { ok: true, values: lines };
}

type VlqDecodeResult =
  | Readonly<{ ok: true, values: number[] }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

function decodeVlqValues(segment: string): VlqDecodeResult {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  let hasContinuation = false;
  for (const character of segment) {
    const digit = BASE64_ALPHABET.indexOf(character);
    if (digit < 0) {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an invalid base64 VLQ character." } };
    }
    value += (digit & 31) * (2 ** shift);
    if (!Number.isSafeInteger(value)) {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an oversized VLQ value." } };
    }
    hasContinuation = (digit & 32) !== 0;
    if (hasContinuation) {
      shift += 5;
      if (shift > 50) {
        return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an oversized VLQ segment." } };
      }
      continue;
    }
    const magnitude = Math.floor(value / 2);
    values.push(value % 2 === 1 ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  if (hasContinuation) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The source map contains an unterminated VLQ segment." } };
  }
  return { ok: true, values };
}

function findMapping(map: ParsedSourceMap, line: number, generatedColumn: number): MappingSegment | null {
  const segments = map.mappings.at(line - 1);
  if (segments === undefined) return null;
  let selected: MappingSegment | null = null;
  for (const segment of segments) {
    if (segment.generatedColumn > generatedColumn) break;
    selected = segment;
  }
  if (selected === null || selected.sourceIndex === null) return null;
  return selected;
}

type InlineSourceMapResult =
  | Readonly<{ ok: true, bytes: Uint8Array }>
  | Readonly<{ ok: false, diagnostic: SymbolicationDiagnostic }>;

function readInlineSourceMap(bundle: Uint8Array, maxBytes: number): InlineSourceMapResult {
  const bundleText = decodeUtf8(bundle);
  if (bundleText === null) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The inline source-map bundle is not valid UTF-8." } };
  }
  let sourceMapUrl: string | null = null;
  let match = INLINE_SOURCE_MAP_PATTERN.exec(bundleText);
  while (match !== null) {
    sourceMapUrl = match[1];
    match = INLINE_SOURCE_MAP_PATTERN.exec(bundleText);
  }
  if (sourceMapUrl === null || !/^data:/iu.test(sourceMapUrl)) {
    return { ok: false, diagnostic: { code: "missing_source_map", message: "The artifact does not contain an inline source map." } };
  }
  const commaIndex = sourceMapUrl.indexOf(",");
  if (commaIndex < 0) {
    return { ok: false, diagnostic: { code: "invalid_source_map", message: "The inline source-map data URL is malformed." } };
  }
  const metadata = sourceMapUrl.slice(0, commaIndex);
  const payload = sourceMapUrl.slice(commaIndex + 1);
  let bytes: Uint8Array;
  if (/;base64$/iu.test(metadata)) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 === 1) {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: "The inline source-map base64 payload is malformed." } };
    }
    bytes = new Uint8Array(Buffer.from(payload, "base64"));
  } else {
    try {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
      return { ok: false, diagnostic: { code: "invalid_source_map", message: "The inline source-map URI payload is malformed." } };
    }
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, diagnostic: { code: "source_map_too_large", message: "The inline source map exceeds the symbolication read limit." } };
  }
  return { ok: true, bytes };
}

function resolveSourcePath(sourceRoot: string, source: string): string {
  if (sourceRoot === "" || /^[a-z][a-z0-9+.-]*:/iu.test(source)) return source;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(sourceRoot)) {
    try {
      return new URL(source, sourceRoot).toString();
    } catch {
      return `${trimTrailingSlash(sourceRoot)}/${source}`;
    }
  }
  return `${trimTrailingSlash(sourceRoot)}/${source}`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function extractSourceContext(
  source: string,
  line: number,
  column: number,
  contextLines: number,
  maxLineBytes: number,
): SymbolicationSourceContext | null {
  const lines = source.split("\n").map((value) => value.endsWith("\r") ? value.slice(0, -1) : value);
  if (source.endsWith("\n") && lines.at(-1) === "") lines.pop();
  const index = line - 1;
  const contextLine = lines.at(index);
  if (contextLine === undefined) return null;
  const pre: string[] = [];
  for (let offset = Math.max(0, index - contextLines); offset < index; offset++) {
    const value = lines.at(offset);
    if (value !== undefined) pre.push(trimContextLine(value, column, maxLineBytes));
  }
  const post: string[] = [];
  for (let offset = index + 1; offset <= Math.min(lines.length - 1, index + contextLines); offset++) {
    const value = lines.at(offset);
    if (value !== undefined) post.push(trimContextLine(value, column, maxLineBytes));
  }
  return {
    pre,
    line: trimContextLine(contextLine, column, maxLineBytes),
    post,
  };
}

function trimContextLine(line: string, column: number, maxBytes: number): string {
  if (utf8ByteLength(line) <= maxBytes) return line;
  const markerBytes = utf8ByteLength(SOURCE_MAP_SNIP_MARKER);
  const availableBytes = Math.max(1, maxBytes - markerBytes - 1);
  const codePoints = Array.from(line);
  const center = Math.min(codePoints.length, Math.max(0, column - 1));
  let start = Math.max(0, center - Math.floor(availableBytes / 2));
  let end = Math.min(codePoints.length, start + availableBytes);
  let excerpt = codePoints.slice(start, end).join("");
  while (utf8ByteLength(excerpt) > availableBytes && end > start) {
    end -= 1;
    excerpt = codePoints.slice(start, end).join("");
  }
  let result = `${start > 0 ? `${SOURCE_MAP_SNIP_MARKER} ` : ""}${excerpt}${end < codePoints.length ? ` ${SOURCE_MAP_SNIP_MARKER}` : ""}`;
  while (utf8ByteLength(result) > maxBytes && end > start) {
    if (start > 0) start += 1;
    else end -= 1;
    excerpt = codePoints.slice(start, end).join("");
    result = `${start > 0 ? `${SOURCE_MAP_SNIP_MARKER} ` : ""}${excerpt}${end < codePoints.length ? ` ${SOURCE_MAP_SNIP_MARKER}` : ""}`;
  }
  return result;
}

export function artifactCodeFileMatchesFrame(artifactCodeFile: string, frameCodeFile: string): boolean {
  if (artifactCodeFile === frameCodeFile) return true;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(frameCodeFile)) return false;
  let pathname: string;
  try {
    pathname = new URL(frameCodeFile).pathname;
  } catch {
    return false;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
  }
  const relative = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return relative === artifactCodeFile || relative.endsWith(`/${artifactCodeFile}`);
}

function frameFailure(raw: RawJavaScriptFrame, diagnostics: readonly SymbolicationDiagnostic[]): SymbolicatedJavaScriptFrame {
  return { raw, location: null, diagnostics };
}

function artifactDiagnostic(
  code: SymbolicationDiagnosticCode,
  message: string,
  debugId: string,
  codeFile: string,
): SymbolicationDiagnostic {
  return { code, message, debugId, codeFile };
}

function withArtifact(diagnostic: SymbolicationDiagnostic, lookup: ArtifactLookup): SymbolicationDiagnostic {
  return {
    ...diagnostic,
    debugId: lookup.artifact.debugId,
    codeFile: lookup.artifact.codeFile,
  };
}

function resolveLimits(input: Partial<JavaScriptSymbolicationLimits>): JavaScriptSymbolicationLimits {
  return {
    maxFrames: positiveLimit(input.maxFrames, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxFrames, "maxFrames"),
    maxBundleBytes: positiveLimit(input.maxBundleBytes, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxBundleBytes, "maxBundleBytes"),
    maxSourceMapBytes: positiveLimit(input.maxSourceMapBytes, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxSourceMapBytes, "maxSourceMapBytes"),
    maxSourceMapGzippedBytes: positiveLimit(input.maxSourceMapGzippedBytes, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxSourceMapGzippedBytes, "maxSourceMapGzippedBytes"),
    maxSources: positiveLimit(input.maxSources, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxSources, "maxSources"),
    maxNames: positiveLimit(input.maxNames, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxNames, "maxNames"),
    maxPathBytes: positiveLimit(input.maxPathBytes, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxPathBytes, "maxPathBytes"),
    maxNameBytes: positiveLimit(input.maxNameBytes, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxNameBytes, "maxNameBytes"),
    maxMappingSegments: positiveLimit(input.maxMappingSegments, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxMappingSegments, "maxMappingSegments"),
    maxMappingLines: positiveLimit(input.maxMappingLines, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxMappingLines, "maxMappingLines"),
    maxSourceContentBytes: positiveLimit(input.maxSourceContentBytes, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxSourceContentBytes, "maxSourceContentBytes"),
    maxContextLines: positiveLimit(input.maxContextLines, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxContextLines, "maxContextLines"),
    maxContextLineBytes: contextLineBytesLimit(input.maxContextLineBytes),
  };
}

const MIN_CONTEXT_LINE_BYTES = 2 * utf8ByteLength(SOURCE_MAP_SNIP_MARKER) + 2;

function contextLineBytesLimit(value: number | undefined): number {
  const limit = positiveLimit(value, DEFAULT_JAVASCRIPT_SYMBOLICATION_LIMITS.maxContextLineBytes, "maxContextLineBytes");
  if (limit < MIN_CONTEXT_LINE_BYTES) {
    throw new Error(`maxContextLineBytes must be at least ${MIN_CONTEXT_LINE_BYTES} to fit the snip markers around one code point.`);
  }
  return limit;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function boundedContextLines(value: number | undefined, max: number): number {
  if (value === undefined) return max;
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, max);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
