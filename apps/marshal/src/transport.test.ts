import { describe, expect, it } from "vitest";
import { computeRevision } from "./revision.js";
import { soleHttpPort, specIsPublic, standardPortsHolderFor, validateServiceSpec } from "./services.js";

const TEST_DATA_KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");

function spec(config: Record<string, unknown> = {}) {
  return {
    config: { type: "serverless", min_instances: 0, max_instances: 1, public: false, ports: { "3000": { protocol: "http" } }, ...config },
    source: { image: "docker.io/library/nginx:latest" },
    env: {},
  };
}

describe("service transport validation", () => {
  it("defaults to private and preserves explicit public ingress", () => {
    expect(specIsPublic(validateServiceSpec(spec()))).toBe(false);
    expect(specIsPublic(validateServiceSpec(spec({ public: true })))).toBe(true);
  });

  it("accepts the provider-neutral API shapes even when a provider has stricter reconciliation constraints", () => {
    expect(() => validateServiceSpec(spec({ ports: {} }))).not.toThrow();
    expect(() => validateServiceSpec(spec({ public: true, ports: { "3000": { protocol: "http" }, "8080": { protocol: "http" } } }))).not.toThrow();
    expect(() => validateServiceSpec(spec({ type: "server", ports: { "5432": { protocol: "tcp" } } }))).not.toThrow();
  });

  it("rejects public raw TCP and public services with no ports", () => {
    expect(() => validateServiceSpec(spec({ public: true, ports: { "5432": { protocol: "tcp" } } }))).toThrow(/may not declare a "tcp" port/);
    expect(() => validateServiceSpec(spec({ public: true, ports: {} }))).toThrow(/must declare at least one port/);
  });

  it("requires canonical unique port keys", () => {
    for (const key of ["0", "080", "65536", "abc", "-1"]) {
      expect(() => validateServiceSpec(spec({ ports: { [key]: { protocol: "http" } } }))).toThrow(/port number between 1 and 65535/);
    }
  });

  it("selects a sole HTTP port and the lowest public standard-port holder", () => {
    expect(soleHttpPort({ "3000": { protocol: "http" } })).toBe(3000);
    expect(soleHttpPort({ "3000": { protocol: "http" }, "5432": { protocol: "tcp" } })).toBe(3000);
    expect(soleHttpPort({ "3000": { protocol: "http" }, "8080": { protocol: "http" } })).toBeNull();
    expect(standardPortsHolderFor({ "8080": { protocol: "http" }, "3000": { protocol: "http" } }, true)).toBe(3000);
  });

  it("rolls the revision for every transport-visible change", () => {
    const revision = (config: Record<string, unknown>) => computeRevision(validateServiceSpec(spec(config)), TEST_DATA_KEY);
    const revisions = [
      revision({}),
      revision({ public: true }),
      revision({ ports: { "8080": { protocol: "http" } } }),
      revision({ type: "server", ports: { "3000": { protocol: "http" } } }),
    ];
    expect(new Set(revisions).size).toBe(revisions.length);
  });
});
