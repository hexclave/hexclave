// Shared shapes for the Deploy app. Service definitions used to live in
// the branch config (`deployments-alpha.services`); they now live in the
// backend database and are synced from the `deploy` export of
// hexclave.deploy.ts by `hexclave deploy`. This module is the single source of
// truth for the definition shape so the CLI (which evaluates the deploy file),
// the backend (which stores and deploys definitions), and the SDK (which reads
// them) cannot drift.
//
// Everything here is snake_case: these types are simultaneously the API wire
// shape and the backend's stored JSON shape, and keeping them identical avoids
// a translation layer that would have to be maintained in three places.

import * as yup from "yup";
import { MAX_PROJECT_SECRET_KEY_LENGTH, PROJECT_SECRET_KEY_REGEX } from "./project-secrets";
import { yupArray, yupBoolean, yupNumber, yupObject, yupRecord, yupString } from "./schema-fields";
import { stringCompare } from "./utils/strings";

export const DEPLOYMENT_ENV_VAR_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A DEPLOYMENT SOURCE is the unit a deploy ships: one deploy file, one source,
// one upload, one build. Its id comes from the deploy file's own
// `deploymentGroupId` export — the authoring surface calls it a deployment
// GROUP, the wire format and the database still say source — which is what lets
// one project be deployed from several repositories, each with a deploy file of
// its own, each deploying on its own schedule.
//
// Service ids stay unique per PROJECT rather than per source, so a reference
// never has to name a source: two sources declaring the same service id is a
// conflict, refused at sync.
//
// Dots are allowed: a source id appears in no reference, so nothing has to
// parse one, and projects deployed before services moved out of
// hexclave.config.ts still have a stored source id named after that file.
export const DEPLOYMENT_SOURCE_ID_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
export const MAX_DEPLOYMENT_SOURCE_ID_LENGTH = 63;

// ---------------------------------------------------------------------------
// Runtimes.
//
// Marshal can run a project's services on one of two infrastructure providers.
// "fly" is the default and what every project runs on unless it says otherwise;
// "gcp" is opted into per project with an INTERNAL, undocumented export in the
// deploy file:
//
//   export const version = "gcp-beta-1";
//
// The token is a VERSION rather than a provider name on purpose: it is a
// channel we hand to ourselves for testing, and the runtime it maps to (and the
// behaviour that comes with it) may change from one token to the next without
// the deploy file changing. Absent means the default. An unknown token is
// refused by the CLI and the backend rather than ignored, so a typo in one of
// ours cannot silently deploy to the default, and a stray `version` in a user's
// file cannot silently mean anything.
//
// The runtime is pinned per PROJECT, not per deploy file: services of one
// project share a private network and resolve each other's addresses, neither
// of which can span providers. The backend enforces that every deploy file of a
// project agrees, and Marshal pins the namespace on first use.
export const DEPLOYMENT_RUNTIMES = ["fly", "gcp"] as const;
export type DeploymentRuntime = typeof DEPLOYMENT_RUNTIMES[number];
export const DEFAULT_DEPLOYMENT_RUNTIME = "fly" satisfies DeploymentRuntime;

// Every accepted `version` token and the runtime it selects.
export const DEPLOYMENT_VERSIONS = {
  "gcp-beta-1": "gcp",
} as const satisfies Record<string, DeploymentRuntime>;
export type DeploymentVersion = keyof typeof DEPLOYMENT_VERSIONS;
export const DEPLOYMENT_VERSION_TOKENS = Object.keys(DEPLOYMENT_VERSIONS) as DeploymentVersion[];

export function isDeploymentRuntime(value: unknown): value is DeploymentRuntime {
  return typeof value === "string" && (DEPLOYMENT_RUNTIMES as readonly string[]).includes(value);
}

export function isDeploymentVersion(value: unknown): value is DeploymentVersion {
  return typeof value === "string" && (DEPLOYMENT_VERSION_TOKENS as readonly string[]).includes(value);
}

/**
 * The runtime a deploy file's `version` export selects. Absent (or null) is the
 * default runtime; an unknown token is null, and the caller refuses it.
 */
export function deploymentRuntimeForVersion(version: string | null | undefined): DeploymentRuntime | null {
  if (version === undefined || version === null) return DEFAULT_DEPLOYMENT_RUNTIME;
  return isDeploymentVersion(version) ? DEPLOYMENT_VERSIONS[version] : null;
}

import.meta.vitest?.test("version tokens map to runtimes, and absent is the default", ({ expect }) => {
  expect(deploymentRuntimeForVersion(undefined)).toBe("fly");
  expect(deploymentRuntimeForVersion(null)).toBe("fly");
  expect(deploymentRuntimeForVersion("gcp-beta-1")).toBe("gcp");
  // Unknown tokens are refused by the caller, never rounded to a runtime.
  expect(deploymentRuntimeForVersion("gcp")).toBe(null);
  expect(deploymentRuntimeForVersion("1.0.0")).toBe(null);
  expect(isDeploymentVersion("constructor")).toBe(false);
});

// ---------------------------------------------------------------------------
// Source manifest
//
// What a deploy PACKAGED, recorded so a reader can answer "why is my upload
// this big, and did my .gitignore/.dockerignore do what I meant" without
// guessing. It is a listing, not the source: paths and sizes only, never
// contents. The tarball itself is consumed by the build and deleted, on purpose
// — this is what survives it.
//
// One manifest per DEPLOYMENT, not per service: a deploy uploads one tree and
// every source-built service is built from it. A service's slice is the subtree
// under its `root_directory`.

/**
 * How many file entries a manifest may carry.
 *
 * High enough that the listing is the WHOLE tree for essentially any real
 * source: node_modules and build output are excluded before packaging, and what
 * survives is source, which is thousands of files at the top end rather than
 * tens of thousands. The dashboard shows every entry, so this is the number that
 * decides whether it is showing everything.
 *
 * The cost is a JSON column: ~90 bytes an entry, so ~180 KB before Postgres
 * compresses it — and paths in one tree share nearly all their prefixes, which
 * TOAST squashes hard. Worth it to be able to say "these are the files" rather
 * than "these are some of them".
 */
export const MAX_SOURCE_MANIFEST_ENTRIES = 2000;
export const MAX_SOURCE_MANIFEST_PATH_LENGTH = 1024;

export type DeploymentSourceManifest = {
  /** Every file packaged, including the ones `entries` had no room for. */
  file_count: number,
  /** Their total size before compression. */
  total_bytes: number,
  /** What was actually uploaded, after tar + gzip. */
  compressed_bytes: number,
  /**
   * The largest files, biggest first, capped at MAX_SOURCE_MANIFEST_ENTRIES.
   *
   * Largest-first rather than a truncated alphabetical walk, because the cap
   * then only ever drops files too small to be anyone's problem — the question
   * this answers is which files are big.
   */
  entries: { path: string, bytes: number }[],
};

/**
 * The manifest for a packaged tree, capped. `paths` and `sizes` come from the
 * packager, which already holds every entry it wrote.
 */
export function buildSourceManifest(options: {
  files: { path: string, bytes: number }[],
  compressedBytes: number,
}): DeploymentSourceManifest {
  const files = options.files;
  const entries = [...files]
    .sort((a, b) => b.bytes - a.bytes || stringCompare(a.path, b.path))
    .slice(0, MAX_SOURCE_MANIFEST_ENTRIES)
    .map((file) => ({ path: file.path.slice(0, MAX_SOURCE_MANIFEST_PATH_LENGTH), bytes: file.bytes }));
  return {
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    compressed_bytes: options.compressedBytes,
    entries,
  };
}

/**
 * Parses a stored manifest, or null when there is none / it is not one.
 *
 * Tolerant on purpose: this is a debugging aid read out of a JSON column, and a
 * row written by an older client (or hand-edited) must degrade to "no manifest"
 * rather than break the deployment it belongs to.
 */
export function parseSourceManifest(value: unknown): DeploymentSourceManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Counts and sizes, so a negative or fractional one is not a number this
  // describes anything with — and the UI states all three as facts about the
  // deploy ("N files", "X on disk").
  const count = (key: string) => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
  };
  const fileCount = count("file_count");
  const totalBytes = count("total_bytes");
  const compressedBytes = count("compressed_bytes");
  if (fileCount === null || totalBytes === null || compressedBytes === null) return null;
  if (!Array.isArray(record.entries)) return null;
  // Deduplicated by path: nothing upstream guarantees uniqueness (a client may
  // send duplicates, and buildSourceManifest's own path truncation can make two
  // long paths collide), and the dashboard keys its rows on the path.
  const seen = new Set<string>();
  const entries = record.entries.flatMap((entry): { path: string, bytes: number }[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.path !== "string" || candidate.path === "") return [];
    if (typeof candidate.bytes !== "number" || !Number.isInteger(candidate.bytes) || candidate.bytes < 0) return [];
    // Bounded HERE, not only in buildSourceManifest — this is the function the
    // server gates writes with, and the client-side cap binds nothing that
    // reaches the database. Dropped rather than truncated: a truncated path is
    // a path that names a different file, and it is what makes two rows collide.
    if (candidate.path.length > MAX_SOURCE_MANIFEST_PATH_LENGTH) return [];
    if (seen.has(candidate.path)) return [];
    seen.add(candidate.path);
    return [{ path: candidate.path, bytes: candidate.bytes }];
  })
    // Re-established rather than trusted: the dashboard tells the reader the
    // listing is largest-first and that anything dropped was smaller than every
    // row shown. Both are claims about ORDER, and the order arrived from a
    // client. Sorting here makes them true by construction.
    .sort((a, b) => b.bytes - a.bytes || stringCompare(a.path, b.path))
    .slice(0, MAX_SOURCE_MANIFEST_ENTRIES);
  return { file_count: fileCount, total_bytes: totalBytes, compressed_bytes: compressedBytes, entries };
}

/**
 * The manifest entries belonging to one service, and whether the listing is
 * complete for it.
 *
 * `rootDirectory` is the service's own subtree of the shared upload; null or
 * "." means the whole tree. Paths are posix and relative to the upload root.
 *
 * `prefix` is that root as a path prefix ("web/", or "" for the whole tree).
 * Returned rather than left for the caller to re-derive: entries keep their
 * full paths, so anything that displays them relative to the service — the
 * dashboard's folder tree — needs exactly the prefix this filtered on, and a
 * second copy of this normalisation is a second place for it to drift.
 */
export function sourceManifestEntriesForService(
  manifest: DeploymentSourceManifest,
  rootDirectory: string | null,
): { entries: { path: string, bytes: number }[], truncated: boolean, prefix: string } {
  const normalized = (rootDirectory ?? ".").replace(/^\.\/+/, "").replace(/\/+$/, "");
  const prefix = normalized === "" || normalized === "." ? "" : `${normalized}/`;
  const entries = prefix === "" ? manifest.entries : manifest.entries.filter((entry) => entry.path.startsWith(prefix));
  // Truncated is a property of the whole manifest, not of this slice: once the
  // cap dropped files, no subtree can claim to be complete.
  return { entries, truncated: manifest.file_count > manifest.entries.length, prefix };
}

// A connection value is `<serviceId>.<outputKey>` — a typed pointer to another
// service's output — or `hexclave.<outputKey>` for the managed service. The
// backend resolves it at deploy time. This is deliberately its own env var TYPE
// rather than a `{serviceId.outputKey}` interpolation syntax inside plain
// values: with interpolation, a literal value that happens to contain `{...}`
// would be misinterpreted as a reference, so plain values must stay entirely
// literal.
//
// The optional `:<port>` suffix belongs to `url`, which names the port it wants:
// `api.url:9090`. It is part of the reference rather than a separate field
// because references are single opaque strings everywhere they travel — deploy
// file, stored definition, and the runtime's own env refs.
export const DEPLOYMENT_CONNECTION_VALUE_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*\.[A-Za-z0-9_]+(?::[0-9]{1,5})?$/;

/**
 * The managed Hexclave service's slot on the deployments board. A service in
 * the deploy file's `deploy` export must never shadow it — `service("hexclave")`
 * doesn't exist (the `hexclave` context object replaces it), but the id stays
 * reserved so connection values like "hexclave.projectId" are unambiguous.
 */
export const HEXCLAVE_SERVICE_ID = "hexclave";

// The outputs each service kind exposes. The backend's resolvers and the CLI's
// `service()` / `hexclave` context objects must both stay in sync with these.
// Note there is deliberately no `previewUrl` output: nothing in the current
// flow can create a preview deployment (`hexclave deploy` always targets
// production), so exposing it would be a documented dead end — every deploy
// referencing it would fail with "no successful preview deployment yet".
export const HEXCLAVE_OUTPUT_KEYS = ["projectId", "apiUrl", "jwksUrl", "publishableClientKey", "secretServerKey"] as const;
//
// `url` is a CALL, because a URL names exactly one port: `url()` when a single
// HTTP port makes it unambiguous, `url(9090)` to pick one when the service
// declares several. It resolves to the service's PUBLIC url when that port is
// public (the platform URL, or a verified custom domain) and to its private
// address otherwise, with the scheme taken from the port's protocol.
//
// `hostname` is the service's private DNS name, which resolves to the stable
// private IPv6 address of its app. Pair it with a literal port number for a raw
// TCP client. There is deliberately no port output — its value is a number the
// author already wrote in the target's `ports`, so a plain `"5433"` says the
// same thing without a second way to spell it.
export const SERVICE_OUTPUT_KEYS = ["url", "hostname"] as const;

/**
 * Splits a connection reference into its parts. One parser so the CLI, the
 * backend and the runtime cannot disagree about what `api.url:9090`
 * means. Returns null when the value is not a reference at all.
 */
export function parseConnectionValue(value: string): { serviceId: string, outputKey: string, port: number | null } | null {
  if (!DEPLOYMENT_CONNECTION_VALUE_REGEX.test(value)) return null;
  const colonIndex = value.lastIndexOf(":");
  const port = colonIndex === -1 ? null : Number(value.slice(colonIndex + 1));
  const withoutPort = colonIndex === -1 ? value : value.slice(0, colonIndex);
  // The regex allows a dot on neither side of the separator, so this is unambiguous.
  const dotIndex = withoutPort.indexOf(".");
  return {
    serviceId: withoutPort.slice(0, dotIndex),
    outputKey: withoutPort.slice(dotIndex + 1),
    port,
  };
}

/**
 * Whether a reference actually requires its target to have DEPLOYED. The
 * answer depends on the RUNTIME, because it is a fact about where addresses
 * come from:
 *
 * On "fly", a service's private hostname is a pure function of its identity
 * (Fly's 6PN DNS publishes "<app>.internal" the moment the app exists), so
 * `hostname` and a private `url` with a named port resolve before the target
 * ever runs. Only a PUBLIC url (the platform URL, which exists once the service
 * is up) and a bare `url()` (which has to read the target's ports) wait.
 * `targetIsPublic` is null when the caller cannot answer — a reference into a
 * source this deploy file does not contain, or one naming a port the target
 * does not declare — in which case the conservative answer is that it waits.
 * Getting this wrong in the other direction would serialize independent
 * deploys, cascade false "skipped" results when the target fails, and reject
 * mutually-wired services as circular.
 *
 * On "gcp", every SERVICE output waits — `url` and `hostname` alike, public or
 * private, named port or not. Both are the target's runtime ADDRESS, and GCP
 * publishes none for a service that does not exist yet: a private service is
 * reached at its VM's internal IP (assigned when the instance is created), a
 * public one at its platform URL, and a serverless one at the URI its revision
 * got. The cost is that mutually-wired services are a circular dependency
 * there, reported as one, instead of silently resolving.
 *
 * `hexclave.*` outputs are not service outputs and never wait — they come from
 * the managed service, which always exists.
 */
