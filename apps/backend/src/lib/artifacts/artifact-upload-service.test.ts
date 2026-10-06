import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ArtifactServiceError } from "./artifact-errors";
import {
  sha256Hex,
  type ArtifactManifest,
  type ArtifactScope,
} from "./artifact-manifest";
import type {
  ArtifactObjectStorage,
  ArtifactStorageObject,
  ArtifactStorageObjectInfo,
  ArtifactUploadContentType,
} from "./artifact-storage";
import {
  ArtifactUploadService,
  type ArtifactManifestRegistrationResult,
} from "./artifact-upload-service";

const SCOPE = {
  tenantId: "tenancy-1",
  projectId: "project-1",
  branchId: "main",
} satisfies ArtifactScope;

const OTHER_SCOPE = {
  tenantId: "tenancy-2",
  projectId: "project-1",
  branchId: "main",
} satisfies ArtifactScope;

const DEBUG_ID = "01234567-89ab-cdef-0123-456789abcdef";
const BUNDLE = new TextEncoder().encode("console.log('minified');\n");
const SOURCE_MAP = new TextEncoder().encode(JSON.stringify({
  version: 3,
  sources: ["src/index.ts"],
  names: [],
  mappings: "AAAA",
}));
const SOURCE_MAP_GZIP = gzipSync(SOURCE_MAP);

class MemoryArtifactStorage implements ArtifactObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();

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
    return body === undefined ? null : { byteLength: body.byteLength };
  }

  public async readObject(key: string): Promise<Uint8Array | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : new Uint8Array(body);
  }

  public upload(key: string, body: Uint8Array): void {
    this.objects.set(key, new Uint8Array(body));
  }

  public deleteMatching(suffix: string): void {
    for (const key of this.objects.keys()) {
      if (key.endsWith(suffix)) this.objects.delete(key);
    }
  }
}

function createManifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
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
      sourceMapGzippedBytes: SOURCE_MAP_GZIP.byteLength,
    }],
    ...overrides,
  };
}

function manifestDigest(manifest: ArtifactManifest): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
}

async function register(
  service: ArtifactUploadService,
  storage: MemoryArtifactStorage,
  scope: ArtifactScope = SCOPE,
): Promise<ArtifactManifestRegistrationResult> {
  const manifest = createManifest({ projectId: scope.projectId });
  const result = await service.registerManifest(scope, {
    manifest,
    manifestSha256: manifestDigest(manifest),
  });
  const descriptor = result.artifacts[0];
  storage.upload(descriptor.bundleObjectKey, BUNDLE);
  if (descriptor.sourceMapObjectKey === null) throw new Error("Expected an external source map object.");
  storage.upload(descriptor.sourceMapObjectKey, SOURCE_MAP_GZIP);
  return result;
}

