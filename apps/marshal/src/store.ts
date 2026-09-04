import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand, type ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getConfig, MAX_UPLOAD_BYTES, MULTIPART_UPLOAD_THRESHOLD_BYTES, UPLOAD_EXPIRY_SECONDS, UPLOAD_PART_SIZE_BYTES } from "./config.js";
import { authenticateControlPlaneState, decryptString, encryptString, verifyControlPlaneStateAuthentication } from "./spec-crypto.js";
import { POOL_PROJECT_STATES, type DomainClaim, type EnvValue, type PendingDomainClaim, type PoolProjectEntry, type PoolProjectState, type ReconciliationLease, type ServiceSpec, type StoredDeployment, type StoredSpec, type TenantProjectAssignment } from "./types.js";

// The bucket is Marshal's only state. Layout:
//   specs/<ns>/<key>.json                 — current desired spec + revision; env is AES-GCM encrypted
//   reconciliation-leases/<ns>/<key>.json — renewable per-service provider mutation lease
//   uploads/<ns>/<id>.tar.gz              — source tarballs (presigned PUT slots; lifecycle-expired)
//   uploads/.validated/<ns>/<build>.tar.gz — immutable validated copies consumed by builders
//   builds/<ns>/<key>/rec/<ulid>.json     — build records (ULID ids → lexicographic ≈ chronological)
//   builds/<ns>/<key>/log/<ulid>.jsonl    — durable build logs (LogLine per line), written at terminal state
//   domains/<hostname>.json               — GLOBAL hostname-uniqueness registry (conditional-PUT claims)
//   domain-index/<ns>/<key>/<hostname>    — per-service index of claims, so deletes can release hostnames
//   tenants/<ns>.json                     — namespace → tenant GCP project assignment (conditional-PUT, once)
//   gcp-project-pool/<projectId>.json     — pre-provisioned tenant projects awaiting assignment

let cachedClient: S3Client | null = null;

function s3(): S3Client {
  if (cachedClient) return cachedClient;
  const { s3: config } = getConfig();
  cachedClient = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return cachedClient;
}

function bucket(): string {
  return getConfig().s3.bucket;
}

function isNoSuchKey(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : null;
  const metadata = "$metadata" in error && typeof error.$metadata === "object" && error.$metadata !== null ? error.$metadata : null;
  const status = metadata !== null && "httpStatusCode" in metadata ? metadata.httpStatusCode : null;
  return name === "PreconditionFailed" || status === 412;
}

// The AWS SDK retries failed requests but NOT responses that die mid-flight (ECONNRESET /
// "aborted" on a reused keep-alive socket — s3mock does this under concurrent load, and
// R2 can too). Every op in this module is idempotent, so one blind retry is safe; the
// conditional-write path is excluded because a 412 must surface, and precondition
// failures are not socket errors anyway.
async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "";
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || message === "aborted") {
      return await fn();
    }
    throw error;
  }
}

async function getJson<T>(key: string): Promise<T | null> {
  try {
    return await withTransientRetry(async () => {
      const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      const body = await result.Body?.transformToString();
      if (body === undefined) return null;
      return JSON.parse(body) as T;
    });
  } catch (error) {
    if (isNoSuchKey(error)) return null;
    throw error;
  }
}

async function putJson(key: string, value: unknown): Promise<void> {
  await withTransientRetry(async () => await s3().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
  })));
}

export type Versioned<T> = { value: T, etag: string };

async function getJsonVersioned<T>(key: string): Promise<Versioned<T> | null> {
  try {
    return await withTransientRetry(async () => {
      const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      const body = await result.Body?.transformToString();
      if (body === undefined) return null;
      if (result.ETag === undefined) throw new Error(`S3 omitted ETag for ${key}; conditional updates cannot be made safely`);
      return { value: JSON.parse(body) as T, etag: result.ETag };
    });
  } catch (error) {
    if (isNoSuchKey(error)) return null;
    throw error;
  }
}

type WriteCondition = { ifMatch: string } | { ifNoneMatch: true };

async function putJsonConditionally(key: string, value: unknown, condition: WriteCondition): Promise<string | null> {
  try {
    const result = await s3().send(new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: JSON.stringify(value),
      ContentType: "application/json",
      ...("ifMatch" in condition ? { IfMatch: condition.ifMatch } : { IfNoneMatch: "*" }),
    }));
    if (result.ETag === undefined) throw new Error(`S3 omitted ETag for conditional write to ${key}`);
    return result.ETag;
  } catch (error) {
    if (isPreconditionFailed(error)) return null;
    throw error;
  }
}

type AuthenticatedControlPlaneState = {
  authentication_version: 1,
  value: unknown,
  mac_base64: string,
};

function authenticatedControlPlaneState(key: string, value: unknown): AuthenticatedControlPlaneState {
  // TODO(security): bind a monotonically increasing generation to an authority outside this
  // bucket. The MAC prevents forgery and moving values between keys, but an attacker who can
  // overwrite objects can still replay an older, validly authenticated version of a value.
  const serialized = JSON.stringify(value);
  return {
    authentication_version: 1,
    value,
    mac_base64: authenticateControlPlaneState(serialized, key, getConfig().dataEncryptionRootKey),
  };
}

