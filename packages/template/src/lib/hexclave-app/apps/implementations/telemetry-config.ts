import { snapshotTelemetryResource, type TelemetryResource } from "@hexclave/shared/dist/utils/analytics-wire";

export type { TelemetryResource } from "@hexclave/shared/dist/utils/analytics-wire";

export type TelemetryOptions = {
  /**
   * Immutable identity of the application process/page producing telemetry.
   * Required whenever Analytics or Observability delivery is enabled.
   */
  resource?: TelemetryResource,
  /**
   * Serverless keep-alive hook shared by Analytics and Observability delivery.
   * It is intentionally omitted when an app is serialized across runtimes.
   */
  waitUntil?: (promise: Promise<unknown>) => void,
};

export function snapshotTelemetryOptions(options: TelemetryOptions | undefined): TelemetryOptions | undefined {
  if (options === undefined) return undefined;
  return {
    ...options,
    ...options.resource === undefined ? {} : { resource: snapshotTelemetryResource(options.resource) },
  };
}

/**
 * Drops the function-valued `waitUntil` hook, which cannot survive being
 * serialized into the client payload and re-hydrated. The reverse direction
 * needs no codec: what comes back is already a plain `{ resource }`.
 */
export function telemetryOptionsToJson(options: TelemetryOptions | undefined): TelemetryOptions | undefined {
  if (options?.resource === undefined) return undefined;
  return { resource: snapshotTelemetryResource(options.resource) };
}

/**
 * Guarded `process.env` read. There are no Node types in this package, and
 * browser runtimes may not define `process` at all (bundlers that shim it are
 * covered by the same path). A blank value counts as absent — CI systems
 * routinely export empty strings.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Best-effort service identity for apps that did not configure `telemetry`.
 *
 * Inference keeps zero-config working while leaving the explicit option as the
 * override for projects that run several services against one project.
 *
 * `tier` disambiguates the two halves of an isomorphic app, so a browser bundle
 * and its server never collapse into one service identity by accident.
 */
export function inferTelemetryResource(tier: "browser" | "server"): TelemetryResource {
  // npm_package_name is set by npm/pnpm/yarn when running through a script;
  // the Vercel/Netlify vars cover built deployments where it is absent.
  const inferredName = readEnv("HEXCLAVE_SERVICE_NAME")
    ?? readEnv("VERCEL_PROJECT_NAME")
    ?? readEnv("npm_package_name")
    ?? readEnv("SITE_NAME");
  const version = readEnv("VERCEL_GIT_COMMIT_SHA") ?? readEnv("COMMIT_REF") ?? readEnv("npm_package_version");
  const environment = readEnv("VERCEL_ENV") ?? readEnv("NODE_ENV");
  return snapshotTelemetryResource({
    service: {
      name: inferredName === undefined ? tier : `${inferredName}-${tier}`,
      ...version === undefined ? {} : { version },
    },
    ...environment === undefined ? {} : { deploymentEnvironmentName: environment },
  });
}

/**
 * The resource an app emits telemetry under: the caller's explicit
 * `telemetry.resource` when set, otherwise an inferred one (see
 * inferTelemetryResource). Never throws for a missing resource — only for one
 * that is present and malformed.
 */
export function resolveTelemetryResource(options: TelemetryOptions | undefined, tier: "browser" | "server"): TelemetryResource {
  const resource = options?.resource;
  if (resource === undefined) return inferTelemetryResource(tier);
  return snapshotTelemetryResource(resource);
}
