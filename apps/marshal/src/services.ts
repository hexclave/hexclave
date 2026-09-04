import { buildEnvByteLength, buildTimeEnv, computeWebhookToken, type Builder } from "./builds.js";
import { BASE_IMAGE, BUILDER_MACHINE_BY_MEMORY_MB, BUILD_TIMEOUT_SECONDS, MAX_BUILD_ENV_BYTES, MAX_COMMAND_LENGTH, MAX_INSTANCES_CAP, MAX_PERSISTENT_VOLUMES_PER_SERVICE, MAX_PORTS_PER_SERVICE, MAX_UPLOAD_BYTES, MAX_VOLUME_ID_LENGTH, MAX_VOLUME_SIZE_GB, MIN_REDACTED_ENV_VALUE_LENGTH, MIN_VOLUME_SIZE_GB, UNREDACTED_ENV_KEY_REGEX, VOLUME_ID_REGEX, defaultMemoryMbFor, memorySizesFor } from "./config.js";
import { applyErrorMessage } from "./apply-error.js";
import { resolveEnv, type KnownTarget } from "./env-resolution.js";
import { MarshalError, badRequest, conflict, notFound } from "./errors.js";
import { MutationOutcomeUnknownError, RECONCILIATION_TAKEOVER_GRACE_MS } from "./mutation-safety.js";
import { providerFor, providerForNamespace, type RuntimeProvider } from "./provider.js";
import { ReconciliationLeaseLostError, withReconciliationLease, type ReconciliationLeaseGuard } from "./reconciliation-lock.js";
import { redactBuildLogLines, redactBuildLogText } from "./redact-build-log.js";
import { computeRevision } from "./revision.js";
import { DEFAULT_RUNTIME, type DeploymentRuntime } from "./runtime.js";
import { assertServiceCanHoldADomain, standardPortsHolderFor } from "./spec-helpers.js";
import { createDeployment, deleteSpecConditionally, deleteUpload, deleteValidatedUpload, listDomainClaimsForService, listSpecKeys, readDeployment, readDeploymentVersioned, readDomainClaimVersioned, readSpec, readSpecVersioned, readUpload, replaceDeployment, statUpload, writeDeploymentLog, writeSpec, writeValidatedUpload } from "./store.js";
import { loadAndValidateSourceArchive } from "./source-archive.js";
import { validateImageRef } from "./image-ref.js";
import { portEntries, targetIsBuilt, targetUsesGeneratedDockerfile, type Deployment, type DeploymentServiceState, type DeploymentTarget, type EnvValue, type PortsConfig, type ServiceSpec, type ServiceState, type StoredDeployment, type StoredSpec, type VolumeConfig } from "./types.js";
import { ulid } from "./ulid.js";

// The pure spec helpers and the env resolver moved to their own modules so the providers can
// share them; re-exported here so their existing importers (and tests) need not move.
export { resolveEnv, type KnownTarget } from "./env-resolution.js";
export { assertServiceCanHoldADomain, soleHttpPort, specIsPublic, specVolume, standardPortsHolderFor } from "./spec-helpers.js";
export { redactBuildLogLines, redactBuildLogText } from "./redact-build-log.js";
export { builderOutputIsTerminal, builderStartupScriptFailed } from "./gcp/provider.js";

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The optional `:<port>` suffix belongs to `url`, which names the port it means
// on a service that declares several.
const REF_REGEX = /^([a-zA-Z0-9_][a-zA-Z0-9_-]*)\.([A-Za-z0-9_]+)(?::([0-9]{1,5}))?$/;
const SERVICE_KEY_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;
// Keys that cannot be used as an object key, which is what a service key IS
// here — specs, images and outcomes are all records keyed by it. `__proto__` is
// the one that breaks: `record["__proto__"] = value` invokes the prototype
// setter and stores nothing, so the value vanishes between the write and the
// Object.hasOwn read. Refused here as well as in the product's own id rules,
// because this is the last line before the runtime.
const RESERVED_SERVICE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SOURCE_ID_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,62}$/;
// A bound on one deployment, not a platform limit: a deploy file declaring more
// services than this is far likelier to be a mistake than a real source, and every
// target is an image built serially in one machine.
const MAX_TARGETS_PER_DEPLOYMENT = 20;
// The `source` a target's spec is validated with. A target has no image until its
// build finishes, but validating the rest of the spec on the REQUEST is what makes
// a bad port list a 400 now rather than a failure after a five-minute build.
const PLACEHOLDER_IMAGE = "marshal-placeholder:pending-build";
// Advancing a deployment must not queue behind a busy source: if another request
// holds the lease it is already doing this work, so give up quickly and report
// what is stored (see advanceDeployment).
const DEPLOYMENT_ADVANCE_TIMINGS = {
  durationMs: 2 * 60 * 1000,
  renewIntervalMs: 20 * 1000,
  contendedPollMs: 250,
  takeoverGraceMs: RECONCILIATION_TAKEOVER_GRACE_MS,
  acquireTimeoutMs: 1000,
};
const NAMESPACE_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
// upload_id flows into an S3 object key (uploads/<ns>/<id>.tar.gz); validate it so a
// path-traversal id can't escape the prefix. The backend mints these as randomUUIDs.
const UPLOAD_ID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Build ids are ULIDs (Crockford base32, 26 chars); they flow into builds/<ns>/<key>/... keys.
export const BUILD_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Grace on top of the harness's own watchdog before the lazy backstop declares a build dead.
const BUILD_STALE_GRACE_MS = 5 * 60 * 1000;
// Errors are surfaced to the caller and stored, so they are bounded: a build can
// print a great deal before it dies.
const MAX_ERROR_LENGTH = 2000;

function isReconciliationFencingError(error: unknown): boolean {
  return error instanceof ReconciliationLeaseLostError || error instanceof MutationOutcomeUnknownError;
}

export function validateNamespace(ns: string): string {
  if (!NAMESPACE_REGEX.test(ns)) throw badRequest(`invalid namespace ${JSON.stringify(ns)}`);
  return ns;
}

/**
 * A deployment source id. Looser than a service key because the backend's ids
 * may contain dots (projects deployed before services moved out of
 * hexclave.config.ts still have a source named after that file), and it reaches
 * an S3 key prefix only through the lease, so traversal characters are what
 * matter.
 */
export function validateSourceId(sourceId: string): string {
  if (!SOURCE_ID_REGEX.test(sourceId)) throw badRequest(`invalid deployment source id ${JSON.stringify(sourceId)}`);
  return sourceId;
}

