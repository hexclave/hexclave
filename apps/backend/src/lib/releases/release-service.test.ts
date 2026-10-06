import { describe, expect, it } from "vitest";
import {
  ReleaseArtifactStatus as PrismaReleaseArtifactStatus,
  ReleaseStatus as PrismaReleaseStatus,
} from "@/generated/prisma/enums";
import type {
  Prisma,
  Release,
  ReleaseArtifact,
  ReleaseArtifactDebugId,
  ReleaseCommit,
  ReleaseDeployment,
} from "@/generated/prisma/client";
import {
  ReleaseInputError,
  ReleaseService,
  type ReleaseDatabase,
  type ReleaseScope,
  releaseScopeFields,
  validateDebugId,
  validateReleaseJson,
  validateReleaseVersion,
  validateSha256,
} from "./release-service";

const tenancyId = "00000000-0000-4000-8000-000000000001";
const releaseId = "00000000-0000-4000-8000-000000000002";
const artifactId = "00000000-0000-4000-8000-000000000003";

const scope = {
  tenancy: {
    id: tenancyId,
    branchId: "main",
    project: { id: "project-release-test" },
  },
} satisfies ReleaseScope;

const now = new Date("2026-08-06T00:00:00.000Z");

const release: Release = {
  tenancyId,
  projectId: "project-release-test",
  branchId: "main",
  id: releaseId,
  version: "2026.08.06",
  status: PrismaReleaseStatus.OPEN,
  ref: null,
  url: null,
  data: null,
  dateAdded: now,
  dateStarted: null,
  dateReleased: null,
  createdAt: now,
  updatedAt: now,
};

