import { describe, expect, it, vi } from "vitest";

// Tearing a service down is the one Fly mutation that can destroy tenant data: destroying an
// app destroys its VOLUMES with it. Everything mocked here exists to let deleteService reach
// its Fly calls and to record them, not to model the rest of the runtime.

const flyVolumes = vi.hoisted(() => vi.fn(async (_app: string) => [] as { id: string }[]));
const domainClaims = vi.hoisted(() => vi.fn(async (_ns: string, _key: string): Promise<string[]> => []));
const fly = vi.hoisted(() => ({
  listVolumes: flyVolumes,
  listMachines: vi.fn(async (_app: string) => [{ id: "machine-1" }, { id: "machine-2" }]),
  destroyMachine: vi.fn(async (_app: string, _machineId: string) => {}),
  deleteApp: vi.fn(async (_app: string) => {}),
  deleteCertificate: vi.fn(async (_app: string, _hostname: string) => {}),
  listCertificates: vi.fn(async (_app: string) => [] as unknown[]),
  getAppIps: vi.fn(async (_app: string) => ({ sharedIpv4: "192.0.2.1", dedicated: [{ id: "v6-id", type: "v6" }] })),
  releaseIpById: vi.fn(async (_app: string, _id: string) => {}),
  releaseIpByAddress: vi.fn(async (_app: string, _ip: string) => {}),
}));

const flyConfiguration = { orgSlug: "org", token: "token", region: "iad", registryHost: "registry.fly.io", machinesApiUrl: "", graphqlApiUrl: "", logsApiUrl: "" };
vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  getConfig: () => ({ envId: "test", fly: flyConfiguration, gcp: null }),
  flyConfig: () => flyConfiguration,
  resolveNamespaceOrg: () => ({ orgSlug: "org", token: "token" }),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./client.js")>(),
  flyClientForNamespaceOrg: () => fly,
}));

vi.mock("../reconciliation-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../reconciliation-lock.js")>(),
  withReconciliationLease: async (_ns: string, _key: string, body: (lease: unknown) => unknown) => {
    return await body({ assertOwned: async () => {} });
  },
}));

vi.mock("../store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../store.js")>(),
  // No runtime pin: the namespace is a Fly namespace, the default.
  readTenantRecord: async () => null,
  listSpecKeys: async () => [],
  readSpec: async () => null,
  listDomainClaimsForService: domainClaims,
  readDomainClaimVersioned: async (hostname: string) => ({ value: { ns: "ns", service_key: "web", hostname }, etag: "etag" }),
  releaseDomainClaim: async () => {},
  readSpecVersioned: async () => null,
  deleteSpecConditionally: async () => {},
}));

import { appNameForService } from "./naming.js";
import { deleteService } from "../services.js";

const APP_NAME = appNameForService("test", "ns", "web");

describe("deleteService", () => {
  const resetMocks = () => {
    for (const mock of Object.values(fly)) mock.mockClear();
    domainClaims.mockClear();
  };

  it("keeps a volume-backed service's disks: machines and ingress go, the app stays", async () => {
    resetMocks();
    flyVolumes.mockResolvedValueOnce([{ id: "vol-1" }]);

    await deleteService("ns", "web");

    // The whole point: deleting the app would take the volume with it, and removing a
    // service from a deploy file must not be irreversible tenant-data loss.
    expect(fly.deleteApp).not.toHaveBeenCalled();
    expect(fly.destroyMachine.mock.calls.map((call) => call[1])).toEqual(["machine-1", "machine-2"]);
    // Nothing serves the app now, so its public addresses must not stay routable.
    expect(fly.releaseIpByAddress).toHaveBeenCalledWith(APP_NAME, "192.0.2.1");
    expect(fly.releaseIpById).toHaveBeenCalledWith(APP_NAME, "v6-id");
  });

  it("destroys an app that holds no volume rather than leaking it", async () => {
    resetMocks();
    flyVolumes.mockResolvedValueOnce([]);

    await deleteService("ns", "web");

    // Nothing is lost here, and an empty app left behind would burn the org's app limit.
    expect(fly.deleteApp).toHaveBeenCalledWith(APP_NAME);
  });

  it("takes the hostname's certificate with the service on either path", async () => {
    for (const volumes of [[{ id: "vol-1" }], []]) {
      resetMocks();
      flyVolumes.mockResolvedValueOnce(volumes);
      domainClaims.mockResolvedValueOnce(["app.example.com"]);

      await deleteService("ns", "web");

      // On the detach path the app outlives the service, so a certificate left behind would
      // keep a hostname pointing at an app with no machines — and would make Fly refuse the
      // same hostname when it is re-attached to another service.
      expect(fly.deleteCertificate, JSON.stringify(volumes)).toHaveBeenCalledWith(APP_NAME, "app.example.com");
    }
  });
});
