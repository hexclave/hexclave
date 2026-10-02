import {
  ReleaseArtifactStatus as PrismaReleaseArtifactStatus,
  ReleaseStatus as PrismaReleaseStatus,
} from "@/generated/prisma/enums";
import type {
  Release,
  ReleaseArtifact,
  ReleaseArtifactDebugId,
  ReleaseCommit,
  ReleaseDeployment,
} from "@/generated/prisma/client";
import {
  ReleaseArtifactNotFoundError,
  ReleaseInputError,
  ReleaseNotFoundError,
  ReleaseScopeInvariantError,
  releaseService,
  type ReleaseDetail,
  type ReleaseService,
} from "@/lib/releases/release-service";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import {
  adaptSchema,
  serverOrHigherAuthTypeSchema,
  yupArray,
  yupBoolean,
  yupMixed,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { DEBUG_ID_RE } from "../artifacts/artifact-manifest";

const MAX_RELEASE_VERSION_BYTES = 250;
const MAX_RELEASE_REF_BYTES = 250;
const MAX_URL_BYTES = 2_048;
const MAX_DEPLOYMENT_KEY_BYTES = 256;
const MAX_ENVIRONMENT_BYTES = 255;
const MAX_REPOSITORY_BYTES = 256;
const MAX_COMMIT_SHA_BYTES = 128;
const MAX_ARTIFACT_DIST_BYTES = 64;
const MAX_OBJECT_KEY_BYTES = 4_096;
const MAX_CODE_FILE_BYTES = 1_024;
const MAX_COMMIT_MESSAGE_BYTES = 100_000;
const MAX_AUTHOR_NAME_BYTES = 256;
const MAX_AUTHOR_EMAIL_BYTES = 320;
const MAX_DATE_BYTES = 64;
const MAX_DATABASE_INT = 2_147_483_647;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ReleaseAuthSchema = yupObject({
  type: serverOrHigherAuthTypeSchema.defined(),
  tenancy: adaptSchema.defined(),
}).defined();

const optionalDateInputSchema = yupString().max(MAX_DATE_BYTES).optional();
const nullableDateInputSchema = yupString().max(MAX_DATE_BYTES).nullable().optional();
const jsonInputSchema = yupMixed().optional();
type NonNullJsonValue = Exclude<Json, null>;

const ReleaseUpsertBodySchema = yupObject({
  version: yupString().max(MAX_RELEASE_VERSION_BYTES).defined(),
  status: yupString().oneOf(["open", "archived"]).optional(),
  ref: yupString().max(MAX_RELEASE_REF_BYTES).optional(),
  url: yupString().max(MAX_URL_BYTES).optional(),
  data: jsonInputSchema,
  date_added: optionalDateInputSchema,
  date_started: nullableDateInputSchema,
  date_released: nullableDateInputSchema,
}).defined();

const ReleaseLookupQuerySchema = yupObject({
  version: yupString().max(MAX_RELEASE_VERSION_BYTES).defined(),
}).defined();

const ReleaseListQuerySchema = yupObject({
  limit: yupString().matches(/^(100|[1-9][0-9]?)$/u).optional(),
  cursor: yupString().max(512).optional(),
}).defined();

const ReleaseArtifactListQuerySchema = yupObject({
  release_id: yupString().uuid().defined(),
  limit: yupString().matches(/^(100|[1-9][0-9]?)$/u).optional(),
  cursor: yupString().max(512).optional(),
}).defined();

const DeploymentRegistrationBodySchema = yupObject({
  release_id: yupString().uuid().defined(),
  deployment_key: yupString().max(MAX_DEPLOYMENT_KEY_BYTES).defined(),
  environment: yupString().max(MAX_ENVIRONMENT_BYTES).defined(),
  name: yupString().max(64).optional(),
  url: yupString().max(MAX_URL_BYTES).optional(),
  started_at: nullableDateInputSchema,
  finished_at: optionalDateInputSchema,
  metadata: jsonInputSchema,
}).defined();

const CommitRegistrationBodySchema = yupObject({
  release_id: yupString().uuid().defined(),
  repository: yupString().max(MAX_REPOSITORY_BYTES).defined(),
  commit_sha: yupString().max(MAX_COMMIT_SHA_BYTES).defined(),
  position: yupNumber().integer().min(0).max(MAX_DATABASE_INT).defined(),
  message: yupString().max(MAX_COMMIT_MESSAGE_BYTES).optional(),
  author_name: yupString().max(MAX_AUTHOR_NAME_BYTES).optional(),
  author_email: yupString().max(MAX_AUTHOR_EMAIL_BYTES).optional(),
  committed_at: nullableDateInputSchema,
  url: yupString().max(MAX_URL_BYTES).optional(),
}).defined();

const ArtifactRegistrationBodySchema = yupObject({
  release_id: yupString().uuid().defined(),
  manifest_sha256: yupString().length(64).matches(SHA256_PATTERN).defined(),
  dist: yupString().max(MAX_ARTIFACT_DIST_BYTES).optional(),
  environment: yupString().max(MAX_ENVIRONMENT_BYTES).optional(),
  status: yupString().oneOf(["registered", "finalized"]).optional(),
  manifest_object_key: yupString().max(MAX_OBJECT_KEY_BYTES).optional(),
  finalized_at: nullableDateInputSchema,
}).defined();

const DebugIdAssociationBodySchema = yupObject({
  release_artifact_id: yupString().uuid().defined(),
  debug_id: yupString().matches(DEBUG_ID_RE).defined(),
  code_file: yupString().max(MAX_CODE_FILE_BYTES).defined(),
  source_map_file: yupString().max(MAX_CODE_FILE_BYTES).nullable().defined(),
  source_map_inline: yupBoolean().defined(),
  bundle_sha256: yupString().length(64).matches(SHA256_PATTERN).defined(),
  bundle_bytes: yupNumber().integer().min(1).max(MAX_DATABASE_INT).defined(),
  source_map_sha256: yupString().length(64).matches(SHA256_PATTERN).defined(),
  source_map_bytes: yupNumber().integer().min(1).max(MAX_DATABASE_INT).defined(),
  source_map_gzipped_bytes: yupNumber().integer().min(1).max(MAX_DATABASE_INT).defined(),
  bundle_object_key: yupString().max(MAX_OBJECT_KEY_BYTES).optional(),
  source_map_object_key: yupString().max(MAX_OBJECT_KEY_BYTES).nullable().optional(),
}).defined();

const DebugIdLookupQuerySchema = yupObject({
  debug_id: yupString().matches(DEBUG_ID_RE).defined(),
  release: yupString().max(MAX_RELEASE_VERSION_BYTES).optional(),
  dist: yupString().max(MAX_ARTIFACT_DIST_BYTES).optional(),
  environment: yupString().max(MAX_ENVIRONMENT_BYTES).optional(),
}).defined();

const dateResponseSchema = yupString().nullable().defined();

const ReleaseResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  version: yupString().defined(),
  status: yupString().oneOf(["open", "archived"]).defined(),
  ref: yupString().nullable().defined(),
  url: yupString().nullable().defined(),
  data: yupMixed<NonNullJsonValue>().nullable().defined(),
  date_added: dateResponseSchema,
  date_started: dateResponseSchema,
  date_released: dateResponseSchema,
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

const ReleaseListResponseSchema = yupObject({
  items: yupArray(ReleaseResponseSchema).defined(),
  truncated: yupBoolean().defined(),
  next_cursor: yupString().nullable().defined(),
}).defined();

const DeploymentResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  release_id: yupString().uuid().defined(),
  deployment_key: yupString().defined(),
  environment: yupString().defined(),
  name: yupString().nullable().defined(),
  url: yupString().nullable().defined(),
  started_at: dateResponseSchema,
  finished_at: yupString().defined(),
  metadata: yupMixed<NonNullJsonValue>().nullable().defined(),
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

const CommitResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  release_id: yupString().uuid().defined(),
  repository: yupString().defined(),
  commit_sha: yupString().defined(),
  position: yupNumber().integer().defined(),
  message: yupString().nullable().defined(),
  author_name: yupString().nullable().defined(),
  author_email: yupString().nullable().defined(),
  committed_at: dateResponseSchema,
  url: yupString().nullable().defined(),
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

const ArtifactResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  release_id: yupString().uuid().defined(),
  manifest_sha256: yupString().defined(),
  dist: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  status: yupString().oneOf(["registered", "finalized"]).defined(),
  manifest_object_key: yupString().nullable().defined(),
  finalized_at: dateResponseSchema,
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

const DebugIdResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  release_artifact_id: yupString().uuid().defined(),
  debug_id: yupString().defined(),
  code_file: yupString().defined(),
  source_map_file: yupString().nullable().defined(),
  source_map_inline: yupBoolean().defined(),
  bundle_sha256: yupString().defined(),
  bundle_bytes: yupNumber().integer().defined(),
  source_map_sha256: yupString().defined(),
  source_map_bytes: yupNumber().integer().defined(),
  source_map_gzipped_bytes: yupNumber().integer().defined(),
  bundle_object_key: yupString().nullable().defined(),
  source_map_object_key: yupString().nullable().defined(),
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

const CatalogDebugIdResponseSchema = DebugIdResponseSchema.omit(["bundle_object_key", "source_map_object_key"]);
const CatalogArtifactResponseSchema = ArtifactResponseSchema.omit(["manifest_object_key"]).concat(yupObject({
  debug_ids: yupArray(CatalogDebugIdResponseSchema).defined(),
}).defined());
const CatalogArtifactPageResponseSchema = yupObject({
  items: yupArray(CatalogArtifactResponseSchema).defined(),
  next_cursor: yupString().nullable().defined(),
}).defined();
const ReleaseDetailResponseSchema = ReleaseResponseSchema.concat(yupObject({
  commits: yupArray(CommitResponseSchema).defined(),
  deployments: yupArray(DeploymentResponseSchema).defined(),
  artifacts: CatalogArtifactPageResponseSchema,
}).defined());

const DebugIdLookupResponseSchema = yupObject({
  items: yupArray(yupObject({
    release: ReleaseResponseSchema,
    artifact: ArtifactResponseSchema,
    debug_id: DebugIdResponseSchema,
  }).defined()).defined(),
}).defined();

type RouteRelease = Pick<Release, "id" | "version" | "status" | "ref" | "url" | "data" | "dateAdded" | "dateStarted" | "dateReleased" | "createdAt" | "updatedAt">;
type RouteDeployment = Pick<ReleaseDeployment, "id" | "releaseId" | "deploymentKey" | "environment" | "name" | "url" | "startedAt" | "finishedAt" | "metadata" | "createdAt" | "updatedAt">;
type RouteCommit = Pick<ReleaseCommit, "id" | "releaseId" | "repository" | "commitSha" | "position" | "message" | "authorName" | "authorEmail" | "committedAt" | "url" | "createdAt" | "updatedAt">;
type RouteArtifact = Pick<ReleaseArtifact, "id" | "releaseId" | "manifestSha256" | "dist" | "environment" | "status" | "manifestObjectKey" | "finalizedAt" | "createdAt" | "updatedAt">;
type RouteDebugId = Pick<ReleaseArtifactDebugId, "id" | "releaseArtifactId" | "debugId" | "codeFile" | "sourceMapFile" | "sourceMapInline" | "bundleSha256" | "bundleBytes" | "sourceMapSha256" | "sourceMapBytes" | "sourceMapGzippedBytes" | "bundleObjectKey" | "sourceMapObjectKey" | "createdAt" | "updatedAt">;

export function createReleaseLookupRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Look up a release",
      description: "Returns one release for the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      query: ReleaseLookupQuerySchema,
      method: yupString().oneOf(["GET"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: ReleaseDetailResponseSchema,
    }),
    handler: async ({ auth, query }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const detail = await service.getReleaseDetail({ tenancy: auth.tenancy }, query.version);
        if (detail === null) throw new StatusError(StatusError.NotFound, "Release not found");
        return { statusCode: 200, bodyType: "json", body: serializeReleaseDetail(detail) } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createReleaseListRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "List recent releases",
      description: "Returns recent releases for the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      query: ReleaseListQuerySchema,
      method: yupString().oneOf(["GET"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: ReleaseListResponseSchema,
    }),
    handler: async ({ auth, query }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const releases = await service.listReleases(
          { tenancy: auth.tenancy },
          { limit: parseOptionalReleaseLimit(query.limit), cursor: query.cursor },
        );
        return {
          statusCode: 200,
          bodyType: "json",
          body: {
            items: releases.items.map(serializeRelease),
            truncated: releases.nextCursor !== null,
            next_cursor: releases.nextCursor,
          },
        } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createReleaseArtifactListRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "List finalized source-map manifests for a release",
      description: "Returns cursor-paginated finalized source-map manifests and their debug IDs without private storage keys.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      query: ReleaseArtifactListQuerySchema,
      method: yupString().oneOf(["GET"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: CatalogArtifactPageResponseSchema,
    }),
    handler: async ({ auth, query }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const page = await service.listReleaseArtifacts({ tenancy: auth.tenancy }, {
          releaseId: query.release_id,
          limit: parseOptionalReleaseLimit(query.limit),
          cursor: query.cursor,
        });
        return { statusCode: 200, bodyType: "json", body: serializeArtifactPage(page) };
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createReleaseUpsertRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Register or update a release",
      description: "Idempotently registers release metadata inside the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      body: ReleaseUpsertBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: ReleaseResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const release = await service.upsertRelease({ tenancy: auth.tenancy }, {
          version: body.version,
          status: body.status === undefined ? undefined : body.status === "open" ? PrismaReleaseStatus.OPEN : PrismaReleaseStatus.ARCHIVED,
          ref: body.ref,
          url: body.url,
          data: body.data,
          dateAdded: parseOptionalDate(body.date_added),
          dateStarted: parseNullableDate(body.date_started),
          dateReleased: parseNullableDate(body.date_released),
        });
        return { statusCode: 200, bodyType: "json", body: serializeRelease(release) } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createDeploymentRegistrationRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Register a release deployment",
      description: "Idempotently registers a deployment for a release inside the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      body: DeploymentRegistrationBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: DeploymentResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const deployment = await service.upsertDeployment({ tenancy: auth.tenancy }, {
          releaseId: body.release_id,
          deploymentKey: body.deployment_key,
          environment: body.environment,
          name: body.name,
          url: body.url,
          startedAt: parseNullableDate(body.started_at),
          finishedAt: parseOptionalDate(body.finished_at),
          metadata: body.metadata,
        });
        return { statusCode: 200, bodyType: "json", body: serializeDeployment(deployment) } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createCommitRegistrationRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Register a release commit",
      description: "Idempotently associates an ordered repository commit with a release in the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      body: CommitRegistrationBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: CommitResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const commit = await service.upsertCommit({ tenancy: auth.tenancy }, {
          releaseId: body.release_id,
          repository: body.repository,
          commitSha: body.commit_sha,
          position: body.position,
          message: body.message,
          authorName: body.author_name,
          authorEmail: body.author_email,
          committedAt: parseNullableDate(body.committed_at),
          url: body.url,
        });
        return { statusCode: 200, bodyType: "json", body: serializeCommit(commit) } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createReleaseArtifactRegistrationRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Register a release artifact",
      description: "Registers an immutable source-map artifact binding inside the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      body: ArtifactRegistrationBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: ArtifactResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const artifact = await service.upsertArtifact({ tenancy: auth.tenancy }, {
          releaseId: body.release_id,
          manifestSha256: body.manifest_sha256,
          dist: body.dist,
          environment: body.environment,
          status: body.status === undefined ? undefined : body.status === "registered" ? PrismaReleaseArtifactStatus.REGISTERED : PrismaReleaseArtifactStatus.FINALIZED,
          manifestObjectKey: body.manifest_object_key,
          finalizedAt: parseNullableDate(body.finalized_at),
        });
        return { statusCode: 200, bodyType: "json", body: serializeArtifact(artifact) } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createDebugIdAssociationRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Associate a debug ID with a release artifact",
      description: "Registers exact bundle/source-map metadata for a release artifact inside the authenticated tenant, project, and branch scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      body: DebugIdAssociationBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: DebugIdResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const debugId = await service.upsertArtifactDebugId({ tenancy: auth.tenancy }, {
          releaseArtifactId: body.release_artifact_id,
          debugId: body.debug_id,
          codeFile: body.code_file,
          sourceMapFile: body.source_map_file,
          sourceMapInline: body.source_map_inline,
          bundleSha256: body.bundle_sha256,
          bundleBytes: body.bundle_bytes,
          sourceMapSha256: body.source_map_sha256,
          sourceMapBytes: body.source_map_bytes,
          sourceMapGzippedBytes: body.source_map_gzipped_bytes,
          bundleObjectKey: body.bundle_object_key,
          sourceMapObjectKey: body.source_map_object_key,
        });
        return { statusCode: 200, bodyType: "json", body: serializeDebugId(debugId) } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function createDebugIdLookupRoute(service: ReleaseService = releaseService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Look up release artifacts by debug ID",
      description: "Returns exact debug-ID artifact associations within the authenticated tenant, project, branch, release, distribution, and environment scope.",
      tags: ["Releases"],
    },
    request: yupObject({
      auth: ReleaseAuthSchema,
      query: DebugIdLookupQuerySchema,
      method: yupString().oneOf(["GET"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: DebugIdLookupResponseSchema,
    }),
    handler: async ({ auth, query }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const rows = await service.lookupArtifactDebugId({ tenancy: auth.tenancy }, {
          debugId: query.debug_id,
          releaseVersion: query.release,
          dist: query.dist,
          environment: query.environment,
        });
        return {
          statusCode: 200,
          bodyType: "json",
          body: {
            items: rows.map((row) => ({
              release: serializeRelease(row.release),
              artifact: serializeArtifact(row.artifact),
              debug_id: serializeDebugId(row.debugId),
            })),
          },
        } as const;
      } catch (error) {
        throwReleaseRouteError(error);
      }
    },
  });
}