function readAuthenticatedControlPlaneState(key: string, stored: unknown): unknown {
  if (!isRecord(stored)
    || stored.authentication_version !== 1
    || !("value" in stored)
    || typeof stored.mac_base64 !== "string") {
    // TODO(operations): provide an offline migration command that authenticates a trusted
    // snapshot before rollout. Doing this automatically at runtime would turn attacker-written
    // unsigned state into authoritative state, so this path must continue to fail closed.
    // Deliberately no legacy fallback: accepting an unsigned object once and signing it would
    // authenticate an attacker's forged claim or project assignment after a bucket compromise.
    throw new Error(`authoritative state ${JSON.stringify(key)} is unsigned; migrate it before starting this Marshal version`);
  }
  const serialized = JSON.stringify(stored.value);
  if (!verifyControlPlaneStateAuthentication(serialized, key, stored.mac_base64, getConfig().dataEncryptionRootKey)) {
    throw new Error(`authoritative state ${JSON.stringify(key)} failed authentication`);
  }
  return stored.value;
}

async function deleteObject(key: string): Promise<void> {
  await withTransientRetry(async () => await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })));
}

async function deleteObjectConditionally(key: string, etag: string): Promise<boolean> {
  // TODO(reliability): represent an interrupted conditional delete as outcome-unknown instead
  // of blindly retrying it. A retry can observe a replacement object's ETag after the original
  // request succeeded, making it impossible for this layer to distinguish the two outcomes.
  try {
    await withTransientRetry(async () => await s3().send(new DeleteObjectCommand({
      Bucket: bucket(),
      Key: key,
      IfMatch: etag,
    })));
    return true;
  } catch (error) {
    if (isPreconditionFailed(error)) return false;
    // The object is already gone — someone else's delete won. That is the same
    // outcome as a precondition failure (this caller did not perform the
    // delete), and must not escape as an internal error. Stores differ here:
    // an IfMatch delete of a missing key is a 404 on some, a 412 on others.
    if (isNoSuchKey(error)) return false;
    throw error;
  }
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined = undefined;
  do {
    const result: ListObjectsV2CommandOutput = await withTransientRetry(async () => await s3().send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    })));
    for (const item of result.Contents ?? []) {
      if (item.Key !== undefined) keys.push(item.Key);
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken !== undefined);
  return keys;
}

// ---------------------------------------------------------------------------
// Specs

type StoredSpecOnDisk = Omit<StoredSpec, "spec"> & {
  spec: Omit<ServiceSpec, "env"> & { encrypted_env: unknown },
};
type PersistedStoredSpec = StoredSpecOnDisk | StoredSpec;

function specKey(ns: string, key: string): string {
  return `specs/${ns}/${key}.json`;
}

function specEncryptionContext(ns: string, key: string, stored: Omit<StoredSpecOnDisk, "spec"> & { spec: Omit<ServiceSpec, "env"> }): string {
  // The requested object path is authoritative: deriving this from the untrusted body would
  // let a bucket writer move a complete object without invalidating its authentication tag.
  // Authenticate the remaining plaintext too, so config/source/revision tampering is detected
  // even though only the secret-bearing environment needs confidentiality.
  return JSON.stringify({ object_key: specKey(ns, key), stored });
}

function storedSpecForDisk(spec: StoredSpec): StoredSpecOnDisk {
  const { env, ...specWithoutEnv } = spec.spec;
  const authenticated = { ...spec, spec: specWithoutEnv };
  return {
    ...authenticated,
    spec: {
      ...specWithoutEnv,
      encrypted_env: encryptString(
        JSON.stringify(env),
        specEncryptionContext(spec.ns, spec.key, authenticated),
        getConfig().dataEncryptionRootKey,
      ),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredEnv(serialized: string): Record<string, EnvValue> {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) throw new Error("decrypted stored service environment is not an object");
  const env = new Map<string, EnvValue>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) throw new Error(`decrypted stored environment entry ${JSON.stringify(key)} is not an object`);
    const fields = Object.keys(value);
    if (fields.length === 1 && fields[0] === "value" && typeof value.value === "string") {
      env.set(key, { value: value.value });
    } else if (fields.length === 1 && fields[0] === "ref" && typeof value.ref === "string") {
      env.set(key, { ref: value.ref });
    } else {
      throw new Error(`decrypted stored environment entry ${JSON.stringify(key)} is not { value } or { ref }`);
    }
  }
  return Object.fromEntries(env);
}

function isLegacyStoredSpec(stored: PersistedStoredSpec): stored is StoredSpec {
  // TODO(security): delete this format discriminator after the one-time plaintext-spec
  // migration is complete. Until then a bucket writer can forge the legacy shape and bypass
  // the AEAD integrity check; compatibility is retained only for pre-encryption records.
  return "env" in stored.spec;
}

