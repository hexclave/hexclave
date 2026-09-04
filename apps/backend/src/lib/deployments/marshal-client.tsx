import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";

// Thin client for Marshal, the GCP-backed deployments runtime (apps/marshal).
// Marshal implements the Hexclave Runtime API: stateless, namespace-scoped
// (the namespace is the tenancy id), single bearer credential. This module is
// the only place backend code talks to it.

const MOCK_MARSHAL_KEY = "mock_hexclave_marshal_key";

export type MarshalDeploymentsConfig = {
  apiKey: string,
  baseUrl: string,
};

export function getMarshalDeploymentsConfigOrNull(): MarshalDeploymentsConfig | null {
  const apiKey = getEnvVariable("HEXCLAVE_MARSHAL_API_KEY", "");
  if (!apiKey) {
    return null;
  }
  let baseUrl = getEnvVariable("HEXCLAVE_MARSHAL_URL", "") || undefined;
  if (apiKey === MOCK_MARSHAL_KEY) {
    // The mock key is only allowed in dev/test — or on a localhost-hosted
    // instance, because the local QA setup runs *production builds* of the
    // backend on localhost (NODE_ENV=production) and still needs the local
    // Marshal (which itself talks to gcp-mock).
    const isLocalhostInstance = /^(.*\.)?localhost$|^127\.0\.0\.1$/.test(new URL(getEnvVariable("NEXT_PUBLIC_STACK_API_URL", "http://invalid.example.com")).hostname);
    if (!["development", "test"].includes(getNodeEnvironment()) && !isLocalhostInstance) {
      throw new HexclaveAssertionError("Mock Marshal key used in production; please set the HEXCLAVE_MARSHAL_API_KEY environment variable to a real credential.");
    }
    if (!baseUrl) {
      const prefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
      baseUrl = `http://localhost:${prefix}47`;
    }
  }
  if (!baseUrl) {
    return null;
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

// Statuses that indicate OUR request was bad in a way the caller can fix
// (invalid spec, missing upload, hostname conflict). Everything else — auth
// failures (our credential), 5xx, 502 upstream_api_error relays — is an
// infrastructure problem the caller can't do anything about.
const USER_INPUT_MARSHAL_STATUSES = new Set([400, 404, 409]);

export class MarshalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly marshalMessage: string,
    public readonly endpoint: string,
  ) {
    super(`Marshal API error at ${endpoint}: ${status} ${code}: ${marshalMessage}`);
    this.name = "MarshalApiError";
  }
}

/**
 * Converts an error from a Marshal call into what the client should see:
 * expected request-level rejections become clean 400/404/409s with Marshal's
 * message (Marshal never embeds infrastructure identifiers in those), while
 * everything else becomes an assertion error — logged server-side with full
 * detail, hidden from the client.
 */
export function sanitizeMarshalError(error: unknown, context: string): never {
  if (error instanceof MarshalApiError) {
    if (USER_INPUT_MARSHAL_STATUSES.has(error.status)) {
      throw new StatusError(error.status === 409 ? 409 : 400, `${context}: ${error.marshalMessage}`);
    }
    throw new HexclaveAssertionError(`${context}: Marshal request failed unexpectedly`, { cause: error });
  }
  throw error;
}

export type MarshalEnvValue = { value: string } | { ref: string };

export type MarshalServiceSpec = {
  config: {
    type: "server" | "serverless",
    // Whether Marshal allocates public ingress. A property of the SERVICE: the
    // GCP ingress fronts the service as a unit, so
    // there is no such thing as a public port with a private sibling. Marshal
    // re-validates that a public service is all-HTTP and declares a port.
    public: boolean,
    // The ports the container listens on, keyed by port number.
    ports: Record<string, { protocol: "http" | "tcp" }>,
    // Persistent disks keyed by volume id; absent = ephemeral filesystem.
    // Marshal requires type "server" when one is set.
    persistent_volumes?: Record<string, { path: string, size_gb: number }>,
    // A single command line the runtime starts the container with, instead of
    // whatever the image would have started. Absent = the image decides. It is
    // machine configuration rather than image content, so it takes effect on a
    // roll and never causes a build.
    start_command?: string,
  },
  // A spec always names an already-built image: images are produced by the
  // deployment's single build, which builds every service of the deployment
  // source from one upload in one builder machine, and the applies follow it.
  source: { image: string },
  env: Record<string, MarshalEnvValue>,
};

