// Custom domains: a hostname belongs to exactly one (namespace, service) claim in the bucket's
// global registry, and the runtime the namespace runs on decides how the hostname is proven,
// routed and certified. Both halves live with the provider (see fly/provider.ts and
// gcp/provider.ts, `domains`); this module is the entry point that picks one.
import { badRequest } from "./errors.js";
import { providerForNamespace, type AttachDomainResult } from "./provider.js";

export type { AttachDomainResult };

// KEPT IN SYNC WITH the backend's HOSTNAME_REGEX (apps/backend/src/lib/deployments/index.tsx),
// duplicated because Marshal is standalone and takes no @hexclave/shared dependency. The
// backend copy must stay at least as strict as this one.
const HOSTNAME_REGEX = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function normalizeHostnameOrThrow(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_REGEX.test(normalized)) throw badRequest(`invalid hostname ${JSON.stringify(hostname)}`);
  return normalized;
}

export async function attachDomain(ns: string, hostname: string, serviceKey: string): Promise<AttachDomainResult> {
  return await (await providerForNamespace(ns)).domains.attach(ns, hostname, serviceKey);
}

// Read-only: the "re-check verification now" primitive. A PUT would repoint the hostname,
// so callers that only want current state must use this.
export async function readDomain(ns: string, hostname: string): Promise<AttachDomainResult> {
  return await (await providerForNamespace(ns)).domains.read(ns, hostname);
}

// `expectedServiceKey` fences a stale detach: when the hostname has since been repointed to
// another service in this namespace, removing it on behalf of the OLD service would tear down
// the new owner's live certificate. Treated as already-detached (404) instead.
export async function detachDomain(ns: string, hostname: string, expectedServiceKey?: string): Promise<void> {
  await (await providerForNamespace(ns)).domains.detach(ns, hostname, expectedServiceKey);
}