export function connectionRequiresTargetDeployed(runtime: DeploymentRuntime, outputKey: string, port: number | null, targetIsPublic: boolean | null): boolean {
  if (!SERVICE_OUTPUT_KEYS.includes(outputKey as ServiceOutputKey)) return false;
  if (runtime === "gcp") return true;
  if (outputKey !== "url") return false;
  if (port === null) return true;
  return targetIsPublic !== false;
}

/** Formats a connection reference. The inverse of parseConnectionValue. */
export function formatConnectionValue(serviceId: string, outputKey: string, port: number | null = null): string {
  return port === null ? `${serviceId}.${outputKey}` : `${serviceId}.${outputKey}:${port}`;
}

export type HexclaveOutputKey = typeof HEXCLAVE_OUTPUT_KEYS[number];
export type ServiceOutputKey = typeof SERVICE_OUTPUT_KEYS[number];

// One env var, discriminated by `type`:
// - absent (plain): a literal `value`.
// - "secret": only the secret's name (`key`) is in the definition; the actual
//   value lives in the project's secret store (see ./project-secrets), set in
//   the dashboard under Project Settings → Secrets and read server-side at
//   deploy time. A secret with no stored value fails the deploy
//   unless the deploy request supplies a default for it (see
//   deploymentSecretDefaultsSchema).
// - "connection": `value` names another service's output (see the regex
//   comment above); resolved server-side at deploy time.
export type DeploymentEnvVarDefinition = {
  type?: "secret" | "connection" | undefined,
  value?: string | undefined,
  key?: string | undefined,
};

/**
 * The builder machine for one deployment source.
 *
 * A property of the DEPLOYMENT rather than of any service: one `hexclave deploy`
 * uploads one tree and builds every service of it on ONE machine, so there is
 * exactly one builder to size and a per-service field could only ever be a
 * request that some other service's request overrode.
 *
 * Absent, or `memory` absent within it, means the deployment picks its own size
 * — the floor a build of that shape needs (see DEFAULT_BUILDER_MEMORY, and the
 * larger floor an auto-detected build gets).
 */
export type DeploymentBuilderDefinition = {
  memory?: DeploymentMemorySize | undefined,
};

export type DeploymentServiceDefinition = {
  // How the service is run on the Marshal runtime.
  //
  // - "server": exactly one instance (max_instances is always 1), backed by a
  //   single Compute Engine VM. There is no request-triggered suspend, so
  //   min_instances 0 keeps its availability and disk semantics but does not
  //   guarantee scale-to-zero billing; min_instances 1 (the default) stays up.
  //   It is the only type allowed to hold a persistent volume — a volume is
  //   local disk on one host, which only a single instance can ever mount.
  // - "serverless": scales between min_instances and max_instances and STOPS
  //   (not suspends) on scale-down, so every start is a cold start from a clean
  //   rootfs. Persistent volumes are rejected: a fleet would give each instance
  //   its own unreplicated disk rather than shared storage.
  //
  // The field is required so every write path states what it is creating.
  type: DeploymentServiceType,
  // Whether the service is reachable from the internet. Default false: a service
  // is private unless it says otherwise, and private services reach each other
  // over the project's internal network.
  //
  // Public is a property of the SERVICE and not of one port, because the runtime
  // cannot make it anything else. Fly's proxy listener set is per-app rather than
  // per-address, so every declared port answers on every address the app holds:
  // the moment one port is public they all are. A per-port flag could express
  // "public 3000, private 5432" but the runtime would publish both, so the flag
  // lives where the truth does. (An earlier revision of this branch had the flag
  // on the port and a rule forbidding the mixture; this is the same rule made
  // unrepresentable instead of enforced.)
  //
  // A public service must therefore be all-HTTP: raw TCP cannot be public,
  // because Fly's shared IPv4 tells apps apart by SNI (or Host) and a raw TCP
  // stream carries neither — the edge accepts the connection and then drops it.
  // Lifting that needs a dedicated IPv4 per service, which is a billing decision.
  // VERIFIED against real Fly; see the `public-service-is-all-http` rule below.
  public?: boolean | undefined,
  // The ports the container listens on.
  //
  // May be EMPTY, for a worker that only makes outbound connections. Such a
  // service has no URL of any kind and can hold no custom domain, and it only
  // ever runs if it is always-on (see the schema's note on autostart). A worker
  // may not be `public`: there would be nothing to serve on the ingress it
  // allocates.
  //
  // Each port is reachable at its own number, and the service's standard-ports
  // holder is additionally served on 80/443 so `url` and custom domain
  // certificates work on the standard ports.
  ports: DeploymentPorts,
  // Scaling bounds. On a "serverless" the instance count moves between them and
  // min 0 scales to zero; defaults are min 0, max 1. A "server" holds exactly
  // one instance, so max_instances may only ever be 1 and min_instances is the
  // suspend switch: 1 (the default) stays up, 0 suspends when idle.
  min_instances?: number | undefined,
  max_instances?: number | undefined,
  // How much memory the container gets, as a size token ("512MB", "4GB"). Absent
  // = the type's default (see defaultDeploymentMemoryForType), which is what the
  // service ran at before compute was configurable.
  //
  // CPU is DERIVED from it rather than declared: a "server" is a whole machine
  // from a fixed catalog of shapes and a "serverless" container has legal
  // cpu/memory pairs rather than free choice, so memory is the only dial that
  // lands on a valid combination for both. On the smaller server rungs the
  // derived CPU is a burstable fraction of a core, which is why every surface
  // that shows it says so.
  //
  // Changing it re-rolls the service: for a "serverless" that is an ordinary
  // rolling revision, but a "server" is a VM that has to be replaced, so it goes
  // down and comes back (its persistent disk survives — the disk outlives the
  // instance by design).
  memory?: DeploymentMemorySize | undefined,
  // Relative to the directory containing hexclave.deploy.ts. Decides what
  // `hexclave deploy` packages, and — on the generated-Dockerfile path below —
  // the working directory `build_command` runs in.
  //
  // Meaningful alongside `image` only when a `build_command` makes the image a
  // BASE: a service that merely runs a prebuilt image is not built from the
  // uploaded source, so it has no directory within it.
  root_directory?: string | undefined,
  // The Dockerfile to build from, as a path within the uploaded tree — i.e.
  // relative to the directory containing hexclave.deploy.ts, like
  // root_directory. In the deploy file it is written relative to the service's
  // `rootDirectory` and the CLI joins the two before sending it, so that the
  // pre-flight, this schema and the remote builder all resolve it against one
  // base. When absent the service is NOT built from a Dockerfile — the remote
  // builder auto-detects the build with Railpack (https://railpack.com) instead
  // — unless a `build_command` is set, which selects the generated-Dockerfile
  // path below rather than auto-detection.
  //
  // Mutually exclusive with `image`.
  dockerfile_path?: string | undefined,
  // An already-built image: `postgres:16`, `ghcr.io/org/app:1.2.3`, or a digest.
  //
  // On its own it is the image to RUN, and the service is not built at all —
  // nothing is uploaded for it and its deploy takes seconds. With a
  // `build_command` it is instead the BASE the service is built from, and the
  // uploaded source is copied in on top of it (see `build_command`).
  //
  // Mutually exclusive with `dockerfile_path`: both name a base.
  //
  // Stored as the author wrote it (normalized to a canonical, fully-qualified
  // ref by parseDeploymentImageRef, so `postgres:16` is stored as
  // `docker.io/library/postgres:16`). Nothing resolves it: the reference goes
  // into the machine config as written, and the platform resolves a tag when it
  // pulls. A deployment reports the digest the platform came back with, which
  // is the only record of which bytes a tag turned out to mean.
  image?: string | undefined,
  // Persistent disks mounted into the container, keyed by VOLUME ID. Absent or
  // empty = the container filesystem is entirely ephemeral (the default).
  // Only "server" services may declare one.
  //
  // The key names the underlying Fly volume, which lives inside the service's
  // own Fly app. It therefore identifies the disk WITHIN a service: moving an id
  // to another service (or renaming the service) hands the new one a fresh empty
  // disk and strands the old one, detached and still billed. Two services may
  // never hold one id at a time. See MAX_PERSISTENT_VOLUMES_PER_SERVICE for the
  // current one-per-service cap.
  persistent_volumes?: Record<string, DeploymentVolumeDefinition> | undefined,
  // A single command line, run through `/bin/sh -c` while the image is BUILT.
  //
  // It selects a GENERATED DOCKERFILE, whose base is `image` if one is named and
  // the Hexclave base image otherwise. The whole uploaded source is copied into
  // `/app`, the command runs in `/app/<root_directory>`, and every build-visible
  // env var is available to it. That is what makes `image` + `build_command`
  // mean "start from this image, add my code" rather than "run this image".
  //
  // The one exception is `dockerfile_path`, which already describes a complete
  // build: there the command is APPENDED to the author's Dockerfile as a final
  // `RUN`, and nothing is copied in that the Dockerfile did not copy itself.
  //
  // Absent = the base decides the build entirely (Railpack auto-detection, the
  // author's Dockerfile, or — for a bare `image` — no build at all).
  build_command?: string | undefined,
  // A single command line, run through `/bin/sh -c` as the container's process,
  // INSTEAD of whatever the image would have started.
  //
  // Applied at RUN time (the machine's init, which replaces both the image's
  // entrypoint and its command — verified against real Fly), not baked into the
  // image. So it costs no build: naming one on a prebuilt `image` service keeps
  // that service's deploy build-less, and changing only this rolls the machines
  // without rebuilding anything.
  //
  // It never changes HOW the service is built, which is what makes it usable on
  // every shape: a Railpack-built service keeps its auto-detected build and just
  // starts differently.
  //
  // REQUIRED when the service builds on the Hexclave base image (no `image`, no
  // `dockerfile_path`, but a command): that base starts nothing on its own, so a
  // service without one would deploy and then immediately exit.
  start_command?: string | undefined,
  env: Record<string, DeploymentEnvVarDefinition>,
};

// Whether a definition is BUILT from the deployment's uploaded source.
//
// True for everything except a service that merely runs an already-built
// `image`: naming a `build_command` alongside one turns it into a base, which
// means an upload, a builder machine and a build log. Shared because the answer
// decides several unrelated things — whether the CLI packages the source at all,
// whether the runtime demands an upload, and whether a deploy has logs to show —
// and those must not be able to disagree.
export function deploymentServiceIsBuilt(definition: Pick<DeploymentServiceDefinition, "image" | "build_command">): boolean {
  return definition.image === undefined || definition.build_command !== undefined;
}

// Whether a definition builds from a GENERATED Dockerfile — the path that copies
// the uploaded source onto a base image, rather than Railpack auto-detection or
// the author's own Dockerfile.
//
// Only a `build_command` selects it. A `start_command` deliberately does NOT:
// it is applied by the runtime and works on whatever image the service ends up
// with, so letting it switch the BUILD would mean that adding "run it this way"
// to a working Railpack service silently threw away the install and compile
// steps that made it work — an image that builds fine and then has no
// node_modules. Overriding a wrongly-detected start command is exactly what a
// start command is for, and it must stay possible without rebuilding anything.
export function deploymentServiceUsesGeneratedDockerfile(definition: Pick<DeploymentServiceDefinition, "image" | "dockerfile_path" | "build_command">): boolean {
  if (definition.build_command === undefined) return false;
  return definition.dockerfile_path === undefined;
}

// How one port the container listens on is exposed.
//
// There is deliberately no `public` here — it is a property of the SERVICE (see
// DeploymentServiceDefinition.public for why the runtime leaves no other
// option). A service's ports are all reachable or none of them are.
//
// `protocol` picks the protocol handler explicitly. A "tcp" port is raw: it may
// only appear on a PRIVATE service, reached over the internal network with
// hostname() and its port number.
export type DeploymentPortDefinition = {
  protocol: "http" | "tcp",
};

// The ports a service listens on, keyed by port NUMBER — the same shape the
// author writes in the deploy file (`ports: { 3000: { protocol: "http" } }`), kept
// all the way through the wire and the database so nothing has to translate
// between two spellings of one thing. Keys are decimal port numbers; JSON has no
// numeric object keys, so they are strings here and parsed at the few points
// that need arithmetic (see deploymentPortEntries).
export type DeploymentPorts = Record<string, DeploymentPortDefinition>;

// `path` is where the disk is mounted inside the container; `size_gb` is the
// provisioned size, which can be grown on a later deploy but never shrunk.
export type DeploymentVolumeDefinition = {
  path: string,
  size_gb: number,
};

export type DeploymentServiceType = "server" | "serverless";
export const DEPLOYMENT_SERVICE_TYPES = ["server", "serverless"] as const;

/** A port's explicitly configured protocol. */
export function portProtocol(port: DeploymentPortDefinition): "http" | "tcp" {
  return port.protocol;
}

/** One declared port, with the record's key parsed. */
export type DeploymentPortEntry = {
  port: number,
  protocol: "http" | "tcp",
};

/**
 * The ports as a list, ascending by port number. Every
 * consumer that has to compare, count or iterate ports goes through this, so the
 * key parsing happens in exactly one place — and so the order is
 * the same everywhere (object key order would otherwise put "80" after "8080"
 * for one caller and not another).
 *
 * Keys that are not port numbers are dropped rather than thrown on: this runs on
 * stored rows, and a hand-edited one must not take down a listing. Every write
 * path validates the shape.
 */
export function deploymentPortEntries(ports: DeploymentPorts): DeploymentPortEntry[] {
  const entries: DeploymentPortEntry[] = [];
  for (const [portKey, definition] of Object.entries(ports)) {
    if (!DEPLOYMENT_PORT_KEY_REGEX.test(portKey)) continue;
    const port = Number(portKey);
    if (port < 1 || port > 65535) continue;
    entries.push({ port, protocol: portProtocol(definition) });
  }
  return entries.sort((a, b) => a.port - b.port);
}

// A port key in its ONE canonical spelling: decimal, no leading zero.
//
// Leading zeros are what make a "duplicate port" possible in a record keyed by
// port: "80" and "080" are different object keys but the same port, so both
// survive as entries and the runtime emits two identical external listeners for
// them. Rejecting the non-canonical spelling makes that impossible by
// construction rather than by a cross-entry duplicate check — the same reason
// the ports are a record and not an array.
//
// KEPT IN SYNC WITH the key check in apps/marshal/src/services.ts and the
// `hexclave_deployment_ports_entries_valid` CHECK function in the deployments
// migration. Five digits max is the width of 65535; the range is checked
// separately so an out-of-range port reports as a range error, not a shape one.
export const DEPLOYMENT_PORT_KEY_REGEX = /^[1-9][0-9]{0,4}$/;