function storedSpecFromDisk(stored: PersistedStoredSpec, expectedNs: string, expectedKey: string): StoredSpec {
  if (stored.ns !== expectedNs || stored.key !== expectedKey) {
    throw new Error(`stored service identity does not match requested object ${expectedNs}/${expectedKey}`);
  }
  if (isLegacyStoredSpec(stored)) return stored;
  const { encrypted_env: encryptedEnv, ...specWithoutEnv } = stored.spec;
  const authenticated = { ...stored, spec: specWithoutEnv };
  return {
    ...stored,
    spec: {
      ...specWithoutEnv,
      env: parseStoredEnv(decryptString(
        encryptedEnv,
        specEncryptionContext(expectedNs, expectedKey, authenticated),
        getConfig().dataEncryptionRootKey,
      )),
    },
  };
}

export async function readSpec(ns: string, key: string): Promise<StoredSpec | null> {
  return (await readSpecVersioned(ns, key))?.value ?? null;
}

export async function readSpecVersioned(ns: string, key: string): Promise<Versioned<StoredSpec> | null> {
  for (;;) {
    const stored = await getJsonVersioned<PersistedStoredSpec>(specKey(ns, key));
    if (stored === null) return null;
    const value = storedSpecFromDisk(stored.value, ns, key);
    if (!isLegacyStoredSpec(stored.value)) return { value, etag: stored.etag };

    // Draft/QA buckets may contain specs written before application-layer encryption was
    // introduced. Upgrade them atomically on first access so rolling out this fix does not
    // require clearing services, while a concurrent PUT remains the desired-state winner.
    const encryptedEtag = await writeSpec(value, { ifMatch: stored.etag });
    if (encryptedEtag !== null) return { value, etag: encryptedEtag };
  }
}

export async function writeSpec(spec: StoredSpec, condition: WriteCondition): Promise<string | null> {
  return await putJsonConditionally(specKey(spec.ns, spec.key), storedSpecForDisk(spec), condition);
}

export async function deleteSpec(ns: string, key: string): Promise<void> {
  await deleteObject(specKey(ns, key));
}

export async function deleteSpecConditionally(ns: string, key: string, etag: string): Promise<boolean> {
  return await deleteObjectConditionally(specKey(ns, key), etag);
}

export async function listSpecKeys(ns: string): Promise<string[]> {
  const keys = await listKeys(`specs/${ns}/`);
  return keys
    .filter((key) => key.endsWith(".json"))
    .map((key) => key.slice(`specs/${ns}/`.length, -".json".length));
}

// ---------------------------------------------------------------------------
// Per-service reconciliation leases

function reconciliationLeaseKey(ns: string, key: string): string {
  return `reconciliation-leases/${ns}/${key}.json`;
}

export async function readReconciliationLease(ns: string, key: string): Promise<Versioned<ReconciliationLease> | null> {
  return await getJsonVersioned<ReconciliationLease>(reconciliationLeaseKey(ns, key));
}

export async function createReconciliationLease(ns: string, key: string, lease: ReconciliationLease): Promise<string | null> {
  return await putJsonConditionally(reconciliationLeaseKey(ns, key), lease, { ifNoneMatch: true });
}

export async function replaceReconciliationLease(ns: string, key: string, lease: ReconciliationLease, previousEtag: string): Promise<string | null> {
  return await putJsonConditionally(reconciliationLeaseKey(ns, key), lease, { ifMatch: previousEtag });
}

export async function releaseReconciliationLease(ns: string, key: string, etag: string): Promise<boolean> {
  return await deleteObjectConditionally(reconciliationLeaseKey(ns, key), etag);
}

// ---------------------------------------------------------------------------
// Uploads

export async function createUploadSlot(ns: string, id: string): Promise<{ uploadUrl: string, expiresAtMillis: number }> {
  // TODO(security): bind a signed Content-Length to direct and multipart uploads, or replace
  // presigned writes with a streaming size-enforcing endpoint. The consume-time gate prevents
  // oversized builds, but an authenticated tenant can still create temporary storage and
  // ingress cost before bucket lifecycle cleanup removes an oversized object.
  const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({
    Bucket: bucket(),
    Key: uploadObjectKey(ns, id),
    ContentType: "application/gzip",
  }), { expiresIn: UPLOAD_EXPIRY_SECONDS });
  return { uploadUrl, expiresAtMillis: Date.now() + UPLOAD_EXPIRY_SECONDS * 1000 };
}

export function uploadObjectKey(ns: string, id: string): string {
  return `uploads/${ns}/${id}.tar.gz`;
}

/**
 * The multipart half of an upload slot: everything the client needs to send the
 * source in parts and assemble it, as presigned URLs.
 *
 * WHY THE CLIENT DRIVES THE WHOLE LIFECYCLE. `CreateMultipartUpload` is the only
 * step that has to run here — it is what mints the upload id. Uploading a part,
 * completing and aborting are all ordinary S3 operations that SigV4 can presign
 * (verified against R2), so handing the client signed URLs for them keeps this
 * to one Marshal route and no new backend route: the alternative was a
 * create/complete/abort endpoint on both services relaying calls this client can
 * make for itself.
 */
