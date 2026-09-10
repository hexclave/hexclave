import { execFileSync, spawn, type ChildProcess } from "child_process";
import { Command } from "commander";
import crossSpawn from "cross-spawn";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { dirname, join, resolve } from "path";
import { DEFAULT_API_URL, DEFAULT_PUBLISHABLE_CLIENT_KEY, resolveLoginConfig } from "../lib/auth.js";
import { forwardSignals } from "../lib/child-process.js";
import { resolveConfigFilePathOption } from "../lib/config-file-path.js";
import { DASHBOARD_SERVER_RELATIVE_PATH, dashboardDirOverride, fetchDashboardManifest, resolveDashboardRuntime, type DashboardManifest } from "../lib/dashboard-release.js";
import { devEnvStatePath, ensureLocalDashboardSecret, readDevEnvState, recordLocalDashboardProcess } from "../lib/dev-env-state.js";
import { CliError, errorMessage } from "../lib/errors.js";
import { DASHBOARD_PORT_ENV_VAR, dashboardPort, dashboardRequest, dashboardUrl, createRemoteDevelopmentEnvironmentSession, type DashboardSessionResponse } from "../lib/local-dashboard.js";
import { startProgress } from "../lib/progress.js";
import { evaluateDeploymentConfig, importDeployModule, resolveDeployFilePath, resolveDevEnv, type EvaluatedService } from "../lib/deployment-config.js";

type ChildCommand = {
  command: string,
  args: string[],
  // True when `command` is a full command LINE that must be run through the
  // platform shell (Windows only — see shellChildCommand).
  shell?: boolean,
};

type DevOptions = {
  configFile?: string,
  deployFile?: string,
  serviceId?: string,
};

type ConfigSyncEventBase = {
  config_file_path: string,
  created_at_millis: number,
};

type ConfigSyncEvent = ConfigSyncEventBase & ({
  status: "syncing",
} | {
  status: "success",
} | {
  status: "error",
  error_message: string,
});

type HeartbeatResponse = {
  ok: true,
  browser_secret_confirmation_code?: string,
  browser_secret_confirmation_code_expires_at_millis?: number,
  config_sync_events?: ConfigSyncEvent[],
};

const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_STOP_POLL_MS = 100;
const DASHBOARD_RESTART_MIN_UPTIME_MS = 5_000;
const DASHBOARD_START_TIMEOUT_MS = 60_000;
const DASHBOARD_STOP_TIMEOUT_MS = 10_000;
const DASHBOARD_FORCE_STOP_TIMEOUT_MS = 2_000;
const DASHBOARD_HEALTH_PATH = "/api/development-environment/health";
const DEV_DASHBOARD_COMMAND_ENV_VAR = "HEXCLAVE_CLI_DEV_DASHBOARD_COMMAND";
const DEV_DASHBOARD_DIST_DIR_ENV_VAR = "HEXCLAVE_DASHBOARD_NEXT_DIST_DIR";
const RDE_DASHBOARD_LOG_PATH_ENV_VAR = "HEXCLAVE_RDE_DASHBOARD_LOG_PATH";
const DASHBOARD_RUNTIME_DIR_NAME = "rde-dashboard-runtime";
const SENTINEL_PREFIX = "STACK_ENV_VAR_SENTINEL_";
const USE_INLINE_ENV_VARS_SENTINEL = "STACK_ENV_VAR_SENTINEL_USE_INLINE_ENV_VARS";
const SENTINEL_REGEX = /STACK_ENV_VAR_SENTINEL(?:_[A-Z0-9_]+)?/g;
const LOG_PREFIX = "[Hexclave] ";
const REQUIRED_DASHBOARD_RUNTIME_ENV_VARS = new Set([
  "NEXT_PUBLIC_STACK_API_URL",
  "NEXT_PUBLIC_BROWSER_STACK_API_URL",
  "NEXT_PUBLIC_SERVER_STACK_API_URL",
  "NEXT_PUBLIC_STACK_DASHBOARD_URL",
  "NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL",
  "NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL",
  "NEXT_PUBLIC_STACK_PROJECT_ID",
  "NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY",
  "NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT",
  "NEXT_PUBLIC_STACK_IS_PREVIEW",
  DASHBOARD_PORT_ENV_VAR,
]);

export function dashboardEnvWithStatePath(env: NodeJS.ProcessEnv, statePath: string): NodeJS.ProcessEnv {
  return {
    ...env,
    STACK_DEV_ENVS_PATH: env.STACK_DEV_ENVS_PATH ?? statePath,
  };
}