/**
 * The port number that additionally answers on the standard 80/443, or null when
 * the service has no single obvious one.
 *
 * For a PUBLIC service it is the LOWEST-numbered HTTP port. Lowest rather than
 * first-encountered: deploymentPortEntries sorts numerically, so the holder is a
 * property of the port set and not of JSON key ordering. That determinism is the
 * whole point — the holder is the port the service's bare URL names and the only
 * one a custom domain can front, so an arbitrary pick would silently move both.
 *
 * For a PRIVATE service it is the sole HTTP port, because a private service gets
 * public IPs the moment a custom domain is attached and that domain terminates
 * TLS on 443. Null when there are several, which is what makes such a service
 * ineligible to hold a domain at all.
 *
 * KEPT IN SYNC WITH standardPortsHolderFor in apps/marshal/src/services.ts.
 */
export function standardPortsHolderPort(ports: DeploymentPorts, isPublic: boolean): number | null {
  if (!isPublic) return soleHttpDeploymentPort(ports);
  // Filtered to HTTP defensively: a public service may declare no TCP port, so
  // on any valid definition this is simply the lowest port.
  const httpPorts = deploymentPortEntries(ports).filter((entry) => entry.protocol === "http");
  return httpPorts.length === 0 ? null : httpPorts[0].port;
}

/**
 * Whether this port is the one that owns the service's standard 80/443, and so
 * the one whose URL carries no `:port` suffix.
 *
 * VERIFIED AGAINST REAL FLY: every other port of a public service is reachable
 * on its own number over BOTH IPv4 and IPv6 — a shared IPv4 forwards any port,
 * so long as the traffic carries SNI or a Host header for the proxy to route on.
 * The difference between the holder and the rest is the URL shape and which port
 * a custom domain can front, NOT reachability.
 */
export function deploymentPortOwnsStandardPorts(ports: DeploymentPorts, isPublic: boolean, port: number): boolean {
  return standardPortsHolderPort(ports, isPublic) === port;
}

/**
 * Declared ports that collide with the external listeners the standard-ports
 * holder reserves, as a sorted list (empty when there is no conflict).
 *
 * The holder does not only answer on its own number — it also claims external 80
 * and 443, which is what makes the platform URL and any custom domain
 * certificate work. Those are listeners on the WHOLE app: the runtime emits one
 * entry per declared port, so a *different* port that is itself numbered 80 or
 * 443 asks for an external listener the holder has already taken. Two entries
 * claiming one external port is a config the runtime cannot serve — it is
 * rejected outright, or routes one of them somewhere the author did not ask for.
 *
 * The cheap example is a public service with
 * `{ 80: { protocol: "http" }, 443: { protocol: "http" } }`: 80 is the
 * holder, claims 80 and 443, and the declared 443 claims 443 again. This is
 * refused rather than resolved by precedence, because every way of resolving it
 * silently drops or retargets a port the author explicitly declared.
 */
export function reservedStandardPortConflicts(ports: DeploymentPorts, isPublic: boolean): number[] {
  const holder = standardPortsHolderPort(ports, isPublic);
  if (holder === null) return [];
  return deploymentPortEntries(ports)
    .filter((entry) => entry.port !== holder && (entry.port === 80 || entry.port === 443))
    .map((entry) => entry.port);
}

/**
 * The port a bare `url()` refers to, or null when the service leaves it
 * ambiguous (several HTTP ports) or impossible (none). Callers phrase their own
 * error — the CLI wants a config-file diagnostic, the backend an HTTP status —
 * which is why this returns null rather than throwing.
 */
export function soleHttpDeploymentPort(ports: DeploymentPorts): number | null {
  const httpPorts = deploymentPortEntries(ports).filter((entry) => entry.protocol === "http");
  return httpPorts.length === 1 ? httpPorts[0].port : null;
}

/** One port's definition, or null when the service does not declare it. */
export function deploymentPortEntry(ports: DeploymentPorts, port: number): DeploymentPortEntry | null {
  return deploymentPortEntries(ports).find((entry) => entry.port === port) ?? null;
}

// Each declared port becomes its own entry in the Fly machine's `services`
// array. The cap is a bound on the spec rather than a platform limit — a
// container listening on more than this is far likelier to be a config mistake
// than a real fleet, and an unbounded record would be sent to Fly verbatim.
export const MAX_PORTS_PER_SERVICE = 10;

// The most instances one service may scale to. A bound on the spec rather than
// a platform limit: a fleet larger than this is far likelier to be a typo (or a
// misunderstanding of what a Hexclave service is for) than a real intent, and
// each instance is a machine somebody pays for. Both bounds share it — a floor
// above the ceiling could never be satisfied.
export const MAX_INSTANCES_PER_SERVICE = 10;

export const MIN_VOLUME_SIZE_GB = 1;
export const MAX_VOLUME_SIZE_GB = 500;

// A Fly machine mounts at most one volume ("Currently, you may only mount one
// volume per Machine" — Machines API reference), so a second entry could not be
// honoured by the runtime. `persistent_volumes` is a record rather than a
// single object anyway: the shape is what makes the volume ID a first-class
// key, and the cap can lift without a breaking config change if Fly ever allows
// more than one mount.
export const MAX_PERSISTENT_VOLUMES_PER_SERVICE = 1;

// The Free plan's disk entitlement: how many persistent volumes one project may
// hold in total, and how large each of them may be.
//
// Volumes are the one deployment resource that keeps costing after the project
// stops using it. A suspended machine bills nothing; a provisioned disk bills on
// its size whether or not anything mounts it, and tearing a service down
// DETACHES its disk rather than destroying it (see the Fly provider's
// deleteService), so an abandoned volume outlives the service that made it.
// That is why disks are capped on Free by count and size rather than left to
// the always-on gate, which only ever reaches running machines.
//
// Counted per PROJECT rather than per service: MAX_PERSISTENT_VOLUMES_PER_SERVICE
// already holds a service to one disk, so a per-service cap would bound nothing
// a second service could not simply ask for again.
export const FREE_PLAN_MAX_VOLUMES_PER_PROJECT = 1;
export const FREE_PLAN_MAX_VOLUME_SIZE_GB = 10;

// Volume ids become Fly volume names (see appVolumeName in Marshal), which are
// alphanumeric + underscore and at most 30 characters. The id is capped at 26
// so a 4-character prefix still fits, and lowercased so two ids cannot differ
// only by case and then collide once Fly normalizes them.
export const DEPLOYMENT_VOLUME_ID_REGEX = /^[a-z][a-z0-9_]*$/;
export const MAX_VOLUME_ID_LENGTH = 26;

// ---------------------------------------------------------------------------
// Compute sizing.
//
// How much memory a service's container gets, and how much the builder machine
// that builds a deployment gets. Written as a SIZE TOKEN ("512MB", "4GB") rather
// than a number, so the unit is part of the value and a bare `memory: 4` cannot
// mean four of something unstated.
//
// Only MB and GB are spelled, and only in that capitalization: "Mb" is megabits,
// which is not another spelling of this but a different quantity. One canonical
// token per size, for the same reason port keys refuse a leading zero — two
// spellings of one value is a duplicate-detection problem nobody needs.
//
// The ladder is deliberately COARSE and closed. Memory is the only dial; CPU is
// derived from it, which is what makes every rung valid on both runtime shapes
// at once. A "server" is a whole VM and can only be one of a fixed catalog of
// machine shapes; a "serverless" container has legal cpu/memory PAIRS rather
// than free choice (past 4GB it must have more than one CPU). Free-form
// cpu/memory would let an author write a combination that neither can honour,
// and we would have to silently round it into one that they can.
//
// The cost of deriving CPU is that a memory change is also a CPU change, and on
// the bottom three server rungs that CPU is a burstable fraction of a core
// rather than a whole one. That is stated wherever the derived value is shown —
// a 4GB server running on one burstable core is a surprise worth spending words
// on, not one to discover under load.
export const DEPLOYMENT_MEMORY_SIZES = ["512MB", "1GB", "2GB", "4GB", "8GB", "16GB", "32GB"] as const;
export type DeploymentMemorySize = typeof DEPLOYMENT_MEMORY_SIZES[number];

// MB here is what the platforms mean by it — a binary megabyte — so "512MB" is
// the 512Mi the container runtime is asked for and "1GB" is the 1 GiB a machine
// shape actually carries. The decimal spelling is the one every developer reads,
// and nothing computes bytes from these: the number only ever indexes a table.
const MEMORY_MB_BY_SIZE: Record<DeploymentMemorySize, number> = {
  "512MB": 512,
  "1GB": 1024,
  "2GB": 2048,
  "4GB": 4096,
  "8GB": 8192,
  "16GB": 16384,
  "32GB": 32768,
};

// Which rungs each kind may ask for, PER RUNTIME. These ARE the paid-plan
// ceilings: rather than defining sizes nobody can select and refusing them
// later in the plan gate, the ladder stops where the entitlement does, so
// autocomplete never offers a value that cannot be deployed. Raising a ceiling
// is one entry here.
//
// The ladders differ at the bottom because the runtimes' smallest shapes do.
// On Fly a machine of either type can carry 512MB (and that IS what every
// service ran on before sizes existed, so it is the default there for both
// types). On GCP a "server" is a Compute Engine machine and the smallest one
// carries a full gigabyte, so there is no 512MB server rung to offer — offering
// it would be offering a size that silently becomes a different one.
export const FLY_SERVER_MEMORY_SIZES = ["512MB", "1GB", "2GB", "4GB", "8GB"] as const satisfies readonly DeploymentMemorySize[];
export const FLY_SERVERLESS_MEMORY_SIZES = ["512MB", "1GB", "2GB", "4GB", "8GB"] as const satisfies readonly DeploymentMemorySize[];
export const GCP_SERVER_MEMORY_SIZES = ["1GB", "2GB", "4GB", "8GB"] as const satisfies readonly DeploymentMemorySize[];
export const GCP_SERVERLESS_MEMORY_SIZES = ["512MB", "1GB", "2GB", "4GB", "8GB"] as const satisfies readonly DeploymentMemorySize[];
// Every rung ANY runtime offers a type, for the schema: the wire schema does not
// know which runtime a definition is bound for, so it accepts the union and the
// runtime-specific check happens where the runtime is known (the CLI, which has
// the deploy file's `version`, and the sync route, which has the source's pin).
export const SERVER_MEMORY_SIZES = FLY_SERVER_MEMORY_SIZES;
export const SERVERLESS_MEMORY_SIZES = FLY_SERVERLESS_MEMORY_SIZES;
// The builder starts where the services stop: it is a transient machine that
// exists for one build, so its floor is the size a real build needs rather than
// the size a small service idles at. The same on both runtimes.
export const BUILDER_MEMORY_SIZES = ["8GB", "16GB", "32GB"] as const satisfies readonly DeploymentMemorySize[];

// The sizes a deployment gets when it says nothing. Each is exactly what that
// kind ran at before compute was configurable ON THAT RUNTIME, so an unchanged
// deploy file deploys the same machines it did before this existed — which is
// also why the two runtimes disagree about a server's default.
export const DEFAULT_SERVER_MEMORY = "512MB" satisfies DeploymentMemorySize;
export const DEFAULT_SERVERLESS_MEMORY = "512MB" satisfies DeploymentMemorySize;
export const GCP_DEFAULT_SERVER_MEMORY = "1GB" satisfies DeploymentMemorySize;
export const DEFAULT_BUILDER_MEMORY = "8GB" satisfies DeploymentMemorySize;

/** The rungs a service of this type may ask for on this runtime. */
export function deploymentMemorySizesForType(type: DeploymentServiceType, runtime: DeploymentRuntime = DEFAULT_DEPLOYMENT_RUNTIME): readonly DeploymentMemorySize[] {
  if (runtime === "gcp") return type === "server" ? GCP_SERVER_MEMORY_SIZES : GCP_SERVERLESS_MEMORY_SIZES;
  return type === "server" ? FLY_SERVER_MEMORY_SIZES : FLY_SERVERLESS_MEMORY_SIZES;
}

/** What a service of this type runs at on this runtime when it declares no `memory`. */
export function defaultDeploymentMemoryForType(type: DeploymentServiceType, runtime: DeploymentRuntime = DEFAULT_DEPLOYMENT_RUNTIME): DeploymentMemorySize {
  if (type === "server") return runtime === "gcp" ? GCP_DEFAULT_SERVER_MEMORY : DEFAULT_SERVER_MEMORY;
  return DEFAULT_SERVERLESS_MEMORY;
}

/** A size token as a whole number of megabytes. */
export function deploymentMemoryToMb(size: DeploymentMemorySize): number {
  return MEMORY_MB_BY_SIZE[size];
}

/**
 * The size token for a stored megabyte count, or null when no rung matches.
 *
 * Null rather than a throw or a rounded neighbour: the input is a database
 * column, and a value written by a future version (or edited by hand) must
 * degrade to "unset" — which every reader already handles — rather than claim
 * to be a size the deployment is not running.
 */
export function deploymentMemoryFromMb(megabytes: number): DeploymentMemorySize | null {
  return DEPLOYMENT_MEMORY_SIZES.find((size) => MEMORY_MB_BY_SIZE[size] === megabytes) ?? null;
}

/**
 * The canonical token for something an author wrote, or null.
 *
 * Case-insensitive and space-tolerant on PURPOSE, and used only to phrase a
 * "did you mean" — never to accept the input. "4gb" and "4 GB" are refused like
 * any other non-canonical spelling; recognising them is what lets the error say
 * which token to write instead of listing seven and leaving the reader to
 * diff them by eye. Binary suffixes are recognised for the same reason: "4Gi"
 * is what someone arriving from a container platform will type first.
 */
export function suggestDeploymentMemorySize(raw: string): DeploymentMemorySize | null {
  const match = /^\s*([0-9]+)\s*(m|mb|mi|mib|g|gb|gi|gib)\s*$/i.exec(raw);
  if (match === null) return null;
  const amount = Number(match[1]);
  const megabytes = /^m/i.test(match[2]) ? amount : amount * 1024;
  return deploymentMemoryFromMb(megabytes);
}

/**
 * The CPU that comes with a memory size, and whether it is a whole core.
 *
 * Derived rather than declared — see the note on the ladder above — but NOT
 * hidden: on the smaller server sizes it is a burstable fraction of a core, and
 * a 4GB server that turns out to have one shared core is a surprise worth
 * spending a line of UI on rather than one to meet under load. Every surface
 * that shows a size shows this beside it.
 *
 * `shared` means the vCPU is a burstable slice: it can reach a full core in
 * bursts and is throttled to `count` sustained. A dedicated CPU is `count`
 * cores, always.
 *
 * This is the DISPLAY copy of the mapping. The runtime derives its own machine
 * shapes from the same ladder at the point it calls a provider — that boundary
 * re-derives rather than trusting a number off the wire, exactly as it
 * re-validates every other part of a spec.
 */
