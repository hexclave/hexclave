// The runtime a project's services run on, and how a deploy file selects it.
//
// Fly is the default: a sync that names no `version` runs on it, and every namespace that
// existed before a second runtime did needs nothing to keep doing so. The internal
// `version` export ("gcp-beta-1") opts a project into Google Cloud. The choice is pinned per
// PROJECT once a service is provisioned — services share a private network, which cannot
// span providers — and moves again only once every provisioned service is gone.
//
// deployments.test.ts is the default runtime's own suite and deployments-gcp.test.ts the
// GCP one; this file covers only the selection and the pin.
import { createHash, randomUUID } from "node:crypto";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { Project, niceBackendFetch } from "../../../../backend-helpers";

const FLY_MOCK_URL = `http://localhost:${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX || "81"}48`;
const FLY_MOCK_TOKEN = "mock_hexclave_fly_key";
const GCP_MOCK_URL = `http://localhost:${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX || "81"}49`;
const GCP_MOCK_TOKEN = "mock_hexclave_gcp_key";
const GCP_VERSION = "gcp-beta-1";

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// A prebuilt image: nothing to upload or build, so the deploy is the apply alone and the
// runtime it lands on is the whole question.
function prebuiltService(): Record<string, unknown> {
  return { type: "serverless", ports: { 80: { protocol: "http" } }, image: "nginx:1.27", env: {} };
}

async function syncServices(sourceId: string, services: Record<string, unknown>, version?: string) {
  return await niceBackendFetch("/api/v1/deployments/services", {
    method: "PUT",
    accessType: "admin",
    body: { source_id: sourceId, services, ...(version === undefined ? {} : { version }) },
  });
}