export function validateServiceKey(key: string): string {
  if (!SERVICE_KEY_REGEX.test(key)) throw badRequest(`invalid service key ${JSON.stringify(key)}`);
  if (RESERVED_SERVICE_KEYS.has(key)) throw badRequest(`service key ${JSON.stringify(key)} is reserved and cannot be used`);
  return key;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

/**
 * Validates a spec. `runtime` decides the memory ladder — the one part of a spec whose
 * legal values are a fact about the infrastructure rather than about the contract — and
 * defaults to the default runtime, which is what a spec with no namespace context (a test,
 * a placeholder) is validated against.
 */
export function validateServiceSpec(body: unknown, runtime: DeploymentRuntime = DEFAULT_RUNTIME): ServiceSpec {
  const record = asRecord(body);
  if (record === null) throw badRequest("request body must be a ServiceSpec object");
  const config = asRecord(record.config);
  if (config === null) throw badRequest("config is required");
  const minInstances = config.min_instances;
  const maxInstances = config.max_instances;
  const serviceKind = config.type;
  if (serviceKind !== "server" && serviceKind !== "serverless") throw badRequest('config.type must be "server" or "serverless"');
  if (typeof minInstances !== "number" || !Number.isInteger(minInstances) || minInstances < 0) throw badRequest("config.min_instances must be a non-negative integer");
  if (typeof maxInstances !== "number" || !Number.isInteger(maxInstances) || maxInstances < 1) throw badRequest("config.max_instances must be a positive integer");
  if (maxInstances < minInstances) throw badRequest("config.max_instances must be >= config.min_instances");
  if (maxInstances > MAX_INSTANCES_CAP) throw badRequest(`config.max_instances must be <= ${MAX_INSTANCES_CAP}`);

  // Ports. Re-validated here rather than trusted from the backend: this is the
  // boundary that turns a spec into provider config, and a bad port list would otherwise
  // reach a provider API. An empty object remains legal for a private server worker.
  // Keyed by port number, exactly as the deploy file writes it — so a duplicate
  // port is impossible by construction and the key is what has to be validated.
  // Arrays are excluded explicitly: asRecord accepts them (an array IS an
  // object), so the previous array shape would otherwise be read as "no ports"
  // — silently deploying a service that listens on nothing.
  const portsRecord = Array.isArray(config.ports) ? null : asRecord(config.ports);
  if (portsRecord === null) throw badRequest("config.ports must be an object keyed by port number");
  if (Object.keys(portsRecord).length > MAX_PORTS_PER_SERVICE) throw badRequest(`config.ports may declare at most ${MAX_PORTS_PER_SERVICE} ports`);
  const ports: PortsConfig = {};
  for (const [portKey, portRaw] of Object.entries(portsRecord)) {
    // Decimal, no LEADING ZERO. That spelling rule is what makes a duplicate
    // port impossible: "80" and "080" are different keys of one record but the
    // same port, so both would survive and the machine would declare two
    // identical external listeners. Rejecting the non-canonical spelling beats a
    // cross-entry duplicate check — it is the same reason ports are a record and
    // not an array. KEPT IN SYNC WITH DEPLOYMENT_PORT_KEY_REGEX in
    // @hexclave/shared's deployments.ts.
    if (!/^[1-9][0-9]{0,4}$/.test(portKey) || Number(portKey) < 1 || Number(portKey) > 65535) {
      throw badRequest("each config.ports key must be a port number between 1 and 65535, written in decimal without a leading zero");
    }
    const portRecord = asRecord(portRaw);
    if (portRecord === null) throw badRequest("each config.ports value must be an object");
    const protocol = portRecord.protocol;
    if (protocol !== "http" && protocol !== "tcp") throw badRequest('each config.ports value must declare protocol as "http" or "tcp"');
    ports[portKey] = { protocol };
  }
  const portList = portEntries(ports);

  // Memory. Re-validated here rather than trusted, like every other part of a
  // spec: this is the boundary that turns a request into provider config, and an
  // unsupported size would otherwise reach a provider API and come back as a
  // rejection the caller cannot read.
  //
  // The ladder is per RUNTIME and per type, because the runtimes' smallest shapes
  // differ: a Fly machine of either type can carry 512MB, a GCP "server" is a
  // whole machine and the smallest one carries a full gigabyte.
  const memoryMbRaw = config.memory_mb;
  let memoryMb: number | undefined;
  if (memoryMbRaw !== undefined && memoryMbRaw !== null) {
    const allowed = memorySizesFor(runtime, serviceKind);
    if (typeof memoryMbRaw !== "number" || !Number.isInteger(memoryMbRaw) || !allowed.includes(memoryMbRaw)) {
      throw badRequest(`config.memory_mb must be one of ${allowed.join(", ")} for a ${JSON.stringify(serviceKind)} service`);
    }
    // NORMALIZED: the type's own default is dropped rather than carried, so a
    // spec that spells out the size a service already runs on is byte-identical
    // to one that says nothing. computeRevision hashes this field, and for a
    // "server" a changed revision means the machine is replaced — so
    // without this, restating the default would take a database down for no
    // change at all.
    //
    // The backend normalizes too, but this is the boundary that turns a request
    // into provider config and it does not trust the one above it (see the
    // ports note): a replayed older spec, or any other caller, must get the
    // same guarantee.
    memoryMb = memoryMbRaw === defaultMemoryMbFor(runtime, serviceKind) ? undefined : memoryMbRaw;
  }

  // Visibility belongs to the CONTAINER, not to a port — see PortConfig in
  // types.ts. A per-port public flag would misdescribe the service-level ingress contract.
  const isPublic = config.public ?? false;
  if (typeof isPublic !== "boolean") throw badRequest("config.public must be a boolean");
  // A public service is all-HTTP. Raw TCP cannot take public ingress: a shared
  // public address tells apps apart by SNI or Host, and a raw TCP stream carries neither.
  const tcpPorts = portList.filter((entry) => entry.protocol === "tcp");
  if (isPublic && tcpPorts.length > 0) {
    throw badRequest(`a public service may not declare a "tcp" port (it declares ${tcpPorts.map((entry) => entry.port).join(", ")}): raw TCP carries no SNI or Host header, so a shared public address cannot tell which service a connection is for`);
  }
  // Public ingress with nothing behind it: addresses would be allocated for a
  // service that can never answer on them.
  if (isPublic && portList.length === 0) {
    throw badRequest("a public service must declare at least one port: a service with no ports has nothing to serve on the public address it would be given");
  }
  // The standard-ports holder claims external 80 and 443 in ADDITION to its own
  // number, and listeners are per-app. So a different port that is itself numbered
  // 80 or 443 asks for an external listener the holder has already taken —
  // `{80: public, 443: public}` makes 80 the holder, which claims 80 and 443, and
  // the declared 443 claims 443 a second time. One external port cannot be served
  // from two entries.
  //
  // Refused rather than resolved by precedence: dropping the holder's standard
  // binding costs the platform URL and the certificate, and dropping the
  // sibling's own binding silently unpublishes a port the caller declared.
  // KEPT IN SYNC WITH reservedStandardPortConflicts in @hexclave/shared.
  const standardHolder = standardPortsHolderFor(ports, isPublic);
  if (standardHolder !== null) {
    const conflicting = portList.filter((entry) => entry.port !== standardHolder && (entry.port === 80 || entry.port === 443));
    if (conflicting.length > 0) {
      throw badRequest(`port ${conflicting.map((entry) => entry.port).join(" and ")} would collide with the standard bindings of port ${standardHolder}, which additionally answers on 80 and 443: one external port cannot be served from two ports of one service`);
    }
  }
  // A "server" is a SINGLE instance by definition, so its ceiling is 1 — but its floor is
  // the caller's choice: 0 lets it suspend when idle (on Fly; a GCP server has no suspend
  // and simply stays up) and 1 keeps it up. Rejecting min_instances 1 here would reject the
  // default every `server` deploys with. Reject rather than coerce: the caller's stated
  // bounds and its stated type would otherwise disagree in the stored spec.
  if (serviceKind === "server" && (minInstances > 1 || maxInstances !== 1)) {
    throw badRequest('config.min_instances must be 0 or 1 and config.max_instances must be 1 when config.type is "server"');
  }

  // A persistent disk attaches to the single instance, so only a "server" can hold one.
  // The disk survives runtime deletion and a later deployment adopts it.
  let persistentVolumes: Record<string, VolumeConfig> | undefined;
  if (config.persistent_volumes !== undefined && config.persistent_volumes !== null) {
    const volumesRecord = asRecord(config.persistent_volumes);
    if (volumesRecord === null) throw badRequest("config.persistent_volumes must be an object keyed by volume id");
    const volumeIds = Object.keys(volumesRecord);
    if (volumeIds.length > MAX_PERSISTENT_VOLUMES_PER_SERVICE) {
      throw badRequest(`config.persistent_volumes may declare at most ${MAX_PERSISTENT_VOLUMES_PER_SERVICE} volume (an instance mounts at most one)`);
    }
    if (volumeIds.length > 0 && serviceKind !== "server") {
      throw badRequest('config.type must be "server" when config.persistent_volumes is set (a persistent volume can only be attached to one instance)');
    }
    const validatedVolumes = new Map<string, VolumeConfig>();
    for (const [volumeId, volumeValue] of Object.entries(volumesRecord)) {
      // The id contributes to the disk identity, so its spelling is constrained before the
      // naming function normalizes it.
      if (!VOLUME_ID_REGEX.test(volumeId) || volumeId.length > MAX_VOLUME_ID_LENGTH) {
        throw badRequest(`invalid persistent volume id ${JSON.stringify(volumeId)} (lowercase letters, digits, and underscores, starting with a letter, at most ${MAX_VOLUME_ID_LENGTH} characters)`);
      }
      const volumeRecord = asRecord(volumeValue);
      if (volumeRecord === null) throw badRequest(`config.persistent_volumes.${volumeId} must be an object of { path, size_gb }`);
      const volumePath = volumeRecord.path;
      const sizeGb = volumeRecord.size_gb;
      if (typeof volumePath !== "string" || volumePath === "" || volumePath.length > 512) throw badRequest(`config.persistent_volumes.${volumeId}.path must be a non-empty string of at most 512 characters`);
      // The path becomes a mount point inside the container. Require a normalized ABSOLUTE
      // path: relative or dot-laden paths are ambiguous against the image's WORKDIR, and
      // mounting over "/" would shadow the whole image.
      // eslint-disable-next-line no-control-regex
      if (!volumePath.startsWith("/") || volumePath === "/" || volumePath.endsWith("/") || volumePath.includes("\\") || /[\x00-\x1f]/.test(volumePath) || volumePath.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw badRequest(`config.persistent_volumes.${volumeId}.path must be a normalized absolute path inside the container (e.g. "/data") — no trailing slash, no "." or ".." segments, no backslashes or control characters`);
      }
      if (typeof sizeGb !== "number" || !Number.isInteger(sizeGb) || sizeGb < MIN_VOLUME_SIZE_GB || sizeGb > MAX_VOLUME_SIZE_GB) {
        throw badRequest(`config.persistent_volumes.${volumeId}.size_gb must be an integer between ${MIN_VOLUME_SIZE_GB} and ${MAX_VOLUME_SIZE_GB}`);
      }
      validatedVolumes.set(volumeId, { path: volumePath, size_gb: sizeGb });
    }
    // An empty record collapses to absent so it hashes identically to a volumeless spec —
    // otherwise `{}` and omitted would be two revisions of the same service.
    if (validatedVolumes.size > 0) persistentVolumes = Object.fromEntries(validatedVolumes);
  }

  // What the container is started with, instead of the image's own entrypoint and
  // command. Validated to the same rule as the rest of the pipeline states it: a
  // single non-empty line with no control characters. It becomes an argv entry in
  // a machine config, where a newline is not something that could be escaped into
  // meaning — so it is refused here rather than sanitized.
  let startCommand: string | undefined;
  if (config.start_command !== undefined && config.start_command !== null) {
    const value = config.start_command;
    // eslint-disable-next-line no-control-regex
    if (typeof value !== "string" || value.trim() === "" || value.length > MAX_COMMAND_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
      throw badRequest(`config.start_command must be a single non-empty command line of at most ${MAX_COMMAND_LENGTH} characters, with no control characters`);
    }
    startCommand = value;
  }

  // A spec always names an already-built image. Building belongs to a DEPLOYMENT
  // (see startSourceDeployment), which builds every service of a deployment
  // source from one uploaded tree in one builder machine — so by the time a spec
  // is applied, its image exists.
  const source = asRecord(record.source);
  if (source === null) throw badRequest("source is required");
  const image = source.image;
  if (typeof image !== "string" || image === "") throw badRequest("source.image is required (a spec names an already-built image; builds run as part of a deployment)");

  const env = asRecord(record.env);
  if (env === null) throw badRequest("env is required (use {} for no env vars)");
  const validatedEnv = new Map<string, EnvValue>();
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_REGEX.test(key)) throw badRequest(`invalid env var key ${JSON.stringify(key)}`);
    const envValue = asRecord(value);
    if (envValue === null) throw badRequest(`env.${key} must be { value } or { ref }`);
    const hasValue = typeof envValue.value === "string";
    const hasRef = typeof envValue.ref === "string";
    if (hasValue === hasRef) throw badRequest(`env.${key} must be exactly one of { value } or { ref }`);
    if (hasRef && !REF_REGEX.test(envValue.ref as string)) throw badRequest(`env.${key}.ref must look like "<service_key>.<output_key>"`);
    validatedEnv.set(key, hasValue ? { value: envValue.value as string } : { ref: envValue.ref as string });
  }
  // Plain values ride to the builder machine inside its config, so their total size is
  // bounded. Enforced here so an oversized env is a 400 rather than an opaque provider
  // rejection. Refs don't count: they resolve to machine env only.
  const buildEnvBytes = buildEnvByteLength(buildTimeEnv(Object.fromEntries(validatedEnv)));
  if (buildEnvBytes > MAX_BUILD_ENV_BYTES) {
    throw badRequest(`the env var values total ${buildEnvBytes} bytes, over the ${MAX_BUILD_ENV_BYTES}-byte limit (they are handed to the remote build, which puts them in the builder machine's configuration)`);
  }

  return {
    // Key order is canonical here too (see the source note below). `persistent_volumes` is
    // only present when set; computeRevision mirrors that same conditional spread.
    config: { type: serviceKind, public: isPublic, min_instances: minInstances, max_instances: maxInstances, ports, ...(persistentVolumes !== undefined ? { persistent_volumes: persistentVolumes } : {}), ...(startCommand !== undefined ? { start_command: startCommand } : {}), ...(memoryMb !== undefined ? { memory_mb: memoryMb } : {}) },
    // Key order is fixed here on purpose: computeRevision hashes the JSON serialization of
    // this object, so construction must stay canonical.
    source: { image },
    env: Object.fromEntries(validatedEnv),
  };
}

