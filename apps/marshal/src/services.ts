import { createHash } from "node:crypto";
import { buildEnvByteLength, buildTimeEnv, computeWebhookToken, type Builder } from "./builds.js";
import { BASE_IMAGE, BUILD_TIMEOUT_SECONDS, MACHINE_GUEST, MAX_BUILD_ENV_BYTES, MAX_COMMAND_LENGTH, MAX_INSTANCES_CAP, MAX_PERSISTENT_VOLUMES_PER_SERVICE, MAX_PORTS_PER_SERVICE, MAX_UPLOAD_BYTES, MAX_VOLUME_ID_LENGTH, MAX_VOLUME_SIZE_GB, MIN_REDACTED_ENV_VALUE_LENGTH, MIN_VOLUME_SIZE_GB, SOFT_CONCURRENCY_LIMIT, VOLUME_ID_REGEX, flyVolumeName, getConfig, resolveNamespaceOrg } from "./config.js";
import { applyErrorMessage } from "./apply-error.js";
import { MarshalError, badRequest, conflict, notFound } from "./errors.js";
import { FlyClient, flyClientForNamespaceOrg, type FlyCertificate, type FlyMachine, type FlyVolume } from "./fly/client.js";
import { fetchAllLogs } from "./logs.js";
import { appNameForService, hostnameForService, networkForNamespace } from "./naming.js";
import { MutationOutcomeUnknownError, RECONCILIATION_TAKEOVER_GRACE_MS } from "./mutation-safety.js";
import { redactSecrets } from "./redact.js";
import { ReconciliationLeaseLostError, withReconciliationLease, type ReconciliationLeaseGuard } from "./reconciliation-lock.js";
import { computeRevision } from "./revision.js";
import { reconcilePublicIps } from "./public-networking.js";
import { createDeployment, deleteSpecConditionally, deleteUpload, deleteValidatedUpload, listDomainClaimsForService, listSpecKeys, readDeployment, readDeploymentVersioned, readDomainClaimVersioned, readSpec, readSpecVersioned, readUpload, releaseDomainClaim, replaceDeployment, statUpload, writeDeploymentLog, writeSpec, writeValidatedUpload } from "./store.js";
import { validateSourceArchive } from "./source-archive.js";
import { isImageDigest, pinToDigest, validateImageRef } from "./image-ref.js";
import { portEntries, targetIsBuilt, targetUsesGeneratedDockerfile, type Deployment, type DeploymentServiceState, type DeploymentTarget, type DnsRecord, type EnvValue, type PortEntry, type PortsConfig, type ServiceDomainState, type ServiceSpec, type ServiceState, type StoredDeployment, type StoredSpec, type VolumeConfig } from "./types.js";
import { ulid } from "./ulid.js";

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
 * may contain dots (deployments declared in hexclave.config.ts belong to a
 * source named after the file), and it reaches an S3 key prefix only through the
 * lease, so traversal characters are what matter.
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

export function validateServiceSpec(body: unknown): ServiceSpec {
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
  // boundary that turns a spec into Fly machine config, and a bad port list
  // would otherwise reach the Fly API.
  // An EMPTY array is legal: a worker with nothing listening, which gets an empty
  // Fly `services` array. It only ever runs while pinned, since autostart lives on
  // a `services` entry — that is the caller's call to make, not ours to refuse.
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

  // Visibility belongs to the CONTAINER, not to a port — see PortConfig in
  // types.ts. Fly's `services` array is the proxy's listener set for the whole
  // APP with no per-address scoping, so every declared port answers on every IP
  // the app holds: "public 3000, private 5432" is not a thing the runtime can do,
  // and a per-port flag could only ever misdescribe it.
  const isPublic = config.public ?? false;
  if (typeof isPublic !== "boolean") throw badRequest("config.public must be a boolean");
  // A public service is all-HTTP. Raw TCP cannot take public ingress: a shared
  // public IPv4 tells apps apart by SNI (TLS) or Host (HTTP), and a raw stream
  // carries neither, so the edge accepts the connection and then drops it —
  // VERIFIED against real Fly. It would need a dedicated IPv4 per service, which
  // is a billing decision rather than a code change.
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
  // number (see externalPortsFor), and `services` entries are listeners on the
  // whole app. So a different port that is itself numbered 80 or 443 asks for an
  // external listener the holder has already taken — `{80: public, 443: public}`
  // makes 80 the holder, which claims 80 and 443, and the declared 443 claims
  // 443 a second time. Fly cannot serve one external port from two entries.
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
  // the caller's choice: 0 suspends the machine when idle (it resumes with its memory
  // intact) and 1 keeps it up. Rejecting min_instances 1 here would reject the default
  // every `server` deploys with, and it is exactly the pinning that isServerful() below
  // reads. Reject rather than coerce: the caller's stated bounds and its stated type would
  // otherwise disagree in the stored spec.
  if (serviceKind === "server" && (minInstances > 1 || maxInstances !== 1)) {
    throw badRequest('config.min_instances must be 0 or 1 and config.max_instances must be 1 when config.type is "server"');
  }

  // A Fly volume attaches to at most one machine, and a machine mounts at most one volume,
  // so only a single-instance "server" can hold one. min_instances 0 is still fine — a
  // suspended machine keeps its volume and resumes with it (smoke-verified).
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
      // The id becomes the Fly volume name (see flyVolumeName), so it has to survive that
      // mapping unchanged — no case folding, no character substitution, nothing that could
      // make two distinct ids name one disk.
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
  // Plain values ride to the builder machine inside its machine config (see
  // createFlyBuilder), so their total size is bounded by what one machine-create call will
  // accept. Enforced here rather than at build start so an oversized env is a 400 naming
  // the problem, not an opaque Fly rejection partway into a deploy. Refs don't count: they
  // resolve to machine env only.
  const buildEnvBytes = buildEnvByteLength(buildTimeEnv(Object.fromEntries(validatedEnv)));
  if (buildEnvBytes > MAX_BUILD_ENV_BYTES) {
    throw badRequest(`the env var values total ${buildEnvBytes} bytes, over the ${MAX_BUILD_ENV_BYTES}-byte limit (they are handed to the remote build, which puts them in the builder machine's configuration)`);
  }

  return {
    // Key order is canonical here too (see the source note below). `persistent_volumes` is
    // only present when set; computeRevision mirrors that same conditional spread.
    config: { type: serviceKind, public: isPublic, min_instances: minInstances, max_instances: maxInstances, ports, ...(persistentVolumes !== undefined ? { persistent_volumes: persistentVolumes } : {}), ...(startCommand !== undefined ? { start_command: startCommand } : {}) },
    // Key order is fixed here on purpose: computeRevision hashes the JSON serialization of
    // this object, so construction must stay canonical.
    source: { image },
    env: Object.fromEntries(validatedEnv),
  };
}

// ---------------------------------------------------------------------------
// Env ref resolution

// What a `url` reference needs to know about its target: which ports it declares
// and whether the SERVICE is public. Kept as one value so the two can never be
// sourced from different places — see targetOf.
export type KnownTarget = { ports: PortsConfig, public: boolean };

type ResolvedEnv =
  | { ok: true, env: Record<string, string> }
  | { ok: false, blockedRefs: string[] };

