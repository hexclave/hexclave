import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { ArtifactServiceError } from "./artifact-errors";
import {
  validateArtifactMetadata,
  type ArtifactManifestArtifact,
  type ArtifactScope,
} from "./artifact-manifest";
import {
  type ArtifactLookup,
  type ArtifactManifestFinalizeRequest,
  type ArtifactManifestFinalizeResult,
  type ArtifactManifestRegistrationRequest,
  type ArtifactManifestRegistrationResult,
  type ArtifactUploadDescriptor,
  ArtifactUploadService,
} from "./artifact-upload-service";
import type { ArtifactPublicationFinalizeResult, ArtifactPublicationService } from "./artifact-publication-service";

export type ArtifactRouteTenancy = {
  id: string,
  branchId: string,
  project: { id: string },
};

const artifactAuthSchema = yupObject({
  type: serverOrHigherAuthTypeSchema,
  tenancy: adaptSchema.defined(),
}).defined();

const artifactManifestArtifactResponseSchema = yupObject({
  debug_id: yupString().defined(),
  code_file: yupString().defined(),
  source_map_file: yupString().nullable().defined(),
  source_map_inline: yupBoolean().defined(),
  bundle_sha256: yupString().defined(),
  bundle_bytes: yupNumber().defined(),
  source_map_sha256: yupString().defined(),
  source_map_bytes: yupNumber().defined(),
  source_map_gzipped_bytes: yupNumber().defined(),
}).defined();

const artifactRegistrationBodySchema = yupObject({
  manifest: yupMixed().defined(),
  manifest_sha256: yupString().optional(),
}).defined();

const artifactFinalizeBodySchema = yupObject({
  manifest_sha256: yupString().optional(),
}).defined();

const artifactLookupQuerySchema = yupObject({
  debug_id: yupString().optional(),
  release: yupString().optional(),
  dist: yupString().optional(),
}).defined();

const artifactUploadDescriptorResponseSchema = yupObject({
  debug_id: yupString().defined(),
  code_file: yupString().defined(),
  source_map_file: yupString().nullable().defined(),
  bundle_object_key: yupString().defined(),
  bundle_upload_url: yupString().defined(),
  source_map_object_key: yupString().nullable().defined(),
  source_map_upload_url: yupString().nullable().defined(),
  already_finalized: yupBoolean().defined(),
}).defined();

const artifactRegistrationResponseSchema = yupObject({
  manifest_sha256: yupString().defined(),
  status: yupString().oneOf(["registered", "already_registered"]).defined(),
  finalize_path: yupString().defined(),
  artifacts: yupArray(artifactUploadDescriptorResponseSchema).defined(),
}).defined();

const artifactFinalizeResponseSchema = yupObject({
  manifest_sha256: yupString().defined(),
  status: yupString().oneOf(["finalized", "already_finalized"]).defined(),
  uploaded: yupArray(yupString().defined()).defined(),
  already_uploaded: yupArray(yupString().defined()).defined(),
  catalog_status: yupString().oneOf(["published", "already_published", "unversioned"]).defined(),
}).defined();

const artifactLookupResponseSchema = yupObject({
  manifest_sha256: yupString().defined(),
  release: yupString().nullable().defined(),
  dist: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  artifact: artifactManifestArtifactResponseSchema,
  bundle_object_key: yupString().defined(),
  source_map_object_key: yupString().nullable().defined(),
}).defined();

export function artifactScopeForTenancy(tenancy: ArtifactRouteTenancy): ArtifactScope {
  return {
    tenantId: tenancy.id,
    projectId: tenancy.project.id,
    branchId: tenancy.branchId,
  };
}

export async function registerArtifactManifest(
  service: ArtifactUploadService,
  tenancy: ArtifactRouteTenancy,
  input: unknown,
): Promise<ArtifactManifestRegistrationResult> {
  return await service.registerManifest(
    artifactScopeForTenancy(tenancy),
    parseArtifactManifestRegistrationRequest(input),
  );
}