// ---------------------------------------------------------------------------
// PUT /services/{key}

export type ApplyResult = {
  revision: string,
  changed: boolean,
  state: ServiceState,
  // The image reference the provider accepted. Null when no runtime resource was rolled
  // (an apply that ended blocked, lost the spec, or threw).
  imageRef: string | null,
};

async function claimDesiredSpec(ns: string, key: string, spec: ServiceSpec, revision: string, now: number): Promise<{
  stored: StoredSpec,
  changed: boolean,
  etag: string,
}> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const previousVersion = await readSpecVersioned(ns, key);
    const previous = previousVersion?.value ?? null;
    const changed = previous === null || previous.revision !== revision;
    const stored: StoredSpec = {
      ns,
      key,
      spec: changed ? spec : previous.spec,
      revision,
      created_at_millis: previous?.created_at_millis ?? now,
      updated_at_millis: Date.now(),
      last_apply_error: changed ? null : previous.last_apply_error,
    };
    const etag = await writeSpec(stored, previousVersion === null ? { ifNoneMatch: true } : { ifMatch: previousVersion.etag });
    if (etag !== null) return { stored, changed, etag };
  }
  throw conflict(`service ${JSON.stringify(key)} was updated too frequently; retry the request`);
}

async function stateAfterSpecWrite(provider: RuntimeProvider, ns: string, key: string, stored: StoredSpec, previousEtag: string, knownTargets?: Map<string, KnownTarget>): Promise<ServiceState> {
  const etag = await writeSpec(stored, { ifMatch: previousEtag });
  if (etag !== null) return await serviceStateWith(provider, ns, key, stored, knownTargets);
  // Another request (or a delete) owns the desired state now. Never resurrect/overwrite it.
  return await serviceStateWith(provider, ns, key, undefined, knownTargets);
}

async function specIsStillOwned(ns: string, key: string, etag: string): Promise<boolean> {
  return (await readSpecVersioned(ns, key))?.etag === etag;
}

async function currentDomainClaimsForService(ns: string, key: string): Promise<string[]> {
  const indexed = await listDomainClaimsForService(ns, key);
  const claims = await Promise.all(indexed.map(async (hostname) => ({ hostname, claim: await readDomainClaimVersioned(hostname) })));
  // Index entries are intentionally written before the global claim CAS so a crash cannot
  // create an undiscoverable claim. The tradeoff is harmless orphan indexes; every reader
  // must revalidate them against the authenticated global authority before treating them as
  // service state.
  return claims
    .filter(({ claim }) => claim !== null && claim.value.ns === ns && claim.value.service_key === key)
    .map(({ hostname }) => hostname);
}

/**
 * Applies a spec. `runtime` is the runtime the caller asked for (a PUT body's `runtime`),
 * reconciled against the namespace's pin — see resolveNamespaceRuntime. Absent on the
 * deployment path, where the deployment has already pinned it.
 */
export async function applyServiceSpec(ns: string, key: string, spec: ServiceSpec, options?: { knownTargets?: Map<string, KnownTarget>, lease?: ReconciliationLeaseGuard, runtime?: DeploymentRuntime }): Promise<ApplyResult> {
  const provider = await providerForNamespace(ns, options?.runtime);
  // A deployment already holds the lease for its whole source, so it passes its
  // own rather than taking a second one per service — the lease is not
  // re-entrant, and waiting on itself is a deadlock.
  if (options?.lease !== undefined) {
    return await applyServiceSpecWithLease(provider, ns, key, spec, options.lease, options.knownTargets);
  }
  return await withReconciliationLease(ns, key, async (lease) => await applyServiceSpecWithLease(provider, ns, key, spec, lease, options?.knownTargets));
}

