// All Marshal configuration comes from env vars — Marshal is stateless and holds no DB.
// Mock mode is refused unless the process explicitly opts in. This must not depend on
// NODE_ENV: an omitted production NODE_ENV must fail closed.

import { assertDataEncryptionKeyIsSafe, parseDataEncryptionRootKey } from "./spec-crypto.js";

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
  // Base URL builder VMs use to reach the completion webhook. Only needed for real builds
  // (the mock builder completes in-process).
  publicUrl: string | null,
  envId: string,
  gcp: {
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
  },
  builderKind: "gcp" | "mock",
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

export function resolveGcpMockUrl(value: string | undefined, prefix: string): string | null {
  const configured = (value || "").replace(/\/$/, "");
  return configured === "local" ? `http://localhost:${prefix}48` : configured || null;
}

let cached: MarshalConfig | null = null;

export function getConfig(): MarshalConfig {
  if (cached) return cached;

  const builderKind = env("MARSHAL_BUILDER", "gcp");
  if (builderKind !== "gcp" && builderKind !== "mock") {
    throw new Error(`marshal refuses to start: MARSHAL_BUILDER must be "gcp" or "mock" (got ${JSON.stringify(builderKind)})`);
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
  if (builderKind === "gcp" && publicUrl === null) {
    throw new Error("marshal refuses to start: MARSHAL_PUBLIC_URL is required when MARSHAL_BUILDER=gcp (the builder VM calls the completion webhook on it).");
  }

  const existingProjectIdForTests = (process.env.HEXCLAVE_MARSHAL_GCP_EXISTING_PROJECT_ID_FOR_TESTS || "").trim() || null;
  if (existingProjectIdForTests !== null) assertMocksExplicitlyAllowed("HEXCLAVE_MARSHAL_GCP_EXISTING_PROJECT_ID_FOR_TESTS");
  const gcpMockUrl = resolveGcpMockUrl(process.env.HEXCLAVE_MARSHAL_GCP_MOCK_URL, portPrefix());
  if (gcpMockUrl !== null) assertMocksExplicitlyAllowed("HEXCLAVE_MARSHAL_GCP_MOCK_URL");
  const projectPoolSizeRaw = process.env.HEXCLAVE_MARSHAL_GCP_PROJECT_POOL_SIZE || "0";
  const projectPoolSize = Number(projectPoolSizeRaw);
  if (!Number.isInteger(projectPoolSize) || projectPoolSize < 0 || projectPoolSize > 100) {
    throw new Error(`marshal refuses to start: HEXCLAVE_MARSHAL_GCP_PROJECT_POOL_SIZE must be an integer between 0 and 100 (got ${JSON.stringify(projectPoolSizeRaw)})`);
  }
  const region = env("HEXCLAVE_MARSHAL_GCP_REGION", "us-central1");
  const zone = env("HEXCLAVE_MARSHAL_GCP_ZONE", `${region}-a`);

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
    gcp: {
      billingAccount: env("HEXCLAVE_MARSHAL_GCP_BILLING_ACCOUNT", existingProjectIdForTests === null ? undefined : "test-only"),
      projectParent: (process.env.HEXCLAVE_MARSHAL_GCP_PROJECT_PARENT || "").replace(/^\/+|\/+$/g, "") || null,
      projectPrefix: env("HEXCLAVE_MARSHAL_GCP_PROJECT_PREFIX", "hxc-tenant"),
      projectPoolSize,
      platformProjectId: env("HEXCLAVE_MARSHAL_GCP_PLATFORM_PROJECT_ID"),
      existingProjectIdForTests,
      region,
      zone,
      network: env("HEXCLAVE_MARSHAL_GCP_NETWORK", "hexclave-runtime"),
      subnetwork: env("HEXCLAVE_MARSHAL_GCP_SUBNETWORK", "hexclave-runtime"),
      mockUrl: gcpMockUrl,
      mockToken: gcpMockUrl === null ? null : env("HEXCLAVE_MARSHAL_GCP_MOCK_TOKEN", "mock_hexclave_gcp_key"),
    },
    builderKind,
    s3: {
      // The localhost default is the dev s3mock and is only offered in mock mode: silently
      // pointing a real deployment at localhost would fail every spec, upload and build with
      // a connection error instead of saying which env var is missing.
      endpoint: env("MARSHAL_S3_ENDPOINT", builderKind === "mock" ? `http://localhost:${portPrefix()}21` : undefined),
      region: env("MARSHAL_S3_REGION", "auto"),
      accessKeyId: env("MARSHAL_S3_ACCESS_KEY_ID"),
      secretAccessKey: env("MARSHAL_S3_SECRET_ACCESS_KEY"),
      bucket: env("MARSHAL_S3_BUCKET"),
      forcePathStyle: process.env.MARSHAL_S3_FORCE_PATH_STYLE === "1",
    },
  };
  return cached;
}

// Runtime policy (deliberately NOT part of the service spec or the revision hash).
export const MAX_INSTANCES_CAP = 5;
// A bound on the spec rather than a platform limit: a container listening on more than this is far
// likelier to be a config mistake than a real fleet.
export const MAX_PORTS_PER_SERVICE = 10;
// Persistent Disk bounds. Disks are grow-only and survive server deletion.
export const MIN_VOLUME_SIZE_GB = 1;
export const MAX_VOLUME_SIZE_GB = 500;
// A server deliberately supports one persistent disk to preserve the v1 service contract.
export const MAX_PERSISTENT_VOLUMES_PER_SERVICE = 1;
// Volume ids must survive gcpDiskName() unchanged; see VOLUME_NAME_PREFIX below.
export const VOLUME_ID_REGEX = /^[a-z][a-z0-9_]*$/;
export const MAX_VOLUME_ID_LENGTH = 26;
// The name is derived from service identity and volume id in naming.ts. Underscores are
// normalized because Compute Engine resource names only allow lowercase letters, digits,
// and hyphens.
export const VOLUME_NAME_PREFIX = "hxv_";
export function gcpDiskName(volumeId: string): string {
  return `${VOLUME_NAME_PREFIX}${volumeId}`.replace(/_/g, "-");
}