// One service's slot in a deployment: what to build, and what to run.
//
// `dockerfile_path` is relative to the root of the uploaded source (the whole
// deployment source is uploaded once, so a monorepo service can COPY from above its own
// directory); absent = the builder auto-detects the build with Railpack, or
// generates a Dockerfile when a `build_command` says what to run instead.
// `root_directory` scopes where detection starts, and is the directory a
// `build_command` runs in.
export type MarshalDeploymentTarget = {
  service_key: string,
  root_directory?: string,
  dockerfile_path?: string,
  // An image. On its own it is the image to RUN: the runtime resolves the
  // reference to a digest and applies it, and this target enters no build. With
  // a `build_command` it is the BASE of a generated Dockerfile instead, and the
  // target is built like any other. Mutually exclusive with `dockerfile_path`.
  image?: string,
  // A single command line run while the image is built. Its base is `image`, or
  // `dockerfile_path`'s Dockerfile (where the runtime appends it as a final
  // RUN), or the runtime's own base image.
  build_command?: string,
  // The spec to apply once this target's image exists. Its `source` is filled in
  // by the runtime with the image the build produced (or with the digest the
  // reference above resolved to).
  spec: Omit<MarshalServiceSpec, "source">,
};

export type MarshalServiceState = {
  key: string,
  type: string,
  status: "pending" | "blocked" | "building" | "deploying" | "running" | "idle" | "degraded" | "failed" | "stopped",
  instances: number,
  revision: string | null,
  target_revision: string | null,
  outputs: Record<string, string | null>,
  domains: { hostname: string, verified: boolean, dns_records: MarshalDnsRecord[], error: string | null }[],
  error: string | null,
  observed_at_millis: number,
};

export type MarshalDnsRecord = { type: string, name: string, value: string };

export type MarshalDeployment = {
  id: string,
  source_id: string,
  // "building" covers the whole batch build; "deploying" is the apply phase.
  // A build failure fails the WHOLE deployment and applies nothing: one machine
  // builds every image, so there is no partial success to salvage — and shipping
  // half a source is not what the author asked for.
  status: "queued" | "building" | "deploying" | "succeeded" | "failed" | "canceled",
  has_logs: boolean,
  error: string | null,
  started_at_millis: number,
  finished_at_millis: number | null,
  // One entry per requested target, in the order they were applied.
  services: {
    service_key: string,
    status: "pending" | "building" | "deploying" | "deployed" | "failed" | "skipped",
    revision: string | null,
    url: string | null,
    // The digest-pinned image the apply actually ran, once it has happened. The
    // tag an author writes and the bytes that run are different facts.
    image: string | null,
    error: string | null,
  }[],
};

export type MarshalLogLine = {
  at_millis: number,
  stream: "stdout" | "stderr" | "system",
  instance: string | null,
  text: string,
};

export type MarshalUploadSlot = {
  id: string,
  upload_url: string,
  content_type: string,
  expires_at_millis: number,
  max_bytes: number,
  // Present only for a source big enough to be worth sending in parts. Every
  // field is a presigned object-storage URL, so the client runs the multipart
  // lifecycle against the store directly and the backend only relays them.
  multipart?: {
    upload_id: string,
    part_size_bytes: number,
    part_urls: string[],
    complete_url: string,
    abort_url: string,
  } | null,
};

export type MarshalApplyResult = {
  revision: string,
  changed: boolean,
  state: MarshalServiceState,
};

export type MarshalDomainResult = {
  hostname: string,
  service_key: string,
  verified: boolean,
  dns_records: MarshalDnsRecord[],
};

