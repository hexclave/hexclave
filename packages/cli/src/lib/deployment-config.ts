// Evaluates the `deploy` export of hexclave.deploy.ts.
//
// Deployments live in their OWN file, separate from hexclave.config.ts: one
// Hexclave project can be deployed from several repositories, each shipping the
// services it owns, and each of those repositories has a deploy file of its own
// while only one of them (if any) owns the project's configuration.
//
// The export is a FUNCTION of the deployment context returning `{ services }`.
// The context is where `secret()`, `service()` and `hexclave.*` come from.
//
// The file's `deploymentGroupId` export names the DEPLOYMENT GROUP: which deploy
// file (and so which repository) these services belong to. Service ids stay
// unique across the whole project, so a reference never names a group. (The
// wire format and the dashboard still call a group a deployment SOURCE; the
// export was renamed, the concept is the same one.)
//
//   export const deploymentGroupId = "my-app";
//
//   export const deploy: HexclaveDeploymentConfig = ({ isDev, secret, service, hexclave }) => ({
//     services: {
//       frontend: {
//         type: "serverless",
//         public: true,
//         ports: { 3000: { protocol: "http" } },
//         maxInstances: 3,
//         devCommand: "pnpm dev",
//         env: {
//           DB_URL: service("database").url(5432),
//           OPENAI: isDev ? null : secret("OPENAI_API_KEY", "some-default"),
//           PROJECT_ID: hexclave.projectId,
//         },
//       },
//       database: {
//         type: "server",
//         ports: { 5432: { protocol: "tcp" } },
//         persistentVolumes: { pgdata: { path: "/var/lib/postgresql/data", sizeGb: 10 } },
//       },
//     },
//   });
//
// `secret()`, `service()` and `hexclave.*` return SENTINEL objects (in deploy
// mode) that this module serializes into the wire-shape definitions the
// backend stores — the function itself never sees real secret or connection
// values. In dev mode (`hexclave dev --service-id ...`) the context behaves
// differently: `secret()` resolves to its default value (secrets are never
// fetched during dev), `service()` returns null (guard connection values with
// `isDev`), and `hexclave.*` resolves from the development-environment
// session's credentials.
//
// Everything here is validated at runtime with precise errors rather than
// through a typed wrapper: the deploy file is arbitrary user TypeScript loaded
// via jiti, so compile-time checking of service ids can't be enforced from our
// side anyway.

import {
  DEPLOYMENT_ENV_VAR_KEY_REGEX,
  DEPLOYMENT_SERVICE_TYPES,
  DEPLOYMENT_VOLUME_ID_REGEX,
  HEXCLAVE_OUTPUT_KEYS,
  HEXCLAVE_SERVICE_ID,
  DEPLOYMENT_SOURCE_ID_REGEX,
  MAX_DEPLOYMENT_COMMAND_LENGTH,
  MAX_DEPLOYMENT_SOURCE_ID_LENGTH,
  MAX_INSTANCES_PER_SERVICE,
  MAX_PERSISTENT_VOLUMES_PER_SERVICE,
  MAX_PORTS_PER_SERVICE,
  MAX_VOLUME_ID_LENGTH,
  MAX_VOLUME_SIZE_GB,
  MIN_VOLUME_SIZE_GB,
  SERVICE_OUTPUT_KEYS,
  connectionRequiresTargetDeployed,
  deploymentServiceIsBuilt,
  formatConnectionValue,
  isValidDeploymentCommand,
  parseConnectionValue,
  parseDeploymentImageRef,
  DEPLOYMENT_PORT_KEY_REGEX,
  deploymentPortEntries,
  reservedStandardPortConflicts,
  standardPortsHolderPort,
  type DeploymentEnvVarDefinition,
  type DeploymentPorts,
  type DeploymentServiceDefinition,
  type DeploymentServiceType,
  type DeploymentVolumeDefinition,
  type HexclaveOutputKey,
} from "@hexclave/shared/dist/deployments";
import { PROJECT_SECRET_KEY_REGEX } from "@hexclave/shared/dist/project-secrets";
import fs from "node:fs";
import path from "node:path";
import { CliError, errorMessage } from "./errors.js";

// The names checked (in order) when --deploy-file is not passed.
export const DEPLOY_FILE_CANDIDATES = ["hexclave.deploy.ts", "hexclave.deploy.js"];

/** Whether `cwd` contains a deploy file at all. */
export function hasDeployFile(cwd: string): boolean {
  return DEPLOY_FILE_CANDIDATES.some((candidate) => {
    const resolved = path.resolve(cwd, candidate);
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  });
}

/**
 * Resolves the deploy file path: --deploy-file wins (and must exist); otherwise
 * the first existing candidate in `cwd`. A deploy file is REQUIRED — service
 * definitions only exist in its `deploy` export.
 */
export function resolveDeployFilePath(deployFileOption: string | undefined, cwd: string): string {
  if (deployFileOption != null && deployFileOption !== "") {
    const resolved = path.resolve(cwd, deployFileOption);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new CliError(`Deploy file not found: ${resolved}`);
    }
    return resolved;
  }
  for (const candidate of DEPLOY_FILE_CANDIDATES) {
    const resolved = path.resolve(cwd, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  throw new CliError(`No deploy file found in ${cwd}. \`hexclave deploy\` deploys the services defined by the \`deploy\` export of your ${DEPLOY_FILE_CANDIDATES[0]} — create one, or pass --deploy-file <path>.`);
}

// Mirrors the backend's userSpecifiedIdSchema so a bad id fails here (with the
// service context) instead of as a 400 from the sync request.
const SERVICE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const SERVICE_ID_MAX_LENGTH = 63;

const SECRET_REF_MARKER = Symbol("hexclave-secret-ref");
const CONNECTION_REF_MARKER = Symbol("hexclave-connection-ref");
// Marks the `internalUrl` FUNCTION itself (not the ref it returns), so assigning
// it without calling can be reported as the missing call it is.
const UNCALLED_OUTPUT_MARKER = Symbol("hexclave-uncalled-output");

type SecretRef = {
  [SECRET_REF_MARKER]: true,
  secretKey: string,
  defaultValue: string | undefined,
};

type ConnectionRef = {
  [CONNECTION_REF_MARKER]: true,
  // `<serviceId>.<outputKey>` or `hexclave.<outputKey>`
  reference: string,
  // Set for `hexclave.*` refs so dev mode can resolve them from the session.
  hexclaveOutputKey: HexclaveOutputKey | undefined,
};

function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "object" && value !== null && SECRET_REF_MARKER in value;
}

function isConnectionRef(value: unknown): value is ConnectionRef {
  return typeof value === "object" && value !== null && CONNECTION_REF_MARKER in value;
}

/**
 * Makes string coercion of a sentinel throw. Without this,
 * `env: { API: \`${service("db").url}/api\` }` would coerce the ref to
 * "[object Object]" and pass the plain-string env value check — silently
 * deploying garbage. References must be used as whole values.
 */
function preventStringCoercion<T extends object>(sentinel: T, description: string): T {
  const throwOnCoercion = () => {
    throw new CliError(`${description} cannot be embedded in a string. References must be used as the WHOLE env var value (e.g. \`DB_URL: service("db").url\`) — string interpolation with references is not supported, because plain env values must stay entirely literal.`);
  };
  Object.defineProperty(sentinel, Symbol.toPrimitive, { value: throwOnCoercion });
  Object.defineProperty(sentinel, "toString", { value: throwOnCoercion });
  return sentinel;
}

// Property names that runtimes and libraries probe on arbitrary objects
// (promise unwrapping checks "then", console.log checks inspect/toJSON, ...).
// The output proxies must answer those with undefined instead of throwing, or
// perfectly fine user code like `console.log(ctx)` would crash.
const PROBED_PROPERTY_NAMES = new Set(["then", "toJSON", "constructor", "$$typeof", "prototype"]);

/**
 * A proxy whose known output keys resolve via `resolveOutput` and whose
 * unknown STRING property accesses throw a CliError naming the available
 * outputs — a typo like `service("db").ur` should fail at evaluation time with
 * a precise message, not serialize into a broken definition.
 */