async function applyServiceSpecWithLease(provider: RuntimeProvider, ns: string, key: string, spec: ServiceSpec, lease: ReconciliationLeaseGuard, knownTargets?: Map<string, KnownTarget>): Promise<ApplyResult> {
  // A domain-holding service must satisfy the domain port rule on every spec write, not just
  // at attach time. The domain's public ingress outlives the attach: a later PUT that adds a
  // private sibling port would hand it to the proxy on those IPs, so the whole rule is
  // re-checked here rather than only its HTTP-port half.
  const domainClaims = await currentDomainClaimsForService(ns, key);
  if (domainClaims.length > 0) {
    assertServiceCanHoldADomain(key, spec.config.ports, spec.config.public, "Detach the service's custom domains first if this port set is what you want.");
  }
  const revision = computeRevision(spec);
  const now = Date.now();
  const claimed = await claimDesiredSpec(ns, key, spec, revision, now);
  const { stored, changed } = claimed;
  const ownedSpecEtag = claimed.etag;

  // Unresolvable refs: persist the spec and report blocked WITHOUT touching runtime resources or
  // starting builds — the backend re-applies when the blocking output appears.
  const resolved = await resolveEnv(ns, stored.spec.env, knownTargets);
  if (!resolved.ok) {
    return { revision, changed, state: await serviceStateWith(provider, ns, key, stored, knownTargets), imageRef: null };
  }

  // FUTURE (build-time env): env values are handed to the builder too (see buildTimeEnv),
  // because frameworks that inline them (NEXT_PUBLIC_*, VITE_*) need them at BUILD time. So
  // an env-only change rolls the runtime with the new value while the already-built image
  // keeps the old one baked in. That skew is ACCEPTED for now: a spec names an image that
  // has already been built, so nothing here can rebuild it. The fix is not in this function
  // but in the product surface: track which build-visible values an image was built from,
  // report the service as stale in the dashboard, and offer a redeploy (Vercel makes the
  // redeploy mandatory — an env change never applies to an existing deployment).

  if (!await specIsStillOwned(ns, key, ownedSpecEtag)) {
    // Deliberately WITHOUT knownTargets: the spec being reported now belongs to whoever won the
    // race, and resolving someone else's refs against this deployment's targets would report
    // a state their own reads never agree with.
    return { revision, changed, state: await serviceStateWith(provider, ns, key), imageRef: null };
  }
  let imageRef: string | null = null;
  try {
    // A claimed custom domain routes through the persistent-server gateway on GCP, so the
    // apply has to know about it or it will tear that gateway down as though the service
    // were merely private.
    imageRef = await provider.applyService(stored, stored.spec.source.image, resolved.env, lease, domainClaims.length > 0);
    stored.last_apply_error = null;
  } catch (error) {
    if (isReconciliationFencingError(error)) throw error;
    // Logged here because this is the ONLY place the real failure survives:
    // last_apply_error is served to the caller, so it carries our sanitized text
    // and never the provider's wording, status or app identifiers.
    console.error(`apply failed for service ${stored.ns}/${stored.key}`, error);
    stored.last_apply_error = `deploy failed: ${applyErrorMessage(error)}`;
  }
  return { revision, changed, state: await stateAfterSpecWrite(provider, ns, key, stored, ownedSpecEtag, knownTargets), imageRef };
}

// ---------------------------------------------------------------------------
// Deployments: one `hexclave deploy` of one deployment source.
//
// The runtime owns the WHOLE sequence — build every target in one machine, then
// apply them level by level — rather than the backend driving it step by step,
// because the lease, the build-completion webhook and the specs all live here.
//
// Progress is made on READ. There is no background worker (Marshal is a
// stateless HTTP service that also runs on a serverless host), so each poll of
// GET /deployments/:id advances the deployment by at most one service. The
// backend polls every few seconds while a deploy is in flight, which is what
// turns a series of cheap reads into a rollout.

/**
 * A lookup into a stored JSON record, typed as possibly-absent.
 *
 * A plain index is typed as always-present without noUncheckedIndexedAccess,
 * which would type away the case every caller here has to handle: these records
 * come from the bucket, keyed by service keys that may not be in them.
 * `Object.hasOwn` also keeps a key like "constructor" from resolving to
 * something off the prototype.
 */
function lookup<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The lease key that serializes everything belonging to one deployment source. */
function sourceLeaseKey(sourceId: string): string {
  return `source:${sourceId}`;
}

export function validateDeploymentRequest(body: unknown, runtime: DeploymentRuntime = DEFAULT_RUNTIME): { uploadId: string | null, targets: DeploymentTarget[], order: string[][], builderMemoryMb: number | null } {
  const record = asRecord(body);
  if (record === null) throw badRequest("request body must be an object");
  // Optional: a deployment whose every target names a prebuilt image builds
  // nothing, so there is no archive to consume. Whether it is REQUIRED depends on
  // the targets, so that check comes after they are parsed.
  const uploadIdRaw = record.upload_id;
  const uploadId = uploadIdRaw === undefined || uploadIdRaw === null ? null : uploadIdRaw;
  if (uploadId !== null && (typeof uploadId !== "string" || !UPLOAD_ID_REGEX.test(uploadId))) throw badRequest("upload_id must be a UUID");
  if (!Array.isArray(record.targets) || record.targets.length === 0) throw badRequest("targets must be a non-empty array");
  if (record.targets.length > MAX_TARGETS_PER_DEPLOYMENT) throw badRequest(`a deployment may declare at most ${MAX_TARGETS_PER_DEPLOYMENT} targets`);

  const targets: DeploymentTarget[] = record.targets.map((targetRaw) => {
    const target = asRecord(targetRaw);
    if (target === null) throw badRequest("each target must be an object");
    const serviceKey = validateServiceKey(typeof target.service_key === "string" ? target.service_key : "");
    // Both paths flow into the builder harness as TAB-separated manifest fields
    // and as shell variables, so anything that could break a line or escape a
    // field is refused rather than escaped.
    const rootDirectory = validateOptionalRelativePath(target.root_directory, `target ${serviceKey} root_directory`);
    const dockerfilePath = validateOptionalRelativePath(target.dockerfile_path, `target ${serviceKey} dockerfile_path`);
    // The image a target runs, or — with a build command — the base it is built
    // on. Parsed (not merely pattern-checked) so the reference is stored fully
    // qualified and the resolver below knows which registry to ask.
    const image = target.image === undefined || target.image === null
      ? undefined
      : validateImageRef(target.image, `target ${serviceKey} image`).canonical;
    if (image !== undefined && dockerfilePath !== undefined) {
      throw badRequest(`target ${serviceKey} names an image and a dockerfile_path; each of them says what the build starts from, so a target has at most one`);
    }
    // Becomes a `RUN` line of a Dockerfile the builder generates or appends to,
    // so a newline (a second instruction) or any other control character is
    // refused rather than escaped — the same rule the start command is held to.
    let buildCommand: string | undefined;
    if (target.build_command !== undefined && target.build_command !== null) {
      const value = target.build_command;
      // eslint-disable-next-line no-control-regex
      if (typeof value !== "string" || value.trim() === "" || value.length > MAX_COMMAND_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
        throw badRequest(`target ${serviceKey} build_command must be a single non-empty command line of at most ${MAX_COMMAND_LENGTH} characters, with no control characters`);
      }
      buildCommand = value;
    }
    // The spec arrives without a source: the image does not exist yet. It is
    // validated in full anyway (ports, bounds, env, volumes) so a bad spec is a
    // 400 on THIS request rather than a failure after a five-minute build.
    const specRecord = asRecord(target.spec);
    if (specRecord === null) throw badRequest(`target ${serviceKey} must have a spec`);
    const spec = validateServiceSpec({ ...specRecord, source: { image: PLACEHOLDER_IMAGE } }, runtime);
    // A target built on the runtime's own base image has nothing to start: that
    // base runs a REPL, so without a start command the service would deploy, boot
    // and exit. Refused here as well as upstream, since this is the boundary that
    // turns a request into a build.
    if (image === undefined && dockerfilePath === undefined && buildCommand !== undefined && spec.config.start_command === undefined) {
      throw badRequest(`target ${serviceKey} has a build_command but neither an image nor a dockerfile_path, so it is built on the base image — which has no command of its own. Its spec must name a start_command`);
    }
    if (image !== undefined && buildCommand === undefined && rootDirectory !== undefined) {
      throw badRequest(`target ${serviceKey} names an image with no build_command, so it is not built from the upload and a root_directory within it means nothing`);
    }
    return {
      service_key: serviceKey,
      ...(rootDirectory !== undefined ? { root_directory: rootDirectory } : {}),
      ...(dockerfilePath !== undefined ? { dockerfile_path: dockerfilePath } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(buildCommand !== undefined ? { build_command: buildCommand } : {}),
      spec: { config: spec.config, env: spec.env },
    };
  });
  const keys = targets.map((target) => target.service_key);
  if (new Set(keys).size !== keys.length) throw badRequest("targets must not name the same service twice");

  if (!Array.isArray(record.order) || record.order.length === 0) throw badRequest("order must be a non-empty array of dependency levels");
  const order: string[][] = record.order.map((levelRaw) => {
    if (!Array.isArray(levelRaw)) throw badRequest("each order level must be an array of service keys");
    return levelRaw.map((keyRaw) => validateServiceKey(typeof keyRaw === "string" ? keyRaw : ""));
  });
  const ordered = order.flat();
  if (ordered.length !== keys.length || ordered.some((key) => !keys.includes(key)) || new Set(ordered).size !== ordered.length) {
    throw badRequest("order must list every target exactly once");
  }
  // The upload is required exactly when something is built from it, and refused
  // when nothing is: an upload nothing can build from would be consumed (and its
  // bytes copied) for no reason, and it means the caller and the targets disagree
  // about what this deployment is.
  const buildsFromSource = targets.some(targetIsBuilt);
  if (buildsFromSource && uploadId === null) throw badRequest("upload_id is required: at least one target is built from source");
  if (!buildsFromSource && uploadId !== null) throw badRequest("upload_id must be omitted: every target names an already-built image, so there is nothing to build");
  // Deployment-level, because a builder is: one machine builds every target of
  // one deployment, so there is a single size to state. Absent = let the build
  // shape decide, which is the only thing that CAN decide it (whether the build
  // is auto-detected is derived from the targets, not declared by the caller).
  //
  // Not floored here — the builder does that at the point the machine is
  // created, where "is this a Railpack build" is already known. The ladder is the
  // same on both runtimes.
  const builderRaw = record.builder;
  let builderMemoryMb: number | null = null;
  if (builderRaw !== undefined && builderRaw !== null) {
    const builder = asRecord(builderRaw);
    if (builder === null) throw badRequest("builder must be an object");
    const requested = builder.memory_mb;
    if (requested !== undefined && requested !== null) {
      if (typeof requested !== "number" || !Number.isInteger(requested) || !Object.hasOwn(BUILDER_MACHINE_BY_MEMORY_MB, requested)) {
        const sizes = Object.keys(BUILDER_MACHINE_BY_MEMORY_MB).map(Number).sort((a, b) => a - b).join(", ");
        throw badRequest(`builder.memory_mb must be one of ${sizes}`);
      }
      builderMemoryMb = requested;
    }
  }
  return { uploadId, targets, order, builderMemoryMb };
}

// A relative path with nothing that could break the harness's TSV manifest or
// escape its own directory. Kept in one place so root_directory and
// dockerfile_path cannot drift apart.
function validateOptionalRelativePath(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 512) throw badRequest(`${label} must be a string of at most 512 characters`);
  if (value === ".") return undefined;
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (
    normalized.startsWith("/")
    || normalized.includes("\\")
    // eslint-disable-next-line no-control-regex
    || /[\x00-\x1f\t]/.test(normalized)
    || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw badRequest(`${label} must be a normalized relative path inside the uploaded source (no leading "/", no "." or ".." segments, no backslashes, tabs or control characters)`);
  }
  return normalized;
}

