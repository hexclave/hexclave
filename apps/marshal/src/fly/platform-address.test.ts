import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlyCertificate } from "./client.js";
import type { StoredSpec } from "../types.js";

const certificates = vi.hoisted(() => vi.fn(async (): Promise<FlyCertificate[]> => []));
vi.mock("../config.js", async (original) => ({
  ...await original<typeof import("../config.js")>(),
  getConfig: () => ({ envId: "test" }),
  resolveNamespaceOrg: () => ({ orgSlug: "test", token: "test" }),
}));
vi.mock("./client.js", async (original) => ({
  ...await original<typeof import("./client.js")>(),
  flyClientForNamespaceOrg: () => ({ listCertificates: certificates }),
}));

import { createFlyProvider } from "./provider.js";
import { DEVELOPMENT_PLATFORM_HOSTNAME_KEY, platformHostname } from "../platform-domain-names.js";

const stored: StoredSpec = {
  ns: "project", key: "web", revision: "one", created_at_millis: 1, updated_at_millis: 1, last_apply_error: null,
  spec: { source: { image: "nginx:alpine" }, env: {}, config: { type: "serverless", public: true, min_instances: 0, max_instances: 1, ports: { "80": { protocol: "http" } } } },
};

beforeEach(() => {
  certificates.mockClear();
  vi.stubEnv("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY", DEVELOPMENT_PLATFORM_HOSTNAME_KEY);
});

describe("public Fly addresses", () => {
  it("advertises the proxy immediately without querying certificates", async () => {
    const address = await createFlyProvider().address(stored.ns, stored.key, stored);
    expect(address.platformUrl).toBe(`https://${platformHostname("test", stored.ns, stored.key)}`);
    expect(address.internalUrl).toMatch(/^http:\/\/hxc-.+\.flycast:80$/);
    expect(certificates).not.toHaveBeenCalled();
    expect((await createFlyProvider().address(stored.ns, stored.key, { ...stored, revision: "two" })).platformUrl).toBe(address.platformUrl);
  });

  it("does not advertise the proxy for private or TCP services", async () => {
    const privateSpec = { ...stored, spec: { ...stored.spec, config: { ...stored.spec.config, public: false } } };
    expect((await createFlyProvider().address(stored.ns, stored.key, privateSpec)).platformUrl).toBeNull();
    const tcp: StoredSpec = { ...stored, spec: { ...stored.spec, config: { ...stored.spec.config, ports: { "5432": { protocol: "tcp" } } } } };
    expect((await createFlyProvider().address(stored.ns, stored.key, tcp)).platformUrl).toBeNull();
  });
});