type DashboardSessionState = {
  session: DashboardSessionResponse,
  dashboardReachableSinceMs: number,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function splitDevCommandArgs(commandArgs: string[]): ChildCommand {
  if (commandArgs.length === 0) {
    throw new CliError("Missing command. Usage: hexclave dev --config-file <path> -- <command> [args...]");
  }
  const command = commandArgs[0];
  return { command, args: commandArgs.slice(1) };
}

/**
 * Wraps a devCommand string (from the deploy file's `deploy` export) for
 * execution through the platform shell — unlike the `-- <command> [args...]`
 * form, a devCommand is a single command LINE (e.g. "pnpm dev --port 3000")
 * and may use shell syntax. Exported for unit tests.
 */
export function shellChildCommand(commandLine: string, platform: NodeJS.Platform = process.platform): ChildCommand {
  if (platform === "win32") {
    // Passed to spawn(..., { shell: true }) so NODE builds the
    // `cmd.exe /d /s /c "<line>"` invocation with windowsVerbatimArguments.
    // Hand-rolling the cmd argv here would make Node apply MSVCRT escaping to
    // the line (embedded `"` -> `\"`), which cmd.exe does not parse.
    return { command: commandLine, args: [], shell: true };
  }
  return { command: "/bin/sh", args: ["-c", commandLine] };
}

/**
 * The env for the dev child process. Precedence (later wins): the service's
 * env vars from the config file may not shadow the session's credentials — a
 * stale hexclave.* value baked into the config would otherwise break the dev
 * session. Exported for unit tests (the ordering IS the contract).
 */
export function composeDevChildEnv(processEnv: NodeJS.ProcessEnv, serviceEnv: Record<string, string>, sessionEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...processEnv,
    ...serviceEnv,
    ...sessionEnv,
  };
}

export function devDashboardCommandFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const command = env[DEV_DASHBOARD_COMMAND_ENV_VAR]?.trim();
  return command == null || command.length === 0 ? undefined : command;
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString().replace(/\/$/, "");
}

function logDev(message: string): void {
  console.warn(`${LOG_PREFIX}${message}`);
}

function stderrSupportsAnsiColor(): boolean {
  return process.stderr.isTTY && process.env.NO_COLOR == null && process.env.TERM !== "dumb";
}

export function configErrorLogPrefix(supportsColor = stderrSupportsAnsiColor()): string {
  const label = supportsColor ? "\x1b[41;37;1m[CONFIG ERROR]\x1b[0m" : "[CONFIG ERROR]";
  return `${LOG_PREFIX}${label} `;
}

function logDevConfigError(message: string): void {
  console.warn(`${configErrorLogPrefix()}${message}`);
}

function openUrlInBrowser(url: string): boolean {
  try {
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
      return true;
    }
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
      return true;
    }
    execFileSync("xdg-open", [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function maybeOpenOnboardingPage(session: DashboardSessionResponse, port: number): void {
  if (!session.onboarding_outstanding) {
    return;
  }
  const url = `${dashboardUrl(port)}/new-project?project_id=${encodeURIComponent(session.project_id)}`;
  const opened = openUrlInBrowser(url);
  if (opened) {
    logDev(`Onboarding is still pending for project ${session.project_id}. Opened: ${url}`);
  } else {
    logDev(`Onboarding is still pending for project ${session.project_id}. Open this URL manually: ${url}`);
  }
}

function dashboardRuntimeRoot(port: number): string {
  return join(dirname(devEnvStatePath()), `${DASHBOARD_RUNTIME_DIR_NAME}-${port}`);
}

function dashboardLogPath(port: number): string {
  return join(dirname(devEnvStatePath()), `rde-dashboard-${port}.log`);
}

function replaceSentinels(content: string, env: NodeJS.ProcessEnv): string {
  return content.replace(SENTINEL_REGEX, (sentinel) => {
    if (sentinel === USE_INLINE_ENV_VARS_SENTINEL) {
      return "true";
    }
    if (!sentinel.startsWith(SENTINEL_PREFIX)) {
      return sentinel;
    }
    const envVarName = sentinel.slice(SENTINEL_PREFIX.length);
    const value = env[envVarName];
    if (value == null) {
      if (REQUIRED_DASHBOARD_RUNTIME_ENV_VARS.has(envVarName)) {
        throw new CliError(`Missing environment variable ${envVarName} while preparing the bundled dashboard runtime.`);
      }
      return sentinel;
    }
    return value;
  });
}

function replaceDashboardRuntimeSentinels(root: string, env: NodeJS.ProcessEnv): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      replaceDashboardRuntimeSentinels(path, env);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const buffer = readFileSync(path);
    if (!buffer.includes("STACK_ENV_VAR_SENTINEL")) {
      continue;
    }
    writeFileSync(path, replaceSentinels(buffer.toString("utf-8"), env));
  }
}

function dashboardRuntimeLockPath(port: number): string {
  return `${dashboardRuntimeRoot(port)}.lock`;
}

function prepareDashboardRuntime(env: NodeJS.ProcessEnv, port: number, dashboardRoot: string): string {
  if (!existsSync(join(dashboardRoot, DASHBOARD_SERVER_RELATIVE_PATH))) {
    throw new CliError("The Hexclave development-environment dashboard is missing its server entrypoint.");
  }
  const runtimeRoot = dashboardRuntimeRoot(port);
  mkdirSync(dirname(runtimeRoot), { recursive: true });
  rmSync(runtimeRoot, { recursive: true, force: true });
  cpSync(dashboardRoot, runtimeRoot, { recursive: true });
  replaceDashboardRuntimeSentinels(runtimeRoot, env);

  const runtimeServerPath = join(runtimeRoot, DASHBOARD_SERVER_RELATIVE_PATH);
  if (!existsSync(runtimeServerPath)) {
    throw new CliError("The Hexclave development-environment dashboard is missing its server entrypoint.");
  }
  return runtimeServerPath;
}

