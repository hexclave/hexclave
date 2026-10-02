import type { SmartRequest } from "@/route-handlers/smart-request";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
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
import { beforeAll, describe, expect, it } from "vitest";
import {
  createCommitRegistrationRoute,
  createDebugIdAssociationRoute,
  createDebugIdLookupRoute,
  createDeploymentRegistrationRoute,
  createReleaseArtifactRegistrationRoute,
  createReleaseListRoute,
  createReleaseLookupRoute,
  createReleaseUpsertRoute,
} from "./release-route-handlers";
import type {
  ReleaseArtifactLookupRow,
  ReleaseDatabase,
  ReleaseService,
} from "./release-service";
import { ReleaseService as ReleaseServiceImpl } from "./release-service";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const RELEASE_ID = "00000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000002";
const DEBUG_ROW_ID = "00000000-0000-4000-8000-000000000003";
const DEBUG_ID = "00000000-0000-0000-0000-000000000004";

let tenancy: Tenancy;

beforeAll(async () => {
  const row = await globalPrismaClient.tenancy.findFirst({ select: { id: true } });
  if (row === null) throw new Error("Release route tests need a seeded tenancy.");
  const resolved = await getTenancy(row.id);
  if (resolved === null) throw new Error("Release route test tenancy could not be resolved.");
  tenancy = resolved;
});

