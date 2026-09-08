import type { SandboxBackend } from "eve/sandbox";
import { docker, type DockerSandboxCreateOptions } from "eve/sandbox/docker";
import {
  vercel,
  type VercelSandboxBootstrapUseOptions,
  type VercelSandboxCreateOptions,
  type VercelSandboxSessionUseOptions,
} from "eve/sandbox/vercel";

const SANDBOX_BACKEND_ENV_VAR = "HEXCLAVE_GROWTH_SANDBOX_BACKEND";

const SANDBOX_BACKEND_IDS = ["docker", "vercel"] as const;
type SandboxBackendId = typeof SANDBOX_BACKEND_IDS[number];

export type GrowthSandboxBackendOptions = {
  readonly docker: DockerSandboxCreateOptions,
  readonly vercel: VercelSandboxCreateOptions,
};

type VercelSandboxBackend = SandboxBackend<VercelSandboxBootstrapUseOptions, VercelSandboxSessionUseOptions>;

/**
 * Eve intentionally creates named, persistent Vercel sandboxes so arbitrary
 * durable agents can resume their filesystem across turns. Growth workflows
 * persist every useful result through authored tools instead, and each root or
 * child sandbox is scratch space for one run. Disable persistence immediately
 * after Eve creates or reattaches the live session so stopping it discards the
 * filesystem instead of creating an automatic snapshot. Template prewarming is
 * delegated unchanged, preserving the reusable snapshots built by `bootstrap`.
 */
export function withEphemeralVercelSessions(backend: VercelSandboxBackend): VercelSandboxBackend {
  return {
    ...backend,
    async create(input) {
      const handle = await backend.create(input);
      try {
        await handle.useSessionFn({ persistent: false });
        return handle;
      } catch (error) {
        await handle.shutdown();
        throw error;
      }
    },
  };
}

function parseBackendId(value: string): SandboxBackendId {

  const ids: readonly string[] = SANDBOX_BACKEND_IDS;
  if (!ids.includes(value)) {
    throw new Error(
      `${SANDBOX_BACKEND_ENV_VAR} must be one of ${SANDBOX_BACKEND_IDS.join(", ")}, got ${JSON.stringify(value)}. `
      + `Fail loudly rather than guessing: picking the wrong one either bills a hosted sandbox for every local run or `
      + `breaks a deployment that cannot run containers.`,
    );
  }
  return SANDBOX_BACKEND_IDS.find((id) => id === value) ?? throwUnreachable(value);
}

function throwUnreachable(value: string): never {
  throw new Error(`Unreachable: ${JSON.stringify(value)} passed the ${SANDBOX_BACKEND_ENV_VAR} allow-list check but matched no id`);
}


export function growthSandboxBackend(options: GrowthSandboxBackendOptions): SandboxBackend {
  const override = process.env[SANDBOX_BACKEND_ENV_VAR];
  const backendId: SandboxBackendId = override != null && override.length > 0
    ? parseBackendId(override)
    : (process.env.VERCEL != null && process.env.VERCEL.length > 0 ? "vercel" : "docker");

  switch (backendId) {
    case "docker": {
      return docker(options.docker);
    }
    case "vercel": {
      return withEphemeralVercelSessions(vercel(options.vercel));
    }
  }
}
