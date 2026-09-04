import { createTar } from "@hexclave/shared/dist/utils/tar";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { InternalApiKey, Project, backendContext, niceBackendFetch } from "../../../../backend-helpers";

// These tests run against the local Marshal dev server (apps/marshal), which
// itself talks to the gcp-mock docker service (docker/dependencies/gcp-mock), the runtime a
// project opts into with the internal `version` export (deployments.test.ts covers the default)
// and the s3mock bucket — the backend's .env.development points at Marshal via
// the mock HEXCLAVE_MARSHAL_API_KEY, and Marshal's .env.development enables
// the mock builder (instant fake digests). CI never talks to real GCP.
// Secret values are KMS-encrypted server-side via the localstack container.
const GCP_MOCK_URL = `http://localhost:${process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX || "81"}49`;
// Same well-known dev token Marshal uses in apps/marshal/.env.development.
// The mock's /__mock namespace requires it because its listing exposes resolved secrets.
const GCP_MOCK_TOKEN = "mock_hexclave_gcp_key";

// Service ids are randomized per test because the gcp-mock accumulates projects
// for its whole container lifetime: label-based lookups below
// must not collide with earlier runs or concurrently-running tests.
function uniqueServiceId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function makeSourceTarball(files: Record<string, string> = { "Dockerfile": "FROM nginx:alpine\n", "index.html": "<h1>hello</h1>" }): Uint8Array {
  return gzipSync(createTar(Object.entries(files).map(([path, content]) => ({
    path,
    data: new TextEncoder().encode(content),
  }))));
}

async function createUpload(files?: Record<string, string>): Promise<{ uploadId: string }> {
  const uploadResponse = await niceBackendFetch("/api/v1/deployments/uploads", {
    method: "POST",
    accessType: "admin",
  });
  if (uploadResponse.status !== 201) throw new Error(`Failed to create upload: ${JSON.stringify(uploadResponse.body)}`);
  const uploadUrl = (uploadResponse.body as any).upload_url;
  const contentType = (uploadResponse.body as any).content_type;
  if (typeof uploadUrl !== "string" || typeof contentType !== "string") {
    throw new Error(`Upload response is missing the upload URL or content type: ${JSON.stringify(uploadResponse.body)}`);
  }
  const source = makeSourceTarball(files);
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "content-length": source.length.toString(),
    },
    body: new Uint8Array(source).slice().buffer,
  });
  if (!putResponse.ok) throw new Error(`Failed to upload tarball: ${putResponse.status} ${await putResponse.text()}`);
  return { uploadId: (uploadResponse.body as any).id };
}

type RuntimeLogLine = { at_millis: number, stream: string, instance: string | null, text: string };

/**
 * Reads one page of a service's runtime logs.
 *
 * `follow=false` matters: the endpoint's whole point is that a runtime log never
 * ends, so the default follows for minutes and a test that read the body would
 * block for all of them.
 */
async function readRuntimeLogs(serviceId: string, options?: { sinceMillis?: number }): Promise<{ status: number, contentType: string | null, lines: RuntimeLogLine[] }> {
  const params = new URLSearchParams({ follow: "false" });
  if (options?.sinceMillis !== undefined) params.set("since_millis", String(options.sinceMillis));
  const response = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/logs?${params.toString()}`, { accessType: "admin" });
  // Only a 200 is NDJSON; an error status carries an ordinary JSON error body,
  // which would blow up the per-line parse below.
  //
  // The body arrives as an ArrayBuffer, not a string: the test helper decodes
  // `application/json` and `text/*` and hands everything else back raw, and
  // `application/x-ndjson` is neither.
  const text = response.status !== 200
    ? ""
    : typeof response.body === "string"
      ? response.body
      : new TextDecoder().decode(response.body as ArrayBuffer);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    lines: text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as RuntimeLogLine),
  };
}

// Syncs service definitions the way `hexclave deploy` does (its first step
// after evaluating the deploy file's `services`). Scoped to a DEPLOYMENT SOURCE:
// one deploy file, whose services this sync is the whole truth about.
// Every sync in this file opts the project into the GCP runtime with the internal `version`
// token a deploy file would export — this suite is the GCP half of the deployments contract;
// deployments.test.ts is the default (Fly) half.
const GCP_VERSION = "gcp-beta-1";

async function syncServices(services: Record<string, unknown>, sourceId: string = uniqueServiceId("src")): Promise<{ syncId: string, sourceId: string, removedServiceIds: string[] }> {
  const response = await niceBackendFetch("/api/v1/deployments/services", {
    method: "PUT",
    accessType: "admin",
    body: { source_id: sourceId, services, version: GCP_VERSION },
  });
  if (response.status !== 200) throw new Error(`Failed to sync services: ${JSON.stringify(response.body)}`);
  const syncId = (response.body as any).sync_id;
  if (typeof syncId !== "string") throw new Error(`Sync response is missing sync_id: ${JSON.stringify(response.body)}`);
  return { syncId, sourceId, removedServiceIds: (response.body as any).removed_service_ids ?? [] };
}

async function syncServiceAndUpload(serviceId: string, definition: Record<string, unknown> = {}, files?: Record<string, string>, existingSourceId?: string): Promise<{ uploadId: string, definitionSyncId: string, sourceId: string }> {
  // Pass existingSourceId to re-sync a service this test already synced: service ids are
  // unique per PROJECT, so a second source claiming one is refused by design.
  const { syncId, sourceId } = await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {}, ...definition } }, existingSourceId);
  return { ...await createUpload(files), definitionSyncId: syncId, sourceId };
}

// Deploys a whole deployment source: one upload, one build of every service it
// declares, then the applies in the given dependency order.
async function startDeploy(options: {
  sourceId: string,
  // Omitted when every service in the deploy names an already-built image:
  // nothing is built, so there is no source archive and the backend refuses one.
  uploadId?: string,
  definitionSyncId: string,
  levels: string[][],
  extraBody?: Record<string, unknown>,
  accessType?: "admin" | "server",
}): Promise<string> {
  const response = await niceBackendFetch("/api/v1/deployments/deployments", {
    method: "POST",
    accessType: options.accessType ?? "admin",
    body: {
      source_id: options.sourceId,
      ...(options.uploadId === undefined ? {} : { upload_id: options.uploadId }),
      definition_sync_id: options.definitionSyncId,
      levels: options.levels,
      ...options.extraBody,
    },
  });
  if (response.status !== 200) throw new Error(`Failed to start deploy: ${JSON.stringify(response.body)}`);
  return (response.body as any).id;
}

/** Sync + upload + deploy one service, which is what most tests here need. */
async function deployOneService(serviceId: string, definition: Record<string, unknown> = {}, files?: Record<string, string>): Promise<string> {
  const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId, definition, files);
  return await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]] });
}

// The mock builder completes asynchronously and the applies advance on READ (Marshal has no
// background worker), so poll the deployment until it settles. The wall-clock budget matches
// the declared test timeout so a slow CI runner doesn't fail early with 100s of the timeout
// unused; the give-up error includes the last observed body for debuggability.
async function pollDeploymentToStatus(deploymentId: string, wantedStatus: "deployed" | "failed"): Promise<Record<string, any>> {
  let last: any = null;
  for (let attempt = 0; attempt < 240; attempt++) {
    const poll = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}`, { accessType: "admin" });
    last = poll;
    const body = poll.body as any;
    if (body?.status === wantedStatus) return body;
    if (body?.status === "deployed" || body?.status === "failed" || body?.status === "canceled") {
      throw new Error(`Deployment reached ${body.status} instead of ${wantedStatus}: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Deployment ${deploymentId} did not become ${wantedStatus} in time; last poll: ${last?.status} ${JSON.stringify(last?.body)}`);
}

/** One service's outcome within a deployment. */
function serviceOutcome(deployment: Record<string, any>, serviceId: string): Record<string, any> {
  const outcome = (deployment.services as any[]).find((service) => service.service_id === serviceId);
  if (outcome === undefined) throw new Error(`Deployment has no outcome for ${serviceId}: ${JSON.stringify(deployment)}`);
  return outcome;
}

type MockCloudRunService = {
  name: string,
  labels: Record<string, string>,
  ingress: string,
  invokerIamDisabled: boolean,
  uri: string,
  scaling: { minInstanceCount: number, maxInstanceCount: number },
  template: { containers: { image: string, env: { name: string, value: string }[], command?: string[], args?: string[], ports?: { containerPort: number }[] }[] },
};

type MockInstance = {
  id: string,
  name: string,
  status: string,
  labels: Record<string, string>,
  metadata: { items: { key: string, value: string }[] },
  disks: { boot: boolean, source: string, deviceName: string, autoDelete: boolean }[],
  networkInterfaces: { networkIP: string }[],
};

type MockDisk = { id: string, name: string, sizeGb: string };
type MockProject = {
  projectId: string,
  cloudRunServices: MockCloudRunService[],
  instances: MockInstance[],
  disks: MockDisk[],
  computeResources: { path: string, resource: Record<string, unknown> }[],
};

function serviceKeyHash(serviceId: string): string {
  return createHash("sha256").update(serviceId).digest("hex").slice(0, 24);
}

async function mockProjects(): Promise<MockProject[]> {
  const response = await fetch(`${GCP_MOCK_URL}/__mock/projects`, {
    headers: { authorization: `Bearer ${GCP_MOCK_TOKEN}` },
  });
  if (!response.ok) throw new Error(`gcp-mock project listing failed: ${response.status} ${await response.text()}`);
  return (await response.json() as { projects: MockProject[] }).projects;
}

async function findMockCloudRun(serviceId: string): Promise<{ project: MockProject, service: MockCloudRunService }> {
  const hash = serviceKeyHash(serviceId);
  for (let attempt = 0; attempt < 60; attempt++) {
    // The /__mock namespace is authenticated: its listing includes each container's
    // resolved env, which holds decrypted project secrets.
    for (const project of await mockProjects()) {
      const service = project.cloudRunServices.find((candidate) => candidate.labels["hexclave-service-key"] === hash);
      if (service !== undefined) return { project, service };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gcp-mock Cloud Run service for ${serviceId} never appeared`);
}

