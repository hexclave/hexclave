import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRunClient } from "./cloud-run.js";
import { GcpClient } from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloud Run reconciliation", () => {
  it("creates a private scale-to-zero service with Direct VPC egress", async () => {
    const client = new GcpClient();
    const request = vi.spyOn(client, "request")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "operations/create" })
      .mockResolvedValueOnce({ name: "operations/create", done: true })
      .mockResolvedValueOnce({
        uri: "https://service-example.run.app",
        labels: { "hexclave-revision": "rev-1" },
        scaling: { minInstanceCount: 0 },
        latestReadyRevision: "service-00001",
        terminalCondition: { state: "CONDITION_SUCCEEDED" },
      })
      .mockResolvedValueOnce({ status: { imageDigest: `sha256:${"a".repeat(64)}` } });
    const cloudRun = new CloudRunClient(client, {
      projectId: "tenant-project",
      region: "us-central1",
      network: "hexclave-runtime",
      subnetwork: "hexclave-runtime",
    });

    const observation = await cloudRun.apply({
      name: "service",
      image: "docker.io/library/nginx:latest",
      env: { PORT: "9999", MESSAGE: "hello" },
      port: 8080,
      public: false,
      minInstances: 0,
      maxInstances: 3,
      revision: "rev-1",
      startCommand: null,
      serviceKeyHash: "service-key",
    });

    expect(observation.ready).toBe(true);
    expect(observation.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
    const createCall = request.mock.calls.find(([url]) => url.includes("?serviceId=service"));
    expect(createCall?.[1]?.body).not.toHaveProperty("name");
    expect(createCall?.[1]?.body).toMatchObject({
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      invokerIamDisabled: true,
      scaling: { minInstanceCount: 0, maxInstanceCount: 3 },
      template: {
        vpcAccess: {
          networkInterfaces: [{ network: "hexclave-runtime", subnetwork: "hexclave-runtime" }],
          egress: "PRIVATE_RANGES_ONLY",
        },
        containers: [{ env: [{ name: "MESSAGE", value: "hello" }], ports: [{ name: "http1", containerPort: 8080 }] }],
      },
    });
  });

  it("includes the resource name when patching an existing service", async () => {
    const client = new GcpClient();
    const existingService = {
      uri: "https://service-example.run.app",
      labels: { "hexclave-revision": "rev-1" },
      scaling: { minInstanceCount: 1 },
      latestReadyRevision: "service-00001",
      terminalCondition: { state: "CONDITION_SUCCEEDED" },
    };
    const readyService = {
      uri: "https://service-example.run.app",
      labels: { "hexclave-revision": "rev-2" },
      scaling: { minInstanceCount: 1 },
      latestReadyRevision: "service-00002",
      terminalCondition: { state: "CONDITION_SUCCEEDED" },
    };
    const request = vi.spyOn(client, "request")
      .mockResolvedValueOnce(existingService)
      .mockResolvedValueOnce({ name: "operations/update" })
      .mockResolvedValueOnce({ name: "operations/update", done: true })
      .mockResolvedValueOnce(existingService)
      .mockResolvedValueOnce(readyService)
      .mockResolvedValueOnce({ status: { imageDigest: `sha256:${"b".repeat(64)}` } });
    const cloudRun = new CloudRunClient(client, {
      projectId: "tenant-project",
      region: "us-central1",
      network: "hexclave-runtime",
      subnetwork: "hexclave-runtime",
    });

    await cloudRun.apply({
      name: "service",
      image: "docker.io/library/nginx:latest",
      env: {},
      port: 8080,
      public: true,
      minInstances: 1,
      maxInstances: 2,
      revision: "rev-2",
      startCommand: null,
      serviceKeyHash: "service-key",
    });

    const patchCall = request.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(patchCall?.[1]?.body).toMatchObject({
      name: "projects/tenant-project/locations/us-central1/services/service",
    });
    // No updateMask, ever: real Cloud Run reads `updateMask=*` as an empty field list and
    // silently no-ops the whole update (200, done operation, unchanged resource), which
    // strands the revision waiter until it times out. The mock reproduces this, but only an
    // end-to-end run would notice — so pin the URL here, where the mask would be re-added.
    expect(patchCall?.[0]).toBe("https://run.googleapis.com/v2/projects/tenant-project/locations/us-central1/services/service");
  });
});
