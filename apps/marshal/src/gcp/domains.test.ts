import { afterEach, describe, expect, it, vi } from "vitest";
import { GcpClient } from "./client.js";
import { DomainLoadBalancerClient } from "./domains.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custom-domain load balancer lifecycle", () => {
  it("keeps the backend in the tenant and shares the frontend in the platform project", async () => {
    const client = new GcpClient();
    const resources = new Map<string, unknown>();
    const mutations: { method: string, url: string, body: unknown }[] = [];
    let address = 0;
    vi.spyOn(client, "request").mockImplementation(async (url, options) => {
      const method = options?.method ?? "GET";
      if (method === "GET") return resources.get(url) ?? null;
      mutations.push({ method, url, body: options?.body ?? null });
      if (method === "DELETE") {
        resources.delete(url);
        return url.includes("certificatemanager.googleapis.com")
          ? { name: `operations/delete-${mutations.length}`, done: true }
          : { selfLink: `https://compute.googleapis.com/operations/delete-${mutations.length}`, status: "DONE" };
      }
      if (method === "PUT") {
        resources.set(url, { ...objectBody(options?.body), fingerprint: `fingerprint-${mutations.length}` });
        return { selfLink: `https://compute.googleapis.com/operations/update-${mutations.length}`, status: "DONE" };
      }
      const parsed = new URL(url);
      const body = objectBody(options?.body);
      if (parsed.host === "compute.googleapis.com") {
        const resourceUrl = `${parsed.origin}${parsed.pathname}/${String(body.name)}`;
        resources.set(resourceUrl, {
          ...body,
          selfLink: resourceUrl,
          ...(parsed.pathname.endsWith("/addresses") ? { address: `203.0.113.${++address}` } : {}),
          ...(parsed.pathname.endsWith("/urlMaps") ? { fingerprint: `fingerprint-${mutations.length}` } : {}),
        });
        return { selfLink: `https://compute.googleapis.com/operations/create-${mutations.length}`, status: "DONE" };
      }
      const id = parsed.searchParams.get("certificateId") ?? parsed.searchParams.get("certificateMapId") ?? parsed.searchParams.get("certificateMapEntryId");
      if (id === null) throw new Error(`test mock received Certificate Manager create without an id: ${url}`);
      const resourceUrl = `${parsed.origin}${parsed.pathname}/${id}`;
      resources.set(resourceUrl, {
        ...body,
        name: resourceUrl,
        ...(parsed.searchParams.has("certificateId") ? { managed: { ...objectBody(body.managed), state: "PROVISIONING" } } : {}),
      });
      return { name: `operations/create-${mutations.length}`, done: true };
    });
    const domains = new DomainLoadBalancerClient(client, {
      tenantProjectId: "tenant-project",
      platformProjectId: "platform-project",
      environmentId: "test",
      region: "us-central1",
    });

    const state = await domains.ensure("app.example.com", "service-name");

    expect(state).toEqual({
      hostname: "app.example.com",
      verified: false,
      dnsRecords: [{ type: "A", name: "app.example.com", value: "203.0.113.1" }],
    });
    const creates = mutations.filter((mutation) => mutation.method === "POST");
    expect(creates.filter((mutation) => mutation.url.includes("compute.googleapis.com")).map((mutation) => new URL(mutation.url).pathname)).toMatchInlineSnapshot(`
      [
        "/compute/v1/projects/tenant-project/regions/us-central1/networkEndpointGroups",
        "/compute/v1/projects/tenant-project/global/backendServices",
        "/compute/v1/projects/platform-project/global/backendServices",
        "/compute/v1/projects/platform-project/global/urlMaps",
        "/compute/v1/projects/platform-project/global/targetHttpsProxies",
        "/compute/v1/projects/platform-project/global/addresses",
        "/compute/v1/projects/platform-project/global/forwardingRules",
      ]
    `);
    expect(creates.filter((mutation) => mutation.url.includes("certificatemanager.googleapis.com"))).toHaveLength(3);
    expect(mutations.find((mutation) => mutation.method === "PUT")?.body).toMatchObject({
      hostRules: [{ hosts: ["app.example.com"] }],
      pathMatchers: [{ defaultService: expect.stringContaining("/projects/tenant-project/global/backendServices/") }],
    });

    await domains.delete("app.example.com");

    expect(await domains.get("app.example.com")).toBeNull();
    expect(mutations.filter((mutation) => mutation.method === "DELETE").map((mutation) => new URL(mutation.url).host)).toEqual([
      "certificatemanager.googleapis.com",
      "certificatemanager.googleapis.com",
      "compute.googleapis.com",
      "compute.googleapis.com",
    ]);
    expect(resources.has("https://compute.googleapis.com/compute/v1/projects/platform-project/global/addresses/hxp-9f86d081884c7d65-ip")).toBe(true);

    await domains.deleteSharedFrontend();

    expect(mutations.filter((mutation) => mutation.method === "DELETE").map((mutation) => new URL(mutation.url).pathname)).toMatchInlineSnapshot(`
      [
        "/v1/projects/platform-project/locations/global/certificateMaps/hxp-9f86d081884c7d65-cert-map/certificateMapEntries/hxd-c152567dc9c3fdb4eefe7bcf-entry",
        "/v1/projects/platform-project/locations/global/certificates/hxd-c152567dc9c3fdb4eefe7bcf-cert",
        "/compute/v1/projects/tenant-project/global/backendServices/hxd-c152567dc9c3fdb4eefe7bcf-backend",
        "/compute/v1/projects/tenant-project/regions/us-central1/networkEndpointGroups/hxd-c152567dc9c3fdb4eefe7bcf-neg",
        "/compute/v1/projects/platform-project/global/forwardingRules/hxp-9f86d081884c7d65-https",
        "/compute/v1/projects/platform-project/global/targetHttpsProxies/hxp-9f86d081884c7d65-proxy",
        "/compute/v1/projects/platform-project/global/addresses/hxp-9f86d081884c7d65-ip",
        "/compute/v1/projects/platform-project/global/urlMaps/hxp-9f86d081884c7d65-map",
        "/compute/v1/projects/platform-project/global/backendServices/hxp-9f86d081884c7d65-fallback",
        "/v1/projects/platform-project/locations/global/certificateMaps/hxp-9f86d081884c7d65-cert-map",
      ]
    `);
    expect(resources.size).toBe(0);
  });
});

function objectBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("test mock expected an object request body");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
