import { DEFAULT_SERVERLESS_MEMORY_MB, getConfig, serverMachineTypeFor, serverlessCpuFor, serviceMemoryMb } from "../config.js";
import { badRequest } from "../errors.js";
import { pinToDigest } from "../image-ref.js";
import { diskNameForVolume, instanceNameForService, serviceName } from "../naming.js";
import type { ReconciliationLeaseGuard } from "../reconciliation-lock.js";
import { portEntries, type LogLine, type ServiceSpec, type StoredSpec } from "../types.js";
import type { CloudRunObservation } from "./cloud-run.js";
import type { ComputeInstance } from "./compute.js";
import { tenantContext } from "./context.js";

export type RuntimeAddress = {
  hostname: string | null,
  platformUrl: string | null,
  internalUrl: string | null,
};

export type RuntimeObservation = RuntimeAddress & {
  exists: boolean,
  ready: boolean,
  instances: number,
  revision: string | null,
  atTarget: boolean,
  error: string | null,
};

function soleHttpPort(spec: ServiceSpec): number {
  const entries = portEntries(spec.config.ports);
  // The constraint is Cloud Run's — one ingress port per service — but the reason belongs
  // here rather than in the message: a 400 is relayed to the caller verbatim, and nothing
  // the provider is named in may travel down that channel (see apply-error.ts).
  if (entries.length !== 1 || entries[0].protocol !== "http") {
    throw badRequest(`${spec.config.type} services must declare exactly one HTTP port; the runtime serves a single ingress port per service`);
  }
  return entries[0].port;
}

function publicHttpPort(spec: ServiceSpec): number {
  const entry = portEntries(spec.config.ports).find((candidate) => candidate.protocol === "http");
  if (entry === undefined) throw badRequest(`${spec.config.type} service has no HTTP port to expose`);
  return entry.port;
}

function soleHttpPortOrNull(spec: ServiceSpec): number | null {
  const entries = portEntries(spec.config.ports).filter((entry) => entry.protocol === "http");
  return entries.length === 1 ? entries[0].port : null;
}

/**
 * The machine shape a server runs on, from the memory its spec asks for.
 *
 * A spec that names no size resolves to the type's default, which is the shape
 * every server ran on before sizes existed — and since the absence also leaves
 * the revision unchanged, such a service is not replaced on the apply that first
 * goes through this.
 *
 * The fallback is unreachable through the API (validateServiceSpec refuses any
 * size that is not a key of this table) and exists because a stored spec is
 * replayed on every reconcile: one written by a future Marshal must not create
 * an instance with an empty machine type.
 */
/**
 * The container resources a serverless service runs with.
 *
 * The CPU comes from the memory rather than being chosen: Cloud Run accepts only
 * certain pairs, so keeping them together here is what makes an illegal
 * combination unrepresentable instead of merely rejected.
 *
 * Unreachable fallback for the same reason as serverMachineType's.
 */
function serverlessResources(spec: ServiceSpec): { memoryMb: number, cpu: number } {
  const memoryMb = serviceMemoryMb("gcp", spec);
  return { memoryMb, cpu: serverlessCpuFor(memoryMb) };
}

function serverMachineType(spec: ServiceSpec): string {
  return serverMachineTypeFor(serviceMemoryMb("gcp", spec));
}

function hostnameFromUrl(url: string | null): string | null {
  return url === null ? null : new URL(url).hostname;
}

function gatewayName(envId: string, ns: string, key: string): string {
  return `${serviceName(envId, ns, key)}-gw`.slice(0, 49).replace(/-$/, "0");
}

function serviceKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function gatewayCommand(): string {
  return "printf 'server { listen %s; location / { proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_pass http://%s:%s; } }' \"$PORT\" \"$TARGET_HOST\" \"$TARGET_PORT\" > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'";
}

async function ensureServerGateway(stored: StoredSpec, instance: ComputeInstance, lease: ReconciliationLeaseGuard): Promise<CloudRunObservation> {
  if (instance.internalIp === null) throw new Error(`Compute Engine instance ${instance.name} has no internal IP address`);
  const port = publicHttpPort(stored.spec);
  const config = getConfig();
  const context = await tenantContext(stored.ns);
  await lease.assertOwned();
  return await context.cloudRun.apply({
    name: gatewayName(config.envId, stored.ns, stored.key),
    image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
    env: { TARGET_HOST: instance.internalIp, TARGET_PORT: String(port) },
    port: 8080,
    public: true,
    minInstances: 0,
    maxInstances: 2,
    revision: stored.revision,
    startCommand: gatewayCommand(),
    serviceKeyHash: serviceKeyHash(stored.key),
    // Fixed at the smallest shape, and deliberately NOT the sized server's: this
    // is an nginx proxy in front of the VM, not the service. Sizing it with the
    // service would bill a second machine for every gigabyte the author asked
    // the first one for, and buy nothing — it forwards bytes.
    memoryMb: DEFAULT_SERVERLESS_MEMORY_MB,
    cpu: serverlessCpuFor(DEFAULT_SERVERLESS_MEMORY_MB),
  });
}

