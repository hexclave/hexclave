import "server-only";

import { getPublicEnvVar } from "@/lib/env";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { AdminOwnedProject, StackClientApp } from "@hexclave/next";
import { Config, override } from "@hexclave/shared/dist/config/format";
import { ProjectOnboardingStatus } from "@hexclave/shared/dist/schema-fields";
import { AccessToken } from "@hexclave/shared/dist/sessions";
import { errorToNiceString } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { randomUUID } from "crypto";
import { appendFileSync, type FSWatcher } from "fs";
import { basename, dirname } from "path";
import { peekRemoteDevelopmentEnvironmentBrowserSecretConfirmationCodeForCli } from "./browser-secret";
import { formatConfigSyncErrorForCli } from "./config-sync-error-format";
import {
  ensureConfigFileExists,
  readConfigFile,
  replaceConfigObject,
  resolveConfigFilePath,
  sha256String,
  updateConfigObject,
} from "./config-file";
import { watchConfigFile } from "./config-file-watcher";
import { assertRemoteDevelopmentEnvironmentEnabled } from "./env";
import {
  RemoteDevelopmentEnvironmentProject,
  readRemoteDevelopmentEnvironmentState,
  updateRemoteDevelopmentEnvironmentState,
} from "./state";

const SESSION_TTL_MS = 25_000;
const FIRST_HEARTBEAT_TTL_MS = 5 * 60_000;
const STARTUP_EMPTY_SESSION_GRACE_MS = 20_000;
const SYNC_DEBOUNCE_MS = 500;
const CONFIG_SYNC_FORMAT_VERSION = 2;
const LOG_PREFIX = "[Stack RDE]";
const RDE_DASHBOARD_LOG_PATH_ENV_VAR = "HEXCLAVE_RDE_DASHBOARD_LOG_PATH";
const CONFIG_SYNC_DUPLICATE_EVENT_SUPPRESSION_MS = 2_000;
const CONFIG_UPDATE_LOG_PATH_LIMIT = 40;

export class RemoteDevelopmentEnvironmentApiUnavailableError extends Error {
  constructor(apiBaseUrl: string, cause: unknown) {
    super(`Could not connect to the Hexclave API at ${apiBaseUrl}. Make sure the backend for this development environment is running and reachable.`, { cause });
    this.name = "RemoteDevelopmentEnvironmentApiUnavailableError";
  }
}

type ActiveSession = {
  configFilePath: string,
  lastHeartbeatMs: number,
  receivedFirstHeartbeat: boolean,
  lastDeliveredConfigSyncEventId: number,
};

type ConfigSyncEventBase = {
  id: number,
  configFilePath: string,
  createdAtMillis: number,
};

type ConfigSyncEvent = ConfigSyncEventBase & ({
  status: "syncing",
} | {
  status: "success",
} | {
  status: "error",
  errorMessage: string,
});

type RemoteDevelopmentEnvironmentConfigSyncEventBase = {
  configFilePath: string,
  createdAtMillis: number,
};

export type RemoteDevelopmentEnvironmentConfigSyncEvent = RemoteDevelopmentEnvironmentConfigSyncEventBase & ({
  status: "syncing",
} | {
  status: "success",
} | {
  status: "error",
  errorMessage: string,
});

type RemoteDevelopmentEnvironmentDebugSession = {
  sessionId: string,
  configFilePath: string,
  lastHeartbeatAgeMs: number,
  ttlMs: number,
  expiresInMs: number,
  receivedFirstHeartbeat: boolean,
};

type RemoteDevelopmentEnvironmentDebugSnapshot = {
  uptimeMs: number,
  shutdownTimerStarted: boolean,
  activeOperations: number,
  hasClosedSession: boolean,
  sessions: RemoteDevelopmentEnvironmentDebugSession[],
  watchedConfigFiles: string[],
  pendingSyncConfigFiles: string[],
  syncErrors: { configFilePath: string, error: string }[],
  pendingConfigSyncEvents: {
    id: number,
    configFilePath: string,
    status: "syncing" | "success" | "error",
    errorMessage?: string,
    createdAgoMs: number,
  }[],
  synchronouslyUpdatingConfigFiles: string[],
  localDashboards: {
    port: number,
    pid: number,
    startedAgoMs: number,
    logPath?: string,
  }[],
  pendingBrowserSecretConfirmationCodes: {
    port: string,
    code: string,
    expiresInMs: number,
    updatedAgoMs: number,
  }[],
  projects: {
    configFilePath: string,
    projectId: string,
    teamId: string,
    apiBaseUrl: string,
    updatedAgoMs: number,
    hasLastSyncedConfigHash: boolean,
  }[],
};

type RemoteDevelopmentEnvironmentGlobals = {
  sessions: Map<string, ActiveSession>,
  watchers: Map<string, FSWatcher>,
  syncTimers: Map<string, NodeJS.Timeout>,
  activeConfigSyncs: Map<string, Promise<void>>,
  syncErrors: Map<string, Error>,
  configSyncEvents: ConfigSyncEvent[],
  lastConfigSyncEventByConfigFile: Map<string, ConfigSyncEvent>,
  nextConfigSyncEventId: number,
  synchronouslyUpdatingConfigFiles: Set<string>,
  shutdownTimerStarted: boolean,
  startedAtMs: number,
  activeOperations: number,
  hasClosedSession: boolean,
};