export type MultipartUploadSlot = {
  uploadId: string,
  partSizeBytes: number,
  /** One presigned PUT per part, in part-number order (1-based on the wire). */
  partUrls: string[],
  /** POST the `<CompleteMultipartUpload>` part list here, as application/xml. */
  completeUrl: string,
  /** DELETE here to discard the parts when the upload is abandoned. */
  abortUrl: string,
};

/**
 * Whether a source of `sizeBytes` should be uploaded in parts, and how many.
 * Null when a single PUT is the better trade — see MULTIPART_UPLOAD_THRESHOLD_BYTES.
 *
 * An unknown or over-limit size gets no multipart slot: the size gate at consume
 * time is what rejects an oversize source, and starting a multipart upload for
 * one would just leave parts to be cleaned up.
 */
export function multipartPartCount(sizeBytes: number | undefined): number | null {
  if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes)) return null;
  if (sizeBytes <= MULTIPART_UPLOAD_THRESHOLD_BYTES || sizeBytes > MAX_UPLOAD_BYTES) return null;
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

/**
 * Starts a multipart upload against the slot's key and presigns every step of it.
 *
 * Costs one round trip to the store and leaves state there, so it is only called
 * when the source is actually big enough to want it: an upload started and never
 * completed holds its parts until the bucket's AbortIncompleteMultipartUpload
 * lifecycle rule sweeps them, and those parts are billed in the meantime.
 */
export async function createMultipartUploadSlot(ns: string, id: string, partCount: number): Promise<MultipartUploadSlot> {
  const Bucket = bucket();
  const Key = uploadObjectKey(ns, id);
  const created = await withTransientRetry(async () => await s3().send(new CreateMultipartUploadCommand({
    Bucket,
    Key,
    ContentType: "application/gzip",
  })));
  const UploadId = created.UploadId;
  if (UploadId === undefined) throw new Error("the object store started a multipart upload without returning an id");
  // Presigning is local HMAC work, not a request — the whole set costs nothing.
  const partUrls = await Promise.all(Array.from({ length: partCount }, async (_unused, index) =>
    await getSignedUrl(s3(), new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: index + 1 }), { expiresIn: UPLOAD_EXPIRY_SECONDS })));
  return {
    uploadId: UploadId,
    partSizeBytes: UPLOAD_PART_SIZE_BYTES,
    partUrls,
    completeUrl: await getSignedUrl(s3(), new CompleteMultipartUploadCommand({ Bucket, Key, UploadId }), { expiresIn: UPLOAD_EXPIRY_SECONDS }),
    abortUrl: await getSignedUrl(s3(), new AbortMultipartUploadCommand({ Bucket, Key, UploadId }), { expiresIn: UPLOAD_EXPIRY_SECONDS }),
  };
}

// max_bytes on upload slots is advisory — R2 does not enforce presigned constraints
// (smoke-verified), so the size gate is here, at consume time.
export async function statUpload(ns: string, id: string): Promise<{ sizeBytes: number, etag: string } | null> {
  try {
    const result = await withTransientRetry(async () => await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: uploadObjectKey(ns, id) })));
    if (result.ETag === undefined) throw new Error(`S3 omitted ETag for upload ${uploadObjectKey(ns, id)}; a validated read cannot be fenced`);
    return { sizeBytes: result.ContentLength ?? 0, etag: result.ETag };
  } catch (error) {
    if (isNoSuchKey(error)) return null;
    throw error;
  }
}

export async function readUpload(ns: string, id: string, expectedEtag: string, maxBytes: number): Promise<Uint8Array | null> {
  try {
    return await withTransientRetry(async () => {
      const result = await s3().send(new GetObjectCommand({
        Bucket: bucket(),
        Key: uploadObjectKey(ns, id),
        IfMatch: expectedEtag,
      }));
      if (result.Body === undefined) return null;
      if (result.ContentLength !== undefined && result.ContentLength > maxBytes) return null;

      const reader = result.Body.transformToWebStream().getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    });
  } catch (error) {
    // A 412 means the still-valid presigned PUT replaced the object after HEAD. Treat it as
    // unavailable rather than reading unvalidated bytes from a different object version.
    if (isNoSuchKey(error) || isPreconditionFailed(error)) return null;
    throw error;
  }
}

export async function presignUploadGet(ns: string, id: string, expiresInSeconds: number): Promise<string> {
  return await getSignedUrl(s3(), new GetObjectCommand({
    Bucket: bucket(),
    Key: uploadObjectKey(ns, id),
  }), { expiresIn: expiresInSeconds });
}

function validatedUploadObjectKey(ns: string, buildId: string): string {
  return `uploads/.validated/${ns}/${buildId}.tar.gz`;
}

export async function writeValidatedUpload(ns: string, buildId: string, bytes: Uint8Array): Promise<void> {
  await withTransientRetry(async () => await s3().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: validatedUploadObjectKey(ns, buildId),
    Body: bytes,
    ContentType: "application/gzip",
  })));
}

export async function presignValidatedUploadGet(ns: string, buildId: string, expiresInSeconds: number): Promise<string> {
  return await getSignedUrl(s3(), new GetObjectCommand({
    Bucket: bucket(),
    Key: validatedUploadObjectKey(ns, buildId),
  }), { expiresIn: expiresInSeconds });
}