describe("artifact upload service", () => {
  it("registers, verifies, finalizes, and exactly looks up a private artifact", async () => {
    const storage = new MemoryArtifactStorage();
    const service = new ArtifactUploadService(storage);
    const registered = await register(service, storage);

    expect(registered.status).toBe("registered");
    expect(registered.finalizePath).toBe("/api/latest/source-maps/artifacts/finalize");
    expect(registered.artifacts[0]?.bundleUploadUrl).toMatch(/^https:\/\/uploads\.example\.test\//u);

    const finalized = await service.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 });
    expect(finalized).toEqual({
      manifestSha256: registered.manifestSha256,
      status: "finalized",
      uploaded: [DEBUG_ID],
      alreadyUploaded: [],
    });

    const lookedUp = await service.lookupArtifact(SCOPE, {
      debugId: DEBUG_ID,
      release: "web@2026.08.06",
      dist: "production",
    });
    expect(lookedUp).toMatchObject({
      manifestSha256: registered.manifestSha256,
      artifact: { debugId: DEBUG_ID, codeFile: "static/chunk.js" },
      bundleObjectKey: registered.artifacts[0]?.bundleObjectKey,
    });

    const repeatedRegistration = await service.registerManifest(SCOPE, {
      manifest: createManifest(),
      manifestSha256: registered.manifestSha256,
    });
    expect(repeatedRegistration.status).toBe("already_registered");
    expect(repeatedRegistration.artifacts[0]?.alreadyFinalized).toBe(true);

    const repeatedFinalize = await service.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 });
    expect(repeatedFinalize.status).toBe("already_finalized");
    expect(repeatedFinalize.uploaded).toEqual([]);
    expect(repeatedFinalize.alreadyUploaded).toEqual([DEBUG_ID]);
  });

  it("does not serve a debug-ID index until its manifest finalize marker exists", async () => {
    const storage = new MemoryArtifactStorage();
    const service = new ArtifactUploadService(storage);
    const registered = await register(service, storage);
    await service.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 });
    storage.deleteMatching(`/finalized/${registered.manifestSha256}.json`);

    await expect(service.lookupArtifact(SCOPE, {
      debugId: DEBUG_ID,
      release: "web@2026.08.06",
      dist: "production",
    })).resolves.toBeNull();
  });

  it("keeps exact debug-ID lookup isolated by authenticated tenancy and release binding", async () => {
    const storage = new MemoryArtifactStorage();
    const service = new ArtifactUploadService(storage);
    const registered = await register(service, storage);
    await service.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 });

    await expect(service.lookupArtifact(OTHER_SCOPE, {
      debugId: DEBUG_ID,
      release: "web@2026.08.06",
      dist: "production",
    })).resolves.toBeNull();
    await expect(service.lookupArtifact(SCOPE, {
      debugId: DEBUG_ID,
      release: "web@2026.08.06",
      dist: "other-dist",
    })).resolves.toBeNull();
    await expect(service.lookupArtifact(SCOPE, {
      debugId: DEBUG_ID,
      release: "release\u0000with-control",
      dist: null,
    })).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("fails finalization loudly when an uploaded object is missing or has the wrong digest", async () => {
    const missingStorage = new MemoryArtifactStorage();
    const missingService = new ArtifactUploadService(missingStorage);
    const missingManifest = createManifest();
    const missingRegistration = await missingService.registerManifest(SCOPE, {
      manifest: missingManifest,
      manifestSha256: manifestDigest(missingManifest),
    });
    await expect(missingService.finalizeManifest(SCOPE, { manifestSha256: missingRegistration.manifestSha256 }))
      .rejects.toMatchObject({ code: "artifact_not_found" });

    const wrongStorage = new MemoryArtifactStorage();
    const wrongService = new ArtifactUploadService(wrongStorage);
    const wrongRegistration = await register(wrongService, wrongStorage);
    const descriptor = wrongRegistration.artifacts[0];
    if (descriptor.sourceMapObjectKey === null) throw new Error("Expected an external source map object.");
    const wrongDigestBundle = new TextEncoder().encode("console.log('MINIFIED');\n");
    if (wrongDigestBundle.byteLength !== BUNDLE.byteLength) throw new Error("Fixture bundles must have equal byte lengths to exercise the digest branch.");
    wrongStorage.upload(descriptor.bundleObjectKey, wrongDigestBundle);
    await expect(wrongService.finalizeManifest(SCOPE, { manifestSha256: wrongRegistration.manifestSha256 }))
      .rejects.toMatchObject({ code: "integrity_mismatch", message: expect.stringContaining("digest") });

    const lengthStorage = new MemoryArtifactStorage();
    const lengthService = new ArtifactUploadService(lengthStorage);
    const lengthRegistration = await register(lengthService, lengthStorage);
    lengthStorage.upload(lengthRegistration.artifacts[0].bundleObjectKey, new TextEncoder().encode("different bundle"));
    await expect(lengthService.finalizeManifest(SCOPE, { manifestSha256: lengthRegistration.manifestSha256 }))
      .rejects.toMatchObject({ code: "integrity_mismatch", message: expect.stringContaining("byte length") });
  });

  it("rejects indexed (sections) source maps at finalization", async () => {
    const storage = new MemoryArtifactStorage();
    const service = new ArtifactUploadService(storage);
    const sectionsMap = new TextEncoder().encode(JSON.stringify({ version: 3, sections: [] }));
    const sectionsMapGzip = gzipSync(sectionsMap);
    const manifest = createManifest({
      artifacts: [{
        debugId: DEBUG_ID,
        codeFile: "static/chunk.js",
        sourceMapFile: "static/chunk.js.map",
        sourceMapInline: false,
        bundleSha256: sha256Hex(BUNDLE),
        bundleBytes: BUNDLE.byteLength,
        sourceMapSha256: sha256Hex(sectionsMap),
        sourceMapBytes: sectionsMap.byteLength,
        sourceMapGzippedBytes: sectionsMapGzip.byteLength,
      }],
    });
    const registered = await service.registerManifest(SCOPE, { manifest, manifestSha256: manifestDigest(manifest) });
    const descriptor = registered.artifacts[0];
    if (descriptor.sourceMapObjectKey === null) throw new Error("Expected an external source map object.");
    storage.upload(descriptor.bundleObjectKey, BUNDLE);
    storage.upload(descriptor.sourceMapObjectKey, sectionsMapGzip);
    await expect(service.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 }))
      .rejects.toMatchObject({ code: "unsupported_source_map" });
  });

  it("uses the symbolicator's bounded VLQ parser during finalization", async () => {
    const storage = new MemoryArtifactStorage();
    const service = new ArtifactUploadService(storage);
    const invalidMap = new TextEncoder().encode(JSON.stringify({
      version: 3,
      sources: ["src/index.ts"],
      names: [],
      mappings: "!",
    }));
    const compressed = gzipSync(invalidMap);
    const manifest = createManifest({
      artifacts: [{
        debugId: DEBUG_ID,
        codeFile: "static/chunk.js",
        sourceMapFile: "static/chunk.js.map",
        sourceMapInline: false,
        bundleSha256: sha256Hex(BUNDLE),
        bundleBytes: BUNDLE.byteLength,
        sourceMapSha256: sha256Hex(invalidMap),
        sourceMapBytes: invalidMap.byteLength,
        sourceMapGzippedBytes: compressed.byteLength,
      }],
    });
    const registered = await service.registerManifest(SCOPE, { manifest, manifestSha256: manifestDigest(manifest) });
    const descriptor = registered.artifacts[0];
    if (descriptor.sourceMapObjectKey === null) throw new Error("Expected an external source map object.");
    storage.upload(descriptor.bundleObjectKey, BUNDLE);
    storage.upload(descriptor.sourceMapObjectKey, compressed);
    await expect(service.finalizeManifest(SCOPE, { manifestSha256: registered.manifestSha256 }))
      .rejects.toMatchObject({ code: "integrity_mismatch", message: expect.stringContaining("base64 VLQ") });
  });

  it("verifies inline source-map bytes against the manifest digest at finalization", async () => {
    const inlineMap = new TextEncoder().encode(JSON.stringify({
      version: 3,
      sources: ["src/index.ts"],
      names: [],
      mappings: "AAAA",
    }));
    const inlineBundle = new TextEncoder().encode(
      `console.log('inline');\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(inlineMap).toString("base64")}\n`,
    );
    const createInlineManifest = (sourceMapSha256: string, sourceMapBytes: number): ArtifactManifest => createManifest({
      artifacts: [{
        debugId: DEBUG_ID,
        codeFile: "static/inline.js",
        sourceMapFile: null,
        sourceMapInline: true,
        bundleSha256: sha256Hex(inlineBundle),
        bundleBytes: inlineBundle.byteLength,
        sourceMapSha256,
        sourceMapBytes,
        sourceMapGzippedBytes: gzipSync(inlineMap).byteLength,
      }],
    });

    const goodStorage = new MemoryArtifactStorage();
    const goodService = new ArtifactUploadService(goodStorage);
    const goodManifest = createInlineManifest(sha256Hex(inlineMap), inlineMap.byteLength);
    const goodRegistration = await goodService.registerManifest(SCOPE, { manifest: goodManifest, manifestSha256: manifestDigest(goodManifest) });
    goodStorage.upload(goodRegistration.artifacts[0].bundleObjectKey, inlineBundle);
    await expect(goodService.finalizeManifest(SCOPE, { manifestSha256: goodRegistration.manifestSha256 }))
      .resolves.toMatchObject({ status: "finalized" });

    const badStorage = new MemoryArtifactStorage();
    const badService = new ArtifactUploadService(badStorage);
    const badManifest = createInlineManifest(sha256Hex(new TextEncoder().encode("not the inline map")), inlineMap.byteLength);
    const badRegistration = await badService.registerManifest(SCOPE, { manifest: badManifest, manifestSha256: manifestDigest(badManifest) });
    badStorage.upload(badRegistration.artifacts[0].bundleObjectKey, inlineBundle);
    await expect(badService.finalizeManifest(SCOPE, { manifestSha256: badRegistration.manifestSha256 }))
      .rejects.toMatchObject({ code: "integrity_mismatch", message: expect.stringContaining("inline source map does not match") });
  });
});
