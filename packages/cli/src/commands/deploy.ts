import { CONFIG_FILE_DEPLOYMENT_SOURCE_ID, buildSourceManifest, connectionRequiresTargetDeployed, deploymentPortEntries, deploymentPortOwnsStandardPorts, deploymentServiceIsBuilt, deploymentServiceUsesGeneratedDockerfile, parseConnectionValue, type DeploymentSourceManifest } from "@hexclave/shared/dist/deployments";
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { getInternalUser } from "../lib/app.js";
import { createUrlIfValid } from "@hexclave/shared/dist/utils/urls";
import { isProjectAuthWithSecretServerKey, resolveAuth, resolveProjectId, type ProjectAuth } from "../lib/auth.js";
import { AuthError, CliError, errorMessage } from "../lib/errors.js";
import { followBuildLogs, type FollowBuildLogsOptions } from "../lib/build-logs.js";
import { packageSourceDirectory } from "../lib/source-packaging.js";
import { formatDuration, uploadSource, uploadSourceMultipart, type MultipartUploadSlot } from "../lib/source-upload.js";
import { collectSecretDefaults, computeDeploymentLevels, evaluateDeploymentConfig, hasDeployFile, importConfigModule, importDeployModule, resolveDeployFilePath, type EvaluatedService } from "../lib/deployment-config.js";
import { buildConfigPushSource, parseConfigOverride, pushConfigToProject } from "./config-file.js";

// The names checked (in order) when --config-file is not passed with
// --config-push; same preference order as `hexclave config push`'s pull-side
// resolution.
const CONFIG_FILE_CANDIDATES = ["hexclave.config.ts", "hexclave.config.js", "stack.config.ts", "stack.config.js"];

const RUN_POLL_INTERVAL_MS = 3_000;
// Generous cap so a wedged remote build doesn't hang CI forever; the remote
// builder's own hard timeout is 15 minutes.
const RUN_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
// How long the deploy waits for the build-log follower to finish writing after
// the deployment itself is done. Bounded so a wedged log stream can only ever
// delay the summary, never withhold it.
const BUILD_LOG_DRAIN_TIMEOUT_MS = 15_000;

export type DeployOptions = {
  serviceId?: string,
  deployFile?: string,
  configFile?: string,
  cloudProjectId?: string,
  // Opt-in: pushing the project's configuration is a separate concern from
  // deploying this repository's services, and several repositories can deploy
  // into one project — so a deploy must not silently publish whichever config
  // file happens to sit next to the deploy file.
  configPush?: boolean,
  // Commander's `--no-build-logs`: undefined/true stream the remote build's
  // output into this terminal, false leaves the deploy reporting status only.
  buildLogs?: boolean,
};

/**
 * Resolves the project config file for `--config-push`: --config-file wins (and
 * must exist); otherwise the first existing candidate in cwd. Returns null when
 * nothing was passed and no candidate exists. Exported for unit tests.
 */