export function throwReleaseRouteError(error: unknown): never {
  if (error instanceof ReleaseInputError) {
    throw new StatusError(StatusError.BadRequest, "Invalid release request");
  }
  if (error instanceof ReleaseNotFoundError || error instanceof ReleaseArtifactNotFoundError || error instanceof ReleaseScopeInvariantError) {
    throw new StatusError(StatusError.NotFound, "Release resource not found");
  }
  throw error;
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return new Date(value);
}

function parseOptionalReleaseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number(value);
}

function parseNullableDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return new Date(value);
}

function serializeRelease(release: RouteRelease) {
  return {
    id: release.id,
    version: release.version,
    status: release.status === PrismaReleaseStatus.OPEN ? "open" : "archived",
    ref: release.ref,
    url: release.url,
    data: serializeJson(release.data),
    date_added: release.dateAdded.toISOString(),
    date_started: release.dateStarted?.toISOString() ?? null,
    date_released: release.dateReleased?.toISOString() ?? null,
    created_at: release.createdAt.toISOString(),
    updated_at: release.updatedAt.toISOString(),
  } as const;
}

function serializeReleaseDetail(detail: ReleaseDetail) {
  return {
    ...serializeRelease(detail.release),
    commits: detail.commits.map(serializeCommit),
    deployments: detail.deployments.map(serializeDeployment),
    artifacts: serializeArtifactPage(detail.artifacts),
  } as const;
}