function createOutputsProxy(subject: string, outputKeys: readonly string[], resolveOutput: (outputKey: string) => unknown): Record<string, unknown> {
  return new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== "string" || PROBED_PROPERTY_NAMES.has(property)) {
        return undefined;
      }
      if (!outputKeys.includes(property)) {
        throw new CliError(`${subject} has no output named ${JSON.stringify(property)}. Available outputs: ${outputKeys.join(", ")}.`);
      }
      return resolveOutput(property);
    },
    has: (_target, property) => typeof property === "string" && outputKeys.includes(property),
    ownKeys: () => [...outputKeys],
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property === "string" && outputKeys.includes(property)) {
        return { configurable: true, enumerable: true, value: undefined };
      }
      return undefined;
    },
  });
}

export type ServicesFunctionContext = {
  isDev: boolean,
  secret: (key: string, defaultValue?: string) => unknown,
  service: (serviceId: string) => unknown,
  hexclave: Record<string, unknown>,
};

function createServicesContext(mode: "deploy" | "dev"): { context: ServicesFunctionContext, referencedServiceIds: Set<string> } {
  const referencedServiceIds = new Set<string>();

  const secret = (key: unknown, defaultValue?: unknown): unknown => {
    if (typeof key !== "string" || !PROJECT_SECRET_KEY_REGEX.test(key)) {
      throw new CliError(`secret() must be called with a secret key containing only letters, numbers, underscores, and hyphens (got ${JSON.stringify(key)}).`);
    }
    if (defaultValue !== undefined && typeof defaultValue !== "string") {
      throw new CliError(`The default value of secret(${JSON.stringify(key)}) must be a string.`);
    }
    // A ref is returned in BOTH modes. Dev mode resolves it to the default
    // value in resolveDevEnv — deliberately deferring the missing-default
    // error to the env of the service actually being run, so a default-less
    // secret in an UNRELATED service can't block `hexclave dev --service-id`
    // for everything else.
    return preventStringCoercion({ [SECRET_REF_MARKER]: true, secretKey: key, defaultValue } satisfies SecretRef, `secret(${JSON.stringify(key)})`);
  };

  const service = (serviceId: unknown): unknown => {
    if (typeof serviceId !== "string" || serviceId.length === 0) {
      throw new CliError(`service() must be called with a service id string (got ${JSON.stringify(serviceId)}).`);
    }
    if (serviceId === HEXCLAVE_SERVICE_ID) {
      throw new CliError(`service(${JSON.stringify(HEXCLAVE_SERVICE_ID)}) does not exist — use the \`hexclave\` context object instead (e.g. \`hexclave.projectId\`).`);
    }
    // Recorded in BOTH modes so a typo'd id fails during `hexclave dev` too,
    // not only at deploy time. Service ids are unique across the whole project,
    // so a service deployed from another deployment source is referenced exactly
    // like one declared right here — this file just cannot check that it exists.
    referencedServiceIds.add(serviceId);
    if (mode === "dev") {
      // During `hexclave dev` there is nothing meaningful to connect to (the
      // referenced service's deployed URL may not even exist), so service()
      // returns null and users are expected to branch on isDev for local
      // values. Accessing an output on the null return crashes evaluation;
      // evaluateDeploymentConfig wraps that crash with a hint.
      return null;
    }
    const subject = `service(${JSON.stringify(serviceId)})`;
    const connectionRef = (outputKey: string, port: number | null, description: string) => preventStringCoercion({
      [CONNECTION_REF_MARKER]: true,
      reference: formatConnectionValue(serviceId, outputKey, port),
      hexclaveOutputKey: undefined,
    } satisfies ConnectionRef, description);
    // Both outputs are CALLS: `url` because a URL names exactly one port, and
    // `hostname` for symmetry — one shape to remember rather than a rule about
    // which of two outputs happens to take parentheses.
    return createOutputsProxy(subject, SERVICE_OUTPUT_KEYS, (outputKey) => {
      const output = (port?: unknown): unknown => {
        if (outputKey === "hostname") {
          if (port !== undefined) {
            throw new CliError(`${subject}.hostname() takes no arguments — it is the service's address without a port. Use ${subject}.url(${JSON.stringify(port)}) for a URL, or pair the hostname with a literal port number.`);
          }
          return connectionRef("hostname", null, `${subject}.hostname()`);
        }
        if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
          throw new CliError(`${subject}.url() takes a port number between 1 and 65535 (got ${JSON.stringify(port)}).`);
        }
        return connectionRef("url", port ?? null, `${subject}.url(${port ?? ""})`);
      };
      // Coercing the FUNCTION is the mistake to catch here — forgetting the
      // call, as in `DB: service("db").url`, would otherwise serialize as
      // "[object Function]" or throw somewhere far from the cause.
      Object.defineProperty(output, UNCALLED_OUTPUT_MARKER, { value: `${subject}.${outputKey}` });
      return preventStringCoercion(output, `${subject}.${outputKey} (call it: \`${subject}.${outputKey}()\`)`);
    });
  };

  // hexclave.* returns connection refs in BOTH modes: at deploy time the
  // backend resolves them, and in dev mode the refs are resolved from the
  // development-environment session's env (see resolveDevEnv).
  const hexclave = createOutputsProxy("hexclave", HEXCLAVE_OUTPUT_KEYS, (outputKey) => preventStringCoercion({
    [CONNECTION_REF_MARKER]: true,
    reference: `${HEXCLAVE_SERVICE_ID}.${outputKey}`,
    hexclaveOutputKey: outputKey as HexclaveOutputKey,
  } satisfies ConnectionRef, `hexclave.${outputKey}`));

  return {
    context: { isDev: mode === "dev", secret, service, hexclave },
    referencedServiceIds,
  };
}

// One env var as evaluated, before mode-specific serialization.
type EvaluatedEnvVarValue =
  | { kind: "plain", value: string }
  | { kind: "secret", secretKey: string, defaultValue: string | undefined }
  | { kind: "connection", reference: string, hexclaveOutputKey: HexclaveOutputKey | undefined };

export type EvaluatedService = {
  serviceId: string,
  // The wire-shape definition synced to the backend (deploy mode). In dev
  // mode secrets have already collapsed into plain values and service
  // connections into omissions, so this is still well-formed but only the
  // dev-relevant parts are meaningful.
  definition: DeploymentServiceDefinition,
  env: Record<string, EvaluatedEnvVarValue>,
  absoluteRootDirectory: string,
  // `dockerfilePath` exactly as the deploy file spells it (relative to the
  // service's root directory). `definition.dockerfile_path` has the root
  // directory joined on, so an error about a missing Dockerfile can name both
  // the line the author has to edit and the path that was looked for.
  authoredDockerfilePath: string | undefined,
  // Local-only: `hexclave dev --service-id` runs this. It is deliberately
  // absent from `definition` (and from the sync route's schema) because the
  // backend never acts on it, so there is no reason for it to leave the
  // machine or to be stored where it could drift from the deploy file.
  devCommand: string | undefined,
};

export type EvaluatedServices = {
  // The deployment source this file is: one `hexclave deploy` uploads and builds
  // exactly these services, and the server treats every service NOT listed here
  // but previously owned by this source as removed.
  sourceId: string,
  services: Map<string, EvaluatedService>,
};

const KNOWN_SERVICE_FIELDS = new Set([
  "type", "public", "ports", "minInstances", "maxInstances",
  "rootDirectory", "dockerfilePath", "image", "devCommand", "buildCommand", "startCommand", "persistentVolumes", "env",
]);
const KNOWN_VOLUME_FIELDS = new Set(["path", "sizeGb"]);

function readOptionalIntegerField(record: Record<string, unknown>, serviceId: string, field: string): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CliError(`deploy.services.${serviceId}.${field} must be an integer.`);
  }
  return value;
}

function readOptionalStringField(record: Record<string, unknown>, serviceId: string, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CliError(`deploy.services.${serviceId}.${field} must be a string.`);
  }
  return value;
}