/**
 * Accepts a deployment: validates it, consumes the upload, and starts the build.
 * Returns as soon as the builder is running — the applies follow, driven by
 * reads (see advanceDeployment).
 *
 * `builderFor` picks the builder once the namespace's runtime is known: the mock one in
 * dev/e2e, and otherwise the runtime's own.
 */
export async function startSourceDeployment(ns: string, sourceId: string, body: unknown, builderFor: (provider: RuntimeProvider) => Builder, requestedRuntime?: DeploymentRuntime): Promise<Deployment> {
  const provider = await providerForNamespace(ns, requestedRuntime);
  const builder = builderFor(provider);
  const { uploadId, targets, order, builderMemoryMb } = validateDeploymentRequest(body, provider.kind);
  // Targets that need the builder, and targets that already have their image.
  // Everything below branches on THIS rather than on "does the target have an
  // image", so that a future source of prebuilt images (one Marshal has to mirror
  // before it can run, say) changes only what fills these two lists.
  const buildTargets = targets.filter(targetIsBuilt);
  const prebuiltTargets = targets.filter((target) => !targetIsBuilt(target));
  return await withReconciliationLease(ns, sourceLeaseKey(sourceId), async (lease) => {
    // A prebuilt target's image goes into the deployment exactly as the author
    // wrote it, normalized but NOT resolved: Marshal never contacts the image's
    // registry, and the runtime resolves whatever this names when it pulls.
    //
    // What that costs the caller, stated once here because it is the whole contract for a tag:
    //   - The bytes a tag names are fixed by the provider at pull time, not by this request.
    //   - A redeploy of an unchanged tag is a no-op: the machine config is
    //     identical, so the config hash matches and nothing is pulled again.
    //     Moving forward onto a republished tag means changing the reference.
    //   - A reference that does not exist is the provider's error at apply time, not a
    //     400 on this request — and on a mixed deployment that lands after the
    //     build has already run.
    // An author who wants none of that writes a digest, which is fixed by
    // definition. `pinToDigest` records which bytes actually ran either way.
    // Prototype-less: a service key is author-chosen and `__proto__` passes the
    // id rules, but `{}["__proto__"] = ref` invokes the prototype setter instead
    // of creating an own property — so the image would vanish and the deploy
    // would fail with "no image was built for __proto__". `lookup` already reads
    // through Object.hasOwn; this makes the WRITE agree with it.
    const prebuiltImages: Record<string, string> = Object.create(null);
    for (const target of prebuiltTargets) {
      prebuiltImages[target.service_key] = validateImageRef(target.image, `target ${target.service_key} image`).canonical;
    }

    // Validate the archive before anything else touches it: the presigned PUT the
    // client used stays valid until it expires, so building from it directly would
    // leave a validation-to-extraction race even after strict tar validation.
    // Skipped entirely when nothing is built — there is no upload in that case
    // (validateDeploymentRequest refuses one).
    let validatedArchive: Uint8Array | null = null;
    if (uploadId !== null) {
      const upload = await statUpload(ns, uploadId);
      if (upload === null) throw badRequest(`upload ${JSON.stringify(uploadId)} does not exist (expired, already consumed, or never uploaded)`);
      if (upload.sizeBytes > MAX_UPLOAD_BYTES) throw badRequest(`upload is ${upload.sizeBytes} bytes; the maximum is ${MAX_UPLOAD_BYTES}`);
      const archive = await loadAndValidateSourceArchive(async () => await readUpload(ns, uploadId, upload.etag, MAX_UPLOAD_BYTES));
      if (archive === null) throw badRequest(`upload ${JSON.stringify(uploadId)} disappeared, changed, or exceeded the size limit before it could be consumed`);
      validatedArchive = archive;
    }

    const now = Date.now();
    // Minted from `now` so the id's embedded time never runs ahead of
    // started_at_millis.
    const deploymentId = ulid(now);
    // Nothing to build means nothing to wait for: the deployment opens straight
    // in "deploying" and the first read advances it, rather than sitting in
    // "building" for a webhook that no builder will ever call. It also has no
    // build log, so `has_logs` says so instead of offering an empty one.
    const buildsFromSource = buildTargets.length > 0;
    const deployment: StoredDeployment = {
      id: deploymentId,
      ns,
      source_id: sourceId,
      status: buildsFromSource ? "building" : "deploying",
      has_logs: buildsFromSource,
      error: null,
      started_at_millis: now,
      finished_at_millis: null,
      order,
      targets,
      services: Object.fromEntries(targets.map((target) => [target.service_key, {
        service_key: target.service_key,
        // A prebuilt target is never "building": its image already exists. It
        // waits in "pending" like any service whose turn in the dependency order
        // has not come — including while a SIBLING builds, since the applies of a
        // mixed deployment all start once the build lands.
        status: targetIsBuilt(target) ? "building" as const : "pending" as const,
        revision: null,
        url: null,
        // Filled in by the apply. A prebuilt target's image is already known
        // (it is in `images`), but this field says what RAN, not what will.
        image: null,
        error: null,
      }])),
      // Prebuilt targets are resolved before the deployment exists; the build
      // fills in the rest.
      images: prebuiltImages,
      builder_app: null,
      builder_machine_id: null,
      builder_memory_mb: builderMemoryMb,
      upload_id: uploadId,
    };

    // Copy the validated bytes to a deployment-specific key the client cannot
    // overwrite, then record the deployment BEFORE starting the builder:
    // completion may land at any moment after startBuild, and a blind write
    // afterwards could clobber a terminal record.
    await lease.assertOwned();
    if (validatedArchive !== null) await writeValidatedUpload(ns, deploymentId, validatedArchive);
    await lease.assertOwned();
    if (await createDeployment(deployment) === null) throw new Error(`deployment id collision for ${deploymentId}`);

    // No build, no builder machine, no upload to consume: the deployment is
    // already "deploying" and the caller's next poll applies its first service.
    if (!buildsFromSource) {
      return deploymentToApiShape(await readDeployment(ns, deploymentId) ?? deployment);
    }

    // Not reachable: `buildsFromSource` is what got us past the early return, and
    // it is exactly the condition under which validateDeploymentRequest requires
    // an upload. Stated so the builder call needs no assertion.
    if (uploadId === null) throw new Error("internal: a source build reached the builder without an upload");

    try {
      await lease.assertOwned();
      const started = await builder.startBuild({
        ns,
        deploymentId,
        uploadId,
        // Only the targets that are actually built. A prebuilt sibling has no
        // Dockerfile, nothing to detect, and nothing to push.
        targets: await Promise.all(buildTargets.map(async (target) => ({
          serviceKey: target.service_key,
          pushTarget: await provider.pushTarget(ns, target.service_key, deploymentId),
          dockerfilePath: target.dockerfile_path ?? null,
          rootDirectory: target.root_directory ?? null,
          // Null unless the target builds from a GENERATED Dockerfile, which is
          // also the only case where `image` is a base rather than the thing to
          // run — so the builder never has to re-derive which of the two it is.
          baseImage: targetUsesGeneratedDockerfile(target) ? target.image ?? BASE_IMAGE : null,
          buildCommand: target.build_command ?? null,
          buildEnv: buildTimeEnv(target.spec.env),
        }))),
        builderMemoryMb,
      }, lease);
      if (started.builderApp !== null || started.builderMachineId !== null) {
        // Attach the builder coordinates (live-log proxy + stale-build backstop need
        // them) — but only if the build hasn't already reached a terminal state.
        const current = await readDeploymentVersioned(ns, deploymentId);
        if (current !== null && current.value.status === "building") {
          await lease.assertOwned();
          await replaceDeployment({ ...current.value, builder_app: started.builderApp, builder_machine_id: started.builderMachineId }, current.etag);
        }
      }
    } catch (error) {
      if (isReconciliationFencingError(error)) throw error;
      const current = await readDeploymentVersioned(ns, deploymentId);
      if (current !== null && current.value.status === "building") {
        await lease.assertOwned();
        await replaceDeployment(failDeployment(current.value, "starting the build failed"), current.etag);
      }
      await deleteValidatedUploadBestEffort(ns, deploymentId);
      throw error;
    }
    // Consume the upload only once the build owns its own copy of the bytes.
    // (Non-null: an all-prebuilt deployment returned above, before the builder.)
    await deleteUploadBestEffort(ns, uploadId);
    return deploymentToApiShape(await readDeployment(ns, deploymentId) ?? deployment);
  });
}