export async function deleteValidatedUpload(ns: string, buildId: string): Promise<void> {
  await deleteObject(validatedUploadObjectKey(ns, buildId));
}

export async function deleteUpload(ns: string, id: string): Promise<void> {
  await deleteObject(uploadObjectKey(ns, id));
}

export { MAX_UPLOAD_BYTES };

// ---------------------------------------------------------------------------
// Deployment records + build logs
//
// A deployment is the unit that builds: one uploaded tree, one builder machine,
// every service of a deployment source. Its record therefore holds both the
// build's state and what each target did with the image it produced.

function deploymentRecordKey(ns: string, id: string): string {
  return `deployments/${ns}/rec/${id}.json`;
}

function deploymentLogKey(ns: string, id: string): string {
  return `deployments/${ns}/log/${id}.jsonl`;
}

type StoredDeploymentOnDisk = Omit<StoredDeployment, "targets"> & {
  targets: Array<Omit<StoredDeployment["targets"][number], "spec"> & {
    spec: Omit<StoredDeployment["targets"][number]["spec"], "env">,
  }>,
  encrypted_target_env: unknown,
};
type PersistedStoredDeployment = StoredDeploymentOnDisk | StoredDeployment;

function deploymentEncryptionContext(ns: string, id: string, stored: Omit<StoredDeploymentOnDisk, "encrypted_target_env">): string {
  return JSON.stringify({ object_key: deploymentRecordKey(ns, id), stored });
}

function storedDeploymentForDisk(deployment: StoredDeployment): StoredDeploymentOnDisk {
  const targetEnvs = deployment.targets.map((target) => target.spec.env);
  const targets = deployment.targets.map((target) => {
    const { env: _env, ...spec } = target.spec;
    return { ...target, spec };
  });
  const authenticated = { ...deployment, targets };
  return {
    ...authenticated,
    encrypted_target_env: encryptString(
      JSON.stringify(targetEnvs),
      deploymentEncryptionContext(deployment.ns, deployment.id, authenticated),
      getConfig().dataEncryptionRootKey,
    ),
  };
}

function isLegacyStoredDeployment(stored: PersistedStoredDeployment): stored is StoredDeployment {
  return !("encrypted_target_env" in stored);
}

function storedDeploymentFromDisk(stored: PersistedStoredDeployment, expectedNs: string, expectedId: string): StoredDeployment {
  if (stored.ns !== expectedNs || stored.id !== expectedId) {
    throw new Error(`stored deployment identity does not match requested object ${expectedNs}/${expectedId}`);
  }
  if (isLegacyStoredDeployment(stored)) {
    // TODO(security): remove plaintext deployment reads after all pre-encryption records have
    // aged out or been migrated. Keeping this compatibility path temporarily means a bucket
    // writer can still attempt a legacy-format downgrade; new writes are always encrypted.
    return stored;
  }
  const { encrypted_target_env: encryptedTargetEnv, ...authenticated } = stored;
  const serialized = decryptString(
    encryptedTargetEnv,
    deploymentEncryptionContext(expectedNs, expectedId, authenticated),
    getConfig().dataEncryptionRootKey,
  );
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.length !== stored.targets.length) {
    throw new Error("decrypted stored deployment target environments do not match its targets");
  }
  const targets = stored.targets.map((target, index) => ({
    ...target,
    spec: { ...target.spec, env: parseStoredEnv(JSON.stringify(parsed[index])) },
  }));
  return { ...authenticated, targets };
}

export async function readDeployment(ns: string, id: string): Promise<StoredDeployment | null> {
  return (await readDeploymentVersioned(ns, id))?.value ?? null;
}

export async function readDeploymentVersioned(ns: string, id: string): Promise<Versioned<StoredDeployment> | null> {
  for (;;) {
    const stored = await getJsonVersioned<PersistedStoredDeployment>(deploymentRecordKey(ns, id));
    if (stored === null) return null;
    const value = storedDeploymentFromDisk(stored.value, ns, id);
    if (!isLegacyStoredDeployment(stored.value)) return { value, etag: stored.etag };

    // Upgrade plaintext historical records opportunistically. The conditional write keeps a
    // concurrent build completion or deployment advance authoritative.
    const encryptedEtag = await replaceDeployment(value, stored.etag);
    if (encryptedEtag !== null) return { value, etag: encryptedEtag };
  }
}

// No unconditional deployment write on purpose: every writer races the completion
// webhook, so they all go through createDeployment (ifNoneMatch) or
// replaceDeployment (ifMatch) and handle losing.
export async function createDeployment(deployment: StoredDeployment): Promise<string | null> {
  return await putJsonConditionally(deploymentRecordKey(deployment.ns, deployment.id), storedDeploymentForDisk(deployment), { ifNoneMatch: true });
}

export async function replaceDeployment(deployment: StoredDeployment, previousEtag: string): Promise<string | null> {
  return await putJsonConditionally(deploymentRecordKey(deployment.ns, deployment.id), storedDeploymentForDisk(deployment), { ifMatch: previousEtag });
}

