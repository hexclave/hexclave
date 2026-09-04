import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ArtifactRegistryClient } from "./artifact-registry.js";
import { CloudRunClient } from "./cloud-run.js";
import { ComputeClient } from "./compute.js";
import { GcpClient } from "./client.js";
import { DomainLoadBalancerClient } from "./domains.js";
import { GcpLoggingClient } from "./logging.js";
import { projectIdForNamespace, TenantProjectManager } from "./projects.js";

const LIVE = process.env.HEXCLAVE_MARSHAL_GCP_LIVE_TEST === "1";

function requiredLiveEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required for the live GCP test`);
  return value;
}

async function waitForLog(read: () => Promise<{ text: string }[]>): Promise<void> {
  const startedAt = performance.now();
  for (;;) {
    if ((await read()).length > 0) return;
    if (performance.now() - startedAt > 2 * 60 * 1000) throw new Error("live GCP logs did not arrive within two minutes");
    await delay(2000);
  }
}

describe("live disposable GCP tenant", () => {
  it.skipIf(!LIVE)("provisions, deploys, observes, updates, fronts a domain, logs, and cleans up", async () => {
    const client = new GcpClient();
    const envId = `live-${new Date().toISOString().slice(5, 10).replace("-", "")}`;
    const namespace = `marshal-live-${randomUUID()}`;
    const managerConfig = {
      envId,
      billingAccount: requiredLiveEnv("HEXCLAVE_MARSHAL_GCP_LIVE_BILLING_ACCOUNT"),
      parent: process.env.HEXCLAVE_MARSHAL_GCP_LIVE_PROJECT_PARENT || null,
      projectPrefix: "hxctest",
    };
    const manager = new TenantProjectManager(client, managerConfig);
    const projectId = projectIdForNamespace({ envId, projectPrefix: "hxctest" }, namespace);
    const platformProjectId = requiredLiveEnv("HEXCLAVE_MARSHAL_GCP_LIVE_PLATFORM_PROJECT_ID");
    const runtimeConfig = {
      projectId,
      region: "us-central1",
      zone: "us-central1-a",
      network: "hexclave-runtime",
      subnetwork: "hexclave-runtime",
    };
    const domains = new DomainLoadBalancerClient(client, {
      tenantProjectId: projectId,
      platformProjectId,
      environmentId: envId,
      region: runtimeConfig.region,
    });
    const hostname = `live-${projectId}.example.com`;
    let domainNeedsCleanup = false;
    let liveFailure: { error: unknown } | null = null;

    try {
      const platformProject = await manager.describeExistingProject(platformProjectId);
      expect(platformProject.projectId).toBe(platformProjectId);
      const project = await manager.ensureForNamespace(namespace);
      expect(project.projectId).toBe(projectId);
      const compute = new ComputeClient(client, runtimeConfig);
      const cloudRun = new CloudRunClient(client, runtimeConfig);
      const artifactRegistry = new ArtifactRegistryClient(client, projectId, runtimeConfig.region);
      const logging = new GcpLoggingClient(client, projectId);
      await compute.ensureNetwork();
      await artifactRegistry.ensureRepository();

      const first = await cloudRun.apply({
        name: "live-web",
        image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
        env: { MARSHAL_LIVE_REVISION: "one" },
        port: 8080,
        public: true,
        minInstances: 0,
        maxInstances: 1,
        revision: "live-1",
        startCommand: "echo marshal-live-cloud-run && sed -i 's/listen[[:space:]]*80;/listen 8080;/' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
        serviceKeyHash: "live-web",
      });
      expect(first.ready).toBe(true);
      expect(first.uri).not.toBeNull();
      const response = await fetch(first.uri ?? throwError("live Cloud Run service returned no URI"));
      expect(response.ok).toBe(true);

      const updated = await cloudRun.apply({
        name: "live-web",
        image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
        env: { MARSHAL_LIVE_REVISION: "two" },
        port: 8080,
        public: true,
        minInstances: 0,
        maxInstances: 1,
        revision: "live-2",
        startCommand: "echo marshal-live-cloud-run-updated && sed -i 's/listen[[:space:]]*80;/listen 8080;/' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
        serviceKeyHash: "live-web",
      });
      expect(updated.targetRevision).toBe("live-2");

      // Mark cleanup as necessary before creation because ensure can leave a
      // partially-created backend or certificate stack when a provider call fails.
      domainNeedsCleanup = true;
      const domain = await domains.ensure(hostname, "live-web");
      expect(domain.dnsRecords).toHaveLength(1);
      expect((await domains.get(hostname))?.verified).toBe(false);
      await domains.delete(hostname);
      domainNeedsCleanup = false;
      expect(await domains.get(hostname)).toBeNull();

      const disk = await compute.ensureDisk("live-data", 10);
      expect(disk.sizeGb).toBe(10);
      const server = await compute.applyInstance({
        name: "live-server",
        image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
        env: {},
        ports: [8080],
        revision: "server-1",
        startCommand: "echo marshal-live-server && sed -i 's/listen[[:space:]]*80;/listen 8080;/' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
        volume: { diskName: "live-data", path: "/data" },
        serviceKeyHash: "live-server",
      });
      expect(server.status).toMatch(/RUNNING|STAGING/);
      const updatedServer = await compute.applyInstance({
        name: "live-server",
        image: "docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
        env: { MARSHAL_LIVE_REVISION: "two" },
        ports: [8080],
        revision: "server-2",
        startCommand: "echo marshal-live-server-updated && sed -i 's/listen[[:space:]]*80;/listen 8080;/' /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
        volume: { diskName: "live-data", path: "/data" },
        serviceKeyHash: "live-server",
      });
      expect(updatedServer.revision).toBe("server-2");
      await compute.deleteInstance("live-server");
      expect(await compute.getInstance("live-server")).toBeNull();
      expect((await compute.getDisk("live-data"))?.sizeGb).toBe(10);

      await cloudRun.delete("live-web");
      expect((await cloudRun.get("live-web")).exists).toBe(false);
      await waitForLog(async () => await logging.cloudRunService("live-web"));
      await waitForLog(async () => await logging.computeInstance(server.id));
    } catch (error) {
      // Preserve the lifecycle error if cleanup also fails; a throwing finally
      // block would otherwise replace the provider failure that triggered it.
      liveFailure = { error };
      throw error;
    } finally {
      const cleanupActions = [
        ...(domainNeedsCleanup ? [async () => await domains.delete(hostname)] : []),
        async () => await domains.deleteSharedFrontend(),
        async () => await manager.deleteDisposableProject(projectId),
      ];
      const failures: unknown[] = [];
      for (const action of cleanupActions) {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          liveFailure === null ? failures : [liveFailure.error, ...failures],
          liveFailure === null ? "failed to clean up one or more disposable live-test resources" : "live GCP lifecycle and cleanup both failed",
        );
      }
    }
  }, 30 * 60 * 1000);
});

function throwError(message: string): never {
  throw new Error(message);
}