function serializeArtifactPage(page: Awaited<ReturnType<ReleaseService["listReleaseArtifacts"]>>) {
  return {
    items: page.items.map((artifact) => ({
      id: artifact.id,
      release_id: artifact.releaseId,
      manifest_sha256: artifact.manifestSha256,
      dist: artifact.dist,
      environment: artifact.environment,
      status: serializeCatalogArtifactStatus(artifact.status),
      finalized_at: artifact.finalizedAt?.toISOString() ?? null,
      created_at: artifact.createdAt.toISOString(),
      updated_at: artifact.updatedAt.toISOString(),
      debug_ids: artifact.debugIds.map((debugId) => ({
        id: debugId.id,
        release_artifact_id: debugId.releaseArtifactId,
        debug_id: debugId.debugId,
        code_file: debugId.codeFile,
        source_map_file: debugId.sourceMapFile,
        source_map_inline: debugId.sourceMapInline,
        bundle_sha256: debugId.bundleSha256,
        bundle_bytes: debugId.bundleBytes,
        source_map_sha256: debugId.sourceMapSha256,
        source_map_bytes: debugId.sourceMapBytes,
        source_map_gzipped_bytes: debugId.sourceMapGzippedBytes,
        created_at: debugId.createdAt.toISOString(),
        updated_at: debugId.updatedAt.toISOString(),
      })),
    })),
    next_cursor: page.nextCursor,
  };
}

