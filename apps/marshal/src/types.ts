// The Hexclave Runtime API types, verbatim from the contract. Marshal implements the
// runtime side; apps/backend is the only caller. Everything is snake_case because these
// are wire shapes.

// Opaque discriminator; a future type is a runtime-only change. v1 has "server" and
// "serverless" (see ContainerConfig.type).
export type ServiceType = string;

// Caller-resolved value, or a ref the runtime resolves locally. Refs carry no namespace —
// cross-tenant references are unrepresentable. A ref to a not-yet-provisioned output (only
// a private service's domain-dependent `url` can be missing) makes the service `blocked`;
// the backend re-applies when the blocking output appears.
export type EnvValue =
  | { value: string }
  // "<service_key>.<output_key>", with an optional ":<port>" on `url`.
  | { ref: string };

// A zonal persistent disk mounted into the container. A disk attaches to one server VM, so
// only a "server" (single-instance by construction) can hold one. size_gb is grow-only.
export type VolumeConfig = {
  path: string, // absolute, normalized mount point inside the container
  size_gb: number,
};

// "server"     → one Compute Engine instance, the only type that may mount a volume. There
//                is no request-triggered suspend, so min_instances 0 does not scale it to zero.
// "serverless" → scales between bounds, autostop "stop": every start is cold, no volume.
export type ServiceKind = "server" | "serverless";

// How one port the container listens on is exposed. Visibility is deliberately a property
// of the whole container (see ContainerConfig.public), not an individual port.
//
// A "tcp" port is raw, and only a PRIVATE service may declare one: a shared
// public IPv4 tells apps apart by SNI or Host, and raw TCP carries neither.
export type PortConfig = {
  protocol: "http" | "tcp",
};

// The ports a service listens on, KEYED BY PORT NUMBER (as a decimal string —
// JSON has no numeric keys). The same shape the deploy file writes, kept
// unchanged through the backend so nothing translates between two spellings of
// one thing, and so a duplicate port is impossible by construction.
export type PortsConfig = Record<string, PortConfig>;

// One declared port with its number parsed out, for the many places that have to
// compare, count or iterate ports. Ascending by number, so every caller sees the
// same order (key order would put "80" after "8080" for one caller and not
// another).
export type PortEntry = { port: number, protocol: "http" | "tcp" };

export function portEntries(ports: PortsConfig): PortEntry[] {
  const entries: PortEntry[] = [];
  for (const [portKey, config] of Object.entries(ports)) {
    if (!/^[0-9]{1,5}$/.test(portKey)) continue;
    const port = Number(portKey);
    if (port < 1 || port > 65535) continue;
    entries.push({ port, protocol: config.protocol });
  }
  return entries.sort((a, b) => a.port - b.port);
}

export type ContainerConfig = {
  type: ServiceKind,
  min_instances: number,
  max_instances: number, // >= min_instances; v1 cap: 10. Always 0/1 for "server".
  // Whether the service takes public ingress. The whole container, not one port.
  //
  // A public service must be all-HTTP and must declare at least one port; both
  // are enforced in validateServiceSpec.
  public: boolean,
  // May be empty (a worker that only dials out; then `public` must be false).
  // Readiness = a declared port accepts connections.
  ports: PortsConfig,
  // Absent = the container filesystem is entirely ephemeral. Keyed by VOLUME ID, which
  // contributes to the stable persistent-disk identity. At most one entry.
  persistent_volumes?: Record<string, VolumeConfig>,
  // A single command line to start the container with, INSTEAD of whatever the
  // image would have started. Absent = the image decides.
  //
  // It replaces the image's entrypoint and command, so it is container config rather than
  // image content: it takes effect on a runtime roll and never causes a build.
  //
  // Run through `/bin/sh -c`, so an image without a shell cannot use one.
  start_command?: string,
  // How much memory the container gets, in megabytes. Absent = the type's
  // default (DEFAULT_SERVER_MEMORY_MB / DEFAULT_SERVERLESS_MEMORY_MB), and the
  // caller omits it rather than restating the default — see computeRevision,
  // which hashes this and would otherwise replace a "server" VM for an edit
  // that changed nothing.
  //
  // The CPU that comes with it is derived here, not sent: a "server" runs on a
  // machine shape from a fixed catalog and a "serverless" container has legal
  // cpu/memory pairs rather than free choice, so a caller-named CPU could ask
  // for a combination no provider will accept.
  memory_mb?: number,
};

