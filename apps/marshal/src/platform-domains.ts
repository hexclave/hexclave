import { flyConfig, getConfig, MOCK_FLY_TOKEN } from "./config.js";
import { appNameForService } from "./fly/naming.js";
import { MutationOutcomeUnknownError } from "./mutation-safety.js";
import { PlatformDomainApiError, PlatformDomainDnsClient, PlatformDomainFlyClient, platformDomainsEnabled } from "./platform-domain-api.js";
import { platformHostname } from "./platform-domain-names.js";
import { ReconciliationLeaseLostError, withReconciliationLease, type ReconciliationLeaseGuard } from "./reconciliation-lock.js";
import { specIsPublic } from "./spec-helpers.js";
import { deletePlatformDomain, listPlatformDomains, readPlatformDomain, readSpec, writePlatformDomain } from "./store.js";
import type { StoredSpec } from "./types.js";

const MINUTE = 60_000;

export async function enqueuePlatformDomain(stored: StoredSpec, lease: ReconciliationLeaseGuard): Promise<void> {
  if (!platformDomainsEnabled() || !specIsPublic(stored.spec)) return;
  const existing = await readPlatformDomain(stored.ns, stored.key);
  if (existing !== null) return; // Redeploys must not reset an ACME cooldown.
  await lease.assertOwned();
  await writePlatformDomain({
    ns: stored.ns, key: stored.key,
    hostname: platformHostname(getConfig().envId, stored.ns, stored.key),
    ready: false, nextAttemptAt: 0, error: "pending",
  });
}

export async function removePlatformDomain(ns: string, key: string, lease: ReconciliationLeaseGuard): Promise<void> {
  const state = await readPlatformDomain(ns, key);
  if (state === null) return;
  const expected = platformHostname(getConfig().envId, ns, key);
  if (state.hostname !== expected) throw new Error("platform domain identity changed; refusing cleanup");
  const fly = new PlatformDomainFlyClient(ns, appNameForService(getConfig().envId, ns, key), lease);
  // Remove DNS before releasing the app/certificate, preventing a dangling record
  // from pointing to an app name that another owner could subsequently acquire.
  await new PlatformDomainDnsClient(expected, lease).delete();
  await fly.delete(expected);
  await lease.assertOwned();
  await deletePlatformDomain(ns, key);
}

export async function reconcilePlatformDomain(ns: string, key: string, lease: ReconciliationLeaseGuard): Promise<void> {
  const state = await readPlatformDomain(ns, key);
  if (state === null || state.nextAttemptAt > Date.now()) return;
  if (state.hostname !== platformHostname(getConfig().envId, ns, key)) throw new Error("platform domain identity changed; refusing provisioning");
  const stored = await readSpec(ns, key);
  if (stored === null || !specIsPublic(stored.spec)) {
    await removePlatformDomain(ns, key, lease);
    return;
  }
  const fly = new PlatformDomainFlyClient(ns, appNameForService(getConfig().envId, ns, key), lease);
  const dns = new PlatformDomainDnsClient(state.hostname, lease);
  // Persist a retry BEFORE external operations. A timeout or process termination can
  // leave a successful provider mutation behind; the next tick reads before creating.
  await lease.assertOwned();
  await writePlatformDomain({ ...state, nextAttemptAt: Date.now() + 5 * MINUTE });
  try {
    let certificate = await fly.get(state.hostname) ?? await fly.create(state.hostname);
    await dns.ensure(state.hostname, certificate.cname);
    await dns.ensure(certificate.challengeName, certificate.challengeTarget);
    if (!certificate.ready && (certificate.retryAt === null || certificate.retryAt <= Date.now())) {
      certificate = await fly.check(state.hostname);
    }
    await lease.assertOwned();
    await writePlatformDomain({
      ...state,
      ready: certificate.ready,
      nextAttemptAt: certificate.ready ? Date.now() + 24 * 60 * MINUTE : Math.max(Date.now() + 5 * MINUTE, certificate.retryAt ?? 0),
      error: certificate.ready ? null : certificate.retryAt !== null ? "rate_limited" : "pending",
    });
  } catch (error) {
    // Only expected provider failures degrade the optional address. Programming errors,
    // corrupt state and fencing failures still surface to the maintenance caller.
    if (!(error instanceof PlatformDomainApiError)) throw error;
    console.warn("platform domain provisioning deferred", { provider: error.provider, status: error.status });
    await lease.assertOwned();
    await writePlatformDomain({
      ...state, ready: false,
      nextAttemptAt: Math.max(Date.now() + 15 * MINUTE, error.retryAt ?? 0),
      error: error.status === 429 ? "rate_limited" : "provider_error",
    });
  }
}

export async function stepPlatformDomains(): Promise<{ processed: number }> {
  if (!platformDomainsEnabled()) return { processed: 0 };
  // Real DNS must never be pointed at the local Fly simulator.
  if (flyConfig().token === MOCK_FLY_TOKEN) throw new Error("platform DNS provisioning requires real Fly credentials");
  const started = performance.now();
  const due = [];
  for (const identity of await listPlatformDomains()) {
    const state = await readPlatformDomain(identity.ns, identity.key);
    if (state !== null && state.nextAttemptAt <= Date.now()) due.push(state);
  }
  due.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  let processed = 0;
  for (const state of due) {
    if (processed >= 10 || performance.now() - started > 45_000) break;
    try {
      await withReconciliationLease(state.ns, state.key, async (lease) => await reconcilePlatformDomain(state.ns, state.key, lease));
    } catch (error) {
      // The lease wrapper must see uncertain writes so it preserves the drain period.
      // Nothing here changes the deployment's success or its usable fly.dev address.
      if (!(error instanceof MutationOutcomeUnknownError || error instanceof ReconciliationLeaseLostError)) throw error;
      console.warn("platform domain reconciliation will retry after its lease drains");
    }
    processed++;
  }
  return { processed };
}