/**
 * Evaluates the optional `persistentVolumes: { <id>: { path, sizeGb } }` field.
 * Author-facing `sizeGb` becomes `size_gb` on the wire; the mount path must be
 * absolute and normalized so it is unambiguous against the image's WORKDIR.
 *
 * The KEY is the volume's id: Marshal names the Fly volume from it, inside the
 * service's own Fly app. It therefore identifies the disk within a service —
 * the same id under a different service is a DIFFERENT (empty) disk.
 */
const KNOWN_PORT_FIELDS = new Set(["protocol"]);

/**
 * Evaluates the `ports` record, keyed by port number. Visibility is NOT here —
 * it belongs to the service (`public: true`), because the runtime serves every
 * declared port on every address the service has and a per-port flag could only
 * ever misdescribe that.
 *
 * The record IS the wire and stored shape — nothing translates between two
 * spellings of one thing — so this validates every explicit protocol and the
 * keys.
 */
function evaluatePorts(serviceId: string, isPublic: boolean, portsRaw: unknown): DeploymentPorts {
  // The FIELD stays required even though the record may be empty: an omitted
  // `ports` is far more often a forgotten line than a deliberate worker, and
  // `ports: {}` says the latter out loud.
  if (portsRaw === undefined || portsRaw === null) {
    throw new CliError(`deploy.services.${serviceId} has no \`ports\`. Every service must declare the ports its container listens on, e.g. \`ports: { 3000: { protocol: "http" } }\` — or \`ports: {}\` for a worker that only makes outbound connections.`);
  }
  if (typeof portsRaw !== "object" || Array.isArray(portsRaw)) {
    throw new CliError(`deploy.services.${serviceId}.ports must be an object keyed by port number, e.g. \`ports: { 3000: { protocol: "http" } }\` (got ${Array.isArray(portsRaw) ? "an array" : JSON.stringify(typeof portsRaw)}).`);
  }
  const portEntries = Object.entries(portsRaw as Record<string, unknown>);
  if (portEntries.length > MAX_PORTS_PER_SERVICE) {
    throw new CliError(`deploy.services.${serviceId}.ports declares ${portEntries.length} ports, but at most ${MAX_PORTS_PER_SERVICE} per service is supported.`);
  }

  const ports: DeploymentPorts = {};
  for (const [portKey, portRaw] of portEntries) {
    const at = `deploy.services.${serviceId}.ports[${portKey}]`;
    // Object keys are strings even when written as numbers, and JS accepts any
    // string as one — so the key is validated as a port number here rather than
    // coerced.
    if (!/^[0-9]+$/.test(portKey)) {
      throw new CliError(`deploy.services.${serviceId}.ports has the key ${JSON.stringify(portKey)}, which is not a port number. Keys are the ports the container listens on, e.g. \`ports: { 3000: { protocol: "http" } }\`.`);
    }
    // A port has ONE canonical spelling, and this is what keeps duplicates
    // impossible. "80" and "080" are different keys of one record but the same
    // port: both survive, and the port would be declared twice. The old claim
    // that "an object cannot hold one key twice" covers exact keys only.
    // Normalizing instead of refusing would silently drop one of the two
    // definitions, which may not even agree with each other.
    if (!DEPLOYMENT_PORT_KEY_REGEX.test(portKey)) {
      throw new CliError(`deploy.services.${serviceId}.ports has the key ${JSON.stringify(portKey)}, which has a leading zero. Write the port in plain decimal (${JSON.stringify(String(Number(portKey)))}) — otherwise one port can be declared twice under two spellings.`);
    }
    const port = Number(portKey);
    if (port < 1 || port > 65535) {
      throw new CliError(`${at} must be a port between 1 and 65535 (got ${port}).`);
    }
    if (portRaw === null || typeof portRaw !== "object" || Array.isArray(portRaw)) {
      throw new CliError(`${at} must be an object with an explicit protocol, e.g. \`{ protocol: "http" }\` or \`{ protocol: "tcp" }\`.`);
    }
    const record = portRaw as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!KNOWN_PORT_FIELDS.has(field)) {
        throw new CliError(`${at} has an unknown field ${JSON.stringify(field)}. Known fields: ${[...KNOWN_PORT_FIELDS].join(", ")}.`);
      }
    }

    const protocol = record.protocol;
    if (protocol !== "http" && protocol !== "tcp") {
      throw new CliError(`${at}.protocol is required and must be "http" or "tcp" (got ${JSON.stringify(record.protocol)}).`);
    }

    // Written out rather than passing the arbitrary input object through.
    ports[String(port)] = { protocol };
  }

  const entries = deploymentPortEntries(ports);

  // PLATFORM LIMITATION: a public service is all-HTTP. Public traffic arrives
  // through one shared Application Load Balancer that tells services apart by SNI
  // (TLS) or Host (HTTP); a raw TCP stream carries neither, so the edge accepts
  // the connection and then drops it. Lifting this needs a dedicated public
  // address per service, which is a cost decision rather than a code change.
  const tcpPorts = entries.filter((entry) => entry.protocol === "tcp");
  if (isPublic && tcpPorts.length > 0) {
    throw new CliError(`deploy.services.${serviceId} is \`public: true\` but declares the "tcp" port${tcpPorts.length === 1 ? "" : "s"} ${tcpPorts.map((entry) => entry.port).join(", ")}. Raw TCP carries no SNI or Host header, so a shared public address cannot tell which service a connection is for. Keep the service private and reach it with service(${JSON.stringify(serviceId)}).hostname() and the port number, or move the TCP ports to their own service.`);
  }

  // Public ingress with nothing behind it.
  if (isPublic && entries.length === 0) {
    throw new CliError(`deploy.services.${serviceId} is \`public: true\` but declares no ports, so there is nothing to serve on the public address it would be given. Drop \`public\`, or declare the port the container listens on.`);
  }

  // The port that owns the standard bindings also claims external 80 and 443 for
  // the whole service, so another port numbered 80 or 443 asks for a listener it
  // has already taken and the runtime cannot serve both.
  const standardConflicts = reservedStandardPortConflicts(ports, isPublic);
  if (standardConflicts.length > 0) {
    const holder = standardPortsHolderPort(ports, isPublic);
    throw new CliError(`deploy.services.${serviceId} declares port ${standardConflicts.join(" and ")} alongside port ${holder}, which additionally answers on the standard 80 and 443 — so one external port would have to be served from two of them. Keep whichever of the two you actually need, or move it to its own service.`);
  }

  // Not an error, but worth saying at evaluation time rather than only in the
  // docs: every port of a public service is reachable, yet only ONE owns the bare
  // platform URL and can hold a custom domain, and the author has no other way to
  // learn which.
  if (isPublic && entries.length > 1) {
    const [holder, ...rest] = entries;
    console.error(`Note: services.${serviceId} is public with ${entries.length} ports. The lowest (${holder.port}) owns the standard 80/443, so it is the one the service's URL points at and the only port a custom domain can front; ${rest.map((entry) => entry.port).join(", ")} ${rest.length === 1 ? "is reachable at its own" : "are reachable at their own"} port number.`);
  }
  return ports;
}