export function deploymentCpuForMemory(
  type: DeploymentServiceType,
  memory: DeploymentMemorySize,
  runtime: DeploymentRuntime = DEFAULT_DEPLOYMENT_RUNTIME,
): { count: number, shared: boolean } {
  if (runtime === "fly") {
    // Fly machine guests, the same for both types: shared-cpu-1x up to 2GB,
    // shared-cpu-2x at 4GB, and performance-2x (two dedicated cores) at 8GB.
    switch (memory) {
      case "4GB": { return { count: 2, shared: true }; }
      case "8GB": { return { count: 2, shared: false }; }
      default: { return { count: 1, shared: true }; }
    }
  }
  if (type === "server") {
    // Whole machines, from a fixed catalog: the three smallest are shared-core
    // and the fourth is the first with dedicated ones.
    switch (memory) {
      case "1GB": { return { count: 0.25, shared: true }; }
      case "2GB": { return { count: 0.5, shared: true }; }
      case "4GB": { return { count: 1, shared: true }; }
      default: { return { count: 2, shared: false }; }
    }
  }
  // Containers, where CPU and memory come in legal PAIRS: past 4GB a single CPU
  // is not an allowed combination, which is the real reason memory is the only
  // dial an author turns.
  switch (memory) {
    case "4GB": { return { count: 2, shared: false }; }
    case "8GB": { return { count: 4, shared: false }; }
    default: { return { count: 1, shared: false }; }
  }
}

/**
 * The most memory one project may hold in ALWAYS-ON services at once.
 *
 * Hexclave's own capacity guard, not a per-project quota: nothing meters
 * deployment compute, so the plan ladder bounds what one service may ask for
 * and this bounds how many of them may ask at once. Without it a paid project
 * can stand up an arbitrary number of top-rung servers, each of which is a
 * machine somebody pays for.
 *
 * Only always-on services count (effective `min_instances` of 1 or more). A
 * service that scales to zero holds no machine while it is idle, and how far it
 * may scale UP is already bounded by MAX_INSTANCES_PER_SERVICE.
 */
export const MAX_PROJECT_ALWAYS_ON_MEMORY_MB = 32 * 1024;

// ---------------------------------------------------------------------------
// Build and start commands.
//
// A command is a single command LINE, run through `/bin/sh -c` — the same shape
// as the deploy file's `devCommand`, and the same shape every other platform's
// build/start command has. Not a script: a newline in a Dockerfile `RUN` is a
// new instruction, and a newline in the machine's start command would have to be
// re-quoted at every hop. `sh -c` means `&&`, pipes and redirections all work,
// so a command that wants two steps writes them with `&&` (or, past a certain
// size, moves into a script the command invokes).
export const MAX_DEPLOYMENT_COMMAND_LENGTH = 2048;

/**
 * Whether `value` is usable as a build or start command.
 *
 * Control characters are refused rather than escaped. A build command becomes a
 * line of a generated Dockerfile and a start command becomes an argv entry in a
 * machine config, and in both places a newline or a NUL is a structural
 * character of the thing being generated rather than data — so the rule is
 * stated here, once, and the generators may then assume it.
 */
export function isValidDeploymentCommand(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.trim() !== "" && value.length <= MAX_DEPLOYMENT_COMMAND_LENGTH && !/[\x00-\x1f\x7f]/.test(value);
}


// ---------------------------------------------------------------------------
// Prebuilt images.
//
// A service either builds from the uploaded source (`root_directory` /
// `dockerfile_path`) or names an ALREADY-BUILT image (`image`) — unless it also
// carries a `build_command`, which turns the image into the BASE of a build
// rather than the thing to run. `image` and `dockerfile_path` stay mutually
// exclusive: each of them names a base, and a definition carrying both would
// leave the deployment with two answers to "what is this built from".

export const MAX_DEPLOYMENT_IMAGE_REF_LENGTH = 512;

// The registry an unqualified name belongs to, following Docker's own rule: the
// first path component is a REGISTRY only when it looks like a host (it has a
// dot or a port, or it is exactly "localhost"), and otherwise it is the first
// half of a repository on the default registry.
export const DEFAULT_DEPLOYMENT_IMAGE_REGISTRY = "docker.io";
// Unqualified repositories on Docker Hub are "official images" and live under
// this namespace: `postgres` is `library/postgres`.
export const DEFAULT_DEPLOYMENT_IMAGE_NAMESPACE = "library";
// Other names for Docker Hub. Written references use these interchangeably, and a
// definition must not depend on which one the author picked.
const DOCKER_HUB_REGISTRY_ALIASES = new Set(["index.docker.io", "registry-1.docker.io"]);

// One path component of a repository, per the OCI distribution spec.
const IMAGE_PATH_COMPONENT_REGEX = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
// A tag: up to 128 characters of word characters, dots and dashes, not starting
// with a dot or a dash.
const IMAGE_TAG_REGEX = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
// Only sha256 is accepted. The registry API can name others in principle, but
// nothing in practice produces them, and a narrow rule gives a clearer error
// than a general one that then fails at the registry.
const IMAGE_DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;
// A registry host with an optional port. Deliberately not a general URL: a
// scheme, a path or credentials in here would all be silently dropped by the
// registry client, so they are refused where the author can still see why.
const IMAGE_REGISTRY_HOST_REGEX = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?$/;

/**
 * An image reference in its parts, always fully qualified: `postgres:16` parses
 * to the registry `docker.io` and the repository `library/postgres`, because
 * that is what actually gets pulled and a stored definition should say so.
 *
 * Exactly one of `tag` and `digest` is set. A tag is a POINTER the publisher can
 * move; a digest is the content hash and cannot be moved. Both spellings are
 * accepted from authors and neither is resolved here — the reference reaches the
 * runtime as written, and an author who needs fixed bytes writes the digest.
 */
export type DeploymentImageRef = {
  registry: string,
  repository: string,
  tag: string | null,
  digest: string | null,
  // The reference as it should be stored and displayed, which is the parts
  // rejoined: one spelling for one image, so two definitions naming the same
  // image are equal as strings.
  canonical: string,
};

/**
 * Parses and normalizes an image reference.
 *
 * Returns the failure MESSAGE rather than just null (unlike
 * parseConnectionValue) because every caller wants to say the same thing and
 * the useful part is always *which* rule was broken: the CLI prints it as a
 * deploy-file diagnostic, the schema as a validation error, and the backend as
 * a 400. One message, phrased once.
 */
export function parseDeploymentImageRef(value: string): { ok: true, ref: DeploymentImageRef } | { ok: false, message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  if (value === "") return fail("image must not be empty");
  if (value.length > MAX_DEPLOYMENT_IMAGE_REF_LENGTH) return fail(`image must be at most ${MAX_DEPLOYMENT_IMAGE_REF_LENGTH} characters long`);
  if (/\s/.test(value)) return fail(`image ${JSON.stringify(value)} contains whitespace`);
  if (value.includes("://")) return fail(`image ${JSON.stringify(value)} must not have a scheme — write the registry host on its own, like "ghcr.io/org/app:1.2.3"`);

  // The digest comes off first: it is the only "@" an image reference may hold,
  // so splitting here leaves a name that a ":" can be looked for in.
  const atIndex = value.indexOf("@");
  const digest = atIndex === -1 ? null : value.slice(atIndex + 1);
  const beforeDigest = atIndex === -1 ? value : value.slice(0, atIndex);
  if (digest !== null && !IMAGE_DIGEST_REGEX.test(digest)) {
    return fail(`image ${JSON.stringify(value)} has an invalid digest — a digest is "sha256:" followed by 64 lowercase hex characters`);
  }

  // A ":" is a tag separator only AFTER the last "/": before it, it is the port
  // of a registry host ("localhost:5000/app").
  const lastSlashIndex = beforeDigest.lastIndexOf("/");
  const colonIndex = beforeDigest.indexOf(":", lastSlashIndex + 1);
  const tag = colonIndex === -1 ? null : beforeDigest.slice(colonIndex + 1);
  const name = colonIndex === -1 ? beforeDigest : beforeDigest.slice(0, colonIndex);
  if (tag !== null && !IMAGE_TAG_REGEX.test(tag)) {
    return fail(`image ${JSON.stringify(value)} has an invalid tag — a tag starts with a letter, digit or underscore and may then contain letters, digits, dots, dashes and underscores`);
  }

  // Naming an image twice over. Accepted by Docker, but it leaves two answers to
  // "which bytes" in one string, and the deploy has to pick one silently.
  if (tag !== null && digest !== null) {
    return fail(`image ${JSON.stringify(value)} names both a tag and a digest — use one or the other, since the digest already says exactly which image to run`);
  }
  // An untagged name means ":latest", which is the one reference that is
  // guaranteed to move. Refused rather than defaulted: the author gets to state
  // which version they meant, and a service holding a volume must not silently
  // change major version between deploys.
  if (tag === null && digest === null) {
    return fail(`image ${JSON.stringify(value)} has no tag or digest — an image without one means ":latest", which can change between deploys. Write the version you mean, like ${JSON.stringify(`${value}:1.2.3`)}, or pin it by digest`);
  }

  const components = name.split("/");
  if (components.some((component) => component === "")) {
    return fail(`image ${JSON.stringify(value)} has an empty path segment`);
  }
  // Docker's own rule for telling a registry host from a repository namespace.
  //
  // Lowercased first: DNS is case-insensitive, so `DOCKER.IO` is a legal way to
  // write the hub — but an uppercase spelling matched neither the alias set nor
  // the `library/` rule nor the registry-host swap, and ended up asking Docker
  // Hub's WEB host for a repository that does not exist there.
  const first = components[0].toLowerCase();
  const hasRegistry = components.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  // Docker Hub answers to several names; they are one registry, so they
  // normalize to one, or the same image would canonicalize two different ways.
  const registry = hasRegistry
    ? (DOCKER_HUB_REGISTRY_ALIASES.has(first) ? DEFAULT_DEPLOYMENT_IMAGE_REGISTRY : first)
    : DEFAULT_DEPLOYMENT_IMAGE_REGISTRY;
  const repositoryComponents = hasRegistry ? components.slice(1) : components;
  if (hasRegistry && !IMAGE_REGISTRY_HOST_REGEX.test(registry)) {
    return fail(`image ${JSON.stringify(value)} has an invalid registry host ${JSON.stringify(registry)}`);
  }
  // The port is range-checked here rather than written into the regex: a regex
  // that spells out 1–65535 is unreadable, and an out-of-range port would
  // otherwise be accepted at sync and only fail when the runtime tried to build
  // a URL from it.
  const registryPort = hasRegistry ? /:(\d+)$/.exec(registry) : null;
  if (registryPort !== null && (Number(registryPort[1]) < 1 || Number(registryPort[1]) > 65535)) {
    return fail(`image ${JSON.stringify(value)} has an invalid registry port ${registryPort[1]} (must be between 1 and 65535)`);
  }
  if (repositoryComponents.length === 0) return fail(`image ${JSON.stringify(value)} names a registry but no repository`);
  for (const component of repositoryComponents) {
    if (!IMAGE_PATH_COMPONENT_REGEX.test(component)) {
      return fail(`image ${JSON.stringify(value)} has an invalid repository path segment ${JSON.stringify(component)} — repository names are lowercase, and may contain digits, dots, dashes and underscores between them`);
    }
  }
  // `postgres` is `library/postgres`: a single-component name on Docker Hub is an
  // official image, and storing the short spelling would leave the definition
  // saying something other than what is pulled.
  //
  // Keyed on the RESOLVED registry rather than on whether one was written, because
  // Docker applies this whenever the registry is Docker Hub however it was
  // spelled: `docker.io/postgres` is `library/postgres` too, and treating it as
  // the repository `postgres` asks the registry for something that does not exist.
  const repository = registry === DEFAULT_DEPLOYMENT_IMAGE_REGISTRY && repositoryComponents.length === 1
    ? `${DEFAULT_DEPLOYMENT_IMAGE_NAMESPACE}/${repositoryComponents[0]}`
    : repositoryComponents.join("/");

  return {
    ok: true,
    ref: {
      registry,
      repository,
      tag,
      digest,
      canonical: `${registry}/${repository}${digest === null ? `:${tag}` : `@${digest}`}`,
    },
  };
}
export const deploymentEnvVarSchema = yupObject({
  type: yupString().oneOf(["secret", "connection"]).optional(),
  value: yupString().when("type", ([type], schema) => {
    switch (type) {
      case "secret": {
        return schema.oneOf([undefined], 'deployment env vars with type "secret" must not have a value — set the value in the dashboard under Project Settings → Secrets, or give the secret a default value');
      }
      case "connection": {
        return schema.defined().matches(DEPLOYMENT_CONNECTION_VALUE_REGEX, 'deployment env vars with type "connection" must reference a service output like "hexclave.projectId"');
      }
      default: {
        return schema.defined();
      }
    }
  }),
  key: yupString().when("type", ([type], schema) => type === "secret"
    ? schema.defined().max(MAX_PROJECT_SECRET_KEY_LENGTH, "project secret keys may be at most ${max} characters long").matches(PROJECT_SECRET_KEY_REGEX, "project secret keys must contain only letters, numbers, underscores, and hyphens")
    : schema.oneOf([undefined], 'deployment env vars may only have a key when their type is "secret"')),
  // `secret(key, default)` fallbacks are a config-file concept that must never
  // be persisted: they travel with the deploy request instead (see
  // deploymentSecretDefaultsSchema). Rejected rather than ignored — this is
  // the schema every write path validates against, so refusing the field here
  // is what makes "a stored definition cannot contain a default" a checkable
  // property instead of a convention. (A `.strip()` here would be the
  // alternative, but rejecting is the point: the caller should learn that the
  // field is not storable rather than have it silently disappear.)
  default_value: yupString().oneOf([undefined], "deployment env var definitions must not carry a default_value — secret defaults belong to the deploy request, not to the stored definition"),
});

// Fallback values for a service's `secret()` env vars, sent with a DEPLOY
// request and never stored: they are the second argument of `secret(key,
// default)` in the deploy file's `services` export, which is a purely
// author-side convenience. Keyed by ENV VAR key (not secret key) because
// that's where the default is written — the same secret may be referenced by
// two env vars with different defaults, and the dashboard must never learn
// that any of this exists.
export const deploymentSecretDefaultsSchema = yupRecord(
  yupString().matches(DEPLOYMENT_ENV_VAR_KEY_REGEX, "deployment secret default keys must be env var keys"),
  yupString().defined(),
);

// The GitLab-style CI variables describing the commit a deploy ships (see
// collectCiEnv in the CLI). Sent with a DEPLOY request and never stored: they
// describe one deploy, so persisting them on the definition would leave a stale
// commit sha on every service the next deploy doesn't ship.
//
// Restricted to the CI_ namespace, so this channel can only ever add CI metadata:
// a deploy must not be able to reach the injected Hexclave credentials (or any
// other env var the definition owns) through a field meant for provenance.
//
// Bare `CI` is deliberately NOT in the namespace. The runtime sets CI=true for
// every remote build, and accepting it here would let a caller send CI=false and
// turn that guarantee off — while also setting CI at RUNTIME, which is the one
// thing that flag should never say.
const DEPLOYMENT_CI_ENV_VAR_KEY_REGEX = /^CI_[A-Z0-9_]+$/;
// A bound on the whole field, checked at the front door. Without one the only
// backstop is the runtime's build-env cap, which fires after the deploy has
// already read secrets, consumed the upload and burned a deployment number —
// so an oversized ci_env would fail late and leave a failed row behind. Ten
// short provenance variables need well under a kilobyte.
export const MAX_DEPLOYMENT_CI_ENV_BYTES = 4 * 1024;
export const deploymentCiEnvSchema = yupRecord(
  yupString().matches(DEPLOYMENT_CI_ENV_VAR_KEY_REGEX, "ci_env keys must be CI variable names: CI_ followed by upper-case letters, digits and underscores"),
  yupString().defined(),
).test(
  "ci-env-within-size-limit",
  `ci_env may be at most ${MAX_DEPLOYMENT_CI_ENV_BYTES} bytes in total (keys plus values)`,
  (value: Record<string, string> | undefined) => {
    if (value === undefined) return true;
    let total = 0;
    for (const [key, entry] of Object.entries(value)) {
      // Measured in UTF-8 rather than UTF-16 code units: this bounds what
      // travels to the runtime and onto the builder machine, which is bytes.
      total += Buffer.byteLength(key, "utf8") + Buffer.byteLength(String(entry), "utf8");
    }
    return total <= MAX_DEPLOYMENT_CI_ENV_BYTES;
  },
);

