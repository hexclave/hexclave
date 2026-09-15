import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactRegistryClient } from "./artifact-registry.js";
import { CloudRunClient } from "./cloud-run.js";
import { ComputeClient } from "./compute.js";
import { GcpClient } from "./client.js";
import { DomainLoadBalancerClient } from "./domains.js";
import { GcpLoggingClient } from "./logging.js";
import { TenantProjectManager } from "./projects.js";

const MOCK_TOKEN = "mock_hexclave_gcp_key";
let mockProcess: ChildProcess | null = null;
let mockUrl = "";

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate a TCP port for gcp-mock");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function waitForMock(url: string, process: ChildProcess, output: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`gcp-mock exited with ${process.exitCode}: ${output()}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`gcp-mock did not become ready: ${output()}`);
}

beforeAll(async () => {
  const port = await unusedPort();
  mockUrl = `http://127.0.0.1:${port}`;
  const serverPath = fileURLToPath(new URL("../../../../docker/dependencies/gcp-mock/server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HEXCLAVE_GCP_MOCK_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mockProcess = child;
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  await waitForMock(mockUrl, child, () => output);
});

afterAll(async () => {
  const process = mockProcess;
  if (process === null || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await new Promise<void>((resolve) => process.once("exit", () => resolve()));
});

describe("gcp-mock contract", () => {
  it("runs the same lifecycle as the disposable live-GCP test", async () => {
    const client = new GcpClient({ url: mockUrl, token: MOCK_TOKEN });
    const manager = new TenantProjectManager(client, {
      envId: "mock",
      billingAccount: "mock-billing-account",
      parent: "organizations/mock-organization",
      projectPrefix: "hxctest",
    });
    const namespace = "contract-tenant";
    const project = await manager.ensureForNamespace(namespace);
    const runtimeConfig = {
      projectId: project.projectId,
      region: "us-central1",
      zone: "us-central1-a",
      network: "hexclave-runtime",
      subnetwork: "hexclave-runtime",
    };
    const compute = new ComputeClient(client, runtimeConfig);
    const cloudRun = new CloudRunClient(client, runtimeConfig);
    const domains = new DomainLoadBalancerClient(client, {
      tenantProjectId: project.projectId,
      platformProjectId: "mock-platform",
      environmentId: "mock",
      region: runtimeConfig.region,
    });
    const logging = new GcpLoggingClient(client, project.projectId);

    try {
      await compute.ensureNetwork();
      await new ArtifactRegistryClient(client, project.projectId, runtimeConfig.region).ensureRepository();
      const first = await cloudRun.apply({
        name: "contract-web",
        image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
        env: { REVISION: "one" },
        port: 8080,
        public: true,
        minInstances: 0,
        maxInstances: 2,
        revision: "revision-1",
        startCommand: null,
        serviceKeyHash: "contract-web",
        memoryMb: 512,
        cpu: 1,
      });
      expect(first).toMatchObject({ exists: true, ready: true, targetRevision: "revision-1", runningInstances: 0 });
      expect(first.uri).toMatch(/^https:\/\/contract-web-.+\.run\.app$/);

      const updated = await cloudRun.apply({
        name: "contract-web",
        image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
        env: { REVISION: "two" },
        port: 8080,
        public: false,
        minInstances: 1,
        maxInstances: 3,
        revision: "revision-2",
        startCommand: "nginx -g 'daemon off;'",
        serviceKeyHash: "contract-web",
        memoryMb: 512,
        cpu: 1,
      });
      expect(updated.targetRevision).toBe("revision-2");

      const disk = await compute.ensureDisk("contract-data", 10);
      expect(disk.sizeGb).toBe(10);
      expect((await compute.ensureDisk("contract-data", 12)).sizeGb).toBe(12);
      const instance = await compute.applyInstance({
        name: "contract-server",
        image: "registry.example.test:5000/team/server:latest",
        env: { MODE: "contract" },
        ports: [8080],
        revision: "server-1",
        startCommand: null,
        volume: { diskName: "contract-data", path: "/data" },
        serviceKeyHash: "contract-server",
        machineType: "e2-micro",
      });
      expect(instance.imageRef).toMatch(/^registry\.example\.test:5000\/team\/server@sha256:[0-9a-f]{64}$/);

      const domain = await domains.ensure("contract.example.test", "contract-web");
      expect(domain.verified).toBe(false);
      expect(domain.dnsRecords).toHaveLength(1);
      const verifiedDomain = await domains.ensure("contract.verified.test", "contract-web");
      expect(verifiedDomain.verified).toBe(true);
      const introspectionResponse = await fetch(`${mockUrl}/__mock/projects`, { headers: { authorization: `Bearer ${MOCK_TOKEN}` } });
      expect(introspectionResponse.ok).toBe(true);
      const introspection = await introspectionResponse.json();
      expect(introspection).toMatchObject({
        projects: expect.arrayContaining([
          expect.objectContaining({
            projectId: "mock-platform",
            certificates: expect.arrayContaining([expect.objectContaining({ managed: expect.objectContaining({ domains: ["contract.example.test"] }) })]),
            certificateMaps: [expect.anything()],
            computeResources: expect.arrayContaining([
              expect.objectContaining({ path: expect.stringContaining("/global/addresses/") }),
              expect.objectContaining({ path: expect.stringContaining("/global/forwardingRules/") }),
              expect.objectContaining({ path: expect.stringContaining("/global/urlMaps/") }),
            ]),
          }),
          expect.objectContaining({
            projectId: project.projectId,
            computeResources: expect.arrayContaining([
              expect.objectContaining({ path: expect.stringContaining("/global/backendServices/") }),
              expect.objectContaining({ path: expect.stringContaining("/networkEndpointGroups/") }),
            ]),
          }),
        ]),
      });
      await domains.delete("contract.example.test");
      expect(await domains.get("contract.example.test")).toBeNull();
      expect(await domains.get("contract.verified.test")).not.toBeNull();
      await domains.delete("contract.verified.test");
      await domains.deleteSharedFrontend();

      expect((await logging.cloudRunService("contract-web")).some((line) => line.text.includes("revision"))).toBe(true);
      expect((await logging.computeInstance(instance.id)).some((line) => line.instance === instance.id)).toBe(true);

      await compute.deleteInstance("contract-server");
      expect(await compute.getInstance("contract-server")).toBeNull();
      expect((await compute.getDisk("contract-data"))?.sizeGb).toBe(12);
      await cloudRun.delete("contract-web");
      expect((await cloudRun.get("contract-web")).exists).toBe(false);
    } finally {
      await manager.deleteDisposableProject(project.projectId);
    }
  }, 30_000);
});
