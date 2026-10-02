import { describe, expect, it } from "vitest";
import { ArtifactServiceError } from "./artifact-errors";
import {
  assertManifestDigest,
  sha256Hex,
  validateArtifactManifest,
  validateArtifactMetadata,
  type ArtifactManifest,
  type ArtifactScope,
} from "./artifact-manifest";

const SCOPE = {
  tenantId: "tenancy-1",
  projectId: "project-1",
  branchId: "main",
} satisfies ArtifactScope;

const BUNDLE = new TextEncoder().encode("console.log('minified');\n");
const SOURCE_MAP = new TextEncoder().encode(JSON.stringify({
  version: 3,
  sources: ["src/index.ts"],
  names: [],
  mappings: "AAAA",
}));

function createManifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    schemaVersion: 1,
    projectId: SCOPE.projectId,
    release: "web@2026.08.06",
    dist: "production",
    environment: "production",
    artifacts: [{
      debugId: "01234567-89ab-cdef-0123-456789abcdef",
      codeFile: "static/chunk.js",
      sourceMapFile: "static/chunk.js.map",
      sourceMapInline: false,
      bundleSha256: sha256Hex(BUNDLE),
      bundleBytes: BUNDLE.byteLength,
      sourceMapSha256: sha256Hex(SOURCE_MAP),
      sourceMapBytes: SOURCE_MAP.byteLength,
      sourceMapGzippedBytes: 100,
    }],
    ...overrides,
  };
}

function firstArtifact(manifest: ArtifactManifest) {
  return manifest.artifacts[0];
}

function expectArtifactError(run: () => unknown, code: ArtifactServiceError["code"]): void {
  try {
    run();
    throw new Error("Expected artifact validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactServiceError);
    if (error instanceof ArtifactServiceError) expect(error.code).toBe(code);
  }
}

describe("artifact manifest validation", () => {
  it("canonicalizes a valid project manifest and verifies its digest", () => {
    const manifest = createManifest();
    const validated = validateArtifactManifest(manifest, SCOPE);

    expect(validated.manifestJson).toBe(JSON.stringify(manifest));
    expect(validated.manifestSha256).toBe(sha256Hex(new TextEncoder().encode(validated.manifestJson)));
    assertManifestDigest(validated.manifestSha256, validated);
  });

  it("rejects project-crossing manifests, traversal paths, and non-canonical debug IDs", () => {
    expectArtifactError(() => validateArtifactManifest(createManifest({ projectId: "other-project" }), SCOPE), "invalid_manifest");
    expectArtifactError(() => validateArtifactManifest(createManifest({
      artifacts: [{ ...firstArtifact(createManifest()), codeFile: "../chunk.js" }],
    }), SCOPE), "invalid_manifest");
    expectArtifactError(() => validateArtifactManifest(createManifest({
      artifacts: [{ ...firstArtifact(createManifest()), debugId: "01234567-89AB-cdef-0123-456789abcdef" }],
    }), SCOPE), "invalid_manifest");
  });

  it("rejects inconsistent inline maps, duplicate artifacts, and dist without a release", () => {
    const artifact = firstArtifact(createManifest());
    expectArtifactError(() => validateArtifactManifest(createManifest({
      release: null,
      dist: "production",
    }), SCOPE), "invalid_manifest");
    expectArtifactError(() => validateArtifactManifest(createManifest({
      artifacts: [{ ...artifact, sourceMapFile: null }],
    }), SCOPE), "invalid_manifest");
    expectArtifactError(() => validateArtifactManifest(createManifest({
      artifacts: [artifact, artifact],
    }), SCOPE), "invalid_manifest");
  });

  it("bounds lookup metadata without silently normalizing unsafe values", () => {
    expect(validateArtifactMetadata(undefined, "release")).toBeNull();
    expect(validateArtifactMetadata(null, "release")).toBeNull();
    expect(validateArtifactMetadata("production", "environment")).toBe("production");
    expectArtifactError(() => validateArtifactMetadata("", "release"), "invalid_manifest");
    expectArtifactError(() => validateArtifactMetadata("release\u0000secret", "release"), "invalid_manifest");
  });
});