type HexclaveAppRequestInternals = {
  sendRequest: (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>,
};

const globals = globalThis as typeof globalThis & {
  __stackRemoteDevelopmentEnvironment?: RemoteDevelopmentEnvironmentGlobals,
};

function getGlobals(): RemoteDevelopmentEnvironmentGlobals {
  assertRemoteDevelopmentEnvironmentEnabled();
  globals.__stackRemoteDevelopmentEnvironment ??= {
    sessions: new Map(),
    watchers: new Map(),
    syncTimers: new Map(),
    activeConfigSyncs: new Map(),
    syncErrors: new Map(),
    configSyncEvents: [],
    lastConfigSyncEventByConfigFile: new Map(),
    nextConfigSyncEventId: 1,
    synchronouslyUpdatingConfigFiles: new Set(),
    shutdownTimerStarted: false,
    startedAtMs: performance.now(),
    activeOperations: 0,
    hasClosedSession: false,
  };
  return globals.__stackRemoteDevelopmentEnvironment;
}

function writeRemoteDevelopmentEnvironmentLogLine(line: string): boolean {
  const logPath = process.env[RDE_DASHBOARD_LOG_PATH_ENV_VAR];
  if (logPath == null || logPath.length === 0) {
    return false;
  }
  try {
    appendFileSync(logPath, `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function formatRemoteDevelopmentEnvironmentLogLine(message: string, details?: Record<string, unknown>): string {
  const prefix = `[${new Date().toISOString()}] ${LOG_PREFIX}`;
  if (details == null) {
    return `${prefix} ${message}`;
  }
  return `${prefix} ${message} ${JSON.stringify(details)}`;
}

function logRemoteDevelopmentEnvironment(message: string, details?: Record<string, unknown>): void {
  const line = formatRemoteDevelopmentEnvironmentLogLine(message, details);
  if (writeRemoteDevelopmentEnvironmentLogLine(line)) {
    return;
  }
  console.log(line);
}

function warnRemoteDevelopmentEnvironment(message: string, details?: Record<string, unknown>): void {
  const line = formatRemoteDevelopmentEnvironmentLogLine(message, details);
  if (writeRemoteDevelopmentEnvironmentLogLine(line)) {
    return;
  }
  console.warn(line);
}

function formatErrorForRemoteDevelopmentEnvironmentLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const cause = error["cause"];
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      ...(cause == null ? {} : { errorCause: errorToNiceString(cause) }),
    };
  }
  return {
    errorMessage: errorToNiceString(error),
  };
}

function collectConfigUpdatePaths(config: Config, prefix: string, paths: string[]): void {
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      collectConfigUpdatePaths(value, path, paths);
    } else {
      paths.push(path);
    }
  }
}

function summarizeConfigUpdateForLog(configUpdate: Config): Record<string, unknown> {
  const configUpdatePaths: string[] = [];
  collectConfigUpdatePaths(configUpdate, "", configUpdatePaths);
  configUpdatePaths.sort();
  return {
    configUpdateTopLevelKeys: Object.keys(configUpdate).sort(),
    configUpdatePathCount: configUpdatePaths.length,
    configUpdatePaths: configUpdatePaths.slice(0, CONFIG_UPDATE_LOG_PATH_LIMIT),
    configUpdatePathsTruncated: configUpdatePaths.length > CONFIG_UPDATE_LOG_PATH_LIMIT,
  };
}

function configSyncEventsMatchForCliDeduplication(a: ConfigSyncEvent, b: { status: "syncing" } | { status: "success" } | { status: "error", errorMessage: string }): boolean {
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === "syncing" || a.status === "success") {
    return true;
  }
  if (b.status !== "error") {
    return false;
  }
  return a.errorMessage === b.errorMessage;
}

function recordConfigSyncEvent(configFilePath: string, event: { status: "syncing" } | { status: "success" } | { status: "error", errorMessage: string }): void {
  const state = getGlobals();
  const createdAtMillis = Date.now();
  const lastEvent = state.lastConfigSyncEventByConfigFile.get(configFilePath);
  const isDuplicate = lastEvent != null &&
    configSyncEventsMatchForCliDeduplication(lastEvent, event) &&
    createdAtMillis - lastEvent.createdAtMillis < CONFIG_SYNC_DUPLICATE_EVENT_SUPPRESSION_MS;
  if (isDuplicate) {
    logRemoteDevelopmentEnvironment("Suppressing duplicate config sync CLI notification", {
      configFilePath,
      status: event.status,
      duplicateWindowMs: CONFIG_SYNC_DUPLICATE_EVENT_SUPPRESSION_MS,
    });
    return;
  }
  const baseEvent = {
    id: state.nextConfigSyncEventId,
    configFilePath,
    createdAtMillis,
  };
  const configSyncEvent: ConfigSyncEvent = event.status === "error"
    ? { ...baseEvent, status: "error", errorMessage: event.errorMessage }
    : { ...baseEvent, status: event.status };
  state.nextConfigSyncEventId += 1;
  state.configSyncEvents.push(configSyncEvent);
  state.lastConfigSyncEventByConfigFile.set(configFilePath, configSyncEvent);
  if (state.configSyncEvents.length > 100) {
    state.configSyncEvents.splice(0, state.configSyncEvents.length - 100);
  }
}

function drainConfigSyncEventsForSession(session: ActiveSession): RemoteDevelopmentEnvironmentConfigSyncEvent[] {
  const state = getGlobals();
  const pendingEvents = state.configSyncEvents.filter((event) => (
    event.configFilePath === session.configFilePath &&
    event.id > session.lastDeliveredConfigSyncEventId
  ));
  if (pendingEvents.length === 0) {
    return [];
  }
  session.lastDeliveredConfigSyncEventId = pendingEvents[pendingEvents.length - 1].id;
  return pendingEvents.map((event) => event.status === "error"
    ? {
      configFilePath: event.configFilePath,
      status: "error",
      errorMessage: event.errorMessage,
      createdAtMillis: event.createdAtMillis,
    }
    : {
      configFilePath: event.configFilePath,
      status: event.status,
      createdAtMillis: event.createdAtMillis,
    });
}

function errorLooksLikeApiConnectionFailure(error: unknown): boolean {
  const message = errorToNiceString(error);
  return (
    message.includes("ECONNREFUSED")
    || message.includes("ECONNRESET")
    || message.includes("ETIMEDOUT")
    || message.includes("ENOTFOUND")
    || message.includes("fetch failed")
  );
}

function throwApiUnavailableIfConnectionFailure(apiBaseUrl: string, error: unknown): never {
  if (errorLooksLikeApiConnectionFailure(error)) {
    throw new RemoteDevelopmentEnvironmentApiUnavailableError(apiBaseUrl, error);
  }
  throw error;
}

function isStackAppRequestInternals(value: unknown): value is HexclaveAppRequestInternals {
  return (
    value != null &&
    typeof value === "object" &&
    "sendRequest" in value &&
    typeof value.sendRequest === "function"
  );
}

function getStackAppRequestInternals(appValue: unknown): HexclaveAppRequestInternals {
  if (appValue == null || typeof appValue !== "object") {
    throw new Error("The Stack app instance is unavailable.");
  }

  const internals = appValue[hexclaveAppInternalsSymbol];
  if (!isStackAppRequestInternals(internals)) {
    throw new Error("The Stack app cannot send remote development environment onboarding updates.");
  }

  return internals;
}

function beginRemoteDevelopmentEnvironmentOperation(name: string, details?: Record<string, unknown>): () => void {
  const state = getGlobals();
  const startedAtMs = performance.now();
  state.activeOperations += 1;
  logRemoteDevelopmentEnvironment(`Started ${name}`, {
    ...details,
    activeOperations: state.activeOperations,
  });

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.activeOperations -= 1;
    logRemoteDevelopmentEnvironment(`Finished ${name}`, {
      ...details,
      activeOperations: state.activeOperations,
      elapsedMs: Math.round(performance.now() - startedAtMs),
    });
  };
}

function internalPublishableClientKey(): string {
  const key = process.env.STACK_CLI_PUBLISHABLE_CLIENT_KEY ?? getPublicEnvVar("NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY");
  if (key == null || key.length === 0) {
    throw new Error("Missing internal publishable client key for remote development environment dashboard.");
  }
  return key;
}

function createInternalApp(apiBaseUrl: string, anonymousRefreshToken?: string) {
  return new StackClientApp({
    projectId: "internal",
    publishableClientKey: internalPublishableClientKey(),
    baseUrl: apiBaseUrl,
    tokenStore: anonymousRefreshToken == null ? "memory" : { refreshToken: anonymousRefreshToken, accessToken: "" },
    noAutomaticPrefetch: true,
  });
}

function envVarsForProject(project: RemoteDevelopmentEnvironmentProject): Record<string, string> {
  const brands = ["HEXCLAVE", "STACK"];
  const publicPrefixes = ["", "NEXT_PUBLIC_", "VITE_", "EXPO_PUBLIC_"];

  const publicValues: Record<string, string> = {
    PROJECT_ID: project.projectId,
    PUBLISHABLE_CLIENT_KEY: project.publishableClientKey,
    API_URL: project.apiBaseUrl,
  };
  const secretValues: Record<string, string> = {
    SECRET_SERVER_KEY: project.secretServerKey,
  };

  const env: Record<string, string> = {};
  for (const brand of brands) {
    for (const [name, value] of Object.entries(publicValues)) {
      for (const prefix of publicPrefixes) {
        env[`${prefix}${brand}_${name}`] = value;
      }
    }
    for (const [name, value] of Object.entries(secretValues)) {
      env[`${brand}_${name}`] = value;
    }
  }
  return env;
}

async function getOrCreateProject(options: {
  apiBaseUrl: string,
  configFilePath: string,
  anonymousRefreshToken?: string,
}): Promise<{ anonymousRefreshToken: string, project: RemoteDevelopmentEnvironmentProject }> {
  logRemoteDevelopmentEnvironment("Ensuring development-environment project exists", {
    apiBaseUrl: options.apiBaseUrl,
    configFilePath: options.configFilePath,
    hasExistingAnonymousSession: options.anonymousRefreshToken != null,
  });
  const app = createInternalApp(options.apiBaseUrl, options.anonymousRefreshToken);
  const user = await app.getUser({ or: "anonymous" });
  const authJson = await user.getAuthJson();
  const anonymousRefreshToken = authJson.refreshToken ?? (() => {
    throw new Error("Anonymous session did not return a refresh token.");
  })();

  const state = readRemoteDevelopmentEnvironmentState();
  const storedProject = state.projectsByConfigPath[options.configFilePath];
  const ownedProjects = await user.listOwnedProjects();
  const existingProject = storedProject == null
    ? undefined
    : ownedProjects.find((project) => project.id === storedProject.projectId);
  if (storedProject != null && existingProject != null) {
    const updatedProject = {
      ...storedProject,
      apiBaseUrl: options.apiBaseUrl,
      updatedAtMillis: Date.now(),
    };
    updateRemoteDevelopmentEnvironmentState((current) => ({
      ...current,
      anonymousRefreshToken,
      anonymousApiBaseUrl: options.apiBaseUrl,
      projectsByConfigPath: {
        ...current.projectsByConfigPath,
        [options.configFilePath]: updatedProject,
      },
    }));
    logRemoteDevelopmentEnvironment("Reusing stored development-environment project", {
      projectId: updatedProject.projectId,
      teamId: updatedProject.teamId,
      configFilePath: options.configFilePath,
    });
    return { anonymousRefreshToken, project: updatedProject };
  }

  const label = basename(dirname(options.configFilePath)) || "Project";
  logRemoteDevelopmentEnvironment("Creating new development-environment team and project", {
    label,
    configFilePath: options.configFilePath,
  });
  const team = await user.createTeam({
    displayName: `Development Environment: ${label}`,
  });
  const project = await user.createProject({
    displayName: "Development Environment Project",
    description: `Development environment for ${label}`,
    teamId: team.id,
    isProductionMode: false,
    isDevelopmentEnvironment: true,
  });
  const key = await project.app.createInternalApiKey({
    description: `Development environment key for ${label}`,
    expiresAt: new Date("2099-12-31T23:59:59Z"),
    hasPublishableClientKey: true,
    hasSecretServerKey: true,
    hasSuperSecretAdminKey: false,
  });
  if (key.publishableClientKey == null || key.secretServerKey == null) {
    throw new Error("Development environment API key response did not include the expected keys.");
  }

  const mappedProject: RemoteDevelopmentEnvironmentProject = {
    projectId: project.id,
    teamId: team.id,
    publishableClientKey: key.publishableClientKey,
    secretServerKey: key.secretServerKey,
    apiBaseUrl: options.apiBaseUrl,
    updatedAtMillis: Date.now(),
  };
  logRemoteDevelopmentEnvironment("Created development-environment project", {
    projectId: mappedProject.projectId,
    teamId: mappedProject.teamId,
    configFilePath: options.configFilePath,
  });
  updateRemoteDevelopmentEnvironmentState((current) => ({
    ...current,
    anonymousRefreshToken,
    anonymousApiBaseUrl: options.apiBaseUrl,
    projectsByConfigPath: {
      ...current.projectsByConfigPath,
      [options.configFilePath]: mappedProject,
    },
  }));
  return { anonymousRefreshToken, project: mappedProject };
}

export async function getRemoteDevelopmentEnvironmentAccessToken(): Promise<{ accessToken: string, expiresAtMillis: number, issuedAtMillis: number, userId: string }> {
  const state = readRemoteDevelopmentEnvironmentState();
  if (state.anonymousRefreshToken == null) {
    throw new Error("Remote development environment has no anonymous session yet.");
  }

  const apiBaseUrl = state.anonymousApiBaseUrl ?? Object.values(state.projectsByConfigPath)[0]?.apiBaseUrl;
  if (apiBaseUrl == null) {
    throw new Error("Remote development environment has no API base URL yet.");
  }

  const app = createInternalApp(apiBaseUrl, state.anonymousRefreshToken);
  const user = await app.getUser({ or: "anonymous" });
  const accessToken = (await user.getAuthJson()).accessToken ?? (() => {
    throw new Error("Remote development environment anonymous session did not return an access token.");
  })();
  const parsedAccessToken = AccessToken.createIfValid(accessToken) ?? (() => {
    throw new Error("Remote development environment anonymous session returned an invalid access token.");
  })();

  return {
    accessToken,
    expiresAtMillis: parsedAccessToken.expiresAt.getTime(),
    issuedAtMillis: parsedAccessToken.issuedAt.getTime(),
    userId: user.id,
  };
}

async function syncRemoteDevelopmentEnvironmentOnboardingStatus(
  project: AdminOwnedProject,
  showOnboarding: boolean,
): Promise<ProjectOnboardingStatus> {
  const onboardingStatus = showOnboarding && project.onboardingStatus === "completed"
    ? "config_choice"
    : showOnboarding
      ? project.onboardingStatus
      : "completed";

  const body = showOnboarding
    ? { onboarding_status: onboardingStatus }
    : { onboarding_status: onboardingStatus, onboarding_state: null };
  const response = await getStackAppRequestInternals(project.app).sendRequest(
    "/internal/projects/current",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    "admin",
  );
  if (!response.ok) {
    throw new Error(`Failed to sync development-environment project onboarding status (${response.status}): ${await response.text()}`);
  }

  return onboardingStatus;
}

async function updateRemoteDevelopmentEnvironmentPushedConfigError(configFilePath: string, errorMessage: string | null): Promise<void> {
  const state = readRemoteDevelopmentEnvironmentState();
  const project = state.projectsByConfigPath[configFilePath];
  if (project == null || state.anonymousRefreshToken == null) {
    warnRemoteDevelopmentEnvironment("Skipping pushed config error update because local state is incomplete", {
      configFilePath,
      hasProject: project != null,
      hasAnonymousRefreshToken: state.anonymousRefreshToken != null,
    });
    return;
  }

  const app = createInternalApp(project.apiBaseUrl, state.anonymousRefreshToken);
  const user = await app.getUser({ or: "anonymous" });
  const ownedProject = (await user.listOwnedProjects()).find((p) => p.id === project.projectId);
  if (ownedProject == null) {
    warnRemoteDevelopmentEnvironment("Skipping pushed config error update because the project is not owned by the anonymous user", {
      projectId: project.projectId,
      configFilePath,
    });
    return;
  }

  logRemoteDevelopmentEnvironment(errorMessage == null ? "Clearing pushed config error on development-environment project" : "Setting pushed config error on development-environment project", {
    projectId: project.projectId,
    configFilePath,
  });
  const response = await getStackAppRequestInternals(ownedProject.app).sendRequest(
    "/internal/config/pushed-error",
    errorMessage == null
      ? { method: "DELETE" }
      : {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error_message: errorMessage,
        }),
      },
    "admin",
  );
  if (!response.ok) {
    throw new Error(`Failed to ${errorMessage == null ? "clear" : "set"} development-environment pushed config error (${response.status}): ${await response.text()}`);
  }
}

type ConfigSyncResult = {
  onboardingStatus: ProjectOnboardingStatus | undefined,
  pushedConfig: boolean,
};

async function runConfigSyncSerialized<T>(configFilePath: string, operationName: string, operation: () => Promise<T>): Promise<T> {
  const state = getGlobals();
  while (true) {
    const activeSync = state.activeConfigSyncs.get(configFilePath);
    if (activeSync == null) {
      break;
    }
    logRemoteDevelopmentEnvironment("Waiting for active config sync before starting another one", {
      configFilePath,
      operationName,
    });
    await activeSync;
  }

  let releaseActiveSync: () => void = () => {};
  const activeSync = new Promise<void>((resolvePromise) => {
    releaseActiveSync = resolvePromise;
  });
  state.activeConfigSyncs.set(configFilePath, activeSync);
  try {
    logRemoteDevelopmentEnvironment("Starting serialized config sync operation", {
      configFilePath,
      operationName,
    });
    return await operation();
  } finally {
    if (state.activeConfigSyncs.get(configFilePath) === activeSync) {
      state.activeConfigSyncs.delete(configFilePath);
    }
    releaseActiveSync();
    logRemoteDevelopmentEnvironment("Finished serialized config sync operation", {
      configFilePath,
      operationName,
    });
  }
}

async function syncConfigToRemote(configFilePath: string): Promise<ConfigSyncResult> {
  logRemoteDevelopmentEnvironment("Starting config sync", {
    configFilePath,
  });
  const state = readRemoteDevelopmentEnvironmentState();
  const project = state.projectsByConfigPath[configFilePath];
  if (project == null || state.anonymousRefreshToken == null) {
    warnRemoteDevelopmentEnvironment("Skipping config sync because local state is incomplete", {
      configFilePath,
      hasProject: project != null,
      hasAnonymousRefreshToken: state.anonymousRefreshToken != null,
    });
    return { onboardingStatus: undefined, pushedConfig: false };
  }

  logRemoteDevelopmentEnvironment("Loading config file for sync", {
    configFilePath,
  });
  const { config, showOnboarding } = await readConfigFile(configFilePath);
  const configHash = sha256String(JSON.stringify({ config, showOnboarding, syncFormatVersion: CONFIG_SYNC_FORMAT_VERSION }));
  logRemoteDevelopmentEnvironment("Loaded config file for sync", {
    configFilePath,
    configHash,
    showOnboarding,
  });
  const app = createInternalApp(project.apiBaseUrl, state.anonymousRefreshToken);
  const user = await app.getUser({ or: "anonymous" });
  logRemoteDevelopmentEnvironment("Ensuring development-environment project ownership for config sync", {
    projectId: project.projectId,
    configFilePath,
  });
  const ownedProject = (await user.listOwnedProjects()).find((p) => p.id === project.projectId);
  if (ownedProject == null) {
    warnRemoteDevelopmentEnvironment("Skipping config sync because the project is not owned by the anonymous user", {
      projectId: project.projectId,
      configFilePath,
    });
    return { onboardingStatus: undefined, pushedConfig: false };
  }
  logRemoteDevelopmentEnvironment("Syncing onboarding status before config push", {
    projectId: project.projectId,
    configFilePath,
    showOnboarding,
  });
  const onboardingStatus = await syncRemoteDevelopmentEnvironmentOnboardingStatus(ownedProject, showOnboarding);
  if (project.lastSyncedConfigHash === configHash) {
    logRemoteDevelopmentEnvironment("Skipping config push because remote config hash is current", {
      projectId: project.projectId,
      configFilePath,
      configHash,
      onboardingStatus,
    });
    await updateRemoteDevelopmentEnvironmentPushedConfigError(configFilePath, null);
    return { onboardingStatus, pushedConfig: false };
  }

  logRemoteDevelopmentEnvironment("Sending config push request to development-environment project", {
    projectId: project.projectId,
    configFilePath,
    configHash,
    showOnboarding,
  });
  await ownedProject.replaceConfigOverride("branch", config);

  updateRemoteDevelopmentEnvironmentState((current) => ({
    ...current,
    projectsByConfigPath: {
      ...current.projectsByConfigPath,
      [configFilePath]: {
        ...project,
        lastSyncedConfigHash: configHash,
        updatedAtMillis: Date.now(),
      },
    },
  }));
  logRemoteDevelopmentEnvironment("Synced config to development-environment project", {
    projectId: project.projectId,
    configFilePath,
    configHash,
    showOnboarding,
    onboardingStatus,
  });
  return { onboardingStatus, pushedConfig: true };
}

function scheduleSync(configFilePath: string): void {
  const state = getGlobals();
  if (state.synchronouslyUpdatingConfigFiles.has(configFilePath)) {
    logRemoteDevelopmentEnvironment("Skipping async config sync during synchronous dashboard update", {
      configFilePath,
    });
    return;
  }
  recordConfigSyncEvent(configFilePath, { status: "syncing" });
  const existing = state.syncTimers.get(configFilePath);
  if (existing != null) {
    clearTimeout(existing);
  }
  logRemoteDevelopmentEnvironment(existing == null ? "Scheduling config sync after local file change" : "Rescheduling config sync after another local file change", {
    configFilePath,
    debounceMs: SYNC_DEBOUNCE_MS,
    hasActiveSync: state.activeConfigSyncs.has(configFilePath),
  });
  const timer = setTimeout(() => {
    state.syncTimers.delete(configFilePath);
    runAsynchronously(
      async () => {
        try {
          const result = await runConfigSyncSerialized(
            configFilePath,
            "debounced local file change",
            () => syncConfigToRemote(configFilePath),
          );
          state.syncErrors.delete(configFilePath);
          if (result.pushedConfig) {
            recordConfigSyncEvent(configFilePath, { status: "success" });
          }
        } catch (error) {
          const errorMessage = errorToNiceString(error);
          const cliErrorMessage = formatConfigSyncErrorForCli(configFilePath, error);
          warnRemoteDevelopmentEnvironment("Config sync failed", {
            configFilePath,
            error: errorMessage,
          });
          state.syncErrors.set(configFilePath, error instanceof Error ? error : new Error(errorMessage));
          await updateRemoteDevelopmentEnvironmentPushedConfigError(configFilePath, cliErrorMessage)
            .catch((pushedConfigErrorUpdateError: unknown) => {
              warnRemoteDevelopmentEnvironment("Failed to update pushed config error after config sync failure", {
                configFilePath,
                error: errorToNiceString(pushedConfigErrorUpdateError),
              });
            });
          recordConfigSyncEvent(configFilePath, {
            status: "error",
            errorMessage: cliErrorMessage,
          });
        }
      },
      {
        noErrorLogging: true,
      },
    );
  }, SYNC_DEBOUNCE_MS);
  timer.unref();
  state.syncTimers.set(configFilePath, timer);
}

async function syncConfigToRemoteNow(configFilePath: string): Promise<ConfigSyncResult> {
  const state = getGlobals();
  const pendingTimer = state.syncTimers.get(configFilePath);
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    state.syncTimers.delete(configFilePath);
    logRemoteDevelopmentEnvironment("Canceled pending debounced config sync before immediate sync", {
      configFilePath,
    });
  }
  const result = await runConfigSyncSerialized(
    configFilePath,
    "immediate sync",
    () => syncConfigToRemote(configFilePath),
  );
  state.syncErrors.delete(configFilePath);
  return result;
}

function ensureWatcher(configFilePath: string): void {
  const state = getGlobals();
  if (state.watchers.has(configFilePath)) return;
  const watcher = watchConfigFile(configFilePath, () => {
    scheduleSync(configFilePath);
  });
  watcher.on("error", (error) => {
    // An errored watcher is no longer evidence that the path is watched. The
    // next session heartbeat will retry attachment without restarting the
    // dashboard process.
    if (state.watchers.get(configFilePath) !== watcher) return;
    state.watchers.delete(configFilePath);
    watcher.close();
    warnRemoteDevelopmentEnvironment("Config file watcher failed; will retry on the next heartbeat", {
      configFilePath,
      ...formatErrorForRemoteDevelopmentEnvironmentLog(error),
    });
  });
  watcher.on("close", () => {
    if (state.watchers.get(configFilePath) === watcher) {
      state.watchers.delete(configFilePath);
    }
  });
  state.watchers.set(configFilePath, watcher);
  logRemoteDevelopmentEnvironment("Started watching config file", {
    configFilePath,
    watchedConfigFiles: state.watchers.size,
  });
}

function ensureShutdownTimer(): void {
  const state = getGlobals();
  if (state.shutdownTimerStarted) return;
  state.shutdownTimerStarted = true;
  logRemoteDevelopmentEnvironment("Started shutdown timer", {
    sessionTtlMs: SESSION_TTL_MS,
    startupEmptySessionGraceMs: STARTUP_EMPTY_SESSION_GRACE_MS,
  });
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [id, session] of state.sessions.entries()) {
      const ttlMs = session.receivedFirstHeartbeat ? SESSION_TTL_MS : FIRST_HEARTBEAT_TTL_MS;
      if (now - session.lastHeartbeatMs > ttlMs) {
        warnRemoteDevelopmentEnvironment("Expiring stale session", {
          sessionId: id,
          ageMs: Math.round(now - session.lastHeartbeatMs),
          activeSessionsBeforeExpire: state.sessions.size,
          receivedFirstHeartbeat: session.receivedFirstHeartbeat,
        });
        state.sessions.delete(id);
      }
    }
    if (state.sessions.size === 0 && state.activeOperations === 0 && (state.hasClosedSession || now - state.startedAtMs > STARTUP_EMPTY_SESSION_GRACE_MS)) {
      logRemoteDevelopmentEnvironment("No active sessions remain; shutting down local dashboard", {
        uptimeMs: Math.round(now - state.startedAtMs),
        watchedConfigFiles: state.watchers.size,
        pendingSyncs: state.syncTimers.size,
        activeConfigSyncs: state.activeConfigSyncs.size,
        syncErrors: state.syncErrors.size,
        activeOperations: state.activeOperations,
        hasClosedSession: state.hasClosedSession,
      });
      for (const watcher of state.watchers.values()) watcher.close();
      process.exit(0);
    }
  }, 5_000);
  timer.unref();
}

export function startRemoteDevelopmentEnvironmentLifecycle(): void {
  assertRemoteDevelopmentEnvironmentEnabled();
  if (getGlobals().shutdownTimerStarted) return;
  logRemoteDevelopmentEnvironment("Starting local dashboard lifecycle");
  ensureShutdownTimer();
}

export async function registerRemoteDevelopmentEnvironmentSession(options: {
  apiBaseUrl: string,
  configPath: string,
}): Promise<{ sessionId: string, env: Record<string, string>, projectId: string, onboardingOutstanding: boolean }> {
  assertRemoteDevelopmentEnvironmentEnabled();
  startRemoteDevelopmentEnvironmentLifecycle();
  const configFilePath = resolveConfigFilePath(options.configPath);
  const endOperation = beginRemoteDevelopmentEnvironmentOperation("session registration", {
    apiBaseUrl: options.apiBaseUrl,
    configFilePath,
  });
  try {
    logRemoteDevelopmentEnvironment("Registering CLI session", {
      apiBaseUrl: options.apiBaseUrl,
      configFilePath,
    });
    ensureConfigFileExists(configFilePath);
    const state = readRemoteDevelopmentEnvironmentState();
    const { project } = await getOrCreateProject({
      apiBaseUrl: options.apiBaseUrl,
      configFilePath,
      anonymousRefreshToken: state.anonymousRefreshToken,
    }).catch((error: unknown) => throwApiUnavailableIfConnectionFailure(options.apiBaseUrl, error));
    ensureWatcher(configFilePath);
    const sessionId = randomUUID();
    const globals = getGlobals();
    globals.sessions.set(sessionId, {
      configFilePath,
      lastHeartbeatMs: performance.now(),
      receivedFirstHeartbeat: false,
      lastDeliveredConfigSyncEventId: globals.nextConfigSyncEventId - 1,
    });
    let syncResult: ConfigSyncResult = { onboardingStatus: undefined, pushedConfig: false };
    try {
      syncResult = await syncConfigToRemoteNow(configFilePath);
    } catch (error) {
      if (errorLooksLikeApiConnectionFailure(error)) {
        globals.sessions.delete(sessionId);
        throw new RemoteDevelopmentEnvironmentApiUnavailableError(options.apiBaseUrl, error);
      }
      const errorMessage = errorToNiceString(error);
      warnRemoteDevelopmentEnvironment("Initial config sync failed", {
        sessionId,
        projectId: project.projectId,
        configFilePath,
        error: errorMessage,
      });
      globals.syncErrors.set(configFilePath, error instanceof Error ? error : new Error(errorMessage));
      const cliErrorMessage = formatConfigSyncErrorForCli(configFilePath, error);
      await updateRemoteDevelopmentEnvironmentPushedConfigError(configFilePath, cliErrorMessage)
        .catch((pushedConfigErrorUpdateError: unknown) => {
          warnRemoteDevelopmentEnvironment("Failed to update pushed config error after initial config sync failure", {
            configFilePath,
            error: errorToNiceString(pushedConfigErrorUpdateError),
          });
        });
      recordConfigSyncEvent(configFilePath, {
        status: "error",
        errorMessage: cliErrorMessage,
      });
    }
    logRemoteDevelopmentEnvironment("Registered CLI session", {
      sessionId,
      projectId: project.projectId,
      activeSessions: getGlobals().sessions.size,
      configFilePath,
    });
    return {
      sessionId,
      env: envVarsForProject(project),
      projectId: project.projectId,
      onboardingOutstanding: syncResult.onboardingStatus != null && syncResult.onboardingStatus !== "completed",
    };
  } finally {
    endOperation();
  }
}

export function heartbeatRemoteDevelopmentEnvironmentSession(sessionId: string): {
  configSyncEvents: RemoteDevelopmentEnvironmentConfigSyncEvent[],
} | null {
  assertRemoteDevelopmentEnvironmentEnabled();
  const session = getGlobals().sessions.get(sessionId);
  if (session == null) {
    warnRemoteDevelopmentEnvironment("Received heartbeat for unknown session", {
      sessionId,
    });
    return null;
  }
  session.lastHeartbeatMs = performance.now();
  session.receivedFirstHeartbeat = true;
  try {
    ensureWatcher(session.configFilePath);
  } catch (error) {
    // Keep the session alive so a transient filesystem failure can be retried
    // on the next heartbeat instead of forcing a dashboard restart.
    warnRemoteDevelopmentEnvironment("Could not attach config file watcher; will retry on the next heartbeat", {
      configFilePath: session.configFilePath,
      ...formatErrorForRemoteDevelopmentEnvironmentLog(error),
    });
  }
  return {
    configSyncEvents: drainConfigSyncEventsForSession(session),
  };
}

export function getPendingRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode(): { code: string, expiresAtMillis: number } | null {
  assertRemoteDevelopmentEnvironmentEnabled();
  return peekRemoteDevelopmentEnvironmentBrowserSecretConfirmationCodeForCli();
}

export function closeRemoteDevelopmentEnvironmentSession(sessionId: string): void {
  assertRemoteDevelopmentEnvironmentEnabled();
  const state = getGlobals();
  const existed = state.sessions.delete(sessionId);
  if (existed) {
    state.hasClosedSession = true;
  }
  logRemoteDevelopmentEnvironment("Closed CLI session", {
    sessionId,
    existed,
    activeSessions: state.sessions.size,
  });
}

export function getRemoteDevelopmentEnvironmentProjectConfigPaths(): Map<string, string> {
  assertRemoteDevelopmentEnvironmentEnabled();
  const state = readRemoteDevelopmentEnvironmentState();
  const result = new Map<string, string>();
  for (const [configFilePath, project] of Object.entries(state.projectsByConfigPath)) {
    if (project == null) continue;
    result.set(project.projectId, configFilePath);
  }
  return result;
}

export function getRemoteDevelopmentEnvironmentHealth(): {
  healthy: boolean,
  configFilePath?: string,
} {
  assertRemoteDevelopmentEnvironmentEnabled();
  const globals = getGlobals();
  const activeSession = globals.sessions.values().next().value as ActiveSession | undefined;
  if (activeSession != null) {
    return {
      healthy: true,
      configFilePath: activeSession.configFilePath,
    };
  }

  const state = readRemoteDevelopmentEnvironmentState();
  let configFilePath: string | undefined;
  let latestUpdatedAtMillis = -Infinity;
  for (const [projectConfigFilePath, project] of Object.entries(state.projectsByConfigPath)) {
    if (project == null || project.updatedAtMillis <= latestUpdatedAtMillis) continue;
    configFilePath = projectConfigFilePath;
    latestUpdatedAtMillis = project.updatedAtMillis;
  }

  return {
    healthy: false,
    configFilePath,
  };
}

export function getRemoteDevelopmentEnvironmentDebugSnapshot(): RemoteDevelopmentEnvironmentDebugSnapshot {
  assertRemoteDevelopmentEnvironmentEnabled();
  const globals = getGlobals();
  const now = performance.now();
  const unixNow = Date.now();
  const state = readRemoteDevelopmentEnvironmentState();
  return {
    uptimeMs: Math.round(now - globals.startedAtMs),
    shutdownTimerStarted: globals.shutdownTimerStarted,
    activeOperations: globals.activeOperations,
    hasClosedSession: globals.hasClosedSession,
    sessions: [...globals.sessions.entries()].map(([sessionId, session]) => {
      const ttlMs = session.receivedFirstHeartbeat ? SESSION_TTL_MS : FIRST_HEARTBEAT_TTL_MS;
      const lastHeartbeatAgeMs = Math.round(now - session.lastHeartbeatMs);
      return {
        sessionId,
        configFilePath: session.configFilePath,
        lastHeartbeatAgeMs,
        ttlMs,
        expiresInMs: Math.max(0, ttlMs - lastHeartbeatAgeMs),
        receivedFirstHeartbeat: session.receivedFirstHeartbeat,
      };
    }),
    watchedConfigFiles: [...globals.watchers.keys()],
    pendingSyncConfigFiles: [...globals.syncTimers.keys()],
    syncErrors: [...globals.syncErrors.entries()].map(([configFilePath, error]) => ({
      configFilePath,
      error: errorToNiceString(error),
    })),
    pendingConfigSyncEvents: globals.configSyncEvents.map((event) => event.status === "error"
      ? {
        id: event.id,
        configFilePath: event.configFilePath,
        status: "error",
        errorMessage: event.errorMessage,
        createdAgoMs: Math.max(0, unixNow - event.createdAtMillis),
      }
      : {
        id: event.id,
        configFilePath: event.configFilePath,
        status: event.status,
        createdAgoMs: Math.max(0, unixNow - event.createdAtMillis),
      }),
    synchronouslyUpdatingConfigFiles: [...globals.synchronouslyUpdatingConfigFiles],
    localDashboards: Object.values(state.localDashboardsByPort ?? {})
      .filter((dashboard) => dashboard != null)
      .map((dashboard) => ({
        port: dashboard.port,
        pid: dashboard.pid,
        startedAgoMs: Math.max(0, unixNow - dashboard.startedAtMillis),
        logPath: dashboard.logPath,
      })),
    pendingBrowserSecretConfirmationCodes: Object.entries(state.pendingBrowserSecretConfirmationCodesByPort ?? {})
      .flatMap(([port, code]) => code == null ? [] : [{
        port,
        code: code.code,
        expiresInMs: Math.max(0, code.expiresAtMillis - unixNow),
        updatedAgoMs: Math.max(0, unixNow - code.updatedAtMillis),
      }]),
    projects: Object.entries(state.projectsByConfigPath)
      .flatMap(([configFilePath, project]) => project == null ? [] : [{
        configFilePath,
        projectId: project.projectId,
        teamId: project.teamId,
        apiBaseUrl: project.apiBaseUrl,
        updatedAgoMs: Math.max(0, unixNow - project.updatedAtMillis),
        hasLastSyncedConfigHash: project.lastSyncedConfigHash != null,
      }]),
  };
}

export async function applyRemoteDevelopmentEnvironmentConfigUpdate(options: {
  sessionId?: string,
  projectId?: string,
  configUpdate: Config,
  waitForSync?: boolean,
}): Promise<void> {
  assertRemoteDevelopmentEnvironmentEnabled();
  const configUpdateOperationId = randomUUID();
  const waitForSync = options.waitForSync ?? true;
  const configUpdateLogDetails = {
    configUpdateOperationId,
    sessionId: options.sessionId,
    projectId: options.projectId,
    waitForSync,
    ...summarizeConfigUpdateForLog(options.configUpdate),
  };
  const endOperation = beginRemoteDevelopmentEnvironmentOperation("config update", {
    ...configUpdateLogDetails,
  });
  let resolvedConfigFilePath: string | undefined;
  try {
    const state = getGlobals();
    const sessionEntry = (() => {
      if (options.sessionId != null) {
        const session = state.sessions.get(options.sessionId);
        return session == null ? undefined : { sessionId: options.sessionId, session };
      }
      if (options.projectId == null) {
        throw new Error("Remote development environment config update requires a session ID or project ID.");
      }
      for (const [sessionId, activeSession] of state.sessions.entries()) {
        const stateProject = readRemoteDevelopmentEnvironmentState().projectsByConfigPath[activeSession.configFilePath];
        if (stateProject?.projectId === options.projectId) {
          return { sessionId, session: activeSession };
        }
      }
      return undefined;
    })();
    if (sessionEntry == null) {
      warnRemoteDevelopmentEnvironment("Could not resolve active session for config update", {
        ...configUpdateLogDetails,
        activeSessions: state.sessions.size,
      });
      throw new Error("Remote development environment session is not active.");
    }
    const session = sessionEntry.session;
    const configFilePath = session.configFilePath;
    resolvedConfigFilePath = configFilePath;
    logRemoteDevelopmentEnvironment("Resolved active session for config update", {
      ...configUpdateLogDetails,
      resolvedSessionId: sessionEntry.sessionId,
      configFilePath,
      activeSessions: state.sessions.size,
    });
    logRemoteDevelopmentEnvironment("Applying config update from local dashboard", {
      ...configUpdateLogDetails,
      resolvedSessionId: sessionEntry.sessionId,
      configFilePath,
    });
    const localWriteStartedAtMs = performance.now();
    if (!waitForSync) {
      logRemoteDevelopmentEnvironment("Writing config update without waiting for remote sync", {
        ...configUpdateLogDetails,
        resolvedSessionId: sessionEntry.sessionId,
        configFilePath,
      });
      const currentConfig = (await readConfigFile(configFilePath)).config;
      await replaceConfigObject(configFilePath, override(currentConfig, options.configUpdate));
      scheduleSync(configFilePath);
      logRemoteDevelopmentEnvironment("Wrote config update and scheduled remote sync", {
        ...configUpdateLogDetails,
        resolvedSessionId: sessionEntry.sessionId,
        configFilePath,
        localWriteElapsedMs: Math.round(performance.now() - localWriteStartedAtMs),
      });
    } else {
      state.synchronouslyUpdatingConfigFiles.add(configFilePath);
      try {
        logRemoteDevelopmentEnvironment("Writing config update before immediate remote sync", {
          ...configUpdateLogDetails,
          resolvedSessionId: sessionEntry.sessionId,
          configFilePath,
        });
        await updateConfigObject(configFilePath, options.configUpdate);
        logRemoteDevelopmentEnvironment("Wrote config update before immediate remote sync", {
          ...configUpdateLogDetails,
          resolvedSessionId: sessionEntry.sessionId,
          configFilePath,
          localWriteElapsedMs: Math.round(performance.now() - localWriteStartedAtMs),
        });
      } finally {
        setTimeout(() => {
          state.synchronouslyUpdatingConfigFiles.delete(configFilePath);
        }, SYNC_DEBOUNCE_MS).unref();
      }
      try {
        const syncStartedAtMs = performance.now();
        const result = await syncConfigToRemoteNow(configFilePath);
        if (result.pushedConfig) {
          recordConfigSyncEvent(configFilePath, { status: "success" });
        }
        logRemoteDevelopmentEnvironment("Immediate remote sync after config update completed", {
          ...configUpdateLogDetails,
          resolvedSessionId: sessionEntry.sessionId,
          configFilePath,
          syncElapsedMs: Math.round(performance.now() - syncStartedAtMs),
          pushedConfig: result.pushedConfig,
          onboardingStatus: result.onboardingStatus,
        });
      } catch (error) {
        const errorMessage = errorToNiceString(error);
        warnRemoteDevelopmentEnvironment("Immediate remote sync after config update failed", {
          ...configUpdateLogDetails,
          resolvedSessionId: sessionEntry.sessionId,
          configFilePath,
          ...formatErrorForRemoteDevelopmentEnvironmentLog(error),
        });
        state.syncErrors.set(configFilePath, error instanceof Error ? error : new Error(errorMessage));
        const cliErrorMessage = formatConfigSyncErrorForCli(configFilePath, error);
        await updateRemoteDevelopmentEnvironmentPushedConfigError(configFilePath, cliErrorMessage)
          .catch((pushedConfigErrorUpdateError: unknown) => {
            warnRemoteDevelopmentEnvironment("Failed to update pushed config error after dashboard config sync failure", {
              ...configUpdateLogDetails,
              resolvedSessionId: sessionEntry.sessionId,
              configFilePath,
              ...formatErrorForRemoteDevelopmentEnvironmentLog(pushedConfigErrorUpdateError),
            });
          });
        recordConfigSyncEvent(configFilePath, {
          status: "error",
          errorMessage: cliErrorMessage,
        });
        throw error;
      }
    }
    logRemoteDevelopmentEnvironment("Applied config update from local dashboard", {
      ...configUpdateLogDetails,
      resolvedSessionId: sessionEntry.sessionId,
      configFilePath,
    });
  } catch (error) {
    warnRemoteDevelopmentEnvironment("Failed to apply config update from local dashboard", {
      ...configUpdateLogDetails,
      ...(resolvedConfigFilePath == null ? {} : { configFilePath: resolvedConfigFilePath }),
      ...formatErrorForRemoteDevelopmentEnvironmentLog(error),
    });
    throw error;
  } finally {
    endOperation();
  }
}