function serializeCatalogArtifactStatus(status: ReleaseArtifact["status"]): "finalized" {
  if (status !== PrismaReleaseArtifactStatus.FINALIZED) {
    throw new Error("Release catalog returned a non-finalized artifact");
  }
  return "finalized";
}

function serializeJson(value: unknown): Json {
  if (!isJsonSerializable(value)) {
    throw new Error("Release metadata is not JSON serializable");
  }
  return value;
}

function serializeDeployment(deployment: RouteDeployment) {
  return {
    id: deployment.id,
    release_id: deployment.releaseId,
    deployment_key: deployment.deploymentKey,
    environment: deployment.environment,
    name: deployment.name,
    url: deployment.url,
    started_at: deployment.startedAt?.toISOString() ?? null,
    finished_at: deployment.finishedAt.toISOString(),
    metadata: serializeJson(deployment.metadata),
    created_at: deployment.createdAt.toISOString(),
    updated_at: deployment.updatedAt.toISOString(),
  } as const;
}

function serializeCommit(commit: RouteCommit) {
  return {
    id: commit.id,
    release_id: commit.releaseId,
    repository: commit.repository,
    commit_sha: commit.commitSha,
    position: commit.position,
    message: commit.message,
    author_name: commit.authorName,
    author_email: commit.authorEmail,
    committed_at: commit.committedAt?.toISOString() ?? null,
    url: commit.url,
    created_at: commit.createdAt.toISOString(),
    updated_at: commit.updatedAt.toISOString(),
  } as const;
}

