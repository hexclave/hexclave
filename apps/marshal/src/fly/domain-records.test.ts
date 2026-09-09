import { describe, expect, it } from "vitest";
import type { FlyCertificateRequirements } from "./client.js";
import { dnsRecordsForRequirements, domainErrorForRequirements, domainStatusForRequirements } from "./provider.js";

// Shaped after a real response from
// GET https://api.machines.dev/v1/apps/<app>/certificates/<hostname>.
function requirements(overrides: {
  hostname?: string,
  status?: string,
  validation?: Partial<FlyCertificateRequirements["validation"]>,
  dns?: Partial<FlyCertificateRequirements["dns_requirements"]>,
  errors?: FlyCertificateRequirements["validation_errors"],
} = {}): FlyCertificateRequirements {
  const hostname = overrides.hostname ?? "example.com";
  return {
    hostname,
    configured: false,
    status: overrides.status ?? "Awaiting configuration",
    validation: {
      dns_configured: false,
      alpn_configured: false,
      http_configured: false,
      ownership_txt_configured: false,
      ...overrides.validation,
    },
    dns_requirements: {
      a: ["66.241.125.232"],
      aaaa: ["2a09:8280:1::188:d6c7:0"],
      cname: "z3d0eez.hxc-app.fly.dev",
      acme_challenge: { name: `_acme-challenge.${hostname}`, target: `${hostname}.z3d0eez.flydns.net.` },
      ownership: { name: `_fly-ownership.${hostname}`, app_value: "app-z3d0eez", org_value: "org-d6d2ld" },
      ...overrides.dns,
    },
    validation_errors: overrides.errors ?? [],
  };
}

describe("dnsRecordsForRequirements", () => {
  it("always includes the ownership TXT, first, while unverified", () => {
    // The whole point of the record: it is the only proof that survives a CDN proxy, and
    // whether the user is behind one is not something Marshal can see.
    const records = dnsRecordsForRequirements(requirements());
    expect(records[0]).toEqual({ type: "TXT", name: "_fly-ownership.example.com", value: "app-z3d0eez" });
  });

  it("publishes the app-scoped ownership value, never the org-scoped one", () => {
    // org_value proves ownership to every app in the platform's Fly org — i.e. to every
    // other tenant — so it must never reach a tenant's DNS instructions.
    const records = dnsRecordsForRequirements(requirements());
    expect(JSON.stringify(records)).not.toContain("org-d6d2ld");
  });

  it("gives an apex A/AAAA records and a subdomain a CNAME", () => {
    expect(dnsRecordsForRequirements(requirements({ hostname: "example.com" })).map((r) => r.type))
      .toEqual(["TXT", "A", "AAAA", "CNAME"]);
    const sub = dnsRecordsForRequirements(requirements({ hostname: "app.example.com" }));
    expect(sub.map((r) => r.type)).toEqual(["TXT", "CNAME", "CNAME"]);
    // The routing CNAME uses Fly's own hashed target, not a guessed `<app>.fly.dev`.
    expect(sub[1]).toEqual({ type: "CNAME", name: "app.example.com", value: "z3d0eez.hxc-app.fly.dev" });
  });

  it("asks for nothing once the certificate is ready", () => {
    expect(dnsRecordsForRequirements(requirements({ status: "Ready" }))).toEqual([]);
  });
});

describe("domainStatusForRequirements", () => {
  it("reports issuing as soon as Fly accepts any one proof", () => {
    // Fly takes any ONE of these; each on its own means the CA step has started, which is
    // what the Fly dashboard calls "Issuing".
    for (const proof of ["dns_configured", "alpn_configured", "http_configured", "ownership_txt_configured"] as const) {
      expect(domainStatusForRequirements(requirements({ validation: { [proof]: true } })), proof).toBe("issuing");
    }
  });

  it("reports awaiting_dns while no proof has landed, and verified when ready", () => {
    expect(domainStatusForRequirements(requirements())).toBe("awaiting_dns");
    expect(domainStatusForRequirements(requirements({ status: "Ready" }))).toBe("verified");
  });

  it("stays verified even though a ready certificate reports no proofs", () => {
    // Real Fly clears nothing when it issues, but the status string is the authority here:
    // a Ready certificate must never be reported as still issuing.
    expect(domainStatusForRequirements(requirements({ status: "Ready", validation: {} }))).toBe("verified");
  });
});

describe("domainErrorForRequirements", () => {
  it("surfaces Fly's own remediation text", () => {
    const error = domainErrorForRequirements(requirements({
      errors: [{
        code: "IPV6_NOT_FOUND",
        message: "No AAAA records were found for your domain",
        remediation: "Add AAAA records pointing to your app's IPv6 addresses, or add a _fly-ownership TXT record to verify domain ownership",
      }],
    }));
    expect(error).toContain("_fly-ownership");
  });

  it("is null when verified, and when Fly reports no problem", () => {
    expect(domainErrorForRequirements(requirements({ status: "Ready" }))).toBeNull();
    expect(domainErrorForRequirements(requirements())).toBeNull();
  });
});
