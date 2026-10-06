import { describe, expect, it } from "vitest";
import { ArtifactPublicationService } from "./artifact-publication-service";
import type { ArtifactManifestFinalizeResult } from "./artifact-upload-service";

const scope = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  projectId: "project-publication-test",
  branchId: "main",
};

const storageResult = {
  manifestSha256: "a".repeat(64),
  status: "already_finalized",
  uploaded: [],
  alreadyUploaded: ["00000000-0000-4000-8000-000000000002"],
} satisfies ArtifactManifestFinalizeResult;

const finalizedManifest = {
  manifestSha256: storageResult.manifestSha256,
  release: "1.4.2",
  dist: null,
  environment: "development",
  artifacts: [{
    debugId: storageResult.alreadyUploaded[0],
    codeFile: "minified-chunk.js",
    sourceMapFile: "minified-chunk.js.map",
    sourceMapInline: false,
    bundleSha256: "b".repeat(64),
    bundleBytes: 100,
    sourceMapSha256: "c".repeat(64),
    sourceMapBytes: 200,
    sourceMapGzippedBytes: 150,
  }],
};

describe("artifact publication", () => {
  it("repairs a failed catalog projection by replaying finalized storage", async () => {
    let finalizeCalls = 0;
    let publishCalls = 0;
    const service = new ArtifactPublicationService({
      finalizeManifest: async () => {
        finalizeCalls += 1;
        return storageResult;
      },
      readFinalizedManifest: async () => finalizedManifest,
    }, {
      publishFinalizedManifest: async () => {
        publishCalls += 1;
        if (publishCalls === 1) throw new Error("temporary database failure");
        return "published";
      },
    });

    await expect(service.finalizeManifest(scope, { manifestSha256: storageResult.manifestSha256 }))
      .rejects.toThrow("temporary database failure");
    await expect(service.finalizeManifest(scope, { manifestSha256: storageResult.manifestSha256 }))
      .resolves.toMatchObject({ catalogStatus: "published", status: "already_finalized" });
    expect({ finalizeCalls, publishCalls }).toEqual({ finalizeCalls: 2, publishCalls: 2 });
  });

  it("keeps finalized unversioned uploads out of the release catalog", async () => {
    let publishCalls = 0;
    const service = new ArtifactPublicationService({
      finalizeManifest: async () => storageResult,
      readFinalizedManifest: async () => ({ ...finalizedManifest, release: null }),
    }, {
      publishFinalizedManifest: async () => {
        publishCalls += 1;
        return "published";
      },
    });

    await expect(service.finalizeManifest(scope, { manifestSha256: storageResult.manifestSha256 }))
      .resolves.toMatchObject({ catalogStatus: "unversioned" });
    expect(publishCalls).toBe(0);
  });
});
