import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  type ArtifactManifest,
  type ArtifactScope,
} from "../artifacts/artifact-manifest";
import type {
  ArtifactObjectStorage,
  ArtifactStorageObject,
  ArtifactStorageObjectInfo,
  ArtifactUploadContentType,
} from "../artifacts/artifact-storage";
import { ArtifactUploadService, type ArtifactLookup } from "../artifacts/artifact-upload-service";
import {
  artifactCodeFileMatchesFrame,
  JavaScriptSymbolicationService,
  parseStandardSourceMap,
  type RawJavaScriptFrame,
} from "./javascript-symbolication";

const SCOPE = {
  tenantId: "tenant-symbolication",
  projectId: "project-symbolication",
  branchId: "main",
} satisfies ArtifactScope;

const DEBUG_ID = "01234567-89ab-cdef-0123-456789abcdef";
const BUNDLE = new TextEncoder().encode("function a(){throw Error('boom')}\n");
const SOURCE = "const before = true;\nthrow new Error(\"boom\");\nconst after = true;\n";
const SOURCE_MAP = new TextEncoder().encode(JSON.stringify({
  version: 3,
  sources: ["src/original.ts"],
  names: ["boom"],
  sourcesContent: [SOURCE],
  mappings: ";AACAA",
}));

class MemoryArtifactStorage implements ArtifactObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  public readonly readExpectedETags: string[] = [];

  public async putImmutableObject(object: ArtifactStorageObject): Promise<boolean> {
    if (this.objects.has(object.key)) return false;
    this.objects.set(object.key, new Uint8Array(object.body));
    return true;
  }

  public async createUploadUrl(options: { key: string, contentType: ArtifactUploadContentType, contentEncoding?: "gzip" }): Promise<string> {
    return `https://uploads.example.test/${encodeURIComponent(options.key)}`;
  }

  public async headObject(key: string): Promise<ArtifactStorageObjectInfo | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { byteLength: body.byteLength, eTag: `etag:${key}` };
  }

  public async readObject(key: string, expectedETag?: string): Promise<Uint8Array | null> {
    if (expectedETag !== undefined) this.readExpectedETags.push(expectedETag);
    const body = this.objects.get(key);
    return body === undefined ? null : new Uint8Array(body);
  }

  public upload(key: string, body: Uint8Array): void {
    this.objects.set(key, new Uint8Array(body));
  }
}

class LookupOnlyArtifactService extends ArtifactUploadService {
  public constructor(private readonly result: ArtifactLookup) {
    super(new MemoryArtifactStorage());
  }

  public override async lookupArtifact(_scope: ArtifactScope, _query: { debugId: string, release: string | null, dist: string | null }): Promise<ArtifactLookup> {
    return this.result;
  }
}

function createManifest(): ArtifactManifest {
  const compressedSourceMap = gzipSync(SOURCE_MAP);
  return {
    schemaVersion: 1,
    projectId: SCOPE.projectId,
    release: "web@2026.08.06",
    dist: "production",
    environment: "production",
    artifacts: [{
      debugId: DEBUG_ID,
      codeFile: "static/chunk.js",
      sourceMapFile: "static/chunk.js.map",
      sourceMapInline: false,
      bundleSha256: sha256Hex(BUNDLE),
      bundleBytes: BUNDLE.byteLength,
      sourceMapSha256: sha256Hex(SOURCE_MAP),
      sourceMapBytes: SOURCE_MAP.byteLength,
      sourceMapGzippedBytes: compressedSourceMap.byteLength,
    }],
  };
}

function manifestDigest(manifest: ArtifactManifest): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
}

async function createFixture(): Promise<{
  storage: MemoryArtifactStorage,
  service: JavaScriptSymbolicationService,
  sourceMapKey: string,
}> {
  const storage = new MemoryArtifactStorage();
  const artifacts = new ArtifactUploadService(storage);
  const manifest = createManifest();
  const registered = await artifacts.registerManifest(SCOPE, {
    manifest,
    manifestSha256: manifestDigest(manifest),
  });
  const descriptor = registered.artifacts.at(0);
  if (descriptor === undefined || descriptor.sourceMapObjectKey === null) throw new Error("Expected an external source-map descriptor.");
  storage.upload(descriptor.bundleObjectKey, BUNDLE);
  storage.upload(descriptor.sourceMapObjectKey, gzipSync(SOURCE_MAP));
  await artifacts.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 });
  return {
    storage,
    service: new JavaScriptSymbolicationService(artifacts, storage),
    sourceMapKey: descriptor.sourceMapObjectKey,
  };
}

function frame(overrides: Partial<RawJavaScriptFrame> = {}): RawJavaScriptFrame {
  return {
    codeFile: "static/chunk.js",
    debugId: DEBUG_ID,
    lineno: 2,
    colno: 1,
    function: "a",
    ...overrides,
  };
}

