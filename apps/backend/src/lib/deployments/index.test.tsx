import { describe, expect, it } from "vitest";
import type { MarshalDeployment } from "./marshal-client";
import { autoInjectedEnvVars, definitionFromServiceRow, deploymentToApiShape, effectiveMinInstances, marshalSpecForDefinition } from "./index";

const baseRow = {
  serviceId: "api",
  type: "serverless",
  isPublic: false, ports: { "3000": { protocol: "http" } },
  minInstances: 0,
  maxInstances: 1,
  rootDirectory: null,
  dockerfilePath: null,
  // Null = built from source, which is what every row here is.
  image: null as string | null,
  // Null = the base decides the build, and the image decides what starts.
  buildCommand: null as string | null,
  startCommand: null as string | null,
  // Null = the type's default size, which is what every row predating the
  // column reads as.
  memoryMb: null as number | null,
  env: [] as [string, { value: string }][],
};

describe("stored deployment environment", () => {
  it("preserves __proto__ from the entry-array database representation", () => {
    const definition = definitionFromServiceRow({ ...baseRow, env: [["__proto__", { value: "safe" }]] });
    expect(Object.getOwnPropertyDescriptor(definition.env, "__proto__")).toBeDefined();
    expect(definition.env.__proto__).toEqual({ type: undefined, value: "safe", key: undefined });
  });

  it("continues to read the object database representation", () => {
    const definition = definitionFromServiceRow({
      ...baseRow,
      isPublic: true, ports: { "3000": { protocol: "http" } },
      env: { SAFE: { value: "legacy" } },
    });
    expect(definition.env.SAFE).toEqual({ type: undefined, value: "legacy", key: undefined });
    // The ports come back in the shape they were written in — the record the
    // deploy file declared, not a translation of it. Publicness is NOT in there:
    // it is the service's, and comes off its own column.
    expect(definition.ports).toEqual({ "3000": { protocol: "http" } });
    expect(definition.public).toBe(true);
  });
});

describe("stored deployment volumes", () => {
  const serverRow = { ...baseRow, type: "server" };

  it("reads an attached volume row into the definition under its id", () => {
    const definition = definitionFromServiceRow(serverRow, { volumeId: "uploads", path: "/data", sizeGb: 10 });
    expect(definition.persistent_volumes).toEqual({ uploads: { path: "/data", size_gb: 10 } });
  });

  it("reports no volume when the service mounts none", () => {
    expect(definitionFromServiceRow(serverRow, null).persistent_volumes).toBeUndefined();
  });

  it("treats an UNATTACHED volume row as no volume", () => {
    // The disk belongs to the deployment source and outlives the service that
    // mounted it, so a row with no mount path is not part of any definition —
    // mounting it at a guessed path would be worse than ignoring it.
    expect(definitionFromServiceRow(serverRow, { volumeId: "uploads", path: null, sizeGb: 10 }).persistent_volumes).toBeUndefined();
  });

  it("passes the volume through to the Marshal spec, and omits it entirely when absent", () => {
    const withVolume = marshalSpecForDefinition(
      definitionFromServiceRow(serverRow, { volumeId: "uploads", path: "/data", sizeGb: 10 }),
      {},
    );
    expect(withVolume.config).toEqual({
      type: "server",
      // A server holds one instance; min 0 is what makes it suspend when idle.
      min_instances: 0,
      max_instances: 1,
      public: false,
      ports: { "3000": { protocol: "http" } },
      persistent_volumes: { uploads: { path: "/data", size_gb: 10 } },
    });
    const withoutVolume = marshalSpecForDefinition(definitionFromServiceRow(serverRow, null), {});
    expect("persistent_volumes" in withoutVolume.config).toBe(false);
  });
});

describe("instance bounds", () => {
  it("defaults a server to always-on and a serverless to scale-to-zero", () => {
    // The default is what the plan gate has to read: a `server` with nothing
    // written keeps an instance up, which is exactly the thing Free cannot do.
    expect(effectiveMinInstances(definitionFromServiceRow({ ...baseRow, type: "server", minInstances: null }))).toBe(1);
    expect(effectiveMinInstances(definitionFromServiceRow({ ...baseRow, type: "server", minInstances: 0 }))).toBe(0);
    expect(effectiveMinInstances(definitionFromServiceRow({ ...baseRow, type: "serverless", minInstances: null }))).toBe(0);
    expect(effectiveMinInstances(definitionFromServiceRow({ ...baseRow, type: "serverless", minInstances: 2 }))).toBe(2);
  });

  it("keeps a serverless spec self-consistent when only a floor is written", () => {
    // max defaults to 1, which would be BELOW a floor of 2 — a spec the runtime
    // would reject after the upload has already been consumed.
    const spec = marshalSpecForDefinition(definitionFromServiceRow({ ...baseRow, minInstances: 2, maxInstances: null }), {});
    expect(spec.config).toMatchObject({ min_instances: 2, max_instances: 2 });
  });
});

