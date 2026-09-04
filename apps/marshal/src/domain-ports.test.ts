import { describe, expect, it, vi } from "vitest";

// The service under test throws inside the domain guard, which is the FIRST thing
// applyServiceSpecWithLease does after reading config. Everything mocked here exists to let
// execution reach that line, not to model the rest of the apply.

const domainClaims = vi.hoisted(() => vi.fn(async (_ns: string, _key: string): Promise<string[]> => []));
const domainClaim = vi.hoisted(() => vi.fn(async (hostname: string): Promise<{
  value: { hostname: string, ns: string, service_key: string, claimed_at_millis: number },
  etag: string,
} | null> => ({
  value: { hostname, ns: "namespace", service_key: "web", claimed_at_millis: 1 },
  etag: "claim-etag",
})));

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  getConfig: () => ({ envId: "test" }),
}));

vi.mock("./reconciliation-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./reconciliation-lock.js")>(),
  // Run the body directly: the lease is not what these tests are about, and taking a real one
  // would need the bucket.
  withReconciliationLease: async (_ns: string, _key: string, body: (lease: unknown) => unknown) => {
    return await body({ assertOwned: async () => {} });
  },
}));

vi.mock("./store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./store.js")>(),
  listDomainClaimsForService: domainClaims,
  readDomainClaimVersioned: domainClaim,
}));

import { applyServiceSpec, assertServiceCanHoldADomain, validateServiceSpec } from "./services.js";


function spec(ports: unknown) {
  return validateServiceSpec({
    config: { type: "serverless", min_instances: 0, max_instances: 1, ports },
    source: { image: "us-central1-docker.pkg.dev/example/runtime/example@sha256:abc" },
    env: {},
  });
}

const apply = async (ports: unknown) => await applyServiceSpec("namespace", "web", spec(ports));

describe("the domain port rule", () => {
  it("refuses a port set that a domain would publish", () => {
    // An HTTP port beside a private database port: legal for a service with no domain,
    // catastrophic for one with a domain, because the proxy would serve 5432 on the public IPs
    // the domain allocated.
    expect(() => assertServiceCanHoldADomain("web", { "3000": { protocol: "http" }, "5432": { protocol: "tcp" } }, false, "remedy"))
      .toThrow(/may not declare more than one port/);
    // Two HTTP ports on a PRIVATE service fail for the same reason, and this is where
    // the domain rule is stricter than validateServiceSpec: that spec is legal precisely
    // because nothing can reach it, and the domain is what makes it reachable.
    expect(() => assertServiceCanHoldADomain("web", { "3000": { protocol: "http" }, "4000": { protocol: "http" } }, false, "remedy"))
      .toThrow(/may not declare more than one port/);
    expect(() => assertServiceCanHoldADomain("web", { "5432": { protocol: "tcp" } }, false, "remedy"))
      .toThrow(/need an HTTP port/);
    expect(() => assertServiceCanHoldADomain("web", {}, false, "remedy")).toThrow(/need an HTTP port/);
    expect(() => assertServiceCanHoldADomain("web", { "3000": { protocol: "http" } }, false, "remedy")).not.toThrow();
    // A PUBLIC service can hold a domain at any port count: it is already reachable,
    // so there is nothing the domain newly publishes, and it fronts the holder (3000).
    expect(() => assertServiceCanHoldADomain("web", { "3000": { protocol: "http" }, "4000": { protocol: "http" } }, true, "remedy"))
      .not.toThrow();
  });

  it("carries the caller's remedy, so each site says what to do about it", () => {
    expect(() => assertServiceCanHoldADomain("web", {}, false, "Detach the domains.")).toThrow(/Detach the domains\./);
  });
});

describe("a spec write against a service that holds a domain", () => {
  // REGRESSION: the guard here used to re-check only the "must keep an HTTP port" half of the
  // rule. A domain's public IPs outlive the attach that allocated them, so checking the port
  // count at attach time alone left this sequence open:
  //
  //   1. create `web` with one private HTTP port      — nothing is `public: true`
  //   2. attach a custom domain                       — allowed: one port, HTTP. Public IPs now exist.
  //   3. PUT `web` with a private `tcp` 5432 sibling  — spec validation passes (still no
  //                                                     `public: true` port), old guard passes
  //   4. the domain gateway answers 5432 on its public IP — the database is on the internet.
  //
  // Step 3 is an ordinary config edit. The whole rule has to be re-checked on every write.
  it("refuses to add a private sibling port after a domain was attached", async () => {
    domainClaims.mockResolvedValue(["app.example.com"]);
    await expect(apply({ "3000": { protocol: "http" }, "5432": { protocol: "tcp" } }))
      .rejects.toThrow(/may not declare more than one port/);
    await expect(apply({ "3000": { protocol: "http" }, "4000": { protocol: "http" } }))
      .rejects.toThrow(/may not declare more than one port/);
  });

  it("still refuses to drop the HTTP port the domain routes to", async () => {
    domainClaims.mockResolvedValue(["app.example.com"]);
    await expect(apply({ "5432": { protocol: "tcp" } })).rejects.toThrow(/need an HTTP port/);
    await expect(apply({  })).rejects.toThrow(/need an HTTP port/);
  });

  it("tells the caller to detach the domains", async () => {
    domainClaims.mockResolvedValue(["app.example.com"]);
    await expect(apply({ "3000": { protocol: "http" }, "5432": { protocol: "tcp" } })).rejects.toThrow(/[Dd]etach/);
  });

  it("leaves a service without domains free to declare several private ports", async () => {
    // The rule is about domains, not about multi-port services: with no domain attached there
    // are no public IPs, so private siblings are exactly as private as they claim to be.
    // The apply still fails afterwards, on the store calls this test deliberately does not
    // mock — so assert on which error came back rather than on success.
    domainClaims.mockResolvedValue([]);
    const error = await apply({ "3000": { protocol: "http" }, "5432": { protocol: "tcp" } }).then(() => null, (caught: unknown) => caught);
    expect(error).not.toBeNull();
    expect(String(error)).not.toMatch(/may not declare a private port alongside others|need an HTTP port/);
  });

  it("does not treat an orphaned domain index as current ownership", async () => {
    domainClaims.mockResolvedValue(["orphan.example.com"]);
    domainClaim.mockResolvedValueOnce(null);

    const error = await apply({ "3000": { protocol: "http" }, "5432": { protocol: "tcp" } }).then(() => null, (caught: unknown) => caught);
    expect(error).not.toBeNull();
    expect(String(error)).not.toMatch(/may not declare more than one port|need an HTTP port/);
  });
});
