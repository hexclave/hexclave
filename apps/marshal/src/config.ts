// All Marshal configuration comes from env vars — Marshal is stateless and holds no DB.
// Mock mode is refused unless the process explicitly opts in. This must not depend on
// NODE_ENV: an omitted production NODE_ENV must fail closed.
//
// Two infrastructure runtimes can be configured at once: Fly (the default, what every
// namespace runs on unless it says otherwise) and Google Cloud (opted into per namespace —
// see runtime.ts). Each is enabled by its own credentials being present; at least one must
// be. A request for a runtime that is not configured is refused at the request, not at
// startup, so a Marshal serving only Fly starts without any GCP configuration at all.

import { assertDataEncryptionKeyIsSafe, parseDataEncryptionRootKey } from "./spec-crypto.js";
import type { ServiceKind } from "./types.js";

export const MOCK_FLY_TOKEN = "mock_hexclave_fly_key";

export type FlyConfig = {
  token: string,
  orgSlug: string,
  machinesApiUrl: string,
  graphqlApiUrl: string,
  logsApiUrl: string,
  registryHost: string,
  region: string,
};

export type GcpConfig = {
  billingAccount: string,
  projectParent: string | null,
  projectPrefix: string,
  // How many fully provisioned tenant projects to keep ready for immediate assignment
  // (Google's multi-tenant recommendation). 0 disables the pool and every first deploy
  // into a namespace provisions its project synchronously.
  projectPoolSize: number,
  platformProjectId: string,
  existingProjectIdForTests: string | null,
  region: string,
  zone: string,
  network: string,
  subnetwork: string,
  mockUrl: string | null,
  mockToken: string | null,
};

export type MarshalConfig = {
  port: number,
  apiKey: string,
  // Vercel sets `Authorization: Bearer $CRON_SECRET` on its cron invocations. Accepted ONLY on
  // the maintenance routes, so the platform's scheduler does not have to be handed the
  // credential the backend uses for everything else. Null when unset, which is not a fallback
  // to anything: unset means Vercel sends no Authorization header and the crons cannot run.
  cronSecret: string | null,
  webhookSecret: string,
  dataEncryptionRootKey: Buffer,
  // Base URL builder machines use to reach the completion webhook. Only needed for real builds
  // (the mock builder completes in-process).
  publicUrl: string | null,
  envId: string,
  // Null = that runtime is not configured on this Marshal, and any namespace pinned to it is
  // refused. Read through `flyConfig()` / `gcpConfig()`, which say so instead of crashing on a
  // null field somewhere deep in a provider.
  fly: FlyConfig | null,
  gcp: GcpConfig | null,
  // "real" starts an ephemeral BuildKit machine on the namespace's runtime; "mock" completes
  // in-process with a fake digest (dev/e2e; non-prod only).
  builderKind: "real" | "mock",
  s3: {
    endpoint: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
    bucket: string,
    forcePathStyle: boolean,
  },
};

function env(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`marshal refuses to start: required env var ${name} is not set`);
}

function portPrefix(): string {
  return process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX || "81";
}

export function assertMocksExplicitlyAllowed(description: string, environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.MARSHAL_ALLOW_MOCKS !== "1") {
    throw new Error(`marshal refuses to start: ${description} requires MARSHAL_ALLOW_MOCKS=1`);
  }
}

// The gcp-mock docker service. On port-prefix 49, one above the fly-mock: both mocks run
// side by side locally, and the Fly one keeps the port it has always had.
export function resolveGcpMockUrl(value: string | undefined, prefix: string): string | null {
  const configured = (value || "").replace(/\/$/, "");
  return configured === "local" ? `http://localhost:${prefix}49` : configured || null;
}

let cached: MarshalConfig | null = null;