// `hasDomainClaim` comes from the caller rather than from the domain store: this module is the
// provider layer and reads no control-plane state, and the caller already holds the service's
// reconciliation lease, so what it read cannot change underneath this apply.
export async function applyRuntimeService(stored: StoredSpec, image: string, env: Record<string, string>, lease: ReconciliationLeaseGuard, hasDomainClaim: boolean): Promise<string | null> {
  const config = getConfig();
  const context = await tenantContext(stored.ns);
  await lease.assertOwned();
  if (stored.spec.config.type === "serverless") {
    // A type change must not leave the former persistent-server resources serving an old
    // revision. The disk intentionally survives, but its VM and public gateway do not.
    await context.cloudRun.delete(gatewayName(config.envId, stored.ns, stored.key));
    await lease.assertOwned();
    await context.compute.deleteInstance(instanceNameForService(config.envId, stored.ns, stored.key));
    await lease.assertOwned();
    const port = soleHttpPort(stored.spec);
    const observation = await context.cloudRun.apply({
      name: serviceName(config.envId, stored.ns, stored.key),
      image,
      env,
      port,
      public: stored.spec.config.public,
      minInstances: stored.spec.config.min_instances,
      maxInstances: stored.spec.config.max_instances,
      revision: stored.revision,
      startCommand: stored.spec.config.start_command ?? null,
      serviceKeyHash: serviceKeyHash(stored.key),
      ...serverlessResources(stored.spec),
    });
    return observation.ready && observation.imageDigest !== null ? pinToDigest(image, observation.imageDigest) : null;
  }

  // The serverless service and persistent-server gateway use distinct names. Remove the
  // former before adopting this key as a server so a type change cannot serve two runtimes.
  await context.cloudRun.delete(serviceName(config.envId, stored.ns, stored.key));
  await lease.assertOwned();
  let volume: { diskName: string, path: string, sizeGb: number } | null = null;
  for (const [volumeId, volumeConfig] of Object.entries(stored.spec.config.persistent_volumes ?? {})) {
    volume = {
      diskName: diskNameForVolume(config.envId, stored.ns, stored.key, volumeId),
      path: volumeConfig.path,
      sizeGb: volumeConfig.size_gb,
    };
  }
  if (volume !== null) {
    await lease.assertOwned();
    await context.compute.ensureDisk(volume.diskName, volume.sizeGb);
  }
  await lease.assertOwned();
  const instance = await context.compute.applyInstance({
    name: instanceNameForService(config.envId, stored.ns, stored.key),
    image,
    env,
    ports: portEntries(stored.spec.config.ports).map((entry) => entry.port),
    revision: stored.revision,
    startCommand: stored.spec.config.start_command ?? null,
    volume: volume === null ? null : { diskName: volume.diskName, path: volume.path },
    serviceKeyHash: serviceKeyHash(stored.key),
    // Derived from the spec's memory. Absent memory resolves to the type's
    // default, so a service that has never named a size keeps the shape it has
    // always run on — and, because the same absence keeps its revision
    // unchanged, this apply does not replace it either.
    machineType: serverMachineType(stored.spec),
  });
  // A custom domain routes through the SAME gateway (see ensureDomainGateway), so a private
  // server that owns one still needs it. Deleting it here on every apply is what silently
  // and permanently broke the domain: the claim survived, the route it pointed at did not.
  if (stored.spec.config.public || hasDomainClaim) {
    await ensureServerGateway(stored, instance, lease);
  } else {
    // Visibility can change without changing the service type. Removing the gateway is the
    // operation that makes a formerly public persistent server private again.
    await lease.assertOwned();
    await context.cloudRun.delete(gatewayName(config.envId, stored.ns, stored.key));
  }
  return instance.imageRef ?? image;
}

function cloudRunRuntimeObservation(observation: CloudRunObservation, spec: StoredSpec): RuntimeObservation {
  const hostname = hostnameFromUrl(observation.uri);
  const port = soleHttpPort(spec.spec);
  return {
    exists: observation.exists,
    ready: observation.ready,
    instances: observation.runningInstances,
    revision: observation.targetRevision,
    atTarget: observation.ready && observation.targetRevision === spec.revision,
    hostname,
    platformUrl: spec.spec.config.public ? observation.uri : null,
    internalUrl: hostname === null ? null : `https://${hostname}`,
    error: observation.error,
  };
}