// Every Marshal call is bounded. `fetch` has no default timeout, so without these a Marshal
// that accepts a connection and then stalls holds the backend invocation open forever —
// outliving even the build-log route's own four-minute stream cap. The generous tiers exist
// because some Marshal endpoints legitimately block on GCP: an apply waits for a Cloud Run
// revision or Compute Engine VM, and a delete tears down its runtime resources.
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const DELETE_TIMEOUT_MS = 5 * 60 * 1000;
const LIST_TIMEOUT_MS = 2 * 60 * 1000;
// Starting a source deployment is the same CLASS of work as an apply, and got
// the default tier only by omission. Before it answers, the runtime validates
// the uploaded archive (reading the whole tarball out of the bucket and copying
// it to a deployment-owned key — seconds for a small source, far longer for one
// near the 50 MB ceiling), calls ensureApp once PER TARGET in sequence, and then
// creates and starts the builder VM.
//
// On GCP there is one more synchronous cost, and it dominates: the FIRST
// deployment into a namespace provisions the tenant project before anything
// else — project creation, Cloud Billing's eventual-consistency window for the
// brand-new project (the runtime retries its precondition failure for up to ten
// minutes), and batch API enablement. The runtime keeps a pool of pre-provisioned
// projects to avoid exactly this (see apps/marshal/src/project-pool.ts), but when
// the pool is empty or disabled the request can legitimately run past five minutes.
// A timeout is therefore not fatal: reconciliation is idempotent and deterministic,
// so the caller can simply retry and land on the already-provisioned project.
//
// Deliberately BELOW the 800s Vercel maxDuration both services declare (see
// `src/index.ts` in each): this has to fire first, so the caller gets a clean
// 504 from here rather than a platform-killed invocation with no body at all.
const DEPLOY_START_TIMEOUT_MS = 13 * 60 * 1000;

export class MarshalClient {
  constructor(private readonly config: MarshalDeploymentsConfig) {}

