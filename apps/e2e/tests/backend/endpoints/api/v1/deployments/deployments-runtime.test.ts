// The runtime a project's services run on, and how a deploy file selects it.
//
// Fly is the default: a sync that names no `version` runs on it, and every namespace that
// existed before a second runtime did needs nothing to keep doing so. The internal
// `version` export ("gcp-beta-1") opts a project into Google Cloud. The choice is pinned per
// PROJECT once a deployment is attempted, even if it fails or its services are removed.
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
    expect(JSON.stringify(ownSwitch.body)).toContain("deployment history");
    expect(JSON.stringify(ownSwitch.body)).toContain("Create a new project");
    const otherSource = await syncServices(uniqueId("other"), { [uniqueId("api")]: prebuiltService() }, GCP_VERSION);
    expect(otherSource.status).toBe(400);
    expect(JSON.stringify(otherSource.body)).toContain("Create a new project");
    // Still where it was.
    expect(await serviceRuntime(serviceId)).toBe("fly");
  });

  it("keeps the runtime after removing the previously deployed service", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const first = uniqueId("web");
    const sync = await syncServices(sourceId, { [first]: prebuiltService() });
    expect(sync.status).toBe(200);
    expect((await deployService(sourceId, first, sync.body.sync_id)).status).toBe("deployed");

    const second = uniqueId("web");
    // Remove the old service by replacing it with an undeployed definition on Fly.
    expect((await syncServices(sourceId, { [second]: prebuiltService() })).status).toBe(200);
    const moved = await syncServices(sourceId, { [second]: prebuiltService() }, GCP_VERSION);
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("Create a new project");
    expect(await serviceRuntime(second)).toBe("fly");
  });

  it("allows choosing a different runtime before the first deployment", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const serviceId = uniqueId("web");
    expect((await syncServices(sourceId, { [serviceId]: prebuiltService() })).status).toBe(200);
    const sync = await syncServices(sourceId, { [serviceId]: prebuiltService() }, GCP_VERSION);
    expect(sync.status).toBe(200);
    expect((await deployService(sourceId, serviceId, sync.body.sync_id)).status).toBe("deployed");
    // Keeping the selected runtime remains valid after deployment history exists.
    const again = await syncServices(sourceId, { [serviceId]: prebuiltService() }, GCP_VERSION);
    expect(again.status).toBe(200);
    expect((await deployService(sourceId, serviceId, again.body.sync_id)).status).toBe("deployed");
    const switchedBack = await syncServices(sourceId, { [serviceId]: prebuiltService() });
    expect(switchedBack.status).toBe(400);
    expect(JSON.stringify(switchedBack.body)).toContain("Create a new project");
  });

  it("keeps the runtime after a failed deployment attempt", async ({ expect }) => {
    await Project.createAndSwitch();
    const sourceId = uniqueId("src");
    const target = uniqueId("api");
    const serviceId = uniqueId("web");
    const services = {
      [target]: { ...prebuiltService(), public: true },
      [serviceId]: { ...prebuiltService(), env: { API_URL: { type: "connection", value: `${target}.url` } } },
    };
    const sync = await syncServices(sourceId, services);
    expect(sync.status).toBe(200);
    // Deploy only the dependent: its target has no deployed public URL, so apply fails.
    expect((await deployService(sourceId, serviceId, sync.body.sync_id)).status).toBe("failed");
    const switched = await syncServices(sourceId, services, GCP_VERSION);
    expect(switched.status).toBe(400);
    expect(JSON.stringify(switched.body)).toContain("Create a new project");
  });

  it("rejects deploying a conflicting source synced before the first deployment", async ({ expect }) => {
    await Project.createAndSwitch();
    const flySource = uniqueId("fly");
    const flyService = uniqueId("web");
    const gcpSource = uniqueId("gcp");
    const gcpService = uniqueId("api");
    const flySync = await syncServices(flySource, { [flyService]: prebuiltService() });
    const gcpSync = await syncServices(gcpSource, { [gcpService]: prebuiltService() }, GCP_VERSION);
    expect(flySync.status).toBe(200);
    expect(gcpSync.status).toBe(200);
    expect((await deployService(flySource, flyService, flySync.body.sync_id)).status).toBe("deployed");
    const rejected = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: gcpSource, definition_sync_id: gcpSync.body.sync_id, levels: [[gcpService]] },
    });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain("Create a new project");
    expect(await gcpMockHasService(gcpService)).toBe(false);
  });
});


