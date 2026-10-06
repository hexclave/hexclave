import type {
  PublicIssueErrorEnvelope,
  PublicIssueFrameSymbolication,
  PublicIssueSymbolicationDiagnostic,
} from "@/app/api/latest/issues/contract";
import { ArtifactServiceError } from "../artifacts/artifact-errors";
import { validateArtifactMetadata } from "../artifacts/artifact-manifest";
import { createS3ArtifactObjectStorage } from "../artifacts/artifact-storage";
import { ArtifactUploadService } from "../artifacts/artifact-upload-service";
import {
  JavaScriptSymbolicationService,
  type RawJavaScriptFrame,
  type SymbolicatedJavaScriptFrame,
  type SymbolicationDiagnostic,
} from "../symbolication";
import { scrubPublicText } from "./public-scrub";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";

export type StoredIssueFrame = {
  filename: string | null,
  function: string | null,
  module: string | null,
  absPath: string | null,
  lineno: number | null,
  colno: number | null,
  inApp: boolean,
  debugId: string | null,
};

type StoredDebugImage = {
  codeFile: string,
  debugId: string | null,
};

export type PublicIssueSymbolicator = Pick<JavaScriptSymbolicationService, "symbolicate">;

const PUBLIC_ISSUE_SYMBOLICATOR: PublicIssueSymbolicator = (() => {
  const storage = createS3ArtifactObjectStorage();
  return new JavaScriptSymbolicationService(new ArtifactUploadService(storage), storage);
})();

type SymbolicationMetadata = {
  release: string | null,
  dist: string | null,
  debugImages: readonly StoredDebugImage[],
};

type MetadataDiagnosticCode = "missing_release_metadata" | "invalid_release_metadata" | "invalid_dist_metadata";

function metadataDiagnostic(code: MetadataDiagnosticCode, message: string): PublicIssueSymbolicationDiagnostic {
  return { code, message };
}

function hasOwn(record: Record<string, Json>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stringField(record: Record<string, Json>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function parseStoredDebugImages(value: Json | undefined): StoredDebugImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const codeFile = stringField(item, "code_file", "codeFile");
    if (codeFile === null || codeFile === "") return [];
    const debugIdValue = item.debug_id ?? item.debugId;
    return [{
      codeFile,
      debugId: typeof debugIdValue === "string" ? debugIdValue : null,
    }];
  });
}

function metadataSource(
  data: Record<string, Json>,
  envelope: PublicIssueErrorEnvelope | null,
  key: string,
): Record<string, Json> | null {
  if (hasOwn(data, key)) return data;
  if (envelope !== null && hasOwn(envelope, key)) return envelope;
  return null;
}

function readSymbolicationMetadata(
  data: Record<string, Json>,
  envelope: PublicIssueErrorEnvelope | null,
): {
  metadata: SymbolicationMetadata | null,
  diagnostics: PublicIssueSymbolicationDiagnostic[],
} {
  const diagnostics: PublicIssueSymbolicationDiagnostic[] = [];
  let release: string | null = null;
  const releaseSource = metadataSource(data, envelope, "release");
  if (releaseSource === null) {
    diagnostics.push(metadataDiagnostic(
      "missing_release_metadata",
      "The occurrence projection and canonical error envelope do not contain an exact release value, so source-map lookup was not attempted.",
    ));
  } else {
    try {
      release = validateArtifactMetadata(releaseSource.release, "occurrence.release");
    } catch (error) {
      if (!(error instanceof ArtifactServiceError) || error.code !== "invalid_manifest") throw error;
      diagnostics.push(metadataDiagnostic("invalid_release_metadata", "The occurrence release value is not valid artifact metadata."));
    }
  }

  let dist: string | null = null;
  const distSource = metadataSource(data, envelope, "dist");
  if (distSource !== null) {
    try {
      dist = validateArtifactMetadata(distSource.dist, "occurrence.dist");
    } catch (error) {
      if (!(error instanceof ArtifactServiceError) || error.code !== "invalid_manifest") throw error;
      diagnostics.push(metadataDiagnostic("invalid_dist_metadata", "The occurrence distribution value is not valid artifact metadata."));
    }
  }

  if (diagnostics.length > 0) return { metadata: null, diagnostics };
  const envelopeDebugMeta = envelope !== null && isRecord(envelope.debug_meta) ? envelope.debug_meta : null;
  return {
    metadata: {
      release,
      dist,
      debugImages: [
        ...parseStoredDebugImages(data.debug_images),
        ...parseStoredDebugImages(isRecord(data.debug_meta) ? data.debug_meta.images : undefined),
        ...parseStoredDebugImages(envelopeDebugMeta?.images),
      ],
    },
    diagnostics,
  };
}

