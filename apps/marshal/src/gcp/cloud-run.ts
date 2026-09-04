import { setTimeout as delay } from "node:timers/promises";
import { GcpApiError, GcpClient, parseGcpOperation } from "./client.js";

export type CloudRunConfig = {
  projectId: string,
  region: string,
  network: string,
  subnetwork: string,
};

export type CloudRunServiceSpec = {
  name: string,
  image: string,
  env: Record<string, string>,
  port: number,
  public: boolean,
  minInstances: number,
  maxInstances: number,
  revision: string,
  startCommand: string | null,
  serviceKeyHash: string,
  // Container resources, derived from the spec's memory by the caller. CPU is
  // not independently chosen: Cloud Run accepts only certain cpu/memory PAIRS
  // (past 4 GiB one CPU is not among them), so the pair travels together.
  memoryMb: number,
  cpu: number,
};

export type CloudRunObservation = {
  exists: boolean,
  ready: boolean,
  uri: string | null,
  latestReadyRevision: string | null,
  targetRevision: string | null,
  runningInstances: number,
  error: string | null,
  imageDigest: string | null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function cloudRunError(service: Record<string, unknown>): string | null {
  const conditions = service.terminalCondition;
  if (!isRecord(conditions)) return null;
  if (conditions.state !== "CONDITION_FAILED") return null;
  // NOTE: `conditions.message` is the provider's own string and reaches ServiceState.error,
  // which the CLI and dashboard show — it can carry the tenant project, resource name and
  // image path. Sanitizing it belongs at the runtime.ts boundary (where the raw text is
  // still available to GcpApiError and the server logs) and is deliberately left for later.
  return typeof conditions.message === "string" ? conditions.message : "the service revision failed to become ready";
}

function observedInstances(service: Record<string, unknown>): number {
  // Cloud Run intentionally does not expose the instantaneous autoscaler count on the
  // service resource. A ready service with a non-zero minimum has at least that many;
  // scale-to-zero services report zero until request metrics say otherwise. Marshal avoids
  // inventing a request-time count that the control plane does not provide.
  const scaling = service.scaling;
  if (!isRecord(scaling)) return 0;
  return typeof scaling.minInstanceCount === "number" ? scaling.minInstanceCount : 0;
}

function parseObservation(value: unknown): CloudRunObservation {
  if (!isRecord(value)) throw new Error("Cloud Run returned an invalid service resource");
  const terminalCondition = value.terminalCondition;
  // `reconciling` has to be part of readiness. During an update Cloud Run keeps the PREVIOUS
  // successful terminalCondition while it rolls the new revision, and the revision label this
  // observation reads for targetRevision is updated by the PATCH immediately — so terminal
  // condition alone reports ready AND at-target against the old latestReadyRevision and image
  // digest, which is a green deploy of the image the service was already running.
  const ready = value.reconciling !== true && isRecord(terminalCondition) && terminalCondition.state === "CONDITION_SUCCEEDED";
  const labels = isRecord(value.labels) ? value.labels : {};
  return {
    exists: true,
    ready,
    uri: stringOrNull(value.uri),
    latestReadyRevision: stringOrNull(value.latestReadyRevision),
    targetRevision: stringOrNull(labels["hexclave-revision"]),
    runningInstances: ready ? observedInstances(value) : 0,
    error: cloudRunError(value),
    imageDigest: null,
  };
}

function revisionImageDigest(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.status)) return null;
  return stringOrNull(value.status.imageDigest);
}

export class CloudRunClient {
  constructor(
    private readonly client: GcpClient,
    private readonly config: CloudRunConfig,
  ) {}

  private resourceName(serviceName: string): string {
    return `projects/${this.config.projectId}/locations/${this.config.region}/services/${serviceName}`;
  }

  private serviceUrl(serviceName: string): string {
    return `https://run.googleapis.com/v2/${this.resourceName(serviceName)}`;
  }

  async get(serviceName: string): Promise<CloudRunObservation> {
    const value = await this.client.request(this.serviceUrl(serviceName), { allow404: true });
    return value === null
      ? { exists: false, ready: false, uri: null, latestReadyRevision: null, targetRevision: null, runningInstances: 0, error: null, imageDigest: null }
      : parseObservation(value);
  }