function releaseFor(target: Tenancy = tenancy, overrides: Partial<Release> = {}): Release {
  return {
    tenancyId: target.id,
    projectId: target.project.id,
    branchId: target.branchId,
    id: RELEASE_ID,
    version: "release-2026.08.06",
    status: PrismaReleaseStatus.OPEN,
    ref: null,
    url: null,
    data: null,
    dateAdded: NOW,
    dateStarted: null,
    dateReleased: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function deploymentFor(target: Tenancy = tenancy): ReleaseDeployment {
  return {
    tenancyId: target.id,
    projectId: target.project.id,
    branchId: target.branchId,
    id: "00000000-0000-4000-8000-000000000005",
    releaseId: RELEASE_ID,
    deploymentKey: "deploy-2026.08.06",
    environment: "production",
    name: "production",
    url: "https://deploy.example.test",
    startedAt: NOW,
    finishedAt: NOW,
    metadata: { provider: "vercel" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function commitFor(target: Tenancy = tenancy): ReleaseCommit {
  return {
    tenancyId: target.id,
    projectId: target.project.id,
    branchId: target.branchId,
    id: "00000000-0000-4000-8000-000000000006",
    releaseId: RELEASE_ID,
    repository: "hexclave",
    commitSha: "a".repeat(40),
    position: 0,
    message: "release",
    authorName: "Hexclave",
    authorEmail: "dev@example.test",
    committedAt: NOW,
    url: "https://git.example.test/commit/" + "a".repeat(40),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function artifactFor(target: Tenancy = tenancy): ReleaseArtifact {
  return {
    tenancyId: target.id,
    projectId: target.project.id,
    branchId: target.branchId,
    id: ARTIFACT_ID,
    releaseId: RELEASE_ID,
    manifestSha256: "b".repeat(64),
    dist: "web",
    environment: "production",
    status: PrismaReleaseArtifactStatus.FINALIZED,
    manifestObjectKey: "manifest.json",
    finalizedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function debugFor(target: Tenancy = tenancy): ReleaseArtifactDebugId {
  return {
    tenancyId: target.id,
    projectId: target.project.id,
    branchId: target.branchId,
    id: DEBUG_ROW_ID,
    releaseArtifactId: ARTIFACT_ID,
    debugId: DEBUG_ID,
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function database(options: {
  release?: Release | null,
  releases?: Release[],
  deployment?: ReleaseDeployment,
  commit?: ReleaseCommit,
  artifact?: ReleaseArtifact,
  debugId?: ReleaseArtifactDebugId,
  lookupRows?: ReleaseArtifactLookupRow[],
  onReleaseList?: (args: Prisma.ReleaseFindManyArgs) => void,
  onReleaseUpsert?: (args: Prisma.ReleaseUpsertArgs) => void,
  onDebugLookup?: (args: Prisma.ReleaseArtifactDebugIdFindManyArgs) => void,
} = {}): ReleaseDatabase {
  const release = options.release ?? releaseFor();
  const deployment = options.deployment ?? deploymentFor();
  const commit = options.commit ?? commitFor();
  const artifact = options.artifact ?? artifactFor();
  const debugId = options.debugId ?? debugFor();
  return {
    release: {
      findMany: async (args) => {
        options.onReleaseList?.(args);
        return options.releases ?? [];
      },
      findUnique: async () => release,
      upsert: async (args) => {
        options.onReleaseUpsert?.(args);
        return release;
      },
    },
    releaseDeployment: {
      findMany: async () => [deployment],
      findUnique: async () => null,
      upsert: async () => deployment,
      update: async () => deployment,
    },
    releaseCommit: {
      findMany: async () => [commit],
      upsert: async () => commit,
    },
    releaseArtifact: {
      findMany: async () => [],
      findUnique: async () => artifact,
      upsert: async () => artifact,
    },
    releaseArtifactDebugId: {
      findUnique: async () => null,
      upsert: async () => debugId,
      findMany: async (args) => {
        options.onDebugLookup?.(args);
        return options.lookupRows ?? [];
      },
    },
  };
}

function request(target: Tenancy, method: SmartRequest["method"], body: unknown, query: Record<string, string | undefined> = {}, type: "server" | "admin" | "client" = "server"): SmartRequest {
  return {
    auth: {
      type,
      project: target.project,
      branchId: target.branchId,
      tenancy: target,
    },
    url: "http://localhost/api/latest/releases",
    method,
    body,
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query,
    params: {},
    clientVersion: undefined,
  };
}

describe("authenticated release management routes", () => {
  it("lists recent scoped releases with truncation metadata", async () => {
    const recent = [
      releaseFor(),
      releaseFor(tenancy, {
        id: "00000000-0000-4000-8000-000000000011",
        version: "release-2026.08.05",
      }),
    ];
    let listArgs: Prisma.ReleaseFindManyArgs | undefined;
    const route = createReleaseListRoute(new ReleaseServiceImpl(database({
      releases: recent,
      onReleaseList: (args) => { listArgs = args; },
    })));

    const response = await route.invoke(request(tenancy, "GET", undefined, { limit: "1" }));

    expect(response.body).toMatchObject({
      items: [{ id: RELEASE_ID, version: "release-2026.08.06" }],
      truncated: true,
    });
    expect(listArgs).toMatchObject({
      where: {
        tenancyId: tenancy.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
      },
      take: 2,
    });
  });

  it("rejects list limits above the service maximum at the schema boundary", async () => {
    const route = createReleaseListRoute(new ReleaseServiceImpl(database()));

    await expect(route.invoke(request(tenancy, "GET", undefined, { limit: "101" })))
      .rejects.toMatchObject({ name: "HexclaveAssertionError" });
  });

  it("keeps version lookup responses as a single release", async () => {
    const route = createReleaseLookupRoute(new ReleaseServiceImpl(database()));

    const response = await route.invoke(request(tenancy, "GET", undefined, {
      version: "release-2026.08.06",
    }));

    expect(response.body).toMatchObject({
      id: RELEASE_ID,
      version: "release-2026.08.06",
      status: "open",
      commits: [{ id: "00000000-0000-4000-8000-000000000006", repository: "hexclave" }],
      deployments: [{ id: "00000000-0000-4000-8000-000000000005", environment: "production" }],
    });
    expect("items" in response.body).toBe(false);
  });

  it("upserts a release idempotently and binds the database key to auth scope", async () => {
    const upsertArgs: Prisma.ReleaseUpsertArgs[] = [];
    const service: ReleaseService = new ReleaseServiceImpl(database({
      onReleaseUpsert: (args) => upsertArgs.push(args),
    }));
    const route = createReleaseUpsertRoute(service);
    const body = {
      version: "release-2026.08.06",
      status: "open",
      ref: "main",
      data: { build: "web" },
    };

    const first = await route.invoke(request(tenancy, "POST", body));
    const retry = await route.invoke(request(tenancy, "POST", body));

    expect(first.body).toMatchObject({ id: RELEASE_ID, version: body.version, status: "open" });
    expect(retry.body).toEqual(first.body);
    expect(upsertArgs).toHaveLength(2);
    expect(upsertArgs[0]).toMatchObject({
      where: { tenancyId_version: { tenancyId: tenancy.id, version: body.version } },
      create: { tenancyId: tenancy.id, projectId: tenancy.project.id, branchId: tenancy.branchId },
    });
  });

  it("returns not-found for a release version outside the authenticated branch", async () => {
    const foreignRelease = releaseFor(tenancy, { branchId: `${tenancy.branchId}-foreign` });
    const route = createReleaseLookupRoute(new ReleaseServiceImpl(database({ release: foreignRelease })));

    await expect(route.invoke(request(tenancy, "GET", undefined, { version: foreignRelease.version })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 404, message: "Release not found" });
  });

  it("rejects client auth and oversized registration fields before persistence", async () => {
    const route = createDeploymentRegistrationRoute(new ReleaseServiceImpl(database()));
    const body = {
      release_id: RELEASE_ID,
      deployment_key: "x".repeat(257),
      environment: "production",
    };

    await expect(route.invoke(request(tenancy, "POST", body, {}, "client")))
      .rejects.toMatchObject({ name: "HexclaveAssertionError" });
    await expect(route.invoke(request(tenancy, "POST", body)))
      .rejects.toMatchObject({ name: "HexclaveAssertionError" });
  });

  it("registers deployment, commit, artifact, and debug-ID associations through the scoped service", async () => {
    const service: ReleaseService = new ReleaseServiceImpl(database());
    const deploymentRoute = createDeploymentRegistrationRoute(service);
    const commitRoute = createCommitRegistrationRoute(service);
    const artifactRoute = createReleaseArtifactRegistrationRoute(service);
    const debugRoute = createDebugIdAssociationRoute(service);

    const deployment = await deploymentRoute.invoke(request(tenancy, "POST", {
      release_id: RELEASE_ID,
      deployment_key: "deploy-2026.08.06",
      environment: "production",
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      metadata: { provider: "vercel" },
    }));
    const commit = await commitRoute.invoke(request(tenancy, "POST", {
      release_id: RELEASE_ID,
      repository: "hexclave",
      commit_sha: "a".repeat(40),
      position: 0,
    }));
    const artifact = await artifactRoute.invoke(request(tenancy, "POST", {
      release_id: RELEASE_ID,
      manifest_sha256: "b".repeat(64),
      status: "finalized",
    }));
    const debug = await debugRoute.invoke(request(tenancy, "POST", {
      release_artifact_id: ARTIFACT_ID,
      debug_id: DEBUG_ID,
      code_file: "static/app.js",
      source_map_file: "static/app.js.map",
      source_map_inline: false,
      bundle_sha256: "c".repeat(64),
      bundle_bytes: 10,
      source_map_sha256: "d".repeat(64),
      source_map_bytes: 20,
      source_map_gzipped_bytes: 15,
    }));

    expect(deployment.body).toMatchObject({ deployment_key: "deploy-2026.08.06", release_id: RELEASE_ID });
    expect(commit.body).toMatchObject({ repository: "hexclave", commit_sha: "a".repeat(40) });
    expect(artifact.body).toMatchObject({ manifest_sha256: "b".repeat(64), status: "finalized" });
    expect(debug.body).toMatchObject({ debug_id: DEBUG_ID, release_artifact_id: ARTIFACT_ID });
  });

  it("performs exact debug-ID lookup with release, distribution, environment, and auth scope filters", async () => {
    const release = releaseFor();
    const artifact = artifactFor();
    const debugId = debugFor();
    const lookupRow = {
      ...debugId,
      releaseArtifact: { ...artifact, release },
    } satisfies ReleaseArtifactLookupRow;
    let lookupArgs: Prisma.ReleaseArtifactDebugIdFindManyArgs | undefined;
    const route = createDebugIdLookupRoute(new ReleaseServiceImpl(database({
      lookupRows: [lookupRow],
      onDebugLookup: (args) => { lookupArgs = args; },
    })));

    const response = await route.invoke(request(tenancy, "GET", undefined, {
      debug_id: DEBUG_ID,
      release: release.version,
      dist: "web",
      environment: "production",
    }));

    expect(response.body).toMatchObject({ items: [{ debug_id: { debug_id: DEBUG_ID } }] });
    expect(lookupArgs).toMatchObject({
      take: 100,
      where: {
        tenancyId: tenancy.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        debugId: DEBUG_ID,
        releaseArtifact: {
          is: {
            tenancyId: tenancy.id,
            projectId: tenancy.project.id,
            branchId: tenancy.branchId,
            dist: "web",
            environment: "production",
            release: { is: { tenancyId: tenancy.id, version: release.version } },
          },
        },
      },
    });
  });

  it("does not disclose a debug-ID association from another branch", async () => {
    const foreignArtifact = artifactFor(tenancy);
    foreignArtifact.branchId = `${tenancy.branchId}-foreign`;
    const route = createDebugIdAssociationRoute(new ReleaseServiceImpl(database({ artifact: foreignArtifact })));

    await expect(route.invoke(request(tenancy, "POST", {
      release_artifact_id: ARTIFACT_ID,
      debug_id: DEBUG_ID,
      code_file: "static/app.js",
      source_map_file: "static/app.js.map",
      source_map_inline: false,
      bundle_sha256: "c".repeat(64),
      bundle_bytes: 10,
      source_map_sha256: "d".repeat(64),
      source_map_bytes: 20,
      source_map_gzipped_bytes: 15,
    }))).rejects.toMatchObject({ name: "StatusError", statusCode: 404, message: "Release resource not found" });
  });
});