export async function writeDeploymentLog(ns: string, id: string, jsonlBody: string): Promise<void> {
  await withTransientRetry(async () => await s3().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: deploymentLogKey(ns, id),
    Body: jsonlBody,
    ContentType: "application/jsonl",
  })));
}

export async function readDeploymentLog(ns: string, id: string): Promise<string | null> {
  try {
    return await withTransientRetry(async () => {
      const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: deploymentLogKey(ns, id) }));
      return (await result.Body?.transformToString()) ?? null;
    });
  } catch (error) {
    if (isNoSuchKey(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Domain registry

function domainClaimKey(hostname: string): string {
  return `domains/${hostname}.json`;
}

function domainIndexKey(ns: string, key: string, hostname: string): string {
  return `domain-index/${ns}/${key}/${hostname}`;
}

function pendingDomainClaimKey(ns: string, hostname: string): string {
  return `domain-pending/${ns}/${hostname}.json`;
}

function pendingDomainIndexKey(ns: string, key: string, hostname: string): string {
  return `domain-pending-index/${ns}/${key}/${hostname}`;
}

export async function readPendingDomainClaimVersioned(ns: string, hostname: string): Promise<Versioned<PendingDomainClaim> | null> {
  return await getJsonVersioned<PendingDomainClaim>(pendingDomainClaimKey(ns, hostname));
}

export async function createPendingDomainClaim(claim: PendingDomainClaim): Promise<string | null> {
  await putJson(pendingDomainIndexKey(claim.ns, claim.service_key, claim.hostname), {});
  return await putJsonConditionally(pendingDomainClaimKey(claim.ns, claim.hostname), claim, { ifNoneMatch: true });
}

export async function deletePendingDomainClaim(claim: Versioned<PendingDomainClaim>): Promise<boolean> {
  const deleted = await deleteObjectConditionally(pendingDomainClaimKey(claim.value.ns, claim.value.hostname), claim.etag);
  if (!deleted) return false;
  await deleteObject(pendingDomainIndexKey(claim.value.ns, claim.value.service_key, claim.value.hostname));
  return true;
}

export async function listPendingDomainClaimsForService(ns: string, key: string): Promise<string[]> {
  const prefix = `domain-pending-index/${ns}/${key}/`;
  return (await listKeys(prefix)).map((objectKey) => objectKey.slice(prefix.length));
}

export async function readDomainClaim(hostname: string): Promise<DomainClaim | null> {
  return (await readDomainClaimVersioned(hostname))?.value ?? null;
}

export async function readDomainClaimVersioned(hostname: string): Promise<Versioned<DomainClaim> | null> {
  const key = domainClaimKey(hostname);
  const stored = await getJsonVersioned<unknown>(key);
  if (stored === null) return null;
  const value = readAuthenticatedControlPlaneState(key, stored.value);
  if (!isRecord(value)
    || value.hostname !== hostname
    || typeof value.ns !== "string"
    || typeof value.service_key !== "string"
    || typeof value.claimed_at_millis !== "number"
    || !Number.isSafeInteger(value.claimed_at_millis)
    || value.claimed_at_millis < 0
    || (value.deleting_at_millis !== undefined
      && (typeof value.deleting_at_millis !== "number" || !Number.isSafeInteger(value.deleting_at_millis) || value.deleting_at_millis < 0))) {
    throw new Error(`authenticated domain claim for ${JSON.stringify(hostname)} is malformed`);
  }
  return {
    etag: stored.etag,
    value: {
      hostname,
      ns: value.ns,
      service_key: value.service_key,
      claimed_at_millis: value.claimed_at_millis,
      ...(value.deleting_at_millis === undefined ? {} : { deleting_at_millis: value.deleting_at_millis }),
    },
  };
}

// Atomic claim via conditional write (If-None-Match: "*" → 412 when the hostname is already
// claimed; verified against R2 in the smoke test). Returns false when someone else holds it.
export async function claimDomain(claim: DomainClaim): Promise<boolean> {
  // Write the per-service index entry FIRST: an orphaned index entry (claim never landed) is
  // harmless — deleteService re-validates ownership against the claim before releasing. The
  // reverse order risks the opposite: a crash between the claim PUT and the index PUT would
  // leave a claim that deleteService (which enumerates via the index) can never release,
  // pinning the hostname globally forever.
  await putJson(domainIndexKey(claim.ns, claim.service_key, claim.hostname), {});
  const key = domainClaimKey(claim.hostname);
  return await putJsonConditionally(key, authenticatedControlPlaneState(key, claim), { ifNoneMatch: true }) !== null;
}

// Overwrite is only valid for repoints within the same namespace. The ETag fence prevents a
// stale repoint from overwriting a newer owner that landed after the caller's read.
export async function rewriteDomainClaim(previous: Versioned<DomainClaim>, next: DomainClaim): Promise<boolean> {
  await putJson(domainIndexKey(next.ns, next.service_key, next.hostname), {});
  const key = domainClaimKey(next.hostname);
  const rewritten = await putJsonConditionally(key, authenticatedControlPlaneState(key, next), { ifMatch: previous.etag });
  if (rewritten === null) return false;
  await deleteObject(domainIndexKey(previous.value.ns, previous.value.service_key, previous.value.hostname));
  return true;
}

// Marks a claim as deleting without touching its index. The tombstone remains the global
// ownership authority while fallible provider cleanup runs, making retries recoverable.
export async function beginDomainClaimDeletion(previous: Versioned<DomainClaim>, deletingAtMillis: number): Promise<Versioned<DomainClaim> | null> {
  if (previous.value.deleting_at_millis !== undefined) return previous;
  const key = domainClaimKey(previous.value.hostname);
  const value = { ...previous.value, deleting_at_millis: deletingAtMillis };
  const etag = await putJsonConditionally(key, authenticatedControlPlaneState(key, value), { ifMatch: previous.etag });
  return etag === null ? null : { value, etag };
}

// Deleting by ETag is the ownership check and deletion in one S3 operation. A plain
// read-then-delete has a TOCTOU window where a concurrent repoint can replace the object and
// the stale delete then erases the new owner's claim.
export async function releaseDomainClaim(claim: Versioned<DomainClaim>): Promise<boolean> {
  const released = await deleteObjectConditionally(domainClaimKey(claim.value.hostname), claim.etag);
  if (!released) return false;
  await deleteObject(domainIndexKey(claim.value.ns, claim.value.service_key, claim.value.hostname));
  return true;
}

export async function listDomainClaimsForService(ns: string, key: string): Promise<string[]> {
  const prefix = `domain-index/${ns}/${key}/`;
  return (await listKeys(prefix)).map((objectKey) => objectKey.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Tenant project assignment and pre-provisioned project pool
//
// The pool exists because Google's multi-tenant guidance recommends assigning
// pre-created projects to tenants on demand: creating a project, attaching
// billing (a brand-new project is briefly unknown to Cloud Billing, which the
// provisioner retries for up to ten minutes), and batch-enabling its APIs can
// take fifteen minutes — far past every request budget in the deploy path.

const TENANT_PROJECT_ASSIGNMENT_PREFIX = "tenants/";

function tenantProjectAssignmentKey(ns: string): string {
  return `${TENANT_PROJECT_ASSIGNMENT_PREFIX}${ns}.json`;
}

export async function readTenantProjectAssignment(ns: string): Promise<string | null> {
  const key = tenantProjectAssignmentKey(ns);
  const stored = await getJson<unknown>(key);
  if (stored === null) return null;
  const value = readAuthenticatedControlPlaneState(key, stored);
  if (!isRecord(value) || typeof value.project_id !== "string") throw new Error(`authenticated tenant project assignment for ${JSON.stringify(ns)} is malformed`);
  return value.project_id;
}

// Returns the authoritative assignment no matter who won the race: the caller's
// projectId when the create succeeded, or the pre-existing winner's otherwise. The
// retry loop covers the create losing while a concurrent delete removed the winner —
// only possible around namespace teardown, which does not exist yet.
export async function assignTenantProject(ns: string, projectId: string): Promise<string> {
  for (;;) {
    const key = tenantProjectAssignmentKey(ns);
    const assignment = { project_id: projectId } satisfies TenantProjectAssignment;
    const created = await putJsonConditionally(key, authenticatedControlPlaneState(key, assignment), { ifNoneMatch: true });
    if (created !== null) return projectId;
    const existing = await readTenantProjectAssignment(ns);
    if (existing !== null) return existing;
  }
}

function poolProjectKey(projectId: string): string {
  return `gcp-project-pool/${projectId}.json`;
}

// Read as unknown and validated, not cast: a malformed pool entry would otherwise flow into
// the claim logic and the advancer with a trusted-looking shape. Entries written before the
// state machine existed carry only `state`, so every added field has a defined-and-safe
// default: a zero timestamp reads as "long ago", which is exactly right for a legacy
// `claimed` entry the reaper should now resolve one way or the other.
function parsePoolProjectEntry(projectId: string, stored: unknown): PoolProjectEntry {
  const malformed = (): never => {
    throw new Error(`stored project pool entry ${JSON.stringify(projectId)} is malformed`);
  };
  if (!isRecord(stored)) return malformed();
  if (typeof stored.state !== "string" || !(POOL_PROJECT_STATES as readonly string[]).includes(stored.state)) return malformed();
  const optionalString = (value: unknown): string | null => (value === undefined || value === null ? null : typeof value === "string" ? value : malformed());
  const optionalMillis = (value: unknown): number => (value === undefined ? 0 : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : malformed());
  const state = stored.state as PoolProjectState;
  const ns = optionalString(stored.ns);
  if (state === "claimed" && ns === null) return malformed();
  return {
    state,
    created_at_millis: optionalMillis(stored.created_at_millis),
    state_since_millis: optionalMillis(stored.state_since_millis),
    attempts: optionalMillis(stored.attempts),
    last_error: optionalString(stored.last_error),
    operation_name: optionalString(stored.operation_name),
    project_number: optionalString(stored.project_number),
    ns,
  };
}

export async function listPoolProjects(): Promise<{ projectId: string, entry: PoolProjectEntry }[]> {
  const prefix = "gcp-project-pool/";
  const projects: { projectId: string, entry: PoolProjectEntry }[] = [];
  for (const objectKey of await listKeys(prefix)) {
    if (!objectKey.endsWith(".json")) continue;
    const projectId = objectKey.slice(prefix.length, -".json".length);
    const stored: unknown = await getJson<unknown>(objectKey);
    if (stored === null) continue;
    projects.push({ projectId, entry: parsePoolProjectEntry(projectId, readAuthenticatedControlPlaneState(objectKey, stored)) });
  }
  return projects;
}

export async function readPoolProject(projectId: string): Promise<Versioned<PoolProjectEntry> | null> {
  const key = poolProjectKey(projectId);
  const stored = await getJsonVersioned<unknown>(key);
  return stored === null ? null : { etag: stored.etag, value: parsePoolProjectEntry(projectId, readAuthenticatedControlPlaneState(key, stored.value)) };
}

// Writes the `creating` record. This must happen BEFORE the Resource Manager create call —
// the record is the only thing that makes a project reapable, so a freeze after the POST but
// before the record would leak a billed project nothing can ever find. Fails (false) only
// when the id already exists, which for a random pooled id means another replica got there.
export async function createPoolProject(projectId: string, entry: PoolProjectEntry): Promise<boolean> {
  const key = poolProjectKey(projectId);
  return await putJsonConditionally(key, authenticatedControlPlaneState(key, entry), { ifNoneMatch: true }) !== null;
}

// The ETag fence is the distributed arbiter for every state transition: two overlapping
// advancer ticks cannot both move the same project forward, and the loser simply stops.
export async function updatePoolProject(projectId: string, entry: PoolProjectEntry, previousEtag: string): Promise<boolean> {
  const key = poolProjectKey(projectId);
  return await putJsonConditionally(key, authenticatedControlPlaneState(key, entry), { ifMatch: previousEtag }) !== null;
}

export async function deletePoolProject(projectId: string, previousEtag: string): Promise<boolean> {
  return await deleteObjectConditionally(poolProjectKey(projectId), previousEtag);
}

// The same ETag fence applied to the claim: exactly one caller can flip a ready entry to
// claimed, so two Marshal replicas (or two concurrent deploys) cannot be handed the same
// tenant project.
export async function claimPoolProject(projectId: string, ns: string): Promise<boolean> {
  const entry = await readPoolProject(projectId);
  if (entry === null || entry.value.state !== "ready") return false;
  return await updatePoolProject(projectId, { ...entry.value, state: "claimed", state_since_millis: Date.now(), ns }, entry.etag);
}

// Puts a claimed entry back. Only succeeds while `ns` still owns the claim, so a
// caller that lost its assignment race cannot release someone else's claim.
export async function unclaimPoolProject(projectId: string, ns: string): Promise<boolean> {
  const entry = await readPoolProject(projectId);
  if (entry === null || entry.value.state !== "claimed" || entry.value.ns !== ns) return false;
  return await updatePoolProject(projectId, { ...entry.value, state: "ready", state_since_millis: Date.now(), ns: null }, entry.etag);
}

// The creation-rate ledger. Project creation has to be rate-limited across replicas AND
// across ticks, and the pool entries themselves cannot carry that count: the reaper deletes
// entries (a claimed project that reached its tenant, a condemned one), which would silently
// hand back budget. Deleted GCP projects hold organization quota for 30 days, so a runaway
// advancer would exhaust the org rather than just spend money. Read-modify-write is safe
// without a CAS because every creation happens under the project-pool lease.
const POOL_CREATION_LEDGER_KEY = "gcp-project-pool-ledger.json";

export async function readPoolCreationLedgerVersioned(): Promise<{ etag: string | null, createdAtMillis: number[] }> {
  const stored = await getJsonVersioned<unknown>(POOL_CREATION_LEDGER_KEY);
  if (stored === null) return { etag: null, createdAtMillis: [] };
  const value = readAuthenticatedControlPlaneState(POOL_CREATION_LEDGER_KEY, stored.value);
  if (!isRecord(value)
    || !Array.isArray(value.created_at_millis)
    || !value.created_at_millis.every((timestamp): timestamp is number => typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0)) {
    throw new Error("the authenticated tenant project pool creation ledger is malformed");
  }
  return { etag: stored.etag, createdAtMillis: value.created_at_millis };
}

// Fenced on the ETag rather than written blind. The pool lease normally serializes this, but
// the cap it enforces is the backstop for exactly the case where the lease does NOT hold — an
// expired lease whose owner is still running — and an unconditional PUT there silently drops
// the newer tick's reservations. A lost CAS means someone else recorded first; re-read.
export async function writePoolCreationLedgerConditionally(createdAtMillis: number[], etag: string | null): Promise<boolean> {
  const value = authenticatedControlPlaneState(POOL_CREATION_LEDGER_KEY, { created_at_millis: createdAtMillis });
  return await putJsonConditionally(POOL_CREATION_LEDGER_KEY, value, etag === null ? { ifNoneMatch: true } : { ifMatch: etag }) !== null;
}