export type ServiceSpec = {
  config: ContainerConfig,
  // Always an already-built image. Images are produced by a DEPLOYMENT, which
  // builds every service of a deployment source from one uploaded tree in one
  // builder machine (see startSourceDeployment); the applies follow the build.
  source: { image: string },
  env: Record<string, EnvValue>,
  // No `domains` field — hostnames attach via the domain routes.
};

// ---------------------------------------------------------------------------
// Deployments: one `hexclave deploy` of one deployment source.

// What to build for one service, and what to run once its image exists.
export type DeploymentTarget = {
  service_key: string,
  // Where the service's code lives inside the uploaded tree. The build CONTEXT
  // is the whole upload (a monorepo service usually has to reach shared code
  // above its own directory); this only scopes where detection starts.
  root_directory?: string,
  // Relative to the ROOT of the upload; absent = the builder auto-detects the
  // build with Railpack (https://railpack.com).
  dockerfile_path?: string,
  // An image. Mutually exclusive with `dockerfile_path`: each of them says what
  // the build starts from.
  //
  // ALONE, it is the image to run: the target takes no part in the deployment's
  // build, and starts "pending" rather than "building" because there is nothing
  // to wait for. Stored as the author wrote it, normalized but NOT resolved — a
  // tag reaches the runtime config as a tag and the platform resolves it when it pulls.
  //
  // With a `build_command` it is instead the BASE of a generated Dockerfile, and
  // the target is built like any other. `targetIsBuilt` is the one place that
  // decides which of the two a target is.
  image?: string,
  // A single command line run while this target's image is built.
  //
  // With a `dockerfile_path` it is APPENDED to the author's Dockerfile as a
  // final RUN. Otherwise it selects a GENERATED Dockerfile, whose base is
  // `image` if one is named and BASE_IMAGE otherwise, into which the whole
  // upload is copied.
  build_command?: string,
  // The spec to apply once the image exists; its `source` is filled in with what
  // the build produced.
  spec: Omit<ServiceSpec, "source">,
};

/**
 * Whether a target takes part in the deployment's BUILD.
 *
 * The one place that decides it. Everything downstream is keyed off this answer
 * — whether the deployment needs an upload at all, whether it starts a builder
 * machine (and so whether it has a build log), and whether the target's initial
 * status is "building" or "pending" — and those must not be able to disagree.
 *
 * An `image` alone is the only shape that is not built: adding a `build_command`
 * turns that image into a base.
 */
export function targetIsBuilt(target: Pick<DeploymentTarget, "image" | "build_command">): boolean {
  return target.image === undefined || target.build_command !== undefined;
}

/**
 * Whether a built target's Dockerfile is GENERATED (a base image with the upload
 * copied onto it) rather than the author's own or Railpack's auto-detected plan.
 *
 * Only a `build_command` selects it, and a `start_command` deliberately does
 * not: the start command is machine configuration that works on whatever image
 * the target ends up with, so letting it decide the BUILD would mean that saying
 * "run it this way" silently discarded the install and compile steps Railpack
 * was doing. KEPT IN SYNC WITH deploymentServiceUsesGeneratedDockerfile in
 * @hexclave/shared.
 */
export function targetUsesGeneratedDockerfile(target: Pick<DeploymentTarget, "image" | "dockerfile_path" | "build_command">): boolean {
  if (target.build_command === undefined) return false;
  return target.dockerfile_path === undefined;
}

export type DeploymentStatus = "queued" | "building" | "deploying" | "succeeded" | "failed" | "canceled";