function evaluatePersistentVolumes(serviceId: string, volumesRaw: unknown): Record<string, DeploymentVolumeDefinition> | undefined {
  if (volumesRaw === undefined || volumesRaw === null) return undefined;
  if (typeof volumesRaw !== "object" || Array.isArray(volumesRaw)) {
    throw new CliError(`deploy.services.${serviceId}.persistentVolumes must be an object keyed by volume id, e.g. \`persistentVolumes: { data: { path: "/data", sizeGb: 10 } }\`.`);
  }
  const volumesRecord = volumesRaw as Record<string, unknown>;
  const volumeIds = Object.keys(volumesRecord);
  if (volumeIds.length === 0) return undefined;
  // Fly mounts at most one volume per machine, so a second entry could not be
  // honoured. Refuse it outright rather than silently mounting the first.
  if (volumeIds.length > MAX_PERSISTENT_VOLUMES_PER_SERVICE) {
    throw new CliError(`deploy.services.${serviceId}.persistentVolumes declares ${volumeIds.length} volumes (${volumeIds.join(", ")}), but only ${MAX_PERSISTENT_VOLUMES_PER_SERVICE} per service is supported right now. Keep one volume and put the rest on separate services.`);
  }

  const volumes = new Map<string, DeploymentVolumeDefinition>();
  for (const [volumeId, volumeRaw] of Object.entries(volumesRecord)) {
    // The id becomes the Fly volume name, which is alphanumeric + underscore.
    if (!DEPLOYMENT_VOLUME_ID_REGEX.test(volumeId) || volumeId.length > MAX_VOLUME_ID_LENGTH) {
      throw new CliError(`Invalid persistent volume id ${JSON.stringify(volumeId)} on deploy.services.${serviceId}. Volume ids must start with a lowercase letter, contain only lowercase letters, digits, and underscores, and be at most ${MAX_VOLUME_ID_LENGTH} characters.`);
    }
    if (volumeRaw === null || typeof volumeRaw !== "object" || Array.isArray(volumeRaw)) {
      throw new CliError(`deploy.services.${serviceId}.persistentVolumes.${volumeId} must be an object, e.g. \`{ path: "/data", sizeGb: 10 }\`.`);
    }
    const record = volumeRaw as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!KNOWN_VOLUME_FIELDS.has(field)) {
        throw new CliError(`deploy.services.${serviceId}.persistentVolumes.${volumeId} has an unknown field ${JSON.stringify(field)}. Known fields: ${[...KNOWN_VOLUME_FIELDS].join(", ")}.`);
      }
    }

    const volumePath = record.path;
    if (typeof volumePath !== "string" || volumePath === "") {
      throw new CliError(`deploy.services.${serviceId}.persistentVolumes.${volumeId}.path is required and must be the absolute path the disk is mounted at inside the container, e.g. "/data".`);
    }
    if (volumePath.length > 512
      || !volumePath.startsWith("/")
      || volumePath === "/"
      || volumePath.endsWith("/")
      || volumePath.includes("\\")
      // eslint-disable-next-line no-control-regex
      || /[\x00-\x1f]/.test(volumePath)
      || volumePath.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new CliError(`deploy.services.${serviceId}.persistentVolumes.${volumeId}.path must be a normalized absolute path inside the container (got ${JSON.stringify(volumePath)}). Use something like "/data" — no trailing slash, no "." or ".." segments.`);
    }

    const sizeGb = record.sizeGb;
    if (typeof sizeGb !== "number" || !Number.isInteger(sizeGb)) {
      throw new CliError(`deploy.services.${serviceId}.persistentVolumes.${volumeId}.sizeGb is required and must be a whole number of gigabytes, e.g. \`sizeGb: 10\`.`);
    }
    if (sizeGb < MIN_VOLUME_SIZE_GB || sizeGb > MAX_VOLUME_SIZE_GB) {
      throw new CliError(`deploy.services.${serviceId}.persistentVolumes.${volumeId}.sizeGb must be between ${MIN_VOLUME_SIZE_GB} and ${MAX_VOLUME_SIZE_GB} GB (got ${sizeGb}).`);
    }
    volumes.set(volumeId, { path: volumePath, size_gb: sizeGb });
  }
  return Object.fromEntries(volumes);
}

function evaluateEnvRecord(serviceId: string, envRaw: unknown): Record<string, EvaluatedEnvVarValue> {
  if (envRaw === undefined) return {};
  if (envRaw === null || typeof envRaw !== "object" || Array.isArray(envRaw)) {
    throw new CliError(`deploy.services.${serviceId}.env must be a record of env var values.`);
  }
  const env = new Map<string, EvaluatedEnvVarValue>();
  for (const [envVarKey, value] of Object.entries(envRaw as Record<string, unknown>)) {
    if (!DEPLOYMENT_ENV_VAR_KEY_REGEX.test(envVarKey)) {
      throw new CliError(`deploy.services.${serviceId}.env has an invalid key ${JSON.stringify(envVarKey)}. Env var keys must start with a letter or underscore and contain only letters, digits, and underscores.`);
    }
    if (value === null || value === undefined) {
      // null means "omit this env var" — the isDev-branching idiom
      // (`isDev ? null : secret(...)`) depends on it.
      continue;
    }
    if (typeof value === "string") {
      env.set(envVarKey, { kind: "plain", value });
    } else if (isSecretRef(value)) {
      env.set(envVarKey, { kind: "secret", secretKey: value.secretKey, defaultValue: value.defaultValue });
    } else if (isConnectionRef(value)) {
      env.set(envVarKey, { kind: "connection", reference: value.reference, hexclaveOutputKey: value.hexclaveOutputKey });
    } else if (typeof value === "function" && UNCALLED_OUTPUT_MARKER in value) {
      // `internalUrl` is a call, so the bare property is a function. Say so
      // rather than reporting an unhelpful "got function".
      const call = (value as Record<symbol, string>)[UNCALLED_OUTPUT_MARKER];
      throw new CliError(`deploy.services.${serviceId}.env.${envVarKey} is ${call} without calling it. A URL names one port — write \`${call}()\` when the service has a single HTTP port, or \`${call}(9090)\` to pick one.`);
    } else if (typeof value === "object" && (SERVICE_OUTPUT_KEYS as readonly string[]).some((outputKey) => outputKey in (value as object))) {
      // The whole outputs object was assigned instead of one of its outputs.
      throw new CliError(`deploy.services.${serviceId}.env.${envVarKey} is a service returned by service() — pick one of its outputs instead (e.g. service("...").url).`);
    } else {
      throw new CliError(`deploy.services.${serviceId}.env.${envVarKey} must be a string, null, secret(...), service(...).<output>, or hexclave.<output> (got ${typeof value}).`);
    }
  }
  return Object.fromEntries(env);
}

function serializeEnvForWire(env: Record<string, EvaluatedEnvVarValue>): Record<string, DeploymentEnvVarDefinition> {
  return Object.fromEntries(Object.entries(env).map(([envVarKey, value]): [string, DeploymentEnvVarDefinition] => {
    switch (value.kind) {
      case "plain": {
        return [envVarKey, { value: value.value }];
      }
      case "secret": {
        // No default_value: defaults are author-side only and never persisted
        // server-side. They travel with the deploy request instead — see
        // collectSecretDefaults.
        return [envVarKey, { type: "secret", key: value.secretKey }];
      }
      case "connection": {
        return [envVarKey, { type: "connection", value: value.reference }];
      }
    }
  }));
}

const EXAMPLE_DEPLOYMENT_EXPORT = `  export const deploymentGroupId = "my-app";

  export const deploy: HexclaveDeploymentConfig = ({ isDev, secret, service, hexclave }) => ({
    services: {
      web: {
        type: "serverless",
        public: true,
        ports: { 3000: { protocol: "http" } },
        devCommand: "npm run dev",
        env: { API_URL: service("api").url(8080) },
      },
    },
  });`;

/**
 * Evaluates a loaded deploy module's `deploy` export. `deployFilePath` must
 * be the absolute path of the deploy file (root directories resolve relative to
 * its directory).
 */