describe("automatically injected env vars", () => {
  const injected = autoInjectedEnvVars({
    projectId: "proj-1",
    apiUrl: "https://api.hexclave.com",
    publishableClientKey: "pck_test",
    secretServerKey: "ssk_test",
  });

  it("gives the public values framework-prefixed copies", () => {
    // A framework that inlines values at build time only reads its own prefix,
    // so an unprefixed variable is invisible to the client bundle.
    for (const key of ["HEXCLAVE_PROJECT_ID", "NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "VITE_HEXCLAVE_PROJECT_ID"]) {
      expect(injected[key]).toEqual({ value: "proj-1", secret: false });
    }
    expect(injected.NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY).toEqual({ value: "pck_test", secret: false });
    expect(injected.VITE_HEXCLAVE_API_URL).toEqual({ value: "https://api.hexclave.com", secret: false });
  });

  it("never publishes the secret server key under a client-visible name", () => {
    // A prefixed name is a request to ship the value to the browser, which for
    // a server key is a credential leak rather than a convenience.
    expect(injected.HEXCLAVE_SECRET_SERVER_KEY).toEqual({ value: "ssk_test", secret: true });
    expect(Object.keys(injected).filter((key) => key.includes("SECRET_SERVER_KEY"))).toEqual(["HEXCLAVE_SECRET_SERVER_KEY"]);
  });
});

describe("deploymentToApiShape", () => {
  const deploymentRow = (overrides: Partial<Parameters<typeof deploymentToApiShape>[0]> = {}) => deploymentToApiShape({
    id: "dep-1",
    number: 7,
    status: "BUILDING",
    triggeredBy: "cli",
    createdAt: new Date(1000),
    finishedAt: null,
    error: null,
    marshalBuildId: "build-1",
    // A source build, which is what every row here is unless it says otherwise.
    hasBuildLogs: true,
    plannedServiceIds: ["web", "api"],
    services: { web: { status: "deployed", url: "https://web.example.com" } },
    sourceManifest: null,
    source: { sourceId: "backend" },
    ...overrides,
  });

  it("returns the source manifest on a full read and omits it on a summary", () => {
    // The manifest is per-deployment and the LIST endpoint is polled every few
    // seconds while a deploy is in flight; shipping every manifest in every page
    // of that poll costs far more than the listing itself, for a tab the reader
    // may never open.
    const manifest = { file_count: 1, total_bytes: 10, compressed_bytes: 4, entries: [{ path: "a.txt", bytes: 10 }] };
    expect(deploymentRow({ sourceManifest: manifest }).source_manifest).toEqual(manifest);
    expect(deploymentToApiShape({
      id: "dep-1", number: 7, status: "BUILDING", triggeredBy: "cli", createdAt: new Date(1000),
      finishedAt: null, error: null, marshalBuildId: "build-1", hasBuildLogs: true,
      plannedServiceIds: ["web"], services: {}, sourceManifest: manifest, source: { sourceId: "backend" },
    }, "summary").source_manifest).toBeNull();
  });

  it("reports no manifest for a row that never recorded one", () => {
    expect(deploymentRow().source_manifest).toBeNull();
    // A shape this server does not recognise loses the listing, not the deploy.
    expect(deploymentRow({ sourceManifest: { file_count: "many" } }).source_manifest).toBeNull();
  });

  it("offers build logs only when a build actually ran", () => {
    // A deployment whose every service ran an already-built image starts no
    // builder machine, so there is no log — and an affordance for an empty one
    // is worse than none.
    expect(deploymentRow().has_build_logs).toBe(true);
    expect(deploymentRow({ hasBuildLogs: false }).has_build_logs).toBe(false);
    // ...and neither is there one before the runtime has accepted the deployment.
    expect(deploymentRow({ marshalBuildId: null }).has_build_logs).toBe(false);
  });

  it("reports the deployment source and every planned service, outcome or not", () => {
    const shape = deploymentRow();
    expect(shape.deployment_source_id).toBe("backend");
    expect(shape.status).toBe("building");
    // `api` has no outcome yet: it is still pending rather than missing from
    // the list, which is what lets the dashboard show what a deploy will ship.
    expect(shape.services).toEqual([
      { service_id: "web", status: "deployed", url: "https://web.example.com", revision: null, image: null, error: null },
      { service_id: "api", status: "pending", url: null, revision: null, image: null, error: null },
    ]);
  });

  it("offers build logs only once the runtime has accepted the deployment", () => {
    expect(deploymentRow().has_build_logs).toBe(true);
    expect(deploymentRow({ marshalBuildId: null }).has_build_logs).toBe(false);
  });

  it("keeps an outcome whose service is missing from the plan", () => {
    // A hand-edited row: showing the outcome beats silently dropping it.
    const shape = deploymentRow({ plannedServiceIds: [], services: { ghost: { status: "failed", error: "boom" } } });
    expect(shape.services).toEqual([{ service_id: "ghost", status: "failed", url: null, revision: null, image: null, error: "boom" }]);
  });

  it("survives a plannedServiceIds value that is not a string array", () => {
    expect(deploymentRow({ plannedServiceIds: { nonsense: true } }).services).toEqual([
      { service_id: "web", status: "deployed", url: "https://web.example.com", revision: null, image: null, error: null },
    ]);
  });
});

describe("marshal deployment shape", () => {
  it("is what the client type promises", () => {
    // A compile-time assertion with a runtime body: the fields below are the
    // ones outcomesFromMarshal and marshalDeploymentStatus read, so a rename in
    // the runtime's contract has to fail here rather than at deploy time.
    const deployment: MarshalDeployment = {
      id: "build-1",
      source_id: "backend",
      status: "deploying",
      has_logs: true,
      error: null,
      started_at_millis: 1,
      finished_at_millis: null,
      services: [{ service_key: "web", status: "deployed", revision: "rev1", url: null, image: "registry.fly.io/web@sha256:abc", error: null }],
    };
    expect(deployment.services[0].service_key).toBe("web");
  });
});
