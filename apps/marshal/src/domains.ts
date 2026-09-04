import { badRequest, conflict, notFound } from "./errors.js";
import { createDomainVerificationToken, domainVerificationRecord, hasDomainVerificationRecord } from "./domain-verification.js";
import { ensureDomainGateway } from "./gcp/runtime.js";
import { tenantContext } from "./gcp/context.js";
import { withReconciliationLease } from "./reconciliation-lock.js";
import { withPlatformDomainLease } from "./platform-domain-lock.js";
import { assertServiceCanHoldADomain, resolveEnv } from "./services.js";
import { beginDomainClaimDeletion, claimDomain, createPendingDomainClaim, deletePendingDomainClaim, readDomainClaim, readDomainClaimVersioned, readPendingDomainClaimVersioned, readSpec, releaseDomainClaim, rewriteDomainClaim } from "./store.js";
import type { DnsRecord } from "./types.js";

// KEPT IN SYNC WITH the backend's HOSTNAME_REGEX (apps/backend/src/lib/deployments/index.tsx),
// duplicated because Marshal is standalone and takes no @hexclave/shared dependency.
const HOSTNAME_REGEX = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// DNS propagation routinely takes longer than an interactive setup session. Pending claims are
// tenant-local and do not reserve the hostname globally, so keeping the same proof usable for a
// day improves retry UX without letting an unverified tenant block the real owner.
const PENDING_DOMAIN_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeHostnameOrThrow(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_REGEX.test(normalized)) throw badRequest(`invalid hostname ${JSON.stringify(hostname)}`);
  return normalized;
}

export type AttachDomainResult = {
  hostname: string,
  service_key: string,
  verified: boolean,
  dns_records: DnsRecord[],
};

export async function attachDomain(ns: string, hostname: string, serviceKey: string): Promise<AttachDomainResult> {
  return await withReconciliationLease(ns, serviceKey, async (lease) => {
    const stored = await readSpec(ns, serviceKey);
    if (stored === null) throw notFound(`service ${JSON.stringify(serviceKey)} not found in namespace ${JSON.stringify(ns)}`);
    assertServiceCanHoldADomain(serviceKey, stored.spec.config.ports, stored.spec.config.public, "Change the service's ports first, then attach the domain.");
    let existingClaim = await readDomainClaimVersioned(hostname);
    if (existingClaim === null) {
      let pending = await readPendingDomainClaimVersioned(ns, hostname);
      if (pending !== null && pending.value.expires_at_millis <= Date.now()) {
        await deletePendingDomainClaim(pending);
        pending = null;
      }
      if (pending === null) {
        const now = Date.now();
        await createPendingDomainClaim({
          hostname,
          ns,
          service_key: serviceKey,
          verification_token: createDomainVerificationToken(),
          created_at_millis: now,
          expires_at_millis: now + PENDING_DOMAIN_CLAIM_TTL_MS,
        });
        pending = await readPendingDomainClaimVersioned(ns, hostname);
        if (pending === null) throw new Error(`pending domain claim for ${hostname} disappeared immediately after creation`);
      }
      if (pending.value.service_key !== serviceKey) {
        throw conflict(`hostname ${JSON.stringify(hostname)} already has a pending attachment to another service in this namespace`);
      }

      const routingRecords = await withPlatformDomainLease(async (platformLease) => {
        await lease.assertOwned();
        await platformLease.assertOwned();
        return await (await tenantContext(ns)).domains.ensureFrontendDnsRecords(hostname);
      });
      const verificationRecord = domainVerificationRecord(hostname, pending.value.verification_token);
      if (!await hasDomainVerificationRecord(hostname, pending.value.verification_token)) {
        return { hostname, service_key: serviceKey, verified: false, dns_records: [verificationRecord, ...routingRecords] };
      }

      const claimed = await claimDomain({ hostname, ns, service_key: serviceKey, claimed_at_millis: Date.now() });
      if (!claimed) {
        existingClaim = await readDomainClaimVersioned(hostname);
        if (existingClaim === null || existingClaim.value.ns !== ns || existingClaim.value.service_key !== serviceKey) {
          throw conflict(`hostname ${JSON.stringify(hostname)} was verified and claimed elsewhere concurrently`);
        }
      }
      await deletePendingDomainClaim(pending);
    } else if (existingClaim.value.deleting_at_millis !== undefined) {
      throw conflict(`hostname ${JSON.stringify(hostname)} is still being detached; retry shortly`);
    } else if (existingClaim.value.ns !== ns) {
      throw conflict(`hostname ${JSON.stringify(hostname)} is already attached elsewhere`);
    } else if (existingClaim.value.service_key !== serviceKey) {
      // TODO(security): require renewed DNS proof for repoints, and design a proof-based
      // takeover flow for domains whose DNS ownership changed while an old A record and claim
      // remained. The initial tenant-bound proof prevents first-claim theft, but it is not yet
      // re-evaluated over the lifetime of an existing claim.
      const rewritten = await rewriteDomainClaim(existingClaim, { hostname, ns, service_key: serviceKey, claimed_at_millis: Date.now() });
      if (!rewritten) throw conflict(`hostname ${JSON.stringify(hostname)} changed owners concurrently; retry the attach`);
      await lease.assertOwned();
      await withPlatformDomainLease(async (platformLease) => {
        await lease.assertOwned();
        await platformLease.assertOwned();
        await (await tenantContext(ns)).domains.delete(hostname);
      });
    } else {
      await claimDomain(existingClaim.value);
    }

    const resolved = await resolveEnv(ns, stored.spec.env);
    if (!resolved.ok) throw badRequest(`service ${JSON.stringify(serviceKey)} is blocked on unresolved environment references`);
    const target = await ensureDomainGateway(stored, lease);
    await lease.assertOwned();
    const state = await withPlatformDomainLease(async (platformLease) => {
      await lease.assertOwned();
      await platformLease.assertOwned();
      return await (await tenantContext(ns)).domains.ensure(hostname, target);
    });
    return { hostname, service_key: serviceKey, verified: state.verified, dns_records: state.dnsRecords };
  });
}