function readFlyConfig(): FlyConfig | null {
  const flyToken = (process.env.MARSHAL_FLY_API_TOKEN || "").trim();
  if (flyToken === "") return null;
  const isMockFly = flyToken === MOCK_FLY_TOKEN;
  if (isMockFly) assertMocksExplicitlyAllowed("the mock Fly token");
  // The fly-mock docker service serves all three API surfaces on one port.
  const flyMockUrl = `http://localhost:${portPrefix()}48`;
  return {
    token: flyToken,
    orgSlug: env("MARSHAL_FLY_ORG_SLUG"),
    machinesApiUrl: env("MARSHAL_FLY_MACHINES_API_URL", isMockFly ? flyMockUrl : "https://api.machines.dev").replace(/\/$/, ""),
    graphqlApiUrl: env("MARSHAL_FLY_GRAPHQL_API_URL", isMockFly ? `${flyMockUrl}/graphql` : "https://api.fly.io/graphql"),
    logsApiUrl: env("MARSHAL_FLY_LOGS_API_URL", isMockFly ? `${flyMockUrl}/api/v1` : "https://api.fly.io/api/v1").replace(/\/$/, ""),
    registryHost: env("MARSHAL_FLY_REGISTRY_HOST", "registry.fly.io"),
    region: env("MARSHAL_FLY_REGION", "iad"),
  };
}

function readGcpConfig(): GcpConfig | null {
  const existingProjectIdForTests = (process.env.HEXCLAVE_MARSHAL_GCP_EXISTING_PROJECT_ID_FOR_TESTS || "").trim() || null;
  const gcpMockUrl = resolveGcpMockUrl(process.env.HEXCLAVE_MARSHAL_GCP_MOCK_URL, portPrefix());
  const platformProjectId = (process.env.HEXCLAVE_MARSHAL_GCP_PLATFORM_PROJECT_ID || "").trim();
  // The platform project is the one thing every GCP mode needs (mock, existing-project
  // tests, and production alike), so its absence is what "GCP is not configured" means.
  if (platformProjectId === "") {
    if (existingProjectIdForTests !== null || gcpMockUrl !== null || (process.env.HEXCLAVE_MARSHAL_GCP_BILLING_ACCOUNT || "") !== "") {
      throw new Error("marshal refuses to start: HEXCLAVE_MARSHAL_GCP_* is partially configured; set HEXCLAVE_MARSHAL_GCP_PLATFORM_PROJECT_ID to enable the GCP runtime or unset the rest to disable it");
    }
    return null;
  }
  if (existingProjectIdForTests !== null) assertMocksExplicitlyAllowed("HEXCLAVE_MARSHAL_GCP_EXISTING_PROJECT_ID_FOR_TESTS");
  if (gcpMockUrl !== null) assertMocksExplicitlyAllowed("HEXCLAVE_MARSHAL_GCP_MOCK_URL");
  const projectPoolSizeRaw = process.env.HEXCLAVE_MARSHAL_GCP_PROJECT_POOL_SIZE || "0";
  const projectPoolSize = Number(projectPoolSizeRaw);
  if (!Number.isInteger(projectPoolSize) || projectPoolSize < 0 || projectPoolSize > 100) {
    throw new Error(`marshal refuses to start: HEXCLAVE_MARSHAL_GCP_PROJECT_POOL_SIZE must be an integer between 0 and 100 (got ${JSON.stringify(projectPoolSizeRaw)})`);
  }
  const region = env("HEXCLAVE_MARSHAL_GCP_REGION", "us-central1");
  const zone = env("HEXCLAVE_MARSHAL_GCP_ZONE", `${region}-a`);
  return {
    billingAccount: env("HEXCLAVE_MARSHAL_GCP_BILLING_ACCOUNT", existingProjectIdForTests === null ? undefined : "test-only"),
    projectParent: (process.env.HEXCLAVE_MARSHAL_GCP_PROJECT_PARENT || "").replace(/^\/+|\/+$/g, "") || null,
    projectPrefix: env("HEXCLAVE_MARSHAL_GCP_PROJECT_PREFIX", "hxc-tenant"),
    projectPoolSize,
    platformProjectId,
    existingProjectIdForTests,
    region,
    zone,
    network: env("HEXCLAVE_MARSHAL_GCP_NETWORK", "hexclave-runtime"),
    subnetwork: env("HEXCLAVE_MARSHAL_GCP_SUBNETWORK", "hexclave-runtime"),
    mockUrl: gcpMockUrl,
    mockToken: gcpMockUrl === null ? null : env("HEXCLAVE_MARSHAL_GCP_MOCK_TOKEN", "mock_hexclave_gcp_key"),
  };
}

