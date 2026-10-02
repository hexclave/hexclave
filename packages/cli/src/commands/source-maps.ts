import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { getInternalUser } from "../lib/app.js";
import {
  isProjectAuthWithRefreshToken,
  isProjectAuthWithSecretServerKey,
  resolveAuth,
  resolveProjectId,
  type ProjectAuth,
} from "../lib/auth.js";
import { AuthError, CliError, errorMessage } from "../lib/errors.js";
import {
  appendDebugIdSnippet,
  collectArtifacts,
  deriveBundleDebugId,
  findIntegrityManifests,
  findNextBuildRoots,
  isInside,
  isDebugId,
  NEXT_SERVER_SOURCE_MAPS_CONFIG_HINT,
  normalizeArtifactRelativePath,
  prepareSourceMapForUpload,
  readInlineSourceMap,
  sha256Hex,
  type SourceMapArtifactCandidate,
} from "../lib/source-maps.js";

export type SourceMapsUploadOptions = {
  release?: string,
  dist?: string,
  environment?: string,
  deleteMaps?: boolean,
  dryRun?: boolean,
  strict?: boolean,
  cloudProjectId?: string,
};

export type PreparedSourceMapArtifact = {
  debugId: string,
  bundlePath: string,
  bundleRelativePath: string,
  sourceMapPath: string | null,
  sourceMapRelativePath: string | null,
  /** sha256 of the emitted bundle after debug-id injection, which is uploaded. */
  bundleSha256: string,
  /** Byte length of the emitted bundle after debug-id injection, which is uploaded. */
  bundleBytes: number,
  /** sha256 of the prepared (uncompressed) source map JSON. Also the storage key. */
  sourceMapSha256: string,
  sourceMapGzipped: Uint8Array,
  sourceMapBytes: number,
};

export type SourceMapUploadRequest = {
  auth: ProjectAuth,
  getAuthHeaders: () => Promise<Record<string, string>>,
  release: string | null,
  dist: string | null,
  environment: string | null,
  artifacts: readonly PreparedSourceMapArtifact[],
  plan: SourceMapUploadPlan,
  transport?: SourceMapUploadTransport,
};

export type SourceMapUploadRequestInput = Omit<SourceMapUploadRequest, "plan">;

export type SourceMapUploadResult = {
  /** Debug ids the server stored during this run. */
  uploaded: readonly string[],
  /** Debug ids the server already had (a derived id that did not change). */
  alreadyUploaded: readonly string[],
  catalogStatus: "published" | "already_published" | "unversioned",
  storageNotConfigured: boolean,
};

export type SourceMapUploadTransport = {
  fetch?: typeof fetch,
  sleep?: (milliseconds: number) => Promise<void>,
};

export class SourceMapUploadHttpError extends CliError {
  public readonly status: number;
  public readonly operation: string;

  constructor(operation: string, status: number, message: string) {
    super(`Source-map ${operation} failed with HTTP ${status}: ${message}`);
    this.name = "SourceMapUploadHttpError";
    this.status = status;
    this.operation = operation;
  }
}

export class SourceMapUploadProtocolError extends CliError {
  public readonly operation: string;

  constructor(operation: string, message: string) {
    super(`Invalid source-map ${operation} response: ${message}`);
    this.name = "SourceMapUploadProtocolError";
    this.operation = operation;
  }
}

export class SourceMapUploadNetworkError extends CliError {
  public readonly operation: string;

  constructor(operation: string, message: string) {
    super(`Source-map ${operation} request failed: ${message}`);
    this.name = "SourceMapUploadNetworkError";
    this.operation = operation;
  }
}

export const SOURCE_MAP_MANIFEST_VERSION = 1;

export type SourceMapManifestArtifact = {
  debugId: string,
  codeFile: string,
  sourceMapFile: string | null,
  sourceMapInline: boolean,
  bundleSha256: string,
  bundleBytes: number,
  sourceMapSha256: string,
  sourceMapBytes: number,
  sourceMapGzippedBytes: number,
};

export type SourceMapManifest = {
  schemaVersion: typeof SOURCE_MAP_MANIFEST_VERSION,
  projectId: string | null,
  release: string | null,
  dist: string | null,
  environment: string | null,
  artifacts: readonly SourceMapManifestArtifact[],
};