async function isDashboardReachable(url: string, secret?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }
    const response = await fetch(`${url}${DASHBOARD_HEALTH_PATH}`, { headers });
    if (!secret) {
      // Without a secret we only care whether the port is still bound (used by
      // killLocalDashboard to detect process shutdown), so any HTTP response suffices.
      return true;
    }
    const body: unknown = await response.json();
    return (
      typeof body === "object"
      && body !== null
      && "ok" in body
      && typeof body.ok === "boolean"
      && "restart_command" in body
      && typeof body.restart_command === "string"
    );
  } catch {
    return false;
  }
}

type ParsedVersion = {
  core: [number, number, number],
  hasPrerelease: boolean,
};

function parseVersionCore(version: string): ParsedVersion | null {
  const trimmed = version.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    // A `-` immediately after the core marks a semver prerelease (e.g.
    // 2.8.109-beta.1). `.test()` returns a plain boolean, sidestepping the
    // optional-capture-group typing.
    hasPrerelease: /^v?\d+\.\d+\.\d+-/.test(trimmed),
  };
}

// Returns true only when `candidate` is strictly newer than `current`. Unknown
// or unparseable versions return false so we never act on a version we can't
// reason about (and never downgrade). Prerelease identifiers beyond the
// "release beats same-core prerelease" rule are intentionally not ordered. Used
// by the dashboard restart check below. Exported for unit testing.
export function isVersionNewer(candidate: string, current: string): boolean {
  const a = parseVersionCore(candidate);
  const b = parseVersionCore(current);
  if (a == null || b == null) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i] > b.core[i];
    }
  }
  // Same x.y.z: a final release outranks a prerelease of the same core.
  return !a.hasPrerelease && b.hasPrerelease;
}

// Restart the running dashboard only when the latest published release is
// strictly newer than the one serving the port. Equal/older/unknown versions (a
// pre-feature CLI's record, or an unreachable manifest) are reused as-is.
// Exported for unit testing.
export function shouldRestartDashboard(latestVersion: string | undefined, runningVersion: string | undefined): boolean {
  return latestVersion != null && runningVersion != null && isVersionNewer(latestVersion, runningVersion);
}

// Whether `pid` refers to a live process. EPERM means it exists but is owned by
// another user — i.e. the pid was recycled onto something that isn't ours.
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalDashboardProcess(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  process.kill(pid, signal);
}

function startDashboardProcess(options: {
  dashboardEnv: NodeJS.ProcessEnv,
  logFd: number,
  port: number,
  dashboardRoot?: string,
}): ChildProcess {
  const devDashboardCommand = devDashboardCommandFromEnv(process.env);
  if (devDashboardCommand != null) {
    writeSync(options.logFd, `Using ${DEV_DASHBOARD_COMMAND_ENV_VAR}: ${devDashboardCommand}\n`);
    return spawn(devDashboardCommand, {
      cwd: process.cwd(),
      detached: true,
      env: options.dashboardEnv,
      shell: true,
      stdio: ["ignore", options.logFd, options.logFd],
    });
  }

  if (options.dashboardRoot == null) {
    throw new CliError("Internal error: the Hexclave dashboard build was not resolved before starting.");
  }
  const dashboardServerPath = prepareDashboardRuntime(options.dashboardEnv, options.port, options.dashboardRoot);
  return spawn(process.execPath, [dashboardServerPath], {
    cwd: resolve(dirname(dashboardServerPath), "../.."),
    detached: true,
    stdio: ["ignore", options.logFd, options.logFd],
    env: options.dashboardEnv,
  });
}

