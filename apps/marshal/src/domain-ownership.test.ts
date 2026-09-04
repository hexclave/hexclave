import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainClaim, PendingDomainClaim } from "./types.js";

let pending: { value: PendingDomainClaim, etag: string } | null = null;
let claimed: { value: DomainClaim, etag: string } | null = null;
const hasDomainVerificationRecord = vi.hoisted(() => vi.fn());
const claimDomain = vi.hoisted(() => vi.fn());
const beginDomainClaimDeletion = vi.hoisted(() => vi.fn());
const readDomainClaimVersioned = vi.hoisted(() => vi.fn());
const releaseDomainClaim = vi.hoisted(() => vi.fn());
const ensureDomainGateway = vi.hoisted(() => vi.fn());
const ensureDomain = vi.hoisted(() => vi.fn());
const deleteDomain = vi.hoisted(() => vi.fn());

vi.mock("./domain-verification.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./domain-verification.js")>(),
  createDomainVerificationToken: () => "tenant-bound-token",
  hasDomainVerificationRecord,
}));
vi.mock("./reconciliation-lock.js", () => ({
  withReconciliationLease: async (_ns: string, _key: string, fn: (lease: { assertOwned: () => Promise<void> }) => Promise<unknown>) => await fn({ assertOwned: async () => {} }),
}));
vi.mock("./platform-domain-lock.js", () => ({
  withPlatformDomainLease: async (fn: (lease: { assertOwned: () => Promise<void> }) => Promise<unknown>) => await fn({ assertOwned: async () => {} }),
}));
vi.mock("./services.js", () => ({
  assertServiceCanHoldADomain: () => {},
  resolveEnv: async () => ({ ok: true, env: {} }),
}));
vi.mock("./gcp/runtime.js", () => ({ ensureDomainGateway }));
vi.mock("./gcp/context.js", () => ({
  tenantContext: async () => ({
    domains: {
      ensureFrontendDnsRecords: async (hostname: string) => [{ type: "A", name: hostname, value: "203.0.113.10" }],
      ensure: ensureDomain,
      delete: deleteDomain,
    },
  }),
}));
vi.mock("./store.js", () => ({
  readSpec: async () => ({ spec: { config: { ports: { "3000": { protocol: "http" } }, public: true }, env: {} } }),
  readDomainClaim: async () => claimed?.value ?? null,
  readDomainClaimVersioned,
  readPendingDomainClaimVersioned: async () => pending,
  createPendingDomainClaim: async (value: PendingDomainClaim) => {
    pending = { value, etag: "pending-etag" };
    return pending.etag;
  },
  deletePendingDomainClaim: async () => {
    pending = null;
    return true;
  },
  claimDomain,
  beginDomainClaimDeletion,
  rewriteDomainClaim: vi.fn(),
  releaseDomainClaim,
}));

import { attachDomain, detachDomain } from "./domains.js";

describe("custom-domain ownership", () => {
  beforeEach(() => {
    pending = null;
    claimed = null;
    hasDomainVerificationRecord.mockReset();
    claimDomain.mockReset();
    beginDomainClaimDeletion.mockReset();
    readDomainClaimVersioned.mockReset();
    releaseDomainClaim.mockReset();
    ensureDomainGateway.mockReset();
    ensureDomain.mockReset();
    deleteDomain.mockReset();
    readDomainClaimVersioned.mockImplementation(async () => claimed);
    ensureDomainGateway.mockResolvedValue("cloud-run-service");
    ensureDomain.mockResolvedValue({
      hostname: "app.example.com",
      verified: true,
      dnsRecords: [{ type: "A", name: "app.example.com", value: "203.0.113.10" }],
    });
    claimDomain.mockImplementation(async (value: DomainClaim) => {
      claimed = { value, etag: "claim-etag" };
      return true;
    });
    beginDomainClaimDeletion.mockImplementation(async (current: { value: DomainClaim, etag: string }, deletingAtMillis: number) => {
      const deleting = { value: { ...current.value, deleting_at_millis: deletingAtMillis }, etag: "deleting-etag" };
      claimed = deleting;
      return deleting;
    });
    releaseDomainClaim.mockImplementation(async () => {
      claimed = null;
      return true;
    });
  });

  it("does not create a global claim or tenant route until the TXT token verifies", async () => {
    hasDomainVerificationRecord.mockResolvedValueOnce(false);

    await expect(attachDomain("tenant-a", "app.example.com", "web")).resolves.toEqual({
      hostname: "app.example.com",
      service_key: "web",
      verified: false,
      dns_records: [
        { type: "TXT", name: "_hexclave-verification.app.example.com", value: "hexclave-domain-verification=tenant-bound-token" },
        { type: "A", name: "app.example.com", value: "203.0.113.10" },
      ],
    });
    expect(claimDomain).not.toHaveBeenCalled();
    expect(ensureDomainGateway).not.toHaveBeenCalled();
    expect(ensureDomain).not.toHaveBeenCalled();

    hasDomainVerificationRecord.mockResolvedValueOnce(true);
    await expect(attachDomain("tenant-a", "app.example.com", "web")).resolves.toMatchObject({ verified: true });
    expect(claimDomain).toHaveBeenCalledOnce();
    expect(ensureDomain).toHaveBeenCalledOnce();
  });

  it("does not delete provider state when a queued detach observes a newer owner", async () => {
    const oldClaim = { value: { hostname: "app.example.com", ns: "tenant-a", service_key: "web", claimed_at_millis: 1 }, etag: "old-etag" };
    const newClaim = { value: { hostname: "app.example.com", ns: "tenant-b", service_key: "web", claimed_at_millis: 2 }, etag: "new-etag" };
    readDomainClaimVersioned.mockResolvedValueOnce(oldClaim).mockResolvedValueOnce(newClaim);

    await expect(detachDomain("tenant-a", "app.example.com", "web")).rejects.toThrow("changed owners");
    expect(releaseDomainClaim).not.toHaveBeenCalled();
    expect(deleteDomain).not.toHaveBeenCalled();
  });

  it("keeps a tombstone until its provider route has been deleted", async () => {
    const order: string[] = [];
    claimed = { value: { hostname: "app.example.com", ns: "tenant-a", service_key: "web", claimed_at_millis: 1 }, etag: "claim-etag" };
    releaseDomainClaim.mockImplementationOnce(async () => {
      order.push("release");
      claimed = null;
      return true;
    });
    deleteDomain.mockImplementationOnce(async () => {
      order.push("provider-delete");
    });
    beginDomainClaimDeletion.mockImplementationOnce(async (current: { value: DomainClaim, etag: string }) => {
      order.push("tombstone");
      const deleting = { value: { ...current.value, deleting_at_millis: 2 }, etag: "deleting-etag" };
      claimed = deleting;
      return deleting;
    });

    await expect(detachDomain("tenant-a", "app.example.com", "web")).resolves.toBeUndefined();
    expect(order).toEqual(["tombstone", "provider-delete", "release"]);
  });

  it("retains the deletion tombstone when provider cleanup fails so retry can resume", async () => {
    claimed = { value: { hostname: "app.example.com", ns: "tenant-a", service_key: "web", claimed_at_millis: 1 }, etag: "claim-etag" };
    deleteDomain.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(detachDomain("tenant-a", "app.example.com", "web")).rejects.toThrow("provider unavailable");
    expect(claimed.value.deleting_at_millis).toBeDefined();
    expect(releaseDomainClaim).not.toHaveBeenCalled();
  });
});