// "skipped" = the deployment stopped before reaching it (the build failed, or an
// earlier level did).
export type DeploymentServiceStatus = "pending" | "building" | "deploying" | "deployed" | "failed" | "skipped";

export type DeploymentServiceState = {
  service_key: string,
  status: DeploymentServiceStatus,
  revision: string | null,
  url: string | null,
  // The digest-pinned image this service was applied with, once it has been —
  // what a built target pushed, or what a prebuilt target's reference resolved
  // to. Null until the apply happens. Reported because the tag an author writes
  // and the bytes that run are different facts, and only the second one explains
  // a bad deploy.
  image: string | null,
  error: string | null,
};

export type Deployment = {
  id: string, // ULID (time-ordered)
  source_id: string,
  status: DeploymentStatus,
  has_logs: boolean,
  error: string | null,
  started_at_millis: number,
  finished_at_millis: number | null,
  services: DeploymentServiceState[],
};

export type DnsRecord = { type: string, name: string, value: string };

export type ServiceDomainState = {
  hostname: string,
  verified: boolean,
  dns_records: DnsRecord[],
  error: string | null,
};

export type ServiceStatus =
  | "pending" | "blocked" | "building" | "deploying" | "running"
  | "idle" | "degraded" | "failed" | "stopped";

export type ServiceState = {
  key: string,
  type: ServiceType,
  status: ServiceStatus,
  instances: number, // currently running; 0 while idle; serverful is 0 or 1
  revision: string | null, // currently running
  target_revision: string | null, // converging toward, when different
  // `hostname` — a pure function of the service identity, so always present.
  // `url` — the public URL, null until the service is up (or a domain verifies).
  outputs: Record<string, string | null>,
  domains: ServiceDomainState[],
  error: string | null,
  observed_at_millis: number,
};

export type LogLine = {
  at_millis: number,
  stream: "stdout" | "stderr" | "system",
  instance: string | null, // null for build logs and platform "system" events
  text: string,
};

// ---------------------------------------------------------------------------
// Bucket-stored shapes (internal to Marshal, never returned verbatim)

export type StoredSpec = {
  ns: string,
  key: string,
  // env keeps the original EnvValue forms ({ref} vs {value}); source is rewritten from
  // { upload_id } to { image } on build success so re-applies don't rebuild.
  spec: ServiceSpec,
  revision: string,
  created_at_millis: number,
  updated_at_millis: number,
  // Last machine-apply failure, surfaced as ServiceState.error until a later apply succeeds.
  last_apply_error: string | null,
};

export type StoredDeployment = Omit<Deployment, "services"> & {
  ns: string,
  // Dependency levels of service keys: everything in one level is applied
  // concurrently, and a level starts only once the previous one has converged.
  order: string[][],
  targets: DeploymentTarget[],
  // Per-target state, keyed by service key.
  services: Record<string, DeploymentServiceState>,
  // The image each target will run, keyed by service key. Targets that name a
  // prebuilt image are here from the moment the deployment is created (nothing
  // has to resolve first); the rest are filled in by the build-completion
  // webhook, which MERGES into this rather than replacing it.
  //
  // What a target will RUN, which for a tag is not the same as which bytes it
  // ran — that is reported per service in `services`.
  images: Record<string, string>,
  // Set for real GCP builds so live logs can be proxied from the builder VM and the
  // lazy backstop can detect a dead builder. Null for mock builds.
  builder_app: string | null,
  builder_machine_id: string | null,
  // The builder size the caller asked for, in megabytes, or null to let the
  // build shape decide. Stored on the DEPLOYMENT because that is the scope a
  // builder has: one machine builds every target of one deployment.
  builder_memory_mb: number | null,
  // The upload the build consumed, kept for diagnostics; the bytes themselves are
  // copied to a deployment-specific object and the original is deleted once the
  // build owns its copy. Null when every target names a prebuilt image: nothing
  // is built, so nothing was uploaded.
  upload_id: string | null,
};