export function evaluateDeploymentConfig(options: {
  deployFilePath: string,
  // The file's `deploymentGroupId` export — the deployment group id. Required in
  // a deploy file; the caller passes CONFIG_FILE_DEPLOYMENT_SOURCE_ID for
  // deployments declared in hexclave.config.ts, which has no id of its own.
  deploymentGroupIdExport: unknown,
  // The file's `id` export, which is what this used to be called. Passed so a
  // file still using the old name fails with the rename instead of the
  // less helpful "no `deploymentGroupId` export".
  legacyIdExport?: unknown,
  deployExport: unknown,
  mode: "deploy" | "dev",
}): EvaluatedServices {
  const { deployFilePath, deploymentGroupIdExport, legacyIdExport, deployExport, mode } = options;
  const deployFileDirectory = path.dirname(deployFilePath);

  // `id` was the old name for this export. Refuse the file outright rather than
  // ignoring the old name: silently ignoring it would deploy under a DIFFERENT
  // group id than the file asks for, which tears down every service the author
  // meant to keep.
  if (legacyIdExport !== undefined) {
    throw new CliError(`The deploy file ${deployFilePath} has an \`id\` export, which is no longer supported. Rename it to \`deploymentGroupId\`, e.g. \`export const deploymentGroupId = ${JSON.stringify(typeof legacyIdExport === "string" ? legacyIdExport : "backend")};\`.`);
  }

  // The group id names what this file deploys. Everything downstream — the
  // upload, the build, the teardown of services this file no longer declares —
  // is scoped to it, which is what lets several repositories deploy into one
  // project without touching each other's services.
  if (deploymentGroupIdExport === undefined) {
    throw new CliError(`The deploy file ${deployFilePath} has no \`deploymentGroupId\` export. Add one naming this deployment group, e.g. \`export const deploymentGroupId = "backend";\` — it is how Hexclave tells the deploy files of different repositories apart.`);
  }
  if (typeof deploymentGroupIdExport !== "string") {
    throw new CliError(`The \`deploymentGroupId\` export of ${deployFilePath} must be a string naming this deployment group (got ${typeof deploymentGroupIdExport}).`);
  }
  const sourceId = deploymentGroupIdExport;
  if (!DEPLOYMENT_SOURCE_ID_REGEX.test(sourceId) || sourceId.length > MAX_DEPLOYMENT_SOURCE_ID_LENGTH) {
    throw new CliError(`Invalid deployment group id ${JSON.stringify(sourceId)} in ${deployFilePath}. Ids must be at most ${MAX_DEPLOYMENT_SOURCE_ID_LENGTH} characters and contain only letters, numbers, underscores, dots, and hyphens (not starting with a dot or hyphen).`);
  }

  if (deployExport === undefined) {
    throw new CliError(`The deploy file ${deployFilePath} has no \`deploy\` export. Add one, e.g.:\n${EXAMPLE_DEPLOYMENT_EXPORT}`);
  }
  // The export is a function OF THE CONTEXT returning `{ services }` — the
  // context is what `secret()`, `service()` and `hexclave.*` come from, so a
  // plain object could never reach them.
  if (typeof deployExport !== "function") {
    throw new CliError(`The \`deploy\` export of ${deployFilePath} must be a function of the deployment context, e.g.:\n${EXAMPLE_DEPLOYMENT_EXPORT}`);
  }

  const { context, referencedServiceIds } = createServicesContext(mode);
  let deployRaw: unknown;
  try {
    deployRaw = (deployExport as (ctx: ServicesFunctionContext) => unknown)(context);
  } catch (error) {
    if (error instanceof CliError) throw error;
    // The most common dev-mode crash: calling `.url()` on service()'s null
    // return without an isDev guard. Attach the explanation to the TypeError
    // instead of letting a bare "Cannot read properties of null" surface.
    if (mode === "dev" && error instanceof TypeError && /null/.test(error.message)) {
      throw new CliError(`Failed to evaluate the \`deploy\` export of ${deployFilePath}: ${error.message}\nNote: during \`hexclave dev\`, service() returns null — guard connection values with isDev, e.g. \`isDev ? "http://localhost:5432" : service("database").url(5432)\`.`);
    }
    throw new CliError(`Failed to evaluate the \`deploy\` export of ${deployFilePath}: ${errorMessage(error)}`);
  }
  // An async function's Promise would pass the object check below and then die
  // on a misleading "has no services".
  if (deployRaw !== null && typeof deployRaw === "object" && "then" in deployRaw && typeof (deployRaw as { then: unknown }).then === "function") {
    throw new CliError(`The \`deploy\` export of ${deployFilePath} must be synchronous, but it returned a Promise. Remove the \`async\` keyword — secrets and connections are resolved for you, nothing here needs to be awaited.`);
  }
  if (deployRaw === null || typeof deployRaw !== "object" || Array.isArray(deployRaw)) {
    throw new CliError(`The \`deploy\` export of ${deployFilePath} must return an object with a \`services\` member, e.g.:\n${EXAMPLE_DEPLOYMENT_EXPORT}`);
  }
  const deployRecord = deployRaw as Record<string, unknown>;
  for (const field of Object.keys(deployRecord)) {
    if (field !== "services") {
      throw new CliError(`The \`deploy\` export of ${deployFilePath} returned an unknown field ${JSON.stringify(field)}. The only supported field is \`services\`.`);
    }
  }
  const servicesRaw = deployRecord.services;
  if (servicesRaw === undefined) {
    throw new CliError(`The \`deploy\` export of ${deployFilePath} returned no \`services\`. Add them, e.g.:\n${EXAMPLE_DEPLOYMENT_EXPORT}`);
  }
  if (servicesRaw === null || typeof servicesRaw !== "object" || Array.isArray(servicesRaw)) {
    throw new CliError(`deploy.services of ${deployFilePath} must be a record of services keyed by service id.`);
  }

  const services = new Map<string, EvaluatedService>();
  for (const [serviceId, serviceRaw] of Object.entries(servicesRaw as Record<string, unknown>)) {
    if (!SERVICE_ID_PATTERN.test(serviceId) || serviceId.length > SERVICE_ID_MAX_LENGTH) {
      throw new CliError(`Invalid service id ${JSON.stringify(serviceId)}. Service ids must be at most ${SERVICE_ID_MAX_LENGTH} characters and contain only letters, numbers, underscores, and hyphens (not starting with a hyphen).`);
    }
    if (serviceId === HEXCLAVE_SERVICE_ID) {
      throw new CliError(`The service id ${JSON.stringify(HEXCLAVE_SERVICE_ID)} is reserved for the managed Hexclave service.`);
    }
    if (serviceRaw === null || typeof serviceRaw !== "object" || Array.isArray(serviceRaw)) {
      throw new CliError(`deploy.services.${serviceId} must be an object.`);
    }
    const record = serviceRaw as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!KNOWN_SERVICE_FIELDS.has(field)) {
        throw new CliError(`deploy.services.${serviceId} has an unknown field ${JSON.stringify(field)}. Known fields: ${[...KNOWN_SERVICE_FIELDS].join(", ")}.`);
      }
    }
    if (!(DEPLOYMENT_SERVICE_TYPES as readonly unknown[]).includes(record.type)) {
      throw new CliError(record.type === undefined
        ? `deploy.services.${serviceId} has no \`type\`. Add \`type: "server"\` (single always-on instance, may have persistentVolumes, paid plan) or \`type: "serverless"\` (scales out, stops on scale-down).`
        : `deploy.services.${serviceId}.type must be ${DEPLOYMENT_SERVICE_TYPES.map((knownType: string) => JSON.stringify(knownType)).join(" or ")} (got ${JSON.stringify(record.type)}).`);
    }
    const serviceType = record.type as DeploymentServiceType;
    // Visibility is the SERVICE's, not a port's: the runtime serves every declared
    // port on every address the service has, so there is no such thing as a
    // public port with a private sibling.
    if (record.public !== undefined && typeof record.public !== "boolean") {
      throw new CliError(`deploy.services.${serviceId}.public must be true or false (got ${JSON.stringify(record.public)}). It defaults to false — services are private, reachable only by other services in this project.`);
    }
    const isPublic = record.public === true;
    const ports = evaluatePorts(serviceId, isPublic, record.ports);

    // `image` and `dockerfilePath` each say what the build starts FROM, so a
    // service has at most one of them. Checked on the RAW record rather than on
    // the resolved values below, because `rootDirectory` resolves to a default
    // and would otherwise look present on every service.
    const imageRaw = readOptionalStringField(record, serviceId, "image");
    const buildCommand = readOptionalStringField(record, serviceId, "buildCommand");
    const startCommand = readOptionalStringField(record, serviceId, "startCommand");
    for (const [field, value] of [["buildCommand", buildCommand], ["startCommand", startCommand]] as const) {
      // Stated here as well as in the wire schema so the author sees it before
      // anything is packaged, and phrased for the deploy file they are editing.
      if (value !== undefined && !isValidDeploymentCommand(value)) {
        throw new CliError(`deploy.services.${serviceId}.${field} must be a single non-empty command line of at most ${MAX_DEPLOYMENT_COMMAND_LENGTH} characters, with no newlines or other control characters. Chain steps with \`&&\`, or move them into a script the command runs.`);
      }
    }
    let image: string | undefined;
    if (imageRaw !== undefined) {
      if (record.dockerfilePath !== undefined) {
        throw new CliError(`deploy.services.${serviceId} sets both \`image\` and \`dockerfilePath\`. Each of them says what the build starts from — remove \`dockerfilePath\` to build on ${JSON.stringify(imageRaw)}, or remove \`image\` to build from the Dockerfile.`);
      }
      if (buildCommand === undefined && record.rootDirectory !== undefined) {
        throw new CliError(`deploy.services.${serviceId} sets both \`image\` and \`rootDirectory\`, but without a \`buildCommand\` it only runs ${JSON.stringify(imageRaw)} and is never built from your source, so a directory within it means nothing. Add a \`buildCommand\` to build on top of the image, or remove \`rootDirectory\`.`);
      }
      const parsed = parseDeploymentImageRef(imageRaw);
      if (!parsed.ok) {
        // The shared parser phrases the rule; this only says where it was broken.
        throw new CliError(`deploy.services.${serviceId}: ${parsed.message}.`);
      }
      // Normalized rather than stored verbatim, so the definition names what is
      // actually pulled: `postgres:16` is `docker.io/library/postgres:16`.
      image = parsed.ref.canonical;
    }

    const rootDirectoryRaw = readOptionalStringField(record, serviceId, "rootDirectory");
    const absoluteRootDirectory = path.resolve(deployFileDirectory, rootDirectoryRaw ?? ".");
    const relativeRootDirectory = path.relative(deployFileDirectory, absoluteRootDirectory);
    if (relativeRootDirectory === ".." || relativeRootDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRootDirectory)) {
      throw new CliError(`deploy.services.${serviceId}.rootDirectory resolves to ${absoluteRootDirectory}, which is outside the directory containing the deploy file (${deployFileDirectory}). Root directories must be inside it.`);
    }

    // Optional Dockerfile location, written relative to the service's
    // `rootDirectory` — the service's code is what its Dockerfile belongs to,
    // so a service moves by editing one field rather than two. When it is
    // absent, the service is NOT built from a Dockerfile at all — the remote
    // builder auto-detects the build with Railpack (https://railpack.com)
    // instead, even if a file named "Dockerfile" happens to exist.
    //
    // It is JOINED onto the root directory here, so what leaves this machine
    // is a path within the uploaded tree: the pre-flight below, the wire
    // schema and the remote builder all resolve `dockerfile_path` against the
    // upload root, and one meaning per field is what keeps them from drifting.
    // The authored spelling is kept alongside it, purely so an error can quote
    // what the deploy file actually says.
    const dockerfilePathRaw = readOptionalStringField(record, serviceId, "dockerfilePath");
    let dockerfilePath: string | undefined;
    if (dockerfilePathRaw !== undefined) {
      const absoluteDockerfilePath = path.resolve(absoluteRootDirectory, dockerfilePathRaw);
      const rootRelativeDockerfilePath = path.relative(absoluteRootDirectory, absoluteDockerfilePath);
      if (rootRelativeDockerfilePath === "" || rootRelativeDockerfilePath === ".." || rootRelativeDockerfilePath.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelativeDockerfilePath)) {
        throw new CliError(`deploy.services.${serviceId}.dockerfilePath must point to a file inside the service's root directory (got ${JSON.stringify(dockerfilePathRaw)}). It is resolved relative to \`rootDirectory\` (${JSON.stringify(relativeRootDirectory === "" ? "." : relativeRootDirectory.split(path.sep).join("/"))}), not to the deploy file.`);
      }
      dockerfilePath = path.relative(deployFileDirectory, absoluteDockerfilePath).split(path.sep).join("/");
    }

    const minInstances = readOptionalIntegerField(record, serviceId, "minInstances");
    const maxInstances = readOptionalIntegerField(record, serviceId, "maxInstances");
    if (minInstances !== undefined && (minInstances < 0 || minInstances > MAX_INSTANCES_PER_SERVICE)) {
      throw new CliError(`deploy.services.${serviceId}.minInstances must be between 0 and ${MAX_INSTANCES_PER_SERVICE} (got ${minInstances}).`);
    }
    if (maxInstances !== undefined && (maxInstances < 1 || maxInstances > MAX_INSTANCES_PER_SERVICE)) {
      // Caught here rather than server-side so a typo'd fleet size fails in
      // seconds, before anything is packaged or uploaded.
      throw new CliError(`deploy.services.${serviceId}.maxInstances must be between 1 and ${MAX_INSTANCES_PER_SERVICE} (got ${maxInstances}). A service may scale to at most ${MAX_INSTANCES_PER_SERVICE} instances.`);
    }
    // Only reject when max is explicitly below min. min-only is fine: max defaults up to min
    // downstream, so the spec stays consistent (this used to slip through and 400 from the runtime).
    if (minInstances !== undefined && maxInstances !== undefined && maxInstances < minInstances) {
      throw new CliError(`deploy.services.${serviceId}.maxInstances (${maxInstances}) must be at least minInstances (${minInstances}).`);
    }
    // A "server" is exactly one instance that suspends when idle, so scaling
    // bounds may only ever restate that. Anything else is a type mismatch, not
    // a bounds error, so point at the type the author probably wanted.
    if (serviceType === "server") {
      if (maxInstances !== undefined && maxInstances !== 1) {
        throw new CliError(`deploy.services.${serviceId} is a "server", which is always a single instance, so maxInstances must be 1 (got ${maxInstances}). Use \`type: "serverless"\` to scale out.`);
      }
      if (minInstances !== undefined && minInstances !== 0 && minInstances !== 1) {
        throw new CliError(`deploy.services.${serviceId} is a "server", which holds a single instance, so minInstances must be 1 (always on, the default) or 0 (suspend when idle) — got ${minInstances}. Use \`type: "serverless"\` to run several instances.`);
      }
    }

    // A volume is local disk on a single host and attaches to at most one
    // instance, so only a "server" can hold one.
    const persistentVolumes = evaluatePersistentVolumes(serviceId, record.persistentVolumes);
    if (persistentVolumes !== undefined && serviceType !== "server") {
      throw new CliError(`deploy.services.${serviceId} declares persistentVolumes but is a "serverless" service. A volume is a disk on one machine — it cannot be shared between instances, so each one would get its own separate copy. Change it to \`type: "server"\`, or drop the volume and keep state in a database or object storage instead.`);
    }

    // The Hexclave base image (see `buildCommand`) starts nothing on its own, so
    // a service built on it without a start command would deploy, boot and
    // immediately exit. Refused here, before anything is packaged or uploaded.
    if (buildCommand !== undefined && startCommand === undefined && image === undefined && dockerfilePath === undefined) {
      throw new CliError(`deploy.services.${serviceId} has a \`buildCommand\` but no \`image\` or \`dockerfilePath\`, so it is built on the Hexclave base image — which has no command of its own. Add a \`startCommand\` saying how to run it (e.g. startCommand: "npm start").`);
    }

    const env = evaluateEnvRecord(serviceId, record.env);
    // Read (and type-checked) but deliberately NOT part of `definition`: the
    // dev command is only ever run locally by `hexclave dev --service-id`, so
    // it stays on this machine — see EvaluatedService.devCommand below.
    const devCommand = readOptionalStringField(record, serviceId, "devCommand");
    services.set(serviceId, {
      serviceId,
      definition: {
        type: serviceType,
        // Written out rather than left undefined so the stored definition states
        // the default instead of leaving each reader to apply it.
        public: isPublic,
        ports,
        // A "server" defaults to 1: it holds one instance, and the interesting
        // choice is whether that instance suspends when idle (0) or stays up.
        // A "serverless" defaults to 0 (scale to zero) downstream.
        min_instances: serviceType === "server" ? minInstances ?? 1 : minInstances,
        max_instances: maxInstances,
        // Stored/displayed as a config-directory-relative posix path ("." for
        // the config directory itself) — an absolute local path would be
        // meaningless (and leak local filesystem layout) server-side.
        //
        // Omitted for a service that is not built from the upload at all (an
        // `image` with no `buildCommand`), where a directory within it would be
        // a path to nothing. (`absoluteRootDirectory` below is still the deploy
        // file's own directory, because `hexclave dev` runs `devCommand` there
        // — that is a local concern and never leaves this machine.)
        root_directory: deploymentServiceIsBuilt({ image, build_command: buildCommand })
          ? (relativeRootDirectory === "" ? "." : relativeRootDirectory.split(path.sep).join("/"))
          : undefined,
        // Posix path within the uploaded tree — `rootDirectory` already joined
        // on. Absent = Railpack auto-detection, or the generated Dockerfile if a
        // command selects it.
        dockerfile_path: dockerfilePath,
        // The image to run, or — with a `buildCommand` — the base to build on.
        image,
        // Run while the image is built; run instead of the image's own command.
        // A start command is applied by the runtime, so it causes no build.
        build_command: buildCommand,
        start_command: startCommand,
        // Absent = the container filesystem is entirely ephemeral.
        persistent_volumes: persistentVolumes,
        env: serializeEnvForWire(env),
      },
      env,
      absoluteRootDirectory,
      authoredDockerfilePath: dockerfilePathRaw,
      devCommand,
    });
  }

  if (services.size === 0) {
    throw new CliError(`The services function of ${deployFilePath} returned no services.`);
  }

  // A volume id names exactly one disk, so two services claiming the same id
  // would be asking to mount one disk on two machines — which Fly refuses, and
  // which would mean data loss for whichever service lost the race. This is the
  // flip side of ids being service-independent: moving an id between services is
  // supported precisely BECAUSE only one service may hold it at a time.
  const volumeIdOwners = new Map<string, string>();
  for (const [serviceId, service] of services) {
    for (const volumeId of Object.keys(service.definition.persistent_volumes ?? {})) {
      const existingOwner = volumeIdOwners.get(volumeId);
      if (existingOwner !== undefined) {
        throw new CliError(`The persistent volume id ${JSON.stringify(volumeId)} is claimed by both deploy.services.${existingOwner} and deploy.services.${serviceId}. A volume is one disk and can only be mounted by one service — give one of them a different id.`);
      }
      volumeIdOwners.set(volumeId, serviceId);
    }
  }

  // A service("...") call may reference a service this file does not define:
  // service ids are unique across the whole project, so it may well belong to
  // another deployment source (another repository), whose deploy file this one
  // has never seen. The backend resolves those against the services it has
  // stored and fails the deploy if the target does not exist — which is also
  // where a typo'd id is caught, at the cost of one round trip.

  // Reject connections the target's ports cannot satisfy, before uploading
  // anything. The backend enforces this too, but config evaluation can name
  // both services and the correct replacement immediately.
  //
  // `url` names ONE port, so a service with several only breaks the reference,
  // not itself — which is why this is checked here, against the referrer, rather
  // than when the target is parsed.
  for (const [serviceId, service] of services) {
    for (const [envVarKey, value] of Object.entries(service.env)) {
      if (value.kind !== "connection") continue;
      const parsed = parseConnectionValue(value.reference);
      if (parsed === null) throw new CliError(`Internal error: ${JSON.stringify(value.reference)} is not a valid connection reference.`);
      const { serviceId: targetServiceId, outputKey, port: namedPort } = parsed;
      if (targetServiceId === HEXCLAVE_SERVICE_ID) continue;
      const target = services.get(targetServiceId);
      // A target from another deployment source: its ports are not in this file,
      // so the rules below can only be enforced server-side.
      if (target == null) continue;
      const at = `deploy.services.${serviceId}.env.${envVarKey}`;
      const targetPorts = deploymentPortEntries(target.definition.ports);
      // "none" rather than an empty string: a portless service is a legal
      // declaration now, so this list really can be empty.
      const describePorts = () => targetPorts.map((entry) => `${entry.port} (${entry.protocol})`).join(", ") || "none";

      // A URL names ONE port, and needs something HTTP to serve. A URL to a
      // service that speaks only raw TCP, or listens on nothing at all, could
      // never resolve — and neither could one whose port is ambiguous.
      //
      // Publicness is NOT a requirement: a private service's URL is its
      // internal address, and a public one's is the platform URL.
      if (outputKey === "url") {
        const call = `service(${JSON.stringify(targetServiceId)}).url`;
        if (namedPort === null) {
          // A bare url() only works when one HTTP port makes it obvious.
          const httpPorts = targetPorts.filter((entry) => entry.protocol === "http");
          if (httpPorts.length === 0) {
            const why = targetPorts.length === 0 ? "declares no ports at all" : "declares only TCP ports";
            throw new CliError(`${at} calls ${call}(), but ${JSON.stringify(targetServiceId)} ${why}, so it can never have a URL. Use service(${JSON.stringify(targetServiceId)}).hostname() with an explicit port instead. Its ports: ${describePorts()}.`);
          }
          if (httpPorts.length > 1) {
            throw new CliError(`${at} calls ${call}() on a service with ${httpPorts.length} HTTP ports (${httpPorts.map((entry) => entry.port).join(", ")}), so which one it means is ambiguous. Name the port you want: ${call}(${httpPorts[0].port}).`);
          }
        } else {
          // A named port must actually exist on the target, and speak HTTP.
          const match = targetPorts.find((entry) => entry.port === namedPort);
          if (match === undefined) {
            throw new CliError(`${at} calls ${call}(${namedPort}), but ${JSON.stringify(targetServiceId)} does not declare that port. Its ports: ${describePorts()}.`);
          }
          if (match.protocol !== "http") {
            throw new CliError(`${at} calls ${call}(${namedPort}), but that port is TCP, so it has no URL. Use service(${JSON.stringify(targetServiceId)}).hostname() with port ${namedPort} instead.`);
          }
        }
      }
    }
  }

  // A service referencing its OWN address can never be satisfied: every service address is
  // produced by that service's own rollout, so the reference would have to resolve before the
  // deploy that creates it has finished.
  //
  // This used to apply only to a PUBLIC url, because a private address was name-derived and
  // therefore known before anything ran. That stopped being true with the move off Fly 6PN
  // DNS: nothing publishes such a record now, and `hostname` and a private `url` block on the
  // target's real address like every other service output (see connectionRequiresTargetDeployed).
  // Caught here rather than at deploy time, where it surfaced as "blocked on unresolved refs"
  // after the upload — and where no retry could ever clear it.
  for (const [serviceId, service] of services) {
    for (const [envVarKey, value] of Object.entries(service.env)) {
      if (value.kind !== "connection") continue;
      const parsed = parseConnectionValue(value.reference);
      if (parsed === null || parsed.serviceId !== serviceId) continue;
      if (!connectionRequiresTargetDeployed(parsed.outputKey)) continue;
      throw new CliError(`deploy.services.${serviceId}.env.${envVarKey} connects to the service's own ${parsed.outputKey}, which cannot exist before the service is deployed. Set it as a plain env var, or have the service read its own address at runtime.`);
    }
  }

  return { sourceId, services };
}