  private async fetchMarshal<T>(path: string, init?: { method?: string, body?: unknown, timeoutMs?: number }): Promise<T> {
    const method = init?.method ?? "GET";
    const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          "authorization": `Bearer ${this.config.apiKey}`,
          ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        // Covers the body read below too — an abort tears down the whole exchange.
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Body consumption must stay inside the timeout catch: fetch resolves as soon as the
      // headers arrive, while a stalled response body rejects here with the same abort.
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        // 504 is deliberately not a USER_INPUT_MARSHAL_STATUS: a stalled runtime is an
        // infrastructure failure, so sanitizeMarshalError logs it and hides it from the client.
        throw new MarshalApiError(504, "timeout", `Marshal did not respond within ${Math.round(timeoutMs / 1000)}s`, `${method} ${path}`);
      }
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      const errorBody = (json ?? {}) as { error?: string, message?: string };
      throw new MarshalApiError(
        response.status,
        errorBody.error ?? "unknown",
        errorBody.message ?? text.slice(0, 500),
        `${method} ${path}`,
      );
    }
    return json as T;
  }

  // `sizeBytes` is what the client says it is about to upload. The runtime uses
  // it to decide whether to mint a multipart slot alongside the single-PUT URL;
  // omitting it yields the single-PUT slot on its own.
  async createUpload(ns: string, sizeBytes?: number): Promise<MarshalUploadSlot> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/uploads`, {
      method: "POST",
      body: { size_bytes: sizeBytes },
    });
  }

  // Starts a whole deployment: one uploaded source, one builder machine
  // that builds every target's image, then the applies in the given order.
  //
  // The runtime owns the entire sequence rather than the backend driving it step
  // by step, because the runtime is where the reconciliation lease and the build
  // completion webhook already live — a backend-driven version would have to
  // hold an HTTP request open across a multi-minute build, or re-derive
  // "what has been applied so far" on every poll.
  //
  // Returns as soon as the deployment is accepted; poll getDeployment.
  async startSourceDeployment(ns: string, sourceId: string, body: {
    // Omitted when every target names an already-built image: nothing is built,
    // so the runtime needs no source archive and starts no builder machine.
    upload_id?: string,
    targets: MarshalDeploymentTarget[],
    // Service keys grouped into dependency levels: everything in one level is
    // applied concurrently, and a level starts only once the previous one has
    // converged (a `url` ref can only resolve after its target is up).
    order: string[][],
  }): Promise<MarshalDeployment> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/sources/${sourceId}/deployments`, { method: "POST", body, timeoutMs: DEPLOY_START_TIMEOUT_MS });
  }

  async getDeployment(ns: string, deploymentId: string): Promise<MarshalDeployment> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/deployments/${deploymentId}`);
  }

  async getDeploymentLogs(ns: string, deploymentId: string, options?: { sinceMillis?: number }): Promise<{ lines: MarshalLogLine[], next_since_millis: number, complete: boolean }> {
    const params = new URLSearchParams();
    if (options?.sinceMillis !== undefined) params.set("since_millis", String(options.sinceMillis));
    const queryString = params.toString();
    return await this.fetchMarshal(`${urlString`/v1/namespaces/${ns}/deployments/${deploymentId}/logs`}${queryString === "" ? "" : `?${queryString}`}`);
  }

  async putService(ns: string, serviceKey: string, spec: MarshalServiceSpec): Promise<MarshalApplyResult> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/services/${serviceKey}`, { method: "PUT", body: spec, timeoutMs: APPLY_TIMEOUT_MS });
  }

  async getService(ns: string, serviceKey: string): Promise<MarshalServiceState> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/services/${serviceKey}`);
  }

  async deleteService(ns: string, serviceKey: string): Promise<void> {
    await this.fetchMarshal(urlString`/v1/namespaces/${ns}/services/${serviceKey}`, { method: "DELETE", timeoutMs: DELETE_TIMEOUT_MS });
  }

  async listServices(ns: string): Promise<MarshalServiceState[]> {
    const result = await this.fetchMarshal<{ services: MarshalServiceState[] }>(urlString`/v1/namespaces/${ns}`, { timeoutMs: LIST_TIMEOUT_MS });
    return result.services;
  }

  // Safe for "is it verified yet?" polling. Marshal may promote this tenancy's pending TXT
  // proof, but unlike putDomain this cannot repoint an already claimed hostname.
  async getDomain(ns: string, hostname: string): Promise<MarshalDomainResult> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/domains/${hostname}`);
  }

  async putDomain(ns: string, hostname: string, serviceKey: string): Promise<MarshalDomainResult> {
    return await this.fetchMarshal(urlString`/v1/namespaces/${ns}/domains/${hostname}`, { method: "PUT", body: { service_key: serviceKey } });
  }

  // serviceKey fences the delete: if the hostname has been repointed to another service in
  // this tenancy, Marshal 404s instead of detaching the new owner's live certificate.
  async deleteDomain(ns: string, hostname: string, serviceKey: string): Promise<void> {
    await this.fetchMarshal(`${urlString`/v1/namespaces/${ns}/domains/${hostname}`}?service_key=${encodeURIComponent(serviceKey)}`, { method: "DELETE" });
  }

  // NOTE: runtime (service) logs are NOT yet exposed by any backend route. Marshal does not
  // redact them (they can contain tenant secret values printed by the app), so a future route
  // that serves these MUST apply the same run-scoped redactSecrets pass the build-log route
  // uses — do not return this verbatim to clients.
  async getServiceLogs(ns: string, serviceKey: string, options?: { sinceMillis?: number, instance?: string }): Promise<{ lines: MarshalLogLine[], next_since_millis: number }> {
    const params = new URLSearchParams();
    if (options?.sinceMillis !== undefined) params.set("since_millis", String(options.sinceMillis));
    if (options?.instance !== undefined) params.set("instance", options.instance);
    const queryString = params.toString();
    return await this.fetchMarshal(`${urlString`/v1/namespaces/${ns}/services/${serviceKey}/logs`}${queryString === "" ? "" : `?${queryString}`}`);
  }
}

/**
 * Returns a Marshal client, or throws a 400 explaining deployments are
 * unconfigured. Deliberately a StatusError (not an assertion): an unconfigured
 * instance (e.g. a self-hoster without Marshal) is an expected state, and every
 * deployments route should answer it the same way.
 */
export function getMarshalClientOrThrow(): MarshalClient {
  const config = getMarshalDeploymentsConfigOrNull();
  if (config == null) {
    throw new StatusError(400, "Deploy is not configured on this Hexclave instance. Configure HEXCLAVE_MARSHAL_API_KEY (and HEXCLAVE_MARSHAL_URL if Marshal is not on the default local port) first.");
  }
  return new MarshalClient(config);
}