export const deploymentServiceDefinitionSchema = yupObject({
  type: yupString().oneOf([...DEPLOYMENT_SERVICE_TYPES]).defined(),
  // Keyed by port NUMBER, exactly as the deploy file writes it. JSON object keys
  // are strings, so the key schema is what enforces "this is a port number" —
  // and duplicates are impossible by construction, which is one rule fewer than
  // the array shape needed.
  // Public is a property of the SERVICE, not of a port: Fly's proxy listener set
  // is per-app rather than per-address, so every declared port answers on every
  // address the app holds. A per-port flag could SAY "public 3000, private 5432"
  // but the runtime would publish both, so the flag lives where the truth does.
  //
  // The two rules below are what that costs: with the flag on the port, "public
  // TCP" and "public worker" were unrepresentable; on the service they have to be
  // refused instead.
  public: yupBoolean().optional()
    // A public service is all-HTTP. Raw TCP cannot be public because Fly's shared
    // IPv4 tells apps apart by SNI (or Host) and a raw TCP stream carries
    // neither — VERIFIED against real Fly, where the edge accepts the connection
    // and then silently drops it. Lifting this needs a dedicated IPv4 per
    // service, which is a billing decision rather than a code change.
    .test("public-service-is-all-http", 'a public service may not declare a "tcp" port: raw TCP carries no SNI or Host header, so a shared public address cannot tell which service a connection is for. Keep the service private and reach it with hostname() and its port number', function (value) {
      if (value !== true) return true;
      const ports = (this.parent as { ports?: DeploymentPorts }).ports;
      return ports === undefined || deploymentPortEntries(ports).every((entry) => entry.protocol === "http");
    })
    // A worker declares no ports, so there is nothing for public ingress to
    // serve. Refused rather than ignored: it allocates addresses for a service
    // that can never answer on them.
    .test("public-service-serves-something", "a public service must declare at least one port — a service with no ports has nothing to serve on the public address it would be given", function (value) {
      if (value !== true) return true;
      const ports = (this.parent as { ports?: DeploymentPorts }).ports;
      return ports === undefined || deploymentPortEntries(ports).length > 0;
    }),
  ports: yupRecord(
    yupString().matches(DEPLOYMENT_PORT_KEY_REGEX, "deployment service port keys must be port numbers written without a leading zero")
      .test("port-in-range", "deployment service ports must be between 1 and 65535", (value) =>
        value === undefined || (Number(value) >= 1 && Number(value) <= 65535)),
    yupObject({
      protocol: yupString().oneOf(["http", "tcp"]).defined(),
    }).defined()
  ).defined()
    // No lower bound: a service may declare zero ports. That is a worker — a
    // queue consumer, a cron, anything that only makes outbound connections —
    // and it runs with an empty Fly `services` array. Nothing downstream needs a
    // port: `url` resolves to null, and a custom domain is
    // already refused on a service with no HTTP port.
    //
    // It is only USEFUL on an always-on service, because autostart/autostop live
    // on `services` entries: with none, the Fly proxy can never wake a stopped
    // machine. A `type: "server"` with minInstances 1 runs; one that suspends,
    // or a "serverless" with `minInstances: 0`, will sit stopped forever. That is
    // left to the author rather than refused — see the note on serverless status
    // in getServiceState.
    //
    // The `value === undefined` guards below are load-bearing despite what the
    // types say: `.defined()` makes yup TYPE the test input as present, but yup
    // still runs every test on a missing value (that is how `.defined()` itself
    // reports), and under `abortEarly: false` these run alongside it.
    .test("ports-within-cap", `a deployment service may declare at most ${MAX_PORTS_PER_SERVICE} ports`, (value) =>
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      value === undefined || Object.keys(value).length <= MAX_PORTS_PER_SERVICE)
    // The standard-ports holder claims external 80 and 443 for the whole app, so
    // no OTHER declared port may be numbered 80 or 443 — it would ask for a
    // listener the holder already took. See reservedStandardPortConflicts.
    .test("standard-ports-are-not-claimed-twice", "80 and 443 belong to the port that owns the service's standard bindings (the lowest port of a public service, or the sole HTTP port of a private one), so no other port may be numbered 80 or 443 — the runtime cannot serve one external port from two of them", function (value) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      return value === undefined || reservedStandardPortConflicts(value, (this.parent as { public?: boolean }).public === true).length === 0;
    }),
  // min is capped at the same MAX_INSTANCES_PER_SERVICE as max — an unbounded
  // min would only ever fail downstream. On a "server" it is not a fleet size:
  // 1 (the default) keeps its single instance up, and 0 is the Free-plan value.
  // The runtime has no request-triggered suspend for a server, so 0 does not
  // currently guarantee scale-to-zero billing.
  min_instances: yupNumber().integer().min(0).max(MAX_INSTANCES_PER_SERVICE).optional()
    .test("server-is-single-instance-min", 'a "server" service holds a single instance, so min_instances must be 0 or 1 — use type "serverless" to scale out', function (value) {
      return (this.parent as { type?: string }).type !== "server" || value === undefined || value === 0 || value === 1;
    }),
  max_instances: yupNumber().integer().min(1).max(MAX_INSTANCES_PER_SERVICE).optional()
    // Compare EFFECTIVE bounds, not just when both are present: `min_instances` alone (no
    // max) defaults max to 1 downstream, so `min: 2` with no max is an invalid spec that
    // must be caught here — otherwise Marshal 400s it after the upload is consumed.
    .test("max-gte-min", "max_instances must be greater than or equal to min_instances (max_instances defaults to 1)", function (value) {
      const minInstances = (this.parent as { min_instances?: number }).min_instances ?? 0;
      const effectiveMax = value ?? Math.max(minInstances, 1);
      return effectiveMax >= minInstances;
    })
    .test("server-is-single-instance", 'a "server" service is always a single instance, so max_instances must be 1 (use type "serverless" to scale out)', function (value) {
      return (this.parent as { type?: string }).type !== "server" || value === undefined || value === 1;
    }),
  // Only the rungs the service's own type offers: a "server" has no 512MB shape
  // to run on, and each type's ladder stops where the plan entitlement does.
  // Validated against `type` rather than against one flat list so the message
  // names the sizes that are actually available to THIS service.
  memory: yupString().oneOf([...DEPLOYMENT_MEMORY_SIZES]).optional()
    .test("memory-is-available-for-type", "the memory size is not available for this service type", function (value) {
      if (value === undefined) return true;
      const type = (this.parent as { type?: DeploymentServiceType }).type;
      // A missing/invalid type is its own error; do not add a second one that
      // only says the size could not be checked.
      if (type !== "server" && type !== "serverless") return true;
      const available = deploymentMemorySizesForType(type);
      if ((available as readonly string[]).includes(value)) return true;
      return this.createError({ message: `memory ${JSON.stringify(value)} is not available for a ${JSON.stringify(type)} service — it can be ${available.join(", ")}` });
    }),
  root_directory: yupString().optional(),
  // Persistent disks, keyed by volume id. The rules here must be AT LEAST as
  // strict as Marshal's validateServiceSpec so nothing reaches the runtime that
  // it would reject after an upload has already been consumed.
  persistent_volumes: yupRecord(
    yupString()
      .matches(DEPLOYMENT_VOLUME_ID_REGEX, "persistent volume ids must start with a lowercase letter and contain only lowercase letters, digits, and underscores")
      .max(MAX_VOLUME_ID_LENGTH),
    yupObject({
      // A normalized ABSOLUTE mount point. Relative paths are ambiguous against
      // the image's WORKDIR, and mounting over "/" would shadow the whole image.
      path: yupString().defined().max(512)
        // `path` is `.defined()`, so unlike the optional `dockerfile_path` above
        // there is no undefined case to let through here.
        .test("absolute-path", 'persistent volume paths must be a normalized absolute path inside the container (e.g. "/data") — no trailing slash, no "." or ".." segments, no backslashes or control characters', (value) =>
          value.startsWith("/")
          && value !== "/"
          && !value.endsWith("/")
          && !value.includes("\\")
          // eslint-disable-next-line no-control-regex
          && !/[\x00-\x1f]/.test(value)
          && value.split("/").slice(1).every((segment) => segment !== "" && segment !== "." && segment !== "..")),
      size_gb: yupNumber().integer().min(MIN_VOLUME_SIZE_GB).max(MAX_VOLUME_SIZE_GB).defined(),
    }).defined(),
  ).optional().default(undefined)
    .test("at-most-one-persistent-volume", `a service may declare at most ${MAX_PERSISTENT_VOLUMES_PER_SERVICE} persistent volume — mounting more than one disk on a single instance is not supported yet`, (value) =>
      value === undefined || Object.keys(value).length <= MAX_PERSISTENT_VOLUMES_PER_SERVICE)
    // Only a "server" is single-instance-by-construction; a serverless fleet
    // would hand each instance its own unreplicated disk.
    .test("volume-requires-server-type", 'only a "server" service may have persistent volumes — a volume is local disk on one host and can only be attached to a single instance', function (value) {
      if (value === undefined || Object.keys(value).length === 0) return true;
      return (this.parent as { type?: string }).type === "server";
    }),
  // Optional Dockerfile location within the uploaded tree (the deploy file's
  // `dockerfilePath` with the service's `rootDirectory` already joined on);
  // absent = Railpack auto-detected build. Must stay inside the packaged source
  // — it flows into the remote builder as a path within the source tarball. The
  // rules here must be AT LEAST as strict as Marshal's validateServiceSpec:
  // anything the runtime would reject must already fail at sync time, not after
  // an upload has been consumed at deploy time.
  dockerfile_path: yupString().optional().max(512)
    .test("relative-path", 'dockerfile_path must be a normalized relative path inside the uploaded source (no leading "/", no "." or ".." segments, no backslashes or control characters)', (value) =>
      value === undefined || (
        value !== ""
        && !value.startsWith("/")
        && !value.includes("\\")
        // eslint-disable-next-line no-control-regex
        && !/[\x00-\x1f]/.test(value)
        && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
      )),
  // An already-built image to run instead of building one. Validated with the
  // shared parser so the deploy file, this schema and the runtime cannot
  // disagree about what a reference means, and stored CANONICAL so a definition
  // says what is actually pulled.
  image: yupString().optional().max(MAX_DEPLOYMENT_IMAGE_REF_LENGTH)
    // Normalized on the way IN, so what is stored is what is actually pulled and
    // every write path agrees. Doing it here rather than in each client is what
    // keeps `postgres:16` from the CLI and `postgres:16` from a direct API call
    // from becoming two different stored strings for one image.
    //
    // A reference that does not parse is passed through untouched, so the test
    // below reports which rule it broke instead of a confusing cast failure.
    // (Only write paths validate: rows stored before this existed keep whatever
    // spelling they were written with.)
    .transform((value: unknown) => {
      if (typeof value !== "string") return value;
      const parsed = parseDeploymentImageRef(value);
      return parsed.ok ? parsed.ref.canonical : value;
    })
    .test("valid-image-ref", "invalid image reference", function (value) {
      if (value === undefined) return true;
      const parsed = parseDeploymentImageRef(value);
      // The parser's message is the whole point of it — surfaced verbatim rather
      // than collapsed into "invalid image reference", which would leave the
      // author to guess which of a dozen rules they broke.
      return parsed.ok || this.createError({ message: parsed.message });
    })
    // `image` and `dockerfile_path` each name a BASE, so a service has at most
    // one of them. `root_directory` is deliberately not in this rule any more:
    // with a `build_command` the image is a base, the source is copied onto it,
    // and the root directory is where that command runs.
    .test("image-excludes-dockerfile-path", "a service is built from an `image` or from a `dockerfile_path`, not both — each of them says what the build starts from", function (value) {
      if (value === undefined) return true;
      return (this.parent as { dockerfile_path?: string }).dockerfile_path === undefined;
    })
    .test("image-without-build-excludes-root-directory", "a service that only runs an `image` is not built from your source, so it has no `root_directory` within it — add a `build_command` to build on top of the image, or drop `root_directory`", function (value) {
      if (value === undefined) return true;
      const parent = this.parent as { root_directory?: string, build_command?: string };
      return parent.build_command !== undefined || parent.root_directory === undefined;
    }),
  // A single command line run through `/bin/sh -c` while the image is built.
  // Selects the generated-Dockerfile path unless a `dockerfile_path` is set, in
  // which case it is appended to the author's Dockerfile as a final `RUN`.
  //
  // The rules here must be AT LEAST as strict as Marshal's, which generates a
  // Dockerfile line from this: a command that the runtime would refuse has to
  // fail at sync time rather than after an upload has been consumed.
  build_command: yupString().optional().max(MAX_DEPLOYMENT_COMMAND_LENGTH)
    .test("valid-command", `build_command must be a single non-empty command line of at most ${MAX_DEPLOYMENT_COMMAND_LENGTH} characters, with no control characters (it becomes one \`RUN\` line of the built image — chain steps with \`&&\`)`, (value) =>
      value === undefined || isValidDeploymentCommand(value)),
  // A single command line run through `/bin/sh -c` as the container's process,
  // instead of whatever the image would have started. Applied at run time, so it
  // never causes a build.
  start_command: yupString().optional().max(MAX_DEPLOYMENT_COMMAND_LENGTH)
    .test("valid-command", `start_command must be a single non-empty command line of at most ${MAX_DEPLOYMENT_COMMAND_LENGTH} characters, with no control characters`, (value) =>
      value === undefined || isValidDeploymentCommand(value))
    // The Hexclave base image runs nothing on its own: a service built on it
    // without a start command would deploy, start, and immediately exit. Caught
    // here rather than at deploy time, where the upload has already been spent.
    .test("base-image-build-needs-start-command", "a service with a `build_command` but no `image` or `dockerfile_path` is built on the Hexclave base image, which has no command of its own — add a `startCommand` saying how to run it", function (value) {
      if (value !== undefined) return true;
      const parent = this.parent as { image?: string, dockerfile_path?: string, build_command?: string };
      return parent.build_command === undefined || parent.image !== undefined || parent.dockerfile_path !== undefined;
    }),
  // `devCommand` is a config-file-only field: `hexclave dev --service-id`
  // reads it straight out of the local deploy file, and the backend never acts
  // on it, so it is never sent and never stored. Rejected rather than simply
  // absent because yupRecord re-validates its values in a fresh validation
  // whose path no longer starts with "body" — the route handler's
  // unknown-property check therefore does NOT reach inside `services`, so an
  // omitted field would be silently dropped instead of reported (same reason
  // `default_value` below is spelled out).
  dev_command: yupString().oneOf([undefined], "deployment service definitions must not carry a dev_command — the dev command stays in your deploy file and is never sent to the server (upgrade your Hexclave CLI if this came from `hexclave deploy`)"),
  env: yupRecord(
    yupString().matches(DEPLOYMENT_ENV_VAR_KEY_REGEX, "deployment env var keys must start with a letter or underscore and contain only letters, digits, and underscores"),
    deploymentEnvVarSchema.defined(),
  ).defined(),
});