export async function readDomain(ns: string, hostname: string): Promise<AttachDomainResult> {
  const claim = await readDomainClaim(hostname);
  if (claim === null) {
    const pending = await readPendingDomainClaimVersioned(ns, hostname);
    if (pending === null) throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
    return await attachDomain(ns, hostname, pending.value.service_key);
  }
  if (claim.ns !== ns) throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
  const state = await (await tenantContext(ns)).domains.get(hostname);
  if (state === null) throw notFound(`hostname ${JSON.stringify(hostname)} has no load balancer on service ${JSON.stringify(claim.service_key)}`);
  return { hostname, service_key: claim.service_key, verified: state.verified, dns_records: state.dnsRecords };
}

export async function detachDomain(ns: string, hostname: string, expectedServiceKey?: string): Promise<void> {
  const claim = await readDomainClaimVersioned(hostname);
  if (claim === null) {
    const pending = await readPendingDomainClaimVersioned(ns, hostname);
    if (pending === null || (expectedServiceKey !== undefined && pending.value.service_key !== expectedServiceKey)) {
      throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
    }
    // TODO(security): serialize pending deletion with the pending service's reconciliation
    // lease and make attachDomain revalidate the pending ETag immediately before claiming.
    // Without that, DELETE can report success while an already-in-flight verified PUT still
    // publishes the hostname. This is a revocation race, not an initial ownership bypass.
    await deletePendingDomainClaim(pending);
    return;
  }
  if (claim.value.ns !== ns) throw notFound(`hostname ${JSON.stringify(hostname)} is not attached in namespace ${JSON.stringify(ns)}`);
  if (expectedServiceKey !== undefined && claim.value.service_key !== expectedServiceKey) {
    throw notFound(`hostname ${JSON.stringify(hostname)} is not attached to service ${JSON.stringify(expectedServiceKey)} in namespace ${JSON.stringify(ns)}`);
  }
  await withReconciliationLease(ns, claim.value.service_key, async (lease) => {
    const detached = await withPlatformDomainLease(async (platformLease) => {
      await lease.assertOwned();
      await platformLease.assertOwned();
      const current = await readDomainClaimVersioned(hostname);
      if (current === null
        || current.etag !== claim.etag
        || current.value.ns !== ns
        || current.value.service_key !== claim.value.service_key) return false;
      const deleting = await beginDomainClaimDeletion(current, Date.now());
      if (deleting === null) return false;
      await (await tenantContext(ns)).domains.delete(hostname);
      await lease.assertOwned();
      await platformLease.assertOwned();
      if (!await releaseDomainClaim(deleting)) throw conflict(`hostname ${JSON.stringify(hostname)} cleanup changed concurrently; retry the detach`);
      return true;
    });
    if (!detached) throw notFound(`hostname ${JSON.stringify(hostname)} changed owners while it was being detached`);
  });
}
