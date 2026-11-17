import { readConfigValue } from "./config.js";
import { AuthError, CliError } from "./errors.js";

export const DEFAULT_API_URL = "https://api.hexclave.com";
export const DEFAULT_DASHBOARD_URL = "https://app.hexclave.com";
export const DEFAULT_PUBLISHABLE_CLIENT_KEY = process.env.STACK_CLI_PUBLISHABLE_CLIENT_KEY ?? "pck_9bbqvqsbh0gdb6smk11d71qg4ktc4rz8ya7cc69yndm7g";

export type LoginConfig = {
  apiUrl: string,
  dashboardUrl: string,
  publishableClientKey: string,
};

export type SessionAuth = LoginConfig & {
  refreshToken: string,
};

export type ProjectAuthWithRefreshToken = SessionAuth & {
  projectId: string,
};

export type ProjectAuthWithSecretServerKey = LoginConfig & {
  projectId: string,
  secretServerKey: string,
};

export type ProjectAuth = (ProjectAuthWithRefreshToken | ProjectAuthWithSecretServerKey) & {
  projectId: string,
};

function resolveHexclaveStackEnvVar(hexclaveName: string, stackName: string): string | undefined {
  const hexclaveValue = process.env[hexclaveName];
  const stackValue = process.env[stackName];
  const hasHexclaveValue = hexclaveValue != null && hexclaveValue !== "";
  const hasStackValue = stackValue != null && stackValue !== "";
  if (hasHexclaveValue && hasStackValue && hexclaveValue !== stackValue) {
    throw new CliError(`Environment variables ${hexclaveName} and ${stackName} are both set to different values. Remove one of them or set them to the same value.`);
  }
  if (hasHexclaveValue) return hexclaveValue;
  if (hasStackValue) return stackValue;
  return undefined;
}

function resolveApiUrl(): string {
  return resolveHexclaveStackEnvVar("HEXCLAVE_API_URL", "STACK_API_URL")
    ?? readConfigValue("STACK_API_URL")
    ?? DEFAULT_API_URL;
}

function resolveDashboardUrl(): string {
  return resolveHexclaveStackEnvVar("HEXCLAVE_DASHBOARD_URL", "STACK_DASHBOARD_URL")
    ?? readConfigValue("STACK_DASHBOARD_URL")
    ?? DEFAULT_DASHBOARD_URL;
}

function resolveRefreshToken(): string {
  const token = process.env.STACK_CLI_REFRESH_TOKEN
    ?? readConfigValue("STACK_CLI_REFRESH_TOKEN");
  if (!token) {
    throw new AuthError("Not logged in. Run `hexclave login` first.");
  }
  return token;
}

function resolveSecretServerKey(): string | null {
  return resolveHexclaveStackEnvVar("HEXCLAVE_SECRET_SERVER_KEY", "STACK_SECRET_SERVER_KEY") ?? null;
}

export function resolveLoginConfig(): LoginConfig {
  return {
    apiUrl: resolveApiUrl(),
    dashboardUrl: resolveDashboardUrl(),
    publishableClientKey: DEFAULT_PUBLISHABLE_CLIENT_KEY,
  };
}

export function resolveSessionAuth(): SessionAuth {
  return {
    ...resolveLoginConfig(),
    refreshToken: resolveRefreshToken(),
  };
}

export function resolveAuth(projectId: string): ProjectAuth {
  const secretServerKey = resolveSecretServerKey();
  if (secretServerKey) {
    return {
      ...resolveLoginConfig(),
      projectId,
      secretServerKey,
    };
  }

  return {
    ...resolveSessionAuth(),
    projectId,
  };
}

export function resolveProjectId(projectIdOption?: string, missingMessage = "No project ID provided. Pass --cloud-project-id <id> or set the HEXCLAVE_PROJECT_ID environment variable."): string {
  if (projectIdOption != null && projectIdOption !== "") {
    return projectIdOption;
  }
  const projectIdFromEnv = resolveHexclaveStackEnvVar("HEXCLAVE_PROJECT_ID", "STACK_PROJECT_ID");
  if (projectIdFromEnv != null && projectIdFromEnv !== "") {
    return projectIdFromEnv;
  }
  throw new CliError(missingMessage);
}

export function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  return err.name === "TypeError" || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(err.message);
}

export function isProjectAuthWithSecretServerKey(auth: ProjectAuth): auth is ProjectAuthWithSecretServerKey {
  return "secretServerKey" in auth;
}

export function isProjectAuthWithRefreshToken(auth: ProjectAuth): auth is ProjectAuthWithRefreshToken {
  return "refreshToken" in auth;
}
