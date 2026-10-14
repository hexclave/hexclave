import { withReconciliationLease, type ReconciliationLeaseGuard } from "./reconciliation-lock.js";

// Every custom domain shares one platform URL map. Service reconciliation is
// deliberately concurrent, so URL-map read/modify/write operations need their
// own distributed lease or two tenants can silently overwrite each other's
// routes. The service lease remains responsible for the service and claim.
export async function withPlatformDomainLease<T>(action: (lease: ReconciliationLeaseGuard) => Promise<T>): Promise<T> {
  return await withReconciliationLease("__platform__", "shared-domain-routing", action);
}
