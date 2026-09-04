import type { BranchConfigNormalizedOverride } from "./config/schema";

type StackConfigObject = BranchConfigNormalizedOverride;
export const showOnboardingHexclaveConfigValue = "show-onboarding";
/** @deprecated Use `HexclaveConfig` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export type StackConfig = StackConfigObject | typeof showOnboardingHexclaveConfigValue;

// Hexclave alias — same shape, declared separately so it doesn't inherit the deprecation tag.
export type HexclaveConfig = StackConfigObject | typeof showOnboardingHexclaveConfigValue;

type StrictConfigShape<Actual, Expected> =
  Expected extends readonly unknown[]
      ? Actual extends readonly unknown[]
      ? { [K in keyof Actual]: K extends keyof Expected ? StrictConfigShape<Actual[K], Expected[K]> : never }
        : Actual
    : Expected extends object
        ? Actual extends object
        ? Exclude<keyof Actual, keyof Expected> extends never
          ? { [K in keyof Actual]: K extends keyof Expected ? StrictConfigShape<Actual[K], Expected[K]> : never }
            : never
          : Actual
        : Actual;

type StrictStackConfig<T extends StackConfig> =
  T extends StackConfigObject
    ? T & StrictConfigShape<T, StackConfigObject>
    : T;

/** @deprecated Use `defineHexclaveConfig` from the `@hexclave/*` package instead — same symbol, new brand name. See https://docs.hexclave.com/migration. */
export function defineStackConfig(config: StrictStackConfig<StackConfig>): StackConfig {
  return config;
}

/**
 * Defines a Hexclave project configuration as code. See the documentation at https://skill.hexclave.com for more information.
 */
export function defineHexclaveConfig(config: StrictStackConfig<HexclaveConfig>): HexclaveConfig {
  return config;
}

// ============================ deployments ============================
// The author-facing shape of the deploy file's `deploy` export. These types
// are camelCase and deliberately NOT the wire shape in ./deployments (which is
// snake_case): the CLI evaluates this, validates it with precise per-field
// errors, and serializes it. They exist so `export const deploy:
// HexclaveDeploymentConfig = { ... }` gets completion and catches typos in the
// editor — the CLI still re-validates everything at runtime, because the deploy
// file is arbitrary user TypeScript that may not be typechecked at all.

/** The value of one env var: a literal, `null` to omit it, or a reference from the context object. */
export type HexclaveEnvVarValue = string | null | undefined | HexclaveDeploymentReference;

/**
 * An opaque reference produced by `secret()`, `service(...).<output>`, or
 * `hexclave.<output>`. It has no usable members: references must be assigned as
 * the WHOLE value of an env var, never interpolated into a string.
 */
// Not exported: it has no runtime value, so exporting it would put a name in the
// package's declarations that resolves to nothing at run time (`undefined` under
// CJS, a link error under ESM). The alias below is what consumers use.
declare const hexclaveDeploymentReference: unique symbol;
export type HexclaveDeploymentReference = { readonly [hexclaveDeploymentReference]: true };

/** The outputs another service exposes to `service("id").<output>`. */
export type HexclaveServiceOutputs = {
  /**
   * The URL of one of the service's ports, with the scheme taken from that
   * port's `protocol` — a URL names ONE port, which is why this is a call.
   *
   * `url()` requires the target to declare exactly one HTTP port; `url(9090)`
   * names one when it declares several. A PUBLIC service resolves to its public
   * URL (its platform URL, or a verified custom domain); a private one resolves
   * to its internal address.
   */
  url: (port?: number) => HexclaveDeploymentReference,
  /**
   * The service's private-network hostname, without a port. Always available,
   * including before the target has ever been deployed.
   *
   * There is deliberately no port output: its value is a number you already
   * wrote in the target's `ports`, so pair this with a literal (e.g.
   * `DATABASE_PORT: "5432"`) for raw TCP clients.
   */
  hostname: () => HexclaveDeploymentReference,
};

