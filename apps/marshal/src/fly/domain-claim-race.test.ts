import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainClaim } from "../types.js";
import type { FlyCertificate } from "./client.js";

// The registry state the race is fought over. `claimDomain` is the atomic conditional create:
// it succeeds for whichever request gets there first and fails for every one after.
let claimed: { value: DomainClaim, etag: string } | null = null;

const claimDomain = vi.hoisted(() => vi.fn());
const readDomainClaimVersioned = vi.hoisted(() => vi.fn());
const rewriteDomainClaim = vi.hoisted(() => vi.fn());
const addCertificate = vi.hoisted(() => vi.fn());

vi.mock("../config.js", async (original) => ({
  ...await original<typeof import("../config.js")>(),
  getConfig: () => ({ envId: "test" }),
  resolveNamespaceOrg: () => ({ orgSlug: "test", token: "test" }),
}));
vi.mock("../spec-helpers.js", async (original) => ({
  ...await original<typeof import("../spec-helpers.js")>(),
  assertServiceCanHoldADomain: () => {},
}));
vi.mock("../public-networking.js", () => ({
  ensurePublicIps: async () => {},
  reconcilePublicIps: async () => {},
  releasePublicIpsIfUnused: async () => {},
}));
vi.mock("../store.js", async (original) => ({
  ...await original<typeof import("../store.js")>(),
  readSpec: async () => ({ spec: { config: { ports: { "80": { protocol: "http" } }, public: true }, env: {} } }),
  readDomainClaimVersioned,
  claimDomain,
  rewriteDomainClaim,
}));
vi.mock("./client.js", async (original) => ({
  ...await original<typeof import("./client.js")>(),
  flyClientForNamespaceOrg: () => ({
    addCertificate,
    getCertificate: async (): Promise<FlyCertificate> => ({ id: "cert", hostname: "app.example.com", clientStatus: "Ready" } as FlyCertificate),
    getCertificateRequirements: async () => null,
  }),
}));

import { createFlyProvider } from "./provider.js";

const attach = async (ns: string, serviceKey: string) => await createFlyProvider().domains.attach(ns, "app.example.com", serviceKey);

describe("Fly custom-domain claim races", () => {
  beforeEach(() => {
    claimed = null;
    claimDomain.mockReset();
    readDomainClaimVersioned.mockReset();
    rewriteDomainClaim.mockReset();
    addCertificate.mockReset();
    addCertificate.mockResolvedValue({ id: "cert", hostname: "app.example.com", clientStatus: "Ready" } as FlyCertificate);
    readDomainClaimVersioned.mockImplementation(async () => claimed);
    claimDomain.mockImplementation(async (value: DomainClaim) => {
      // Conditional create: the first writer wins, and a re-assert of the SAME owner is a
      // no-op rather than a failure (matching the store's index re-write).
      if (claimed !== null && claimed.value.service_key !== value.service_key) return false;
      if (claimed === null) claimed = { value, etag: "claim-etag" };
      return true;
    });
  });

  // Two concurrent attaches of the same hostname on the same service both read no claim and
  // both try to create one. The loser must reach the same idempotent answer as a sequential
  // replay: losing the create race says someone got there first, NOT that someone ELSE owns it.
  it("treats a lost create race against the same service as an idempotent re-attach", async () => {
    readDomainClaimVersioned.mockResolvedValueOnce(null);
    claimDomain.mockResolvedValueOnce(false);
    claimed = { value: { hostname: "app.example.com", ns: "tenant-a", service_key: "web", claimed_at_millis: 1 }, etag: "winner-etag" };

    await expect(attach("tenant-a", "web")).resolves.toMatchObject({ hostname: "app.example.com", service_key: "web", verified: true });
    expect(rewriteDomainClaim).not.toHaveBeenCalled();
  });

  // The same lost race, but the winner is a DIFFERENT tenant: still a genuine conflict, and
  // the message must not name the namespace that holds it.
  it("still refuses a lost create race won by another namespace", async () => {
    readDomainClaimVersioned.mockResolvedValueOnce(null);
    claimDomain.mockResolvedValueOnce(false);
    claimed = { value: { hostname: "app.example.com", ns: "tenant-b", service_key: "web", claimed_at_millis: 1 }, etag: "winner-etag" };

    await expect(attach("tenant-a", "web")).rejects.toThrow("already attached elsewhere");
  });

  // Claimed and then released between the two reads: there is no owner left to reconcile
  // against, so the caller is told to retry rather than being handed a bogus success.
  it("asks the caller to retry when the winning claim vanishes before it can be read", async () => {
    readDomainClaimVersioned.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    claimDomain.mockResolvedValueOnce(false);

    await expect(attach("tenant-a", "web")).rejects.toThrow("changed owners concurrently");
  });
});