/**
 * The `builder` a deploy file declares, alongside its services.
 *
 * Deliberately its own schema rather than a field of the service one: the
 * builder is one machine per DEPLOYMENT, and the sync route stores it on the
 * deployment source rather than on any service row.
 */
export const deploymentBuilderDefinitionSchema = yupObject({
  memory: yupString().oneOf([...BUILDER_MEMORY_SIZES]).optional(),
});

import.meta.vitest?.test("memory sizes are per-type ladders with derivable megabytes", async ({ expect }) => {
  const base = { ports: { "3000": { protocol: "http" } }, env: {} };
  // Every rung of a type's own ladder is accepted.
  for (const memory of SERVERLESS_MEMORY_SIZES) {
    await expect(deploymentServiceDefinitionSchema.validate({ ...base, type: "serverless", memory }, { abortEarly: false })).resolves.toBeDefined();
  }
  for (const memory of SERVER_MEMORY_SIZES) {
    await expect(deploymentServiceDefinitionSchema.validate({ ...base, type: "server", memory }, { abortEarly: false })).resolves.toBeDefined();
  }
  // The schema accepts the UNION of the runtimes' ladders (it does not know
  // which runtime a definition is bound for); the runtime-specific check lives
  // in the CLI and the sync route. A GCP server has no 512MB shape, which is
  // what the per-runtime ladder says and the schema deliberately does not.
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, type: "server", memory: "512MB",
  }, { abortEarly: false })).resolves.toBeDefined();
  expect(deploymentMemorySizesForType("server", "gcp")).not.toContain("512MB");
  expect(deploymentMemorySizesForType("server", "fly")).toContain("512MB");
  expect(defaultDeploymentMemoryForType("server", "gcp")).toBe("1GB");
  expect(defaultDeploymentMemoryForType("server", "fly")).toBe("512MB");
  expect(defaultDeploymentMemoryForType("serverless", "gcp")).toBe(defaultDeploymentMemoryForType("serverless", "fly"));
  // Builder-only rungs are not service rungs: the ladders stop where the plan
  // entitlement does, so a size nobody can deploy is never offered.
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, type: "serverless", memory: "16GB",
  }, { abortEarly: false })).rejects.toThrow(/memory/);
  // Non-canonical spellings are values outside the ladder, not alternate names.
  for (const memory of ["4gb", "4 GB", "4Gi", "4096MB", 4096]) {
    await expect(deploymentServiceDefinitionSchema.validate({ ...base, type: "serverless", memory }, { abortEarly: false })).rejects.toThrow(/memory/);
  }
  // Absent stays absent: the default is applied downstream, not baked in here,
  // so a definition that says nothing keeps hashing as it did before this field.
  expect(await deploymentServiceDefinitionSchema.validate({ ...base, type: "serverless" }, { abortEarly: false }))
    .not.toHaveProperty("memory");
  // The builder ladder starts where the service ladders stop.
  await expect(deploymentBuilderDefinitionSchema.validate({ memory: "32GB" })).resolves.toBeDefined();
  await expect(deploymentBuilderDefinitionSchema.validate({ memory: "512MB" })).rejects.toThrow(/memory/);
});

import.meta.vitest?.test("memory tokens round-trip through megabytes, and near-misses are suggestible", ({ expect }) => {
  for (const size of DEPLOYMENT_MEMORY_SIZES) {
    expect(deploymentMemoryFromMb(deploymentMemoryToMb(size))).toBe(size);
  }
  // Every ladder entry is a real token, and the defaults are on their own ladder.
  expect(deploymentMemorySizesForType("server")).toContain(defaultDeploymentMemoryForType("server"));
  expect(deploymentMemorySizesForType("serverless")).toContain(defaultDeploymentMemoryForType("serverless"));
  // A megabyte count off the ladder is "unset", never a rounded neighbour: a
  // column written by a future version must not claim to be a size we run.
  expect(deploymentMemoryFromMb(3072)).toBe(null);
  expect(deploymentMemoryFromMb(0)).toBe(null);
  // Suggestions recognise the spellings someone actually types first, including
  // the binary suffixes of other container platforms. Recognising is not
  // accepting — the schema above still refuses all of these.
  expect(suggestDeploymentMemorySize("4gb")).toBe("4GB");
  expect(suggestDeploymentMemorySize("4 GB")).toBe("4GB");
  expect(suggestDeploymentMemorySize("4Gi")).toBe("4GB");
  expect(suggestDeploymentMemorySize("4096MB")).toBe("4GB");
  expect(suggestDeploymentMemorySize("512Mi")).toBe("512MB");
  expect(suggestDeploymentMemorySize("3GB")).toBe(null);
  expect(suggestDeploymentMemorySize("lots")).toBe(null);
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema accepts all env var shapes", async ({ expect }) => {
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless",
    ports: { "3000": { protocol: "http" } },
    min_instances: 0,
    max_instances: 2,
    root_directory: "./",
    dockerfile_path: "docker/Dockerfile.web",
    env: {
      MY_ENV_VAR: { value: "true" },
      DATABASE_CONNECTION_STRING: { type: "secret", key: "db_connection" },
      OPENAI_API_KEY: { type: "secret", key: "OPENAI" },
      NEXT_PUBLIC_HEXCLAVE_PROJECT_ID: { type: "connection", value: "hexclave.projectId" },
      API_INTERNAL_URL: { type: "connection", value: "api.url:8080" },
    },
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("parseDeploymentImageRef fully qualifies every accepted spelling", ({ expect }) => {
  const parse = (value: string) => {
    const result = parseDeploymentImageRef(value);
    if (!result.ok) throw new Error(`expected ${value} to parse, got: ${result.message}`);
    return result.ref;
  };
  // An unqualified name is an official image on the default registry, and is
  // stored as such: the definition must say what is actually pulled.
  expect(parse("postgres:16")).toMatchObject({ registry: "docker.io", repository: "library/postgres", tag: "16", digest: null, canonical: "docker.io/library/postgres:16" });
  expect(parse("myorg/app:1.2.3")).toMatchObject({ registry: "docker.io", repository: "myorg/app", canonical: "docker.io/myorg/app:1.2.3" });
  // A first component that looks like a host IS one; one that does not is a
  // repository namespace. That is the only thing telling the two apart.
  expect(parse("ghcr.io/org/app:1.2.3")).toMatchObject({ registry: "ghcr.io", repository: "org/app" });
  expect(parse("registry.example.com:5000/team/app:v1")).toMatchObject({ registry: "registry.example.com:5000", repository: "team/app", tag: "v1" });
  expect(parse("localhost:5000/app:v1")).toMatchObject({ registry: "localhost:5000", repository: "app" });
  // A deep repository path keeps every segment.
  expect(parse("gcr.io/project/team/app:v1")).toMatchObject({ registry: "gcr.io", repository: "project/team/app" });
  // A digest is a reference in its own right and needs no tag.
  const digest = `sha256:${"a".repeat(64)}`;
  expect(parse(`postgres@${digest}`)).toMatchObject({ tag: null, digest, canonical: `docker.io/library/postgres@${digest}` });
  // The `library/` default follows the REGISTRY, not whether one was written:
  // Docker applies it to any single-component name on Docker Hub, and the hub
  // answers to several host names that must all canonicalize to one.
  for (const written of ["docker.io/postgres:16", "index.docker.io/postgres:16", "registry-1.docker.io/postgres:16"]) {
    expect(parse(written).canonical).toBe("docker.io/library/postgres:16");
  }
  // Already-qualified names, and other registries, are left alone.
  expect(parse("docker.io/myorg/app:1").canonical).toBe("docker.io/myorg/app:1");
  expect(parse("ghcr.io/app:1").canonical).toBe("ghcr.io/app:1");
  // DNS is case-insensitive, so an uppercase host names the same registry.
  expect(parse("DOCKER.IO/postgres:16").canonical).toBe("docker.io/library/postgres:16");
  expect(parse("Index.Docker.IO/postgres:16").canonical).toBe("docker.io/library/postgres:16");
  expect(parse("GHCR.IO/org/app:1").canonical).toBe("ghcr.io/org/app:1");
});

import.meta.vitest?.test("parseDeploymentImageRef refuses a registry port outside 1-65535", ({ expect }) => {
  // Refused at authoring rather than at deploy: the runtime can only report
  // these as an unbuildable URL, long after the definition was synced.
  const message = (value: string) => {
    const result = parseDeploymentImageRef(value);
    if (result.ok) throw new Error(`expected ${value} to be rejected`);
    return result.message;
  };
  expect(message("registry.example.com:99999/team/app:v1")).toMatch(/invalid registry port/);
  expect(message("registry.example.com:0/team/app:v1")).toMatch(/invalid registry port/);
  expect(parseDeploymentImageRef("registry.example.com:65535/team/app:v1").ok).toBe(true);
  expect(parseDeploymentImageRef("localhost:5000/app:v1").ok).toBe(true);
});

import.meta.vitest?.test("parseDeploymentImageRef refuses references that would not name fixed bytes", ({ expect }) => {
  const message = (value: string) => {
    const result = parseDeploymentImageRef(value);
    if (result.ok) throw new Error(`expected ${value} to be rejected`);
    return result.message;
  };
  // The headline rule: an untagged name means ":latest", which is exactly the
  // reference a publisher moves. The author says which version they meant.
  expect(message("postgres")).toMatch(/no tag or digest/);
  expect(message("ghcr.io/org/app")).toMatch(/no tag or digest/);
  // An EXPLICIT :latest is allowed — no worse than any other tag, and unlike a
  // bare name it says the author meant it.
  expect(parseDeploymentImageRef("postgres:latest").ok).toBe(true);
  // Two answers to "which bytes" in one string.
  expect(message(`postgres:16@sha256:${"a".repeat(64)}`)).toMatch(/both a tag and a digest/);
  expect(message("postgres@sha256:abc")).toMatch(/invalid digest/);
  expect(message("postgres@md5:abc")).toMatch(/invalid digest/);
  // Repository names are lowercase; an uppercase one fails at the registry with
  // a far worse error than this.
  expect(message("Postgres:16")).toMatch(/invalid repository path segment/);
  expect(message("ghcr.io/Org/app:1")).toMatch(/invalid repository path segment/);
  expect(message("https://ghcr.io/org/app:1")).toMatch(/must not have a scheme/);
  expect(message("ghcr.io//app:1")).toMatch(/empty path segment/);
  expect(message("postgres:.16")).toMatch(/invalid tag/);
  expect(message("")).toMatch(/must not be empty/);
  expect(message("postgres :16")).toMatch(/whitespace/);
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema accepts an image service and refuses one that also builds", async ({ expect }) => {
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "5432": { protocol: "tcp" } }, image: "postgres:16",
    persistent_volumes: { pgdata: { path: "/data", size_gb: 10 } },
    env: { POSTGRES_PASSWORD: { type: "secret", key: "POSTGRES_PASSWORD" } },
    // Normalized by the schema itself, so every write path stores the reference
    // that is actually pulled rather than whichever spelling the client used.
  }, { abortEarly: false })).resolves.toMatchObject({ image: "docker.io/library/postgres:16" });
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: {}, image: "ghcr.io/org/app:1.2.3", env: {},
  }, { abortEarly: false })).resolves.toMatchObject({ image: "ghcr.io/org/app:1.2.3" });
  // The parser's own message survives validation rather than being flattened.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: {}, image: "postgres", env: {},
  }, { abortEarly: false })).rejects.toThrow(/no tag or digest/);
  // An image with nothing built on top of it is not built from the source, so it
  // has no directory within it.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: {}, image: "postgres:16", root_directory: "./database", env: {},
  }, { abortEarly: false })).rejects.toThrow(/has no `root_directory`/);
  // `image` and `dockerfile_path` each name a base.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: {}, image: "postgres:16", dockerfile_path: "Dockerfile", env: {},
  }, { abortEarly: false })).rejects.toThrow(/not both/);
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema accepts build and start commands, including on an image base", async ({ expect }) => {
  // The generated-Dockerfile path: no base named, so the Hexclave base image is
  // used and a start command is what makes it runnable.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, root_directory: "./web",
    build_command: "pnpm install --frozen-lockfile && pnpm build",
    start_command: "pnpm start",
    env: {},
  }, { abortEarly: false })).resolves.toMatchObject({ build_command: "pnpm install --frozen-lockfile && pnpm build", start_command: "pnpm start" });
  // An image as a BASE: `root_directory` is meaningful again, because the source
  // is copied onto it and the command runs there.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } },
    image: "python:3.12-slim", root_directory: "./api", build_command: "pip install -r requirements.txt",
    start_command: "python -m uvicorn main:app --host 0.0.0.0 --port 3000",
    env: {},
  }, { abortEarly: false })).resolves.toMatchObject({ image: "docker.io/library/python:3.12-slim", root_directory: "./api" });
  // A start command alone never causes a build, so it is legal on a bare image.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "6379": { protocol: "tcp" } }, image: "redis:7-alpine",
    start_command: "redis-server --appendonly yes", env: {},
  }, { abortEarly: false })).resolves.toMatchObject({ start_command: "redis-server --appendonly yes" });
  // A Dockerfile plus a build command appends to the author's build.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, dockerfile_path: "Dockerfile",
    build_command: "npm run postbuild", env: {},
  }, { abortEarly: false })).resolves.toMatchObject({ build_command: "npm run postbuild" });
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema refuses commands it could not generate from", async ({ expect }) => {
  const base = { type: "serverless" as const, ports: { "3000": { protocol: "http" } }, env: {} };
  // A newline would be a second Dockerfile instruction, and a NUL cannot survive
  // an argv entry — both are refused rather than escaped.
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, build_command: "npm run build\nrm -rf /", start_command: "npm start",
  }, { abortEarly: false })).rejects.toThrow(/build_command/);
  await expect(deploymentServiceDefinitionSchema.validate({
    // A TAB is the field separator of the manifest the builder reads, so it
    // cannot reach the build either.
    ...base, start_command: "npm\tstart",
  }, { abortEarly: false })).rejects.toThrow(/start_command/);
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, build_command: "   ", start_command: "npm start",
  }, { abortEarly: false })).rejects.toThrow(/build_command/);
  // Not `abortEarly: false` here: an over-length command breaks BOTH the max and
  // the shape rule, and an aggregated ValidationError reports only "2 errors
  // occurred" rather than either message.
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, start_command: "x".repeat(MAX_DEPLOYMENT_COMMAND_LENGTH + 1),
  })).rejects.toThrow(/start_command/);
  // The Hexclave base image has no command of its own.
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, build_command: "npm run build",
  }, { abortEarly: false })).rejects.toThrow(/no command of its own/);
  // ...but a base that DOES (the author's image or Dockerfile) needs none.
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, build_command: "npm run build", image: "node:22-bookworm",
  }, { abortEarly: false })).resolves.toBeDefined();
  await expect(deploymentServiceDefinitionSchema.validate({
    ...base, build_command: "npm run build", dockerfile_path: "Dockerfile",
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceIsBuilt and deploymentServiceUsesGeneratedDockerfile agree on what each shape means", ({ expect }) => {
  const built = (definition: Partial<DeploymentServiceDefinition>) => deploymentServiceIsBuilt(definition);
  const generated = (definition: Partial<DeploymentServiceDefinition>) => deploymentServiceUsesGeneratedDockerfile(definition);
  // Railpack auto-detection: built, but not from a generated Dockerfile.
  expect([built({}), generated({})]).toEqual([true, false]);
  // The author's Dockerfile owns the build, with or without an appended command.
  expect([built({ dockerfile_path: "Dockerfile" }), generated({ dockerfile_path: "Dockerfile" })]).toEqual([true, false]);
  expect(generated({ dockerfile_path: "Dockerfile", build_command: "make" })).toBe(false);
  // A bare image is the one shape that is not built at all.
  expect([built({ image: "postgres:16" }), generated({ image: "postgres:16" })]).toEqual([false, false]);
  // ...and a start command does not change that: it is applied at run time.
  expect(built({ image: "postgres:16", start_command: "postgres -c fsync=off" })).toBe(false);
  // A build command turns the image into a base.
  expect([built({ image: "node:22", build_command: "npm ci" }), generated({ image: "node:22", build_command: "npm ci" })]).toEqual([true, true]);
  // With no base at all, a BUILD command selects the Hexclave base image...
  expect(generated({ build_command: "npm ci" })).toBe(true);
  // ...but a start command alone never changes how a service is built. Adding
  // "run it this way" to a Railpack service must not silently throw away the
  // install and compile that Railpack was doing for it.
  expect(generated({ start_command: "node server.js" })).toBe(false);
  expect(built({ start_command: "node server.js" })).toBe(true);
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema requires explicit port protocols and defaults a service to private", async ({ expect }) => {
  await expect(deploymentServiceDefinitionSchema.validate({ type: "serverless", ports: { "3000": {} }, env: {} }))
    .rejects.toThrow(/protocol.*defined/);
  await expect(deploymentServiceDefinitionSchema.validate({ type: "serverless", ports: { "3000": { protocol: "http" } }, env: {} }))
    .resolves.toMatchObject({ ports: { "3000": { protocol: "http" } } });
  await expect(deploymentServiceDefinitionSchema.validate({ type: "serverless", public: true, ports: { "3000": { protocol: "http" } }, env: {} }))
    .resolves.toMatchObject({ public: true, ports: { "3000": { protocol: "http" } } });
  // A PRIVATE service may hold several ports of mixed protocols.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "8080": { protocol: "http" }, "5432": { protocol: "tcp" }, "9090": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema accepts a portless worker", async ({ expect }) => {
  // Nothing listening: a queue consumer or cron that only dials out. Accepted on
  // either type — a "serverless" one that never scales up is the author's call.
  await expect(deploymentServiceDefinitionSchema.validate({ type: "server", ports: {  }, env: {} }, { abortEarly: false }))
    .resolves.toMatchObject({ ports: {  } });
  await expect(deploymentServiceDefinitionSchema.validate({ type: "serverless", ports: {  }, env: {} }, { abortEarly: false }))
    .resolves.toMatchObject({ ports: {  } });
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema accepts a public service with several ports", async ({ expect }) => {
  // Every port of a public service is reachable, so there is no port the author
  // did not ask to publish. Only the lowest additionally owns 80/443.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", public: true, ports: { "3000": { protocol: "http" }, "4000": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema refuses a non-canonical port key", async ({ expect }) => {
  // "80" and "080" are one port under two keys: the record makes an exact key
  // impossible to repeat, not a numeric alias, so both entries would be stored
  // and the runtime would declare the port twice.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", public: true, ports: { "80": { protocol: "http" }, "080": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/without a leading zero/);
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "08080": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/without a leading zero/);
});