export function getConfig(): MarshalConfig {
  if (cached) return cached;

  // "fly" and "gcp" are accepted as spellings of "real" so an environment written for one
  // runtime keeps starting; the builder always runs on the namespace's runtime regardless.
  const builderRaw = env("MARSHAL_BUILDER", "real");
  const builderKind = builderRaw === "mock" ? "mock" : builderRaw === "real" || builderRaw === "fly" || builderRaw === "gcp" ? "real" : null;
  if (builderKind === null) {
    throw new Error(`marshal refuses to start: MARSHAL_BUILDER must be "real" or "mock" (got ${JSON.stringify(builderRaw)})`);
  }
  if (builderKind === "mock") assertMocksExplicitlyAllowed("the mock builder");

  const port = Number(env("MARSHAL_PORT", `${portPrefix()}47`));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`marshal refuses to start: MARSHAL_PORT must be a valid port number (got ${JSON.stringify(process.env.MARSHAL_PORT)})`);
  }

  const publicUrlRaw = (process.env.MARSHAL_PUBLIC_URL || "").replace(/\/$/, "") || null;
  let publicUrl: string | null = null;
  if (publicUrlRaw !== null) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrlRaw);
    } catch (error) {
      throw new Error(`marshal refuses to start: MARSHAL_PUBLIC_URL must be an absolute URL (got ${JSON.stringify(publicUrlRaw)})`, { cause: error });
    }
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "/") {
      throw new Error("marshal refuses to start: MARSHAL_PUBLIC_URL must contain only an origin, without credentials, a path, query params, or a fragment");
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && process.env.MARSHAL_ALLOW_MOCKS === "1")) {
      throw new Error("marshal refuses to start: MARSHAL_PUBLIC_URL must use HTTPS (HTTP is allowed only with MARSHAL_ALLOW_MOCKS=1)");
    }
    publicUrl = parsed.origin;
  }
  // The real builder machine calls the completion webhook on MARSHAL_PUBLIC_URL — refuse to
  // start without it rather than failing every upload-sourced build at runtime.
  if (builderKind === "real" && publicUrl === null) {
    throw new Error("marshal refuses to start: MARSHAL_PUBLIC_URL is required unless MARSHAL_BUILDER=mock (the builder machine calls the completion webhook on it).");
  }

  const fly = readFlyConfig();
  const gcp = readGcpConfig();
  if (fly === null && gcp === null) {
    throw new Error("marshal refuses to start: no runtime is configured; set MARSHAL_FLY_API_TOKEN (Fly, the default runtime) and/or HEXCLAVE_MARSHAL_GCP_PLATFORM_PROJECT_ID (Google Cloud)");
  }
  const anyMock = fly?.token === MOCK_FLY_TOKEN || gcp?.mockUrl !== null && gcp !== null;

  const apiKey = env("MARSHAL_API_KEY");
  const dataEncryptionKey = env("HEXCLAVE_MARSHAL_DATA_ENCRYPTION_KEY");
  assertDataEncryptionKeyIsSafe(dataEncryptionKey, process.env.MARSHAL_ALLOW_MOCKS === "1");
  cached = {
    port,
    apiKey,
    cronSecret: process.env.CRON_SECRET || null,
    webhookSecret: env("MARSHAL_WEBHOOK_SECRET", apiKey),
    dataEncryptionRootKey: parseDataEncryptionRootKey(dataEncryptionKey),
    publicUrl,
    envId: env("MARSHAL_ENV_ID"),
    fly,
    gcp,
    builderKind,
    s3: {
      // The localhost default is the dev s3mock and is only offered in mock mode: silently
      // pointing a real deployment at localhost would fail every spec, upload and build with
      // a connection error instead of saying which env var is missing.
      endpoint: env("MARSHAL_S3_ENDPOINT", builderKind === "mock" || anyMock ? `http://localhost:${portPrefix()}21` : undefined),
      region: env("MARSHAL_S3_REGION", "auto"),
      accessKeyId: env("MARSHAL_S3_ACCESS_KEY_ID"),
      secretAccessKey: env("MARSHAL_S3_SECRET_ACCESS_KEY"),
      bucket: env("MARSHAL_S3_BUCKET"),
      forcePathStyle: process.env.MARSHAL_S3_FORCE_PATH_STYLE === "1",
    },
  };
  return cached;
}