/** The context object passed to the `services` function. */
export type HexclaveDeploymentContext = {
  /** True during `hexclave dev`. Guard connection values with it — `service()` returns null there. */
  isDev: boolean,
  /**
   * References a project secret by key. Values are set per project under
   * Project Settings → Secrets and resolved server-side at deploy time.
   *
   * The optional default is NOT dev-only. It is never stored server-side, but it
   * travels with each deploy request and fills the secret whenever the project
   * has no stored value for that key — on production deploys as well as
   * `hexclave dev`. A key with a default is also excluded from the preflight
   * that fails a deploy on missing secrets, since it can always be satisfied.
   * Treat anything you pass here as a value you are willing to ship: to force a
   * real secret to be set, omit the default.
   */
  secret: (key: string, defaultValue?: string) => HexclaveDeploymentReference,
  /**
   * References another service of this PROJECT — service ids are unique across
   * every deployment source, so a service deployed from another repository is
   * referenced exactly like one next door. Returns null during `hexclave dev`.
   */
  service: (serviceId: string) => HexclaveServiceOutputs,
  /** The managed Hexclave backend's outputs. */
  hexclave: {
    projectId: HexclaveDeploymentReference,
    apiUrl: HexclaveDeploymentReference,
    jwksUrl: HexclaveDeploymentReference,
    publishableClientKey: HexclaveDeploymentReference,
    secretServerKey: HexclaveDeploymentReference,
  },
};

/** One persistent disk. `sizeGb` can be grown on a later deploy but never shrunk. */
export type HexclavePersistentVolume = {
  /** Absolute, normalized mount point inside the container, e.g. "/data". */
  path: string,
  /** Provisioned size in whole gigabytes (1–500). */
  sizeGb: number,
};

/** How one port the container listens on is exposed. */
export type HexclavePort = {
  /**
   * "http" serves an HTTP endpoint. "tcp" is a raw port, for databases and
   * other daemons. Only a PRIVATE service may declare TCP — a shared public
   * address tells services apart by SNI or Host, and a raw TCP stream carries
   * neither. Reach TCP ports with `hostname()` and the port number.
   */
  protocol: "http" | "tcp",
};

type HexclaveServiceBase = {
  /**
   * Exposes the service to the internet and gives it a platform URL, even
   * without a custom domain. Defaults to false — services are private and reach
   * each other over the project's internal network.
   *
   * It belongs to the SERVICE rather than to a port because the runtime cannot
   * make it anything else: Fly's proxy serves every declared port on every
   * address the app holds, so the moment one port is public they all are.
   *
   * A public service must therefore be all-HTTP and declare at least one port.
   */
  public?: boolean,
  /**
   * The ports the container listens on, keyed by port number:
   * `ports: { 3000: { protocol: "http" }, 5432: { protocol: "tcp" } }`. Whether they are reachable
   * from the internet is the SERVICE's `public`, not a per-port flag.
   *
   * Each port is reachable at its own number; the standard-ports holder (the
   * lowest port of a public service, or the sole HTTP port of a private one) is
   * additionally served on 80/443. Note that a URL names a single port, so a
   * service with several needs `url(9090)` rather than a bare `url()`.
   *
   * Use `ports: {}` for a worker that only makes outbound connections. It gets
   * no URL and can hold no custom domain, and since the platform only wakes a
   * stopped machine on inbound traffic, it should be `type: "server"` (or a
   * "serverless" with `minInstances` above zero) or it will never run.
   */
  ports: Record<number, HexclavePort>,
  /** Run locally by `hexclave dev --service-id`. Never sent to the server. */
  devCommand?: string,
  /**
   * A single command line, run through `sh -c` while your image is BUILT — e.g.
   * `"pnpm install --frozen-lockfile && pnpm build"`. Chain steps with `&&`; it
   * is one command, not a script.
   *
   * What it builds ON depends on the rest of the service:
   * - no `image` and no `dockerfilePath`: the Hexclave base image (Debian-based,
   *   with node, npm, pnpm, yarn, git and a C toolchain preinstalled). Your whole uploaded source is
   *   copied to `/app`, and the command runs in your `rootDirectory`. This
   *   REPLACES Railpack auto-detection, so nothing is inferred for you — and
   *   `startCommand` becomes required, since that base starts nothing by itself.
   * - `image`: the same, but built on that image instead. Naming a build command
   *   is what turns an image from "the thing to run" into "the thing to build
   *   on", so the service is built and uploaded like any other. Your source is
   *   copied in as root and the command inherits the image's own `USER`, so a
   *   base that defaults to a non-root user needs to be able to write under
   *   `/app` — if it cannot, use a Dockerfile, where you control both.
   * - `dockerfilePath`: appended to your Dockerfile as a final `RUN`. Nothing is
   *   copied in that your Dockerfile did not copy itself.
   *
   * Every env var is available to it, exactly as in a Railpack build.
   */
  buildCommand?: string,
  /**
   * A single command line, run through `sh -c` as the container's process,
   * INSTEAD of whatever the image would have started — e.g. `"node server.js"`.
   *
   * It is applied when the container starts, not baked into the image, so it
   * causes no build: naming one on an `image` service keeps that service's
   * deploy build-less, and changing only this restarts the service without
   * rebuilding it. It replaces the image's entrypoint as well as its command,
   * so it must be the whole way to start the process.
   *
   * On its own it changes nothing about the build: a service with no `image`,
   * `dockerfilePath` or `buildCommand` is still auto-detected by Railpack and
   * simply starts with your command instead of the detected one.
   *
   * Required when a `buildCommand` is used with no `image` and no
   * `dockerfilePath`. Unrelated to `devCommand`, which only ever runs locally.
   */
  startCommand?: string,
  /** Environment variables. Values may be literals, `null` to omit, or references from the context object. */
  env?: Record<string, HexclaveEnvVarValue>,
};