export function resolveConfigPushPath(configOption: string | undefined, cwd: string): string | null {
  if (configOption != null && configOption !== "") {
    const resolved = path.resolve(cwd, configOption);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new CliError(`Config file not found: ${resolved}`);
    }
    return resolved;
  }
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const resolved = path.resolve(cwd, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

/**
 * The secret keys that MUST have a stored value for these services to deploy:
 * every secret referenced without a default value. Exported for unit tests.
 */
export function collectRequiredSecretKeys(services: EvaluatedService[]): string[] {
  const requiredKeys = new Set<string>();
  for (const service of services) {
    for (const value of Object.values(service.env)) {
      if (value.kind === "secret" && value.defaultValue === undefined) {
        requiredKeys.add(value.secretKey);
      }
    }
  }
  return [...requiredKeys].sort();
}

// Returns a FACTORY rather than a fixed header object: the deploy flow can
// span minutes (large uploads, remote builds), and the refresh-token path's
// access token may expire mid-flow. getTokens() transparently refreshes when
// needed, so calling the factory per request always yields a valid token; the
// secret-server-key path is static.
async function buildAuthHeadersFactory(auth: ProjectAuth): Promise<() => Promise<Record<string, string>>> {
  if (isProjectAuthWithSecretServerKey(auth)) {
    const headers = {
      "x-stack-access-type": "server",
      "x-stack-project-id": auth.projectId,
      "x-stack-secret-server-key": auth.secretServerKey,
    };
    return () => Promise.resolve(headers);
  }
  // Refresh-token auth: the admin access token for a project is simply the
  // internal-project access token of a user who owns it.
  const user = await getInternalUser(auth);
  return async () => {
    const { accessToken } = await user.currentSession.getTokens();
    if (accessToken == null) {
      throw new AuthError("Could not obtain an access token. Run `hexclave login` again.");
    }
    return {
      "x-stack-access-type": "admin",
      "x-stack-project-id": auth.projectId,
      "x-stack-admin-access-token": accessToken,
    };
  };
}

// Returns `any` on purpose: this is a thin JSON transport; each call site
// immediately validates the specific fields it needs (and errors cleanly on
// unexpected shapes), so a structural type here would just duplicate that.
async function deployApiFetch(auth: ProjectAuth, getAuthHeaders: () => Promise<Record<string, string>>, apiPath: string, init: {
  method: string,
  jsonBody?: unknown,
}): Promise<any> {
  const url = `${auth.apiUrl.replace(/\/$/, "")}/api/latest${apiPath}`;
  const response = await fetch(url, {
    method: init.method,
    headers: {
      ...await getAuthHeaders(),
      ...(init.jsonBody !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === "string") message = parsed.error;
      else if (typeof parsed?.error?.message === "string") message = parsed.error.message;
    } catch {
      // Response body isn't JSON; use it as-is.
    }
    throw new CliError(`Deploy request failed (${response.status} at ${init.method} ${apiPath}): ${message.slice(0, 1000)}`);
  }
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new CliError(`Unexpected non-JSON response from the Hexclave API at ${init.method} ${apiPath}.`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Awaits `promise`, giving up after `ms`. The timer is cleared either way, so
 * winning the race doesn't leave a pending timeout holding the process open for
 * the rest of the window.
 */
async function awaitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const timeout = new Promise<void>((resolvePromise) => {
    timer = setTimeout(resolvePromise, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    // Cleared whichever side won: a pending timer would otherwise hold the
    // event loop open for the rest of the window after a fast drain.
    clearTimeout(timer);
  }
}

/**
 * followBuildLogs, with any failure of the log stream ITSELF reduced to a
 * warning. Wrapped rather than left bare because this promise is only awaited
 * once the deploy is over: an unhandled rejection in the meantime would be
 * reported as a crash, and a build log that cannot be read is a degraded
 * deploy, never a failed one.
 */
async function followBuildLogsSafely(options: FollowBuildLogsOptions): Promise<void> {
  try {
    await followBuildLogs(options);
  } catch (error) {
    console.error(`Warning: stopped streaming the build logs (${errorMessage(error)}). They are still readable in the dashboard.`);
  }
}

/** The build-log endpoint for one deployment. */
export function deploymentBuildLogsUrl(apiUrl: string, deploymentId: string): string {
  return `${apiUrl.replace(/\/$/, "")}/api/latest/deployments/deployments/${encodeURIComponent(deploymentId)}/logs`;
}

export function collectPublicUrls(deploySet: string[], services: Map<string, EvaluatedService>, results: Map<string, ServiceDeployResult>) {
  return deploySet.flatMap((serviceId) => {
    const service = services.get(serviceId) ?? (() => {
      throw new CliError(`Internal error: deploy set contains unknown service ${JSON.stringify(serviceId)}.`);
    })();
    const result = results.get(serviceId) ?? (() => {
      throw new CliError(`Internal error: no deploy result for service ${JSON.stringify(serviceId)}.`);
    })();
    // Only a public service has a URL to report, and a public one is all-HTTP,
    // so every port it declares is one to show.
    if (service.definition.public !== true || result.status !== "deployed" || result.url === null) return [];
    // `result.url` is the standard-ports holder's URL, which is why it carries no
    // port. Every OTHER port answers at its own number on the same host, so it
    // gets a line of its own — otherwise a second port would simply not appear
    // anywhere the author looks.
    const holderUrl = result.url;
    return deploymentPortEntries(service.definition.ports)
      .map((entry) => deploymentPortOwnsStandardPorts(service.definition.ports, true, entry.port)
        ? { serviceId, url: holderUrl }
        : { serviceId, url: `${holderUrl}:${entry.port}` });
  });
}

/**
 * Where to read this deployment in the dashboard.
 *
 * The deployments page keeps its selection in the URL, so this can open the
 * exact thing a reader wants: the deployment's service map, or one service's
 * build log. `panel` is the dashboard's own tab id, not a name invented here.
 */
export function deploymentDashboardUrl(options: {
  dashboardUrl: string,
  projectId: string,
  deploymentId: string,
  /** The service to open. Null opens the deployment's service map instead. */
  serviceId?: string | null,
  /** Whether to land on that service's build log rather than its overview. */
  buildLogs?: boolean,
}): string {
  const params = new URLSearchParams({ deploymentId: options.deploymentId });
  if (options.serviceId != null && options.serviceId !== "") {
    params.set("serviceId", options.serviceId);
    if (options.buildLogs === true) params.set("panel", "build-logs");
  }
  const route = `/projects/${encodeURIComponent(options.projectId)}/deployments`;
  // Built through URL, not interpolated: a configured base carrying a query or
  // fragment would otherwise swallow the whole route into it and the link would
  // not navigate anywhere. Same shape as onboardingUrlFor in lib/app.ts, which
  // solved this first — including the fallback, because a configured dashboard
  // URL is unvalidated and this is printed, never fetched, so it must not throw.
  const parsed = createUrlIfValid(options.dashboardUrl);
  if (parsed == null) {
    return `${options.dashboardUrl.replace(/\/+$/, "")}${route}?${params.toString()}`;
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}${route}`;
  parsed.search = params.toString();
  parsed.hash = "";
  return parsed.toString();
}

/**
 * The service whose build log the reader is about to go looking for: the first
 * one that failed, in the order the deploy applied them. Null when none did.
 *
 * The FIRST rather than every one, because a level's failure skips everything
 * after it — later failures are consequences, and the first is the cause.
 */
export function firstFailedService(deploySet: string[], results: Map<string, ServiceDeployResult>): string | null {
  return deploySet.find((serviceId) => results.get(serviceId)?.status === "failed") ?? null;
}

export type ServiceDeployResult = {
  serviceId: string,
  status: "deployed" | "failed" | "skipped" | "pending" | "building" | "deploying",
  url: string | null,
  error: string | null,
};

/**
 * Packages the deployment source ONCE and uploads it. Every service is built
 * from this one tree by one builder machine, so there is one upload per deploy
 * rather than one per service — and a service can reach shared code above its
 * own directory, which per-service packaging made impossible.
 */
export async function packageAndUploadSource(options: {
  auth: ProjectAuth,
  authHeaders: () => Promise<Record<string, string>>,
  sourceRoot: string,
  services: Map<string, EvaluatedService>,
  // The services this deploy actually ships. The UPLOAD is still the whole tree
  // — one deploy is one tarball — but only these are pre-flighted: a
  // `--service-id web` deploy must not fail over a sibling whose directory is
  // missing from a sparse checkout, since nothing is going to build it. Absent =
  // every service, which is what a full deploy passes.
  deploySet?: string[],
}): Promise<{ uploadId: string, manifest: DeploymentSourceManifest }> {
  const { auth, authHeaders, sourceRoot, services, deploySet } = options;
  const packaged = packageSourceDirectory(sourceRoot);

  const preflightServices = deploySet === undefined
    ? [...services.values()]
    : deploySet.flatMap((serviceId) => {
      const service = services.get(serviceId);
      return service === undefined ? [] : [service];
    });
  for (const service of preflightServices) {
    // A service that only runs an already-built image is not built from this
    // tree at all, so neither the Dockerfile pre-flight nor the Railpack note
    // below applies to it — and a stray Dockerfile beside it is not a mistake.
    if (!deploymentServiceIsBuilt(service.definition)) continue;
    // The root directory has to exist in the PACKAGED tree, or the build fails
    // in the remote builder minutes later with nothing to look at. Only checked
    // for services that are built from it (the loop above skips the rest), and
    // only when it names something other than the upload root, which is the
    // tarball itself.
    const rootDirectory = service.definition.root_directory ?? ".";
    const normalizedRootDirectory = rootDirectory.replace(/^\.\//, "").replace(/\/$/, "");
    if (normalizedRootDirectory !== "" && normalizedRootDirectory !== "." && !packaged.paths.some((entry) => entry.startsWith(`${normalizedRootDirectory}/`))) {
      throw new CliError(fs.existsSync(path.join(sourceRoot, normalizedRootDirectory))
        ? `services.${service.serviceId} declares rootDirectory ${JSON.stringify(rootDirectory)}, but nothing under it is in the packaged source — check your .dockerignore/.gitignore.`
        : `services.${service.serviceId} declares rootDirectory ${JSON.stringify(rootDirectory)}, but there is no such directory under ${sourceRoot}.`);
    }
    const dockerfilePath = service.definition.dockerfile_path;
    // A generated Dockerfile is built from the base image and the build command,
    // so there is no Dockerfile to look for and no auto-detection to warn about.
    if (deploymentServiceUsesGeneratedDockerfile(service.definition)) continue;
    if (dockerfilePath === undefined) {
      // No dockerfilePath means Railpack auto-detection — an existing Dockerfile is
      // deliberately NOT picked up implicitly, so say so instead of silently ignoring it.
      const rootDirectory = service.definition.root_directory ?? ".";
      const candidate = rootDirectory === "." ? "Dockerfile" : `${rootDirectory.replace(/^\.\//, "").replace(/\/$/, "")}/Dockerfile`;
      if (packaged.paths.includes(candidate)) {
        // `dockerfilePath` is written relative to the service's root directory,
        // so the value to suggest is the bare "Dockerfile" even though the file
        // sits at `candidate` within the upload.
        console.error(`Note: the source contains ${candidate}, but services.${service.serviceId} does not set dockerfilePath, so its image will be built with Railpack auto-detection (https://railpack.com) instead. Set dockerfilePath: "Dockerfile" to build from it.`);
      }
      continue;
    }
    // The declared Dockerfile must be in the PACKAGED source — verified against the actual
    // tar contents (case-exact, after .gitignore/.dockerignore), not just the filesystem, so
    // a missing/ignored/case-mismatched Dockerfile fails before upload rather than minutes
    // later in the remote builder. (Docker never runs locally.)
    if (!packaged.paths.includes(dockerfilePath)) {
      const onDisk = fs.existsSync(path.join(sourceRoot, dockerfilePath));
      // `dockerfilePath` is authored relative to the service's root directory
      // and joined onto it before it gets here, so name both: the value in the
      // deploy file is what has to be edited, and the joined path is what was
      // actually looked for.
      const declared = `dockerfilePath ${JSON.stringify(service.authoredDockerfilePath ?? dockerfilePath)}`;
      const resolved = service.authoredDockerfilePath === dockerfilePath ? "" : ` (${dockerfilePath}, relative to its rootDirectory ${JSON.stringify(service.definition.root_directory ?? ".")})`;
      throw new CliError(onDisk
        ? `services.${service.serviceId} declares ${declared}${resolved} but that file isn't in the packaged source — check your .dockerignore/.gitignore (and that the path matches the filename case-exactly).`
        : `services.${service.serviceId} declares ${declared}${resolved}, but there is no such file under ${sourceRoot}.`);
    }
  }
  console.error(`Packaged ${packaged.fileCount} files (${(packaged.tarballGzipped.length / 1024).toFixed(1)} KiB compressed) from ${sourceRoot}.`);

  // The size is declared up front so the API can decide whether to hand back a
  // multipart slot: below its threshold one PUT is fewer round trips, and above
  // it a single connection is too long-lived to survive a lossy link.
  const upload = await deployApiFetch(auth, authHeaders, "/deployments/uploads", {
    method: "POST",
    jsonBody: { size_bytes: packaged.tarballGzipped.length },
  });
  if (typeof upload?.id !== "string" || typeof upload?.upload_url !== "string" || typeof upload?.content_type !== "string") {
    throw new CliError("Unexpected response from the Hexclave API when creating the upload.");
  }
  if (typeof upload.max_bytes === "number" && packaged.tarballGzipped.length > upload.max_bytes) {
    throw new CliError(`The packaged source is too large (${packaged.tarballGzipped.length} bytes, max ${upload.max_bytes}). Check your .gitignore/.dockerignore — build outputs and large assets shouldn't be uploaded.`);
  }
  const multipart = parseMultipartSlot(upload.multipart);
  const uploadOptions = {
    uploadUrl: upload.upload_url,
    contentType: upload.content_type,
    bytes: packaged.tarballGzipped,
    // The slot's own expiry is the upload's deadline — see source-upload.ts.
    expiresAtMillis: typeof upload.expires_at_millis === "number" ? upload.expires_at_millis : null,
    // A retry re-sends a whole part (or, without multipart, the whole tarball),
    // which is minutes of apparent silence on a big source — so say that it is
    // happening and why. Only the first line: the rest of an upload error is
    // advice that a retry is already acting on, and repeating it every attempt
    // would bury the one thing that changes.
    onRetry: ({ attempt, maxAttempts, error, delayMs }: { attempt: number, maxAttempts: number, error: Error, delayMs: number }) => {
      console.error(`Upload attempt ${attempt} of ${maxAttempts} failed: ${error.message.split("\n")[0]}`);
      console.error(`Retrying in ${formatDuration(delayMs)}...`);
    },
  };
  if (multipart === null) {
    console.error("Uploading source...");
    await uploadSource(uploadOptions);
  } else {
    const partCount = multipart.part_urls.length;
    console.error(`Uploading source in ${partCount} parts...`);
    await uploadSourceMultipart({
      ...uploadOptions,
      multipart,
      onPartUploaded: ({ part }) => console.error(`  uploaded ${part}/${partCount}`),
    });
  }
  // Recorded with the deployment because the tarball is not: the build consumes
  // it and it is deleted, so a listing of what went in is the only thing left
  // to answer "why was this upload 39 MB" after the fact.
  return {
    uploadId: upload.id,
    manifest: buildSourceManifest({ files: packaged.files, compressedBytes: packaged.tarballGzipped.length }),
  };
}

/**
 * The multipart slot from an upload response, or null to use the single PUT.
 *
 * Null rather than an error whenever the shape is not exactly right: multipart
 * is an optimisation over a `upload_url` that is always returned, so an API that
 * omits it, is older than it, or returns something unusable must fall back
 * rather than fail the deploy.
 */
function parseMultipartSlot(value: unknown): MultipartUploadSlot | null {
  if (value === null || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  const partUrls = slot.part_urls;
  if (typeof slot.part_size_bytes !== "number" || slot.part_size_bytes <= 0) return null;
  if (!Array.isArray(partUrls) || partUrls.length === 0 || !partUrls.every((url) => typeof url === "string")) return null;
  if (typeof slot.complete_url !== "string" || typeof slot.abort_url !== "string") return null;
  return {
    part_size_bytes: slot.part_size_bytes,
    part_urls: partUrls as string[],
    complete_url: slot.complete_url,
    abort_url: slot.abort_url,
  };
}

/**
 * Follows a deployment to its terminal state, reporting each service as it
 * changes. Polling spans many minutes, so transient failures (a network blip, a
 * 5xx from the API) must not kill the deploy — only several CONSECUTIVE ones do.
 */
async function waitForDeployment(options: {
  auth: ProjectAuth,
  authHeaders: () => Promise<Record<string, string>>,
  deploymentId: string,
}): Promise<{ status: string, error: string | null, services: ServiceDeployResult[] }> {
  const { auth, authHeaders, deploymentId } = options;
  const startedAtMs = performance.now();
  let consecutivePollFailures = 0;
  let lastLoggedStatus: string | null = null;
  const lastLoggedServiceStatus = new Map<string, string>();
  while (true) {
    let deployment: any;
    try {
      deployment = await deployApiFetch(auth, authHeaders, `/deployments/deployments/${encodeURIComponent(deploymentId)}`, { method: "GET" });
      consecutivePollFailures = 0;
    } catch (error) {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new CliError(`Polling the deployment failed ${consecutivePollFailures} times in a row: ${errorMessage(error)}\nThe build may still be running — check the deployment in the dashboard.`);
      }
      console.error(`Polling the deployment failed (attempt ${consecutivePollFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}), retrying: ${errorMessage(error)}`);
      await wait(RUN_POLL_INTERVAL_MS);
      continue;
    }

    const status = typeof deployment?.status === "string" ? deployment.status : "unknown";
    if (status !== lastLoggedStatus && (status === "queued" || status === "building" || status === "deploying")) {
      console.error(status === "building" ? "Building every service in one builder..." : `Deployment ${status}...`);
      lastLoggedStatus = status;
    }
    const services: ServiceDeployResult[] = (Array.isArray(deployment?.services) ? deployment.services : []).map((service: any) => ({
      serviceId: typeof service?.service_id === "string" ? service.service_id : "unknown",
      status: service?.status ?? "pending",
      url: typeof service?.url === "string" ? service.url : null,
      error: typeof service?.error === "string" ? service.error : null,
    }));
    for (const service of services) {
      if (lastLoggedServiceStatus.get(service.serviceId) === service.status) continue;
      lastLoggedServiceStatus.set(service.serviceId, service.status);
      if (service.status === "deploying" || service.status === "deployed" || service.status === "failed") {
        console.error(`[${service.serviceId}] ${service.status}${service.url != null ? `: ${service.url}` : ""}${service.error != null ? ` — ${service.error}` : ""}`);
      }
    }

    if (status === "deployed" || status === "failed" || status === "canceled") {
      return { status, error: typeof deployment?.error === "string" ? deployment.error : null, services };
    }
    if (performance.now() - startedAtMs > RUN_POLL_TIMEOUT_MS) {
      throw new CliError(`Timed out waiting for the deployment. Check its status in the dashboard.`);
    }
    await wait(RUN_POLL_INTERVAL_MS);
  }
}

/** Transitive dependents of `failedServiceId`, by connection edges within this deploy. */
function collectTransitiveDependents(failedServiceId: string, services: Map<string, EvaluatedService>): Set<string> {
  const directDependents = new Map<string, Set<string>>();
  for (const [serviceId, service] of services) {
    for (const value of Object.values(service.env)) {
      if (value.kind !== "connection") continue;
      const parsed = parseConnectionValue(value.reference);
      if (parsed === null) continue;
      // Services of another deployment source are not part of this deploy, so
      // they can neither fail in it nor be skipped by it.
      if (!services.has(parsed.serviceId)) continue;
      // Same rule as computeDeploymentLevels: only a reference that needed its
      // target deployed makes its holder a dependent of it.
      if (!connectionRequiresTargetDeployed(parsed.outputKey)) continue;
      const dependents = directDependents.get(parsed.serviceId) ?? new Set<string>();
      dependents.add(serviceId);
      directDependents.set(parsed.serviceId, dependents);
    }
  }
  const result = new Set<string>();
  const queue = [failedServiceId];
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    for (const dependent of directDependents.get(current) ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return result;
}

/**
 * What this deploy ships: a deploy file when there is one, otherwise the config
 * file, for a project small enough to keep its services there. The config file
 * has no `deploymentGroupId` export, so its deployments belong to a group named
 * after the file itself — which is what lets them coexist with the deploy files
 * of other repositories deploying into the same project.
 */
async function resolveDeploySource(deployFileOption: string | undefined, cwd: string): Promise<{
  path: string,
  deploymentGroupIdExport: unknown,
  // The deploy file's `id` export, if it still uses that old name. Only a deploy
  // file can have one; the config file's group id is the file name.
  legacyIdExport?: unknown,
  deployExport: unknown,
}> {
  if (deployFileOption == null || deployFileOption === "") {
    const configPath = resolveConfigPushPath(undefined, cwd);
    // Only if there is no deploy file at all: a repository that has both keeps
    // its services in the deploy file, and silently preferring the config file's
    // would deploy something other than what the author is editing.
    if (configPath !== null && !hasDeployFile(cwd)) {
      const configModule = await importConfigModule(configPath);
      if (configModule.deploy !== undefined) {
        return { path: configPath, deploymentGroupIdExport: CONFIG_FILE_DEPLOYMENT_SOURCE_ID, deployExport: configModule.deploy };
      }
    }
  }
  const deployFilePath = resolveDeployFilePath(deployFileOption, cwd);
  const deployModule = await importDeployModule(deployFilePath);
  return { path: deployFilePath, deploymentGroupIdExport: deployModule.deploymentGroupId, legacyIdExport: deployModule.legacyId, deployExport: deployModule.deploy };
}

export function registerDeployCommand(program: Command) {
  program
    .command("deploy")
    .description("Deploy the services defined by the `deploy` export of your hexclave.deploy.ts. Syncs the service definitions, then deploys every service in dependency order and waits for the remote builds to finish.")
    .option("--service-id <id>", "Deploy only this service (its connections resolve against already-deployed services)")
    .option("--deploy-file <path>", "Path to the deploy file (default: auto-discover hexclave.deploy.ts in the current directory)")
    .option("--config-push", "Also push the project config file's `config` export to the project before deploying")
    .option("--config-file <path>", "Path to the project config file for --config-push (default: auto-discover hexclave.config.ts in the current directory)")
    .option("--cloud-project-id <id>", "Hexclave project ID to deploy to (defaults to the HEXCLAVE_PROJECT_ID env var)")
    .option("--no-build-logs", "Don't stream the remote build's output; report service status only")
    .addHelpText("after", "\nAuthentication: uses HEXCLAVE_SECRET_SERVER_KEY if set (recommended for CI), otherwise your `hexclave login` session.\nSecrets: values for secret() env vars are read from the dashboard (Project Settings > Secrets); the deploy fails up front and lists every secret that still needs a value there.")
    .action(async (opts: DeployOptions) => {
      const auth = resolveAuth(resolveProjectId(opts.cloudProjectId));
      const authHeaders = await buildAuthHeadersFactory(auth);

      // A deploy file if there is one; otherwise the config file, for a project
      // that keeps its services there. The config file has no `deploymentGroupId`
      // export, so its deployments belong to a group named after the file itself.
      const deploySource = await resolveDeploySource(opts.deployFile, process.cwd());
      const { sourceId, services } = evaluateDeploymentConfig({
        deployFilePath: deploySource.path,
        deploymentGroupIdExport: deploySource.deploymentGroupIdExport,
        legacyIdExport: deploySource.legacyIdExport,
        deployExport: deploySource.deployExport,
        mode: "deploy",
      });

      // The cycle check only matters when the whole graph deploys — a
      // single-service deploy resolves its connections against already-
      // deployed state, so a cycle elsewhere in the config must not block it.
      let levels: string[][];
      if (opts.serviceId != null) {
        const service = services.get(opts.serviceId);
        if (service == null) {
          throw new CliError(`No service named ${JSON.stringify(opts.serviceId)} in the deploy file's \`deploy\` export. Available services: ${[...services.keys()].join(", ")}.`);
        }
        levels = [[opts.serviceId]];
      } else {
        levels = computeDeploymentLevels(services);
      }
      const deploySet = levels.flat();

      // Pre-flight: every secret without a default must have a stored value
      // BEFORE anything is packaged or uploaded. The backend re-checks this
      // authoritatively per deploy.
      const requiredSecretKeys = collectRequiredSecretKeys(deploySet.map((serviceId) => services.get(serviceId) ?? (() => {
        throw new CliError(`Internal error: deploy set contains unknown service ${JSON.stringify(serviceId)}.`);
      })()));
      if (requiredSecretKeys.length > 0) {
        const storedSecrets = await deployApiFetch(auth, authHeaders, "/project-secrets", { method: "GET" });
        const storedKeys = new Set<string>(
          (Array.isArray(storedSecrets?.items) ? storedSecrets.items : [])
            .map((item: any) => item?.key)
            .filter((key: unknown): key is string => typeof key === "string"),
        );
        const missing = requiredSecretKeys.filter((key) => !storedKeys.has(key));
        if (missing.length > 0) {
          // One error listing EVERY missing key, not one per key: fixing these
          // means a trip to the dashboard, and finding out about the second
          // missing secret only after setting the first would mean a round
          // trip per secret.
          throw new CliError([
            `Missing ${missing.length === 1 ? "a value" : "values"} for ${missing.length === 1 ? "this secret" : `these ${missing.length} secrets`}:`,
            ...missing.map((key) => `  - ${key}`),
            "",
            "All of them must be set in the dashboard under Project Settings > Secrets before this deploy can run.",
          ].join("\n"));
        }
      }

      // Config push is OPT-IN. A project can be deployed from several
      // repositories, and each push replaces the project's whole configuration —
      // so a deploy that published it by default would let any of those
      // repositories silently overwrite the others' config with its own.
      if (opts.configPush === true) {
        const configPath = resolveConfigPushPath(opts.configFile, process.cwd());
        if (configPath == null) {
          throw new CliError(`--config-push was passed, but no config file was found in ${process.cwd()} (looked for ${CONFIG_FILE_CANDIDATES.join(", ")}). Pass --config-file <path>, or drop --config-push to deploy without publishing the project config.`);
        }
        const configModule = await importConfigModule(configPath);
        if (configModule.config === undefined) {
          throw new CliError(`--config-push was passed, but ${configPath} has no \`config\` export. Add one, or drop --config-push.`);
        }
        const config = parseConfigOverride(configModule.config);
        if (config == null) {
          throw new CliError(`The \`config\` export of ${configPath} must be a plain object (or "show-onboarding"). Fix it, or drop --config-push to deploy without pushing the config.`);
        }
        console.error("Pushing config...");
        // The GitHub-Actions auto-detection inside buildConfigPushSource
        // records this path verbatim as the repo-relative config_file_path,
        // so pass a cwd-relative posix path, not the resolved absolute one
        // (which would bake the runner's filesystem layout into the source).
        const relativeConfigPath = path.relative(process.cwd(), configPath).split(path.sep).join("/");
        await pushConfigToProject(auth, config, buildConfigPushSource(relativeConfigPath, {}));
      }

      // Sync ALL definitions (even for a --service-id deploy) so the server sees
      // the deploy file's whole truth: services it no longer declares are torn
      // down here, and syncing only a subset would read as "the rest were
      // removed".
      console.error(`Syncing ${services.size} service definition${services.size === 1 ? "" : "s"} for deployment source ${JSON.stringify(sourceId)}...`);
      const syncResponse = await deployApiFetch(auth, authHeaders, "/deployments/services", {
        method: "PUT",
        jsonBody: {
          source_id: sourceId,
          services: Object.fromEntries([...services.values()].map((service) => [service.serviceId, service.definition])),
        },
      });
      if (typeof syncResponse?.sync_id !== "string") {
        throw new CliError("Unexpected response from the Hexclave API when syncing service definitions.");
      }
      const definitionSyncId = syncResponse.sync_id;
      const removedServiceIds: string[] = Array.isArray(syncResponse.removed_service_ids) ? syncResponse.removed_service_ids : [];
      for (const serviceId of removedServiceIds) {
        console.error(`Removed ${serviceId}: it is no longer declared in this deploy file. Its persistent volume and any custom domain were kept, unattached.`);
      }

      // ONE upload for the whole deployment source, and one build of every
      // service from it — but only if anything is actually built. A deploy set
      // that is entirely prebuilt images has nothing to send: no packaging, no
      // upload, and no builder machine on the other end.
      //
      // Keyed on the DEPLOY SET rather than on the whole file, so
      // `hexclave deploy --service-id database` skips the upload even in a repo
      // whose other services are built from source.
      // Resolved explicitly rather than with `?.`: a deploy-set id that is not a
      // known service is impossible (the set comes from `services`), and letting
      // it read as "source-built" would package an upload for nothing and defer
      // the real error to the API. Same shape as the two other lookups here.
      const buildsFromSource = deploySet.some((serviceId) => deploymentServiceIsBuilt((services.get(serviceId) ?? (() => {
        throw new CliError(`Internal error: deploy set contains unknown service ${JSON.stringify(serviceId)}.`);
      })()).definition));
      const sourceRoot = path.dirname(deploySource.path);
      // Undefined for an all-prebuilt deploy: nothing is packaged, so there is
      // no upload and no manifest to report.
      const packagedSource = buildsFromSource
        ? await packageAndUploadSource({ auth, authHeaders, sourceRoot, services, deploySet })
        : undefined;

      console.error("Starting deployment...");
      const deploymentResponse = await deployApiFetch(auth, authHeaders, "/deployments/deployments", {
        method: "POST",
        jsonBody: {
          source_id: sourceId,
          // Omitted entirely when nothing is built from source; the backend
          // requires it exactly when at least one service needs a build.
          ...(packagedSource === undefined ? {} : {
            upload_id: packagedSource.uploadId,
            source_manifest: packagedSource.manifest,
          }),
          definition_sync_id: definitionSyncId,
          levels,
          // The `secret()` defaults ride along with the deploy instead of being
          // synced with the definition: they are a deploy-file concept, and
          // storing them would make the dashboard's secrets page report a value
          // that isn't actually stored anywhere.
          secret_defaults: Object.fromEntries(deploySet.map((serviceId) => [
            serviceId,
            collectSecretDefaults(services.get(serviceId) ?? (() => {
              throw new CliError(`Internal error: deploy set contains unknown service ${JSON.stringify(serviceId)}.`);
            })()),
          ])),
          triggered_by: "cli",
        },
      });
      if (typeof deploymentResponse?.id !== "string") {
        throw new CliError("Unexpected response from the Hexclave API when starting the deployment.");
      }
      const deploymentId = deploymentResponse.id;
      console.error(`Deployment #${deploymentResponse.number} started. ${buildsFromSource ? "Waiting for the remote build..." : "Nothing to build — waiting for the services to come up..."}`);

      // Stream the remote build's output into this terminal while it runs. A
      // deploy is mostly one long remote build, and until now the only way to
      // see what it was doing was to open the dashboard — which is no help at
      // all in CI, where the build output IS the reason the job failed.
      //
      // Skipped when nothing is built from source (an all-prebuilt deploy has
      // no builder and no log), and opt-out via --no-build-logs for callers that
      // only want the status lines.
      const streamBuildLogs = buildsFromSource && opts.buildLogs !== false;
      // Flipped the moment the deployment reaches a terminal state, which is
      // what bounds the follower: the build cannot still be producing output
      // once the deploy is over.
      let deploymentFinished = false;
      const buildLogsAbort = new AbortController();
      const buildLogsFollower = streamBuildLogs
        ? followBuildLogsSafely({
          url: deploymentBuildLogsUrl(auth.apiUrl, deploymentId),
          getAuthHeaders: authHeaders,
          isDeploymentFinished: () => deploymentFinished,
          // Build output goes to stderr with everything else the deploy reports,
          // so stdout stays exactly the JSON summary and nothing more.
          write: (line) => console.error(line),
          signal: buildLogsAbort.signal,
        })
        : null;

      // try/finally: the deployment row exists from here on, and a client that
      // dies leaves it reading as in-flight forever — so whatever happens, the
      // server has to be told this client has stopped.
      // Known from the moment the deployment row exists, because every exit from
      // here on should be able to hand it over — including the ones that throw.
      const deploymentUrlBase = deploymentDashboardUrl({
        dashboardUrl: auth.dashboardUrl,
        projectId: auth.projectId,
        deploymentId,
      });
      let outcome: { status: string, error: string | null, services: ServiceDeployResult[] };
      try {
        // Nested so the build log always finishes writing BEFORE anything else
        // is printed: the outer catch's dashboard link and the summary below
        // both describe the log, and either one landing in the middle of it
        // would read as part of the build's own output.
        try {
          outcome = await waitForDeployment({ auth, authHeaders, deploymentId });
        } finally {
          deploymentFinished = true;
          if (buildLogsFollower !== null) {
            await awaitAtMost(buildLogsFollower, BUILD_LOG_DRAIN_TIMEOUT_MS);
            // Whether it drained or timed out, it must not write again — a line
            // arriving after the summary would attach itself to the wrong thing.
            buildLogsAbort.abort();
          }
        }
      } catch (error) {
        // A client that stopped waiting has not stopped the DEPLOYMENT: it is
        // still there, still has a log, and is exactly what the user now needs
        // to go and look at. Printed before rethrowing so the link survives an
        // error the caller sees as a failure.
        console.error("");
        console.error("The deployment is still in the dashboard:");
        console.error(`  ${deploymentUrlBase}`);
        throw error;
      } finally {
        // Best-effort, and deliberately swallowing: this is bookkeeping, so a
        // failure here must not replace the real deploy error the caller needs
        // to see, nor turn a successful deploy into a failed one.
        try {
          await deployApiFetch(auth, authHeaders, `/deployments/deployments/${deploymentId}/conclude`, { method: "POST", jsonBody: {} });
        } catch (error) {
          console.error(`Warning: could not mark deployment #${deploymentResponse.number} as concluded (${errorMessage(error)}). Its status in the dashboard may stay in progress.`);
        }
      }

      const results = new Map(outcome.services.map((service) => [service.serviceId, service]));

      // Human summary on stderr, machine-readable summary on stdout.
      console.error("");
      if (outcome.error != null) console.error(`Deployment failed: ${outcome.error}`);
      for (const serviceId of deploySet) {
        const result = results.get(serviceId) ?? { serviceId, status: "pending" as const, url: null, error: null };
        console.error(`  ${serviceId}: ${result.status}${result.url != null ? ` — ${result.url}` : ""}${result.error != null ? ` — ${result.error}` : ""}`);
      }
      // Printed whatever happened. A failed deploy is the obvious case — the
      // build log is the next thing anyone asks for, and this is how they reach
      // it without being told where to click — but a green one has a log worth
      // reading too, and the link is also the shareable name of what just ran.
      //
      // BEFORE collectPublicUrls, which throws when a deploy-set service has no
      // outcome at all (a canceled deploy, or one that failed before every
      // service got a row — the loop above has a `?? pending` fallback for
      // exactly that). Printed after it, the one deploy most in need of the link
      // was the one that never got it.
      const failedService = firstFailedService(deploySet, results);
      // Per-SERVICE, not per-deploy: `buildsFromSource` is true if ANY service
      // builds from source, so a mixed deploy whose PREBUILT service failed
      // would link to a build-logs tab holding a sibling's log — which never
      // mentions the failed service. Worse than not linking to the tab at all.
      const failedServiceDefinition = failedService === null ? undefined : services.get(failedService)?.definition;
      const failedServiceBuilt = failedServiceDefinition !== undefined && deploymentServiceIsBuilt(failedServiceDefinition);
      const deploymentUrl = failedService === null
        ? deploymentUrlBase
        : deploymentDashboardUrl({
          dashboardUrl: auth.dashboardUrl,
          projectId: auth.projectId,
          deploymentId,
          serviceId: failedService,
          buildLogs: failedServiceBuilt,
        });
      console.error("");
      console.error(failedServiceBuilt
        ? `Build logs for ${failedService}:`
        : "View this deployment:");
      console.error(`  ${deploymentUrl}`);

      const publicUrls = collectPublicUrls(deploySet, services, results);
      if (publicUrls.length > 0) {
        console.error("");
        console.error("Public URLs:");
        for (const publicUrl of publicUrls) console.error(`  ${publicUrl.serviceId}: ${publicUrl.url}`);
      }

      console.log(JSON.stringify({
        deploymentId,
        deploymentSourceId: sourceId,
        deploymentUrl,
        status: outcome.status,
        error: outcome.error,
        publicUrls,
        services: Object.fromEntries([...results.values()].map((result) => [result.serviceId, {
          status: result.status,
          url: result.url,
          error: result.error,
        }])),
      }, null, 2));

      if (outcome.status !== "deployed") {
        process.exitCode = 1;
      }
    });
}