// `hostname` is a pure function of the service name. `url` names ONE port, so it
// needs to know that port's protocol and whether it is public — from the
// deployment's own targets when the target is part of this deploy (which is what
// keeps a private url() from depending on deploy ORDER), and otherwise from the
// target's stored spec.
export async function resolveEnv(fly: FlyClient, ns: string, env: Record<string, EnvValue>, knownTargets?: Map<string, KnownTarget>): Promise<ResolvedEnv> {
  const { envId } = getConfig();
  const resolved = new Map<string, string>();
  const blockedRefs: string[] = [];
  const urlCache = new Map<string, string | null>();
  const targetCache = new Map<string, KnownTarget | null>();
  // Ports AND visibility together: they are two halves of one decision (which
  // address a `url` resolves to), so reading them from different places lets a
  // service being flipped public→private in this very deploy resolve as public
  // for a sibling applied before it.
  const targetOf = async (targetKey: string): Promise<KnownTarget | null> => {
    const known = knownTargets?.get(targetKey);
    if (known !== undefined) return known;
    if (!targetCache.has(targetKey)) {
      const spec = await readSpec(ns, targetKey);
      targetCache.set(targetKey, spec === null ? null : { ports: spec.spec.config.ports, public: spec.spec.config.public });
    }
    return targetCache.get(targetKey) ?? null;
  };

  for (const [key, value] of Object.entries(env)) {
    if ("value" in value) {
      resolved.set(key, value.value);
      continue;
    }
    const match = REF_REGEX.exec(value.ref);
    if (match === null) {
      blockedRefs.push(value.ref);
      continue;
    }
    const [, targetKey, outputKey, namedPortText] = match;
    // Truthiness, not an undefined check: TS types an optional capture group as
    // `string` even though it is undefined at run time when it did not match.
    const namedPort = namedPortText ? Number(namedPortText) : null;
    switch (outputKey) {
      case "hostname": {
        resolved.set(key, hostnameForService(envId, ns, targetKey));
        break;
      }
      case "url": {
        // Which port the URL means, and what it looks like. The port picks the
        // number; the TARGET SERVICE's visibility picks the address:
        //  - a PUBLIC service resolves to its public URL (the platform URL, or a
        //    verified custom domain), which exists only once the service is up —
        //    so it blocks until then;
        //  - a PRIVATE service resolves to its internal address, built from the
        //    deterministic hostname and the port itself.
        const target = await targetOf(targetKey);
        if (target === null) {
          // Nothing known about the target: it may not have been deployed yet.
          blockedRefs.push(value.ref);
          break;
        }
        const ports = target.ports;
        const port = namedPort === null
          ? (() => {
            const sole = soleHttpPort(ports);
            return sole === null ? null : portEntries(ports).find((entry) => entry.port === sole) ?? null;
          })()
          : portEntries(ports).find((entry) => entry.port === namedPort) ?? null;
        if (port === null || port.protocol !== "http") {
          // The backend rejects both of these up front against the synced
          // definition; blocking rather than guessing means a spec that somehow
          // arrives unresolvable never deploys a container pointed at the wrong
          // port.
          blockedRefs.push(value.ref);
          break;
        }
        // Visibility is the TARGET SERVICE's, not the port's: a private service
        // resolves to its internal address, a public one to its platform URL.
        // Read from `target`, which prefers this deployment's own specs — see
        // targetOf. Reading it from the STORED spec instead reintroduced exactly
        // the deploy-order dependence knownTargets exists to remove.
        if (!target.public) {
          resolved.set(key, `http://${hostnameForService(envId, ns, targetKey)}:${port.port}`);
          break;
        }
        if (!urlCache.has(targetKey)) {
          urlCache.set(targetKey, await computeServiceUrl(fly, ns, targetKey));
        }
        const url = urlCache.get(targetKey) ?? null;
        if (url === null) {
          blockedRefs.push(value.ref);
        } else {
          // computeServiceUrl answers for the port that owns 80/443. Any OTHER
          // public port of a multi-port service is reachable on its own number
          // and nowhere else, so the ref has to carry it — otherwise every
          // public port of one service would resolve to the same URL and quietly
          // point at whichever one happened to be lowest.
          const holder = standardPortsHolderFor(ports, target.public);
          resolved.set(key, port.port === holder ? url : `${url}:${port.port}`);
        }
        break;
      }
      default: {
        // Unknown output keys block rather than 400 so adding output keys later is
        // backward-compatible: the backend re-applies once the runtime learns them.
        blockedRefs.push(value.ref);
      }
    }
  }
  if (blockedRefs.length > 0) return { ok: false, blockedRefs };
  return { ok: true, env: Object.fromEntries(resolved) };
}

function certificateIsVerified(certificate: FlyCertificate): boolean {
  return certificate.clientStatus === "Ready";
}

async function computeServiceUrl(fly: FlyClient, ns: string, key: string): Promise<string | null> {
  const { envId } = getConfig();
  const stored = await readSpec(ns, key);
  if (stored !== null && specIsPublic(stored.spec)) {
    return `https://${appNameForService(envId, ns, key)}.fly.dev`;
  }
  const certificates = await fly.listCertificates(appNameForService(envId, ns, key));
  const verified = certificates.filter(certificateIsVerified).map((certificate) => certificate.hostname).sort();
  return verified.length > 0 ? `https://${verified[0]}` : null;
}

// ---------------------------------------------------------------------------
// Machine reconciliation

function isServerful(spec: ServiceSpec): boolean {
  return spec.config.min_instances === 1 && spec.config.max_instances === 1;
}

function desiredMachineCount(spec: ServiceSpec): number {
  return isServerful(spec) ? 1 : spec.config.max_instances;
}

function pinnedMachineCount(spec: ServiceSpec): number {
  return isServerful(spec) ? 1 : spec.config.min_instances;
}

// The parts of a Fly machine config this module actually produces. Named rather
// than left as `Record<string, unknown>` so callers — the tests especially — can
// read `.services[].ports[].handlers` without a cast to get at it. Fly accepts
// far more than this; only what we send is described.
export type MachineConfig = {
  image: string,
  env: Record<string, string>,
  // Present only when the spec names a start command. `exec` replaces the
  // image's ENTRYPOINT and CMD both — see ContainerConfig.start_command.
  init?: { exec: string[] },
  mounts?: { volume: string, path: string }[],
  metadata: Record<string, string>,
  services: {
    protocol: string,
    internal_port: number,
    autostop: string,
    autostart: boolean,
    ports: { port: number, handlers?: string[] }[],
    concurrency: { type: string, soft_limit: number },
  }[],
  guest: { cpu_kind: string, cpus: number, memory_mb: number },
  restart: { policy: string, max_retries: number },
};