// Terminate the background dashboard recorded for `port` in dev-env state and
// wait until the port stops answering, so a fresh (newer) dashboard can rebind
// without EADDRINUSE.
export async function killLocalDashboard(url: string, port: number): Promise<void> {
  const pid = readDevEnvState().localDashboardsByPort?.[String(port)]?.pid;
  if (pid == null || pid <= 0) return;
  if (!processExists(pid)) return;

  try {
    signalDashboardProcess(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: already gone. EPERM: the pid was recycled onto a process we don't
    // own, so it isn't our dashboard — don't wait on it or escalate to SIGKILL.
    if (code === "ESRCH" || code === "EPERM") return;
    throw error;
  }

  // Wait for the port to be released — that's the property that actually lets
  // the replacement bind. Don't gate on the pid: once the dashboard exits its
  // pid can be recycled onto an unrelated same-user process, which a pid probe
  // would misreport as "still alive" (spinning the full timeout and then
  // mis-targeting the SIGKILL below). isDashboardReachable only succeeds while
  // the listener is up, so an unreachable port reliably means it's gone.
  const startedAt = performance.now();
  while (performance.now() - startedAt < DASHBOARD_STOP_TIMEOUT_MS) {
    if (!(await isDashboardReachable(url))) return;
    await wait(200);
  }

  // Still listening after the grace period — the process is genuinely hung and
  // still holding the port, so the recorded pid is necessarily still valid;
  // force it down, then wait for the socket to be released.
  try {
    signalDashboardProcess(pid, "SIGKILL");
  } catch {
    // best-effort
  }
  const killDeadline = performance.now() + DASHBOARD_FORCE_STOP_TIMEOUT_MS;
  while (performance.now() < killDeadline) {
    if (!(await isDashboardReachable(url))) return;
    await wait(200);
  }
}

async function startDashboardIfNeeded(options: { apiBaseUrl: string, secret: string, port: number }): Promise<void> {
  const url = dashboardUrl(options.port);
  const devDashboardCommand = devDashboardCommandFromEnv(process.env);

  // Look up the newest published release to decide whether to restart a running
  // dashboard and which build to launch. Skipped for a custom dev command or a
  // local-build override; a null manifest (offline) reuses the running dashboard
  // or falls back to cache.
  const dashboardOverride = dashboardDirOverride();
  const skipReleaseLookup = devDashboardCommand != null || dashboardOverride != null;
  if (!skipReleaseLookup) {
    logDev("Checking for Hexclave dashboard updates...");
  }
  const manifest: DashboardManifest | null = skipReleaseLookup ? null : await fetchDashboardManifest();
  const latestVersion = manifest?.version;

  if (await isDashboardReachable(url, options.secret)) {
    const runningDashboard = readDevEnvState().localDashboardsByPort?.[String(options.port)];
    const runningVersion = runningDashboard?.version;
    if (devDashboardCommand != null && runningVersion != null) {
      // A custom dev command should take over a release/override dashboard left
      // running from a prior run. A custom-command dashboard records no version,
      // so `runningVersion != null` avoids needlessly restarting that one.
      logDev("A custom Hexclave dashboard command is configured; restarting the running dashboard...");
      await killLocalDashboard(url, options.port);
    } else if (dashboardOverride != null && runningVersion !== "local") {
      // A local-build override should win over a release dashboard left running
      // from a prior run; the override always resolves to version "local".
      logDev("A local Hexclave dashboard override is configured; restarting the running dashboard...");
      await killLocalDashboard(url, options.port);
    } else if (shouldRestartDashboard(latestVersion, runningVersion)) {
      logDev(`A newer Hexclave dashboard (${latestVersion}) is available; restarting from ${runningVersion}...`);
      await killLocalDashboard(url, options.port);
    } else {
      logDev(`Using existing Hexclave dashboard on ${url}.`);
      if (runningDashboard?.logPath != null) {
        logDev(`Dashboard logs: ${runningDashboard.logPath}`);
      }
      return;
    }
  }

  // Download (or reuse a cached copy of) the dashboard build to launch. Not
  // needed when a custom dev dashboard command runs the dashboard itself.
  const release = devDashboardCommand == null
    ? await resolveDashboardRuntime({ manifest, onProgress: (message) => logDev(`${message}...`) })
    : null;

  const progress = startProgress(`Hexclave dashboard not found on port ${options.port}. Starting now`, { prefix: LOG_PREFIX });
  const dashboardEnv = {
    ...dashboardEnvWithStatePath(process.env, devEnvStatePath()),
    NODE_ENV: devDashboardCommand == null ? "production" : "development",
    PORT: String(options.port),
    HOSTNAME: "0.0.0.0",
    [DEV_DASHBOARD_DIST_DIR_ENV_VAR]: process.env[DEV_DASHBOARD_DIST_DIR_ENV_VAR] ?? ".next-development-environment",
    STACK_API_URL: options.apiBaseUrl,
    NEXT_PUBLIC_STACK_API_URL: options.apiBaseUrl,
    NEXT_PUBLIC_BROWSER_STACK_API_URL: options.apiBaseUrl,
    NEXT_PUBLIC_SERVER_STACK_API_URL: options.apiBaseUrl,
    NEXT_PUBLIC_STACK_DASHBOARD_URL: url,
    NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL: url,
    NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL: url,
    NEXT_PUBLIC_STACK_PROJECT_ID: "internal",
    NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: DEFAULT_PUBLISHABLE_CLIENT_KEY,
    NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT: "true",
    NEXT_PUBLIC_STACK_IS_PREVIEW: "false",
    [DASHBOARD_PORT_ENV_VAR]: String(options.port),
    [RDE_DASHBOARD_LOG_PATH_ENV_VAR]: dashboardLogPath(options.port),
  };
  try {
    const logPath = dashboardLogPath(options.port);
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a", 0o600);
    chmodSync(logPath, 0o600);
    writeSync(logFd, `\n[${new Date().toISOString()}] Starting Hexclave development-environment dashboard on ${url}\n`);
    // Acquire a filesystem lock so parallel `hexclave dev` invocations don't
    // race on the runtime directory. openSync with 'wx' is an atomic
    // exclusive-create; EEXIST means another process holds the lock.
    let lockAcquired = false;
    const lockPath = dashboardRuntimeLockPath(options.port);
    // Remove stale lock left behind if a previous process was killed mid-prepare
    // (normal hold time is <1 s, so 5 s is certainly stale).
    try {
      const lockStat = statSync(lockPath);
      if (Date.now() - lockStat.mtimeMs > 5000) {
        unlinkSync(lockPath);
      }
    } catch {
      // lock doesn't exist or was already removed — fine
    }
    try {
      closeSync(openSync(lockPath, "wx"));
      lockAcquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!lockAcquired) {
      closeSync(logFd);
      logDev("Another process is starting the dashboard; waiting for it...");
    } else {
      try {
        const child = (() => {
          try {
            return startDashboardProcess({ dashboardEnv, logFd, port: options.port, dashboardRoot: release?.root });
          } finally {
            closeSync(logFd);
          }
        })();
        if (child.pid == null) {
          throw new CliError(`Failed to start the development environment dashboard process. Dashboard logs: ${logPath}`);
        }
        recordLocalDashboardProcess(options.port, options.secret, child.pid, logPath, release?.version);
        logDev(`Dashboard logs: ${logPath}`);
        child.unref();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // best-effort cleanup
        }
      }
    }

    const startedAt = performance.now();
    while (performance.now() - startedAt < DASHBOARD_START_TIMEOUT_MS) {
      if (await isDashboardReachable(url, options.secret)) {
        progress.stop(`Started Hexclave dashboard`);
        return;
      }
      await wait(500);
    }

    throw new CliError(`Timed out waiting for the development environment dashboard to start at ${url}. Dashboard logs: ${logPath}`);
  } catch (error) {
    progress.stop();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigSyncEvent(value: unknown): value is ConfigSyncEvent {
  if (
    !isRecord(value) ||
    !("config_file_path" in value) ||
    typeof value.config_file_path !== "string" ||
    !("status" in value) ||
    !("created_at_millis" in value) ||
    typeof value.created_at_millis !== "number"
  ) {
    return false;
  }
  if (value.status === "syncing" || value.status === "success") {
    return true;
  }
  return (
    value.status === "error" &&
    "error_message" in value &&
    typeof value.error_message === "string"
  );
}

export function isHeartbeatResponse(value: unknown): value is HeartbeatResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "ok" in value &&
    value.ok === true &&
    (
      !("browser_secret_confirmation_code" in value) ||
      typeof value.browser_secret_confirmation_code === "string"
    ) &&
    (
      !("browser_secret_confirmation_code_expires_at_millis" in value) ||
      typeof value.browser_secret_confirmation_code_expires_at_millis === "number"
    ) &&
    (
      !("config_sync_events" in value) ||
      (Array.isArray(value.config_sync_events) && value.config_sync_events.every(isConfigSyncEvent))
    )
  );
}