/**
 * Orders services into deployment levels: every service deploys after all
 * services it connects to (its env references their deployment outputs), and
 * services within one level are independent of each other. Throws on circular
 * dependencies, naming the cycle.
 */
export function computeDeploymentLevels(services: Map<string, EvaluatedService>): string[][] {
  const dependencies = new Map<string, Set<string>>();
  for (const [serviceId, service] of services) {
    const serviceDependencies = new Set<string>();
    for (const value of Object.values(service.env)) {
      if (value.kind !== "connection") continue;
      const parsed = parseConnectionValue(value.reference);
      if (parsed === null) continue;
      const targetServiceId = parsed.serviceId;
      // hexclave.* outputs come from the managed service, which always exists;
      // connections to services of ANOTHER deployment source are resolved
      // against already-deployed state, since that source deploys on its own
      // schedule and is not part of this deploy at all.
      // Self-references never create a deploy edge: every self-reference to an address output
      // is rejected outright above, and the outputs that remain do not depend on the service
      // having deployed. Adding a self-edge here would make computeDeploymentLevels report a
      // circular-dependency error where the check above gives the specific reason.
      //
      // The same reasoning excludes DETERMINISTIC cross-service references: only
      // `url` and a bare `internalUrl()` need the target deployed. Counting the
      // rest would serialize independent deploys and reject mutually-wired
      // services as circular.
      // A target this file does not define is not part of this deploy either way,
      // so it never becomes an edge.
      if (!services.has(targetServiceId)) continue;
      if (!connectionRequiresTargetDeployed(parsed.outputKey)) continue;
      if (targetServiceId !== HEXCLAVE_SERVICE_ID && targetServiceId !== serviceId) {
        serviceDependencies.add(targetServiceId);
      }
    }
    dependencies.set(serviceId, serviceDependencies);
  }

  const levels: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < services.size) {
    const level = [...services.keys()].filter((serviceId) =>
      !placed.has(serviceId)
      && [...(dependencies.get(serviceId) ?? [])].every((dependency) => placed.has(dependency)));
    if (level.length === 0) {
      // Everything unplaced is part of (or downstream of) a cycle; walk one
      // cycle explicitly so the error names it.
      const unplaced = [...services.keys()].filter((serviceId) => !placed.has(serviceId));
      const cycle = findDependencyCycle(unplaced, dependencies) ?? unplaced;
      throw new CliError(`The services have a circular connection dependency: ${[...cycle, cycle[0]].join(" -> ")}. Break the cycle (e.g. move one of the URLs into a plain env var).`);
    }
    for (const serviceId of level) placed.add(serviceId);
    levels.push(level);
  }
  return levels;
}