import.meta.vitest?.test("deploymentPortEntries drops a non-canonical key rather than double-counting it", ({ expect }) => {
  // The reader runs on STORED rows and must not throw, but it must also not turn
  // one port into two entries — a row written before this rule existed would
  // otherwise still produce duplicate listeners.
  expect(deploymentPortEntries({ "80": { protocol: "http" }, "080": { protocol: "http" } })).toEqual([{ port: 80, protocol: "http" }]);
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema refuses a port that collides with the standard bindings", async ({ expect }) => {
  // The holder claims external 80 and 443 on top of its own number, so a sibling
  // numbered 80 or 443 asks for a listener it has already taken.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", public: true, ports: { "80": { protocol: "http" }, "443": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/no other port may be numbered 80 or 443/);
  // Not only a public-service problem: the sole HTTP port of a PRIVATE service
  // is the holder too, so a raw TCP 443 beside it collides just as hard.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "8080": { protocol: "http" }, "443": { protocol: "tcp" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/no other port may be numbered 80 or 443/);
  // The holder being 80 or 443 itself is fine — it is the one that owns them.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", public: true, ports: { "80": { protocol: "http" }, "3000": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  // Two HTTP ports on a private service leave no holder at all, so nothing is reserved.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "80": { protocol: "http" }, "443": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema refuses a public service the runtime could not serve", async ({ expect }) => {
  // Raw TCP carries no SNI or Host, so a shared public address cannot tell which
  // service a connection is for — VERIFIED against real Fly.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", public: true, ports: { "5432": { protocol: "tcp" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/may not declare a "tcp" port/);
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", public: true, ports: { "3000": { protocol: "http" }, "5432": { protocol: "tcp" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/may not declare a "tcp" port/);
  // A PRIVATE service may declare TCP freely — only public ingress is the problem.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" }, "5432": { protocol: "tcp" } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  // Public ingress with nothing behind it. Unrepresentable while the flag lived
  // on a port; refused now that it lives on the service.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", public: true, ports: {}, env: {},
  }, { abortEarly: false })).rejects.toThrow(/must declare at least one port/);
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: {}, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema rejects port sets it could not serve", async ({ expect }) => {
  // A duplicate port needs no rule of its own here: an object cannot hold one
  // key twice, and the canonical-spelling rule rules out the numeric aliases.
  await expect(deploymentServiceDefinitionSchema.validate({ type: "serverless", ports: { "0": { protocol: "http" } }, env: {} })).rejects.toThrow();
  await expect(deploymentServiceDefinitionSchema.validate({ type: "serverless", ports: { "70000": { protocol: "http" } }, env: {} })).rejects.toThrow();
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: Object.fromEntries(Array.from({ length: MAX_PORTS_PER_SERVICE + 1 }, (_, index) => [String(3000 + index), { protocol: "http" }])), env: {},
  }, { abortEarly: false })).rejects.toThrow(/at most/);
});

import.meta.vitest?.test("port helpers agree with what the schema allows", ({ expect }) => {
  const mixed: DeploymentPorts = { "3000": { protocol: "http" }, "5432": { protocol: "tcp" } };
  // The holder of a PRIVATE service is its sole HTTP port; the TCP sibling does
  // not make it ambiguous.
  expect(standardPortsHolderPort(mixed, false)).toBe(3000);
  // The holder of a PUBLIC service is its LOWEST port, by number and not by key
  // order — so "443" wins over "8443" however the record was written.
  const twoPorts: DeploymentPorts = { "8443": { protocol: "http" }, "443": { protocol: "http" } };
  expect(standardPortsHolderPort(twoPorts, true)).toBe(443);
  expect(deploymentPortOwnsStandardPorts(twoPorts, true, 443)).toBe(true);
  expect(deploymentPortOwnsStandardPorts(twoPorts, true, 8443)).toBe(false);
  // The same set on a PRIVATE service has no holder at all: two HTTP ports leave
  // nothing for a certificate to terminate on.
  expect(standardPortsHolderPort(twoPorts, false)).toBe(null);
  // A lone port is always the holder.
  expect(deploymentPortOwnsStandardPorts({ "3000": { protocol: "http" } }, true, 3000)).toBe(true);
  // Ambiguous references resolve to null so each layer can phrase its own error.
  // url only counts HTTP ports, so the TCP sibling does not make it ambiguous.
  expect(soleHttpDeploymentPort(mixed)).toBe(3000);
  expect(soleHttpDeploymentPort({ "3000": { protocol: "http" }, "4000": { protocol: "http" } })).toBe(null);
  expect(portProtocol({ protocol: "http" })).toBe("http");
  expect(portProtocol({ protocol: "tcp" })).toBe("tcp");
  // Ascending by port NUMBER, not by key order — "80" must not sort after "8080".
  expect(deploymentPortEntries({ "8080": { protocol: "http" }, "80": { protocol: "http" } })).toEqual([
    { port: 80, protocol: "http" },
    { port: 8080, protocol: "http" },
  ]);
  // A hand-edited row with a key that is not a port is skipped, not thrown on:
  // this runs on stored rows, and one bad entry must not take down a listing.
  expect(deploymentPortEntries({ web: { protocol: "http" }, "3000": { protocol: "http" } })).toEqual([{ port: 3000, protocol: "http" }]);
  expect(deploymentPortEntry({ "3000": { protocol: "tcp" } }, 3000)?.protocol).toBe("tcp");
  expect(deploymentPortEntry({ "3000": { protocol: "http" } }, 4000)).toBe(null);
});

import.meta.vitest?.test("connection references round-trip, with and without a port", ({ expect }) => {
  expect(parseConnectionValue("api.url")).toEqual({ serviceId: "api", outputKey: "url", port: null });
  expect(parseConnectionValue("api.url:9090")).toEqual({ serviceId: "api", outputKey: "url", port: 9090 });
  // Service ids may contain hyphens; output keys may not contain dots or colons.
  expect(parseConnectionValue("my-api.hostname")).toEqual({ serviceId: "my-api", outputKey: "hostname", port: null });
  expect(parseConnectionValue("hexclave.projectId")).toEqual({ serviceId: "hexclave", outputKey: "projectId", port: null });
  expect(parseConnectionValue("api")).toBe(null);
  expect(parseConnectionValue("api.url:")).toBe(null);
  expect(parseConnectionValue("api.url:123456")).toBe(null);
  expect(formatConnectionValue("api", "url")).toBe("api.url");
  expect(formatConnectionValue("api", "url", 9090)).toBe("api.url:9090");
  for (const value of ["api.url", "api.url:9090", "api.hostname", "hexclave.projectId"]) {
    const parsed = parseConnectionValue(value)!;
    expect(formatConnectionValue(parsed.serviceId, parsed.outputKey, parsed.port)).toBe(value);
  }
});

import.meta.vitest?.test("which references wait for their target depends on the runtime", ({ expect }) => {
  // Fly: a private port's URL is as deterministic as the hostname it is built from.
  expect(connectionRequiresTargetDeployed("fly", "url", 5432, false)).toBe(false);
  expect(connectionRequiresTargetDeployed("fly", "url", 3000, true)).toBe(true);
  // Unknown publicness (a target this deploy file cannot see) waits.
  expect(connectionRequiresTargetDeployed("fly", "url", 3000, null)).toBe(true);
  // A bare url() has to read the target's ports to know which one it means.
  expect(connectionRequiresTargetDeployed("fly", "url", null, false)).toBe(true);
  expect(connectionRequiresTargetDeployed("fly", "hostname", null, null)).toBe(false);
  // GCP: every service output is the target's runtime address, and nothing
  // publishes one before the target exists.
  expect(connectionRequiresTargetDeployed("gcp", "url", 5432, false)).toBe(true);
  expect(connectionRequiresTargetDeployed("gcp", "hostname", null, null)).toBe(true);
  // The managed service is not deployed by anyone, so its outputs never wait.
  expect(connectionRequiresTargetDeployed("fly", "projectId", null, null)).toBe(false);
  expect(connectionRequiresTargetDeployed("gcp", "projectId", null, null)).toBe(false);
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema accepts a persistent volume on a server service", async ({ expect }) => {
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, persistent_volumes: { data: { path: "/data", size_gb: 10 } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  // Spelling out the implied 0/1 bounds is allowed; anything else is not.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, min_instances: 0, max_instances: 1,
    persistent_volumes: { app_state: { path: "/var/lib/app/data", size_gb: 1 } }, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  // An empty record is the same as having no volume, and stays valid on a
  // serverless service — otherwise `persistent_volumes: {}` written out by a
  // serializer would fail a config that declares no disks at all.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, persistent_volumes: {}, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema pins a server service to a single instance", async ({ expect }) => {
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, max_instances: 2, env: {},
  }, { abortEarly: false })).rejects.toThrow(/max_instances must be 1/);
  // 0 and 1 are the only meanings a single instance can have; anything above
  // is a fleet, which "server" is not.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, min_instances: 1, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, min_instances: 0, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, min_instances: 2, env: {},
  }, { abortEarly: false })).rejects.toThrow(/min_instances must be 0 or 1/);
  // Serverless keeps the full range.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, min_instances: 1, max_instances: 10, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema rejects persistent volumes that cannot work", async ({ expect }) => {
  // A serverless fleet cannot share one disk, whatever its bounds are.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, persistent_volumes: { data: { path: "/data", size_gb: 1 } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/only a "server" service may have persistent volumes/);
  // More than one disk on one machine is beyond what Fly can mount today, and
  // must fail loudly rather than silently mounting whichever came first.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "server", ports: { "3000": { protocol: "http" } }, env: {},
    persistent_volumes: { data: { path: "/data", size_gb: 1 }, cache: { path: "/cache", size_gb: 1 } },
  }, { abortEarly: false })).rejects.toThrow(/at most 1 persistent volume/);
  for (const badId of ["Data", "1data", "my-volume", "_data", "x".repeat(MAX_VOLUME_ID_LENGTH + 1)]) {
    await expect(deploymentServiceDefinitionSchema.validate({
      type: "server", ports: { "3000": { protocol: "http" } }, persistent_volumes: { [badId]: { path: "/data", size_gb: 1 } }, env: {},
    }, { abortEarly: false }), `volume id ${JSON.stringify(badId)}`).rejects.toThrow();
  }
  for (const badPath of ["data", "/", "/data/", "/data/../etc", "/data/./x", "/da\\ta", "/da\u0000ta"]) {
    await expect(deploymentServiceDefinitionSchema.validate({
      type: "server", ports: { "3000": { protocol: "http" } }, persistent_volumes: { data: { path: badPath, size_gb: 1 } }, env: {},
    }, { abortEarly: false })).rejects.toThrow(/normalized absolute path/);
  }
  // Anchored to the size field: a bare toThrow() would still pass if the size
  // bounds regressed and some unrelated rule happened to reject the shape.
  for (const badSize of [0, -1, 501, 1.5]) {
    await expect(deploymentServiceDefinitionSchema.validate({
      type: "server", ports: { "3000": { protocol: "http" } }, persistent_volumes: { data: { path: "/data", size_gb: badSize } }, env: {},
    }, { abortEarly: false })).rejects.toThrow(/size_gb/);
  }
});