function logBrowserSecretConfirmationCode(response: HeartbeatResponse): void {
  if (response.browser_secret_confirmation_code == null) return;
  const expiresAtMillis = response.browser_secret_confirmation_code_expires_at_millis;
  const expiresInSeconds = expiresAtMillis == null
    ? undefined
    : Math.max(0, Math.ceil((expiresAtMillis - Date.now()) / 1000));
  logDev(expiresInSeconds == null
    ? `Dashboard browser confirmation code: ${response.browser_secret_confirmation_code}`
    : `Dashboard browser confirmation code: ${response.browser_secret_confirmation_code} (expires in ${expiresInSeconds}s)`);
}

export function logConfigSyncEvents(response: HeartbeatResponse): void {
  for (const event of response.config_sync_events ?? []) {
    if (event.status === "syncing") {
      logDev(`Detected change to config file at ${event.config_file_path}. Syncing...`);
    } else if (event.status === "success") {
      logDev("Updated config sync successful!");
    } else {
      logDevConfigError(`Config sync failed for ${event.config_file_path}: ${event.error_message}`);
    }
  }
}

function pendingBrowserSecretConfirmationCodeFromState(port: number): HeartbeatResponse | null {
  const pending = readDevEnvState().pendingBrowserSecretConfirmationCodesByPort?.[String(port)];
  if (pending == null || pending.expiresAtMillis <= Date.now()) {
    return null;
  }
  return {
    ok: true,
    browser_secret_confirmation_code: pending.code,
    browser_secret_confirmation_code_expires_at_millis: pending.expiresAtMillis,
  };
}

function maybeLogPendingBrowserSecretConfirmationCodeFromState(port: number, lastLoggedConfirmationCode: string | null): string | null {
  const pending = pendingBrowserSecretConfirmationCodeFromState(port);
  const code = pending?.browser_secret_confirmation_code;
  if (code == null || code === lastLoggedConfirmationCode) {
    return lastLoggedConfirmationCode;
  }
  if (pending == null) {
    return lastLoggedConfirmationCode;
  }
  logBrowserSecretConfirmationCode(pending);
  return code;
}

async function logPendingBrowserSecretConfirmationCodesUntilStopped(options: {
  port: number,
  shouldStop: () => boolean,
}): Promise<void> {
  let lastLoggedConfirmationCode: string | null = null;
  while (!options.shouldStop()) {
    lastLoggedConfirmationCode = maybeLogPendingBrowserSecretConfirmationCodeFromState(options.port, lastLoggedConfirmationCode);
    await wait(1_000);
  }
}