/**
 * The deployment-level outcome for one service, from the state its apply reported.
 *
 * REGRESSION GUARD: this used to special-case only "blocked" and call everything
 * else "deployed", so a runtime apply that FAILED was recorded as a success and
 * the deployment went on to report "succeeded" over it.
 *
 * Three things mean the apply did not converge and never will on its own:
 *
 *   - "blocked": a ref could not resolve — a `url` of a service that never came
 *     up. Nothing later in this deployment makes it resolvable.
 *   - "failed": the apply threw and left zero running instances. That error is
 *     caught INSIDE applyServiceSpec and stored as last_apply_error rather than
 *     rethrown, so it reaches callers only through the reported state — never
 *     through their own catch.
 *   - a non-null error under any other status ("degraded", when the same stored
 *     error left some runtime instances up): partially rolled, still broken.
 *
 * `error` is the load-bearing signal rather than the status: getServiceState
 * sets it only for unresolved refs or a stored last_apply_error, and
 * last_apply_error is cleared on every successful apply and on every spec change
 * — so it is never stale. That is also what keeps a "degraded" caused merely by
 * an under-scaled runtime (which carries no error) counted as deployed, instead of
 * failing deploys for a transient scale-up.
 */
export function deploymentStateForApply(serviceKey: string, image: string, applied: { revision: string, state: ServiceState, imageRef: string | null }): DeploymentServiceState {
  // What the provider accepted for the running revision. The requested reference is the
  // fallback for an apply that created no runtime.
  const ran = applied.imageRef ?? image;
  const failed = applied.state.status === "blocked" || applied.state.status === "failed" || applied.state.error !== null;
  if (!failed) {
    return { service_key: serviceKey, status: "deployed", revision: applied.revision, url: applied.state.outputs.url ?? null, image: ran, error: null };
  }
  return {
    service_key: serviceKey,
    status: "failed",
    revision: applied.revision,
    url: null,
    // Reported on a FAILURE too: "which image" is most of the question when an
    // apply fails, and the apply did happen with this one.
    image: ran,
    error: applied.state.error ?? (applied.state.status === "blocked" ? "a connection could not be resolved" : `${serviceKey} failed to deploy`),
  };
}

/** Marks a deployment failed, and everything it had not finished as skipped. */
function failDeployment(deployment: StoredDeployment, error: string): StoredDeployment {
  return {
    ...deployment,
    status: "failed",
    error: truncateError(error),
    finished_at_millis: deployment.finished_at_millis ?? Date.now(),
    services: Object.fromEntries(Object.entries(deployment.services).map(([key, service]) => [
      key,
      service.status === "deployed" || service.status === "failed" ? service : { ...service, status: "skipped" as const },
    ])),
  };
}

/**
 * Build completion — the webhook and the mock builder both land here.
 *
 * A build either produced every image or the deployment fails: one machine
 * builds them all in order, so a failure means the rest never ran. There is no
 * half-built source to salvage, and shipping the targets that happened to be
 * first is not what the author asked for.
 */
export async function completeBuild(options: {
  ns: string,
  deploymentId: string,
  status: "succeeded" | "failed",
  metadataJson: string | null,
  errorText: string | null,
}): Promise<void> {
  const existing = await readDeployment(options.ns, options.deploymentId);
  if (existing === null) return;
  const provider = await providerForNamespace(options.ns);
  try {
    await withReconciliationLease(options.ns, sourceLeaseKey(existing.source_id), async (lease) => {
      const current = await readDeploymentVersioned(options.ns, options.deploymentId);
      // Terminal already (a retried webhook, or the stale-build backstop got there
      // first): the first outcome wins.
      if (current === null || current.value.status !== "building") return;
      await lease.assertOwned();

      if (options.status === "failed") {
        await replaceDeployment(failDeployment(current.value, options.errorText ?? "the build failed"), current.etag);
        await persistDeploymentLog(provider, current.value);
        await deleteValidatedUploadBestEffort(options.ns, options.deploymentId);
        return;
      }

      const images = parseBuildImages(provider, options.metadataJson, current.value);
      // Only the targets that were BUILT need a digest from the build. A prebuilt
      // target was resolved when the deployment was created and is already in
      // `images`; asking the build for one would fail every mixed deployment.
      const missing = current.value.targets
        .filter((target) => targetIsBuilt(target) && lookup(images, target.service_key) === undefined)
        .map((target) => target.service_key);
      if (missing.length > 0) {
        // The harness reports a digest per target; a missing one means the build
        // ended in a state Marshal cannot map to images, which is a failure rather
        // than something to half-apply.
        await replaceDeployment(failDeployment(current.value, `the build reported no image for ${missing.join(", ")}`), current.etag);
        await persistDeploymentLog(provider, current.value);
        await deleteValidatedUploadBestEffort(options.ns, options.deploymentId);
        return;
      }

      await replaceDeployment({
        ...current.value,
        status: "deploying",
        // MERGED, not replaced: the prebuilt entries were resolved before the build
        // started and the build knows nothing about them.
        images: { ...current.value.images, ...images },
        services: Object.fromEntries(Object.entries(current.value.services).map(([key, service]) => [key, { ...service, status: "pending" as const }])),
      }, current.etag);
      await persistDeploymentLog(provider, current.value);
      await deleteValidatedUploadBestEffort(options.ns, options.deploymentId);
    });
  } finally {
    await provider.deleteBuilder(existing);
  }
}

/**
 * The images a completed build produced, keyed by service key.
 *
 * Digests are resolved into fully-qualified image refs here rather than in the
 * harness: the registry host and repository name are Marshal's to know, and a
 * harness that composed them would have to be trusted about which repository it
 * pushed to.
 */
function parseBuildImages(provider: RuntimeProvider, metadataJson: string | null, deployment: StoredDeployment): Record<string, string> {
  // Prototype-less for the same reason as prebuiltImages: see startSourceDeployment.
  const images: Record<string, string> = Object.create(null);
  let parsed: unknown;
  try {
    parsed = metadataJson === null ? null : JSON.parse(metadataJson);
  } catch {
    parsed = null;
  }
  const targets = asRecord(asRecord(parsed)?.targets ?? null);
  if (targets === null) return images;
  for (const target of deployment.targets) {
    // A target that was not built never entered the build, so a digest reported
    // for it would not be one this build pushed. (An `image` with a build command
    // WAS built — it is a base, not the thing to run — so this asks the shared
    // predicate rather than looking at `image`.)
    if (!targetIsBuilt(target)) continue;
    const digest = targets[target.service_key];
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) continue;
    images[target.service_key] = provider.builtImageRef(deployment, target.service_key, digest);
  }
  return images;
}

/**
 * Moves a deploying deployment forward by AT MOST ONE service, and returns its
 * current state.
 *
 * One service per call rather than a whole level: an apply rolls runtime resources and
 * waits for them, so a call that drained a level could outlive the caller's
 * timeout — and the backend polls, so a bounded step per poll converges just as
 * fast while keeping every request short enough to answer.
 *
 * Contention is not an error here: if another request holds the source lease,
 * it is already doing this work, so this one simply reports what it can see.
 */