describe("deployment capacity and GCP beta restrictions", () => {
  const sized = (minimum: number) => ({ ...prebuiltService(), memory: "8GB", min_instances: minimum, max_instances: 10 });

  it("reserves memory across sources and replaces a source's previous reservation", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const first = uniqueId("src");
    const second = uniqueId("src");
    const a = uniqueId("web");
    const b = uniqueId("web");
    const c = uniqueId("web");
    expect((await syncServices(first, { [a]: sized(2), [b]: sized(2) })).status).toBe(200);
    // Re-syncing the same 32GB does not count it twice.
    expect((await syncServices(first, { [a]: sized(2), [b]: sized(2) })).status).toBe(200);
    const exceeded = await syncServices(second, { [c]: sized(1) });
    expect(exceeded.status).toBe(400);
    expect(JSON.stringify(exceeded.body)).toContain("40GB");
    // Removing a definition and lowering the remaining minimum frees its reservation.
    expect((await syncServices(first, { [a]: sized(1) })).status).toBe(200);
    expect((await syncServices(second, { [c]: sized(1) })).status).toBe(200);
  });

  it("serializes concurrent sources competing for project capacity", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const responses = await Promise.all([
      syncServices(uniqueId("src"), { [uniqueId("web")]: sized(3) }),
      syncServices(uniqueId("src"), { [uniqueId("web")]: sized(3) }),
    ]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toMatchInlineSnapshot(`[200, 400]`);
  });

  it("counts every minimum instance and counts GCP servers with a zero minimum", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const oversized = await syncServices(uniqueId("src"), { [uniqueId("web")]: sized(10) });
    expect(oversized.status).toBe(400);
    expect(JSON.stringify(oversized.body)).toContain("80GB");
    const servers = Object.fromEntries(Array.from({ length: 5 }, () => [uniqueId("server"), {
      ...sized(0), type: "server", max_instances: 1,
    }]));
    const gcp = await syncServices(uniqueId("src"), servers, GCP_VERSION);
    expect(gcp.status).toBe(400);
    expect(JSON.stringify(gcp.body)).toContain("40GB");
  });

  it("rejects private GCP serverless references, including privatizing another source's target", async ({ expect }) => {
    await Project.createAndSwitch();
    const targetSource = uniqueId("src");
    const consumerSource = uniqueId("src");
    const target = uniqueId("api");
    const consumer = uniqueId("web");
    expect((await syncServices(targetSource, { [target]: prebuiltService() }, GCP_VERSION)).status).toBe(200);
    for (const output of ["hostname", "url"]) {
      const rejected = await syncServices(consumerSource, { [consumer]: {
        ...prebuiltService(), env: { TARGET: { type: "connection", value: `${target}.${output}` } },
      } }, GCP_VERSION);
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.body)).toContain("private GCP serverless");
    }
    expect((await syncServices(targetSource, { [target]: { ...prebuiltService(), public: true } }, GCP_VERSION)).status).toBe(200);
    expect((await syncServices(consumerSource, { [consumer]: {
      ...prebuiltService(), env: { TARGET: { type: "connection", value: `${target}.url` } },
    } }, GCP_VERSION)).status).toBe(200);
    const privatized = await syncServices(targetSource, { [target]: prebuiltService() }, GCP_VERSION);
    expect(privatized.status).toBe(400);
    expect(JSON.stringify(privatized.body)).toContain("private GCP serverless");
  });

  it("requires detaching domains before changing a GCP service type", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const source = uniqueId("src");
    const serviceId = uniqueId("web");
    const definition = { ...prebuiltService(), public: true };
    const synced = await syncServices(source, { [serviceId]: definition }, GCP_VERSION);
    expect(synced.status).toBe(200);
    expect((await deployService(source, serviceId, synced.body.sync_id)).status).toBe("deployed");
    const hostname = `${serviceId}.verified.test`;
    const attached = await niceBackendFetch(`/api/v1/deployments/services/${encodeURIComponent(serviceId)}/domains`, {
      method: "POST", accessType: "admin", body: { hostname },
    });
    expect(attached.status).toBe(201);
    // Same-type edits remain allowed while the domain is attached.
    expect((await syncServices(source, { [serviceId]: definition }, GCP_VERSION)).status).toBe(200);
    const changed = { ...definition, type: "server", min_instances: 0, max_instances: 1 };
    const rejected = await syncServices(source, { [serviceId]: changed }, GCP_VERSION);
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain("Detach all custom domains");
    const detached = await niceBackendFetch(`/api/v1/deployments/services/${encodeURIComponent(serviceId)}/domains/${encodeURIComponent(hostname)}`, {
      method: "DELETE", accessType: "admin",
    });
    expect(detached.status).toBe(200);
    const accepted = await syncServices(source, { [serviceId]: changed }, GCP_VERSION);
    expect(accepted.status).toBe(200);
    expect((await deployService(source, serviceId, accepted.body.sync_id)).status).toBe("deployed");
  });
});