const deployment: ReleaseDeployment = {
  tenancyId,
  projectId: "project-release-test",
  branchId: "main",
  id: "00000000-0000-4000-8000-000000000004",
  releaseId,
  deploymentKey: "deploy-1",
  environment: "production",
  name: null,
  url: null,
  startedAt: null,
  finishedAt: now,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

const commit: ReleaseCommit = {
  tenancyId,
  projectId: "project-release-test",
  branchId: "main",
  id: "00000000-0000-4000-8000-000000000005",
  releaseId,
  repository: "hexclave",
  commitSha: "a".repeat(40),
  position: 0,
  message: null,
  authorName: null,
  authorEmail: null,
  committedAt: null,
  url: null,
  createdAt: now,
  updatedAt: now,
};

const artifact: ReleaseArtifact = {
  tenancyId,
  projectId: "project-release-test",
  branchId: "main",
  id: artifactId,
  releaseId,
  manifestSha256: "b".repeat(64),
  dist: "web",
  environment: "production",
  status: PrismaReleaseArtifactStatus.FINALIZED,
  manifestObjectKey: "manifest.json",
  finalizedAt: now,
  createdAt: now,
  updatedAt: now,
};

const debugId: ReleaseArtifactDebugId = {
  tenancyId,
  projectId: "project-release-test",
  branchId: "main",
  id: "00000000-0000-4000-8000-000000000006",
  releaseArtifactId: artifactId,
  debugId: "00000000-0000-4000-8000-000000000007",
  codeFile: "static/app.js",
  sourceMapFile: "static/app.js.map",
  sourceMapInline: false,
  bundleSha256: "c".repeat(64),
  bundleBytes: 10,
  sourceMapSha256: "d".repeat(64),
  sourceMapBytes: 20,
  sourceMapGzippedBytes: 15,
  bundleObjectKey: "bundle.js",
  sourceMapObjectKey: "source-map.gz",
  createdAt: now,
  updatedAt: now,
};

type ReleaseDatabaseOverrides = {
  [Key in keyof ReleaseDatabase]?: Partial<ReleaseDatabase[Key]>;
};

function fakeDatabase(overrides: ReleaseDatabaseOverrides = {}): ReleaseDatabase {
  return {
    release: {
      findMany: async () => [],
      findUnique: async () => release,
      upsert: async () => release,
      ...overrides.release,
    },
    releaseDeployment: {
      findMany: async () => [],
      findUnique: async () => null,
      upsert: async () => deployment,
      update: async () => deployment,
      ...overrides.releaseDeployment,
    },
    releaseCommit: {
      findMany: async () => [],
      upsert: async () => commit,
      ...overrides.releaseCommit,
    },
    releaseArtifact: {
      findMany: async () => [],
      findUnique: async () => artifact,
      upsert: async () => artifact,
      ...overrides.releaseArtifact,
    },
    releaseArtifactDebugId: {
      findUnique: async () => null,
      upsert: async () => debugId,
      findMany: async () => [],
      ...overrides.releaseArtifactDebugId,
    },
  };
}

describe("release service validation", () => {
  it("rejects Sentry-reserved and unsafe release versions", () => {
    expect(() => validateReleaseVersion("latest")).toThrow(ReleaseInputError);
    expect(() => validateReleaseVersion("\u0000release")).toThrow(ReleaseInputError);
    expect(validateReleaseVersion("git@2026.08.06")).toBe("git@2026.08.06");
  });

  it("requires lowercase fixed-size artifact identities", () => {
    expect(validateSha256("a".repeat(64), "manifestSha256")).toHaveLength(64);
    expect(() => validateSha256("A".repeat(64), "manifestSha256")).toThrow(ReleaseInputError);
    expect(validateDebugId("00000000-0000-0000-0000-000000000001")).toBe("00000000-0000-0000-0000-000000000001");
    expect(() => validateDebugId("0000000a-0000-4000-8000-000000000001".toUpperCase())).toThrow(ReleaseInputError);
  });

  it("bounds release metadata and rejects cyclic values", () => {
    expect(validateReleaseJson({ build: "web", flags: [true, false] }, "release data")).toEqual({
      build: "web",
      flags: [true, false],
    });
    expect(() => validateReleaseJson({ payload: "x".repeat(65 * 1024) }, "release data")).toThrow(ReleaseInputError);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => validateReleaseJson(cyclic, "release data")).toThrow(ReleaseInputError);
  });

  it("extracts an explicit scope key for every write", () => {
    expect(releaseScopeFields(scope)).toEqual({
      tenancyId,
      projectId: "project-release-test",
      branchId: "main",
    });
    expect(() => releaseScopeFields({ tenancy: { ...scope.tenancy, branchId: "" } })).toThrow(ReleaseInputError);
  });
});