export type SourceMapUploadPlan = {
  manifest: SourceMapManifest,
  manifestJson: string,
  manifestSha256: string,
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeOptionalMetadata(value: string | undefined, optionName: string): string | null {
  if (value == null) return null;
  if (value.trim() === "") {
    throw new CliError(`${optionName} must not be empty.`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > 256) {
    throw new CliError(`${optionName} must be at most 256 UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CliError(`${optionName} must not contain control characters.`);
  }
  return normalized;
}

function resolveOptionalProjectId(option: string | undefined): string | null {
  if (option != null) return normalizeOptionalMetadata(option, "--cloud-project-id");
  const hexclaveProjectId = process.env.HEXCLAVE_PROJECT_ID;
  const stackProjectId = process.env.STACK_PROJECT_ID;
  if (hexclaveProjectId != null && stackProjectId != null && hexclaveProjectId !== stackProjectId) {
    throw new CliError("Environment variables HEXCLAVE_PROJECT_ID and STACK_PROJECT_ID are both set to different values. Remove one of them or set them to the same value.");
  }
  return normalizeOptionalMetadata(hexclaveProjectId ?? stackProjectId, "--cloud-project-id");
}

export function createSourceMapManifest(
  artifacts: readonly PreparedSourceMapArtifact[],
  release: string | undefined | null,
  environment: string | undefined | null,
  options: { projectId?: string | null, dist?: string | null } = {},
): SourceMapManifest {
  const byDebugId = new Map<string, SourceMapManifestArtifact>();
  const byCodeFile = new Map<string, SourceMapManifestArtifact>();
  const manifestArtifacts = artifacts
    .map((artifact) => {
      // Validate the identifier before it becomes durable metadata. This also
      // keeps the future registry from receiving uppercase and lowercase rows
      // for what Symbolicator treats as one debug ID.
      if (!isDebugId(artifact.debugId)) {
        throw new CliError(`Invalid debug id ${JSON.stringify(artifact.debugId)} in artifact manifest.`);
      }
      if (!/^[a-f0-9]{64}$/.test(artifact.bundleSha256) || !/^[a-f0-9]{64}$/.test(artifact.sourceMapSha256)) {
        throw new CliError(`Artifact ${JSON.stringify(artifact.bundleRelativePath)} has an invalid SHA-256 digest.`);
      }
      if (!Number.isSafeInteger(artifact.bundleBytes) || artifact.bundleBytes <= 0) {
        throw new CliError(`Artifact ${JSON.stringify(artifact.bundleRelativePath)} has an invalid bundle byte count.`);
      }
      if (!Number.isSafeInteger(artifact.sourceMapBytes) || artifact.sourceMapBytes <= 0 || artifact.sourceMapGzipped.length <= 0) {
        throw new CliError(`Artifact ${JSON.stringify(artifact.bundleRelativePath)} has an invalid source-map byte count.`);
      }
      return {
        debugId: artifact.debugId,
        codeFile: normalizeArtifactRelativePath(artifact.bundleRelativePath, "Artifact code file"),
        sourceMapFile: artifact.sourceMapRelativePath === null
          ? null
          : normalizeArtifactRelativePath(artifact.sourceMapRelativePath, "Artifact source map file"),
        sourceMapInline: artifact.sourceMapPath === null,
        bundleSha256: artifact.bundleSha256,
        bundleBytes: artifact.bundleBytes,
        sourceMapSha256: artifact.sourceMapSha256,
        sourceMapBytes: artifact.sourceMapBytes,
        sourceMapGzippedBytes: artifact.sourceMapGzipped.length,
      };
    })
    .sort((left, right) => compareStrings(left.codeFile, right.codeFile) || compareStrings(left.debugId, right.debugId));

  const uniqueManifestArtifacts: SourceMapManifestArtifact[] = [];
  for (const artifact of manifestArtifacts) {
    const existingPath = byCodeFile.get(artifact.codeFile);
    if (existingPath !== undefined) {
      throw new CliError(
        `Duplicate artifact path ${JSON.stringify(artifact.codeFile)} was prepared more than once. `
        + "Use one scan root or make the artifact paths unique before uploading.",
      );
    }
    byCodeFile.set(artifact.codeFile, artifact);
    const existing = byDebugId.get(artifact.debugId);
    if (existing !== undefined && (existing.codeFile !== artifact.codeFile || existing.sourceMapSha256 !== artifact.sourceMapSha256)) {
      throw new CliError(
        `Duplicate debug ID ${artifact.debugId} refers to conflicting artifacts ${JSON.stringify(existing.codeFile)} and ${JSON.stringify(artifact.codeFile)}. `
        + "Clean the build output and ensure each emitted bundle receives a unique debug ID.",
      );
    }
    if (existing === undefined) {
      byDebugId.set(artifact.debugId, artifact);
      uniqueManifestArtifacts.push(artifact);
    }
  }

  return {
    schemaVersion: SOURCE_MAP_MANIFEST_VERSION,
    projectId: normalizeOptionalMetadata(options.projectId ?? undefined, "--cloud-project-id"),
    release: normalizeOptionalMetadata(release ?? undefined, "--release"),
    dist: normalizeOptionalMetadata(options.dist ?? undefined, "--dist"),
    environment: normalizeOptionalMetadata(environment ?? undefined, "--environment"),
    artifacts: uniqueManifestArtifacts,
  };
}

export function createSourceMapUploadPlan(request: SourceMapUploadRequestInput): SourceMapUploadPlan {
  const manifest = createSourceMapManifest(request.artifacts, request.release, request.environment, {
    projectId: request.auth.projectId,
    dist: request.dist,
  });
  if (manifest.projectId === null) {
    throw new CliError("Project ID is required for source-map uploads so artifacts cannot cross project boundaries.");
  }
  if (manifest.dist !== null && manifest.release === null) {
    throw new CliError("Distribution is only meaningful with a release. Supply --release together with --dist.");
  }
  const manifestJson = JSON.stringify(manifest);
  return {
    manifest,
    manifestJson,
    manifestSha256: sha256Hex(Buffer.from(manifestJson, "utf-8")),
  };
}

export function createSourceMapUploadRequest(input: SourceMapUploadRequestInput): SourceMapUploadRequest {
  return { ...input, plan: createSourceMapUploadPlan(input) };
}

const SOURCE_MAP_REGISTRATION_PATH = "/api/latest/source-maps/artifacts";
const SOURCE_MAP_FINALIZE_PATH = "/api/latest/source-maps/artifacts/finalize";
const SOURCE_MAP_REQUEST_TIMEOUT_MS = 60_000;
const SOURCE_MAP_MAX_ATTEMPTS = 3;
const SOURCE_MAP_MAX_RETRY_DELAY_MS = 5_000;
const SOURCE_MAP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type RegisteredArtifact = {
  debugId: string,
  codeFile: string,
  sourceMapFile: string | null,
  bundleUploadUrl: string,
  sourceMapUploadUrl: string | null,
  alreadyFinalized: boolean,
  artifact: PreparedSourceMapArtifact,
};

type RegistrationResponse = {
  manifestSha256: string,
  finalizePath: string,
  artifacts: readonly RegisteredArtifact[],
};

type FinalizeResponse = {
  uploaded: readonly string[],
  alreadyUploaded: readonly string[],
  catalogStatus: "published" | "already_published" | "unversioned",
};

export async function createSourceMapAuthHeadersFactory(auth: ProjectAuth): Promise<() => Promise<Record<string, string>>> {
  if (isProjectAuthWithSecretServerKey(auth)) {
    const headers = {
      "x-stack-access-type": "server",
      "x-stack-project-id": auth.projectId,
      "x-stack-secret-server-key": auth.secretServerKey,
    };
    return () => Promise.resolve({ ...headers });
  }
  if (!isProjectAuthWithRefreshToken(auth)) {
    throw new AuthError("Source-map uploads require either HEXCLAVE_SECRET_SERVER_KEY or a `hexclave login` session.");
  }

  const user = await getInternalUser(auth);
  return async () => {
    const { accessToken } = await user.currentSession.getTokens();
    if (accessToken == null) {
      throw new AuthError("Could not obtain an access token. Run `hexclave login` again.");
    }
    return {
      "x-stack-access-type": "admin",
      "x-stack-project-id": auth.projectId,
      "x-stack-admin-access-token": accessToken,
    };
  };
}

export async function uploadPreparedSourceMaps(request: SourceMapUploadRequest): Promise<SourceMapUploadResult> {
  const expectedPlan = createSourceMapUploadPlan(request);
  if (
    expectedPlan.manifestJson !== request.plan.manifestJson
    || expectedPlan.manifestSha256 !== request.plan.manifestSha256
    || JSON.stringify(request.plan.manifest) !== expectedPlan.manifestJson
  ) {
    throw new CliError("The source-map upload plan changed after preparation. Re-run the build and upload together so artifact digests and the manifest stay consistent.");
  }
  if (expectedPlan.manifest.artifacts.length === 0) {
    throw new CliError("Cannot upload source maps because the prepared manifest contains no artifacts.");
  }

  const transport = request.transport ?? {};
  const registrationBody = {
    manifest: expectedPlan.manifest,
    manifest_sha256: expectedPlan.manifestSha256,
  };
  const registration = await requestSourceMapJson(
    request,
    transport,
    SOURCE_MAP_REGISTRATION_PATH,
    registrationBody,
    expectedPlan.manifestSha256,
    "registration",
    (value) => parseRegistrationResponse(value, expectedPlan, request.artifacts),
  );

  if (!registration.artifacts.every((artifact) => artifact.alreadyFinalized)) {
    for (const registered of registration.artifacts) {
      if (registered.alreadyFinalized) continue;
      const bundleBytes = readAndVerifyBundle(registered.artifact, expectedPlan.manifestSha256);
      await uploadPresignedObject(
        transport,
        registered.bundleUploadUrl,
        "application/javascript",
        null,
        bundleBytes,
        `bundle ${registered.codeFile}`,
      );
      if (registered.sourceMapUploadUrl !== null) {
        await uploadPresignedObject(
          transport,
          registered.sourceMapUploadUrl,
          "application/json",
          "gzip",
          registered.artifact.sourceMapGzipped,
          `source map ${registered.codeFile}`,
        );
      }
    }
  }

  const finalized = await requestSourceMapJson(
    { ...request, plan: expectedPlan },
    transport,
    registration.finalizePath,
    { manifest_sha256: expectedPlan.manifestSha256 },
    expectedPlan.manifestSha256,
    "finalize",
    (value) => parseFinalizeResponse(value, expectedPlan),
  );
  return {
    uploaded: finalized.uploaded,
    alreadyUploaded: finalized.alreadyUploaded,
    catalogStatus: finalized.catalogStatus,
    storageNotConfigured: false,
  };
}

function readAndVerifyBundle(artifact: PreparedSourceMapArtifact, manifestSha256: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(artifact.bundlePath);
  } catch (error) {
    throw new CliError(`Could not read prepared bundle ${artifact.bundlePath} for manifest ${manifestSha256}: ${errorMessage(error)}`);
  }
  if (bytes.byteLength !== artifact.bundleBytes || sha256Hex(bytes) !== artifact.bundleSha256) {
    throw new CliError(`Prepared bundle ${artifact.bundlePath} no longer matches manifest ${manifestSha256}. Re-run source-map preparation and upload together.`);
  }
  return bytes;
}

type SourceMapApiRequestBody = {
  manifest?: SourceMapManifest,
  manifest_sha256: string,
};

async function requestSourceMapJson<T>(
  request: SourceMapUploadRequest,
  transport: SourceMapUploadTransport,
  apiPath: string,
  body: SourceMapApiRequestBody,
  idempotencyKey: string,
  operation: string,
  parse: (value: unknown) => T,
): Promise<T> {
  const url = createSourceMapApiUrl(request.auth, apiPath, operation);
  const authHeaders = await request.getAuthHeaders();
  const response = await fetchWithRetries(transport, url, {
    method: "POST",
    headers: {
      ...authHeaders,
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  }, operation);
  const responseText = await readResponseText(response, operation);
  if (!response.ok) {
    throw new SourceMapUploadHttpError(operation, response.status, describeResponseBody(responseText, response.statusText));
  }
  if (responseText.trim() === "") {
    throw new SourceMapUploadProtocolError(operation, "the response body was empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new SourceMapUploadProtocolError(operation, "the response body was not valid JSON");
  }
  return parse(parsed);
}

async function uploadPresignedObject(
  transport: SourceMapUploadTransport,
  uploadUrl: string,
  contentType: string,
  contentEncoding: string | null,
  bytes: Uint8Array,
  operation: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": bytes.byteLength.toString(),
    "if-none-match": "*",
  };
  if (contentEncoding !== null) headers["content-encoding"] = contentEncoding;
  const response = await fetchWithRetries(transport, uploadUrl, {
    method: "PUT",
    headers,
    // A copied ArrayBuffer satisfies Node's BodyInit type and prevents a
    // caller-owned Buffer from being mutated while fetch is in flight.
    body: new Uint8Array(bytes).slice().buffer,
  }, operation);
  if (response.status === 412) return;
  if (!response.ok) {
    const responseText = await readResponseText(response, operation);
    throw new SourceMapUploadHttpError(operation, response.status, describeResponseBody(responseText, response.statusText));
  }
}

async function fetchWithRetries(
  transport: SourceMapUploadTransport,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  const fetcher = transport.fetch ?? globalThis.fetch;
  let lastNetworkError: SourceMapUploadNetworkError | null = null;
  for (let attempt = 1; attempt <= SOURCE_MAP_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(fetcher, url, init, operation);
      if (!isRetryableSourceMapStatus(response.status) || attempt === SOURCE_MAP_MAX_ATTEMPTS) {
        return response;
      }
      await waitBeforeSourceMapRetry(transport, response, attempt);
    } catch (error) {
      if (!(error instanceof SourceMapUploadNetworkError)) throw error;
      lastNetworkError = error;
      if (attempt === SOURCE_MAP_MAX_ATTEMPTS) throw error;
      await waitBeforeSourceMapRetry(transport, null, attempt);
    }
  }
  throw lastNetworkError ?? new SourceMapUploadNetworkError(operation, "request attempts were exhausted");
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_MAP_REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new SourceMapUploadNetworkError(operation, errorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function waitBeforeSourceMapRetry(
  transport: SourceMapUploadTransport,
  response: Response | null,
  attempt: number,
): Promise<void> {
  const retryAfter = response?.headers.get("retry-after");
  const retryAfterSeconds = retryAfter == null ? Number.NaN : Number.parseInt(retryAfter, 10);
  const retryAfterMilliseconds = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1_000
    : 250 * (2 ** (attempt - 1));
  const delay = Math.min(retryAfterMilliseconds, SOURCE_MAP_MAX_RETRY_DELAY_MS);
  if (delay === 0) return;
  await (transport.sleep ?? sleep)(delay);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableSourceMapStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function readResponseText(response: Response, operation: string): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new SourceMapUploadNetworkError(operation, `could not read the response body: ${errorMessage(error)}`);
  }
  if (Buffer.byteLength(text, "utf8") > SOURCE_MAP_MAX_RESPONSE_BYTES) {
    throw new SourceMapUploadProtocolError(operation, `the response body exceeded ${SOURCE_MAP_MAX_RESPONSE_BYTES} bytes`);
  }
  return text;
}

function createSourceMapApiUrl(auth: ProjectAuth, apiPath: string, operation: string): string {
  let parsed: URL;
  try {
    parsed = new URL(auth.apiUrl);
  } catch {
    throw new SourceMapUploadProtocolError(operation, "the configured API URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SourceMapUploadProtocolError(operation, "the configured API URL must use http or https");
  }
  return `${auth.apiUrl.replace(/\/+$/, "")}${apiPath}`;
}

function describeResponseBody(text: string, statusText: string): string {
  if (text.trim() === "") return statusText || "empty response";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return error.slice(0, 1_000);
      if (isRecord(error)) {
        const message = error.message;
        if (typeof message === "string") return message.slice(0, 1_000);
      }
      const message = parsed.message;
      if (typeof message === "string") return message.slice(0, 1_000);
    }
  } catch {
  }
  return text.trim().slice(0, 1_000);
}

function parseRegistrationResponse(
  value: unknown,
  plan: SourceMapUploadPlan,
  artifacts: readonly PreparedSourceMapArtifact[],
): RegistrationResponse {
  const record = readResponseRecord(value, "registration");
  const manifestSha256 = readResponseString(record, "manifest_sha256", "registration");
  if (manifestSha256 !== plan.manifestSha256) {
    throw new SourceMapUploadProtocolError("registration", `manifest digest ${manifestSha256} did not match ${plan.manifestSha256}`);
  }
  const status = readResponseString(record, "status", "registration");
  if (status !== "registered" && status !== "already_registered") {
    throw new SourceMapUploadProtocolError("registration", `unknown status ${JSON.stringify(status)}`);
  }
  const finalizePath = readResponseString(record, "finalize_path", "registration");
  if (finalizePath !== SOURCE_MAP_FINALIZE_PATH) {
    throw new SourceMapUploadProtocolError("registration", `unexpected finalize path ${JSON.stringify(finalizePath)}`);
  }
  const responseArtifacts = record.artifacts;
  if (!Array.isArray(responseArtifacts)) {
    throw new SourceMapUploadProtocolError("registration", "artifacts must be an array");
  }
  const artifactsByDebugId = new Map(artifacts.map((artifact) => [artifact.debugId, artifact]));
  const seenDebugIds = new Set<string>();
  const registeredArtifacts: RegisteredArtifact[] = [];
  for (const responseArtifact of responseArtifacts) {
    const artifactRecord = readResponseRecord(responseArtifact, "registration artifact");
    const debugId = readResponseString(artifactRecord, "debug_id", "registration artifact");
    const artifact = artifactsByDebugId.get(debugId);
    if (artifact === undefined) {
      throw new SourceMapUploadProtocolError("registration", `returned unknown debug ID ${debugId}`);
    }
    if (seenDebugIds.has(debugId)) {
      throw new SourceMapUploadProtocolError("registration", `returned duplicate debug ID ${debugId}`);
    }
    seenDebugIds.add(debugId);
    const manifestArtifact = plan.manifest.artifacts.find((candidate) => candidate.debugId === debugId);
    if (manifestArtifact === undefined) {
      throw new SourceMapUploadProtocolError("registration", `manifest has no artifact for debug ID ${debugId}`);
    }
    const codeFile = readResponseString(artifactRecord, "code_file", "registration artifact");
    const sourceMapFile = readResponseNullableString(artifactRecord, "source_map_file", "registration artifact");
    if (codeFile !== manifestArtifact.codeFile || sourceMapFile !== manifestArtifact.sourceMapFile) {
      throw new SourceMapUploadProtocolError("registration", `artifact ${debugId} did not preserve its prepared file identities`);
    }
    const bundleObjectKey = readResponseString(artifactRecord, "bundle_object_key", "registration artifact");
    const sourceMapObjectKey = readResponseNullableString(artifactRecord, "source_map_object_key", "registration artifact");
    if (bundleObjectKey === "") {
      throw new SourceMapUploadProtocolError("registration", `artifact ${debugId} has an empty bundle object key`);
    }
    if (artifact.sourceMapRelativePath === null && sourceMapObjectKey !== null) {
      throw new SourceMapUploadProtocolError("registration", `inline artifact ${debugId} unexpectedly has a source-map object key`);
    }
    if (artifact.sourceMapRelativePath !== null && sourceMapObjectKey === null) {
      throw new SourceMapUploadProtocolError("registration", `external-map artifact ${debugId} has no source-map object key`);
    }
    const bundleUploadUrl = validatePresignedUploadUrl(
      readResponseString(artifactRecord, "bundle_upload_url", "registration artifact"),
      "registration artifact bundle URL",
    );
    const sourceMapUploadUrlValue = readResponseNullableString(artifactRecord, "source_map_upload_url", "registration artifact");
    const sourceMapUploadUrl = sourceMapUploadUrlValue === null
      ? null
      : validatePresignedUploadUrl(sourceMapUploadUrlValue, "registration artifact source-map URL");
    if ((artifact.sourceMapRelativePath === null) !== (sourceMapUploadUrl === null)) {
      throw new SourceMapUploadProtocolError("registration", `artifact ${debugId} has an inconsistent source-map upload URL`);
    }
    const alreadyFinalized = readResponseBoolean(artifactRecord, "already_finalized", "registration artifact");
    registeredArtifacts.push({ debugId, codeFile, sourceMapFile, bundleUploadUrl, sourceMapUploadUrl, alreadyFinalized, artifact });
  }
  if (seenDebugIds.size !== artifactsByDebugId.size) {
    throw new SourceMapUploadProtocolError("registration", `expected ${artifactsByDebugId.size} artifacts but received ${seenDebugIds.size}`);
  }
  return { manifestSha256, finalizePath, artifacts: registeredArtifacts };
}

function parseFinalizeResponse(value: unknown, plan: SourceMapUploadPlan): FinalizeResponse {
  const record = readResponseRecord(value, "finalize");
  const manifestSha256 = readResponseString(record, "manifest_sha256", "finalize");
  if (manifestSha256 !== plan.manifestSha256) {
    throw new SourceMapUploadProtocolError("finalize", `manifest digest ${manifestSha256} did not match ${plan.manifestSha256}`);
  }
  const status = readResponseString(record, "status", "finalize");
  if (status !== "finalized" && status !== "already_finalized") {
    throw new SourceMapUploadProtocolError("finalize", `unknown status ${JSON.stringify(status)}`);
  }
  const expectedDebugIds = new Set(plan.manifest.artifacts.map((artifact) => artifact.debugId));
  const uploaded = validateFinalizeDebugIds(record.uploaded, expectedDebugIds, "uploaded");
  const alreadyUploaded = validateFinalizeDebugIds(record.already_uploaded, expectedDebugIds, "already_uploaded");
  const catalogStatus = readResponseString(record, "catalog_status", "finalize");
  if (catalogStatus !== "published" && catalogStatus !== "already_published" && catalogStatus !== "unversioned") {
    throw new SourceMapUploadProtocolError("finalize", `unknown catalog status ${JSON.stringify(catalogStatus)}`);
  }
  const overlap = uploaded.filter((debugId) => alreadyUploaded.includes(debugId));
  if (overlap.length > 0) {
    throw new SourceMapUploadProtocolError("finalize", `debug IDs appeared in both uploaded and already_uploaded: ${overlap.join(", ")}`);
  }
  if (new Set([...uploaded, ...alreadyUploaded]).size !== expectedDebugIds.size) {
    throw new SourceMapUploadProtocolError("finalize", `expected a result for all ${expectedDebugIds.size} artifacts`);
  }
  return { uploaded, alreadyUploaded, catalogStatus };
}

function validateFinalizeDebugIds(value: unknown, expected: ReadonlySet<string>, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SourceMapUploadProtocolError("finalize", `${field} must be an array of strings`);
  }
  const ids = value.filter((entry): entry is string => typeof entry === "string");
  if (new Set(ids).size !== ids.length) {
    throw new SourceMapUploadProtocolError("finalize", `${field} contains duplicate debug IDs`);
  }
  for (const debugId of ids) {
    if (!expected.has(debugId)) {
      throw new SourceMapUploadProtocolError("finalize", `${field} contains unknown debug ID ${debugId}`);
    }
  }
  return ids;
}

function validatePresignedUploadUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SourceMapUploadProtocolError("registration", `${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SourceMapUploadProtocolError("registration", `${label} must use http or https`);
  }
  return value;
}

function readResponseRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SourceMapUploadProtocolError(operation, "the response must be an object");
  }
  return value;
}

function readResponseString(record: Record<string, unknown>, key: string, operation: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new SourceMapUploadProtocolError(operation, `${key} must be a non-empty string`);
  return value;
}

function readResponseNullableString(record: Record<string, unknown>, key: string, operation: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value === "") throw new SourceMapUploadProtocolError(operation, `${key} must be a non-empty string or null`);
  return value;
}

function readResponseBoolean(record: Record<string, unknown>, key: string, operation: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new SourceMapUploadProtocolError(operation, `${key} must be a boolean`);
  return value;
}


function resolveScanDirs(dirs: readonly string[], cwd: string): string[] {
  if (dirs.length === 0) {
    throw new CliError("Pass at least one build output directory, e.g. `hexclave sourcemaps upload .next`.");
  }
  return dirs.map((dir) => {
    const resolved = path.resolve(cwd, dir);
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      throw new CliError(`Build output directory not found: ${resolved}`);
    }
    return resolved;
  });
}