  async apply(spec: CloudRunServiceSpec): Promise<CloudRunObservation> {
    const resourceName = this.resourceName(spec.name);
    const service = {
      labels: {
        "hexclave-managed": "true",
        "hexclave-revision": spec.revision,
        "hexclave-service-key": spec.serviceKeyHash,
      },
      // Private services accept VPC-internal traffic and traffic from an external Application
      // Load Balancer. The latter supports an attached custom domain while the default
      // run.app URL remains unreachable directly from the Internet.
      ingress: spec.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      // Google recommends disabling the invoker check for public services, particularly
      // under domain-restricted-sharing policies where an allUsers IAM binding is rejected.
      // Private services remain network-restricted by ingress while allowing the load
      // balancer and tenant VPC to invoke without distributing Google identity tokens.
      invokerIamDisabled: true,
      scaling: {
        minInstanceCount: spec.minInstances,
        maxInstanceCount: spec.maxInstances,
      },
      template: {
        labels: { "hexclave-revision": spec.revision },
        maxInstanceRequestConcurrency: 25,
        timeout: "300s",
        vpcAccess: {
          networkInterfaces: [{ network: this.config.network, subnetwork: this.config.subnetwork }],
          // Marshal provisions no Cloud NAT. Route only private ranges through Direct VPC
          // egress so service-to-service/VM traffic stays private while ordinary Internet
          // calls keep using Cloud Run's managed outbound path.
          egress: "PRIVATE_RANGES_ONLY",
        },
        containers: [{
          image: spec.image,
          env: Object.entries(spec.env).filter(([name]) => name !== "PORT").map(([name, value]) => ({ name, value })),
          ports: [{ name: "http1", containerPort: spec.port }],
          // "Mi" is the unit Cloud Run takes, and it is what our megabytes mean:
          // the sizes are binary, spelled in the decimal shorthand everybody
          // reads. Nothing converts, so nothing can convert wrongly.
          resources: { limits: { cpu: String(spec.cpu), memory: `${spec.memoryMb}Mi` }, cpuIdle: spec.minInstances === 0 },
          ...(spec.startCommand === null ? {} : { command: ["/bin/sh"], args: ["-c", spec.startCommand] }),
        }],
      },
    };
    const existing = await this.get(spec.name);
    const result = existing.exists
      // Deliberately NO updateMask. Cloud Run v2 treats `updateMask=*` as an empty field
      // list: it answers 200 with a DONE operation carrying the UNCHANGED resource, never
      // bumps the generation, and does not even validate the body — verified against real
      // Cloud Run, where every update silently no-opped and the revision waiter then timed
      // out on a `hexclave-revision` label that could never appear. With the mask omitted,
      // the patch updates the fields the body carries and clears the ones it leaves empty
      // (an empty `env` array does remove the container's environment, also verified).
      ? await this.client.request(this.serviceUrl(spec.name), { method: "PATCH", body: { ...service, name: resourceName } })
      : await this.client.request(`https://run.googleapis.com/v2/projects/${this.config.projectId}/locations/${this.config.region}/services?serviceId=${encodeURIComponent(spec.name)}`, { method: "POST", body: service });
    await this.client.waitForOperation(parseGcpOperation(result), { apiBaseUrl: "https://run.googleapis.com/v2/", timeoutMillis: 10 * 60 * 1000 });
    const observation = await this.waitForReadyRevision(spec.name, spec.revision);
    if (!observation.ready) throw new GcpApiError(502, resourceName, observation.error ?? "Cloud Run service did not become ready");
    if (observation.latestReadyRevision === null) throw new Error(`ready Cloud Run service ${resourceName} reported no ready revision`);
    const revisionName = observation.latestReadyRevision.split("/").at(-1) ?? throwError(`Cloud Run returned an invalid ready revision for ${resourceName}`);
    const revision = await this.client.request(`https://${encodeURIComponent(this.config.region)}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${encodeURIComponent(this.config.projectId)}/revisions/${encodeURIComponent(revisionName)}`);
    const imageDigest = revisionImageDigest(revision) ?? throwError(`ready Cloud Run revision ${revisionName} reported no resolved image digest`);
    return { ...observation, imageDigest };
  }

  private async waitForReadyRevision(serviceName: string, revision: string): Promise<CloudRunObservation> {
    const startedAt = performance.now();
    for (;;) {
      const observation = await this.get(serviceName);
      if (observation.targetRevision === revision && observation.ready) return observation;
      if (observation.targetRevision === revision && observation.error !== null) {
        throw new GcpApiError(502, this.resourceName(serviceName), observation.error);
      }
      if (performance.now() - startedAt > 10 * 60 * 1000) {
        throw new GcpApiError(408, this.resourceName(serviceName), `timed out waiting for revision ${revision} to become ready`);
      }
      await delay(1000);
    }
  }

  async delete(serviceName: string): Promise<void> {
    const result = await this.client.request(this.serviceUrl(serviceName), { method: "DELETE", allow404: true });
    if (result !== null) await this.client.waitForOperation(parseGcpOperation(result), { apiBaseUrl: "https://run.googleapis.com/v2/", timeoutMillis: 10 * 60 * 1000 });
  }
}

function throwError(message: string): never {
  throw new Error(message);
}