export async function observeRuntimeService(stored: StoredSpec): Promise<RuntimeObservation> {
  const config = getConfig();
  const context = await tenantContext(stored.ns);
  if (stored.spec.config.type === "serverless") {
    return cloudRunRuntimeObservation(await context.cloudRun.get(serviceName(config.envId, stored.ns, stored.key)), stored);
  }
  const instance = await context.compute.getInstance(instanceNameForService(config.envId, stored.ns, stored.key));
  const gateway = stored.spec.config.public ? await context.cloudRun.get(gatewayName(config.envId, stored.ns, stored.key)) : null;
  const ready = instance?.status === "RUNNING" && (gateway === null || gateway.ready);
  const port = soleHttpPortOrNull(stored.spec);
  // The VM's internal IP, or nothing. There is deliberately NO name-derived fallback:
  // Fly answered "<app>.internal" from its own 6PN DNS, but GCP publishes no such record
  // (its internal DNS is "<instance>.<zone>.c.<project>.internal", and the instance also
  // carries a "-vm" suffix). Handing that name out produced an env var that every consumer
  // failed to resolve — verified end to end, where a Cloud Run service reached its Postgres
  // VM only to get ENOTFOUND. A null blocks the ref instead, which is what blockedRefs is for.
  const privateHostname = instance?.internalIp ?? null;
  return {
    exists: instance !== null,
    ready,
    instances: instance?.status === "RUNNING" ? 1 : 0,
    revision: instance?.revision ?? null,
    atTarget: ready && instance.revision === stored.revision && (gateway === null || gateway.targetRevision === stored.revision),
    hostname: privateHostname,
    platformUrl: gateway?.uri ?? null,
    internalUrl: privateHostname === null || port === null ? null : `http://${privateHostname}:${port}`,
    error: gateway?.error ?? null,
  };
}

export async function deleteRuntimeService(_stored: StoredSpec | null, ns: string, key: string, lease: ReconciliationLeaseGuard): Promise<void> {
  const config = getConfig();
  const context = await tenantContext(ns);
  // Delete every non-persistent shape for the key. This is intentionally independent of
  // the stored type so an interrupted type transition cannot orphan its previous runtime.
  await lease.assertOwned();
  await context.cloudRun.delete(serviceName(config.envId, ns, key));
  await lease.assertOwned();
  await context.cloudRun.delete(gatewayName(config.envId, ns, key));
  await lease.assertOwned();
  await context.compute.deleteInstance(instanceNameForService(config.envId, ns, key));
  // Persistent disks deliberately survive. They are addressed by service + volume id and
  // are adopted on a later deploy, preserving Marshal's existing delete semantics.
}

export async function runtimeAddress(ns: string, key: string, stored: StoredSpec): Promise<RuntimeAddress> {
  const observation = await observeRuntimeService(stored);
  return { hostname: observation.hostname, platformUrl: observation.platformUrl, internalUrl: observation.internalUrl };
}

export async function ensureDomainGateway(stored: StoredSpec, lease: ReconciliationLeaseGuard): Promise<string> {
  const config = getConfig();
  if (stored.spec.config.type === "serverless") return serviceName(config.envId, stored.ns, stored.key);
  const context = await tenantContext(stored.ns);
  const instance = await context.compute.getInstance(instanceNameForService(config.envId, stored.ns, stored.key));
  if (instance === null) throw badRequest(`service ${JSON.stringify(stored.key)} must be deployed before attaching a domain`);
  await ensureServerGateway(stored, instance, lease);
  return gatewayName(config.envId, stored.ns, stored.key);
}

export async function runtimeLogs(stored: StoredSpec, sinceMillis?: number, requestedInstance?: string): Promise<LogLine[]> {
  const config = getConfig();
  const context = await tenantContext(stored.ns);
  if (stored.spec.config.type === "serverless") {
    return await context.logging.cloudRunService(serviceName(config.envId, stored.ns, stored.key), sinceMillis);
  }
  const instance = await context.compute.getInstance(instanceNameForService(config.envId, stored.ns, stored.key));
  if (instance === null || (requestedInstance !== undefined && requestedInstance !== instance.id && requestedInstance !== instance.name)) return [];
  return await context.logging.computeInstance(instance.id, sinceMillis);
}
import { createHash } from "node:crypto";