const APP_COMMAND_WRAPPER_PARENT_PID_ENV_VAR = "HEXCLAVE_DEV_APP_COMMAND_PARENT_PID";
const APP_COMMAND_WRAPPER_COMMAND_ENV_VAR = "HEXCLAVE_DEV_APP_COMMAND";
const APP_COMMAND_WRAPPER_ARGS_ENV_VAR = "HEXCLAVE_DEV_APP_COMMAND_ARGS_JSON";

const APP_COMMAND_WRAPPER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");

const parentPid = Number(process.env.HEXCLAVE_DEV_APP_COMMAND_PARENT_PID);
const command = process.env.HEXCLAVE_DEV_APP_COMMAND;
const rawArgs = process.env.HEXCLAVE_DEV_APP_COMMAND_ARGS_JSON ?? "[]";
if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !command) {
  console.error("[Hexclave] Invalid app-command wrapper configuration.");
  process.exit(1);
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch (error) {
  console.error("[Hexclave] Invalid app-command argument payload.", error);
  process.exit(1);
}
if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
  console.error("[Hexclave] Invalid app-command arguments.");
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.HEXCLAVE_DEV_APP_COMMAND_PARENT_PID;
delete childEnv.HEXCLAVE_DEV_APP_COMMAND;
delete childEnv.HEXCLAVE_DEV_APP_COMMAND_ARGS_JSON;

const child = spawn(command, args, {
  env: childEnv,
  stdio: "inherit",
});

let stopping = false;
let forceKillTimer;

function signalOwnProcessGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch {
    // best-effort
  }
}

function stopProcessGroup(signal) {
  if (stopping) return;
  stopping = true;
  signalOwnProcessGroup(signal);
  forceKillTimer = setTimeout(() => signalOwnProcessGroup("SIGKILL"), 5000);
  forceKillTimer.unref();
}

process.on("SIGINT", () => stopProcessGroup("SIGINT"));
process.on("SIGTERM", () => stopProcessGroup("SIGTERM"));

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    stopProcessGroup("SIGTERM");
  }
}, 1000);
parentWatch.unref();

child.on("close", (code, signal) => {
  clearInterval(parentWatch);
  if (forceKillTimer != null) clearTimeout(forceKillTimer);
  if (code != null) {
    process.exit(code);
  }
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  if (signal === "SIGKILL") process.exit(137);
  process.exit(1);
});

child.on("error", (error) => {
  console.error("[Hexclave] Failed to run app command:", error);
  process.exit(1);
});
`;

// `cwd` is undefined when no service is selected (a bare `hexclave dev --
// <command>` keeps the caller's directory). On POSIX it is handed to the
// wrapper process, whose own inner spawn inherits it — so the app command
// lands in the same directory on both platforms.
export function runChildProcess(command: ChildCommand, env: NodeJS.ProcessEnv, cwd?: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = process.platform === "win32"
      // cross-spawn handles Windows command shims that Node cannot spawn
      // directly (it passes through to plain spawn when `shell` is set).
      ? crossSpawn(command.command, command.args, { stdio: "inherit", env, cwd, shell: command.shell ?? false })
      : spawn(process.execPath, ["-e", APP_COMMAND_WRAPPER_SCRIPT], {
        detached: true,
        stdio: "inherit",
        cwd,
        env: {
          ...env,
          [APP_COMMAND_WRAPPER_PARENT_PID_ENV_VAR]: String(process.pid),
          [APP_COMMAND_WRAPPER_COMMAND_ENV_VAR]: command.command,
          [APP_COMMAND_WRAPPER_ARGS_ENV_VAR]: JSON.stringify(command.args),
        },
      });
    const cleanup = forwardSignals(child, {
      forceKillAfterMs: 5_000,
      processGroup: process.platform !== "win32",
    });
    child.on("close", (code) => {
      cleanup();
      resolvePromise(code ?? 1);
    });
    child.on("error", (err) => {
      cleanup();
      reject(new CliError(`Failed to run ${command.command}: ${err.message}`));
    });
  });
}

async function restartDashboardForHeartbeat(options: {
  apiBaseUrl: string,
  configFilePath: string,
  dashboardReachableSinceMs: number,
  port: number,
  secret: string,
}): Promise<DashboardSessionResponse> {
  const dashboardUptimeMs = performance.now() - options.dashboardReachableSinceMs;
  if (dashboardUptimeMs < DASHBOARD_RESTART_MIN_UPTIME_MS) {
    throw new CliError(`Local Hexclave dashboard stopped before it had been running for ${DASHBOARD_RESTART_MIN_UPTIME_MS / 1000} seconds. Not restarting to avoid a restart loop.`);
  }

  logDev("Local Hexclave dashboard stopped. Restarting...");
  await startDashboardIfNeeded({ apiBaseUrl: options.apiBaseUrl, secret: options.secret, port: options.port });
  return await createRemoteDevelopmentEnvironmentSession({
    apiBaseUrl: options.apiBaseUrl,
    configFilePath: options.configFilePath,
    port: options.port,
    secret: options.secret,
  });
}

async function waitForHeartbeatIntervalOrStop(shouldStop: () => boolean): Promise<boolean> {
  const startedAtMs = performance.now();
  while (!shouldStop()) {
    const remainingMs = HEARTBEAT_INTERVAL_MS - (performance.now() - startedAtMs);
    if (remainingMs <= 0) return false;
    await wait(Math.min(remainingMs, HEARTBEAT_STOP_POLL_MS));
  }
  return true;
}