export function emptyFrameSymbolication(
  status: PublicIssueFrameSymbolication["status"],
  diagnostics: readonly PublicIssueSymbolicationDiagnostic[],
): PublicIssueFrameSymbolication {
  return {
    status,
    source_file: null,
    original_line: null,
    original_column: null,
    name: null,
    context: null,
    diagnostics: [...diagnostics],
  };
}

function toPublicDiagnostic(diagnostic: SymbolicationDiagnostic): PublicIssueSymbolicationDiagnostic {
  const publicDiagnostic: PublicIssueSymbolicationDiagnostic = {
    code: diagnostic.code,
    message: scrubPublicText(diagnostic.message),
  };
  if (diagnostic.debugId !== undefined) publicDiagnostic.debug_id = scrubPublicText(diagnostic.debugId);
  if (diagnostic.codeFile !== undefined) publicDiagnostic.code_file = scrubPublicText(diagnostic.codeFile);
  if (diagnostic.line !== undefined) publicDiagnostic.line = diagnostic.line;
  if (diagnostic.column !== undefined) publicDiagnostic.column = diagnostic.column;
  if (diagnostic.source !== undefined) publicDiagnostic.source = scrubPublicText(diagnostic.source);
  return publicDiagnostic;
}

function toPublicFrameSymbolication(frame: SymbolicatedJavaScriptFrame): PublicIssueFrameSymbolication {
  const diagnostics = frame.diagnostics.map(toPublicDiagnostic);
  if (frame.location === null) return emptyFrameSymbolication("unsymbolicated", diagnostics);

  const sourceContext = frame.location.sourceContext;
  return {
    status: "symbolicated",
    source_file: scrubPublicText(frame.location.source),
    original_line: frame.location.line,
    original_column: frame.location.column,
    name: frame.location.name === null ? null : scrubPublicText(frame.location.name),
    context: sourceContext === undefined ? null : {
      pre: sourceContext.pre.map(scrubPublicText),
      line: scrubPublicText(sourceContext.line),
      post: sourceContext.post.map(scrubPublicText),
    },
    diagnostics,
  };
}

function debugIdForFrame(frame: StoredIssueFrame, debugImages: readonly StoredDebugImage[]): string | null {
  if (frame.debugId !== null) return frame.debugId;
  if (frame.absPath === null || frame.absPath === "") return null;
  return debugImages.find((image) => image.codeFile === frame.absPath)?.debugId ?? null;
}

export async function symbolicatePublicFrames(options: {
  frames: readonly StoredIssueFrame[],
  data: Record<string, Json>,
  envelope: PublicIssueErrorEnvelope | null,
  scope: { tenantId: string, projectId: string, branchId: string },
  symbolicator?: PublicIssueSymbolicator,
}): Promise<{
  frames: PublicIssueFrameSymbolication[],
  diagnostics: PublicIssueSymbolicationDiagnostic[],
}> {
  const metadataResult = readSymbolicationMetadata(options.data, options.envelope);
  const frameSymbolication = options.frames.map(() => emptyFrameSymbolication("not_attempted", metadataResult.diagnostics));
  if (metadataResult.metadata === null) {
    return { frames: frameSymbolication, diagnostics: metadataResult.diagnostics };
  }

  const candidates: { index: number, raw: RawJavaScriptFrame }[] = [];
  for (const [index, frame] of options.frames.entries()) {
    if (frame.absPath === null || frame.absPath === "") {
      frameSymbolication[index] = emptyFrameSymbolication("not_attempted", [{
        code: "missing_code_file_metadata",
        message: "The occurrence frame has no exact emitted artifact path, so symbolication was not attempted.",
      }]);
      continue;
    }
    candidates.push({
      index,
      raw: {
        codeFile: frame.absPath,
        debugId: debugIdForFrame(frame, metadataResult.metadata.debugImages),
        lineno: frame.lineno,
        colno: frame.colno,
        function: frame.function,
      },
    });
  }

  if (candidates.length === 0) return { frames: frameSymbolication, diagnostics: [] };

  const symbolicator = options.symbolicator ?? PUBLIC_ISSUE_SYMBOLICATOR;
  const result = await symbolicator.symbolicate({
    scope: options.scope,
    release: metadataResult.metadata.release,
    dist: metadataResult.metadata.dist,
    frames: candidates.map((candidate) => candidate.raw),
    applySourceContext: true,
  });
  const diagnostics = result.diagnostics.map(toPublicDiagnostic);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const resultFrame = result.frames.at(candidateIndex);
    if (resultFrame === undefined) {
      frameSymbolication[candidate.index] = emptyFrameSymbolication("unsymbolicated", diagnostics);
      continue;
    }
    frameSymbolication[candidate.index] = toPublicFrameSymbolication(resultFrame);
  }
  return { frames: frameSymbolication, diagnostics };
}