/** The Fly configuration, or a clear error when this Marshal has none. */
export function flyConfig(): FlyConfig {
  const config = getConfig().fly;
  if (config === null) throw new Error("the Fly runtime is not configured on this Marshal (MARSHAL_FLY_API_TOKEN is unset)");
  return config;
}

/** The Google Cloud configuration, or a clear error when this Marshal has none. */
export function gcpConfig(): GcpConfig {
  const config = getConfig().gcp;
  if (config === null) throw new Error("the Google Cloud runtime is not configured on this Marshal (HEXCLAVE_MARSHAL_GCP_PLATFORM_PROJECT_ID is unset)");
  return config;
}

// namespace → Fly org resolution. One org per environment today; sharding namespaces
// across orgs later is a change to this function only.
export function resolveNamespaceOrg(_ns: string): { orgSlug: string, token: string } {
  const config = flyConfig();
  return { orgSlug: config.orgSlug, token: config.token };
}

// Runtime policy (deliberately NOT part of the service spec or the revision hash).
export const MAX_INSTANCES_CAP = 5;
// A bound on the spec rather than a platform limit: a container listening on more than this is far
// likelier to be a config mistake than a real fleet.
export const MAX_PORTS_PER_SERVICE = 10;
// Volume bounds, the same on both runtimes: 1 GB is the platform default/minimum on Fly and
// 500 GB a sane maximum on either. Disks are grow-only and survive service deletion.
export const MIN_VOLUME_SIZE_GB = 1;
export const MAX_VOLUME_SIZE_GB = 500;
// A Fly machine mounts at most one volume ("Currently, you may only mount one volume per
// Machine" — Machines API reference), and a server deliberately supports one persistent disk
// on GCP too, to keep one service contract.
export const MAX_PERSISTENT_VOLUMES_PER_SERVICE = 1;
// Volume ids must survive flyVolumeName() / gcpDiskName() unchanged; see VOLUME_NAME_PREFIX.
export const VOLUME_ID_REGEX = /^[a-z][a-z0-9_]*$/;
export const MAX_VOLUME_ID_LENGTH = 26;
// One volume per service. Fly volume names are alnum + underscore, <= 30 chars, so the
// caller-chosen volume id (lowercase alnum + underscore, <= 26 — validated upstream) fits
// behind this 4-character prefix.
//
// The name is derived from the volume ID rather than being constant so a service can hold
// several distinct disks over its life and name which one it wants. The identity is NOT
// global: a Fly volume lives inside one app and the app is per-service (see fly/naming.ts),
// so the same id under a different service is a DIFFERENT disk — ensureVolume finds no volume
// by that name in the new app and creates an empty one. Callers must not present moving an
// id between services as moving the data.
export const VOLUME_NAME_PREFIX = "hxv_";
export function flyVolumeName(volumeId: string): string {
  return `${VOLUME_NAME_PREFIX}${volumeId}`;
}
// Underscores are normalized because Compute Engine resource names only allow lowercase
// letters, digits, and hyphens.
export function gcpDiskName(volumeId: string): string {
  return `${VOLUME_NAME_PREFIX}${volumeId}`.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// Compute sizing.
//
// Callers name MEMORY and nothing else; everything below is derived here. That
// is not a simplification of a richer contract — it is the only shape that can
// be honoured, because neither runtime accepts free choice: a Fly machine is one
// of a fixed set of guests, a GCP "server" is a Compute Engine instance and must
// be one of a fixed catalog of machine types, and a Cloud Run container's CPU
// and memory come in legal PAIRS. A caller-supplied CPU could ask for something
// no provider will take, and the 400 would arrive after the caller's upload had
// already been consumed.
//
// These tables are the runtime half of the ladders in @hexclave/shared's
// deployments.ts. KEPT IN SYNC WITH IT — the backend refuses a size that is not
// on its copy, and this one refuses a size that is not on ours, exactly as
// validateServiceSpec re-validates every other part of a spec rather than
// trusting the boundary above it.

// Fly machine guests, the same table for both service types. The three smallest
// are shared-cpu-1x, 4GB is shared-cpu-2x, and 8GB is performance-2x — the first
// with dedicated cores. 512MB is what every Fly service ran on before sizes
// existed, and is what an absent size still means there.
export type FlyGuest = { cpu_kind: "shared" | "performance", cpus: number, memory_mb: number };
export const FLY_GUEST_BY_MEMORY_MB: Partial<Record<number, FlyGuest>> = {
  512: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
  1024: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
  2048: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
  4096: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
  8192: { cpu_kind: "performance", cpus: 2, memory_mb: 8192 },
};
export const FLY_DEFAULT_MEMORY_MB = 512;

// The machine shape a GCP "server" of each size runs on.
//
// The three smallest are SHARED-CORE: e2-micro is 0.25 vCPU sustained (burstable
// to 2), e2-small 0.5, e2-medium 1. e2-standard-2 is the first with dedicated
// cores. So a memory change is also a CPU change, which is why the sizes are
// coarse and why every surface that shows one shows the CPU beside it.
export const SERVER_MACHINE_TYPE_BY_MEMORY_MB: Partial<Record<number, string>> = {
  1024: "e2-micro",
  2048: "e2-small",
  4096: "e2-medium",
  8192: "e2-standard-2",
};
// What a "serverless" container of each size gets on Cloud Run. Every pair here
// is one Cloud Run accepts; the table exists so an invalid pair is
// unrepresentable rather than validated.
export const SERVERLESS_CPU_BY_MEMORY_MB: Partial<Record<number, number>> = {
  512: 1,
  1024: 1,
  2048: 1,
  4096: 2,
  8192: 4,
};
// What a GCP service runs at when its spec names no size. Absent MUST mean
// exactly this, in both directions: the backend omits the field rather than
// restating the default precisely so that a spec which changes nothing hashes
// to the same revision — and for a "server" a changed revision means the VM is
// replaced.
export const DEFAULT_SERVER_MEMORY_MB = 1024;
export const DEFAULT_SERVERLESS_MEMORY_MB = 512;

export type RuntimeKind = "fly" | "gcp";

/** The rungs a service of this type may ask for on this runtime, in MB. */
export function memorySizesFor(runtime: RuntimeKind, type: ServiceKind): number[] {
  const table = runtime === "fly" ? FLY_GUEST_BY_MEMORY_MB : type === "server" ? SERVER_MACHINE_TYPE_BY_MEMORY_MB : SERVERLESS_CPU_BY_MEMORY_MB;
  return Object.keys(table).map(Number).sort((a, b) => a - b);
}

/** What a service of this type runs at on this runtime when its spec names no size. */
export function defaultMemoryMbFor(runtime: RuntimeKind, type: ServiceKind): number {
  if (runtime === "fly") return FLY_DEFAULT_MEMORY_MB;
  return type === "server" ? DEFAULT_SERVER_MEMORY_MB : DEFAULT_SERVERLESS_MEMORY_MB;
}

/**
 * The machine shape a GCP server of this size runs on.
 *
 * Throws rather than falling back, and the callers are why: validateServiceSpec
 * refuses any size that is not a key here, so reaching this means a STORED spec
 * (replayed on every reconcile) named a size this Marshal does not know — and
 * creating an instance with no machine type would be a worse outcome than
 * failing the apply.
 */
export function serverMachineTypeFor(memoryMb: number): string {
  const machineType = SERVER_MACHINE_TYPE_BY_MEMORY_MB[memoryMb];
  if (machineType === undefined) throw new Error(`no server machine shape for ${memoryMb}MB`);
  return machineType;
}

/** The CPU a Cloud Run container of this size gets. Throws for the same reason. */
export function serverlessCpuFor(memoryMb: number): number {
  const cpu = SERVERLESS_CPU_BY_MEMORY_MB[memoryMb];
  if (cpu === undefined) throw new Error(`no container CPU for ${memoryMb}MB`);
  return cpu;
}

/** The Fly guest a service of this size runs on. Throws for the same reason. */
export function flyGuestFor(memoryMb: number): FlyGuest {
  const guest = FLY_GUEST_BY_MEMORY_MB[memoryMb];
  if (guest === undefined) throw new Error(`no Fly guest for ${memoryMb}MB`);
  return guest;
}

/** The memory a spec asks for, or its type's default on the given runtime. */
export function serviceMemoryMb(runtime: RuntimeKind, spec: { config: { type: ServiceKind, memory_mb?: number } }): number {
  return spec.config.memory_mb ?? defaultMemoryMbFor(runtime, spec.config.type);
}

// The GCP builder machine for one deployment, by requested memory. Disk grows with
// it: a build big enough to need 32g of RAM is pulling and unpacking more
// layers too, and ENOSPC on the boot disk is the same failure as ENOSPC in the
// snapshot store, from a different direction.
export const BUILDER_MACHINE_BY_MEMORY_MB: Partial<Record<number, { machineType: string, diskSizeGb: number }>> = {
  8192: { machineType: "e2-standard-2", diskSizeGb: 30 },
  16384: { machineType: "e2-standard-4", diskSizeGb: 50 },
  32768: { machineType: "e2-standard-8", diskSizeGb: 100 },
};
// The Fly builder guests for an EXPLICITLY sized builder. An unsized Fly builder keeps the
// guests it always had (BUILDER_GUEST / RAILPACK_BUILDER_GUEST below) rather than being
// raised to the 8GB default of the shared ladder: that default is GCP's floor, and silently
// quadrupling every Dockerfile build's machine on Fly is not something a no-op deploy file
// change should do.
export const FLY_BUILDER_GUEST_BY_MEMORY_MB: Partial<Record<number, FlyGuest>> = {
  8192: { cpu_kind: "performance", cpus: 2, memory_mb: 8192 },
  16384: { cpu_kind: "performance", cpus: 2, memory_mb: 16384 },
  32768: { cpu_kind: "performance", cpus: 4, memory_mb: 32768 },
};
export const DEFAULT_BUILDER_MEMORY_MB = 8192;
// The FLOOR for a Railpack build, not its default: a request for less is raised
// to this rather than refused.
//
// Every builder is ephemeral (no image cache) and the railpack-builder base
// image is large, so a small machine can spend its entire 15 minutes on
// base-image extraction alone — the CPUs that come with the larger shape are
// what buy that back. The RAM has to cover TWO things at once, which is what the
// first sizing of this got wrong: the tmpfs holding buildkit's snapshot store
// AND the build process itself. At 8g with a 6g tmpfs there were ~2g left, and a
// Next 16 app with ~1.1g of node_modules either filled the store (ENOSPC) or was
// OOM-killed at ~1.3g RSS.
export const RAILPACK_MIN_BUILDER_MEMORY_MB = 16384;

/**
 * The GCP builder machine for a deployment: what was asked for, floored at what
 * the build shape needs, and defaulted when nothing was asked.
 *
 * A request BELOW the floor is raised rather than refused. The floor is a fact
 * about how much machine this kind of build takes, not an entitlement, and
 * failing a deploy because the author asked for a machine that merely would not
 * have worked is worse than quietly giving them one that does.
 */
export function builderMachineFor(options: { requestedMemoryMb: number | null, isRailpackBuild: boolean }): { machineType: string, diskSizeGb: number, memoryMb: number } {
  const floor = options.isRailpackBuild ? RAILPACK_MIN_BUILDER_MEMORY_MB : DEFAULT_BUILDER_MEMORY_MB;
  const memoryMb = Math.max(options.requestedMemoryMb ?? floor, floor);
  const machine = BUILDER_MACHINE_BY_MEMORY_MB[memoryMb];
  if (machine === undefined) throw new Error(`no builder machine shape for ${memoryMb}MB`);
  return { ...machine, memoryMb };
}

/**
 * The Fly builder guest for a deployment. Unsized keeps the historical guests;
 * a sized request is floored at what a Railpack build needs, like GCP.
 */
export function flyBuilderGuestFor(options: { requestedMemoryMb: number | null, isRailpackBuild: boolean }): FlyGuest {
  if (options.requestedMemoryMb === null) return options.isRailpackBuild ? RAILPACK_BUILDER_GUEST : BUILDER_GUEST;
  const memoryMb = Math.max(options.requestedMemoryMb, options.isRailpackBuild ? RAILPACK_MIN_BUILDER_MEMORY_MB : 0);
  const guest = FLY_BUILDER_GUEST_BY_MEMORY_MB[memoryMb];
  if (guest === undefined) throw new Error(`no Fly builder guest for ${memoryMb}MB`);
  return guest;
}

/**
 * The BuildKit snapshot-store tmpfs for a builder of this size.
 *
 * A cap, not a reservation — unused tmpfs pages cost nothing. It has to SCALE
 * with the machine in both directions: fixed at 10g, a 32g builder would gain
 * nothing at all from its extra memory (the store, not the build, is what runs
 * out first on a large dependency tree), and an 8g one would have almost nothing
 * left for the build itself.
 *
 * ~60%, which is roughly the 10/6 split that a 16g Railpack builder was verified
 * to survive on: enough store that ENOSPC is not what a build hits first, since
 * running out of space inside a buildkit step is a far more confusing failure
 * than running out of memory.
 */
export function buildkitTmpfsSize(memoryMb: number): string {
  return `${Math.max(1, Math.floor((memoryMb * 6) / 10 / 1024))}g`;
}

// The Fly guests an UNSIZED build runs on. Railpack builds get a bigger machine: every
// builder is ephemeral (no image cache) and the railpack-builder base image is large — real-Fly
// QA measured the default guest timing out at 15 minutes on base-image extraction alone. The
// 16g is the ceiling for two performance CPUs (Fly allows 8g per CPU) and splits ~10/6 between
// the snapshot-store tmpfs and the build itself.
export const BUILDER_GUEST: FlyGuest = { cpu_kind: "shared", cpus: 2, memory_mb: 2048 };
export const RAILPACK_BUILDER_GUEST: FlyGuest = { cpu_kind: "performance", cpus: 2, memory_mb: 16384 };
// A cap, not a reservation — unused tmpfs pages cost nothing. Sized so the store cannot fill
// before the guest's remaining ~6g is what limits the build, since ENOSPC from inside a
// buildkit step is a far more confusing failure than running out of memory.
export const RAILPACK_BUILDKIT_TMPFS_SIZE = "10g";

export const BUILDER_IMAGE = "docker.io/moby/buildkit:v0.23.2@sha256:ddd1ca44b21eda906e81ab14a3d467fa6c39cd73b9a39df1196210edcb8db59e";
// Railpack (https://railpack.com) builds services that don't declare a Dockerfile: the CLI
// analyzes the source and emits a build plan that its BuildKit frontend executes. CLI and
// frontend are pinned to the same release by checksum/digest (not just tags), so neither a
// re-pushed tag nor a tampered release asset can change what runs on the builder.
// FUTURE: mirror the CLI tarball and frontend image into Marshal-owned storage so
// github.com/ghcr.io outages can't fail every Railpack build, and so each build stops
// re-downloading them.
export const RAILPACK_VERSION = "0.35.0";
// The builder image is Alpine-based, hence the musl build.
export const RAILPACK_CLI_URL = `https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz`;
export const RAILPACK_CLI_SHA256 = "d039785dd926ba059031c9c463c51f1462f344c844f828ac872c1f6d46fed7f1";
export const RAILPACK_FRONTEND_IMAGE = `ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}@sha256:bc73534934e7929ab3dc41765fb7e25c8c69d9be98c43ef8792fea51f65317bd`;
// The base image a service is built on when it names a `build_command` but no
// image and no Dockerfile — the one shape where the author has said how to build
// and run but not what to start from.
//
// A stock upstream image rather than one Hexclave publishes: it is already
// mirrored, already patched on a schedule somebody else keeps, and needs no
// release pipeline of ours to stay current. The full (non-slim) Debian variant
// on purpose — it carries git, curl, python3 and a C toolchain, which is what
// makes an arbitrary `npm install` with native modules work — and node/npm come
// with it, with pnpm and yarn a `corepack enable` away in the image itself.
//
// Pinned by DIGEST as well as tag, like RAILPACK_FRONTEND_IMAGE: a moved tag
// must not silently change what every base-image build starts from. The tag is
// kept alongside it for readability; the digest is what is pulled.
//
// The cost of this path is that the build image IS the runtime image (there is
// no stage to discard), so a service built this way pulls the whole toolchain on
// every cold start. A Dockerfile is the answer for anything that minds.
export const BASE_IMAGE = "docker.io/library/node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d";
// Where the upload is copied to in a generated Dockerfile, and the root that a
// `root_directory` is resolved against inside it.
export const BASE_IMAGE_WORKDIR = "/app";
export const BUILD_TIMEOUT_SECONDS = 15 * 60;
export const UPLOAD_EXPIRY_SECONDS = 15 * 60;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Multipart uploads: the part size every part but the last must be, and the
// size above which a multipart slot is minted at all.
//
// 8 MiB parts: S3 requires >= 5 MiB for every part but the last, and a source
// tree over the threshold is typically a few dozen megabytes, so this gives it a
// handful of parts rather than a single 30 MB PUT that a flaky link has to get
// right in one go. The threshold equals one part, so anything that would be a
// single-part multipart upload uses the plain PUT it always did.
export const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
// Below this the plain presigned PUT is used: multipart's extra round trips
// (create, N parts, complete) buy nothing for a small tarball.
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
// The completion webhook body: buildctl's metadata JSON (a few hundred bytes) or an error
// text. Anything larger is not something this route should be buffering unauthenticated.
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const SOFT_CONCURRENCY_LIMIT = 25;
// Bound on the total bytes of plain env values a spec may carry. They ride to the builder
// machine inside its config (as files, one per var), and the machine config as a whole is
// capped by the provider, so a spec that would push a build past it is refused as a 400 here
// instead of failing the build with an opaque provider error after the upload was consumed.
export const MAX_BUILD_ENV_BYTES = 32 * 1024;
// Where the tenant's build env is materialized on the builder machine: one directory per
// target, one file per var. See buildHarnessScript.
export const BUILD_ENV_DIR = "/marshal-build-env";
// Where the Dockerfiles Marshal GENERATES (base-image builds, and the `RUN`
// suffix appended to an author's own Dockerfile) are materialized on the
// builder machine: one directory per target. See generatedDockerfile.
export const BUILD_DOCKERFILE_DIR = "/marshal-dockerfiles";
// Below this length, a plain env value is not scrubbed from build logs: "1", "true", "3000"
// and the like appear all over an ordinary log, and scrubbing them turns it into a wall of
// <redacted> that hides the build's actual output while protecting nothing worth hiding.
export const MIN_REDACTED_ENV_VALUE_LENGTH = 8;
// Env keys whose values are never scrubbed from build logs whatever their length: CI
// provenance (the deploy's own commit sha, branch, repository URL) is what the build log
// exists to show, and every value is public in the repository it came from. Bare `CI` is
// "true", below the length floor anyway.
export const UNREDACTED_ENV_KEY_REGEX = /^CI_[A-Z0-9_]+$/;
// A single command line, run through `sh -c`. The bound matches the backend's
// MAX_DEPLOYMENT_COMMAND_LENGTH so a command the CLI accepted is one the
// runtime accepts too.
export const MAX_COMMAND_LENGTH = 2048;