export async function advanceDeployment(ns: string, deploymentId: string): Promise<Deployment> {
  const deployment = await readDeployment(ns, deploymentId);
  if (deployment === null) throw notFound(`deployment ${JSON.stringify(deploymentId)} not found in namespace ${JSON.stringify(ns)}`);
  if (deployment.status === "building") {
    return deploymentToApiShape(await maybeFinalizeStaleDeployment(deployment));
  }
  if (deployment.status !== "deploying") return deploymentToApiShape(deployment);

  let advanced: StoredDeployment | null = null;
  try {
    advanced = await withReconciliationLease(ns, sourceLeaseKey(deployment.source_id), async (lease) => {
      const current = await readDeploymentVersioned(ns, deploymentId);
      if (current === null || current.value.status !== "deploying") return current?.value ?? null;
      return await applyNextService(ns, current.value, lease);
    }, DEPLOYMENT_ADVANCE_TIMINGS);
  } catch (error) {
    if (error instanceof ReconciliationLeaseLostError) {
      // Somebody else is advancing this source right now. Report what is
      // stored rather than failing a read that asked a perfectly good question.
      return deploymentToApiShape(await readDeployment(ns, deploymentId) ?? deployment);
    }
    throw error;
  }
  return deploymentToApiShape(advanced ?? deployment);
}

/**
 * Applies the next pending service of the current level, or closes the
 * deployment when everything has been applied.
 */
async function applyNextService(ns: string, deployment: StoredDeployment, lease: ReconciliationLeaseGuard): Promise<StoredDeployment> {
  // The PORTS AND VISIBILITY of every target in this deployment, so a reference
  // to one of them resolves without waiting for it to be applied first — which is
  // what keeps a private `url(5432)` independent of deploy order.
  //
  // Both halves have to come from here, not just the ports. They are two halves
  // of ONE decision (which address a `url` resolves to), and reading visibility
  // from the target's STORED spec while reading its ports from this deployment
  // lets the two disagree: a service being flipped public→private in this very
  // deploy still reads as public until its own apply lands, so a sibling applied
  // first bakes in a platform URL that the flip is about to take away.
  const knownTargets = new Map(deployment.targets.map((target) => [target.service_key, {
    type: target.spec.config.type,
    ports: target.spec.config.ports,
    public: target.spec.config.public,
  }]));

  for (const level of deployment.order) {
    const levelStates = level.flatMap((key) => {
      const state = lookup(deployment.services, key);
      return state === undefined ? [] : [state];
    });
    // A failure anywhere fails the whole deployment: the services after it
    // depend on this level having converged, and shipping them against a
    // half-rolled-out dependency is worse than stopping.
    if (levelStates.some((state) => state.status === "failed")) {
      return await writeDeployment(ns, deployment, failDeployment(deployment, deployment.error ?? "a service failed to deploy"));
    }
    const next = levelStates.find((state) => state.status === "pending");
    if (next === undefined) continue; // this level is done; look at the next one

    const target = deployment.targets.find((candidate) => candidate.service_key === next.service_key);
    const image = lookup(deployment.images, next.service_key);
    if (target === undefined || image === undefined) {
      return await writeDeployment(ns, deployment, failDeployment(deployment, `no image was built for ${next.service_key}`));
    }
    await lease.assertOwned();
    let state: DeploymentServiceState;
    try {
      const applied = await applyServiceSpec(ns, next.service_key, { ...target.spec, source: { image } }, { knownTargets });
      state = deploymentStateForApply(next.service_key, image, applied);
    } catch (error) {
      if (isReconciliationFencingError(error)) throw error;
      // Same as applyServiceSpecWithLease: log the real error, store only text we wrote.
      console.error(`deployment ${deployment.id}: applying service ${next.service_key} failed`, error);
      state = { service_key: next.service_key, status: "failed", revision: null, url: null, image, error: truncateError(applyErrorMessage(error)) };
    }
    const updated: StoredDeployment = { ...deployment, services: { ...deployment.services, [next.service_key]: state } };
    if (state.status === "failed") {
      return await writeDeployment(ns, deployment, failDeployment(updated, state.error ?? `${next.service_key} failed to deploy`));
    }
    return await writeDeployment(ns, deployment, updated);
  }

  // Nothing left pending: every service of every level is deployed.
  return await writeDeployment(ns, deployment, {
    ...deployment,
    status: "succeeded",
    finished_at_millis: deployment.finished_at_millis ?? Date.now(),
  });
}

async function writeDeployment(ns: string, previous: StoredDeployment, next: StoredDeployment): Promise<StoredDeployment> {
  const current = await readDeploymentVersioned(ns, previous.id);
  if (current === null) return next;
  const etag = await replaceDeployment(next, current.etag);
  // Losing the CAS means another request advanced it first; its view is the one
  // that counts.
  return etag === null ? (await readDeployment(ns, previous.id)) ?? next : next;
}

export function deploymentToApiShape(deployment: StoredDeployment): Deployment {
  return {
    id: deployment.id,
    source_id: deployment.source_id,
    status: deployment.status,
    has_logs: deployment.has_logs,
    error: deployment.error,
    started_at_millis: deployment.started_at_millis,
    finished_at_millis: deployment.finished_at_millis,
    // In the order the deployment applies them, which is the order a reader
    // wants to see progress in.
    services: deployment.order.flat().flatMap((key) => {
      const state = lookup(deployment.services, key);
      // `image` is normalized rather than passed through: records stored before
      // it existed have no such field, and the contract declares it present-
      // or-null. Without this the runtime would omit a key it says it returns.
      return state === undefined ? [] : [{ ...state, image: state.image ?? null }];
    }),
  };
}

function truncateError(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_ERROR_LENGTH ? `${trimmed.slice(0, MAX_ERROR_LENGTH)}…` : trimmed;
}

async function deleteValidatedUploadBestEffort(ns: string, deploymentId: string): Promise<void> {
  try {
    await deleteValidatedUpload(ns, deploymentId);
  } catch (error) {
    // The object contains already-validated source and expires with the bucket lifecycle;
    // cleanup must never prevent a terminal deployment record or its rollout from completing.
    console.error(`deleting validated source for deployment ${ns}/${deploymentId} failed`, error);
  }
}

async function deleteUploadBestEffort(ns: string, uploadId: string): Promise<void> {
  try {
    await deleteUpload(ns, uploadId);
  } catch (error) {
    console.error(`deleting consumed upload ${ns}/${uploadId} failed`, error);
  }
}

// Durable build log: Marshal drains the builder machine's output at terminal state through
// the provider, scrubs every credential it handed to the build, and persists JSONL to the
// bucket — outliving the provider's own retention.
//
// One log per DEPLOYMENT, covering every service it built: they shared a machine,
// so their output is interleaved in one stream and there is nothing to split.
async function persistDeploymentLog(provider: RuntimeProvider, deployment: StoredDeployment): Promise<void> {
  if (deployment.builder_app === null || deployment.builder_machine_id === null) {
    // Mock builds: a canned log so the has_logs contract holds in dev/e2e, and the only
    // vehicle e2e has for the redaction contract — the mock builder starts no machine, so
    // there are no real build logs to scrub. The lines stand in for what a real build could
    // print: MARSHAL_MOCK_ENV echoes each target's resolved plain values (a build step
    // echoing its own env is exactly the leak stage-1 redaction exists to catch), and
    // MARSHAL_BUILD_ENV_KEYS lists the NAMES that target's build was given, which is how
    // e2e sees the buildTimeEnv selection rule (plain values in, refs out) end to end.
    const lines = [
      { at_millis: deployment.started_at_millis, stream: "stdout" as const, instance: null, text: "MARSHAL_BUILD_START (mock builder)" },
      // Only the targets that were actually BUILT. A prebuilt target never
      // entered the builder, so claiming a build env for it would let an e2e
      // assertion pass for a channel production never gives it.
      ...deployment.targets.filter(targetIsBuilt).flatMap((target, index) => {
        const buildEnv = buildTimeEnv(target.spec.env);
        return [
          { at_millis: deployment.started_at_millis + index * 2 + 1, stream: "stdout" as const, instance: null, text: `MARSHAL_TARGET_START ${target.service_key}` },
          { at_millis: deployment.started_at_millis + index * 2 + 2, stream: "stdout" as const, instance: null, text: `MARSHAL_BUILD_ENV_KEYS ${target.service_key} ${Object.keys(buildEnv).sort().join(" ")}` },
          { at_millis: deployment.started_at_millis + index * 2 + 3, stream: "stdout" as const, instance: null, text: `MARSHAL_MOCK_ENV ${target.service_key} ${Object.entries(buildEnv).map(([envKey, value]) => `${envKey}=${value}`).join(" ")}` },
        ];
      }),
      { at_millis: Date.now(), stream: "stdout" as const, instance: null, text: "MARSHAL_BUILD_DONE (mock builder)" },
    ];
    const redactionValues = deploymentLogRedactionValues(provider, deployment);
    await writeDeploymentLog(deployment.ns, deployment.id, lines
      .map((line) => ({ ...line, text: redactBuildLogText(line.text, redactionValues) }))
      .map((line) => JSON.stringify(line))
      .join("\n"));
    return;
  }
  try {
    const lines = await provider.builderLogsDrain(deployment, deploymentLogRedactionValues(provider, deployment));
    // Skip persisting an empty log object: a transient logs-API failure (rate limit,
    // ingestion lag) must not freeze `has_logs:true, lines:[], complete:true`. Leaving no
    // object makes the logs route fall back to the live proxy instead.
    if (lines.length === 0) return;
    await writeDeploymentLog(deployment.ns, deployment.id, lines.map((line) => JSON.stringify(line)).join("\n"));
  } catch (error) {
    // Log persistence is best-effort — the record's terminal status must not be blocked
    // on the logs API. The live proxy already served these lines during the build.
    console.error(`persisting build log for ${deployment.ns}/${deployment.id} failed`, error);
  }
}

