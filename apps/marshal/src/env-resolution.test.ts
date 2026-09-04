import { describe, expect, it, vi } from "vitest";
import type { PortsConfig } from "./types.js";

// resolveEnv reaches for the stored spec only when the target is NOT part of the
// deployment being applied, so the store is mocked to stand in for "what was
// deployed last time" — which is exactly what must NOT win for an in-flight target.
const readSpec = vi.hoisted(() => vi.fn());
const runtimeAddress = vi.hoisted(() => vi.fn());
// The GCP provider, whose address is the target's rollout: a VM's internal IP, or nothing.
const provider = vi.hoisted(() => ({ kind: "gcp" as const }));

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  getConfig: () => ({ envId: "test" }),
}));

vi.mock("./store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./store.js")>(),
  readSpec,
}));

vi.mock("./provider.js", () => ({
  providerForNamespace: async () => ({
    ...provider,
    // GCP: no name-derived private host — a reference waits for the target's address.
    staticPrivateHost: () => null,
    address: async (ns: string, key: string, stored: unknown) => {
      const address = await runtimeAddress(ns, key, stored) as { hostname: string | null, platformUrl: string | null, internalUrl: string | null };
      // What the GCP provider does: a server's private host is its VM IP; Cloud Run has none.
      return { ...address, privateHost: (stored as { spec: { config: { type: string } } }).spec.config.type === "server" ? address.hostname : null };
    },
  }),
}));

import { resolveEnv } from "./services.js";

// A private server is reached at its VM's internal IP. There is no name-derived
// hostname on GCP: nothing publishes "<service>.internal", so a ref that cannot see
// a running VM must block rather than hand out a name that fails to resolve.
const dbIp = "10.128.0.5";

const ports = (config: PortsConfig): PortsConfig => config;
const storedSpec = (isPublic: boolean, type: "server" | "serverless" = "server") => ({
  spec: { config: { type, public: isPublic, min_instances: 0, max_instances: 1, ports: ports({ "8080": { protocol: "http" } }) }, source: { image: "img" }, env: {} },
  revision: "stored",
});

describe("url() resolution against a target being changed in the same deploy", () => {
  it("takes visibility from THIS deployment's targets, not the stored spec", async () => {
    // REGRESSION: visibility used to be read from the target's STORED spec while
    // its ports came from the deployment. A service flipped public -> private in
    // this very deploy therefore still read as public until its own apply landed,
    // so a sibling applied first baked in a platform URL that the flip was about
    // to take away — silently, with no blocked ref and no error.
    readSpec.mockResolvedValue(storedSpec(true));
    runtimeAddress.mockResolvedValue({ hostname: dbIp, platformUrl: null, internalUrl: null });
    const resolved = await resolveEnv(
      "ns",
      { DB: { ref: "db.url:8080" } },
      new Map([["db", { type: "server", ports: ports({ "8080": { protocol: "http" } }), public: false }]]),
    );
    // The private form proves the point: the stored spec says PUBLIC, so a platform URL
    // is what a stored-spec read would have produced. Visibility still comes from the
    // deployment. (The store IS read now, for the target's runtime ADDRESS — an internal
    // IP is a runtime fact that no spec can answer.)
    expect(resolved).toEqual({ ok: true, env: { DB: `http://${dbIp}:8080` } });
  });

  it("still falls back to the stored spec for a target outside this deploy", async () => {
    // A service of another deployment source is not in `knownTargets`, so its
    // stored spec is the only thing that can answer.
    readSpec.mockResolvedValue(storedSpec(false));
    runtimeAddress.mockResolvedValue({ hostname: dbIp, platformUrl: null, internalUrl: null });
    const resolved = await resolveEnv("ns", { DB: { ref: "db.url:8080" } }, new Map());
    expect(resolved).toEqual({ ok: true, env: { DB: `http://${dbIp}:8080` } });
    expect(readSpec).toHaveBeenCalled();
  });

  it("blocks rather than guessing when nothing knows the target", async () => {
    readSpec.mockResolvedValue(null);
    const resolved = await resolveEnv("ns", { DB: { ref: "db.url:8080" } }, new Map());
    expect(resolved).toEqual({ ok: false, blockedRefs: ["db.url:8080"] });
  });

  it("resolves a persistent server hostname to the VM's internal IP", async () => {
    readSpec.mockResolvedValue(storedSpec(false));
    runtimeAddress.mockResolvedValue({ hostname: dbIp, platformUrl: null, internalUrl: null });
    const resolved = await resolveEnv("ns", { HOST: { ref: "db.hostname" } }, new Map());
    expect(resolved).toEqual({ ok: true, env: { HOST: dbIp } });
  });

  // REGRESSION: a private server ref used to resolve to "<service>.internal" no matter
  // what the runtime said. That name is a Fly leftover — GCP publishes no such record —
  // so a Cloud Run service handed it got ENOTFOUND at request time, with a green deploy.
  it("blocks a private server ref while the VM has no address yet", async () => {
    readSpec.mockResolvedValue(storedSpec(false));
    runtimeAddress.mockResolvedValue({ hostname: null, platformUrl: null, internalUrl: null });
    const resolved = await resolveEnv("ns", { HOST: { ref: "db.hostname" }, URL: { ref: "db.url:8080" } }, new Map());
    expect(resolved).toEqual({ ok: false, blockedRefs: ["db.hostname", "db.url:8080"] });
  });

  // REGRESSION: the private and public branches were merged into one `url` variable, so a
  // private address — which already carries the port it is reached on — fell through the
  // standard-ports suffix meant for a public URL that carries no port. Any non-lowest port
  // of a private multi-port server resolved to "http://10.0.0.5:9090:9090".
  it("names a private multi-port server's port exactly once", async () => {
    const twoHttp = ports({ "8080": { protocol: "http" }, "9090": { protocol: "http" } });
    readSpec.mockResolvedValue({
      spec: { config: { type: "server", public: false, min_instances: 0, max_instances: 1, ports: twoHttp }, source: { image: "img" }, env: {} },
      revision: "stored",
    });
    runtimeAddress.mockResolvedValue({ hostname: dbIp, platformUrl: null, internalUrl: null });
    const resolved = await resolveEnv("ns", { A: { ref: "db.url:9090" }, B: { ref: "db.url:8080" } }, new Map());
    // 8080 is the standard-ports holder and 9090 is not; neither may pick up a second port.
    expect(resolved).toEqual({ ok: true, env: { A: `http://${dbIp}:9090`, B: `http://${dbIp}:8080` } });
  });

  it("uses the deployed Cloud Run URI for private serverless references", async () => {
    readSpec.mockResolvedValue(storedSpec(false, "serverless"));
    runtimeAddress.mockResolvedValue({ hostname: "web-abc.a.run.app", platformUrl: null, internalUrl: "https://web-abc.a.run.app" });
    const resolved = await resolveEnv("ns", {
      HOST: { ref: "db.hostname" },
      URL: { ref: "db.url:8080" },
    }, new Map());
    expect(resolved).toEqual({ ok: true, env: { HOST: "web-abc.a.run.app", URL: "https://web-abc.a.run.app" } });
  });
});