describe("release graph persistence", () => {
  it("lists an empty release scope", async () => {
    const result = await new ReleaseService(fakeDatabase()).listReleases(scope, {});

    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it("scopes recent releases to the authenticated tenancy, project, and branch", async () => {
    let captured: Prisma.ReleaseFindManyArgs | undefined;
    const db = fakeDatabase({
      release: {
        findMany: async (args) => {
          captured = args;
          return [release];
        },
      },
    });

    const result = await new ReleaseService(db).listReleases(scope, {});

    expect(result.items).toEqual([release]);
    expect(captured).toMatchObject({
      where: {
        tenancyId,
        projectId: "project-release-test",
        branchId: "main",
      },
      orderBy: [{ dateAdded: "desc" }, { id: "desc" }],
      take: 51,
    });
  });

  it("fetches one extra release to report truncation without an unbounded query", async () => {
    let captured: Prisma.ReleaseFindManyArgs | undefined;
    const releases = [
      release,
      { ...release, id: "00000000-0000-4000-8000-000000000012", version: "2026.08.05" },
      { ...release, id: "00000000-0000-4000-8000-000000000013", version: "2026.08.04" },
    ];
    const db = fakeDatabase({
      release: {
        findMany: async (args) => {
          captured = args;
          return releases;
        },
      },
    });

    const result = await new ReleaseService(db).listReleases(scope, { limit: 2 });

    expect(result.items).toEqual(releases.slice(0, 2));
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(captured).toMatchObject({ take: 3 });

    await new ReleaseService(db).listReleases(scope, { limit: 2, cursor: result.nextCursor });
    expect(captured).toMatchObject({
      where: {
        OR: [
          { dateAdded: { lt: now } },
          { dateAdded: now, id: { lt: releases[1]?.id } },
        ],
      },
    });
  });

  it("rejects malformed cursors and cursor-paginates finalized manifests", async () => {
    let captured: Prisma.ReleaseArtifactFindManyArgs | undefined;
    const catalogArtifact = { ...artifact, debugIds: [debugId] };
    const db = fakeDatabase({
      releaseArtifact: {
        findMany: async (args) => {
          captured = args;
          return [catalogArtifact, { ...catalogArtifact, id: "00000000-0000-4000-8000-000000000008" }];
        },
      },
    });
    const service = new ReleaseService(db);

    await expect(service.listReleases(scope, { cursor: "not+a+cursor" })).rejects.toThrow(ReleaseInputError);
    const page = await service.listReleaseArtifacts(scope, { releaseId, limit: 1 });

    expect(page.items).toEqual([catalogArtifact]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(captured).toMatchObject({
      where: { tenancyId, releaseId, status: PrismaReleaseArtifactStatus.FINALIZED },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    });
  });

  it("loads a bounded commit and deployment graph with a version lookup", async () => {
    let commitArgs: Prisma.ReleaseCommitFindManyArgs | undefined;
    let deploymentArgs: Prisma.ReleaseDeploymentFindManyArgs | undefined;
    const db = fakeDatabase({
      releaseCommit: {
        findMany: async (args) => {
          commitArgs = args;
          return [commit];
        },
      },
      releaseDeployment: {
        findMany: async (args) => {
          deploymentArgs = args;
          return [deployment];
        },
      },
    });

    const result = await new ReleaseService(db).getReleaseDetail(scope, release.version);

    expect(result).toEqual({
      release,
      commits: [commit],
      deployments: [deployment],
      artifacts: { items: [], nextCursor: null },
    });
    expect(commitArgs).toMatchObject({
      where: { tenancyId, releaseId },
      orderBy: { position: "asc" },
      take: 50,
    });
    expect(deploymentArgs).toMatchObject({
      where: { tenancyId, releaseId },
      orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
      take: 50,
    });
  });

  it("hides an existing release from a different project branch", async () => {
    const foreign = { ...release, branchId: "other-branch" };
    const db = fakeDatabase({
      release: {
        findUnique: async () => foreign,
        upsert: async () => foreign,
      },
    });

    await expect(new ReleaseService(db).getRelease(scope, release.version)).resolves.toBeNull();
    await expect(new ReleaseService(db).upsertRelease(scope, { version: release.version }))
      .rejects.toThrow("different project branch");
  });

  it("upserts a release using the tenancy/project/branch scope and version identity", async () => {
    let captured: Prisma.ReleaseUpsertArgs | undefined;
    const db = fakeDatabase({
      release: {
        findUnique: async () => release,
        upsert: async (args) => {
          captured = args;
          return release;
        },
      },
    });

    await new ReleaseService(db).upsertRelease(scope, {
      version: "2026.08.06",
      ref: "main",
      url: "https://example.com/releases/2026.08.06",
    });

    expect(captured).toMatchObject({
      where: { tenancyId_version: { tenancyId, version: "2026.08.06" } },
      create: { tenancyId, projectId: "project-release-test", branchId: "main", version: "2026.08.06" },
    });
  });

  it("upserts deployments with a tenancy-scoped idempotency key", async () => {
    let captured: Prisma.ReleaseDeploymentUpsertArgs | undefined;
    const db = fakeDatabase({
      releaseDeployment: {
        findUnique: async () => null,
        upsert: async (args) => {
          captured = args;
          return deployment;
        },
      },
    });

    await new ReleaseService(db).upsertDeployment(scope, {
      releaseId,
      deploymentKey: deployment.deploymentKey,
      environment: deployment.environment,
    });

    expect(captured).toMatchObject({
      where: { tenancyId_deploymentKey: { tenancyId, deploymentKey: deployment.deploymentKey } },
      create: {
        tenancyId,
        projectId: "project-release-test",
        branchId: "main",
        releaseId,
        deploymentKey: deployment.deploymentKey,
      },
    });
  });

  it("rejects a deployment whose upsert landed on a different release (concurrent key reuse)", async () => {
    const otherRelease = { ...deployment, releaseId: "00000000-0000-4000-8000-000000000099" };
    const db = fakeDatabase({
      releaseDeployment: {
        findUnique: async () => null,
        upsert: async () => otherRelease,
      },
    });

    await expect(new ReleaseService(db).upsertDeployment(scope, {
      releaseId,
      deploymentKey: deployment.deploymentKey,
      environment: deployment.environment,
    })).rejects.toThrow("already attached to a different release scope");
  });

  it("accepts multi-line commit messages but rejects other control characters", async () => {
    let captured: Prisma.ReleaseCommitUpsertArgs | undefined;
    const db = fakeDatabase({
      releaseCommit: {
        upsert: async (args) => {
          captured = args;
          return commit;
        },
      },
    });
    const service = new ReleaseService(db);
    const message = "fix: subject line\n\nLonger body with\ttabs and\r\nCRLF paragraphs.";

    await service.upsertCommit(scope, {
      releaseId,
      repository: commit.repository,
      commitSha: commit.commitSha,
      position: 0,
      message,
    });
    expect(captured?.create).toMatchObject({ message });

    await expect(service.upsertCommit(scope, {
      releaseId,
      repository: commit.repository,
      commitSha: commit.commitSha,
      position: 0,
      message: "bad\u0000message",
    })).rejects.toThrow(ReleaseInputError);
  });

  it("upserts ordered release commits by repository and SHA", async () => {
    let captured: Prisma.ReleaseCommitUpsertArgs | undefined;
    const db = fakeDatabase({
      releaseCommit: {
        upsert: async (args) => {
          captured = args;
          return commit;
        },
      },
    });

    await new ReleaseService(db).upsertCommit(scope, {
      releaseId,
      repository: commit.repository,
      commitSha: commit.commitSha,
      position: commit.position,
    });

    expect(captured).toMatchObject({
      where: {
        tenancyId_releaseId_repository_commitSha: {
          tenancyId,
          releaseId,
          repository: commit.repository,
          commitSha: commit.commitSha,
        },
      },
      create: { tenancyId, projectId: "project-release-test", branchId: "main", position: 0 },
    });
  });

  it("does not downgrade a finalized artifact on an idempotent registration", async () => {
    let captured: Prisma.ReleaseArtifactUpsertArgs | undefined;
    const db = fakeDatabase({
      releaseArtifact: {
        findUnique: async () => artifact,
        upsert: async (args) => {
          captured = args;
          return artifact;
        },
      },
    });

    await new ReleaseService(db).upsertArtifact(scope, {
      releaseId,
      manifestSha256: artifact.manifestSha256,
      status: PrismaReleaseArtifactStatus.REGISTERED,
    });

    expect(captured?.update).not.toHaveProperty("status");
    expect(captured?.create).toMatchObject({ status: PrismaReleaseArtifactStatus.REGISTERED });
  });

  it("publishes a finalized manifest once and treats an exact retry as a no-op", async () => {
    let storedArtifact: ReleaseArtifact | null = null;
    let storedDebugId: ReleaseArtifactDebugId | null = null;
    const db = fakeDatabase({
      releaseArtifact: {
        findUnique: async () => storedArtifact,
        upsert: async () => {
          storedArtifact = artifact;
          return artifact;
        },
      },
      releaseArtifactDebugId: {
        findUnique: async () => storedDebugId,
        upsert: async () => {
          storedDebugId = debugId;
          return debugId;
        },
      },
    });
    const service = new ReleaseService(db);
    const manifest = {
      manifestSha256: artifact.manifestSha256,
      release: release.version,
      dist: artifact.dist,
      environment: artifact.environment,
      artifacts: [{
        debugId: debugId.debugId,
        codeFile: debugId.codeFile,
        sourceMapFile: debugId.sourceMapFile,
        sourceMapInline: debugId.sourceMapInline,
        bundleSha256: debugId.bundleSha256,
        bundleBytes: debugId.bundleBytes,
        sourceMapSha256: debugId.sourceMapSha256,
        sourceMapBytes: debugId.sourceMapBytes,
        sourceMapGzippedBytes: debugId.sourceMapGzippedBytes,
      }],
    };

    await expect(service.publishFinalizedManifest(scope, manifest)).resolves.toBe("published");
    await expect(service.publishFinalizedManifest(scope, manifest)).resolves.toBe("already_published");
  });

  it("upgrades an artifact to finalized through the update clause", async () => {
    let captured: Prisma.ReleaseArtifactUpsertArgs | undefined;
    const db = fakeDatabase({
      releaseArtifact: {
        findUnique: async () => artifact,
        upsert: async (args) => {
          captured = args;
          return artifact;
        },
      },
    });

    await new ReleaseService(db).upsertArtifact(scope, {
      releaseId,
      manifestSha256: artifact.manifestSha256,
      status: PrismaReleaseArtifactStatus.FINALIZED,
      finalizedAt: now,
    });

    expect(captured?.update).toMatchObject({ status: PrismaReleaseArtifactStatus.FINALIZED, finalizedAt: now });
    expect(captured?.create).toMatchObject({ status: PrismaReleaseArtifactStatus.FINALIZED });
  });

  it("upserts debug-ID metadata under the artifact and scope identities", async () => {
    let captured: Prisma.ReleaseArtifactDebugIdUpsertArgs | undefined;
    const db = fakeDatabase({
      releaseArtifactDebugId: {
        upsert: async (args) => {
          captured = args;
          return debugId;
        },
        findMany: async () => [],
      },
    });

    await new ReleaseService(db).upsertArtifactDebugId(scope, {
      releaseArtifactId: artifactId,
      debugId: debugId.debugId,
      codeFile: debugId.codeFile,
      sourceMapFile: debugId.sourceMapFile,
      sourceMapInline: debugId.sourceMapInline,
      bundleSha256: debugId.bundleSha256,
      bundleBytes: debugId.bundleBytes,
      sourceMapSha256: debugId.sourceMapSha256,
      sourceMapBytes: debugId.sourceMapBytes,
      sourceMapGzippedBytes: debugId.sourceMapGzippedBytes,
    });

    expect(captured).toMatchObject({
      where: {
        tenancyId_releaseArtifactId_debugId: {
          tenancyId,
          releaseArtifactId: artifactId,
          debugId: debugId.debugId,
        },
      },
      create: { tenancyId, projectId: "project-release-test", branchId: "main", releaseArtifactId: artifactId },
    });
  });

  it("bounds debug-ID lookups and keeps all filters inside the tenant scope", async () => {
    let captured: Prisma.ReleaseArtifactDebugIdFindManyArgs | undefined;
    const db = fakeDatabase({
      releaseArtifactDebugId: {
        upsert: async () => debugId,
        findMany: async (args) => {
          captured = args;
          return [];
        },
      },
    });

    await new ReleaseService(db).lookupArtifactDebugId(scope, {
      debugId: debugId.debugId,
      releaseVersion: release.version,
      dist: artifact.dist ?? undefined,
      environment: artifact.environment ?? undefined,
    });

    expect(captured).toMatchObject({
      take: 100,
      where: {
        tenancyId,
        projectId: "project-release-test",
        branchId: "main",
        debugId: debugId.debugId,
      },
    });
  });
});