describe("JavaScriptSymbolicationService", () => {
  it("resolves exact debug-ID artifacts with VLQ locations, names, and bounded source context", async () => {
    const fixture = await createFixture();
    const raw = frame();

    const result = await fixture.service.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames: [raw],
    });

    expect(result).toMatchObject({ truncatedFrameCount: 0, diagnostics: [] });
    expect(result.frames[0]).toEqual({
      raw,
      location: {
        source: "src/original.ts",
        line: 2,
        column: 1,
        name: "boom",
        sourceContext: {
          pre: ["const before = true;"],
          line: "throw new Error(\"boom\");",
          post: ["const after = true;"],
        },
        artifact: {
          manifestSha256: expect.any(String),
          debugId: DEBUG_ID,
          codeFile: "static/chunk.js",
        },
      },
      diagnostics: [],
    });
    expect(fixture.storage.readExpectedETags.length).toBeGreaterThan(0);
    expect(fixture.storage.readExpectedETags.every((etag) => etag.startsWith("etag:"))).toBe(true);
  });

  it("preserves raw frames and diagnoses missing, mismatched, and invalid artifacts", async () => {
    const missingStorage = new MemoryArtifactStorage();
    const missingService = new JavaScriptSymbolicationService(new ArtifactUploadService(missingStorage), missingStorage);
    const missingRaw = frame();
    const missing = await missingService.symbolicate({ scope: SCOPE, release: "web@2026.08.06", dist: "production", frames: [missingRaw] });
    expect(missing.frames[0]).toMatchObject({ raw: missingRaw, location: null, diagnostics: [{ code: "missing_artifact" }] });

    const fixture = await createFixture();
    const mismatchedRaw = frame({ codeFile: "static/other.js" });
    const mismatched = await fixture.service.symbolicate({ scope: SCOPE, release: "web@2026.08.06", dist: "production", frames: [frame(), mismatchedRaw] });
    expect(mismatched.frames[1]).toMatchObject({ raw: mismatchedRaw, location: null, diagnostics: [{ code: "artifact_mismatch" }] });

    const invalidRaw = frame();
    fixture.storage.upload(fixture.sourceMapKey, gzipSync(new TextEncoder().encode("not-json")));
    const invalid = await fixture.service.symbolicate({ scope: SCOPE, release: "web@2026.08.06", dist: "production", frames: [invalidRaw] });
    expect(invalid.frames[0]).toMatchObject({ raw: invalidRaw, location: null, diagnostics: [{ code: "artifact_integrity_mismatch" }] });

    const parsed = parseStandardSourceMap(JSON.stringify({ version: 3, sources: ["src.ts"], names: [], mappings: "A?" }));
    expect(parsed).toMatchObject({ ok: false, diagnostic: { code: "invalid_source_map" } });

    const invalidFixture = await createFixture();
    const invalidMap = new TextEncoder().encode("not-json");
    const invalidCompressedMap = gzipSync(invalidMap);
    const invalidLookup = await new ArtifactUploadService(invalidFixture.storage).lookupArtifact(SCOPE, {
      debugId: DEBUG_ID,
      release: "web@2026.08.06",
      dist: "production",
    });
    if (invalidLookup === null) throw new Error("Expected the invalid-map fixture artifact to be indexed.");
    invalidFixture.storage.upload(invalidFixture.sourceMapKey, invalidCompressedMap);
    const invalidArtifactLookup: ArtifactLookup = {
      ...invalidLookup,
      artifact: {
        ...invalidLookup.artifact,
        sourceMapSha256: sha256Hex(invalidMap),
        sourceMapBytes: invalidMap.byteLength,
        sourceMapGzippedBytes: invalidCompressedMap.byteLength,
      },
    };
    const invalidService = new JavaScriptSymbolicationService(
      new LookupOnlyArtifactService(invalidArtifactLookup),
      invalidFixture.storage,
    );
    const invalidArtifactResult = await invalidService.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames: [frame()],
    });
    expect(invalidArtifactResult.frames[0]).toMatchObject({ location: null, diagnostics: [{ code: "invalid_source_map" }] });
  });

  it("reports frame and source-content bounds without doing unbounded work", async () => {
    const fixture = await createFixture();
    const frames = Array.from({ length: 3 }, () => frame());
    const result = await fixture.service.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames,
      applySourceContext: false,
    });
    expect(result.frames).toHaveLength(3);
    expect(result.frames.every((value) => value.location !== null)).toBe(true);

    const bounded = new JavaScriptSymbolicationService(
      new ArtifactUploadService(fixture.storage),
      fixture.storage,
      { maxFrames: 2 },
    );
    const boundedResult = await bounded.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames,
    });
    expect(boundedResult.frames).toHaveLength(2);
    expect(boundedResult.truncatedFrameCount).toBe(1);
    expect(boundedResult.diagnostics).toEqual([{ code: "frame_limit_exceeded", message: "Symbolication processed only the first 2 frames." }]);
  });

  it("retains a resolved location when source context is unavailable", async () => {
    const fixture = await createFixture();
    const mapWithoutSourcesContent = new TextEncoder().encode(JSON.stringify({
      version: 3,
      sources: ["src/original.ts"],
      names: ["boom"],
      mappings: ";AACAA",
    }));
    const realArtifacts = new ArtifactUploadService(fixture.storage);
    const lookedUp = await realArtifacts.lookupArtifact(SCOPE, {
      debugId: DEBUG_ID,
      release: "web@2026.08.06",
      dist: "production",
    });
    if (lookedUp === null) throw new Error("Expected the fixture artifact to be indexed.");
    const compressedMapWithoutSourcesContent = gzipSync(mapWithoutSourcesContent);
    const lookupWithoutSourcesContent: ArtifactLookup = {
      ...lookedUp,
      artifact: {
        ...lookedUp.artifact,
        sourceMapSha256: sha256Hex(mapWithoutSourcesContent),
        sourceMapBytes: mapWithoutSourcesContent.byteLength,
        sourceMapGzippedBytes: compressedMapWithoutSourcesContent.byteLength,
      },
    };
    fixture.storage.upload(fixture.sourceMapKey, compressedMapWithoutSourcesContent);
    const service = new JavaScriptSymbolicationService(new LookupOnlyArtifactService(lookupWithoutSourcesContent), fixture.storage);

    const result = await service.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames: [frame()],
    });

    expect(result.frames[0]).toMatchObject({
      location: { source: "src/original.ts", line: 2, column: 1, name: "boom" },
      diagnostics: [{ code: "missing_source_content" }],
    });
  });

  it("bounds generated mapping lines so delimiter-only mappings cannot amplify memory", () => {
    const floodedLines = JSON.stringify({ version: 3, sources: [], names: [], mappings: ";".repeat(64) });
    expect(parseStandardSourceMap(floodedLines, { maxMappingLines: 64 })).toMatchObject({
      ok: false,
      diagnostic: { code: "invalid_source_map", message: "The source map contains too many generated lines." },
    });

    const sparse = parseStandardSourceMap(JSON.stringify({
      version: 3,
      sources: ["src.ts"],
      names: [],
      mappings: `;;${",".repeat(32)}AACA;`,
    }), { maxMappingLines: 64 });
    if (!sparse.ok) throw new Error("Expected the sparse map to parse.");
    expect(sparse.map.mappings).toHaveLength(4);
    expect(sparse.map.mappings[0]).toBe(sparse.map.mappings[1]);
    expect(sparse.map.mappings[2]).toMatchObject([{ generatedColumn: 0, sourceIndex: 0, originalLine: 1, originalColumn: 0 }]);
  });

  it("treats an out-of-convention zero column like a missing column instead of failing the frame", async () => {
    const fixture = await createFixture();
    const zeroColumnRaw = frame({ colno: 0 });
    const result = await fixture.service.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames: [zeroColumnRaw],
    });
    expect(result.frames[0]).toMatchObject({
      location: { source: "src/original.ts", line: 2, column: 1 },
      diagnostics: [{ code: "invalid_frame_location", column: 0 }],
    });
  });

  it("rejects context-line byte limits too small to honor the snip markers", () => {
    expect(() => new JavaScriptSymbolicationService(
      new ArtifactUploadService(new MemoryArtifactStorage()),
      new MemoryArtifactStorage(),
      { maxContextLineBytes: 8 },
    )).toThrowError(/maxContextLineBytes/u);
  });

  it("joins a browser stack URL onto the relative emitted artifact path", async () => {
    const fixture = await createFixture();
    const raw = frame({ codeFile: "https://cdn.example.test/_next/static/chunk.js" });
    const result = await fixture.service.symbolicate({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames: [raw],
    });
    expect(result.frames[0]?.location?.source).toBe("src/original.ts");
    expect(result.frames[0]?.diagnostics).toEqual([]);
  });
});

describe("artifactCodeFileMatchesFrame", () => {
  it("accepts an exact relative path, a served URL, and a CDN-prefixed pathname", () => {
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "static/chunk.js")).toBe(true);
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "https://cdn.example.test/static/chunk.js")).toBe(true);
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "https://cdn.example.test/_next/static/chunk.js")).toBe(true);
  });

  it("decodes percent-encoded URL pathnames before comparing with the manifest path", () => {
    expect(artifactCodeFileMatchesFrame("static/my file.js", "https://cdn.example.test/static/my%20file.js")).toBe(true);
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "https://cdn.example.test/st%61tic/chunk.js")).toBe(true);
    expect(artifactCodeFileMatchesFrame("static/%zz.js", "https://cdn.example.test/static/%zz.js")).toBe(true);
    expect(artifactCodeFileMatchesFrame("static/other.js", "https://cdn.example.test/static/my%20file.js")).toBe(false);
  });

  it("rejects a different relative path or a URL that does not end at the artifact", () => {
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "static/other.js")).toBe(false);
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "https://cdn.example.test/static/other.js")).toBe(false);
    expect(artifactCodeFileMatchesFrame("static/chunk.js", "https://cdn.example.test/not-static/chunk.js")).toBe(false);
  });
});