export function machineConfigForSlot(options: {
  imageRef: string,
  spec: ServiceSpec,
  revision: string,
  ns: string,
  key: string,
  slot: number,
  env: Record<string, string>,
  volumeId: string | null,
}): MachineConfig {
  const pinned = options.slot < pinnedMachineCount(options.spec);
  const volume = specVolume(options.spec)?.volume;
  const standardPortsHolder = standardPortsHolderFor(options.spec.config.ports, options.spec.config.public);
  const config = {
    image: options.imageRef,
    guest: MACHINE_GUEST,
    env: options.env,
    // A start command replaces what the image starts, entrypoint included: `exec`
    // is the only one of Fly's three init fields that does. (`cmd` alone is
    // passed TO the image's entrypoint as arguments — verified against real Fly
    // with nginx, whose docker-entrypoint.sh then ran the command as if it were
    // its own arguments.) Absent when there is none, so a spec without one hashes
    // and behaves exactly as before this existed.
    ...(options.spec.config.start_command !== undefined
      ? { init: { exec: ["/bin/sh", "-c", options.spec.config.start_command] } }
      : {}),
    // Only slot 0 can carry the volume, and a volume-backed spec is single-slot anyway
    // (type "server", enforced in validateServiceSpec). The volume id is part of the
    // hashed config on purpose: if the volume were ever replaced, the machine must roll onto
    // the new one rather than silently keep the old mount.
    ...(volume !== undefined && options.volumeId !== null && options.slot === 0
      ? { mounts: [{ volume: options.volumeId, path: volume.path }] }
      : {}),
    metadata: {
      hexclave_ns: options.ns,
      hexclave_key: options.key,
      hexclave_revision: options.revision,
      hexclave_slot: String(options.slot),
    },
    restart: { policy: "on-failure", max_retries: 2 },
    // One Fly services entry per declared port. Every port is reachable at its
    // OWN number (that is what makes several ports addressable at all), and the
    // service's single HTTP port additionally answers on 80/443 so its fly.dev
    // URL and any custom domain certificate work on the standard ports.
    services: portEntries(options.spec.config.ports).map((entry) => ({
      protocol: "tcp",
      internal_port: entry.port,
      // Pinned machines never autostop; the rest scale to zero and Fly Proxy autostarts
      // them on demand (only *existing* machines get autostarted, which is why the full
      // max_instances fleet is pre-created).
      //
      // A "server" SUSPENDS instead of stopping: it resumes with its memory intact and
      // without a cold start, and Fly leaves an attached volume and its data untouched
      // across suspend/resume. Suspend is only advisable at <= 2 GB of memory, which
      // MACHINE_GUEST (512 MB) satisfies. A "serverless" stops, so each start is cold from a
      // clean rootfs.
      autostop: pinned ? "off" : options.spec.config.type === "server" ? "suspend" : "stop",
      autostart: true,
      ports: externalPortsFor(entry, standardPortsHolder, options.spec.config.public),
      concurrency: {
        type: entry.protocol === "http" ? "requests" : "connections",
        soft_limit: SOFT_CONCURRENCY_LIMIT,
      },
    })),
  };
  // The config hash makes re-applies cheap no-ops and catches resolved-ref drift that the
  // revision (hashed over UNresolved env) deliberately ignores.
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
  return { ...config, metadata: { ...config.metadata, hexclave_config_hash: hash } };
}

// The spec's single persistent volume, or null. `persistent_volumes` is a record so the
// volume ID is a first-class key, but validateServiceSpec caps it at one entry, so every
// consumer wants exactly this.
/**
 * Whether the spec asks for public ingress. A property of the container, not of
 * any port.
 *
 * Compared against `true` rather than returned directly, despite the type: specs
 * live in the bucket, which no reset clears, and one written before `public`
 * existed has no such field. Such a spec reads as PRIVATE — the safe direction,
 * and it self-corrects on the next apply, which rewrites the spec from the
 * backend's definition.
 */
export function specIsPublic(spec: ServiceSpec): boolean {
  return spec.config.public === true;
}

/**
 * The one HTTP port a bare `url` can name, or null when the service leaves it
 * ambiguous (several HTTP ports) or impossible (none).
 */
export function soleHttpPort(ports: PortsConfig): number | null {
  const httpPorts = portEntries(ports).filter((entry) => entry.protocol === "http");
  return httpPorts.length === 1 ? httpPorts[0].port : null;
}

/**
 * The port that additionally answers on 80/443, or null when there is no single
 * obvious one.
 *
 * Defined for PRIVATE services too, not just public ones: a private service
 * gets public IPs the moment a custom domain is attached (see attachDomain), and
 * that domain terminates TLS on 443 — so a private service with one HTTP port
 * must bind the standard ports too, or its verified domain would resolve and
 * then refuse the connection.
 *
 * When a public service declares SEVERAL ports exactly one can hold 80/443, and it is the
 * LOWEST-NUMBERED — portEntries sorts numerically, so the winner is a property
 * of the port set rather than of JSON key ordering. Determinism is the point:
 * the holder is the port the service's bare URL names and the only one a custom
 * domain can front, so an arbitrary pick would silently move both. KEPT IN SYNC
 * WITH
 * standardPortsHolderPort in @hexclave/shared's deployments.ts, which
 * is what the backend reports to the CLI and dashboard from.
 */
export function standardPortsHolderFor(ports: PortsConfig, isPublic: boolean): number | null {
  if (!isPublic) return soleHttpPort(ports);
  // Filtered to HTTP defensively: a public service may declare no TCP port, so
  // on any valid spec this is simply the lowest port.
  const httpPorts = portEntries(ports).filter((entry) => entry.protocol === "http");
  return httpPorts.length === 0 ? null : httpPorts[0].port;
}

/**
 * The port rule for a service that holds (or is about to hold) a custom domain.
 *
 * A custom domain allocates public IPs on the service's app (see ensurePublicIps), so it
 * makes the service reachable exactly the way `public: true` does — so a service holding one
 * has to satisfy the same rules a public service does, whether or not it declares itself
 * public.
 *
 * Fly `services` are the proxy's listener set for the whole app with no per-address scoping,
 * so every declared port answers on every IP the app holds. A PRIVATE service with an HTTP
 * port next to a 5432 looks legal at sync time — nothing is public — but a domain on it puts
 * that 5432 on the internet.
 *
 * STRICTER THAN validateServiceSpec, and deliberately: that rule passes a wholly private
 * multi-port service, because a service nobody can reach leaks nothing. A domain is exactly
 * what makes it reachable, so at attach time those same siblings become the leak. The one
 * port a private service may front with a domain is its ONLY port — publishing it is what the
 * author asked the domain for. A PUBLIC service is fine at any port count: it is already
 * reachable, the domain simply fronts its standard-ports holder.
 *
 * BOTH places that can bring a domain and this port set together must call this: the attach
 * (domains.ts) and the spec write (applyServiceSpecWithLease). Checking only the attach
 * leaves the ports free to move afterwards — attach a domain to a lone HTTP port, then PUT a
 * `tcp` sibling, and the spec is legal at every gate while the proxy publishes it.
 * That is why this is one function and not a rule re-typed at each site.
 */
export function assertServiceCanHoldADomain(serviceKey: string, ports: PortsConfig, isPublic: boolean, remedy: string): void {
  const entries = portEntries(ports);
  if (!entries.some((entry) => entry.protocol === "http")) {
    throw badRequest(`custom domains need an HTTP port to route to; service ${JSON.stringify(serviceKey)} declares none. ${remedy}`);
  }
  if (!isPublic && entries.length > 1) {
    throw badRequest(`a private service holding a custom domain may not declare more than one port: the domain allocates public IPs, and the proxy serves every declared port on every address the app has, so the others would be published too. Service ${JSON.stringify(serviceKey)} declares ${entries.length} ports; make the service public, or move the others onto their own service and reach them with hostname(). ${remedy}`);
  }
  // The domain can only front the port that owns 80/443 — a certificate
  // terminates TLS there and nowhere else.
  if (standardPortsHolderFor(ports, isPublic) === null) {
    throw badRequest(`a custom domain needs one HTTP port to front, and service ${JSON.stringify(serviceKey)} leaves it ambiguous. ${remedy}`);
  }
}

/**
 * A port's external bindings, deduplicated.
 *
 * The dedupe is load-bearing: a container that listens on 80 or 443 (the default
 * for most web images) would otherwise get that number twice in one entry, and
 * for 443 with CONFLICTING handlers — plain `http` from its own binding and
 * `tls,http` from the standard one — leaving which wins up to Fly.
 */