async function findMockInstance(serviceId: string): Promise<{ project: MockProject, instance: MockInstance }> {
  const hash = serviceKeyHash(serviceId);
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const project of await mockProjects()) {
      const instance = project.instances.find((candidate) => candidate.labels["hexclave-service-key"] === hash);
      if (instance !== undefined) return { project, instance };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gcp-mock Compute Engine instance for ${serviceId} never appeared`);
}

function cloudRunEnv(service: MockCloudRunService): Record<string, string> {
  return Object.fromEntries(service.template.containers[0].env.map(({ name, value }) => [name, value]));
}

function startupScript(instance: MockInstance): string {
  const script = instance.metadata.items.find((item) => item.key === "startup-script")?.value;
  if (script === undefined) throw new Error(`Mock instance ${instance.name} has no startup script`);
  return script;
}

describe("access control", () => {
  it("rejects client access to deployment endpoints", async ({ expect }) => {
    await Project.createAndSwitch();
    const response = await niceBackendFetch("/api/v1/deployments/services", { accessType: "client" });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "client",
            "allowed_access_types": [
              "server",
              "admin",
            ],
          },
          "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);
    const secretsResponse = await niceBackendFetch("/api/v1/project-secrets", { accessType: "client" });
    expect(secretsResponse.status).toBe(401);
  });

  it("accepts secret-server-key access for the whole CI deploy sequence", async ({ expect }) => {
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    // Every route the CLI hits in a server-key-only environment (CI) must
    // accept server access, not just admin: list, sync, secrets pre-flight,
    // and upload creation. (The deploy POST itself is covered with
    // accessType: "server" in the end-to-end test below.)
    const listResponse = await niceBackendFetch("/api/v1/deployments/services", { accessType: "server" });
    expect(listResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "items": [] },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const syncResponse = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "server",
      body: { version: GCP_VERSION, source_id: "ci-src", services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } } },
    });
    expect(syncResponse.status).toBe(200);
    const secretsResponse = await niceBackendFetch("/api/v1/project-secrets", { accessType: "server" });
    expect(secretsResponse.status).toBe(200);
    const uploadResponse = await niceBackendFetch("/api/v1/deployments/uploads", { method: "POST", accessType: "server" });
    expect(uploadResponse.status).toBe(201);
  });
});

describe("compute sizing", () => {
  it("reports the size a service runs at, and the CPU that comes with it", async ({ expect }) => {
    await Project.createAndSwitch();
    await syncServices({
      sized: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
    }, "sizing-src");

    const response = await niceBackendFetch("/api/v1/deployments/services/sized", { accessType: "admin" });
    expect(response.status).toBe(200);
    // Resolved, never null: a service that declares no size is running its
    // type's default, not running nothing — and the reader should not have to
    // know which default belongs to which type.
    expect(response.body).toMatchObject({
      memory: "512MB",
      cpu: { count: 1, shared: false },
    });
  });

  it("refuses sizes the plan does not entitle, and everything else it cannot run", async ({ expect }) => {
    await Project.createAndSwitch();
    // Same switch every other plan limit respects; on a dev machine with limits
    // disabled the gate must fail OPEN rather than half-apply.
    const planUsage = await niceBackendFetch("/api/v1/internal/plan-usage", { accessType: "admin" });
    const enforced = (planUsage.body as any)?.are_plan_limits_enforced !== false;

    const sync = async (body: Record<string, unknown>) => await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "sizing-gate-src", ...body },
    });

    // A size off the ladder is a schema error on every plan: it names a machine
    // shape the runtime does not have.
    const offLadder = await sync({ services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, memory: "3GB", env: {} } } });
    expect(offLadder.status).toBe(400);
    const builderOffLadder = await sync({
      services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } },
      builder: { memory: "512MB" },
    });
    expect(builderOffLadder.status).toBe(400);

    // The default rung always syncs, whatever the plan.
    expect((await sync({
      services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, memory: "512MB", env: {} } },
      builder: { memory: "8GB" },
    })).status).toBe(200);

    const oversized = await sync({
      services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, memory: "4GB", env: {} } },
    });
    const biggerBuilder = await sync({
      services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } },
      builder: { memory: "32GB" },
    });
    if (!enforced) {
      expect([oversized.status, biggerBuilder.status]).toEqual([200, 200]);
      return;
    }
    expect(oversized.status).toBe(400);
    expect(JSON.stringify(oversized.body)).toContain("Free plan");
    expect(biggerBuilder.status).toBe(400);
    expect(JSON.stringify(biggerBuilder.body)).toContain("Free plan");
  });
});

describe("definition sync", () => {
  it("syncs, lists, and reads container service definitions", async ({ expect }) => {
    await Project.createAndSwitch();

    await syncServices({
      api: {
        type: "serverless",
        ports: { 8080: { protocol: "http" } },
        // min_instances stays 0: this project's billing team is on the Free
        // plan, where always-on instances are rejected by the sync route.
        min_instances: 0,
        max_instances: 3,
        root_directory: "api",
        env: {
          MY_ENV_VAR: { value: "true" },
          DATABASE_CONNECTION_STRING: { type: "secret", key: "db_connection" },
          NEXT_PUBLIC_HEXCLAVE_PROJECT_ID: { type: "connection", value: "hexclave.projectId" },
        },
      },
    });

    const getResponse = await niceBackendFetch("/api/v1/deployments/services/api", { accessType: "admin" });
    expect(getResponse.status).toBe(200);
    const body = getResponse.body as any;
    expect(body).toMatchObject({
      id: "api",
      type: "serverless",
      // Defaults filled in: a bare `{}` is an HTTP port, and a service is private.
      public: false,
      ports: { 8080: { protocol: "http" } },
      min_instances: 0,
      max_instances: 3,
      root_directory: "api",
      provisioned: false,
      status: "not_deployed",
      has_successful_deploy: false,
      url: null,
      domains: [],
      latest_deployment_id: null,
    });
    expect(body.env).toEqual([
      { key: "DATABASE_CONNECTION_STRING", type: "secret", value: null, secret_key: "db_connection" },
      { key: "MY_ENV_VAR", type: "plain", value: "true", secret_key: null },
      { key: "NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", type: "connection", value: "hexclave.projectId", secret_key: null },
    ]);

    const listResponse = await niceBackendFetch("/api/v1/deployments/services", { accessType: "admin" });
    expect((listResponse.body as any).items.map((item: any) => item.id)).toEqual(["api"]);
  });

  it("stores a mixed port list and rejects the ones it could not serve", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();

    await syncServices({
      database: { type: "serverless", ports: { 5432: { protocol: "tcp" } }, env: {} },
      // Several PRIVATE ports of mixed protocols, on the only type that may declare
      // TCP ports at all.
      gateway: {
        type: "server",
        min_instances: 0,
        ports: { 3000: { protocol: "http" }, 9090: { protocol: "http" }, 5433: { protocol: "tcp" } },
        env: {},
      },
    });
    const database = await niceBackendFetch("/api/v1/deployments/services/database", { accessType: "admin" });
    expect(database.status).toBe(200);
    expect(database.body).toMatchObject({ public: false, ports: { 5432: { protocol: "tcp" } } });
    const gateway = await niceBackendFetch("/api/v1/deployments/services/gateway", { accessType: "admin" });
    expect((gateway.body as any).ports).toEqual({
      3000: { protocol: "http" },
      9090: { protocol: "http" },
      5433: { protocol: "tcp" },
    });

    const rejects = async (service: Record<string, unknown>, expectedMessage: string) => {
      const response = await niceBackendFetch("/api/v1/deployments/services", {
        method: "PUT",
        accessType: "admin",
        body: { version: GCP_VERSION, source_id: "ports-test", services: { svc: { type: "serverless", env: {}, ...service } } },
      });
      expect(response.status, JSON.stringify(service)).toBe(400);
      expect(JSON.stringify(response.body)).toContain(expectedMessage);
    };
    // Raw TCP carries no SNI or Host header, so a shared public address cannot
    // tell which service a connection is for.
    await rejects({ public: true, ports: { 5432: { protocol: "tcp" } } }, "raw TCP carries no SNI or Host header");
    // Public ingress with nothing behind it to serve.
    await rejects({ public: true, ports: {} }, "must declare at least one port");
    // The old ARRAY shape is refused by the schema itself. A duplicate port needs no rule of
    // its own any more: two entries for one port are impossible in a record keyed by it.
    await rejects({ ports: [{ port: 3000 }, { port: 9090 }] }, "must be a `object` type");
  });

  it("accepts a public service with several ports, and reports which owns 80/443", async ({ expect }) => {
    await Project.createAndSwitch();
    const response = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: {
        version: GCP_VERSION,
        source_id: "multi-public",
        services: { web: { type: "serverless", public: true, ports: { 8443: { protocol: "http" }, 3000: { protocol: "http" } }, env: {} } },
      },
    });
    expect(response.status).toBe(200);
    const service = await niceBackendFetch("/api/v1/deployments/services/web", { accessType: "admin" });
    expect(service.status).toBe(200);
    // Visibility is the SERVICE's, and the ports carry only their protocol.
    expect((service.body as any).public).toBe(true);
    expect((service.body as any).ports).toEqual({ 3000: { protocol: "http" }, 8443: { protocol: "http" } });
  });

  it("lets a public service hold a custom domain on the port that owns 80/443", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("multi-domain");
    await syncServices({ [serviceId]: { type: "serverless", public: true, ports: { 8443: { protocol: "http" }, 3000: { protocol: "http" } }, env: {} } });
    const added = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname: `${serviceId}.verified.test` },
    });
    // A public service is already reachable, so a domain publishes nothing new.
    // This is the case the PRIVATE multi-port rule refuses — see the domains
    // suite — and it is accepted here precisely because nothing becomes newly
    // reachable. (Which port it fronts is stored, not exposed by the API; that
    // the holder is the lowest port is covered by domainPortForService's tests.)
    expect(added.status).toBe(201);
    expect((added.body as any).hostname).toBe(`${serviceId}.verified.test`);
  });

  it("rejects always-on instances on the Free plan, naming the offending services", async ({ expect }) => {
    // A project created through the internal projects API is owned by a billing
    // team that starts on the Free plan (Project.create waits for that
    // entitlement), so this exercises the gate's POSITIVE path. Every other
    // project in this file is gated as Free too; the tests that need a paid
    // capability opt in with Project.createAndSwitchOnPaidPlan().
    const { createProjectResponse } = await Project.createAndSwitch();
    expect(createProjectResponse.body.owner_team_id).toEqual(expect.any(String));

    // The gate deliberately respects the same HEXCLAVE_DISABLE_PLAN_LIMITS
    // switch as every other Hexclave plan limit, and local `.env.local` files
    // commonly set it. Read what the backend actually does rather than assuming
    // — otherwise this test silently means the opposite thing on a dev machine.
    const planUsage = await niceBackendFetch("/api/v1/internal/plan-usage", { accessType: "admin" });
    const enforced = (planUsage.body as any)?.are_plan_limits_enforced !== false;

    const response = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: {
        version: GCP_VERSION,
        source_id: "plan-src",
        services: {
          web: { type: "serverless", ports: { 3000: { protocol: "http" } }, min_instances: 1, env: {} },
          worker: { type: "serverless", ports: { 3001: { protocol: "http" } }, min_instances: 2, max_instances: 3, env: {} },
          idle: { type: "serverless", ports: { 3002: { protocol: "http" } }, env: {} },
        },
      },
    });

    if (!enforced) {
      // Plan limits off: the gate must fail OPEN, not half-apply.
      expect(response.status).toBe(200);
      return;
    }

    expect(response.status).toBe(400);
    const message = JSON.stringify(response.body);
    expect(message).toContain("Free plan");
    // Names every offending service, and only those. Matched with backticks
    // because the message's own prose contains the bare word "idle".
    expect(message).toContain("`web`");
    expect(message).toContain("`worker`");
    expect(message).not.toContain("`idle`");

    // Nothing was written: the gate runs before the upsert.
    const listResponse = await niceBackendFetch("/api/v1/deployments/services", { accessType: "admin" });
    expect((listResponse.body as any).items).toEqual([]);

    // The same services scale-to-zero sync fine.
    const accepted = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: {
        version: GCP_VERSION,
        source_id: "plan-src",
        services: {
          web: { type: "serverless", ports: { 3000: { protocol: "http" } }, min_instances: 0, max_instances: 3, env: {} },
          worker: { type: "serverless", ports: { 3001: { protocol: "http" } }, env: {} },
        },
      },
    });
    expect(accepted.status).toBe(200);
  });

  it("rejects `server` services on the Free plan, whatever their minInstances", async ({ expect }) => {
    // A `server` is a VM that runs until the service is torn down — GCP has no
    // idle-suspend and no wake-on-request, so `minInstances: 0` is accepted and
    // ignored rather than scaling it to zero. The gate therefore refuses the
    // TYPE, not the instance floor: gating on minInstances alone let a Free
    // project hold a machine up around the clock by writing the one value that
    // reads like opting out of exactly that.
    const { createProjectResponse } = await Project.createAndSwitch();
    expect(createProjectResponse.body.owner_team_id).toEqual(expect.any(String));

    const planUsage = await niceBackendFetch("/api/v1/internal/plan-usage", { accessType: "admin" });
    const enforced = (planUsage.body as any)?.are_plan_limits_enforced !== false;

    const response = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: {
        version: GCP_VERSION,
        source_id: "server-plan-src",
        services: {
          // The value that used to buy its way past the gate.
          db: { type: "server", ports: { 5432: { protocol: "tcp" } }, min_instances: 0, env: {} },
          web: { type: "serverless", ports: { 3000: { protocol: "http" } }, min_instances: 0, env: {} },
        },
      },
    });

    if (!enforced) {
      // Plan limits off: the gate must fail OPEN, not half-apply.
      expect(response.status).toBe(200);
      return;
    }

    expect(response.status).toBe(400);
    const message = JSON.stringify(response.body);
    expect(message).toContain("Free plan");
    expect(message).toContain("`db`");
    // The scale-to-zero serverless alongside it is untouched, and the message
    // must not tell the author to set a minInstances they already set.
    expect(message).not.toContain("`web`");

    // Nothing was written: the gate runs before the upsert.
    const listResponse = await niceBackendFetch("/api/v1/deployments/services", { accessType: "admin" });
    expect((listResponse.body as any).items).toEqual([]);

    // The same config syncs once the billing team is on a paid plan — proving
    // the refusal is the entitlement, not the definition.
    await Project.grantBillingTeamPlan(createProjectResponse.body.owner_team_id);
    const accepted = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: {
        version: GCP_VERSION,
        source_id: "server-plan-src",
        services: {
          db: { type: "server", ports: { 5432: { protocol: "tcp" } }, min_instances: 0, env: {} },
          web: { type: "serverless", ports: { 3000: { protocol: "http" } }, min_instances: 0, env: {} },
        },
      },
    });
    expect(accepted.status).toBe(200);
  });

  it("stores a volume and surfaces it on the service", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const serviceId = uniqueServiceId("vol");
    const { sourceId } = await syncServices({
      [serviceId]: { type: "server", ports: { 3000: { protocol: "http" } }, min_instances: 0, max_instances: 1, persistent_volumes: { data: { path: "/data", size_gb: 10 } }, env: {} },
    });
    const getResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect(getResponse.status).toBe(200);
    // Keyed by volume id, the same shape the config file declares.
    expect((getResponse.body as any).persistent_volumes).toEqual({ data: { path: "/data", size_gb: 10 } });

    // Re-syncing without the volume must clear ALL THREE columns, not leave a
    // half-written tuple that would keep mounting a disk the config dropped.
    // Same source: this is the SAME deploy file re-syncing, and a service id
    // another source already owns is refused rather than reassigned.
    await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, min_instances: 0, max_instances: 1, env: {} } }, sourceId);
    const afterRemoval = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((afterRemoval.body as any).persistent_volumes).toBe(null);
  });

  it("rejects shrinking a volume at sync time, before anything is uploaded", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const serviceId = uniqueServiceId("shrink");
    // A `server`, because only a single-instance service may hold a disk.
    const definition = (sizeGb: number) => ({
      [serviceId]: { type: "server", ports: { 3000: { protocol: "http" } }, min_instances: 0, max_instances: 1, persistent_volumes: { data: { path: "/data", size_gb: sizeGb } }, env: {} },
    });
    const { sourceId } = await syncServices(definition(10));

    // Growing is fine; shrinking must fail HERE rather than at apply time, when
    // the CLI has already packaged and uploaded the source.
    await syncServices(definition(20), sourceId);
    const shrunk = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT", accessType: "admin", body: { version: GCP_VERSION, source_id: sourceId, services: definition(5) },
    });
    expect(shrunk.status).toBe(400);
    expect(JSON.stringify(shrunk.body)).toContain("cannot be shrunk");

    // The rejected sync wrote nothing — the stored size is still the grown one.
    const read = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((read.body as any).persistent_volumes).toEqual({ data: { path: "/data", size_gb: 20 } });

    // Detaching entirely is always allowed, whatever the size.
    const detached = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT", accessType: "admin",
      body: { version: GCP_VERSION, source_id: sourceId, services: { [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, max_instances: 1, env: {} } } },
    });
    expect(detached.status).toBe(200);
  });

  it("rejects a volume on a service that could run more than one instance", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    // A persistent disk attaches to one VM, so a fleet would silently give each
    // instance its own separate disk. Only a "server" is single-instance by
    // construction, so that is where the rule lives now.
    const response = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "vol-src", services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, max_instances: 2, persistent_volumes: { data: { path: "/data", size_gb: 1 } }, env: {} } } },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("only a \\\"server\\\" service may have persistent volumes");

    // A server may not restate bounds that contradict its type.
    const badBounds = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { services: { web: { type: "server", ports: { 3000: { protocol: "http" } }, max_instances: 2, persistent_volumes: { data: { path: "/data", size_gb: 1 } }, env: {} } } },
    });
    expect(badBounds.status).toBe(400);

    // The current persistent-server abstraction intentionally supports one data disk.
    const twoVolumes = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "vol-src", services: { web: { type: "server", ports: { 3000: { protocol: "http" } }, env: {},
        persistent_volumes: { data: { path: "/data", size_gb: 1 }, cache: { path: "/cache", size_gb: 1 } } } } },
    });
    expect(twoVolumes.status).toBe(400);
    expect(JSON.stringify(twoVolumes.body)).toContain("at most 1 persistent volume");
  });

  it("rejects a volume mount path that is not a normalized absolute path", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    for (const path of ["data", "/", "/data/../etc"]) {
      const response = await niceBackendFetch("/api/v1/deployments/services", {
        method: "PUT",
        accessType: "admin",
        body: { version: GCP_VERSION, source_id: "vol-src", services: { web: { type: "server", ports: { 3000: { protocol: "http" } }, persistent_volumes: { data: { path, size_gb: 1 } }, env: {} } } },
      });
      expect(response.status, `path ${JSON.stringify(path)}`).toBe(400);
      expect(JSON.stringify(response.body)).toContain("normalized absolute path");
    }
  });

  it("stores dockerfile_path and rejects one escaping the source root", async ({ expect }) => {
    await Project.createAndSwitch();
    const ok = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "df-src", services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, dockerfile_path: "docker/Dockerfile.web", env: {} } } },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as any).items.find((item: any) => item.id === "web").dockerfile_path).toBe("docker/Dockerfile.web");
    const escaping = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "df-src", services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, dockerfile_path: "../Dockerfile", env: {} } } },
    });
    expect(escaping.status).toBe(400);
    expect(JSON.stringify(escaping.body)).toContain("dockerfile_path");
  });

  it("stores a prebuilt image, normalized, and refuses one that also builds", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const ok = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      // A `server`, because this one holds a TCP port.
      body: { version: GCP_VERSION, source_id: "img-src", services: { db: { type: "server", ports: { 5432: { protocol: "tcp" } }, min_instances: 0, image: "postgres:16", env: {} } } },
    });
    expect(ok.status).toBe(200);
    const list = await niceBackendFetch("/api/v1/deployments/services", { accessType: "admin" });
    const stored = (list.body as any).items.find((item: any) => item.id === "db");
    // Fully qualified, so the stored definition names what is actually pulled.
    expect(stored.image).toBe("docker.io/library/postgres:16");
    // ...and the source fields stay empty, because nothing is built from the upload.
    expect(stored.root_directory).toBeNull();
    expect(stored.dockerfile_path).toBeNull();

    // `image` and `dockerfile_path` each say what the build starts from.
    const both = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "img-src", services: { db: { type: "server", ports: {}, min_instances: 0, image: "postgres:16", dockerfile_path: "Dockerfile", env: {} } } },
    });
    expect(both.status).toBe(400);
    expect(JSON.stringify(both.body)).toContain("not both");

    // An untagged image means ":latest", which moves under a running service.
    const untagged = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "img-src", services: { db: { type: "server", ports: {}, min_instances: 0, image: "postgres", env: {} } } },
    });
    expect(untagged.status).toBe(400);
    expect(JSON.stringify(untagged.body)).toContain("no tag or digest");
  });

  it("stores build and start commands, and turns an image into a base", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const ok = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: {
        version: GCP_VERSION,
        source_id: "cmd-src",
        services: {
          // No image and no Dockerfile: built on the Hexclave base image, which
          // is why the start command is what makes it runnable.
          web: {
            type: "serverless", ports: { 3000: { protocol: "http" } }, root_directory: "apps/web",
            build_command: "pnpm install && pnpm build", start_command: "pnpm start", env: {},
          },
          // An image with a build command is a BASE, so it keeps its root
          // directory — the source is copied onto it and the command runs there.
          api: {
            type: "serverless", ports: { 8080: { protocol: "http" } }, image: "python:3.12-slim",
            root_directory: "api", build_command: "pip install -r requirements.txt",
            start_command: "python -m uvicorn main:app --host 0.0.0.0 --port 8080", env: {},
          },
          // A start command alone builds nothing: it is applied by the runtime.
          cache: {
            type: "server", ports: { 6379: { protocol: "tcp" } }, min_instances: 0,
            image: "redis:7-alpine", start_command: "redis-server --appendonly yes", env: {},
          },
        },
      },
    });
    expect(ok.status).toBe(200);
    const items = (ok.body as any).items;
    const byId = (id: string) => items.find((item: any) => item.id === id);
    expect(byId("web").build_command).toBe("pnpm install && pnpm build");
    expect(byId("web").start_command).toBe("pnpm start");
    expect(byId("api").image).toBe("docker.io/library/python:3.12-slim");
    expect(byId("api").root_directory).toBe("api");
    expect(byId("cache").build_command).toBeNull();
    expect(byId("cache").start_command).toBe("redis-server --appendonly yes");
  });

  it("refuses a command that could not survive the file it is written into", async ({ expect }) => {
    await Project.createAndSwitch();
    const service = (extra: Record<string, unknown>) => ({
      source_id: "cmd-bad-src",
      services: { web: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {}, ...extra } },
    });
    // A newline is a second Dockerfile instruction; it is refused rather than escaped.
    const newline = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT", accessType: "admin",
      body: service({ build_command: "npm ci\nrm -rf /", start_command: "npm start" }),
    });
    expect(newline.status).toBe(400);
    expect(JSON.stringify(newline.body)).toContain("build_command");
    // The Hexclave base image starts nothing on its own.
    const noStart = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT", accessType: "admin",
      body: service({ build_command: "npm ci" }),
    });
    expect(noStart.status).toBe(400);
    expect(JSON.stringify(noStart.body)).toContain("no command of its own");
    // A root directory on a service that is not built from the upload.
    const strayRoot = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT", accessType: "admin",
      body: service({ image: "postgres:16", root_directory: "db" }),
    });
    expect(strayRoot.status).toBe(400);
    expect(JSON.stringify(strayRoot.body)).toContain("has no `root_directory`");
  });

  it("rejects definitions without a port and with a non-container type", async ({ expect }) => {
    await Project.createAndSwitch();
    const noPort = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { services: { web: { type: "serverless", env: {} } } },
    });
    expect(noPort.status).toBe(400);
    const wrongType = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "type-src", services: { web: { type: "vercel", ports: { 3000: { protocol: "http" } }, env: {} } } },
    });
    expect(wrongType.status).toBe(400);
  });

  it("rejects the reserved `hexclave` service id and an empty services map", async ({ expect }) => {
    await Project.createAndSwitch();
    const reserved = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { services: { hexclave: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } } },
    });
    expect(reserved.status).toBe(400);
    const empty = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "empty-src", services: {} },
    });
    // An empty services map is rejected — the CLI only syncs when the config declares at
    // least one service (evaluateServicesFunction errors on an empty export).
    expect(empty.status).toBe(400);
  });
});

describe("secrets", () => {
  it("sets, lists, overwrites, and deletes write-only secret values", async ({ expect }) => {
    await Project.createAndSwitch();

    const setResponse = await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "db_connection", value: "postgres://user:hunter2@db.example.com/app" },
    });
    expect(setResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "created": true,
          "key": "db_connection",
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    // Overwriting reports created: false; the value is never echoed anywhere.
    const overwriteResponse = await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "db_connection", value: "postgres://user:hunter3@db.example.com/app" },
    });
    expect((overwriteResponse.body as any).created).toBe(false);

    const listResponse = await niceBackendFetch("/api/v1/project-secrets", { accessType: "admin" });
    expect(listResponse.status).toBe(200);
    expect((listResponse.body as any).items.map((item: any) => item.key)).toEqual(["db_connection"]);
    expect(JSON.stringify(listResponse.body)).not.toContain("hunter");

    // Invalid keys and empty values are rejected.
    const invalidKeyResponse = await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "bad key", value: "x" },
    });
    expect(invalidKeyResponse.status).toBe(400);
    const emptyValueResponse = await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "some_key", value: "" },
    });
    expect(emptyValueResponse.status).toBe(400);

    const deleteResponse = await niceBackendFetch("/api/v1/project-secrets/db_connection", {
      method: "DELETE",
      accessType: "admin",
    });
    expect(deleteResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const deleteAgainResponse = await niceBackendFetch("/api/v1/project-secrets/db_connection", {
      method: "DELETE",
      accessType: "admin",
    });
    expect(deleteAgainResponse.status).toBe(404);
    const emptyListResponse = await niceBackendFetch("/api/v1/project-secrets", { accessType: "admin" });
    expect((emptyListResponse.body as any).items).toEqual([]);
  });

  it("scopes secrets per project", async ({ expect }) => {
    await Project.createAndSwitch();
    await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "shared_key", value: "project-a-value" },
    });
    await Project.createAndSwitch();
    const otherProjectList = await niceBackendFetch("/api/v1/project-secrets", { accessType: "admin" });
    expect((otherProjectList.body as any).items).toEqual([]);
  });
});

describe("deploys against the Marshal runtime", () => {
  it("deploys a service end to end: sync, upload, build, runtime, env resolution", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("web");

    // Store a secret value first (the dashboard flow), then reference it.
    const setSecret = await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "openai_api_key", value: "sk-secret-value-123" },
    });
    expect(setSecret.status).toBe(200);

    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [serviceId]: {
        type: "serverless",
        ports: { 3000: { protocol: "http" } },
        min_instances: 0,
        max_instances: 2,
        // Rides through the whole deploy into the Marshal spec — this covers the
        // backend→Marshal dockerfile_path passthrough (Marshal validates it on the spec
        // PUT; the mock builder then ignores it, as builds are not exercised here).
        dockerfile_path: "docker/Dockerfile.web",
        env: {
          PLAIN_VAR: { value: "plain-value" },
          OPENAI_KEY: { type: "secret", key: "openai_api_key" },
          PROJECT_ID: { type: "connection", value: "hexclave.projectId" },
          ["__proto__"]: { value: "special-key-value" },
        },
      },
    });
    const { uploadId } = await createUpload();
    const deploymentId = await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]], accessType: "server" });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");
    expect(deployment.deployment_source_id).toBe(sourceId);
    expect(deployment.triggered_by).toBe("server");
    const outcome = serviceOutcome(deployment, serviceId);
    expect(outcome.status).toBe("deployed");
    // Container services are private by default: no verified domain, no URL.
    expect(outcome.url).toBeNull();

    // The service board shape after a successful deploy.
    const serviceResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    const service = serviceResponse.body as any;
    expect(service.status).toBe("deployed");
    expect(service.provisioned).toBe(true);
    expect(service.has_successful_deploy).toBe(true);

    // Cloud Run represents the fleet as one autoscaled service. max_instances
    // is a scaling bound, not a count of eagerly-created machines.
    const { service: cloudRun } = await findMockCloudRun(serviceId);
    expect(cloudRun.scaling).toEqual({ minInstanceCount: 0, maxInstanceCount: 2 });
    const projectKeys = backendContext.value.projectKeys;
    if (projectKeys === "no-project") throw new Error("No project in context");
    expect(cloudRunEnv(cloudRun)).toEqual({
      PLAIN_VAR: "plain-value",
      OPENAI_KEY: "sk-secret-value-123",
      PROJECT_ID: projectKeys.projectId,
      ["__proto__"]: "special-key-value",
      // Every deployed service is handed its project's Hexclave credentials, plus
      // NEXT_PUBLIC_/VITE_ copies of the PUBLIC three — a framework that inlines values at
      // build time only reads its own prefix, so an unprefixed name is invisible to the
      // client bundle. Asserted with toEqual (not toMatchObject) so an accidental fourth
      // prefixed copy — of the secret server key above all — fails this test.
      HEXCLAVE_PROJECT_ID: projectKeys.projectId,
      HEXCLAVE_API_URL: expect.any(String),
      HEXCLAVE_PUBLISHABLE_CLIENT_KEY: expect.any(String),
      HEXCLAVE_SECRET_SERVER_KEY: expect.any(String),
      NEXT_PUBLIC_HEXCLAVE_PROJECT_ID: projectKeys.projectId,
      NEXT_PUBLIC_HEXCLAVE_API_URL: expect.any(String),
      NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY: expect.any(String),
      VITE_HEXCLAVE_PROJECT_ID: projectKeys.projectId,
      VITE_HEXCLAVE_API_URL: expect.any(String),
      VITE_HEXCLAVE_PUBLISHABLE_CLIENT_KEY: expect.any(String),
    });
    expect(cloudRun.template.containers[0].image).toMatch(/^us-central1-docker\.pkg\.dev\/.*@sha256:[0-9a-f]{64}$/);
    expect(cloudRun.labels["hexclave-service-key"]).toBe(serviceKeyHash(serviceId));

    // Build logs stream with every env VALUE redacted. The mock builder echoes the resolved
    // env into the log (MARSHAL_MOCK_ENV), standing in for a build step that echoes its own
    // environment — so this is a REAL redaction check, not a shape assertion.
    //
    // The plain var is scrubbed alongside the secret, and deliberately so: env vars reach
    // the build over a single channel with no marker saying which are sensitive, so Marshal
    // cannot tell "plain-value" from a database password and treats both as the latter.
    const logsResponse = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}/logs`, { accessType: "admin" });
    expect(logsResponse.status).toBe(200);
    const logsText = typeof logsResponse.body === "string" ? logsResponse.body : JSON.stringify(logsResponse.body);
    expect(logsText).toContain("MARSHAL_MOCK_ENV");
    expect(logsText).toContain("PLAIN_VAR=<redacted>");
    expect(logsText).toContain("OPENAI_KEY=<redacted>");
    expect(logsText).not.toContain("sk-secret-value-123");
    expect(logsText).not.toContain("plain-value");

    // Runtime logs: what the SERVICE printed, as opposed to what its build did.
    // gcp-mock writes the same Cloud Logging resource shape as a ready revision.
    const runtime = await readRuntimeLogs(serviceId);
    expect(runtime.status).toBe(200);
    expect(runtime.contentType).toContain("application/x-ndjson");
    expect(runtime.lines.length).toBeGreaterThan(0);
    for (const line of runtime.lines) {
      expect(typeof line.at_millis).toBe("number");
      expect(line.at_millis).toBeGreaterThan(0);
      expect(["stdout", "stderr", "system"]).toContain(line.stream);
    }

    const revisionReady = runtime.lines.find((line) => line.text.includes("Cloud Run revision"));
    expect(revisionReady?.stream).toBe("stdout");
    expect(runtime.lines.every((line) => line.instance === null)).toBe(true);

    // Resuming from the newest timestamp returns nothing: the cursor is what
    // makes a reconnect neither repeat nor skip, and it is the whole reason this
    // endpoint serves NDJSON rather than the build log's plain text.
    const newestAtMillis = Math.max(...runtime.lines.map((line) => line.at_millis));
    const resumed = await readRuntimeLogs(serviceId, { sinceMillis: newestAtMillis + 1 });
    expect(resumed.status).toBe(200);
    expect(resumed.lines).toEqual([]);

    // A cursor BEFORE the first line replays from there — the same request the
    // dashboard makes when it reconnects mid-history.
    const oldestAtMillis = Math.min(...runtime.lines.map((line) => line.at_millis));
    const replayed = await readRuntimeLogs(serviceId, { sinceMillis: oldestAtMillis });
    expect(replayed.status).toBe(200);
    expect(replayed.lines.length).toBeGreaterThan(0);
    for (const line of replayed.lines) expect(line.at_millis).toBeGreaterThanOrEqual(oldestAtMillis);
  });

  it("injects the deploy request's CI variables, and refuses keys outside the CI namespace", async ({ expect }) => {
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("ci-env");
    const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId, {
      // A service that declares one of these names has said what it means, so
      // its own value must survive the injection.
      env: { CI_COMMIT_REF_NAME: { value: "declared-in-the-deploy-file" } },
    });

    // `ci_env` is request-scoped: it describes the commit this deploy ships, so
    // it reaches the running service without ever being stored on the definition.
    const deploymentId = await startDeploy({
      sourceId,
      uploadId,
      definitionSyncId,
      levels: [[serviceId]],
      extraBody: { ci_env: { CI_COMMIT_SHA: "0123456789abcdef", CI_COMMIT_REF_NAME: "from-the-deploy-request" } },
    });
    await pollDeploymentToStatus(deploymentId, "deployed");
    const { service: cloudRun } = await findMockCloudRun(serviceId);
    expect(cloudRunEnv(cloudRun)).toMatchObject({
      CI_COMMIT_SHA: "0123456789abcdef",
      CI_COMMIT_REF_NAME: "declared-in-the-deploy-file",
    });
    // CI=true belongs to the BUILD, not to the service: the container this
    // produced runs as an ordinary process, so the flag must not survive into
    // its runtime env.
    expect(cloudRunEnv(cloudRun)).not.toHaveProperty("CI");

    // Not stored: the next deploy of this source must not inherit this deploy's
    // commit sha, so the definition still names only what the deploy file wrote.
    const serviceResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((serviceResponse.body as any).env.map((entry: any) => entry.key)).toEqual(["CI_COMMIT_REF_NAME"]);

    // A service with nothing to build gets NO CI variables. They describe the
    // commit that was built, and a prebuilt image has no relationship to it —
    // but the load-bearing reason is churn: these values change on every commit
    // and the runtime hashes env into a service's revision, so injecting them
    // here would delete and recreate an untouched `postgres:16` on every deploy
    // of its neighbours.
    const prebuiltId = uniqueServiceId("ci-env-prebuilt");
    const { syncId: prebuiltSyncId, sourceId: prebuiltSourceId } = await syncServices({
      [prebuiltId]: { type: "serverless", ports: { 5432: { protocol: "http" } }, image: "postgres:16", env: {} },
    });
    const prebuiltDeploymentId = await startDeploy({
      sourceId: prebuiltSourceId,
      definitionSyncId: prebuiltSyncId,
      levels: [[prebuiltId]],
      extraBody: { ci_env: { CI_COMMIT_SHA: "0123456789abcdef" } },
    });
    await pollDeploymentToStatus(prebuiltDeploymentId, "deployed");
    expect(cloudRunEnv((await findMockCloudRun(prebuiltId)).service)).not.toHaveProperty("CI_COMMIT_SHA");

    // The namespace is the guard: without it this field could overwrite the
    // injected Hexclave credentials, which are not the caller's to set.
    const badResponse = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: {
        source_id: sourceId,
        upload_id: (await createUpload()).uploadId,
        definition_sync_id: definitionSyncId,
        levels: [[serviceId]],
        ci_env: { HEXCLAVE_SECRET_SERVER_KEY: "ssk_not_yours" },
      },
    });
    expect(badResponse.status).toBe(400);
    expect(JSON.stringify(badResponse.body)).toContain("CI variable names");
  });

  it("refuses runtime logs for a service that was never deployed, and for one that does not exist", async ({ expect }) => {
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("never-deployed");
    // Synced but never deployed: the definition exists, the runtime has no app
    // for it, and GCP answers a missing runtime with an empty page — which would
    // render as a silently empty stream if this were not refused up front.
    await syncServices({
      [serviceId]: {
        type: "serverless",
        ports: { 3000: { protocol: "http" } },
        min_instances: 0,
        max_instances: 1,
        env: {},
      },
    });
    const notDeployed = await readRuntimeLogs(serviceId);
    expect(notDeployed.status).toBe(400);

    const missing = await readRuntimeLogs(uniqueServiceId("no-such-service"));
    expect(missing.status).toBe(404);
  });

  it("deploys a prebuilt image with no upload and no build at all", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("db");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [serviceId]: {
        type: "server",
        ports: { 5432: { protocol: "tcp" } },
        // Accepted on a `server`, but inert: the VM runs from apply until the
        // service is torn down, so this pins storage, not runtime behaviour.
        min_instances: 0,
        max_instances: 1,
        image: "postgres:16",
        env: { POSTGRES_PASSWORD: { value: "hunter2" } },
      },
    });
    // No createUpload: nothing is built, so there is nothing to package. The
    // backend refuses an upload here rather than consuming one nothing can use.
    const deploymentId = await startDeploy({ sourceId, definitionSyncId, levels: [[serviceId]] });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");
    // No builder ran, so there is no build log to offer.
    expect(deployment.has_build_logs).toBe(false);

    const outcome = serviceOutcome(deployment, serviceId);
    expect(outcome.status).toBe("deployed");
    // The deploy records what it actually RAN, which for a tag is a fact only the
    // platform has: nothing resolves the reference before the machine is created,
    // so this digest is what the platform reported back for it.
    expect(outcome.image).toMatch(/^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/);

    const { instance } = await findMockInstance(serviceId);
    expect(instance.status).toBe("RUNNING");
    // The VM is given the reference AS WRITTEN — the author's image from its
    // own registry, not an Artifact Registry image (which is what a built service gets),
    // and a tag rather than the digest the outcome reports.
    expect(startupScript(instance)).toContain("readonly IMAGE='docker.io/library/postgres:16'");
    expect(startupScript(instance)).toContain("'POSTGRES_PASSWORD=hunter2'");

    // The definition still reports the reference the author wrote.
    const service = (await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" })).body as any;
    expect(service.image).toBe("docker.io/library/postgres:16");
    expect(service.status).toBe("deployed");
  });

  it("starts a service with its start command, and builds one on a base image", { timeout: 180_000 }, async ({ expect }) => {
    // The two halves of the feature in one deploy: a start command that costs no
    // build (the image service still has none), and a build command that turns a
    // service with no Dockerfile into a base-image build.
    await Project.createAndSwitchOnPaidPlan();
    await InternalApiKey.createAndSetProjectKeys();
    const cacheServiceId = uniqueServiceId("cache");
    const webServiceId = uniqueServiceId("web");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [cacheServiceId]: {
        type: "server", ports: { 6379: { protocol: "tcp" } }, min_instances: 0, max_instances: 1,
        image: "redis:7-alpine", start_command: "redis-server --appendonly yes", env: {},
      },
      [webServiceId]: {
        type: "serverless", ports: { 3000: { protocol: "http" } },
        build_command: "npm ci && npm run build", start_command: "node server.js", env: {},
      },
    });
    // The upload is required because of the BUILD COMMAND: without it the web
    // service would have nothing to build, even though it names no Dockerfile.
    const { uploadId } = await createUpload();
    const deploymentId = await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[cacheServiceId], [webServiceId]] });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");
    expect(deployment.has_build_logs).toBe(true);
    expect(serviceOutcome(deployment, cacheServiceId).status).toBe("deployed");
    expect(serviceOutcome(deployment, webServiceId).status).toBe("deployed");
    // The image service was NOT built: a start command is applied by the runtime,
    // so it still runs the reference the author wrote.
    expect(serviceOutcome(deployment, cacheServiceId).image).toMatch(/^docker\.io\/library\/redis@sha256:[0-9a-f]{64}$/);
    // ...while the base-image build pushed an image of its own.
    expect(serviceOutcome(deployment, webServiceId).image).toMatch(/^us-central1-docker\.pkg\.dev\/.*@sha256:[0-9a-f]{64}$/);

    // Both runtimes replace the image entrypoint with a shell for start_command.
    const { instance: cacheInstance } = await findMockInstance(cacheServiceId);
    expect(startupScript(cacheInstance)).toContain("readonly IMAGE='docker.io/library/redis:7-alpine'");
    expect(startupScript(cacheInstance)).toContain("'--entrypoint' '/bin/sh'");
    expect(startupScript(cacheInstance)).toContain("'-c' 'redis-server --appendonly yes'");
    const { service: webCloudRun } = await findMockCloudRun(webServiceId);
    expect(webCloudRun.template.containers[0].command).toEqual(["/bin/sh"]);
    expect(webCloudRun.template.containers[0].args).toEqual(["-c", "node server.js"]);

    // Both commands survive the round trip into the service board.
    const service = (await niceBackendFetch(`/api/v1/deployments/services/${webServiceId}`, { accessType: "admin" })).body as any;
    expect(service.build_command).toBe("npm ci && npm run build");
    expect(service.start_command).toBe("node server.js");
  });

  it("deploys a mixed source-built and prebuilt deployment in one go", { timeout: 180_000 }, async ({ expect }) => {
    // The common shape: an app built from the repo, wired to a stock database
    // image. One deployment, one build covering only the built service, and both
    // applied in dependency order.
    await Project.createAndSwitchOnPaidPlan();
    await InternalApiKey.createAndSetProjectKeys();
    const dbServiceId = uniqueServiceId("db");
    const webServiceId = uniqueServiceId("web");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [dbServiceId]: { type: "server", ports: { 5432: { protocol: "tcp" } }, min_instances: 0, max_instances: 1, image: "postgres:16", env: {} },
      [webServiceId]: {
        type: "serverless",
        ports: { 3000: { protocol: "http" } },
        env: { DATABASE_HOST: { type: "connection", value: `${dbServiceId}.hostname` } },
      },
    });
    // The upload IS required here: one of the two services is built from it.
    const { uploadId } = await createUpload();
    const deploymentId = await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[dbServiceId], [webServiceId]] });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");
    // A build ran, so this one does have logs.
    expect(deployment.has_build_logs).toBe(true);

    // The prebuilt service runs its own registry's image; the built one runs what
    // the build pushed to Artifact Registry. Both outcomes name a digest — the prebuilt one
    // because the platform reported what its tag resolved to.
    expect(serviceOutcome(deployment, dbServiceId).image).toMatch(/^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/);
    expect(serviceOutcome(deployment, webServiceId).image).toMatch(/^us-central1-docker\.pkg\.dev\/.*@sha256:[0-9a-f]{64}$/);
    expect(serviceOutcome(deployment, dbServiceId).status).toBe("deployed");
    expect(serviceOutcome(deployment, webServiceId).status).toBe("deployed");

    // The connection resolved across the two kinds of service, which is the whole
    // point of deploying them together. `hostname()` returns the VM's internal IP:
    // there is no name to return, because nothing on GCP publishes a record for a
    // service (its own internal DNS names the INSTANCE, "-vm" suffix and all). A
    // name-derived hostname is what the Fly runtime answered, and handing one out
    // here produced an env var whose consumer got ENOTFOUND on a green deploy.
    const { service: webCloudRun } = await findMockCloudRun(webServiceId);
    const { instance: dbInstance } = await findMockInstance(dbServiceId);
    const expectedDatabaseHostname = dbInstance.networkInterfaces[0]?.networkIP;
    expect(expectedDatabaseHostname).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(cloudRunEnv(webCloudRun).DATABASE_HOST).toBe(expectedDatabaseHostname);
  });

  it("records what the deploy packaged, and reports it back with the deployment", { timeout: 120_000 }, async ({ expect }) => {
    // The uploaded tarball is consumed by the build and deleted, so this listing
    // is the only thing left to answer "why was my upload this big, and did my
    // .dockerignore work". It is stored as the client reports it — the client is
    // what packaged the tree — and read back on the deployment.
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("web");
    const { definitionSyncId, sourceId, uploadId } = await syncServiceAndUpload(serviceId);
    const manifest = {
      file_count: 3,
      total_bytes: 6_500,
      compressed_bytes: 2_100,
      entries: [
        { path: "web/public/hero.png", bytes: 6_000 },
        { path: "web/src/index.ts", bytes: 480 },
        { path: "web/Dockerfile", bytes: 20 },
      ],
    };
    const deploymentId = await startDeploy({
      sourceId,
      uploadId,
      definitionSyncId,
      levels: [[serviceId]],
      extraBody: { source_manifest: manifest },
    });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");
    expect(deployment.source_manifest).toEqual(manifest);
  });

  it("stores no manifest rather than a false one when the client reports nothing usable", async ({ expect }) => {
    // A debugging aid must degrade to "not recorded" rather than 400 a deploy or
    // store a shape the dashboard cannot read.
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("web");
    const { definitionSyncId, sourceId, uploadId } = await syncServiceAndUpload(serviceId);
    const deploymentId = await startDeploy({
      sourceId,
      uploadId,
      definitionSyncId,
      levels: [[serviceId]],
      extraBody: { source_manifest: { file_count: 2, entries: "not an array" } },
    });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");
    expect(deployment.source_manifest).toBe(null);
  });

  it("refuses `__proto__` as a service id, at the door", async ({ expect }) => {
    // REGRESSION: it used to be accepted, and then broke silently everywhere a
    // service id keys a record — `images[key] = ref` invokes the prototype
    // setter instead of creating an own property, so the deploy failed with "no
    // image was built for __proto__"; and Prisma's JSON serializer drops the key
    // outright, so the outcome stayed "pending" whatever the runtime reported.
    // The storage layer cannot represent it, so the honest fix is to say so on
    // the request that introduces it rather than mid-deploy.
    await Project.createAndSwitchOnPaidPlan();
    await InternalApiKey.createAndSetProjectKeys();
    const response = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      // A COMPUTED key: `{ __proto__: ... }` in an object literal sets the
      // prototype rather than adding a property, so the literal form would send
      // an empty record. The same hazard, one layer up.
      body: { version: GCP_VERSION, source_id: "proto-src", services: { ["__proto__"]: { type: "server", ports: {}, min_instances: 0, image: "postgres:16", env: {} } } },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("reserved");
  });

  it("refuses an upload for a deployment that builds nothing", async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    await InternalApiKey.createAndSetProjectKeys();
    const serviceId = uniqueServiceId("db");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [serviceId]: { type: "server", ports: { 5432: { protocol: "tcp" } }, min_instances: 0, image: "postgres:16", env: {} },
    });
    const { uploadId } = await createUpload();
    // Refused rather than ignored: an upload nothing can build from would be
    // consumed for no reason, and it means the caller and the stored definitions
    // disagree about what this deploy is.
    const response = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: sourceId, upload_id: uploadId, definition_sync_id: definitionSyncId, levels: [[serviceId]] },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("must be omitted");
  });

  it("gives the build every plain env value, and only those", { timeout: 120_000 }, async ({ expect }) => {
    // Frameworks that inline values (NEXT_PUBLIC_*, VITE_*) need them while they compile,
    // not just at runtime. There is no build/runtime marker on an env var: everything with
    // a resolvable value goes to the build, secrets included. A `service(...)` connection
    // is the one thing that cannot — the target has no address until it is rolled out.
    await Project.createAndSwitch();
    await InternalApiKey.createAndSetProjectKeys();
    const apiServiceId = uniqueServiceId("api");
    const webServiceId = uniqueServiceId("web");
    await niceBackendFetch("/api/v1/project-secrets", {
      method: "POST",
      accessType: "admin",
      body: { key: "inline_secret", value: "sk-build-secret-value" },
    });

    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [apiServiceId]: { type: "serverless", ports: { 8080: { protocol: "http" } }, env: {} },
      [webServiceId]: {
        type: "serverless",
        ports: { 3000: { protocol: "http" } },
        env: {
          NEXT_PUBLIC_API_URL: { value: "https://api.example.com" },
          BUILD_SECRET: { type: "secret", key: "inline_secret" },
          NEXT_PUBLIC_HEXCLAVE_PROJECT_ID: { type: "connection", value: "hexclave.projectId" },
          // Short enough to fall under the redaction floor, which exists so a log doesn't
          // become a wall of <redacted> over values like "true" and "5432".
          PORT: { value: "3000" },
          // A service connection: resolvable at rollout, unresolvable at build time.
          API_INTERNAL_URL: { type: "connection", value: `${apiServiceId}.url` },
        },
      },
    });
    // The api deploys first: an unnamed `url` blocks until its target's spec exists.
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId: (await createUpload()).uploadId, definitionSyncId, levels: [[apiServiceId]] }), "deployed");
    const { uploadId } = await createUpload();
    const deploymentId = await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[webServiceId]] });
    await pollDeploymentToStatus(deploymentId, "deployed");

    const logsResponse = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}/logs`, { accessType: "admin" });
    expect(logsResponse.status).toBe(200);
    const logsText = typeof logsResponse.body === "string" ? logsResponse.body : JSON.stringify(logsResponse.body);
    // MARSHAL_BUILD_ENV_KEYS lists the NAMES the build was handed (the mock builder starts
    // no machine, so this line is the only window onto that selection).
    expect(logsText).toContain("MARSHAL_BUILD_ENV_KEYS");
    for (const key of ["NEXT_PUBLIC_API_URL", "BUILD_SECRET", "NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "PORT"]) {
      expect(logsText).toContain(key);
    }
    expect(logsText).not.toContain("API_INTERNAL_URL");

    // The build value is scrubbed from the log, the short one is not, and the connection
    // still resolves for the RUNNING container — build-time absence is not runtime absence.
    expect(logsText).not.toContain("sk-build-secret-value");
    expect(logsText).toContain("PORT=3000");
    const { service: webCloudRun } = await findMockCloudRun(webServiceId);
    expect(cloudRunEnv(webCloudRun).API_INTERNAL_URL).toMatch(/^https:\/\/.*\.run\.app$/);
    expect(cloudRunEnv(webCloudRun).BUILD_SECRET).toBe("sk-build-secret-value");
  });

  it("provisions a volume and mounts it on the machine", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const serviceId = uniqueServiceId("vol");
    // `server`, because only a single-instance service may hold a disk.
    const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId, {
      type: "server",
      min_instances: 0,
      max_instances: 1,
      persistent_volumes: { data: { path: "/data", size_gb: 3 } },
    });
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]] }), "deployed");

    const { project, instance } = await findMockInstance(serviceId);
    expect(project.disks).toHaveLength(1);
    expect(project.disks[0].name).toMatch(/^hxv-/);
    expect(project.disks[0].sizeGb).toBe("3");
    // The VM attaches that exact persistent disk without auto-deleting it.
    const dataDisk = instance.disks.find((disk) => disk.boot !== true);
    expect(dataDisk).toMatchObject({ deviceName: project.disks[0].name, autoDelete: false });
    expect(dataDisk?.source).toContain(`/disks/${project.disks[0].name}`);

    // Growing the volume reuses the SAME volume rather than creating a second
    // one — the disk (and its data) must survive the redeploy.
    // The SAME deployment source re-syncing: another source claiming this service id is
    // refused, which is the point of the ownership rule.
    const { syncId: grownSyncId } = await syncServices({
      [serviceId]: { type: "server", ports: { 3000: { protocol: "http" } }, min_instances: 0, max_instances: 1, persistent_volumes: { data: { path: "/data", size_gb: 5 } }, env: {} },
    }, sourceId);
    const { uploadId: grownUploadId } = await createUpload();
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId: grownUploadId, definitionSyncId: grownSyncId, levels: [[serviceId]] }), "deployed");

    const grown = await findMockInstance(serviceId);
    expect(grown.project.disks).toHaveLength(1);
    expect(grown.project.disks[0].id).toBe(project.disks[0].id);
    expect(grown.project.disks[0].sizeGb).toBe("5");
  });

  it("adds a volume to an already-deployed service by recreating the machine", { timeout: 180_000 }, async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const serviceId = uniqueServiceId("voladd");

    // Deploy WITHOUT a volume first. `server` from the start, so that the only
    // thing changing in the second sync is the volume itself — a type change
    // would force a recreate on its own and hide what this test is pinning.
    const first = await syncServiceAndUpload(serviceId, { type: "server", min_instances: 0, max_instances: 1 });
    await pollDeploymentToStatus(await startDeploy({ sourceId: first.sourceId, uploadId: first.uploadId, definitionSyncId: first.definitionSyncId, levels: [[serviceId]] }), "deployed");
    const before = await findMockInstance(serviceId);
    expect(before.project.disks).toHaveLength(0);
    expect(before.instance.disks.filter((disk) => disk.boot !== true)).toEqual([]);
    const originalInstanceId = before.instance.id;

    // Now add a volume. Compute Engine cannot mutate the attached-disk graph in
    // this declarative instance create request, so Marshal provisions the disk and
    // replaces the VM while retaining that separately-managed disk.
    const second = await syncServiceAndUpload(serviceId, {
      type: "server",
      min_instances: 0,
      max_instances: 1,
      persistent_volumes: { data: { path: "/data", size_gb: 2 } },
    }, undefined, first.sourceId);
    await pollDeploymentToStatus(await startDeploy({ sourceId: second.sourceId, uploadId: second.uploadId, definitionSyncId: second.definitionSyncId, levels: [[serviceId]] }), "deployed");

    const after = await findMockInstance(serviceId);
    expect(after.project.disks).toHaveLength(1);
    expect(after.project.disks[0]).toMatchObject({ sizeGb: "2" });
    expect(after.instance.disks.find((disk) => disk.boot !== true)).toMatchObject({
      deviceName: after.project.disks[0].name,
      autoDelete: false,
    });
    expect(after.instance.id).not.toBe(originalInstanceId);
  });

  it("marks the run failed and reports blocked when a `url` connection has no verified domain", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const apiServiceId = uniqueServiceId("api");
    const webServiceId = uniqueServiceId("web");
    // web references the API's PUBLIC url, which needs a verified domain the API doesn't have.
    const sync = await syncServices({
      [apiServiceId]: { type: "serverless", ports: { 8080: { protocol: "http" } }, env: {} },
      [webServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API_URL: { type: "connection", value: `${apiServiceId}.url` } } },
    });
    const upload = await createUpload();
    const deploymentId = await startDeploy({ sourceId: sync.sourceId, uploadId: upload.uploadId, definitionSyncId: sync.syncId, levels: [[webServiceId]] });
    const run = await pollDeploymentToStatus(deploymentId, "failed");
    expect(JSON.stringify(run.error)).toContain("blocked");
    // The service reports blocked and has no public URL.
    const service = await niceBackendFetch(`/api/v1/deployments/services/${webServiceId}`, { accessType: "admin" });
    expect((service.body as any).url).toBeNull();
  });

  it("gives public services a run.app endpoint and restricts ingress when they become private", { timeout: 180_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("public");

    const first = await syncServiceAndUpload(serviceId, { public: true, ports: { 3000: { protocol: "http" } } });
    const publicRun = await pollDeploymentToStatus(await startDeploy({ sourceId: first.sourceId, uploadId: first.uploadId, definitionSyncId: first.definitionSyncId, levels: [[serviceId]] }), "deployed");
    expect(serviceOutcome(publicRun, serviceId).url).toMatch(/^https:\/\/hxc-.+\.run\.app$/);
    const publicService = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((publicService.body as any).public).toBe(true);
    expect((publicService.body as any).ports).toEqual({ 3000: { protocol: "http" } });
    expect((publicService.body as any).url).toBe(serviceOutcome(publicRun, serviceId).url);
    const { service: publicCloudRun } = await findMockCloudRun(serviceId);
    expect(publicCloudRun.ingress).toBe("INGRESS_TRAFFIC_ALL");
    expect(publicCloudRun.invokerIamDisabled).toBe(true);

    const second = await syncServiceAndUpload(serviceId, { public: false, ports: { 3000: { protocol: "http" } } }, undefined, first.sourceId);
    const privateRun = await pollDeploymentToStatus(await startDeploy({ sourceId: second.sourceId, uploadId: second.uploadId, definitionSyncId: second.definitionSyncId, levels: [[serviceId]] }), "deployed");
    expect(serviceOutcome(privateRun, serviceId).url).toBeNull();
    const privateService = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((privateService.body as any).public).toBe(false);
    expect((privateService.body as any).ports).toEqual({ 3000: { protocol: "http" } });
    expect((privateService.body as any).url).toBeNull();
    const { service: privateCloudRun } = await findMockCloudRun(serviceId);
    expect(privateCloudRun.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(privateCloudRun.invokerIamDisabled).toBe(true);
  });

  it("rejects a connection to a service that doesn't exist", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("web");
    const { syncId, sourceId } = await syncServices({
      [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { X: { type: "connection", value: "nonexistent.url" } } },
    });
    const { uploadId } = await createUpload();
    const response = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: sourceId, upload_id: uploadId, definition_sync_id: syncId, levels: [[serviceId]] },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("doesn't exist");
  });

  it("resolves url connections between services deterministically, named or not", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const apiServiceId = uniqueServiceId("api");
    const webServiceId = uniqueServiceId("web");

    // The API deploys first...
    const { syncId: sync1, sourceId } = await syncServices({
      [apiServiceId]: { type: "serverless", ports: { 8080: { protocol: "http" } }, env: {} },
      [webServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API_URL: { type: "connection", value: `${apiServiceId}.url` } } },
    });
    const upload1 = await createUpload();
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId: upload1.uploadId, definitionSyncId: sync1, levels: [[apiServiceId]] }), "deployed");

    // ...and the web service's env gets the API's private Cloud Run URI.
    const upload2 = await createUpload();
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId: upload2.uploadId, definitionSyncId: sync1, levels: [[webServiceId]] }), "deployed");

    const { service: webCloudRun } = await findMockCloudRun(webServiceId);
    const { service: apiCloudRun } = await findMockCloudRun(apiServiceId);
    expect(cloudRunEnv(webCloudRun).API_URL).toBe(apiCloudRun.uri);

    // A multi-port target has to be named explicitly: a bare url() is ambiguous
    // and rejected, while `:9090` resolves to that port.
    const multiServiceId = uniqueServiceId("multi");
    const consumerId = uniqueServiceId("consumer");
    const ambiguous = await syncServices({
      [multiServiceId]: { type: "server", ports: { 8080: { protocol: "http" }, 9090: { protocol: "http" } }, min_instances: 0, max_instances: 1, env: {} },
      [consumerId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API: { type: "connection", value: `${multiServiceId}.url` } } },
    });
    const consumerUpload = await createUpload();
    const ambiguousDeploy = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: {
        source_id: ambiguous.sourceId,
        upload_id: consumerUpload.uploadId,
        definition_sync_id: ambiguous.syncId,
        levels: [[consumerId]],
      },
    });
    expect(ambiguousDeploy.status).toBe(400);
    expect(JSON.stringify(ambiguousDeploy.body)).toContain("exactly one HTTP port");

    const named = await syncServices({
      [multiServiceId]: { type: "server", ports: { 8080: { protocol: "http" }, 9090: { protocol: "http" } }, min_instances: 0, max_instances: 1, env: {} },
      [consumerId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API: { type: "connection", value: `${multiServiceId}.url:9090` } } },
    }, ambiguous.sourceId);
    const namedUpload = await createUpload();
    // The target is applied FIRST. Naming a private port settles WHICH port the URL means,
    // but not the address it is built from: that is the target VM's internal IP, which only
    // exists once the target has rolled out. `connectionRequiresTargetDeployed` makes every
    // service reference a deploy-ordering edge for exactly this reason — a consumer put
    // ahead of its target fails the deploy on "blocked on unresolved refs".
    await pollDeploymentToStatus(
      await startDeploy({ sourceId: named.sourceId, uploadId: namedUpload.uploadId, definitionSyncId: named.syncId, levels: [[multiServiceId], [consumerId]] }),
      "deployed",
    );
    const { service: consumerCloudRun } = await findMockCloudRun(consumerId);
    const { instance: multiInstance } = await findMockInstance(multiServiceId);
    // The named port, on the target's own address — not on the sole-HTTP-port internal URL,
    // which is null for a multi-port service and is what a wrong resolution would produce.
    expect(cloudRunEnv(consumerCloudRun).API).toBe(`http://${multiInstance.networkInterfaces[0]?.networkIP}:9090`);
    // The API must report the reference it actually stored, port and all —
    // reporting a bare `url` would name a DIFFERENT (and, on this multi-port
    // target, invalid) config.
    const consumerService = await niceBackendFetch(`/api/v1/deployments/services/${consumerId}`, { accessType: "admin" });
    expect((consumerService.body as any).env).toContainEqual(
      { key: "API", type: "connection", value: `${multiServiceId}.url:9090`, secret_key: null },
    );
    // A port suffix is meaningful only on `url`: a hostname is the service's private DNS
    // name, which no port belongs to.
    const strayPort = await syncServices({
      [multiServiceId]: { type: "server", ports: { 8080: { protocol: "http" }, 9090: { protocol: "http" } }, min_instances: 0, max_instances: 1, env: {} },
      [consumerId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { H: { type: "connection", value: `${multiServiceId}.hostname:9090` } } },
    }, named.sourceId);
    const strayUpload = await createUpload();
    const strayDeploy = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: {
        source_id: strayPort.sourceId,
        upload_id: strayUpload.uploadId,
        definition_sync_id: strayPort.syncId,
        levels: [[consumerId]],
      },
    });
    expect(strayDeploy.status).toBe(400);
    // Quote-free substring: the body is JSON-stringified, so the message's own quotes are escaped.
    expect(JSON.stringify(strayDeploy.body)).toContain("names a port, but only");
  });

  it("fails the run when the container build fails", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("failing");
    const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId, {
      // The magic env key makes Marshal's mock builder fail the build.
      env: { MARSHAL_MOCK_FAIL_BUILD: { value: "1" } },
    });
    const deploymentId = await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]] });
    const run = await pollDeploymentToStatus(deploymentId, "failed");
    expect(String(run.error)).toContain("mock build failed");
  });

  it("does not consume the upload when secrets are missing, and lists every missing key", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("needs-secret");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [serviceId]: {
        type: "serverless",
        ports: { 3000: { protocol: "http" } },
        env: {
          REQUIRED: { type: "secret", key: "never_set_secret" },
          ALSO_REQUIRED: { type: "secret", key: "also_never_set" },
        },
      },
    });
    const { uploadId } = await createUpload();
    const failedDeploy = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: sourceId, upload_id: uploadId, definition_sync_id: definitionSyncId, levels: [[serviceId]] },
    });
    expect(failedDeploy.status).toBe(400);
    // Both missing keys are named in one error (not just the first).
    expect(JSON.stringify(failedDeploy.body)).toContain("never_set_secret");
    expect(JSON.stringify(failedDeploy.body)).toContain("also_never_set");

    // The upload survives the rejected deploy: set both secrets and reuse it.
    for (const key of ["never_set_secret", "also_never_set"]) {
      await niceBackendFetch("/api/v1/project-secrets", { method: "POST", accessType: "admin", body: { key, value: "now-set" } });
    }
    const deploymentId = await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]] });
    await pollDeploymentToStatus(deploymentId, "deployed");
  });

  it("404s a deploy referencing an upload id that doesn't exist", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("web");
    const { syncId: definitionSyncId, sourceId } = await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } });
    const response = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: sourceId, upload_id: randomUUID(), definition_sync_id: definitionSyncId, levels: [[serviceId]] },
    });
    expect(response.status).toBe(404);
  });

  it("consumes an upload exactly once", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("once");
    const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId);
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]] }), "deployed");
    const secondDeploy = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: sourceId, upload_id: uploadId, definition_sync_id: definitionSyncId, levels: [[serviceId]] },
    });
    expect(secondDeploy.status).toBe(404);
  });

  it("rejects deploys with a stale definition sync id", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("stale");
    const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId);
    // A second sync of the SAME source regenerates the fencing token...
    await syncServices({ [serviceId]: { type: "serverless", ports: { 3001: { protocol: "http" } }, env: {} } }, sourceId);
    // ...so the first deploy's token is now stale.
    const response = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: { source_id: sourceId, upload_id: uploadId, definition_sync_id: definitionSyncId, levels: [[serviceId]] },
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain("changed after this deploy synced its definitions");
  });

  it("400s deploys naming a deployment source that was never synced", async ({ expect }) => {
    await Project.createAndSwitch();
    const { uploadId } = await createUpload();
    const response = await niceBackendFetch("/api/v1/deployments/deployments", {
      method: "POST",
      accessType: "admin",
      body: {
        source_id: "never-synced",
        upload_id: uploadId,
        definition_sync_id: randomUUID(),
        levels: [["never-synced-service"]],
      },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("No deployment source");
  });

  it("keeps the machine env in sync when a redeploy drops a var", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("recon");
    const { syncId: sync1, sourceId } = await syncServices({
      [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { KEEP: { value: "yes" }, DROP: { value: "bye" } } },
    });
    const upload1 = await createUpload();
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId: upload1.uploadId, definitionSyncId: sync1, levels: [[serviceId]] }), "deployed");
    // toMatchObject, not toEqual: every service also receives its project's Hexclave
    // credentials, which the end-to-end test above pins exactly. What matters here is the
    // declared pair, and below, that DROP is really gone.
    expect(cloudRunEnv((await findMockCloudRun(serviceId)).service)).toMatchObject({ KEEP: "yes", DROP: "bye" });

    // The SAME deployment source re-syncing: a different one claiming this
    // service id would be refused, which is the point of the ownership rule.
    const { syncId: sync2 } = await syncServices({
      [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { KEEP: { value: "yes" } } },
    }, sourceId);
    const upload2 = await createUpload();
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId: upload2.uploadId, definitionSyncId: sync2, levels: [[serviceId]] }), "deployed");
    // The Cloud Run revision was replaced with the new spec's env — the dropped
    // var is actually gone, not merely unlisted.
    const redeployedEnv = cloudRunEnv((await findMockCloudRun(serviceId)).service);
    expect(redeployedEnv).toMatchObject({ KEEP: "yes" });
    expect(Object.hasOwn(redeployedEnv, "DROP")).toBe(false);
  });

  // Skipped: Marshal serializes concurrent applies with a lease built on conditional writes
  // (If-None-Match), and the s3mock container this suite runs against does not honour them
  // atomically — two callers both "acquire" the lease, so the serialization this asserts
  // cannot hold here. Real S3/R2 does honour them, and the losing deploy now returns a clean
  // 409 rather than a 500. Un-skip once the e2e object store enforces conditional writes.
  it.skip("serializes concurrent deploys so a stale completion cannot overwrite the winner", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("concurrent");
    const { syncId: definitionSyncId, sourceId } = await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } });
    const [firstUpload, secondUpload] = await Promise.all([createUpload(), createUpload()]);
    const [firstDeploymentId, secondDeploymentId] = await Promise.all([
      startDeploy({ sourceId, uploadId: firstUpload.uploadId, definitionSyncId, levels: [[serviceId]] }),
      startDeploy({ sourceId, uploadId: secondUpload.uploadId, definitionSyncId, levels: [[serviceId]] }),
    ]);

    const terminalStatuses = new Map<string, string>();
    for (let attempt = 0; attempt < 240 && terminalStatuses.size < 2; attempt++) {
      for (const deploymentId of [firstDeploymentId, secondDeploymentId]) {
        if (terminalStatuses.has(deploymentId)) continue;
        const response = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}`, { accessType: "admin" });
        const status = (response.body as any)?.status;
        if (status === "deployed" || status === "failed" || status === "canceled") terminalStatuses.set(deploymentId, status);
      }
      if (terminalStatuses.size < 2) await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect([...terminalStatuses.values()].sort()).toEqual(["canceled", "deployed"]);
  });

  // NOTE: there is deliberately no backend DELETE-service route (removal is config-driven;
  // auto-cleanup of services dropped from the config is a tracked gap), so Marshal's
  // deleteService — which releases the hostname claim and tears down the GCP runtime — has no
  // backend-e2e path to exercise. Worth a direct Marshal-level test when one is added.
});

describe("domains", () => {
  it("adds a domain, reports its DNS records, and removes it", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("domained");
    const { uploadId, definitionSyncId, sourceId } = await syncServiceAndUpload(serviceId);
    await pollDeploymentToStatus(await startDeploy({ sourceId, uploadId, definitionSyncId, levels: [[serviceId]] }), "deployed");

    // The magic ".verified.test" suffix makes gcp-mock mark the managed certificate ACTIVE.
    const hostname = `${serviceId}.verified.test`;
    const addResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname, is_primary: true },
    });
    expect(addResponse.status).toBe(201);
    expect((addResponse.body as any).verified).toBe(true);

    const getResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains/${hostname}`, { accessType: "admin" });
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as any).verified).toBe(true);
    expect((getResponse.body as any).pending_first_deploy).toBe(false);

    // A verified primary domain becomes the service's public URL...
    const serviceResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((serviceResponse.body as any).url).toBe(`https://${hostname}`);

    // ...and an unverified one reports the records to create.
    const pendingHostname = `${serviceId}.example.com`;
    const addPending = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname: pendingHostname },
    });
    expect(addPending.status).toBe(201);
    expect((addPending.body as any).verified).toBe(false);
    const getPending = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains/${pendingHostname}`, { accessType: "admin" });
    const records = (getPending.body as any).dns_records;
    expect(Array.isArray(records)).toBe(true);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "TXT",
        name: `_hexclave-verification.${pendingHostname}`,
        value: expect.stringMatching(/^hexclave-domain-verification=[A-Za-z0-9_-]{43}$/),
      }),
      expect.objectContaining({ type: "A", name: pendingHostname }),
    ]));

    const deleteResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains/${hostname}`, {
      method: "DELETE",
      accessType: "admin",
    });
    expect(deleteResponse.status).toBe(200);
    const serviceAfterDelete = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}`, { accessType: "admin" });
    expect((serviceAfterDelete.body as any).url).toBeNull();
  });

  it("rejects a hostname already attached to another project's service", { timeout: 120_000 }, async ({ expect }) => {
    // The hostname registry is global across namespaces (GCP itself does NOT
    // enforce cross-app hostname uniqueness — Marshal's bucket registry does).
    const hostname = `contested-${randomUUID().slice(0, 8)}.verified.test`;

    await Project.createAndSwitch();
    const firstServiceId = uniqueServiceId("first");
    const first = await syncServiceAndUpload(firstServiceId);
    await pollDeploymentToStatus(await startDeploy({ sourceId: first.sourceId, uploadId: first.uploadId, definitionSyncId: first.definitionSyncId, levels: [[firstServiceId]] }), "deployed");
    const firstAdd = await niceBackendFetch(`/api/v1/deployments/services/${firstServiceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname },
    });
    expect(firstAdd.status).toBe(201);

    await Project.createAndSwitch();
    const secondServiceId = uniqueServiceId("second");
    const second = await syncServiceAndUpload(secondServiceId);
    await pollDeploymentToStatus(await startDeploy({ sourceId: second.sourceId, uploadId: second.uploadId, definitionSyncId: second.definitionSyncId, levels: [[secondServiceId]] }), "deployed");
    const secondAdd = await niceBackendFetch(`/api/v1/deployments/services/${secondServiceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname },
    });
    expect(secondAdd.status).toBe(409);
    expect(JSON.stringify(secondAdd.body)).toContain("already attached elsewhere");
  });

  it("rejects a hostname already attached to another service in the SAME project", { timeout: 120_000 }, async ({ expect }) => {
    // Marshal holds exactly one claim per hostname, so two services in one project must not
    // both keep a row for it: the loser would go on advertising a verified URL that routes to
    // the winner, and either service's delete would tear down the other's live certificate.
    await Project.createAndSwitch();
    const ownerServiceId = uniqueServiceId("owner");
    const otherServiceId = uniqueServiceId("other");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [ownerServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
      [otherServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
    });
    // Both services in ONE deployment: a deploy ships its whole source, and GCP mutations of
    // a source are serialized behind its lease — so two back-to-back deploys of the same
    // source are contention this test has no reason to create.
    const upload = await createUpload();
    await pollDeploymentToStatus(
      await startDeploy({ sourceId, uploadId: upload.uploadId, definitionSyncId, levels: [[ownerServiceId], [otherServiceId]] }),
      "deployed",
    );

    const hostname = `${ownerServiceId}.verified.test`;
    const ownerAdd = await niceBackendFetch(`/api/v1/deployments/services/${ownerServiceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname, is_primary: true },
    });
    expect(ownerAdd.status).toBe(201);

    const otherAdd = await niceBackendFetch(`/api/v1/deployments/services/${otherServiceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname },
    });
    expect(otherAdd.status).toBe(400);
    expect(JSON.stringify(otherAdd.body)).toContain("already added to another service");

    // Reading the domain is a pure read on the runtime, so the owner still holds the
    // certificate afterwards and its public URL is unchanged.
    const ownerGet = await niceBackendFetch(`/api/v1/deployments/services/${ownerServiceId}/domains/${hostname}`, { accessType: "admin" });
    expect(ownerGet.status).toBe(200);
    expect((ownerGet.body as any).verified).toBe(true);
    const ownerService = await niceBackendFetch(`/api/v1/deployments/services/${ownerServiceId}`, { accessType: "admin" });
    expect((ownerService.body as any).url).toBe(`https://${hostname}`);
    const otherService = await niceBackendFetch(`/api/v1/deployments/services/${otherServiceId}`, { accessType: "admin" });
    expect((otherService.body as any).url).toBeNull();
  });

  it("uses the database reservation as the arbiter for concurrent same-project domain adds", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const firstServiceId = uniqueServiceId("race-a");
    const secondServiceId = uniqueServiceId("race-b");
    const { syncId: definitionSyncId, sourceId } = await syncServices({
      [firstServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
      [secondServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
    });
    // One deployment ships both services: GCP mutations of a source are serialized behind
    // its lease, so racing two deploys of the SAME source would only test that lease. The
    // race under test is the one below, between two domain adds.
    const upload = await createUpload();
    await pollDeploymentToStatus(
      await startDeploy({ sourceId, uploadId: upload.uploadId, definitionSyncId, levels: [[firstServiceId], [secondServiceId]] }),
      "deployed",
    );

    const hostname = `race-${randomUUID().slice(0, 8)}.verified.test`;
    const [firstAdd, secondAdd] = await Promise.all([
      niceBackendFetch(`/api/v1/deployments/services/${firstServiceId}/domains`, {
        method: "POST", accessType: "admin", body: { hostname },
      }),
      niceBackendFetch(`/api/v1/deployments/services/${secondServiceId}/domains`, {
        method: "POST", accessType: "admin", body: { hostname },
      }),
    ]);
    expect([firstAdd.status, secondAdd.status].sort((first, second) => first - second)).toEqual([201, 400]);

    const winner = firstAdd.status === 201 ? firstServiceId : secondServiceId;
    const loser = winner === firstServiceId ? secondServiceId : firstServiceId;
    const winnerService = await niceBackendFetch(`/api/v1/deployments/services/${winner}`, { accessType: "admin" });
    const loserService = await niceBackendFetch(`/api/v1/deployments/services/${loser}`, { accessType: "admin" });
    expect((winnerService.body as any).url).toBe(`https://${hostname}`);
    expect((loserService.body as any).url).toBeNull();
  });

  it("refuses a domain on a service whose ports cannot hold one", async ({ expect }) => {
    await Project.createAndSwitch();

    // No HTTP port: a domain terminates TLS and routes HTTP, so there is nothing to route to.
    const tcpOnlyId = uniqueServiceId("tcponly");
    await syncServices({ [tcpOnlyId]: { type: "serverless", ports: { 5432: { protocol: "tcp" } }, env: {} } });
    const tcpAdd = await niceBackendFetch(`/api/v1/deployments/services/${tcpOnlyId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname: `${tcpOnlyId}.verified.test` },
    });
    expect(tcpAdd.status).toBe(400);
    expect(JSON.stringify(tcpAdd.body)).toContain("http");

    // A PRIVATE service with an HTTP port and a TCP sibling. The sync is legal —
    // nothing is public — but attaching a domain allocates public IPs, and the
    // runtime's proxy serves every declared port on every address the app holds,
    // which would put the 5432 on the internet.
    const siblingId = uniqueServiceId("sibling");
    await syncServices({ [siblingId]: { type: "serverless", ports: { 3000: { protocol: "http" }, 5432: { protocol: "tcp" } }, env: {} } });
    const siblingAdd = await niceBackendFetch(`/api/v1/deployments/services/${siblingId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname: `${siblingId}.verified.test` },
    });
    expect(siblingAdd.status).toBe(400);
    expect(JSON.stringify(siblingAdd.body)).toContain("it is private and declares more than one port");
  });

  it("refuses to re-sync a domain-holding service into a port list that cannot hold one", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("resynced");
    const { sourceId } = await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } });
    const addResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname: `${serviceId}.verified.test` },
    });
    expect(addResponse.status).toBe(201);

    // Adding the sibling port later must be refused too, or the rule enforced at attach time
    // could be walked around by attaching first and re-syncing after.
    const resync = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: sourceId, services: { [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" }, 5432: { protocol: "tcp" } }, env: {} } } },
    });
    expect(resync.status).toBe(400);
    expect(JSON.stringify(resync.body)).toContain("custom domain");
  });

  it("keeps domains as rows before the first deploy", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("undeployed");
    await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } });
    const addResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains`, {
      method: "POST",
      accessType: "admin",
      body: { hostname: `${serviceId}.verified.test` },
    });
    expect(addResponse.status).toBe(201);
    expect((addResponse.body as any).verified).toBe(false);
    const getResponse = await niceBackendFetch(`/api/v1/deployments/services/${serviceId}/domains/${serviceId}.verified.test`, { accessType: "admin" });
    expect((getResponse.body as any).pending_first_deploy).toBe(true);
  });
});

describe("deployments of a whole deployment source", () => {
  it("builds once and rolls out every service in dependency order", { timeout: 180_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const apiServiceId = uniqueServiceId("api");
    const webServiceId = uniqueServiceId("web");
    // web reads the API's private URL, so it applies after the API — one deploy,
    // one build, two services.
    const { syncId, sourceId } = await syncServices({
      [apiServiceId]: { type: "serverless", ports: { 8080: { protocol: "http" } }, env: {} },
      [webServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { API_URL: { type: "connection", value: `${apiServiceId}.url:8080` } } },
    });
    const { uploadId } = await createUpload();
    const deploymentId = await startDeploy({
      sourceId,
      uploadId,
      definitionSyncId: syncId,
      levels: [[apiServiceId], [webServiceId]],
    });
    const deployment = await pollDeploymentToStatus(deploymentId, "deployed");

    expect(deployment.deployment_source_id).toBe(sourceId);
    expect(deployment.has_build_logs).toBe(true);
    // Reported in apply order, which is the order a reader wants progress in.
    expect(deployment.services.map((service: any) => service.service_id)).toEqual([apiServiceId, webServiceId]);
    expect(deployment.services.every((service: any) => service.status === "deployed")).toBe(true);

    // Both are actually running, and web got the API's private Cloud Run URI.
    const apiCloudRun = (await findMockCloudRun(apiServiceId)).service;
    const webCloudRun = (await findMockCloudRun(webServiceId)).service;
    expect(cloudRunEnv(webCloudRun).API_URL).toBe(apiCloudRun.uri);

    // ONE build log covering both services: they shared a builder machine.
    const logs = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}/logs`, { accessType: "admin" });
    expect(logs.status).toBe(200);
    expect(String(logs.body)).toContain(apiServiceId);
    expect(String(logs.body)).toContain(webServiceId);
  });

  it("fails the whole deployment when the build fails, and ships nothing", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const goodServiceId = uniqueServiceId("good");
    const badServiceId = uniqueServiceId("bad");
    // The mock builder fails the build when any target declares this var — which
    // is what a real builder does too: one machine builds them all, so the first
    // failure ends the run.
    const { syncId, sourceId } = await syncServices({
      [goodServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
      [badServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: { MARSHAL_MOCK_FAIL_BUILD: { value: "1" } } },
    });
    const { uploadId } = await createUpload();
    const deployment = await pollDeploymentToStatus(
      await startDeploy({ sourceId, uploadId, definitionSyncId: syncId, levels: [[goodServiceId], [badServiceId]] }),
      "failed",
    );
    expect(String(deployment.error)).toContain("mock build failed");
    // Nothing was applied — not even the target that would have built fine.
    expect(deployment.services.every((service: any) => service.status === "skipped")).toBe(true);
  });

  it("refuses a service id another deployment source already owns", async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("shared");
    const { sourceId } = await syncServices({ [serviceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } }, "frontend-repo");
    expect(sourceId).toBe("frontend-repo");

    // A second deploy file claiming the same id would otherwise overwrite the
    // first one's definition on every deploy, with neither author able to see why.
    const conflicting = await niceBackendFetch("/api/v1/deployments/services", {
      method: "PUT",
      accessType: "admin",
      body: { version: GCP_VERSION, source_id: "backend-repo", services: { [serviceId]: { type: "serverless", ports: { 4000: { protocol: "http" } }, env: {} } } },
    });
    expect(conflicting.status).toBe(409);
    expect(JSON.stringify(conflicting.body)).toContain("frontend-repo");
  });

  it("removes a service the deploy file no longer declares, keeping its disk", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitchOnPaidPlan();
    const keptServiceId = uniqueServiceId("kept");
    const droppedServiceId = uniqueServiceId("dropped");
    const { syncId, sourceId } = await syncServices({
      [keptServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} },
      [droppedServiceId]: { type: "server", min_instances: 0, max_instances: 1, ports: { 5432: { protocol: "tcp" } }, env: {}, persistent_volumes: { data: { path: "/data", size_gb: 1 } } },
    });
    const { uploadId } = await createUpload();
    await pollDeploymentToStatus(
      await startDeploy({ sourceId, uploadId, definitionSyncId: syncId, levels: [[keptServiceId], [droppedServiceId]] }),
      "deployed",
    );

    // The same source syncs again without the second service.
    const resync = await syncServices({ [keptServiceId]: { type: "serverless", ports: { 3000: { protocol: "http" } }, env: {} } }, sourceId);
    expect(resync.removedServiceIds).toEqual([droppedServiceId]);

    const gone = await niceBackendFetch(`/api/v1/deployments/services/${droppedServiceId}`, { accessType: "admin" });
    expect(gone.status).toBe(404);
    const kept = await niceBackendFetch(`/api/v1/deployments/services/${keptServiceId}`, { accessType: "admin" });
    expect(kept.status).toBe(200);
  });

  it("keeps the first conclusion's timestamp when concluded again", { timeout: 120_000 }, async ({ expect }) => {
    await Project.createAndSwitch();
    const serviceId = uniqueServiceId("conclude");
    const deploymentId = await deployOneService(serviceId);

    const first = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}/conclude`, {
      method: "POST", accessType: "admin", body: {},
    });
    expect(first.status).toBe(200);
    const second = await niceBackendFetch(`/api/v1/deployments/deployments/${deploymentId}/conclude`, {
      method: "POST", accessType: "admin", body: {},
    });
    // Idempotent: a retried CLI request must not stretch the recorded duration.
    expect(second.status).toBe(200);
    expect((second.body as any).finished_at_millis).toBe((first.body as any).finished_at_millis);
  });

  it("404s on a deployment that doesn't exist", async ({ expect }) => {
    await Project.createAndSwitch();
    const response = await niceBackendFetch(`/api/v1/deployments/deployments/${randomUUID()}/conclude`, {
      method: "POST", accessType: "admin", body: {},
    });
    expect(response.status).toBe(404);
  });
});