async function deployService(sourceId: string, serviceId: string, syncId: string): Promise<Record<string, any>> {
  const started = await niceBackendFetch("/api/v1/deployments/deployments", {
    method: "POST",
    accessType: "admin",
    body: { source_id: sourceId, definition_sync_id: syncId, levels: [[serviceId]] },
  });
  if (started.status !== 200) throw new Error(`Failed to start deploy: ${JSON.stringify(started.body)}`);
  const deploymentId = (started.body as any).id;
  // The applies advance on READ (Marshal has no background worker), so poll until it settles.
  const deadline = Date.now() + 60_000;
  let last: Record<string, any> = started.body as any;
  while (Date.now() < deadline) {
    const response = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}`, { accessType: "admin" });
    last = response.body as any;
    if (last.status === "deployed" || last.status === "failed" || last.status === "canceled") return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`deployment ${deploymentId} did not settle: ${JSON.stringify(last)}`);
}

async function serviceRuntime(serviceId: string): Promise<string> {
  const response = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
  if (response.status !== 200) throw new Error(`Failed to read service: ${JSON.stringify(response.body)}`);
  return (response.body as any).runtime;
}

async function flyMockHasService(serviceId: string): Promise<boolean> {
  const response = await fetch(`${FLY_MOCK_URL}/__mock/apps`, { headers: { authorization: `Bearer ${FLY_MOCK_TOKEN}` } });
  if (!response.ok) throw new Error(`fly-mock listing failed: ${response.status}`);
  const { apps } = await response.json() as { apps: { machines: { metadata: Record<string, string> }[] }[] };
  return apps.some((app) => app.machines.some((machine) => machine.metadata.hexclave_key === serviceId));
}

async function gcpMockHasService(serviceId: string): Promise<boolean> {
  const response = await fetch(`${GCP_MOCK_URL}/__mock/projects`, { headers: { authorization: `Bearer ${GCP_MOCK_TOKEN}` } });
  if (!response.ok) throw new Error(`gcp-mock listing failed: ${response.status}`);
  const { projects } = await response.json() as { projects: { cloudRunServices: { labels: Record<string, string> }[] }[] };
  // The mock labels every Cloud Run service with the hash Marshal derives from the service key.
  const hash = serviceKeyHash(serviceId);
  return projects.some((project) => project.cloudRunServices.some((service) => service.labels["hexclave-service-key"] === hash));
}

function serviceKeyHash(serviceId: string): string {
  return createHash("sha256").update(serviceId).digest("hex").slice(0, 24);
}

describe("deploy file version and runtime selection", () => {
  it("runs on the default runtime when no version is named", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const serviceId = uniqueId("web");
    const sync = await syncServices(sourceId, { [serviceId]: prebuiltService() });
    expect(sync.status).toBe(200);
    expect(await serviceRuntime(serviceId)).toBe("fly");
    const deployment = await deployService(sourceId, serviceId, (sync.body as any).sync_id);
    expect(deployment.status).toBe("deployed");
    expect(await flyMockHasService(serviceId)).toBe(true);
    expect(await gcpMockHasService(serviceId)).toBe(false);
  });

  it("refuses an unknown version rather than ignoring it", async ({ expect }) => {
    await Project.createAndSwitch();
    // Both the shape a stray user export would have and a near-miss of our own token.
    for (const version of ["1.0.0", "gcp"]) {
      const sync = await syncServices(uniqueId("src"), { [uniqueId("web")]: prebuiltService() }, version);
      expect(sync.status).toBe(400);
      expect(JSON.stringify(sync.body)).toMatch(/Unknown deploy file version/);
      expect(JSON.stringify(sync.body)).toContain(GCP_VERSION);
    }
  });

  it("opts a project into GCP with the internal version token", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const serviceId = uniqueId("web");
    const sync = await syncServices(sourceId, { [serviceId]: prebuiltService() }, GCP_VERSION);
    expect(sync.status).toBe(200);
    expect(await serviceRuntime(serviceId)).toBe("gcp");
    const deployment = await deployService(sourceId, serviceId, (sync.body as any).sync_id);
    expect(deployment.status).toBe("deployed");
    expect(await gcpMockHasService(serviceId)).toBe(true);
    expect(await flyMockHasService(serviceId)).toBe(false);
  });

  it("pins the project once a service is provisioned, and every deploy file must agree", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const serviceId = uniqueId("web");
    const sync = await syncServices(sourceId, { [serviceId]: prebuiltService() });
    expect(sync.status).toBe(200);
    expect((await deployService(sourceId, serviceId, (sync.body as any).sync_id)).status).toBe("deployed");

    // The same deploy file changing its mind, and a second deploy file of the same project.
    const ownSwitch = await syncServices(sourceId, { [serviceId]: prebuiltService() }, GCP_VERSION);
    expect(ownSwitch.status).toBe(400);
    expect(JSON.stringify(ownSwitch.body)).toMatch(/run on the \\"fly\\" runtime/);
    expect(JSON.stringify(ownSwitch.body)).toContain(serviceId);
    const otherSource = await syncServices(uniqueId("other"), { [uniqueId("api")]: prebuiltService() }, GCP_VERSION);
    expect(otherSource.status).toBe(400);
    expect(JSON.stringify(otherSource.body)).toContain(sourceId);
    // Still where it was.
    expect(await serviceRuntime(serviceId)).toBe("fly");
  });

  it("lets a project change runtime once every provisioned service is gone", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const first = uniqueId("web");
    const sync = await syncServices(sourceId, { [first]: prebuiltService() });
    expect(sync.status).toBe(200);
    expect((await deployService(sourceId, first, (sync.body as any).sync_id)).status).toBe("deployed");

    // A sync that no longer declares the service tears it down; the replacement has never
    // been provisioned, so nothing pins the project any more.
    const second = uniqueId("web");
    const moved = await syncServices(sourceId, { [second]: prebuiltService() }, GCP_VERSION);
    expect(moved.status).toBe(200);
    expect(await serviceRuntime(second)).toBe("gcp");
    const deployment = await deployService(sourceId, second, (moved.body as any).sync_id);
    expect(deployment.status).toBe("deployed");
    expect(await gcpMockHasService(second)).toBe(true);
  });
});