/**
 * What a service's container is BUILT FROM: your own Dockerfile, an image, or
 * neither (Railpack auto-detection, or the Hexclave base image once you write a
 * `buildCommand`).
 *
 * A union rather than independent optional fields, so that naming an image AND a
 * Dockerfile does not compile: each of them says what the build starts from, and
 * a service that gave both would leave the deploy with two answers to one
 * question. (Same reasoning as `public` living on the service rather than the
 * port: make the invalid state unrepresentable instead of validating it after
 * the fact.)
 *
 * `rootDirectory` belongs to neither branch and is legal alongside an image,
 * because a `buildCommand` copies your source onto that image and runs there.
 */
export type HexclaveServiceSource =
  | {
    image?: undefined,
    /** Source directory, relative to the deploy file. Defaults to the deploy file's own directory. */
    rootDirectory?: string,
    /** Dockerfile to build, relative to `rootDirectory`. Omit to auto-detect the build with Railpack. */
    dockerfilePath?: string,
  }
  | {
    /**
     * An image: `"postgres:16"`, `"ghcr.io/org/app:1.2.3"`, or a digest.
     *
     * On its own it is the image to RUN. Nothing is built and nothing is
     * uploaded for the service, so a deploy of it takes seconds — and env vars
     * reach the container at RUNTIME only, so a framework that inlines values
     * while it compiles (`NEXT_PUBLIC_*`) needs a source build instead.
     *
     * With a `buildCommand` it is instead the BASE your service is built on:
     * your source is copied to `/app` and the command runs in your
     * `rootDirectory`. That service is built and uploaded like any other.
     *
     * A tag is resolved when the image is PULLED, by the platform rather than
     * at deploy time. So a tag can name different bytes on machines started at
     * different moments, and a redeploy of an unchanged tag rolls nothing at
     * all — name a digest if a deploy must always run the same bytes. An
     * explicit tag or digest is required either way: a bare `"postgres"` means
     * `:latest`, which can change under you between deploys.
     *
     * Only public registries are supported today.
     */
    image: string,
    /** Where `buildCommand` runs, relative to the deploy file. Only meaningful with one. */
    rootDirectory?: string,
    dockerfilePath?: never,
  };

/**
 * A single always-one-instance service, and the only kind that may hold a
 * persistent volume. Requires a paid plan.
 */
export type HexclaveServerService = HexclaveServiceBase & HexclaveServiceSource & {
  type: "server",
  /**
   * Persistent disks keyed by volume id. At most one is supported today.
   *
   * The id names the disk within this service. Moving it to another service (or
   * renaming this one) does NOT move the data — the new service gets an empty
   * disk and the old one is stranded, detached and still billed. Copy the data
   * out and back if you need to move it.
   */
  persistentVolumes?: Record<string, HexclavePersistentVolume>,
  /**
   * 1 (the default) keeps the single instance up; 0 lets it suspend when idle
   * and resume with its memory intact. Above 0 needs a paid plan.
   */
  minInstances?: 0 | 1,
  /** Always 1 for a server. Use `type: "serverless"` to scale out. */
  maxInstances?: 1,
  /**
   * How much memory the machine gets. Defaults to "512MB".
   *
   * CPU comes with it — you pick memory, the platform picks the matching
   * machine shape: one shared, burstable vCPU up to "2GB", two shared vCPUs at
   * "4GB", and "8GB" is the first size with 2 dedicated cores. A CPU-bound
   * service wants "8GB" even when it fits in less memory.
   *
   * Changing this restarts the machine with the new shape, so the service is
   * briefly unavailable. A persistent volume survives — the disk outlives the
   * machine. Sizes above the default need a paid plan.
   */
  memory?: "512MB" | "1GB" | "2GB" | "4GB" | "8GB",
};