async function heartbeatUntilStopped(sessionState: DashboardSessionState, options: {
  apiBaseUrl: string,
  configFilePath: string,
  port: number,
  secret: string,
  shouldStop: () => boolean,
}): Promise<void> {
  let lastLoggedConfirmationCode: string | null = null;
  let heartbeatAttempt = 0;
  while (!options.shouldStop()) {
    if (await waitForHeartbeatIntervalOrStop(options.shouldStop)) {
      return;
    }
    lastLoggedConfirmationCode = maybeLogPendingBrowserSecretConfirmationCodeFromState(options.port, lastLoggedConfirmationCode);
    heartbeatAttempt += 1;

    let response: Response;
    const controller = new AbortController();
    const abortOnStop = setInterval(() => {
      if (options.shouldStop()) {
        controller.abort();
      }
    }, HEARTBEAT_STOP_POLL_MS);
    try {
      response = await dashboardRequest(`/api/remote-development-environment/sessions/${encodeURIComponent(sessionState.session.session_id)}/heartbeat`, {
        method: "POST",
        signal: controller.signal,
      }, options.secret, options.port);
    } catch (error) {
      lastLoggedConfirmationCode = maybeLogPendingBrowserSecretConfirmationCodeFromState(options.port, lastLoggedConfirmationCode);
      if (options.shouldStop()) return;
      sessionState.session = await restartDashboardForHeartbeat({
        apiBaseUrl: options.apiBaseUrl,
        configFilePath: options.configFilePath,
        dashboardReachableSinceMs: sessionState.dashboardReachableSinceMs,
        port: options.port,
        secret: options.secret,
      });
      sessionState.dashboardReachableSinceMs = performance.now();
      logDev(`Hexclave dashboard running at ${dashboardUrl(options.port)}`);
      continue;
    } finally {
      clearInterval(abortOnStop);
    }

    if (!response.ok) {
      logDev(`Development environment heartbeat failed (${response.status}): ${await response.text()}`);
      sessionState.session = await restartDashboardForHeartbeat({
        apiBaseUrl: options.apiBaseUrl,
        configFilePath: options.configFilePath,
        dashboardReachableSinceMs: sessionState.dashboardReachableSinceMs,
        port: options.port,
        secret: options.secret,
      });
      sessionState.dashboardReachableSinceMs = performance.now();
      logDev(`Hexclave dashboard running at ${dashboardUrl(options.port)}`);
      continue;
    }

    let heartbeatBody: unknown;
    try {
      heartbeatBody = await response.json();
    } catch {
      logDev("Development environment heartbeat returned unparseable JSON.");
      continue;
    }
    if (!isHeartbeatResponse(heartbeatBody)) {
      logDev("Development environment heartbeat returned an invalid response.");
      continue;
    }
    // Deduplicate: only log a confirmation code once per unique code value.
    if (heartbeatBody.browser_secret_confirmation_code != null &&
        heartbeatBody.browser_secret_confirmation_code !== lastLoggedConfirmationCode) {
      logBrowserSecretConfirmationCode(heartbeatBody);
      lastLoggedConfirmationCode = heartbeatBody.browser_secret_confirmation_code;
    }
    logConfigSyncEvents(heartbeatBody);
  }
}

