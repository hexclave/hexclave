// The seam between Marshal's generic service logic and the infrastructure it runs on.
//
// services.ts, domains.ts and marshal-app.ts know about specs, deployments, leases, the
// bucket and the API contract. Everything that touches Fly or Google Cloud lives behind
// this interface, in fly/provider.ts and gcp/provider.ts, and is reached through
// `providerForNamespace(ns)` — which is also where the namespace's runtime pin is read
// (see runtime.ts). A provider never reads control-plane state except through the
// arguments it is handed, so the generic layer stays the only place that decides what a
// namespace holds.
import type { Builder } from "./builds.js";
import type { ReconciliationLeaseGuard } from "./reconciliation-lock.js";
import { createFlyProvider } from "./fly/provider.js";
import { createGcpProvider } from "./gcp/provider.js";
import { resolveNamespaceRuntime, type DeploymentRuntime } from "./runtime.js";
import type { DnsRecord, LogLine, ServiceDomainState, ServiceKind, StoredDeployment, StoredSpec } from "./types.js";

export type RuntimeAddress = {
  // The service's private hostname, when the runtime has one to give. A pure function of
  // the service's identity on Fly (6PN DNS); the VM's internal IP on a GCP server; null on
  // a GCP serverless (Cloud Run has no host-and-port address).
  hostname: string | null,
  // Public URL: the platform URL of a public service, or a verified custom domain's.
  platformUrl: string | null,
  // The private address of the service's sole HTTP port, when there is exactly one.
  internalUrl: string | null,
  // The host a private `url(port)` reference is built on as `http://<host>:<port>`, or null
  // when the runtime hands out one port-agnostic endpoint instead (Cloud Run), in which case
  // the reference resolves to `internalUrl`.
  privateHost: string | null,
};

export type RuntimeObservation = RuntimeAddress & {
  // Whether any runtime resource exists for the service at all.
  exists: boolean,
  // Whether at least the pinned instances are up. False with instances > 0 reads as degraded.
  ready: boolean,
  instances: number,
  // The revision the runtime is running, or null when it runs nothing.
  revision: string | null,
  // Whether every runtime resource is at the stored revision.
  atTarget: boolean,
  error: string | null,
};

export type LogPage = { lines: LogLine[], nextSinceMillis: number };

export type BuilderLiveness = {
  // Still building: the harness watchdog has not fired, so leave the deployment alone.
  alive: boolean,
  // The builder died before the harness started, so nothing will ever post a result.
  startupFailed: boolean,
  // A short tail of the builder's output, for the failure message.
  tail: string,
};

export type AttachDomainResult = {
  hostname: string,
  service_key: string,
  verified: boolean,
  dns_records: DnsRecord[],
};

export type RuntimeProvider = {
  kind: DeploymentRuntime,
  /** The real builder for this runtime (the mock one is chosen above this layer). */
  createBuilder(): Builder,
  /** The memory rungs a service of this type may ask for, in MB, and its default. */
  memorySizesMb(type: ServiceKind): number[],
  defaultMemoryMb(type: ServiceKind): number,
  /** Where a build pushes the image for one service of one deployment. */
  pushTarget(ns: string, serviceKey: string, deploymentId: string): Promise<string>,
  /** The fully-qualified reference of an image a build reported a digest for. */
  builtImageRef(deployment: StoredDeployment, serviceKey: string, digest: string): string,
  /**
   * Brings the service's runtime resources to the stored spec, running `image` with `env`,
   * and reports the image reference the runtime accepted (digest-pinned when it can be).
   * `hasDomainClaim` comes from the caller: this layer reads no control-plane state.
   */
  applyService(stored: StoredSpec, image: string, env: Record<string, string>, lease: ReconciliationLeaseGuard, hasDomainClaim: boolean): Promise<string | null>,
  observeService(stored: StoredSpec): Promise<RuntimeObservation>,
  /** Removes every runtime resource of the service except its persistent disks. */
  deleteService(stored: StoredSpec | null, ns: string, key: string, lease: ReconciliationLeaseGuard): Promise<void>,
  address(ns: string, key: string, stored: StoredSpec): Promise<RuntimeAddress>,
  /**
   * The private host of a service that is a pure function of its identity, or null when the
   * runtime only knows it once the service runs. Fly answers here (6PN DNS publishes
   * "<app>.internal" the moment the app exists), which is what lets a reference to a service
   * that has not been applied yet — a sibling later in the same deploy — resolve up front.
   * GCP has no such name, so a reference there waits for the target's address.
   */
  staticPrivateHost(ns: string, key: string): string | null,
  /** A stable, non-null stand-in for `outputs.hostname` when the runtime has none yet. */
  hostnamePlaceholder(ns: string, key: string): string,
  serviceLogs(stored: StoredSpec, sinceMillis: number | undefined, instance: string | undefined): Promise<LogPage>,
  /** The live build log while the builder runs, already scrubbed with `redactionValues`. */
  builderLogsLive(deployment: StoredDeployment, sinceMillis: number | undefined, redactionValues: string[]): Promise<LogPage>,
  /** The whole build log at terminal state, already scrubbed; empty when nothing could be read. */
  builderLogsDrain(deployment: StoredDeployment, redactionValues: string[]): Promise<LogLine[]>,
  /** Null when the check itself failed transiently — the caller leaves the deployment alone. */
  builderLiveness(deployment: StoredDeployment): Promise<BuilderLiveness | null>,
  deleteBuilder(deployment: StoredDeployment): Promise<void>,
  /** Provider credentials that must never appear in a build log. */
  buildRedactionValues(): string[],
  domains: {
    attach(ns: string, hostname: string, serviceKey: string): Promise<AttachDomainResult>,
    read(ns: string, hostname: string): Promise<AttachDomainResult>,
    detach(ns: string, hostname: string, expectedServiceKey: string | undefined): Promise<void>,
    /** The domain states reported on a service, for getServiceState. */
    statesFor(ns: string, key: string, stored: StoredSpec): Promise<ServiceDomainState[]>,
    /** Releases every hostname the service holds, provider resources included. Part of deleteService. */
    releaseForService(ns: string, key: string, stored: StoredSpec | null, lease: ReconciliationLeaseGuard): Promise<void>,
  },
};

const providers: Partial<Record<DeploymentRuntime, RuntimeProvider>> = {};

export function providerFor(runtime: DeploymentRuntime): RuntimeProvider {
  const existing = providers[runtime];
  if (existing !== undefined) return existing;
  const created = runtime === "fly" ? createFlyProvider() : createGcpProvider();
  providers[runtime] = created;
  return created;
}

/**
 * The provider a namespace's services run on. With `requested`, the request's runtime is
 * reconciled with the pin first (see resolveNamespaceRuntime); without it, this is a read.
 */
export async function providerForNamespace(ns: string, requested?: DeploymentRuntime): Promise<RuntimeProvider> {
  return providerFor(await resolveNamespaceRuntime(ns, requested));
}

export function resetProvidersForTests(): void {
  for (const runtime of Object.keys(providers) as DeploymentRuntime[]) delete providers[runtime];
}
