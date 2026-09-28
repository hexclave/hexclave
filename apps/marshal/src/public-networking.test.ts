import { describe, expect, it, vi } from "vitest";
import { reconcilePublicIps } from "./public-networking.js";

function flyWith(options: { sharedIpv4?: string | null, certificates?: { hostname: string }[] } = {}) {
  return {
    getAppIps: vi.fn(async () => ({
      sharedIpv4: options.sharedIpv4 ?? null,
      dedicated: options.sharedIpv4 === undefined ? [] : [{ id: "v6-id", address: "::1", type: "v6" as const }],
    })),
    allocateIp: vi.fn(async () => {}),
    releaseIpById: vi.fn(async () => {}),
    releaseIpByAddress: vi.fn(async () => {}),
    listCertificates: vi.fn(async () => options.certificates ?? []),
  };
}

describe("public service networking", () => {
  it("allocates IPv4 and IPv6 ingress for a public service", async () => {
    const fly = flyWith();
    await reconcilePublicIps(fly, "app", "public");
    expect(fly.allocateIp.mock.calls).toEqual([["app", "shared_v4"], ["app", "v6"]]);
  });

  it("releases public ingress after a service becomes private", async () => {
    const fly = flyWith({ sharedIpv4: "192.0.2.1" });
    await reconcilePublicIps(fly, "app", "private");
    expect(fly.releaseIpByAddress).toHaveBeenCalledWith("app", "192.0.2.1");
    expect(fly.releaseIpById).toHaveBeenCalledWith("app", "v6-id");
  });

  it("keeps ingress for a private service with a custom domain", async () => {
    const fly = flyWith({ sharedIpv4: "192.0.2.1", certificates: [{ hostname: "app.example.com" }] });
    await reconcilePublicIps(fly, "app", "private");
    expect(fly.releaseIpByAddress).not.toHaveBeenCalled();
    expect(fly.releaseIpById).not.toHaveBeenCalled();
  });
});