export type ReconciliationLease = {
  owner_id: string,
  expires_at_millis: number,
};

// Namespace record: its runtime pin and, on GCP, its tenant project assignment. Google's
// multi-tenant guidance recommends assigning pre-created projects to tenants on demand
// (https://docs.cloud.google.com/run/docs/securing/multi-tenant), so the id is NOT derived
// from the namespace: this mapping is the idempotency anchor that keeps reconciliation
// deterministic across restarts and Marshal replicas.
export type TenantRecord = {
  // Which infrastructure runtime this namespace's services run on. Absent record = "fly".
  // See runtime.ts for how it is pinned.
  runtime: "fly" | "gcp",
  // The tenant GCP project, once one has been assigned. Null until the first GCP deploy
  // claims one, and carried across a re-pin so a namespace that leaves GCP and comes back
  // reuses the project it already had.
  project_id: string | null,
};

// One entry of the pre-provisioned tenant project pool. A project enters the pool only
// after it is fully provisioned (created, billed, APIs enabled, runtime IAM granted), so
// claiming one is a pure bucket operation — no GCP latency in the deploy-start path.
//
// The states before `ready` are RESUME POINTS, not scheduled stages: provisioning runs on
// a cron-driven advancer whose process can be frozen at any instruction (Vercel freezes the
// sandbox the moment a response is written), so every step has to be re-enterable from
// whatever the bucket last recorded. `creating` in particular is written BEFORE the Resource
// Manager POST — a freeze between the POST and the record would otherwise leave a billable
// GCP project that nothing in the bucket knows about, and therefore nothing can ever reap.
//
//   creating        — the record exists; the project may or may not exist yet in GCP
//   billing_pending — the project is ACTIVE; Cloud Billing has not accepted it yet
//   apis_pending    — billing attached; `operation_name` is the batchEnable to poll
//   iam_pending     — APIs enabled; service identity and runtime bindings still to grant
//   ready           — fully provisioned and claimable
//   claimed         — assigned to `ns`
//   condemned       — given up on; the reaper deletes the GCP project and the entry
export const POOL_PROJECT_STATES = ["creating", "billing_pending", "apis_pending", "iam_pending", "ready", "claimed", "condemned"] as const;

export type PoolProjectState = (typeof POOL_PROJECT_STATES)[number];

// Deliberately a flat record rather than a discriminated union: every state transition is a
// read-modify-CAS-write of the whole entry, and a union would make each one restate fields
// that are simply carried forward. `ns` is meaningful only in `claimed`.
export type PoolProjectEntry = {
  state: PoolProjectState,
  // When the entry was first written — which, because the record precedes the create call,
  // is also the earliest moment a billable project could exist. The reaper's stall check
  // measures from here.
  created_at_millis: number,
  // When the state last changed. The reaper's claim grace measures from HERE, not from
  // created_at_millis: a project claimed weeks after it was provisioned must not be treated
  // as instantly past its grace.
  state_since_millis: number,
  attempts: number,
  last_error: string | null,
  // The in-flight Service Usage batchEnable operation. Stored so a tick resuming after a
  // freeze polls the enablement already running instead of starting a second one.
  operation_name: string | null,
  project_number: string | null,
  ns: string | null,
};

// Global hostname-uniqueness registry entry (the infrastructure provider does not enforce
// cross-app hostname uniqueness, so Marshal owns it). Claimed with a conditional PUT.
export type DomainClaim = {
  hostname: string,
  ns: string,
  service_key: string,
  claimed_at_millis: number,
  // Present while provider cleanup is in progress. The global reservation remains until
  // cleanup succeeds, so a failed delete can be retried without a new owner racing it.
  deleting_at_millis?: number,
};

// A request to attach a hostname is tenant-local until DNS proves control. Keeping pending
// requests out of the global claim key prevents an unverified tenant from squatting a name.
export type PendingDomainClaim = {
  hostname: string,
  ns: string,
  service_key: string,
  verification_token: string,
  created_at_millis: number,
  expires_at_millis: number,
};