function findDependencyCycle(serviceIds: string[], dependencies: Map<string, Set<string>>): string[] | undefined {
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (serviceId: string): string[] | undefined => {
    const cycleStart = visiting.indexOf(serviceId);
    if (cycleStart !== -1) {
      return visiting.slice(cycleStart);
    }
    if (visited.has(serviceId)) return undefined;
    visiting.push(serviceId);
    for (const dependency of dependencies.get(serviceId) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    visiting.pop();
    visited.add(serviceId);
    return undefined;
  };
  for (const serviceId of serviceIds) {
    const cycle = visit(serviceId);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/**
 * Collects a service's `secret(key, default)` fallbacks, keyed by env var key,
 * for the deploy request. These are NOT part of the synced definition: the
 * backend uses them only to fill secrets that have no stored value, and never
 * persists them — so the dashboard's secrets page can say "set" or "not
 * there" and nothing in between.
 */
export function collectSecretDefaults(service: EvaluatedService): Record<string, string> {
  const defaults = new Map<string, string>();
  for (const [envVarKey, value] of Object.entries(service.env)) {
    if (value.kind === "secret" && value.defaultValue !== undefined) {
      defaults.set(envVarKey, value.defaultValue);
    }
  }
  return Object.fromEntries(defaults);
}

/**
 * Resolves a dev-mode evaluated env record into literal values using the
 * development-environment session's env (which carries the project's
 * credentials). Called by `hexclave dev` after the session exists.
 */
export function resolveDevEnv(service: EvaluatedService, sessionEnv: Record<string, string>): Record<string, string> {
  const resolved = new Map<string, string>();
  for (const [envVarKey, value] of Object.entries(service.env)) {
    switch (value.kind) {
      case "plain": {
        resolved.set(envVarKey, value.value);
        break;
      }
      case "secret": {
        // Secrets are never fetched from the dashboard during dev; the
        // default is all there is. The error fires here (per selected
        // service) rather than at evaluation time, so it only triggers for
        // the service actually being run.
        if (value.defaultValue === undefined) {
          throw new CliError(`The secret ${JSON.stringify(value.secretKey)} (env var ${JSON.stringify(envVarKey)}) has no default value, so it cannot be resolved during \`hexclave dev\`. Add a default (secret(${JSON.stringify(value.secretKey)}, "some-dev-value")) or guard it with isDev (e.g. \`isDev ? null : secret(${JSON.stringify(value.secretKey)})\`).`);
        }
        resolved.set(envVarKey, value.defaultValue);
        break;
      }
      case "connection": {
        if (value.hexclaveOutputKey === undefined) {
          // Unreachable: in dev mode, service() returns null, so non-hexclave
          // connection refs cannot be constructed.
          throw new CliError(`Internal error: env var ${JSON.stringify(envVarKey)} is an unresolved service connection in dev mode.`);
        }
        resolved.set(envVarKey, resolveHexclaveOutputFromSessionEnv(envVarKey, value.hexclaveOutputKey, sessionEnv));
        break;
      }
    }
  }
  return Object.fromEntries(resolved);
}

function resolveHexclaveOutputFromSessionEnv(envVarKey: string, outputKey: HexclaveOutputKey, sessionEnv: Record<string, string>): string {
  const fromSession = (name: string): string => sessionEnv[name] ?? (() => {
    throw new CliError(`Cannot resolve hexclave.${outputKey} for env var ${JSON.stringify(envVarKey)}: the development-environment session did not provide ${name}.`);
  })();
  switch (outputKey) {
    case "projectId": {
      return fromSession("HEXCLAVE_PROJECT_ID");
    }
    case "apiUrl": {
      return fromSession("HEXCLAVE_API_URL");
    }
    case "jwksUrl": {
      const apiUrl = fromSession("HEXCLAVE_API_URL");
      const projectId = fromSession("HEXCLAVE_PROJECT_ID");
      return `${apiUrl.replace(/\/$/, "")}/api/v1/projects/${projectId}/.well-known/jwks.json`;
    }
    case "publishableClientKey": {
      return fromSession("HEXCLAVE_PUBLISHABLE_CLIENT_KEY");
    }
    case "secretServerKey": {
      return fromSession("HEXCLAVE_SECRET_SERVER_KEY");
    }
  }
}

/**
 * Loads a TypeScript/JavaScript module via jiti. Shared by the deploy-file and
 * config-file loaders below so both fail with the same error on an unloadable
 * file; `description` names which of the two it was.
 */
async function importModule(filePath: string, description: string): Promise<Record<string, unknown>> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  try {
    return await jiti.import(filePath) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new CliError(`Failed to load ${description} ${filePath}: ${errorMessage(error)}`);
  }
}

/**
 * Loads a deploy file (hexclave.deploy.ts) and returns the two exports that make
 * it one: the deployment group id, and the `deploy` function. The old name of
 * the first (`id`) comes back too, so evaluation can name the rename instead of
 * reporting a missing export.
 */
export async function importDeployModule(deployFilePath: string): Promise<{ deploymentGroupId: unknown, legacyId: unknown, deploy: unknown }> {
  const module = await importModule(deployFilePath, "deploy file");
  return { deploymentGroupId: module.deploymentGroupId, legacyId: module.id, deploy: module.deploy };
}

/**
 * Loads a config file (hexclave.config.ts) and returns its `config` export, plus
 * a `deploy` export if it has one — a project small enough to keep its
 * services in the config file may declare them there instead of in a deploy
 * file. Those services belong to a deployment group named after the file (the
 * config file has no `deploymentGroupId` export of its own), so they can coexist
 * with the deploy files of other repositories deploying into the same project.
 */
export async function importConfigModule(configPath: string): Promise<{ config: unknown, deploy: unknown }> {
  const module = await importModule(configPath, "config file");
  return { config: module.config, deploy: module.deploy };
}
