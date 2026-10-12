// Which infrastructure runtime a namespace's services run on, and how that is decided.
//
// Two runtimes exist: "fly" (the default, what every namespace runs on unless it says
// otherwise) and "gcp" (opted into per namespace). The choice is PINNED per namespace in the
// bucket the first time a mutating request names one, because the two cannot mix within a
// namespace: services share a private network and resolve each other's addresses, and a
// runtime cannot see the other's. A namespace with no record is a Fly namespace — which is
// what makes every namespace that existed before the second runtime did need no migration.
//
// The backend sends `runtime` on the requests that can create resources (deploying, applying
// a spec). Reads resolve through the pin alone. A mismatch between the request and the pin
// is a conflict unless the namespace holds no services at all, in which case the pin simply
// moves: the runtime is chosen by whoever deploys next into an empty namespace.

import { getConfig } from "./config.js";
import { MarshalError, badRequest, conflict } from "./errors.js";
import { listSpecKeys, pinTenantRuntime, readTenantRecord } from "./store.js";

export const DEPLOYMENT_RUNTIMES = ["fly", "gcp"] as const;
export type DeploymentRuntime = (typeof DEPLOYMENT_RUNTIMES)[number];
export const DEFAULT_RUNTIME: DeploymentRuntime = "fly";

export function isDeploymentRuntime(value: unknown): value is DeploymentRuntime {
  return typeof value === "string" && (DEPLOYMENT_RUNTIMES as readonly string[]).includes(value);
}

/** The runtime a request body names, or undefined when it names none. A 400 for anything else. */
export function validateRequestedRuntime(value: unknown): DeploymentRuntime | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isDeploymentRuntime(value)) throw badRequest(`runtime must be one of ${DEPLOYMENT_RUNTIMES.map((runtime) => JSON.stringify(runtime)).join(", ")}`);
  return value;
}

export function runtimeIsConfigured(runtime: DeploymentRuntime): boolean {
  const config = getConfig();
  return runtime === "fly" ? config.fly !== null : config.gcp !== null;
}

function assertRuntimeConfigured(runtime: DeploymentRuntime): void {
  if (runtimeIsConfigured(runtime)) return;
  // 503 rather than 400: the request is well-formed, this Marshal simply cannot serve it.
  throw new MarshalError(503, "runtime_unavailable", `the ${JSON.stringify(runtime)} runtime is not configured on this Marshal`);
}

/**
 * The runtime a namespace's services run on.
 *
 * With no `requested` runtime (every read), this is the pin, or the default when the
 * namespace has none. With one, it is the pin when they agree; when they disagree the pin
 * moves to the requested runtime if the namespace is EMPTY (it holds no specs), and the
 * request is refused with a 409 otherwise — the services that exist were created on the
 * pinned runtime and would be orphaned there by an apply on the other one.
 *
 * The pin is written before the first resource is created. A crash between the two leaves a
 * pin over an empty namespace, which the rule above lets the next deploy move or keep.
 */
export async function resolveNamespaceRuntime(ns: string, requested?: DeploymentRuntime): Promise<DeploymentRuntime> {
  const record = await readTenantRecord(ns);
  const pinned = record?.runtime ?? DEFAULT_RUNTIME;
  if (requested === undefined || requested === pinned) {
    if (requested !== undefined) assertRuntimeConfigured(requested);
    return pinned;
  }
  assertRuntimeConfigured(requested);
  const existing = await listSpecKeys(ns);
  if (existing.length > 0) {
    throw conflict(`this project's services run on the ${JSON.stringify(pinned)} runtime, and a deploy cannot move them to ${JSON.stringify(requested)}: remove every service from the project (deploy with none declared) before changing its runtime`);
  }
  await pinTenantRuntime(ns, requested);
  return requested;
}