/**
 * A service that scales between `minInstances` and `maxInstances` and STOPS on
 * scale-down, so every start is a cold start. It cannot hold a persistent
 * volume: each instance would get its own separate disk.
 */
export type HexclaveServerlessService = HexclaveServiceBase & HexclaveServiceSource & {
  type: "serverless",
  /** Lower scaling bound, 0–10. Defaults to 0 (scales to zero). Above 0 needs a paid plan. */
  minInstances?: number,
  /** Upper scaling bound, 1–10. Defaults to 1. */
  maxInstances?: number,
  /**
   * How much memory each instance gets. Defaults to "512MB".
   *
   * CPU comes with it: one shared, burstable vCPU up to "2GB", two shared vCPUs
   * at "4GB", and 2 dedicated cores at "8GB". Changing it rolls the machines
   * one at a time. Sizes above the default need a paid plan.
   */
  memory?: "512MB" | "1GB" | "2GB" | "4GB" | "8GB",
};

export type HexclaveService = HexclaveServerService | HexclaveServerlessService;

/**
 * The `deploy` export of a deploy file (hexclave.deploy.ts) — the services
 * deployed together by one `hexclave deploy`.
 *
 * It is a FUNCTION of the deployment context, so it can reach secrets,
 * connections and the managed backend's outputs:
 *
 * ```ts
 * // hexclave.deploy.ts
 * import type { HexclaveDeploymentConfig } from "@hexclave/js";
 *
 * // Identifies this file as a deployment group. Required here, and unique
 * // across every deploy file that deploys into the same project.
 * export const deploymentGroupId = "backend";
 *
 * export const deploy: HexclaveDeploymentConfig = ({ secret, service, hexclave }) => ({
 *   builder: { memory: "32GB" },
 *   services: {
 *     api: {
 *       type: "server",
 *       memory: "4GB",
 *       ports: { 3000: { protocol: "http" } },
 *       persistentVolumes: { uploads: { path: "/data", sizeGb: 10 } },
 *       env: { DB_URL: service("db").url(5432), PROJECT_ID: hexclave.projectId },
 *     },
 *     web: { type: "serverless", public: true, ports: { 3000: { protocol: "http" } }, maxInstances: 3, env: { KEY: secret("API_KEY") } },
 *   },
 * });
 * ```
 *
 * Deployments live in their own file, never in hexclave.config.ts, so that one
 * Hexclave project can be deployed from several repositories, each shipping the
 * services it owns and each deploying on its own schedule — while at most one of
 * them owns the project's configuration.
 */
/**
 * The machine that builds a deployment.
 *
 * One `hexclave deploy` uploads one tree and builds every service of it on ONE
 * machine, so the builder is declared beside `services` rather than inside one:
 * there is a single machine to size, and a per-service setting could only ever
 * be a request that another service's overrode.
 */
export type HexclaveBuilder = {
  /**
   * How much memory the builder gets. Leave it out and the build gets a machine
   * sized for its shape — a larger one when the build is auto-detected (that
   * path unpacks a large base image and holds the whole layer store in memory,
   * and dies at less).
   *
   * Raise it when a build is killed for running out of memory or space — a
   * large monorepo install, or a compiler that wants the whole project in
   * memory at once. It has no effect on what the service runs on; that is the
   * service's own `memory`. Sizes above the default need a paid plan.
   */
  memory?: "8GB" | "16GB" | "32GB",
};

export type HexclaveDeploymentConfig = (context: HexclaveDeploymentContext) => {
  services: Record<string, HexclaveService>,
  builder?: HexclaveBuilder,
};