function serializeArtifact(artifact: RouteArtifact) {
  return {
    id: artifact.id,
    release_id: artifact.releaseId,
    manifest_sha256: artifact.manifestSha256,
    dist: artifact.dist,
    environment: artifact.environment,
    status: artifact.status === PrismaReleaseArtifactStatus.REGISTERED ? "registered" : "finalized",
    manifest_object_key: artifact.manifestObjectKey,
    finalized_at: artifact.finalizedAt?.toISOString() ?? null,
    created_at: artifact.createdAt.toISOString(),
    updated_at: artifact.updatedAt.toISOString(),
  } as const;
}

function serializeDebugId(debugId: RouteDebugId) {
  return {
    id: debugId.id,
    release_artifact_id: debugId.releaseArtifactId,
    debug_id: debugId.debugId,
    code_file: debugId.codeFile,
    source_map_file: debugId.sourceMapFile,
    source_map_inline: debugId.sourceMapInline,
    bundle_sha256: debugId.bundleSha256,
    bundle_bytes: debugId.bundleBytes,
    source_map_sha256: debugId.sourceMapSha256,
    source_map_bytes: debugId.sourceMapBytes,
    source_map_gzipped_bytes: debugId.sourceMapGzippedBytes,
    bundle_object_key: debugId.bundleObjectKey,
    source_map_object_key: debugId.sourceMapObjectKey,
    created_at: debugId.createdAt.toISOString(),
    updated_at: debugId.updatedAt.toISOString(),
  } as const;
}
