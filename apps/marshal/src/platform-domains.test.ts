import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDomainState } from "./platform-domain-state.js";
import type { StoredSpec } from "./types.js";

const { states, specs } = vi.hoisted(() => ({ states: new Map<string, PlatformDomainState>(), specs: new Map<string, StoredSpec>() }));
vi.mock("./config.js", async (original) => ({
  ...await original<typeof import("./config.js")>(),
  getConfig: () => ({ envId: "test" }),
  flyConfig: () => ({ token: "test-token", machinesApiUrl: "https://api.machines.dev" }),
  resolveNamespaceOrg: () => ({ token: "test-token", orgSlug: "test-org" }),
}));
vi.mock("./store.js", async (original) => ({
  ...await original<typeof import("./store.js")>(),
  readPlatformDomain: async (ns: string, key: string) => states.get(JSON.stringify([ns, key])) ?? null,
  writePlatformDomain: async (state: PlatformDomainState) => { states.set(JSON.stringify([state.ns, state.key]), state); },
  deletePlatformDomain: async (ns: string, key: string) => { states.delete(JSON.stringify([ns, key])); },
  listPlatformDomains: async () => [...states.values()].map(({ ns, key }) => ({ ns, key })),
  readSpec: async (ns: string, key: string) => specs.get(JSON.stringify([ns, key])) ?? null,
}));

import { PlatformDomainDnsClient, PlatformDomainFlyClient, PlatformDomainApiError } from "./platform-domain-api.js";
import { platformHostname } from "./platform-domain-names.js";
import { enqueuePlatformDomain, reconcilePlatformDomain, removePlatformDomain } from "./platform-domains.js";
import { FlyClient, type FlyCertificate } from "./fly/client.js";
import { createFlyProvider } from "./fly/provider.js";
import { attachDomain, detachDomain } from "./domains.js";
import { MutationOutcomeUnknownError } from "./mutation-safety.js";

const ns = "namespace";
const key = "group/web";
const identity = JSON.stringify([ns, key]);
const hostname = platformHostname("test", ns, key);
const lease = { assertOwned: async () => {} };
const stored: StoredSpec = {
  ns, key, revision: "revision", created_at_millis: 1, updated_at_millis: 1, last_apply_error: null,
  spec: { source: { image: "nginx:latest" }, env: {}, config: { type: "serverless", public: true, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } } },
};
const certificate = (ready: boolean, retryAt: number | null = null) => ({ hostname, ready, retryAt, cname: "app.fly.dev", challengeName: `_acme-challenge.${hostname}`, challengeTarget: "app.flydns.net" });
const graphCertificate = (clientStatus: string): FlyCertificate => ({ hostname, clientStatus, id: "id", configured: true, acmeDnsConfigured: true, dnsValidationHostname: `_acme-challenge.${hostname}`, dnsValidationTarget: "app.flydns.net", isApex: false, issued: { nodes: [] } });
const get = vi.spyOn(PlatformDomainFlyClient.prototype, "get");
const create = vi.spyOn(PlatformDomainFlyClient.prototype, "create");
const check = vi.spyOn(PlatformDomainFlyClient.prototype, "check");
const deleteCertificate = vi.spyOn(PlatformDomainFlyClient.prototype, "delete");
const ensureDns = vi.spyOn(PlatformDomainDnsClient.prototype, "ensure");
const deleteDns = vi.spyOn(PlatformDomainDnsClient.prototype, "delete");
const listCertificates = vi.spyOn(FlyClient.prototype, "listCertificates");