async function closeSession(sessionId: string, secret: string, port: number): Promise<void> {
  let response: Response;
  try {
    response = await dashboardRequest(`/api/remote-development-environment/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }, secret, port);
  } catch (error) {
    logDev(`Failed to close development environment session: ${errorMessage(error)}`);
    return;
  }
  if (!response.ok) {
    logDev(`Failed to close development environment session (${response.status}): ${await response.text()}`);
  }
}

export function validateDevCommandSelection(serviceId: string | undefined, commandArgs: string[]): void {
  if (serviceId != null && commandArgs.length > 0) {
    throw new CliError("Cannot combine --service-id <id> with a positional command after --. Choose the service's devCommand or run an explicit command, but not both.");
  }
  if (serviceId == null && commandArgs.length === 0) {
    throw new CliError("Missing command. Pass --service-id <id> to run a service's devCommand from the deploy file, or a command after --: hexclave dev --config-file <path> -- <command> [args...]");
  }
}

export function registerDevCommand(program: Command) {
  program
    .command("dev")
    .usage("--config-file <path> [--service-id <id>] [-- <command> [args...]]")
    .description("Run a command with Hexclave development-environment credentials. With --service-id, the service's devCommand from the deploy file's `deploy` export is run in the service's rootDirectory and its env vars are injected (secrets resolve to their default values; `service()` returns null, so guard connection values with isDev — reading an output off it, e.g. `service(\"api\").url`, throws).")
    .requiredOption("--config-file <path>", "Path to hexclave.config.ts")
    .option("--service-id <id>", "Run the devCommand of this service from the deploy file's `deploy` export, in its rootDirectory and with the service's env vars injected")
    .option("--deploy-file <path>", "Path to the deploy file for --service-id (default: auto-discover hexclave.deploy.ts next to the config file)")
    .argument("[command...]", "Command and arguments to run after --")
    .action(async (commandArgs: string[], opts: DevOptions) => {
      validateDevCommandSelection(opts.serviceId, commandArgs);
      if (opts.configFile == null) {
        throw new CliError("--config-file is required.");
      }

      const configFilePath = resolveConfigFilePathOption(opts.configFile, { mustExist: opts.serviceId != null });

      // Evaluate the deploy file's services BEFORE starting the dashboard so a
      // mistake there fails fast (and without a half-started session).
      let devService: EvaluatedService | undefined;
      if (opts.serviceId != null) {
        // Services live in the DEPLOY file, not the config file: --config-file
        // is what the development-environment session is keyed on, and the two
        // are separate documents. Default to the deploy file sitting next to
        // the config file, which is where a single-repo project keeps it.
        const deployFilePath = resolveDeployFilePath(opts.deployFile, dirname(configFilePath));
        const deployModule = await importDeployModule(deployFilePath);
        const { services } = evaluateDeploymentConfig({
          deployFilePath,
          deploymentGroupIdExport: deployModule.deploymentGroupId,
          legacyIdExport: deployModule.legacyId,
          deployExport: deployModule.deploy,
          versionExport: deployModule.version,
          mode: "dev",
        });
        devService = services.get(opts.serviceId);
        if (devService == null) {
          throw new CliError(`No service named ${JSON.stringify(opts.serviceId)} in the deploy file's \`deploy\` export. Available services: ${[...services.keys()].join(", ")}.`);
        }
        // A BLANK devCommand counts as missing. `shellChildCommand("")` runs `sh -c ""`,
        // which exits 0 immediately — so an empty string would report a successful dev
        // session that never started the service, instead of naming the actual problem.
        if (commandArgs.length === 0 && (devService.devCommand == null || devService.devCommand.trim() === "")) {
          throw new CliError(`The service ${JSON.stringify(opts.serviceId)} has no devCommand in the deploy file's \`deploy\` export. Add one (e.g. devCommand: "npm run dev"), or pass a command after --.`);
        }
        // The service's rootDirectory becomes the child's cwd below, so check it
        // HERE rather than letting spawn fail: spawn reports a bad cwd as an
        // ENOENT naming the EXECUTABLE ("spawn pnpm ENOENT" — reads as "pnpm is
        // not installed"), and a cwd that points at a file makes it throw
        // synchronously, escaping the CliError wrapping in runChildProcess.
        const rootDirectoryStats = (() => {
          try {
            return statSync(devService.absoluteRootDirectory);
          } catch {
            return null;
          }
        })();
        if (rootDirectoryStats == null || !rootDirectoryStats.isDirectory()) {
          throw new CliError(`The rootDirectory of the service ${JSON.stringify(opts.serviceId)} is ${devService.absoluteRootDirectory}, which ${rootDirectoryStats == null ? "does not exist" : "is not a directory"}. Fix \`rootDirectory\` in the deploy file's \`deploy\` export — it is where the service's devCommand runs.`);
        }
      }
      // The selection guard above makes these modes mutually exclusive.
      const childCommand = commandArgs.length > 0
        ? splitDevCommandArgs(commandArgs)
        : shellChildCommand(devService?.devCommand ?? (() => {
          throw new CliError("Internal error: no dev command resolved despite the checks above.");
        })());

      const port = dashboardPort();
      const localDashboardUrl = dashboardUrl(port);
      const secret = ensureLocalDashboardSecret(port);
      const config = resolveLoginConfig();
      const apiBaseUrl = normalizeApiBaseUrl(config.apiUrl || DEFAULT_API_URL);
      await startDashboardIfNeeded({ apiBaseUrl, secret, port });
      const sessionState: DashboardSessionState = {
        session: await createRemoteDevelopmentEnvironmentSession({
          apiBaseUrl,
          configFilePath,
          port,
          secret,
        }),
        dashboardReachableSinceMs: performance.now(),
      };
      logDev(`Hexclave dashboard running at ${localDashboardUrl}`);
      maybeOpenOnboardingPage(sessionState.session, port);

      let stopped = false;
      const heartbeat = heartbeatUntilStopped(sessionState, {
        apiBaseUrl,
        configFilePath,
        port,
        secret,
        shouldStop: () => stopped,
      });
      const browserSecretCodePolling = logPendingBrowserSecretConfirmationCodesUntilStopped({
        port,
        shouldStop: () => stopped,
      });
      let exitCode = 1;
      try {
        exitCode = await runChildProcess(childCommand, composeDevChildEnv(
          process.env,
          devService != null ? resolveDevEnv(devService, sessionState.session.env) : {},
          sessionState.session.env,
        // A selected service runs in its own rootDirectory, which is where its
        // code lives (`pnpm dev` at a monorepo root would otherwise start the
        // ROOT package, not the service). Applied for an explicit `--
        // <command>` too when a service is selected: its env vars are already
        // injected above, so the directory should match the same service.
        ), devService?.absoluteRootDirectory);
      } finally {
        stopped = true;
        await Promise.all([heartbeat, browserSecretCodePolling]);
        await closeSession(sessionState.session.session_id, secret, port);
      }
      process.exit(exitCode);
    });
}