export type PreparationResult = {
  artifacts: PreparedSourceMapArtifact[],
  warnings: string[],
  /** Server chunks with no map, split out so the Next.js-specific hint can be printed. */
  serverBundlesWithoutMaps: string[],
  /**
   * Non-server bundles with no map. Tracked so `--strict` (documented to fail on
   * "missing source maps") actually catches an unsymbolicatable client build,
   * rather than silently skipping every mapless client chunk.
   */
  clientBundlesWithoutMaps: string[],
};

/**
 * Reads every candidate, derives its debug id, injects the snippet, and
 * prepares the map. Writes the injected bundles back to disk unless `dryRun`.
 *
 * Exported for tests: this is everything the command does before the network.
 */
export function prepareArtifacts(candidates: readonly SourceMapArtifactCandidate[], options: { repoRoot: string, dryRun: boolean }): PreparationResult {
  const artifacts: PreparedSourceMapArtifact[] = [];
  const warnings: string[] = [];
  const serverBundlesWithoutMaps: string[] = [];
  const clientBundlesWithoutMaps: string[] = [];
  const stagedWrites: Array<{ path: string, contents: string }> = [];
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.bundlePath, candidate])).values()]
    .sort((left, right) => compareStrings(left.bundlePath, right.bundlePath));

  for (const candidate of uniqueCandidates) {
    const relativePath = path.relative(candidate.scanDir, candidate.bundlePath);
    let source: string;
    try {
      source = fs.readFileSync(candidate.bundlePath, "utf-8");
    } catch (error) {
      throw new CliError(`Could not read bundle ${candidate.bundlePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let mapText: string;
    let mapDir: string;
    if (candidate.sourceMapPath !== null) {
      let realMapPath: string;
      try {
        realMapPath = fs.realpathSync(candidate.sourceMapPath);
        const realScanDir = fs.realpathSync(candidate.scanDir);
        if (!isInside(realMapPath, realScanDir)) {
          throw new CliError(`Source map ${candidate.sourceMapPath} is outside the scanned build directory.`);
        }
        const mapFd = fs.openSync(realMapPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          mapText = fs.readFileSync(mapFd, "utf-8");
        } finally {
          fs.closeSync(mapFd);
        }
      } catch (error) {
        throw new CliError(`Could not read source map ${candidate.sourceMapPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      mapDir = path.dirname(realMapPath);
    } else {
      const inline = readInlineSourceMap(source);
      if (inline === null) {
        if (candidate.isServerBundle) serverBundlesWithoutMaps.push(relativePath);
        else clientBundlesWithoutMaps.push(relativePath);
        continue;
      }
      mapText = inline;
      mapDir = path.dirname(candidate.bundlePath);
    }

    const debugId = deriveBundleDebugId(source, mapText);

    let parsedMap: unknown;
    try {
      parsedMap = JSON.parse(mapText);
    } catch (error) {
      throw new CliError(`Source map for ${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    const prepared = prepareSourceMapForUpload(parsedMap, debugId, { sourceMapDir: mapDir, repoRoot: options.repoRoot });
    const preparedBytes = Buffer.from(prepared, "utf-8");
    const sourceMapRelativePath = candidate.sourceMapPath === null
      ? null
      : normalizeArtifactRelativePath(path.relative(candidate.scanDir, candidate.sourceMapPath), "Source map file");

    const injected = appendDebugIdSnippet(source, debugId);
    const uploadedBundleBytes = Buffer.from(injected, "utf-8");
    if (!options.dryRun && injected !== source) stagedWrites.push({ path: candidate.bundlePath, contents: injected });

    artifacts.push({
      debugId,
      bundlePath: candidate.bundlePath,
      bundleRelativePath: relativePath,
      sourceMapPath: candidate.sourceMapPath,
      sourceMapRelativePath,
      bundleSha256: sha256Hex(uploadedBundleBytes),
      bundleBytes: uploadedBundleBytes.length,
      sourceMapSha256: sha256Hex(preparedBytes),
      sourceMapGzipped: gzipSync(preparedBytes),
      sourceMapBytes: preparedBytes.length,
    });
  }

  const byDebugId = new Map<string, PreparedSourceMapArtifact>();
  for (const artifact of artifacts) {
    const existing = byDebugId.get(artifact.debugId);
    if (existing !== undefined && (existing.bundlePath !== artifact.bundlePath || existing.sourceMapSha256 !== artifact.sourceMapSha256)) {
      throw new CliError(
        `Duplicate debug ID ${artifact.debugId} refers to conflicting bundles ${JSON.stringify(existing.bundleRelativePath)} and ${JSON.stringify(artifact.bundleRelativePath)}. `
        + "Clean the build output and ensure each emitted bundle receives a unique debug ID.",
      );
    }
    byDebugId.set(artifact.debugId, artifact);
  }

  for (const write of stagedWrites) fs.writeFileSync(write.path, write.contents, "utf-8");

  return { artifacts, warnings, serverBundlesWithoutMaps, clientBundlesWithoutMaps };
}

export function registerSourceMapsCommand(program: Command) {
  const sourceMaps = program
    .command("sourcemaps")
    .description("Upload source maps so Hexclave can symbolicate the stack traces of captured errors.");

  sourceMaps
    .command("upload <dir...>")
    .description("Inject debug IDs into the bundles under <dir...> and upload their source maps. Scan both your browser assets and your server build (e.g. `hexclave sourcemaps upload .next/static .next/server`).")
    .option("--release <release>", "Release identifier to associate with the uploaded artifacts")
    .option("--dist <dist>", "Distribution/build identifier within the release (requires --release)")
    .option("--environment <environment>", "Environment this build is deployed to")
    .option("--delete-maps", "Delete the .map files from the build output after a successful upload, so they are never served to browsers")
    .option("--dry-run", "Prepare everything locally and print what would be uploaded, without writing to the build output or contacting the API")
    .option("--strict", "Exit with a non-zero code on warnings (missing source maps, unconfigured object storage)")
    .option("--cloud-project-id <id>", "Hexclave project ID to upload to (defaults to the HEXCLAVE_PROJECT_ID env var)")
    .addHelpText("after", "\nAuthentication: uses HEXCLAVE_SECRET_SERVER_KEY if set (recommended for CI), otherwise your `hexclave login` session.")
    .action(async (dirs: string[], opts: SourceMapsUploadOptions) => {
      const dryRun = opts.dryRun === true;
      const strict = opts.strict === true;
      const release = normalizeOptionalMetadata(opts.release, "--release");
      const dist = normalizeOptionalMetadata(opts.dist, "--dist");
      const environment = normalizeOptionalMetadata(opts.environment, "--environment");
      if (dist !== null && release === null) {
        throw new CliError("Distribution is only meaningful with a release. Supply --release together with --dist.");
      }
      const scanDirs = resolveScanDirs(dirs, process.cwd());

      // Subresource integrity is computed by the bundler over the bytes it
      // emitted. Appending anything invalidates those hashes and the browser
      // refuses to execute the chunk, so this is a hard stop rather than a
      // warning — a "successful" upload that bricks production is worse than a
      // failed CI step.
      const integrityManifests = findIntegrityManifests([...scanDirs, ...findNextBuildRoots(scanDirs)]);
      if (integrityManifests.length > 0) {
        throw new CliError(
          `This build uses subresource integrity (found \`integrity\` hashes in ${integrityManifests.length} manifest(s), e.g. ${path.relative(process.cwd(), integrityManifests[0])}).\n`
          + "Injecting debug IDs rewrites the bundle files, which invalidates those hashes and would make the browser refuse to execute them.\n"
          + "Disable SRI for this build, or generate the manifests after running this command.",
        );
      }

      const candidates = collectArtifacts(scanDirs);
      if (candidates.length === 0) {
        throw new CliError(`No .js/.mjs/.cjs files found under ${scanDirs.join(", ")}. Did you run your build first?`);
      }

      // A build with no source maps at all is a true no-op: `prepareArtifacts`
      // rewrites nothing (mapless bundles are skipped), and there is nothing to
      // upload. Such a run must not authenticate or refresh a session just to
      // print "Nothing to upload". Only when there IS a map do we resolve
      // credentials — and we do so BEFORE `prepareArtifacts` rewrites any
      // bundle, so a failed auth still leaves the build untouched. The
      // short-lived header is fetched per API request below.
      const hasAnySourceMap = candidates.some((candidate) => candidate.sourceMapPath !== null || candidate.hasInlineSourceMap);
      const auth = dryRun || !hasAnySourceMap ? null : resolveAuth(resolveProjectId(opts.cloudProjectId));
      const getAuthHeaders = auth === null ? null : await createSourceMapAuthHeadersFactory(auth);
      const { artifacts, warnings, serverBundlesWithoutMaps, clientBundlesWithoutMaps } = prepareArtifacts(candidates, { repoRoot: process.cwd(), dryRun });

      if (serverBundlesWithoutMaps.length > 0) {
        // Next.js does not emit server source maps unless this is enabled, so
        // saying "no maps found" would send the user hunting for a bug that
        // isn't there. Print the exact line instead.
        warnings.push(
          `${serverBundlesWithoutMaps.length} server chunk(s) have no source map (e.g. ${serverBundlesWithoutMaps[0]}). `
          + `Next.js does not emit them unless you add \`${NEXT_SERVER_SOURCE_MAPS_CONFIG_HINT}\` to your next.config.js; without it, server-side stack traces stay minified.`,
        );
      }
      if (clientBundlesWithoutMaps.length > 0) {
        warnings.push(
          `${clientBundlesWithoutMaps.length} bundle(s) have no source map (e.g. ${clientBundlesWithoutMaps[0]}) and will not be symbolicated. `
          + "Configure your bundler to emit source maps for these files (or scan only the directories that contain them).",
        );
      }
      if (artifacts.length === 0) {
        warnings.push(`No source maps found under ${scanDirs.join(", ")}. Nothing to upload.`);
      }
      for (const warning of warnings) console.error(`Warning: ${warning}`);

      const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sourceMapBytes, 0);
      const totalGzippedBytes = artifacts.reduce((sum, artifact) => sum + artifact.sourceMapGzipped.length, 0);
      console.error(`Prepared ${artifacts.length} source map(s) (${(totalBytes / 1024).toFixed(1)} KiB, ${(totalGzippedBytes / 1024).toFixed(1)} KiB compressed).`);

      if (!dryRun && artifacts.length > 0) {
        if (auth == null || getAuthHeaders == null) {
          throw new CliError("Source-map upload credentials were not resolved.");
        }
        const uploadRequest = createSourceMapUploadRequest({
          auth,
          getAuthHeaders,
          release,
          dist,
          environment,
          artifacts,
        });
        const result = await uploadPreparedSourceMaps(uploadRequest);
        if (opts.deleteMaps === true) {
          const deleted = new Set<string>();
          for (const artifact of artifacts) {
            if (artifact.sourceMapPath === null || deleted.has(artifact.sourceMapPath)) continue;
            fs.unlinkSync(artifact.sourceMapPath);
            deleted.add(artifact.sourceMapPath);
          }
        }
        console.log(JSON.stringify({
          dryRun: false,
          release,
          dist,
          environment,
          manifestSha256: uploadRequest.plan.manifestSha256,
          uploaded: result.uploaded,
          alreadyUploaded: result.alreadyUploaded,
          catalogStatus: result.catalogStatus,
        }, null, 2));
      } else {
        const projectId = auth === null ? resolveOptionalProjectId(opts.cloudProjectId) : auth.projectId;
        const manifest = createSourceMapManifest(artifacts, release, environment, {
          projectId,
          dist,
        });
        console.log(JSON.stringify({
          dryRun,
          release: manifest.release,
          dist: manifest.dist,
          environment: manifest.environment,
          manifest,
          artifacts: manifest.artifacts,
        }, null, 2));
      }
      if (strict && warnings.length > 0) process.exitCode = 1;
    });
}