export const MACHINE_GUEST = { cpu_kind: "shared", cpus: 1, memory_mb: 512 };
export const BUILDER_GUEST = { cpu_kind: "shared", cpus: 2, memory_mb: 2048 };
// Railpack builds get a bigger machine: every builder is ephemeral (no image cache) and the
// railpack-builder base image is large, and the default guest can time out during
// 15 minutes on base-image extraction alone. The CPUs are what buy that back.
//
// The RAM has to cover TWO things at once, which is what the first sizing of it got wrong:
// the tmpfs holding buildkit's snapshot store (below) AND the build process itself. At 8g
// with a 6g tmpfs there were ~2g left, and a Next 16 app with ~1.1g of node_modules either
// filled the store (ENOSPC) or was OOM-killed at ~1.3g RSS. 16g is the ceiling for two
// compilation. The larger shape splits memory roughly 10/6 between snapshots and the build.
export const RAILPACK_BUILDER_GUEST = { cpu_kind: "performance", cpus: 2, memory_mb: 16384 };
// A cap, not a reservation — unused tmpfs pages cost nothing. Sized so the store cannot fill
// before the guest's remaining ~6g is what limits the build, since ENOSPC from inside a
// buildkit step is a far more confusing failure than running out of memory.
export const RAILPACK_BUILDKIT_TMPFS_SIZE = "10g";
export const BUILDER_IMAGE = "docker.io/moby/buildkit:v0.23.2@sha256:ddd1ca44b21eda906e81ab14a3d467fa6c39cd73b9a39df1196210edcb8db59e";
// Railpack (https://railpack.com) builds services that don't declare a Dockerfile: the CLI
// analyzes the source and emits a build plan that its BuildKit frontend executes. CLI and
// frontend are pinned to the same release by checksum/digest (not just tags), so neither a
// re-pushed tag nor a tampered release asset can change what runs on the builder.
// FUTURE: mirror the CLI tarball and frontend image into Marshal-owned storage (the S3
// bucket / Artifact Registry) so github.com/ghcr.io outages can't fail every Railpack build,
// and so each build stops re-downloading them.
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
// target's `root_directory` is resolved against for its build command.
export const BASE_IMAGE_WORKDIR = "/app";
export const BUILD_TIMEOUT_SECONDS = 15 * 60;
export const UPLOAD_EXPIRY_SECONDS = 15 * 60;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// One part of a multipart source upload.
//
// Parts are sent and retried INDEPENDENTLY, which is the whole point: a link
// that drops a connection every few seconds cannot finish a single 30 MB PUT
// (measured: median connection life ~9s against a ~40s upload), but it finishes
// an 8 MiB part comfortably and only re-sends that part when one dies.
//
// The size has to satisfy both stores: S3 requires every part but the last to be
// at least 5 MiB, and R2 additionally requires them all to be the SAME size. A
// fixed part size with a smaller final part satisfies both by construction —
// splitting the source into N even chunks would not.
export const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
// Below this, one PUT is fewer round trips than a multipart handshake and short
// enough on the wire that re-sending it after a drop costs little.
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
// The build-completion webhook carries a status plus a small metadata document
// (an image digest at most). It is the only route reachable before the API-key
// check, so it gets an explicit cap rather than inheriting the server default.
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const SOFT_CONCURRENCY_LIMIT = 25;

// Build-time env (see buildTimeEnv). The values ride to the builder machine inside its
// VM metadata through the file bundle, so they are bounded by what the instance-create
// API will accept as one document, not by anything about env vars. The cap is enforced at
// spec validation so an oversized env fails the PUT with a precise message instead of
// surfacing as an opaque machine-create rejection fifteen seconds into a deploy.
export const MAX_BUILD_ENV_BYTES = 32 * 1024;
// Where the harness finds those files: one file per var, filename = var name, contents =
// the exact value.
export const BUILD_ENV_DIR = "/marshal-build-env";
// Tenant env reaches the builder, so its values are scrubbed from build logs alongside
// Marshal's own credentials. Short values are skipped: "1", "true", "5432" and friends are
// everywhere in a build log, and redacting them would leave a page of <redacted> with no
// secret actually protected (nothing that short is a credential worth hiding).
export const MIN_REDACTED_ENV_VALUE_LENGTH = 8;
// Where Marshal-generated Dockerfiles (and Dockerfile suffixes) are injected on
// the builder machine, one directory per target. Kept out of the build CONTEXT
// (/ctx, the extracted upload) on purpose: a file placed there would be part of
// every `COPY . .` the author writes.
export const BUILD_DOCKERFILE_DIR = "/marshal-dockerfiles";
// The cap on a build or start command, stated here for Marshal and in
// @hexclave/shared's MAX_DEPLOYMENT_COMMAND_LENGTH for everything upstream of
// it. Both must agree: a command the runtime would refuse has to fail at sync
// time, before an upload has been consumed.
export const MAX_COMMAND_LENGTH = 2048;