export async function finalizeArtifactManifest(
  service: Pick<ArtifactPublicationService, "finalizeManifest">,
  tenancy: ArtifactRouteTenancy,
  input: unknown,
): Promise<ArtifactPublicationFinalizeResult> {
  return await service.finalizeManifest(
    artifactScopeForTenancy(tenancy),
    parseArtifactManifestFinalizeRequest(input),
  );
}

export async function lookupArtifact(
  service: ArtifactUploadService,
  tenancy: ArtifactRouteTenancy,
  input: unknown,
): Promise<ArtifactLookup | null> {
  return await service.lookupArtifact(
    artifactScopeForTenancy(tenancy),
    parseArtifactLookupQuery(input),
  );
}

export function parseArtifactManifestRegistrationRequest(input: unknown): ArtifactManifestRegistrationRequest {
  const record = readRecord(input, "Artifact registration request");
  return {
    manifest: record.manifest,
    manifestSha256: readRequiredString(record, "manifest_sha256"),
  };
}

export function parseArtifactManifestFinalizeRequest(input: unknown): ArtifactManifestFinalizeRequest {
  const record = readRecord(input, "Artifact finalize request");
  return {
    manifestSha256: readRequiredString(record, "manifest_sha256"),
  };
}

export function parseArtifactLookupQuery(input: unknown): { debugId: string, release: string | null, dist: string | null } {
  const record = readRecord(input, "Artifact lookup query");
  return {
    debugId: readRequiredString(record, "debug_id"),
    release: validateArtifactMetadata(record.release, "release"),
    dist: validateArtifactMetadata(record.dist, "dist"),
  };
}

export function throwArtifactRouteError(error: unknown): never {
  if (!(error instanceof ArtifactServiceError)) throw error;

  switch (error.code) {
    case "invalid_manifest": {
      throw new StatusError(StatusError.BadRequest, error.message);
    }
    case "invalid_archive": {
      throw new StatusError(StatusError.BadRequest, error.message);
    }
    case "artifact_not_found": {
      throw new StatusError(StatusError.BadRequest, error.message);
    }
    case "manifest_not_found": {
      throw new StatusError(StatusError.NotFound, error.message);
    }
    case "manifest_conflict": {
      throw new StatusError(StatusError.Conflict, error.message);
    }
    case "artifact_conflict": {
      throw new StatusError(StatusError.Conflict, error.message);
    }
    case "unsupported_source_map": {
      throw new StatusError(StatusError.BadRequest, error.message);
    }
    case "storage_unavailable": {
      throw new StatusError(StatusError.ServiceUnavailable, error.message);
    }
    case "integrity_mismatch": {
      throw new StatusError(StatusError.InternalServerError, "Artifact storage integrity validation failed.");
    }
  }
}

export function createArtifactRegistrationRoute(service: ArtifactUploadService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Register source-map artifacts",
      description: "Registers a tenant-scoped source-map manifest and returns private presigned upload URLs for its immutable bundle objects.",
      tags: ["Source Maps"],
      hidden: true,
    },
    request: yupObject({
      auth: artifactAuthSchema,
      body: artifactRegistrationBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200, 201]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: artifactRegistrationResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const result = await registerArtifactManifest(service, auth.tenancy, body);
        const statusCode: 200 | 201 = result.status === "registered" ? 201 : 200;
        return {
          statusCode,
          bodyType: "json",
          body: serializeRegistrationResult(result),
        };
      } catch (error) {
        throwArtifactRouteError(error);
      }
    },
  });
}