export function externalPortsFor(entry: PortEntry, standardPortsHolder: number | null, isPublic: boolean): { port: number, handlers?: string[] }[] {
  if (entry.protocol !== "http") return [{ port: entry.port }];
  const bindings = new Map<number, { port: number, handlers?: string[] }>();
  // Its own number first, so a second HTTP port stays addressable...
  //
  // A PUBLIC SERVICE terminates TLS on that number, a private one does not. The
  // distinction is not cosmetic: on a public service a non-holder port's own
  // number is the ONLY way to reach it (the standard 80/443 belong to the
  // holder), so leaving it plain would put a port the author asked to publish on
  // the internet in cleartext — and the URL we hand back for it says https. A
  // private service is reached over Flycast as `http://<host>:<port>`, and
  // adding TLS there would break every private url() instead.
  bindings.set(entry.port, { port: entry.port, handlers: isPublic ? ["tls", "http"] : ["http"] });
  if (entry.port === standardPortsHolder) {
    // ...but the standard ports win the collision: 443 must terminate TLS, and
    // 80 stays plain HTTP (no force_https) because a private url() is http.
    bindings.set(80, { port: 80, handlers: ["http"] });
    bindings.set(443, { port: 443, handlers: ["tls", "http"] });
  }
  return [...bindings.values()];
}

export function specVolume(spec: ServiceSpec): { volumeId: string, volume: VolumeConfig } | null {
  const entries = Object.entries(spec.config.persistent_volumes ?? {});
  if (entries.length === 0) return null;
  return { volumeId: entries[0][0], volume: entries[0][1] };
}