/**
 * Stage-1 redaction values: every credential Marshal handed the build, plus the
 * tenant's own build-time env values.
 *
 * The provider contributes its own credentials (the Fly org token and registry auth; nothing
 * on GCP, whose registry token is minted on the VM). The per-deployment webhook token is
 * recomputed because it is derived, not stored. The presigned tarball URL isn't
 * recomputable, so its signature is scrubbed by shape in redactBuildLogText.
 *
 * Every plain env value of every target is scrubbed, not a chosen subset: one env
 * channel with no build/runtime marker means Marshal cannot tell a publishable
 * API URL from a database password, and the only safe default is to treat all of
 * them as the latter. They come from the deployment's own targets rather than
 * from current specs, so a value edited after the build is still scrubbed from
 * that build's log.
 *
 * Values shorter than MIN_REDACTED_ENV_VALUE_LENGTH are one exception, and it is
 * about legibility rather than secrecy: "1", "true" and "3000" occur all over an
 * ordinary build log, so scrubbing them turns it into a wall of <redacted> that hides
 * the build's actual output while protecting nothing worth hiding.
 *
 * UNREDACTED_ENV_KEY_REGEX is the other: CI provenance is the deploy's own commit, which
 * the build log exists to show, and scrubbing it costs far more than it protects.
 */
export function deploymentLogRedactionValues(provider: RuntimeProvider, deployment: StoredDeployment): string[] {
  const values = [...provider.buildRedactionValues(), computeWebhookToken(deployment.id, deployment.ns)];
  for (const target of deployment.targets) {
    for (const [key, value] of Object.entries(buildTimeEnv(target.spec.env))) {
      if (UNREDACTED_ENV_KEY_REGEX.test(key)) continue;
      if (value.length >= MIN_REDACTED_ENV_VALUE_LENGTH) values.push(value);
    }
  }
  return values;
}

/**
 * Lazy backstop for lost webhooks: a deployment still building long after the
 * harness watchdog must have fired gets finalized as failed on the next read.
 */
export async function maybeFinalizeStaleDeployment(deployment: StoredDeployment): Promise<StoredDeployment> {
  if (deployment.status !== "building") return deployment;
  const staleAfterMillis = deployment.started_at_millis + BUILD_TIMEOUT_SECONDS * 1000 + BUILD_STALE_GRACE_MS;
  if (Date.now() < staleAfterMillis) return deployment;
  const provider = await providerForNamespace(deployment.ns);
  const liveness = await provider.builderLiveness(deployment);
  // A transient provider error must not turn a read into a 502 — leave the deployment
  // as-is until the next read.
  if (liveness === null) return deployment;
  if (liveness.alive) return deployment;
  const current = await readDeploymentVersioned(deployment.ns, deployment.id);
  if (current === null || current.value.status !== "building") return current?.value ?? deployment;
  const failed = failDeployment(current.value, liveness.startupFailed
    ? `the builder failed to start; last output: ${liveness.tail}`
    : "the build did not report a result before its timeout");
  const etag = await replaceDeployment(failed, current.etag);
  const result = etag === null ? (await readDeployment(deployment.ns, deployment.id)) ?? failed : failed;
  await provider.deleteBuilder(result);
  return result;
}

// ---------------------------------------------------------------------------
// Reads

export async function getServiceState(ns: string, key: string, preloadedSpec?: StoredSpec | null, knownTargets?: Map<string, KnownTarget>): Promise<ServiceState> {
  return await serviceStateWith(await providerForNamespace(ns), ns, key, preloadedSpec, knownTargets);
}

async function serviceStateWith(provider: RuntimeProvider, ns: string, key: string, preloadedSpec?: StoredSpec | null, knownTargets?: Map<string, KnownTarget>): Promise<ServiceState> {
  const stored = preloadedSpec !== undefined ? preloadedSpec : await readSpec(ns, key);
  if (stored === null) throw notFound(`service ${JSON.stringify(key)} not found in namespace ${JSON.stringify(ns)}`);

  // No build lookup: a spec always names an image that has already been built,
  // so a service is never "building". Building belongs to the DEPLOYMENT that
  // produced the image, which reports it (see advanceDeployment).
  const [observation, resolved, domains] = await Promise.all([
    provider.observeService(stored),
    // The SAME knownTargets the apply resolved with. Without it this read would re-resolve
    // from stored specs alone and report `blocked` for a private `url(port)` naming a target
    // of this deployment that has not been applied yet — failing the deployment over the
    // very ordering independence knownTargets exists to provide.
    resolveEnv(ns, stored.spec.env, knownTargets),
    provider.domains.statesFor(ns, key, stored),
  ]);

  const status: ServiceState["status"] = !resolved.ok
    ? "blocked"
    // Checked BEFORE the no-runtime branch: an apply that failed before it created anything
    // leaves zero instances and a terminal last_apply_error, and reporting that as "pending"
    // tells callers to keep waiting for a deploy that is already over.
    : stored.last_apply_error !== null
      ? observation.instances > 0 ? "degraded" : "failed"
      : !observation.exists
        ? "pending"
        : !observation.atTarget
          ? "deploying"
          : observation.instances === 0
            ? stored.spec.config.min_instances === 0 ? "idle" : "stopped"
            : observation.ready ? "running" : "degraded";
  return {
    key,
    // Echo back the type the caller actually stored.
    type: stored.spec.config.type,
    status,
    instances: observation.instances,
    revision: observation.revision,
    target_revision: observation.atTarget ? null : stored.revision,
    outputs: {
      // Non-null by contract. On Fly the hostname is a pure function of the service identity;
      // on GCP a service with no running VM has none, and the placeholder is a stable
      // stand-in that connection refs deliberately never use (see resolveEnv).
      hostname: observation.hostname ?? provider.hostnamePlaceholder(ns, key),
      internal_url: observation.internalUrl,
      url: observation.platformUrl,
    },
    domains,
    error: !resolved.ok
      ? `blocked on unresolved refs: ${resolved.blockedRefs.join(", ")}`
      : stored.last_apply_error ?? observation.error,
    observed_at_millis: Date.now(),
  };
}

export async function listServices(ns: string): Promise<ServiceState[]> {
  const keys = await listSpecKeys(ns);
  const states = await Promise.all(keys.sort().map(async (key) => {
    try {
      return await getServiceState(ns, key);
    } catch (error) {
      // A service deleted concurrently with this listing (its spec vanished between the key
      // list and the per-key read) must not 404 the whole namespace listing — drop it.
      if (error instanceof MarshalError && error.status === 404) return null;
      throw error;
    }
  }));
  return states.filter((state): state is ServiceState => state !== null);
}

// ---------------------------------------------------------------------------
// DELETE /services/{key}

export async function deleteService(ns: string, key: string): Promise<void> {
  const provider = await providerForNamespace(ns);
  await withReconciliationLease(ns, key, async (lease) => await deleteServiceWithLease(provider, ns, key, lease));
}

async function deleteServiceWithLease(provider: RuntimeProvider, ns: string, key: string, lease: ReconciliationLeaseGuard): Promise<void> {
  const stored = await readSpec(ns, key);
  // Release hostname claims first — the bucket registry would otherwise block the hostname
  // forever — and every runtime resource except persistent disks, which are addressed by
  // service + volume id and adopted on a later deploy of the same service id.
  await provider.domains.releaseForService(ns, key, stored, lease);
  await provider.deleteService(stored, ns, key, lease);
  const version = await readSpecVersioned(ns, key);
  await lease.assertOwned();
  if (version !== null) await deleteSpecConditionally(ns, key, version.etag);
}

export { providerFor, providerForNamespace, readDeployment, readSpec };