export function createArtifactFinalizeRoute(service: Pick<ArtifactPublicationService, "finalizeManifest">) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Finalize source-map artifacts",
      description: "Verifies uploaded private bundles and source maps by length, digest, compression, and source-map schema before publishing exact debug-ID indexes.",
      tags: ["Source Maps"],
      hidden: true,
    },
    request: yupObject({
      auth: artifactAuthSchema,
      body: artifactFinalizeBodySchema,
      method: yupString().oneOf(["POST"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: artifactFinalizeResponseSchema,
    }),
    handler: async ({ auth, body }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const result = await finalizeArtifactManifest(service, auth.tenancy, body);
        return {
          statusCode: 200,
          bodyType: "json",
          body: serializeFinalizeResult(result),
        };
      } catch (error) {
        throwArtifactRouteError(error);
      }
    },
  });
}

export function createArtifactLookupRoute(service: ArtifactUploadService) {
  return createSmartRouteHandler({
    metadata: {
      summary: "Look up a source-map artifact",
      description: "Looks up an exact debug ID within the authenticated tenant, project branch, release, and distribution scope.",
      tags: ["Source Maps"],
      hidden: true,
    },
    request: yupObject({
      auth: artifactAuthSchema,
      query: artifactLookupQuerySchema,
      method: yupString().oneOf(["GET"]).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: artifactLookupResponseSchema,
    }),
    handler: async ({ auth, query }) => {
      assertObservabilityEnabled(auth.tenancy);
      try {
        const result = await lookupArtifact(service, auth.tenancy, query);
        if (result === null) {
          throw new StatusError(StatusError.NotFound, "The requested source-map artifact was not found.");
        }
        return {
          statusCode: 200,
          bodyType: "json",
          body: serializeLookupResult(result),
        };
      } catch (error) {
        throwArtifactRouteError(error);
      }
    },
  });
}

function readRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ArtifactServiceError("invalid_manifest", `${label} must be an object.`);
  }
  return input;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactServiceError("invalid_manifest", `${key} must be a non-empty string.`);
  }
  return value;
}

function serializeRegistrationResult(result: ArtifactManifestRegistrationResult) {
  return {
    manifest_sha256: result.manifestSha256,
    status: result.status,
    finalize_path: result.finalizePath,
    artifacts: result.artifacts.map(serializeUploadDescriptor),
  };
}

function serializeUploadDescriptor(descriptor: ArtifactUploadDescriptor) {
  return {
    debug_id: descriptor.debugId,
    code_file: descriptor.codeFile,
    source_map_file: descriptor.sourceMapFile,
    bundle_object_key: descriptor.bundleObjectKey,
    bundle_upload_url: descriptor.bundleUploadUrl,
    source_map_object_key: descriptor.sourceMapObjectKey,
    source_map_upload_url: descriptor.sourceMapUploadUrl,
    already_finalized: descriptor.alreadyFinalized,
  };
}

function serializeFinalizeResult(result: ArtifactPublicationFinalizeResult) {
  return {
    manifest_sha256: result.manifestSha256,
    status: result.status,
    uploaded: [...result.uploaded],
    already_uploaded: [...result.alreadyUploaded],
    catalog_status: result.catalogStatus,
  };
}

function serializeLookupResult(result: ArtifactLookup) {
  return {
    manifest_sha256: result.manifestSha256,
    release: result.release,
    dist: result.dist,
    environment: result.environment,
    artifact: serializeManifestArtifact(result.artifact),
    bundle_object_key: result.bundleObjectKey,
    source_map_object_key: result.sourceMapObjectKey,
  };
}

function serializeManifestArtifact(artifact: ArtifactManifestArtifact) {
  return {
    debug_id: artifact.debugId,
    code_file: artifact.codeFile,
    source_map_file: artifact.sourceMapFile,
    source_map_inline: artifact.sourceMapInline,
    bundle_sha256: artifact.bundleSha256,
    bundle_bytes: artifact.bundleBytes,
    source_map_sha256: artifact.sourceMapSha256,
    source_map_bytes: artifact.sourceMapBytes,
    source_map_gzipped_bytes: artifact.sourceMapGzippedBytes,
  };
}