// Fly does NOT enforce unique volume names within an app. The reconciliation lease prevents
// Marshal replicas from creating concurrently, but a process can still die after Fly accepts
// a create and before the bucket records the outcome. These helpers make recovery
// DETERMINISTIC — the currently-attached volume first, then the oldest id — so every later
// apply converges on the same disk. Choosing arbitrarily is the dangerous case: it would roll
// the machine onto another volume and the service would come up with an empty disk, which
// reads to the tenant as total data loss. Volumes being destroyed are never candidates.
export function candidateVolumes(volumes: FlyVolume[], volumeId: string): FlyVolume[] {
  const name = flyVolumeName(volumeId);
  return volumes
    .filter((candidate) => candidate.name === name && candidate.state !== "destroying" && candidate.state !== "pending_destruction")
    .sort((a, b) => {
      if ((a.attached_machine_id !== null) !== (b.attached_machine_id !== null)) return a.attached_machine_id !== null ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export function selectCanonicalVolume(volumes: FlyVolume[], volumeId: string): FlyVolume | null {
  const candidates = candidateVolumes(volumes, volumeId);
  return candidates.length === 0 ? null : candidates[0];
}

// Idempotently brings the service's single volume to the configured size, returning its id.
// Created BEFORE any machine: Fly places a machine on its volume's host, and creating the
// machine first would usually land it on a different host (then the mount fails).
async function ensureVolume(fly: FlyClient, appName: string, volumeId: string, volume: VolumeConfig, lease: ReconciliationLeaseGuard): Promise<string> {
  const config = getConfig();
  const candidates = candidateVolumes(await fly.listVolumes(appName), volumeId);
  if (candidates.length === 0) {
    await lease.assertOwned();
    const created = await fly.createVolume(appName, { name: flyVolumeName(volumeId), region: config.fly.region, size_gb: volume.size_gb });
    await fly.waitForVolumeListed(appName, created.id);
    // Re-list and re-select rather than trusting our own create. Two concurrent
    // applies can both see an empty list and both create a volume (Fly does not
    // enforce unique names), and if each then mounted the disk it made, the service
    // would come up as two machines backed by DIVERGENT data — writes split across
    // two disks, unmergeable. Re-selecting with the same deterministic rule makes
    // both applies converge on one canonical volume; the loser's create is orphaned
    // (logged below), and whichever apply gets there second is refused by Fly's
    // "volume already claimed" 412 instead of silently diverging.
    const canonical = selectCanonicalVolume(await fly.listVolumes(appName), volumeId);
    if (canonical === null) return created.id; // list raced the create; ours is all we know of
    if (canonical.id !== created.id) {
      console.error(`volume create race on ${appName}: adopted ${canonical.id}, orphaning ${created.id} (needs manual cleanup)`);
      // The orphan may be smaller than requested; the adopted one still has to grow.
      if (volume.size_gb > canonical.size_gb) {
        await lease.assertOwned();
        await fly.extendVolume(appName, canonical.id, volume.size_gb);
      }
    }
    return canonical.id;
  }
  const existing = candidates[0];
  if (volume.size_gb > existing.size_gb) {
    await lease.assertOwned();
    await fly.extendVolume(appName, existing.id, volume.size_gb);
  } else if (volume.size_gb < existing.size_gb) {
    // Fly volumes are grow-only, and shrinking would mean destroying tenant data. Fail the
    // deploy rather than silently ignoring the requested size: a no-op here would leave the
    // config claiming a size the service does not have and the tenant billed for the larger
    // disk, with nothing anywhere reporting the divergence.
    throw badRequest(
      `the volume is already ${existing.size_gb}GB and cannot be shrunk to ${volume.size_gb}GB (disks can only grow). `
      + `Set the volume size back to at least ${existing.size_gb}GB, or remove the volume from this service and redeploy to detach it — the existing disk is kept either way.`,
    );
  }
  return existing.id;
}

// Mount sets are compared by (volume id, path), order-insensitively. Any difference means
// the machine has to be recreated rather than updated — see the call site.
function mountsDiffer(a: { volume: string, path: string }[], b: { volume: string, path: string }[]): boolean {
  if (a.length !== b.length) return true;
  const key = (mount: { volume: string, path: string }) => `${mount.volume}\u0000${mount.path}`;
  const inA = new Set(a.map(key));
  return b.some((mount) => !inA.has(key(mount)));
}

/**
 * The digest Fly reports for a machine, or null when it reports nothing usable.
 *
 * VALIDATED, not merely null-checked. `image_ref.digest` is optional and typed
 * as a plain string, so an empty or malformed one is inside its declared type —
 * and `??` is nullish-only, so `""` would sail past a null check and compose
 * into `docker.io/library/redis@`: a reference recorded as "what ran" that names
 * nothing. The null the callers already handle is the right answer for anything
 * that is not a digest.
 */
export function reportedDigest(machine: FlyMachine): string | null {
  const digest = machine.image_ref?.digest;
  return digest !== undefined && isImageDigest(digest) ? digest : null;
}

/**
 * Rolls the service's machines onto `imageRef`, and reports the image Fly says
 * slot 0 is actually running.
 *
 * The two differ whenever `imageRef` names a tag: Marshal does not resolve
 * images, so the digest Fly reports back is the only record of which bytes the
 * tag pointed at. Slot 0 because it is the one machine every service has, and
 * because a mid-roll tag move would make the later slots disagree — which is a
 * property of tags, not something a second read here could fix.
 *
 * Null when Fly reports no digest (the mock Fly before it grew `image_ref`, or
 * a machine the roll left untouched and unread); callers fall back to the
 * reference as written.
 */
async function applyMachines(fly: FlyClient, stored: StoredSpec, imageRef: string, env: Record<string, string>, lease: ReconciliationLeaseGuard): Promise<string | null> {
  const config = getConfig();
  const appName = appNameForService(config.envId, stored.ns, stored.key);
  const network = networkForNamespace(config.envId, stored.ns);
  await lease.assertOwned();
  await fly.ensureApp(appName, network);
  await lease.assertOwned();
  await fly.ensureFlycastIp(appName, network);
  await lease.assertOwned();
  await reconcilePublicIps(fly, appName, specIsPublic(stored.spec) ? "public" : "private");

  const specVolumeEntry = specVolume(stored.spec);
  const volumeId = specVolumeEntry === null
    ? null
    : await ensureVolume(fly, appName, specVolumeEntry.volumeId, specVolumeEntry.volume, lease);

  const machines = await fly.listMachines(appName);
  const bySlot = new Map<number, FlyMachine>();
  let extras: FlyMachine[] = [];
  for (const machine of machines) {
    const slot = Number(machine.config.metadata?.hexclave_slot);
    if (Number.isInteger(slot) && slot >= 0 && !bySlot.has(slot)) {
      bySlot.set(slot, machine);
    } else {
      extras.push(machine);
    }
  }

  // A volume can only be claimed by one machine, so any leftover machine still holding it
  // must go BEFORE the slot loop tries to mount it — otherwise slot 0's create/update gets
  // Fly's 412 "volume already claimed", applyMachines throws before reaching the destroy
  // loop below, and every retry reproduces it identically (a permanently wedged service).
  // Scoped to claim-holders only: reordering the whole destroy loop would break the rolling
  // guarantee documented below.
  if (volumeId !== null) {
    const holdsVolume = (machine: FlyMachine) => (machine.config.mounts ?? []).some((mount) => mount.volume === volumeId);
    const claimHolders = extras.filter(holdsVolume);
    for (const machine of claimHolders) {
      await lease.assertOwned();
      await fly.destroyMachine(appName, machine.id);
    }
    extras = extras.filter((machine) => !holdsVolume(machine));
  }

  const count = desiredMachineCount(stored.spec);
  // Fly's resolution of `imageRef` for slot 0 — see this function's doc comment.
  // Assigned directly in each branch rather than through a helper: a closure
  // hides the assignment from TypeScript's control flow, which then reads the
  // return below as dead code.
  let runningDigest: string | null = null;
  // Rolling, one machine at a time with a started-wait between (deploy decision #6): a bad
  // image fails on slot 0 and leaves the rest serving the old revision.
  for (let slot = 0; slot < count; slot++) {
    const desired = machineConfigForSlot({ imageRef, spec: stored.spec, revision: stored.revision, ns: stored.ns, key: stored.key, slot, env, volumeId });
    const desiredHash = (desired.metadata as Record<string, string>).hexclave_config_hash;
    let existing = bySlot.get(slot);
    bySlot.delete(slot);

    // A machine's MOUNTS cannot be changed in place. Fly places a machine on its volume's
    // host, so an already-placed machine can't adopt a volume that was created afterwards:
    // real Fly rejects the update with `400 invalid_argument: volume does not exist`, even
    // once the volume is listed and `created` (verified against real Fly). Left to
    // the update path, adding a volume to a deployed service would fail identically on every
    // retry and wedge it forever. Destroy first so the branch below recreates it on the
    // volume's host. Detaching is recreated too: the reverse transition is equally unproven,
    // and the volume itself always survives (smoke Q3a).
    if (existing !== undefined && mountsDiffer(existing.config.mounts ?? [], desired.mounts as { volume: string, path: string }[] | undefined ?? [])) {
      await lease.assertOwned();
      await fly.destroyMachine(appName, existing.id);
      existing = undefined;
    }

    const existingStarted = existing !== undefined && (existing.state === "started" || existing.state === "starting");
    // Config-hash match short-circuits — but only when the machine is actually up. A pinned
    // (autostop:"off") slot that crash-looped to `stopped` will never be restarted by Fly
    // Proxy, so a same-spec reconcile must still boot it; otherwise an always-on service
    // stays down forever. Autostoppable slots are meant to be stopped, so leave those.
    const pinned = slot < pinnedMachineCount(stored.spec);
    if (existing !== undefined && existing.config.metadata?.hexclave_config_hash === desiredHash && (existingStarted || !pinned)) {
      if (slot === 0) runningDigest = reportedDigest(existing);
      continue;
    }
    if (existing !== undefined && existing.config.metadata?.hexclave_config_hash === desiredHash) {
      // Hash matches but a pinned machine is stopped: just start it, no config churn.
      try {
        await lease.assertOwned();
        await fly.startMachine(appName, existing.id);
      } catch (error) {
        if (isReconciliationFencingError(error)) throw error;
        // Already booting / raced — the wait below arbitrates.
      }
      await fly.waitForMachineState(appName, existing.id, "started", { instanceId: existing.instance_id, totalTimeoutSeconds: 120 });
      if (slot === 0) runningDigest = reportedDigest(existing);
      continue;
    }
    if (existing !== undefined) {
      const wasStopped = existing.state !== "started" && existing.state !== "starting";
      await lease.assertOwned();
      const updated = await fly.updateMachine(appName, existing.id, desired);
      if (wasStopped) {
        // Updating a stopped machine doesn't reliably boot it; start explicitly so the
        // started-wait below actually gates the roll (autostop re-stops it when idle).
        try {
          await lease.assertOwned();
          await fly.startMachine(appName, updated.id);
        } catch (error) {
          if (isReconciliationFencingError(error)) throw error;
          // Racing the update-triggered boot is fine — the wait below is the arbiter.
        }
      }
      await fly.waitForMachineState(appName, updated.id, "started", { instanceId: updated.instance_id, totalTimeoutSeconds: 120 });
      if (slot === 0) runningDigest = reportedDigest(updated);
    } else {
      await lease.assertOwned();
      const created = await fly.createMachine(appName, {
        name: `${stored.key.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20)}-${slot}`,
        region: config.fly.region,
        config: desired,
      });
      await fly.waitForMachineState(appName, created.id, "started", { instanceId: created.instance_id, totalTimeoutSeconds: 120 });
      if (slot === 0) runningDigest = reportedDigest(created);
    }
  }
  for (const machine of [...bySlot.values(), ...extras]) {
    await lease.assertOwned();
    await fly.destroyMachine(appName, machine.id);
  }
  return runningDigest === null ? null : pinToDigest(imageRef, runningDigest);
}

// ---------------------------------------------------------------------------
// PUT /services/{key}

export type ApplyResult = {
  revision: string,
  changed: boolean,
  state: ServiceState,
  // The image Fly reports the service is running, digest-pinned — see
  // applyMachines. Null when no machine was rolled or read (an apply that ended
  // blocked, lost the spec, or threw), in which case there is nothing to say
  // beyond the reference the spec named.
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

async function stateAfterSpecWrite(ns: string, key: string, stored: StoredSpec, previousEtag: string, knownTargets?: Map<string, KnownTarget>): Promise<ServiceState> {
  const etag = await writeSpec(stored, { ifMatch: previousEtag });
  if (etag !== null) return await getServiceState(ns, key, stored, knownTargets);
  // Another request (or a delete) owns the desired state now. Never resurrect/overwrite it.
  return await getServiceState(ns, key, undefined, knownTargets);
}

async function specIsStillOwned(ns: string, key: string, etag: string): Promise<boolean> {
  return (await readSpecVersioned(ns, key))?.etag === etag;
}

export async function applyServiceSpec(ns: string, key: string, spec: ServiceSpec, options?: { knownTargets?: Map<string, KnownTarget>, lease?: ReconciliationLeaseGuard }): Promise<ApplyResult> {
  // A deployment already holds the lease for its whole source, so it passes its
  // own rather than taking a second one per service — the lease is not
  // re-entrant, and waiting on itself is a deadlock.
  if (options?.lease !== undefined) {
    return await applyServiceSpecWithLease(ns, key, spec, options.lease, options.knownTargets);
  }
  return await withReconciliationLease(ns, key, async (lease) => await applyServiceSpecWithLease(ns, key, spec, lease, options?.knownTargets));
}

async function applyServiceSpecWithLease(ns: string, key: string, spec: ServiceSpec, lease: ReconciliationLeaseGuard, knownTargets?: Map<string, KnownTarget>): Promise<ApplyResult> {
  const config = getConfig();
  const fly = flyClientForNamespaceOrg(resolveNamespaceOrg(ns));
  // A domain-holding service must satisfy the domain port rule on every spec write, not just
  // at attach time. The domain's public IPs outlive the attach: a later PUT that adds a
  // private sibling port would hand it to the proxy on those IPs, so the whole rule is
  // re-checked here rather than only its HTTP-port half.
  if ((await listDomainClaimsForService(ns, key)).length > 0) {
    assertServiceCanHoldADomain(key, spec.config.ports, spec.config.public, "Detach the service's custom domains first if this port set is what you want.");
  }
  const revision = computeRevision(spec);
  const now = Date.now();
  const claimed = await claimDesiredSpec(ns, key, spec, revision, now);
  const { stored, changed } = claimed;
  const ownedSpecEtag = claimed.etag;

  // Unresolvable refs: persist the spec and report blocked WITHOUT touching machines or
  // starting builds — the backend re-applies when the blocking output appears.
  const resolved = await resolveEnv(fly, ns, stored.spec.env, knownTargets);
  if (!resolved.ok) {
    return { revision, changed, state: await getServiceState(ns, key, stored, knownTargets), imageRef: null };
  }

  // The app must exist before machines can be created into it, and its IPs must
  // match what the ports ask for.
  const appName = appNameForService(config.envId, ns, key);
  const network = networkForNamespace(config.envId, ns);
  await lease.assertOwned();
  await fly.ensureApp(appName, network);
  await lease.assertOwned();
  await fly.ensureFlycastIp(appName, network);
  await lease.assertOwned();
  await reconcilePublicIps(fly, appName, specIsPublic(stored.spec) ? "public" : "private");

  // FUTURE (build-time env): env values are handed to the builder too (see buildTimeEnv),
  // because frameworks that inline them (NEXT_PUBLIC_*, VITE_*) need them at BUILD time. So
  // an env-only change rolls the machines with the new value while the already-built image
  // keeps the old one baked in. That skew is ACCEPTED for now: a spec names an image that
  // has already been built, so nothing here can rebuild it. The fix is not in this function
  // but in the product surface: track which build-visible values an image was built from,
  // report the service as stale in the dashboard, and offer a redeploy (Vercel makes the
  // redeploy mandatory — an env change never applies to an existing deployment).

  if (!await specIsStillOwned(ns, key, ownedSpecEtag)) {
    // Deliberately WITHOUT knownTargets: the spec being reported now belongs to whoever won the
    // race, and resolving someone else's refs against this deployment's targets would report
    // a state their own reads never agree with.
    return { revision, changed, state: await getServiceState(ns, key), imageRef: null };
  }
  let imageRef: string | null = null;
  try {
    imageRef = await applyMachines(fly, stored, stored.spec.source.image, resolved.env, lease);
    stored.last_apply_error = null;
  } catch (error) {
    if (isReconciliationFencingError(error)) throw error;
    // Logged here because this is the ONLY place the real failure survives:
    // last_apply_error is served to the caller, so it carries our sanitized text
    // and never the provider's wording, status or app identifiers.
    console.error(`apply failed for service ${stored.ns}/${stored.key}`, error);
    stored.last_apply_error = `deploy failed: ${applyErrorMessage(error)}`;
  }
  return { revision, changed, state: await stateAfterSpecWrite(ns, key, stored, ownedSpecEtag, knownTargets), imageRef };
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

export function validateDeploymentRequest(body: unknown): { uploadId: string | null, targets: DeploymentTarget[], order: string[][] } {
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
    const spec = validateServiceSpec({ ...specRecord, source: { image: PLACEHOLDER_IMAGE } });
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
  return { uploadId, targets, order };
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
 */
export async function startSourceDeployment(ns: string, sourceId: string, body: unknown, builder: Builder): Promise<Deployment> {
  const { uploadId, targets, order } = validateDeploymentRequest(body);
  const config = getConfig();
  // Targets that need the builder, and targets that already have their image.
  // Everything below branches on THIS rather than on "does the target have an
  // image", so that a future source of prebuilt images (one Marshal has to mirror
  // before it can run, say) changes only what fills these two lists.
  const buildTargets = targets.filter(targetIsBuilt);
  const prebuiltTargets = targets.filter((target) => !targetIsBuilt(target));
  return await withReconciliationLease(ns, sourceLeaseKey(sourceId), async (lease) => {
    const fly = flyClientForNamespaceOrg(resolveNamespaceOrg(ns));

    // A prebuilt target's image goes into the deployment exactly as the author
    // wrote it, normalized but NOT resolved: Marshal never contacts the image's
    // registry, and Fly resolves whatever this names when it pulls.
    //
    // What that costs the caller, stated once here because it is the whole
    // contract for a tag:
    //   - The bytes a tag names are fixed by FLY, at pull time, not by this
    //     deployment. Two machines of one service, or one machine recreated
    //     later, can therefore run different bytes under one revision if the
    //     publisher moves the tag in between.
    //   - A redeploy of an unchanged tag is a no-op: the machine config is
    //     identical, so the config hash matches and nothing is pulled again.
    //     Moving forward onto a republished tag means changing the reference.
    //   - A reference that does not exist is Fly's error at apply time, not a
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
      const archive = await readUpload(ns, uploadId);
      if (archive === null) throw badRequest(`upload ${JSON.stringify(uploadId)} disappeared before it could be consumed`);
      await validateSourceArchive(archive);
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
      upload_id: uploadId,
    };

    // Every target's app must exist BEFORE the build: registry.fly.io only accepts
    // pushes to repositories of existing apps (real-Fly-verified — pushing first
    // fails with "app repository not found"). Prebuilt targets need their app
    // too, just for the apply rather than for a push.
    const network = networkForNamespace(config.envId, ns);
    for (const target of targets) {
      await lease.assertOwned();
      await fly.ensureApp(appNameForService(config.envId, ns, target.service_key), network);
    }

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
        targets: buildTargets.map((target) => ({
          serviceKey: target.service_key,
          pushTarget: `${config.fly.registryHost}/${appNameForService(config.envId, ns, target.service_key)}:${deploymentId.toLowerCase()}`,
          dockerfilePath: target.dockerfile_path ?? null,
          rootDirectory: target.root_directory ?? null,
          // Null unless the target builds from a GENERATED Dockerfile, which is
          // also the only case where `image` is a base rather than the thing to
          // run — so the builder never has to re-derive which of the two it is.
          baseImage: targetUsesGeneratedDockerfile(target) ? target.image ?? BASE_IMAGE : null,
          buildCommand: target.build_command ?? null,
          buildEnv: buildTimeEnv(target.spec.env),
        })),
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
 * else "deployed", so a machine apply that FAILED was recorded as a success and
 * the deployment went on to report "succeeded" over it.
 *
 * Three things mean the apply did not converge and never will on its own:
 *
 *   - "blocked": a ref could not resolve — a `url` of a service that never came
 *     up. Nothing later in this deployment makes it resolvable.
 *   - "failed": the apply threw and left zero started machines. That error is
 *     caught INSIDE applyServiceSpec and stored as last_apply_error rather than
 *     rethrown, so it reaches callers only through the reported state — never
 *     through their own catch.
 *   - a non-null error under any other status ("degraded", when the same stored
 *     error left some machines up): partially rolled, still broken.
 *
 * `error` is the load-bearing signal rather than the status: getServiceState
 * sets it only for unresolved refs or a stored last_apply_error, and
 * last_apply_error is cleared on every successful apply and on every spec change
 * — so it is never stale. That is also what keeps a "degraded" caused merely by
 * under-pinned machines (which carries no error) counted as deployed, instead of
 * failing deploys for a transient scale-up.
 */
export function deploymentStateForApply(serviceKey: string, image: string, applied: { revision: string, state: ServiceState, imageRef: string | null }): DeploymentServiceState {
  // What RAN, not what was asked for. `image` may name a tag, which Fly — not
  // Marshal — resolves at pull time, so `applied.imageRef` is the digest that
  // tag turned out to point at and is the only record of it. The reference as
  // written is the fallback for an apply that rolled no machine, where there is
  // no resolution to report.
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
  await withReconciliationLease(options.ns, sourceLeaseKey(existing.source_id), async (lease) => {
    const current = await readDeploymentVersioned(options.ns, options.deploymentId);
    // Terminal already (a retried webhook, or the stale-build backstop got there
    // first): the first outcome wins.
    if (current === null || current.value.status !== "building") return;
    await lease.assertOwned();

    if (options.status === "failed") {
      await replaceDeployment(failDeployment(current.value, options.errorText ?? "the build failed"), current.etag);
      await persistDeploymentLog(flyClientForNamespaceOrg(resolveNamespaceOrg(options.ns)), current.value);
      await deleteValidatedUploadBestEffort(options.ns, options.deploymentId);
      return;
    }

    const images = parseBuildImages(options.metadataJson, current.value);
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
      await persistDeploymentLog(flyClientForNamespaceOrg(resolveNamespaceOrg(options.ns)), current.value);
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
    await persistDeploymentLog(flyClientForNamespaceOrg(resolveNamespaceOrg(options.ns)), current.value);
    await deleteValidatedUploadBestEffort(options.ns, options.deploymentId);
  });
}

/**
 * The images a completed build produced, keyed by service key.
 *
 * Digests are resolved into fully-qualified image refs here rather than in the
 * harness: the registry host and app name are Marshal's to know, and a harness
 * that composed them would have to be trusted about which app it pushed to.
 */
function parseBuildImages(metadataJson: string | null, deployment: StoredDeployment): Record<string, string> {
  const config = getConfig();
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
    images[target.service_key] = `${config.fly.registryHost}/${appNameForService(config.envId, deployment.ns, target.service_key)}@${digest}`;
  }
  return images;
}

/**
 * Moves a deploying deployment forward by AT MOST ONE service, and returns its
 * current state.
 *
 * One service per call rather than a whole level: an apply rolls machines and
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

// Durable build log: Marshal (not the harness) drains the builder machine's logs from the
// Fly logs API at terminal state, scrubs every credential it handed to the build, and
// persists JSONL to the bucket — outliving Fly's ~7d retention. The harness stays dumb.
//
// One log per DEPLOYMENT, covering every service it built: they shared a machine,
// so their output is interleaved in one stream and there is nothing to split.
async function persistDeploymentLog(fly: FlyClient, deployment: StoredDeployment): Promise<void> {
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
    const redactionValues = deploymentLogRedactionValues(fly, deployment);
    await writeDeploymentLog(deployment.ns, deployment.id, lines
      .map((line) => ({ ...line, text: redactBuildLogText(line.text, redactionValues) }))
      .map((line) => JSON.stringify(line))
      .join("\n"));
    return;
  }
  try {
    const lines = await fetchAllLogs(fly, deployment.builder_app, {
      sinceMillis: deployment.started_at_millis - 60 * 1000,
      instance: deployment.builder_machine_id,
    });
    // Skip persisting an empty log object: a transient logs-API failure (rate limit,
    // ingestion lag) must not freeze `has_logs:true, lines:[], complete:true`. Leaving no
    // object makes the logs route fall back to the live proxy instead.
    if (lines.length === 0) return;
    const redactionValues = deploymentLogRedactionValues(fly, deployment);
    const jsonl = lines
      .map((line) => ({ ...line, text: redactBuildLogText(line.text, redactionValues) }))
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeDeploymentLog(deployment.ns, deployment.id, jsonl);
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
 * The credentials are the org token (with and without its "FlyV1 " scheme), the
 * registry basic-auth blob, and the per-deployment webhook token (recomputed,
 * since it's derived, not stored). The presigned tarball URL isn't recomputable,
 * so its signature is scrubbed by shape in redactBuildLogText.
 *
 * Every plain env value of every target is scrubbed, not a chosen subset: one env
 * channel with no build/runtime marker means Marshal cannot tell a publishable
 * API URL from a database password, and the only safe default is to treat all of
 * them as the latter. They come from the deployment's own targets rather than
 * from current specs, so a value edited after the build is still scrubbed from
 * that build's log.
 */
export function deploymentLogRedactionValues(fly: FlyClient, deployment: StoredDeployment): string[] {
  const { fly: flyConfig } = getConfig();
  const values = [flyConfig.token, fly.registryAuthBase64(), computeWebhookToken(deployment.id, deployment.ns)];
  if (flyConfig.token.startsWith("FlyV1 ")) values.push(flyConfig.token.slice("FlyV1 ".length));
  for (const target of deployment.targets) {
    for (const value of Object.values(buildTimeEnv(target.spec.env))) {
      if (value.length >= MIN_REDACTED_ENV_VALUE_LENGTH) values.push(value);
    }
  }
  return values;
}

export function redactBuildLogText(text: string, values: string[]): string {
  return redactSecrets(text, values)
    // Presigned URL signatures (the tarball GET) — scrub by shape since the exact URL
    // isn't persisted anywhere Marshal can recompute.
    .replace(/X-Amz-Signature=[A-Za-z0-9%]+/gi, "X-Amz-Signature=<redacted>")
    .replace(/X-Amz-Credential=[A-Za-z0-9%/]+/gi, "X-Amz-Credential=<redacted>");
}

/**
 * Lazy backstop for lost webhooks: a deployment still building long after the
 * harness watchdog must have fired gets finalized as failed on the next read.
 */
export async function maybeFinalizeStaleDeployment(deployment: StoredDeployment): Promise<StoredDeployment> {
  if (deployment.status !== "building") return deployment;
  const staleAfterMillis = deployment.started_at_millis + BUILD_TIMEOUT_SECONDS * 1000 + BUILD_STALE_GRACE_MS;
  if (Date.now() < staleAfterMillis) return deployment;
  const fly = flyClientForNamespaceOrg(resolveNamespaceOrg(deployment.ns));
  if (deployment.builder_app !== null && deployment.builder_machine_id !== null) {
    let machine;
    try {
      machine = await fly.getMachine(deployment.builder_app, deployment.builder_machine_id);
    } catch (error) {
      // A transient Fly error here must not turn a read into a 502 — leave the
      // deployment as-is until the next read.
      console.error(`stale-build liveness check for ${deployment.ns}/${deployment.id} failed`, error);
      return deployment;
    }
    // Still running: the watchdog has not fired yet (a clock skew, a long
    // machine start), so leave it alone.
    if (machine !== null && (machine.state === "started" || machine.state === "created" || machine.state === "starting")) return deployment;
  }
  const current = await readDeploymentVersioned(deployment.ns, deployment.id);
  if (current === null || current.value.status !== "building") return current?.value ?? deployment;
  const failed = failDeployment(current.value, "the build did not report a result before its timeout");
  const etag = await replaceDeployment(failed, current.etag);
  return etag === null ? (await readDeployment(deployment.ns, deployment.id)) ?? failed : failed;
}

// ---------------------------------------------------------------------------
// Reads

export async function getServiceState(ns: string, key: string, preloadedSpec?: StoredSpec | null, knownTargets?: Map<string, KnownTarget>): Promise<ServiceState> {
  const config = getConfig();
  const fly = flyClientForNamespaceOrg(resolveNamespaceOrg(ns));
  const stored = preloadedSpec !== undefined ? preloadedSpec : await readSpec(ns, key);
  if (stored === null) throw notFound(`service ${JSON.stringify(key)} not found in namespace ${JSON.stringify(ns)}`);
  const appName = appNameForService(config.envId, ns, key);

  // No build lookup: a spec always names an image that has already been built,
  // so a service is never "building". Building belongs to the DEPLOYMENT that
  // produced the image, which reports it (see advanceDeployment).
  const [machines, certificates, resolved] = await Promise.all([
    fly.listMachines(appName),
    fly.listCertificates(appName),
    // The SAME knownTargets the apply resolved with. Without it this read would re-resolve
    // from stored specs alone and report `blocked` for a private `url(port)` naming a target
    // of this deployment that has not been applied yet — failing the deployment over the
    // very ordering independence knownTargets exists to provide.
    resolveEnv(fly, ns, stored.spec.env, knownTargets),
  ]);

  const domains = await computeDomainStates(fly, appName, certificates);
  const verifiedHostnames = certificates.filter(certificateIsVerified).map((certificate) => certificate.hostname).sort();

  const startedCount = machines.filter((machine) => machine.state === "started").length;
  const machineRevisions = new Set(machines.map((machine) => machine.config.metadata?.hexclave_revision ?? "unknown"));
  const allAtTarget = machines.length > 0 && machineRevisions.size === 1 && machineRevisions.has(stored.revision);
  const runningRevision = machines.length === 0 ? null : machineRevisions.size === 1 ? [...machineRevisions][0] : [...machineRevisions].find((revision) => revision !== stored.revision) ?? stored.revision;

  const status = ((): ServiceState["status"] => {
    if (!resolved.ok) return "blocked";
    // Checked BEFORE the no-machine branch: an apply that failed before it created anything
    // (ensureApp/ensureFlycastIp/the first createMachine) leaves zero machines and a terminal
    // last_apply_error, and reporting that as "pending" tells callers to keep waiting for a
    // deploy that is already over. `error` below has always surfaced it — only status lied.
    if (stored.last_apply_error !== null) return startedCount > 0 ? "degraded" : "failed";
    if (machines.length === 0) return "pending";
    if (!allAtTarget || machines.length !== desiredMachineCount(stored.spec)) return "deploying";
    if (startedCount === 0) {
      if (isServerful(stored.spec) || pinnedMachineCount(stored.spec) > 0) return "stopped";
      return "idle";
    }
    if (startedCount < pinnedMachineCount(stored.spec)) return "degraded";
    return "running";
  })();

  const error = ((): string | null => {
    if (!resolved.ok) return `blocked on unresolved refs: ${resolved.blockedRefs.join(", ")}`;
    if (stored.last_apply_error !== null) return stored.last_apply_error;
    return null;
  })();

  return {
    key,
    // Echo back the type the caller actually stored. Reporting a constant here
    // meant a service PUT as "server" read back as something else entirely.
    type: stored.spec.config.type,
    status,
    instances: startedCount,
    revision: runningRevision,
    target_revision: runningRevision === stored.revision && allAtTarget ? null : stored.revision,
    outputs: {
      hostname: hostnameForService(config.envId, ns, key),
      // The private address of the service's sole HTTP port. Null when it
      // declares several and so leaves a bare `url()` ambiguous — a ref that
      // names its port resolves independently of this.
      internal_url: ((httpPort) => httpPort === null ? null : `http://${hostnameForService(config.envId, ns, key)}:${httpPort}`)(soleHttpPort(stored.spec.config.ports)),
      // Keep a public service's platform URL stable even while custom domains are added or
      // removed. The backend prefers a verified custom domain for display, then falls back
      // to this value; private services continue to expose only a verified custom domain.
      url: !portEntries(stored.spec.config.ports).some((entry) => entry.protocol === "http")
        ? null
        : specIsPublic(stored.spec)
          ? `https://${appName}.fly.dev`
          : verifiedHostnames.length > 0 ? `https://${verifiedHostnames[0]}` : null,
    },
    domains,
    error,
    observed_at_millis: Date.now(),
  };
}

export async function computeDomainStates(fly: FlyClient, appName: string, certificates: FlyCertificate[]): Promise<ServiceDomainState[]> {
  if (certificates.length === 0) return [];
  const ips = await fly.getAppIps(appName);
  return certificates
    .slice()
    .sort((a, b) => a.hostname < b.hostname ? -1 : 1)
    .map((certificate) => ({
      hostname: certificate.hostname,
      verified: certificateIsVerified(certificate),
      dns_records: dnsRecordsForCertificate(appName, certificate, ips.sharedIpv4, ips.dedicated.filter((ip) => ip.type === "v6").map((ip) => ip.address)),
      error: null,
    }));
}

export function dnsRecordsForCertificate(appName: string, certificate: FlyCertificate, sharedIpv4: string | null, v6Addresses: string[]): DnsRecord[] {
  const records: DnsRecord[] = [];
  if (certificate.isApex) {
    if (sharedIpv4 !== null) records.push({ type: "A", name: certificate.hostname, value: sharedIpv4 });
    for (const address of v6Addresses) records.push({ type: "AAAA", name: certificate.hostname, value: address });
  } else {
    records.push({ type: "CNAME", name: certificate.hostname, value: `${appName}.fly.dev` });
  }
  if (!certificateIsVerified(certificate)) {
    // Pre-issuance DNS validation: lets the cert issue before (or without) the main
    // record cutting over.
    records.push({ type: "CNAME", name: certificate.dnsValidationHostname, value: certificate.dnsValidationTarget });
  }
  return records;
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
  await withReconciliationLease(ns, key, async (lease) => await deleteServiceWithLease(ns, key, lease));
}

async function deleteServiceWithLease(ns: string, key: string, lease: ReconciliationLeaseGuard): Promise<void> {
  const config = getConfig();
  const fly = flyClientForNamespaceOrg(resolveNamespaceOrg(ns));
  const appName = appNameForService(config.envId, ns, key);
  const storedVersion = await readSpecVersioned(ns, key);

  // Release hostname claims first — the bucket registry would otherwise block the hostname
  // forever. The certificate goes with it on BOTH paths below: on the destroy path certs die
  // with the app, and on the detach path the app outlives the service, so a cert left behind
  // would keep a hostname pointing at a machine-less app that nothing can serve — and would
  // make Fly refuse the same hostname when it is re-attached elsewhere.
  for (const hostname of await listDomainClaimsForService(ns, key)) {
    const claim = await readDomainClaimVersioned(hostname);
    if (claim !== null && claim.value.ns === ns && claim.value.service_key === key) {
      await lease.assertOwned();
      await fly.deleteCertificate(appName, hostname);
      await releaseDomainClaim(claim);
    }
  }

  // Destroying a Fly app destroys its VOLUMES with it (smoke-verified against real Fly), so a
  // volume-backed service is torn down by DETACHING instead: kill the machines and the public
  // ingress, drop the spec, and leave the app holding its disks. That is what makes removing a
  // service from a deploy file survivable — the contract is that the volume outlives the
  // service and needs an explicit delete — and re-syncing the same service id adopts the disk
  // again by name (ensureVolume selects it deterministically).
  //
  // Only a service with no volumes takes the destroy path, where nothing is lost and leaving
  // an empty app behind would burn the org's app-count limit instead.
  const volumes = await fly.listVolumes(appName);
  if (volumes.length > 0) {
    for (const machine of await fly.listMachines(appName)) {
      await lease.assertOwned();
      await fly.destroyMachine(appName, machine.id);
    }
    // Nothing serves this app any more, so its public IPs must go: the certificates above are
    // already gone, which is what lets this release rather than no-op.
    await lease.assertOwned();
    await reconcilePublicIps(fly, appName, "private");
  } else {
    // force=true kills machines and releases IPs in one call. Build history is intentionally
    // kept (it's namespaced under builds/<ns>/<key>/).
    await lease.assertOwned();
    await fly.deleteApp(appName);
  }
  await lease.assertOwned();
  if (storedVersion !== null) await deleteSpecConditionally(ns, key, storedVersion.etag);
}

export { readDeployment, readSpec };