beforeEach(() => {
  states.clear();
  specs.clear();
  specs.set(identity, structuredClone(stored));
  vi.stubEnv("HEXCLAVE_VERCEL_DNS_TOKEN", "test-token");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  get.mockReset().mockResolvedValue(null);
  create.mockReset().mockResolvedValue(certificate(false));
  check.mockReset().mockResolvedValue(certificate(true));
  deleteCertificate.mockReset().mockResolvedValue(undefined);
  ensureDns.mockReset().mockResolvedValue(undefined);
  deleteDns.mockReset().mockResolvedValue(undefined);
  listCertificates.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform domain lifecycle", () => {
  it("allocates stable names isolated across tenants, groups, and environments", () => {
    expect(hostname).toMatch(/^deploy-[a-f0-9]{40}\.built-with-hexclave\.com$/);
    const names = new Set([hostname, platformHostname("test", "other", key), platformHostname("prod", ns, key), platformHostname("test", ns, "other/web")]);
    expect(names.size).toBe(4);
    expect(platformHostname("test", ns, key)).toBe(hostname);
  });

  it("queues provisioning without contacting Fly or Vercel on the deployment path", async () => {
    await enqueuePlatformDomain(stored, lease);
    expect(states.get(identity)).toEqual({ ns, key, hostname, ready: false, nextAttemptAt: 0, error: "pending" });
    expect(create).not.toHaveBeenCalled();
    expect(ensureDns).not.toHaveBeenCalled();
    expect((await createFlyProvider().address(ns, key, stored)).platformUrl).toMatch(/\.fly\.dev$/);
  });

  it("uses the branded URL only after DNS and TLS are ready", async () => {
    await enqueuePlatformDomain(stored, lease);
    await reconcilePlatformDomain(ns, key, lease);
    expect(ensureDns.mock.calls).toEqual([[hostname, "app.fly.dev"], [`_acme-challenge.${hostname}`, "app.flydns.net"]]);
    expect(states.get(identity)?.ready).toBe(true);
    listCertificates.mockResolvedValue([graphCertificate("Ready")]);
    expect((await createFlyProvider().address(ns, key, stored)).platformUrl).toBe(`https://${hostname}`);
    // A stale ready observation cannot advertise an expired/missing certificate.
    listCertificates.mockResolvedValue([graphCertificate("Awaiting certificates")]);
    expect((await createFlyProvider().address(ns, key, stored)).platformUrl).toMatch(/\.fly\.dev$/);
  });

  it("preserves the Fly fallback and cooldown after hitting the certificate limit", async () => {
    const retryAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    create.mockRejectedValue(new PlatformDomainApiError("fly", 429, retryAt));
    await enqueuePlatformDomain(stored, lease);
    await expect(reconcilePlatformDomain(ns, key, lease)).resolves.toBeUndefined();
    expect(states.get(identity)).toMatchObject({ ready: false, error: "rate_limited", nextAttemptAt: retryAt });
    await enqueuePlatformDomain({ ...stored, revision: "new-revision" }, lease);
    await reconcilePlatformDomain(ns, key, lease);
    expect(create).toHaveBeenCalledOnce();
    expect((await createFlyProvider().address(ns, key, stored)).platformUrl).toMatch(/\.fly\.dev$/);
    expect(stored.last_apply_error).toBeNull();
  });

  it("honors a rate limit reported on a successful Fly response", async () => {
    const retryAt = Date.now() + 3_600_000;
    get.mockResolvedValue(certificate(false, retryAt));
    await enqueuePlatformDomain(stored, lease);
    await reconcilePlatformDomain(ns, key, lease);
    expect(check).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(states.get(identity)).toMatchObject({ ready: false, error: "rate_limited", nextAttemptAt: retryAt });
  });

  it("records a DNS failure and reuses the existing certificate on retry", async () => {
    ensureDns.mockRejectedValueOnce(new PlatformDomainApiError("vercel", 403, null));
    await enqueuePlatformDomain(stored, lease);
    await reconcilePlatformDomain(ns, key, lease);
    expect(states.get(identity)).toMatchObject({ ready: false, error: "provider_error" });
    const state = states.get(identity);
    if (state === undefined) throw new Error("expected queued state");
    states.set(identity, { ...state, nextAttemptAt: 0 });
    get.mockResolvedValue(certificate(true));
    await reconcilePlatformDomain(ns, key, lease);
    expect(create).toHaveBeenCalledOnce();
    expect(states.get(identity)?.ready).toBe(true);
  });

  it("persists retry state before an uncertain write and propagates it for lease draining", async () => {
    create.mockRejectedValueOnce(new MutationOutcomeUnknownError("timeout", { cause: new Error("timeout") }));
    await enqueuePlatformDomain(stored, lease);
    await expect(reconcilePlatformDomain(ns, key, lease)).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    expect(states.get(identity)?.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("does not conceal programming errors as optional-provider failures", async () => {
    get.mockRejectedValueOnce(new Error("invariant failed"));
    await enqueuePlatformDomain(stored, lease);
    await expect(reconcilePlatformDomain(ns, key, lease)).rejects.toThrow("invariant failed");
  });

  it("does not queue private services or deployments without DNS credentials", async () => {
    const privateStored = { ...stored, spec: { ...stored.spec, config: { ...stored.spec.config, public: false } } };
    await enqueuePlatformDomain(privateStored, lease);
    vi.stubEnv("HEXCLAVE_VERCEL_DNS_TOKEN", "");
    await enqueuePlatformDomain(stored, lease);
    expect(states.size).toBe(0);
  });

  it("cleans up DNS before certificates and retains state when cleanup fails", async () => {
    await enqueuePlatformDomain(stored, lease);
    deleteDns.mockRejectedValueOnce(new PlatformDomainApiError("vercel", 503, null));
    await expect(removePlatformDomain(ns, key, lease)).rejects.toBeInstanceOf(PlatformDomainApiError);
    expect(deleteCertificate).not.toHaveBeenCalled();
    expect(states.has(identity)).toBe(true);
    await removePlatformDomain(ns, key, lease);
    expect(deleteDns.mock.invocationCallOrder[1]).toBeLessThan(deleteCertificate.mock.invocationCallOrder[0]);
    expect(states.has(identity)).toBe(false);
  });

  it("cleans up when the desired service is deleted or private", async () => {
    await enqueuePlatformDomain(stored, lease);
    specs.delete(identity);
    await reconcilePlatformDomain(ns, key, lease);
    expect(states.size).toBe(0);
    expect(deleteCertificate).toHaveBeenCalledWith(hostname);
  });

  it("never exposes a generated certificate as a private service URL", async () => {
    listCertificates.mockResolvedValue([graphCertificate("Ready")]);
    const privateStored = { ...stored, spec: { ...stored.spec, config: { ...stored.spec.config, public: false } } };
    expect((await createFlyProvider().address(ns, key, privateStored)).platformUrl).toBeNull();
  });

  it("rejects manual attachment and detachment of reserved platform names", async () => {
    await expect(attachDomain(ns, hostname, key)).rejects.toThrow("managed automatically");
    await expect(detachDomain(ns, hostname, key)).rejects.toThrow("managed automatically");
  });
});