import.meta.vitest?.test("deploymentServiceDefinitionSchema rejects invalid shapes", async ({ expect }) => {
  // A secret with an inline value would defeat the whole point of secrets.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, env: { A: { type: "secret", key: "a", value: "leaked" } },
  }, { abortEarly: false })).rejects.toThrow(/must not have a value/);
  // A secret without a key can never be filled at deploy time.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, env: { A: { type: "secret" } },
  }, { abortEarly: false })).rejects.toThrow(/key/);
  // Plain values may not carry a secret key.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, env: { A: { value: "x", key: "a" } },
  }, { abortEarly: false })).rejects.toThrow(/only have a key/);
  // Connections must point at `<serviceId>.<outputKey>`.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, env: { A: { type: "connection", value: "{hexclave.projectId}" } },
  }, { abortEarly: false })).rejects.toThrow(/service output/);
  // Env var keys must be valid POSIX-ish env var names.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, env: { "1BAD": { value: "x" } },
  }, { abortEarly: false })).rejects.toThrow(/env var keys/);
  // The service type is required.
  await expect(deploymentServiceDefinitionSchema.validate({
    ports: { "3000": { protocol: "http" } }, env: {},
  }, { abortEarly: false })).rejects.toThrow(/type/);
  // Ports are required — there is no sensible default to guess.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", env: {},
  }, { abortEarly: false })).rejects.toThrow(/ports/);
  // Scaling bounds must be consistent when both are given.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, min_instances: 3, max_instances: 1, env: {},
  }, { abortEarly: false })).rejects.toThrow(/greater than or equal to min_instances/);
  // min_instances alone is accepted — max defaults up to min so the spec stays consistent
  // (this is the case that previously slipped through validation and 400'd from the runtime).
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, min_instances: 2, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  // Both bounds are capped at MAX_INSTANCES_PER_SERVICE, and the cap itself is
  // accepted — an off-by-one here would refuse the largest legal fleet.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, min_instances: MAX_INSTANCES_PER_SERVICE, max_instances: MAX_INSTANCES_PER_SERVICE, env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, min_instances: MAX_INSTANCES_PER_SERVICE + 1, env: {},
  }, { abortEarly: false })).rejects.toThrow(/min_instances/);
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, max_instances: MAX_INSTANCES_PER_SERVICE + 1, env: {},
  }, { abortEarly: false })).rejects.toThrow(/max_instances/);
  // dockerfile_path must be a normalized relative path inside the packaged
  // source — mirror of Marshal's validateServiceSpec, checked here so invalid
  // values fail at sync time instead of after an upload is consumed.
  for (const invalidDockerfilePath of [
    "../Dockerfile", "/etc/Dockerfile", ".", "./Dockerfile", "a//b",
    "docker\\Dockerfile", "Dock\terfile", "x".repeat(513),
  ]) {
    await expect(deploymentServiceDefinitionSchema.validate({
      type: "serverless", ports: { "3000": { protocol: "http" } }, dockerfile_path: invalidDockerfilePath, env: {},
    }, { abortEarly: false })).rejects.toThrow(/dockerfile_path/);
  }
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, dockerfile_path: "docker/Dockerfile.web", env: {},
  }, { abortEarly: false })).resolves.toBeDefined();
});

import.meta.vitest?.test("a service's dev command is not part of its definition", async ({ expect }) => {
  // The dev command never leaves the deploy file (see the schema comment), so
  // a client sending one is out of date rather than merely verbose — say so
  // instead of dropping the field on the floor.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless", ports: { "3000": { protocol: "http" } }, dev_command: "pnpm dev", env: {},
  }, { abortEarly: false })).rejects.toThrow(/must not carry a dev_command/);
});

import.meta.vitest?.test("a secret's default value is not part of its definition", async ({ expect }) => {
  // The invariant behind the dashboard's secrets page: a definition can only
  // ever say WHICH secret an env var needs, never what it falls back to. If a
  // default could be stored, "is this secret set?" would stop having a single
  // answer, which is exactly the three-way badge state this replaced.
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless",
    ports: { "3000": { protocol: "http" } },
    env: { OPENAI_API_KEY: { type: "secret", key: "OPENAI", default_value: "sk-dev" } },
  }, { abortEarly: false })).rejects.toThrow(/must not carry a default_value/);
  await expect(deploymentServiceDefinitionSchema.validate({
    type: "serverless",
    ports: { "3000": { protocol: "http" } },
    env: { PLAIN: { value: "x", default_value: "y" } },
  }, { abortEarly: false })).rejects.toThrow(/must not carry a default_value/);
});

import.meta.vitest?.test("deploymentSecretDefaultsSchema accepts env-var-keyed defaults", async ({ expect }) => {
  await expect(deploymentSecretDefaultsSchema.validate({
    OPENAI_API_KEY: "sk-dev",
    // An empty default is meaningful — it means "deploy with this var empty",
    // which is different from having no default at all.
    OPTIONAL_FLAG: "",
  }, { abortEarly: false })).resolves.toEqual({ OPENAI_API_KEY: "sk-dev", OPTIONAL_FLAG: "" });
  await expect(deploymentSecretDefaultsSchema.validate({
    "1BAD": "x",
  }, { abortEarly: false })).rejects.toThrow(/env var keys/);
});

import.meta.vitest?.test("deploymentCiEnvSchema only accepts CI variable names", async ({ expect }) => {
  await expect(deploymentCiEnvSchema.validate({
    CI_COMMIT_SHA: "abc123",
    CI_COMMIT_SHORT_SHA: "abc123de",
  }, { abortEarly: false })).resolves.toEqual({ CI_COMMIT_SHA: "abc123", CI_COMMIT_SHORT_SHA: "abc123de" });
  // The whole point of the namespace: a deploy cannot reach the injected
  // credentials (or anything else the definition owns) through this field.
  await expect(deploymentCiEnvSchema.validate({
    HEXCLAVE_SECRET_SERVER_KEY: "ssk_evil",
  }, { abortEarly: false })).rejects.toThrow(/CI variable names/);
  await expect(deploymentCiEnvSchema.validate({
    CI_lowercase: "x",
  }, { abortEarly: false })).rejects.toThrow(/CI variable names/);
  // Bare CI is excluded on purpose: it is the runtime's to set for the build,
  // and accepting it here would let a caller send CI=false to switch that off.
  await expect(deploymentCiEnvSchema.validate({
    CI: "false",
  }, { abortEarly: false })).rejects.toThrow(/CI variable names/);
});

import.meta.vitest?.test("deploymentCiEnvSchema bounds the whole field", async ({ expect }) => {
  await expect(deploymentCiEnvSchema.validate({
    CI_COMMIT_MESSAGE: "x".repeat(MAX_DEPLOYMENT_CI_ENV_BYTES),
  }, { abortEarly: false })).rejects.toThrow(/at most/);
  // Measured across every entry, not per value: many small vars must not add up
  // to more than one large one is allowed to be.
  await expect(deploymentCiEnvSchema.validate(
    Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`CI_VAR_${index}`, "x".repeat(500)])),
    { abortEarly: false },
  )).rejects.toThrow(/at most/);
});

// Type-level check that the yup schema stays assignable to the hand-written
// definition type (yup's InferType makes optional fields `| undefined`, which
// matches under exactOptionalPropertyTypes only if the shapes agree).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertEnvVarSchemaMatchesType: DeploymentEnvVarDefinition = undefined as unknown as yup.InferType<typeof deploymentEnvVarSchema>;

import.meta.vitest?.test("buildSourceManifest keeps the LARGEST files when it has to drop some", ({ expect }) => {
  // Largest-first is the whole point of the cap: the question a manifest answers
  // is which files are big, so truncation must only ever drop ones too small to
  // be anyone's problem.
  const files = Array.from({ length: MAX_SOURCE_MANIFEST_ENTRIES + 50 }, (_, index) => ({ path: `f${index}.bin`, bytes: index }));
  const manifest = buildSourceManifest({ files, compressedBytes: 1234 });
  expect(manifest.file_count).toBe(files.length);
  expect(manifest.entries).toHaveLength(MAX_SOURCE_MANIFEST_ENTRIES);
  expect(manifest.entries[0]).toEqual({ path: `f${files.length - 1}.bin`, bytes: files.length - 1 });
  // The totals cover every file, including the ones with no room in `entries`.
  expect(manifest.total_bytes).toBe(files.reduce((total, file) => total + file.bytes, 0));
  expect(manifest.compressed_bytes).toBe(1234);
});

import.meta.vitest?.test("buildSourceManifest is deterministic when sizes tie", ({ expect }) => {
  // Two deploys of one tree must produce the same listing, or a diff of them is
  // noise. Ties break on path.
  const files = [{ path: "b.txt", bytes: 10 }, { path: "a.txt", bytes: 10 }, { path: "c.txt", bytes: 99 }];
  expect(buildSourceManifest({ files, compressedBytes: 1 }).entries.map((entry) => entry.path))
    .toEqual(["c.txt", "a.txt", "b.txt"]);
});

import.meta.vitest?.test("parseSourceManifest refuses anything that is not one", ({ expect }) => {
  // It is read out of a JSON column, so it degrades to "no manifest" rather than
  // breaking the deployment it belongs to.
  expect(parseSourceManifest(null)).toBeNull();
  expect(parseSourceManifest(undefined)).toBeNull();
  expect(parseSourceManifest("{}")).toBeNull();
  expect(parseSourceManifest([])).toBeNull();
  expect(parseSourceManifest({ file_count: 1, total_bytes: 2 })).toBeNull();
  expect(parseSourceManifest({ file_count: 1, total_bytes: 2, compressed_bytes: 3 })).toBeNull();
});

import.meta.vitest?.test("parseSourceManifest drops malformed entries but keeps the manifest", ({ expect }) => {
  const parsed = parseSourceManifest({
    file_count: 3,
    total_bytes: 30,
    compressed_bytes: 10,
    entries: [{ path: "a", bytes: 20 }, { path: "b" }, { bytes: 5 }, null, { path: "c", bytes: "big" }],
  });
  expect(parsed?.entries).toEqual([{ path: "a", bytes: 20 }]);
  // The totals are the manifest's own claim and survive a bad entry.
  expect(parsed?.file_count).toBe(3);
});

import.meta.vitest?.test("sourceManifestEntriesForService slices the shared upload by root directory", ({ expect }) => {
  const manifest = buildSourceManifest({
    files: [
      { path: "web/app/page.tsx", bytes: 100 },
      { path: "web/public/hero.png", bytes: 900 },
      { path: "api/main.go", bytes: 400 },
      { path: "README.md", bytes: 10 },
    ],
    compressedBytes: 500,
  });
  expect(sourceManifestEntriesForService(manifest, "web").entries.map((entry) => entry.path))
    .toEqual(["web/public/hero.png", "web/app/page.tsx"]);
  // The authored spellings of "the whole tree" all mean the whole tree.
  for (const root of [null, ".", "./", ""]) {
    expect(sourceManifestEntriesForService(manifest, root).entries).toHaveLength(4);
  }
  // "./web/" is the same subtree as "web".
  expect(sourceManifestEntriesForService(manifest, "./web/").entries).toHaveLength(2);
  // A prefix must match a whole path SEGMENT: "web" is not "website".
  expect(sourceManifestEntriesForService(manifest, "webs").entries).toHaveLength(0);
  // The prefix it filtered on comes back, so a caller showing paths relative to
  // the service strips exactly what was matched.
  expect(sourceManifestEntriesForService(manifest, "./web/").prefix).toBe("web/");
  for (const root of [null, ".", "./", ""]) {
    expect(sourceManifestEntriesForService(manifest, root).prefix).toBe("");
  }
});

import.meta.vitest?.test("sourceManifestEntriesForService reports truncation as the manifest's, not the slice's", ({ expect }) => {
  // Once the cap dropped files, no subtree can claim to be a complete listing —
  // the dropped ones could have been anywhere.
  const files = Array.from({ length: MAX_SOURCE_MANIFEST_ENTRIES + 1 }, (_, index) => ({ path: `web/f${index}.bin`, bytes: index + 1 }));
  const manifest = buildSourceManifest({ files, compressedBytes: 1 });
  expect(sourceManifestEntriesForService(manifest, "web").truncated).toBe(true);
  const small = buildSourceManifest({ files: [{ path: "web/a", bytes: 1 }], compressedBytes: 1 });
  expect(sourceManifestEntriesForService(small, "web").truncated).toBe(false);
});

import.meta.vitest?.test("parseSourceManifest bounds path length, which the CLI-side cap does not", ({ expect }) => {
  // REGRESSION: MAX_SOURCE_MANIFEST_PATH_LENGTH was applied only in
  // buildSourceManifest — the CLI. This is the function the server gates writes
  // with, so an API client could store 2000 entries of arbitrarily long paths in
  // a JSON column that nothing prunes.
  const long = "a".repeat(MAX_SOURCE_MANIFEST_PATH_LENGTH + 1);
  const parsed = parseSourceManifest({
    file_count: 2, total_bytes: 2, compressed_bytes: 1,
    entries: [{ path: long, bytes: 1 }, { path: "ok.txt", bytes: 1 }],
  });
  expect(parsed?.entries).toEqual([{ path: "ok.txt", bytes: 1 }]);
});

import.meta.vitest?.test("parseSourceManifest re-establishes largest-first order", ({ expect }) => {
  // The dashboard states "largest first" and "the rest are smaller than every
  // file shown" — claims about order, on data that arrived from a client.
  const parsed = parseSourceManifest({
    file_count: 3, total_bytes: 60, compressed_bytes: 20,
    entries: [{ path: "a", bytes: 10 }, { path: "b", bytes: 50 }, { path: "c", bytes: 1 }],
  });
  expect(parsed?.entries.map((entry) => entry.bytes)).toEqual([50, 10, 1]);
});

import.meta.vitest?.test("parseSourceManifest keeps the LARGEST when a client overflows the cap", ({ expect }) => {
  // Sorting has to happen before the slice, or the cap would keep whichever
  // entries the client happened to send first.
  const entries = Array.from({ length: MAX_SOURCE_MANIFEST_ENTRIES + 10 }, (_, index) => ({ path: `f${index}`, bytes: index }));
  const parsed = parseSourceManifest({ file_count: entries.length, total_bytes: 1, compressed_bytes: 1, entries });
  expect(parsed?.entries).toHaveLength(MAX_SOURCE_MANIFEST_ENTRIES);
  expect(parsed?.entries[0]?.bytes).toBe(entries.length - 1);
});

import.meta.vitest?.test("parseSourceManifest drops duplicate paths, which the dashboard keys on", ({ expect }) => {
  const parsed = parseSourceManifest({
    file_count: 2, total_bytes: 3, compressed_bytes: 1,
    entries: [{ path: "dup", bytes: 2 }, { path: "dup", bytes: 1 }],
  });
  expect(parsed?.entries).toEqual([{ path: "dup", bytes: 2 }]);
});

import.meta.vitest?.test("parseSourceManifest refuses negative and fractional totals", ({ expect }) => {
  // They render as facts about the deploy: "-1 B on disk" is not one.
  expect(parseSourceManifest({ file_count: 1, total_bytes: -1, compressed_bytes: 1, entries: [] })).toBeNull();
  expect(parseSourceManifest({ file_count: 1.5, total_bytes: 1, compressed_bytes: 1, entries: [] })).toBeNull();
  const parsed = parseSourceManifest({
    file_count: 1, total_bytes: 1, compressed_bytes: 1,
    entries: [{ path: "a", bytes: -5 }, { path: "b", bytes: 1.5 }, { path: "c", bytes: 1 }],
  });
  expect(parsed?.entries).toEqual([{ path: "c", bytes: 1 }]);
});
