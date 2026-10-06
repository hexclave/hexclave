import { describe, expect, it } from "vitest";
import { ArtifactServiceError } from "./artifact-errors";
import {
  artifactScopeForTenancy,
  parseArtifactLookupQuery,
  parseArtifactManifestFinalizeRequest,
  parseArtifactManifestRegistrationRequest,
  throwArtifactRouteError,
} from "./artifact-route-handlers";

const MANIFEST_SHA256 = "a".repeat(64);
const DEBUG_ID = "01234567-89ab-cdef-0123-456789abcdef";

describe("artifact route contracts", () => {
  it("derives storage scope only from authenticated tenancy fields", () => {
    expect(artifactScopeForTenancy({
      id: "tenancy-1",
      branchId: "preview",
      project: { id: "project-1" },
    })).toEqual({
      tenantId: "tenancy-1",
      projectId: "project-1",
      branchId: "preview",
    });
  });

  it("accepts the API's snake_case fields", () => {
    const manifest = { schemaVersion: 1 };
    expect(parseArtifactManifestRegistrationRequest({
      manifest,
      manifest_sha256: MANIFEST_SHA256,
    })).toEqual({ manifest, manifestSha256: MANIFEST_SHA256 });
    expect(parseArtifactManifestFinalizeRequest({ manifest_sha256: MANIFEST_SHA256 })).toEqual({ manifestSha256: MANIFEST_SHA256 });
    expect(parseArtifactLookupQuery({ debug_id: DEBUG_ID, release: "release-1", dist: "dist-1" })).toEqual({
      debugId: DEBUG_ID,
      release: "release-1",
      dist: "dist-1",
    });
  });

  it("rejects missing identifiers and unsafe lookup metadata", () => {
    expect(() => parseArtifactManifestFinalizeRequest({
      manifestSha256: MANIFEST_SHA256,
    })).toThrowError(ArtifactServiceError);
    expect(() => parseArtifactLookupQuery({ debugId: DEBUG_ID })).toThrowError(ArtifactServiceError);
    expect(() => parseArtifactLookupQuery({ debug_id: DEBUG_ID, release: "release\u0000escape" })).toThrowError(ArtifactServiceError);
  });

  it("maps typed service failures to safe HTTP statuses", () => {
    let caught: unknown;
    try {
      throwArtifactRouteError(new ArtifactServiceError("storage_unavailable", "storage is not configured"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ statusCode: 503, message: "storage is not configured" });

    caught = undefined;
    try {
      throwArtifactRouteError(new ArtifactServiceError("integrity_mismatch", "private storage details"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ statusCode: 500, message: "Artifact storage integrity validation failed." });
  });
});
