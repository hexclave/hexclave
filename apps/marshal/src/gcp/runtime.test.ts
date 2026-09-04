import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationLeaseGuard } from "../reconciliation-lock.js";
import type { ServiceKind, StoredSpec } from "../types.js";

const fakes = vi.hoisted(() => ({
  cloudRunApply: vi.fn(),
  cloudRunDelete: vi.fn(),
  cloudRunGet: vi.fn(),
  computeApply: vi.fn(),
  computeDelete: vi.fn(),
  computeGet: vi.fn(),
  ensureDisk: vi.fn(),
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config.js")>(),
  getConfig: () => ({ envId: "test" }),
}));

vi.mock("./context.js", () => ({
  tenantContext: async () => ({
    cloudRun: { apply: fakes.cloudRunApply, delete: fakes.cloudRunDelete, get: fakes.cloudRunGet },
    compute: { applyInstance: fakes.computeApply, deleteInstance: fakes.computeDelete, ensureDisk: fakes.ensureDisk, getInstance: fakes.computeGet },
  }),
}));

import { applyRuntimeService, deleteRuntimeService, observeRuntimeService } from "./runtime.js";

const lease: ReconciliationLeaseGuard = { assertOwned: async () => {} };

function stored(type: ServiceKind, isPublic: boolean): StoredSpec {
  return {
    ns: "tenant",
    key: "web",
    revision: "revision-1",
    created_at_millis: 1,
    updated_at_millis: 1,
    last_apply_error: null,
    spec: {
      config: { type, public: isPublic, min_instances: 0, max_instances: 1, ports: { "8080": { protocol: "http" } } },
      source: { image: "docker.io/library/nginx:latest" },
      env: {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.cloudRunApply.mockResolvedValue({ ready: true });
  fakes.computeApply.mockResolvedValue({ name: "server", internalIp: "10.128.0.2" });
  fakes.cloudRunGet.mockResolvedValue(null);
  fakes.computeGet.mockResolvedValue(null);
});

describe("GCP runtime transitions", () => {
  it("removes a former server and gateway before applying a serverless service", async () => {
    await applyRuntimeService(stored("serverless", false), "docker.io/library/nginx:latest", {}, lease, false);
    expect(fakes.cloudRunDelete).toHaveBeenCalledOnce();
    expect(fakes.computeDelete).toHaveBeenCalledOnce();
    expect(fakes.cloudRunApply).toHaveBeenCalledWith(expect.objectContaining({
      public: false,
      port: 8080,
    }));
  });

  it("removes both a former serverless service and a stale gateway for a private server", async () => {
    await applyRuntimeService(stored("server", false), "docker.io/library/nginx:latest", {}, lease, false);
    expect(fakes.cloudRunDelete).toHaveBeenCalledTimes(2);
    expect(fakes.computeApply).toHaveBeenCalledOnce();
    expect(fakes.cloudRunApply).not.toHaveBeenCalled();
  });

  it("keeps the gateway of a private server that owns a custom domain", async () => {
    // A custom domain routes through this same gateway, so deleting it here left the claim
    // intact and its route gone — the domain stayed broken until someone re-attached it.
    await applyRuntimeService(stored("server", false), "docker.io/library/nginx:latest", {}, lease, true);
    expect(fakes.cloudRunApply).toHaveBeenCalledWith(expect.objectContaining({ public: true, port: 8080 }));
    // Only the former serverless service is removed; the gateway is applied, not deleted.
    expect(fakes.cloudRunDelete).toHaveBeenCalledOnce();
  });

  it("deletes every ephemeral runtime shape while preserving disks", async () => {
    await deleteRuntimeService(stored("server", true), "tenant", "web", lease);
    expect(fakes.cloudRunDelete).toHaveBeenCalledTimes(2);
    expect(fakes.computeDelete).toHaveBeenCalledOnce();
    expect(fakes.ensureDisk).not.toHaveBeenCalled();
  });

  it("does not publish an internal URL until GCP assigns the VM an IP", async () => {
    fakes.computeGet.mockResolvedValue({
      name: "server",
      status: "RUNNING",
      internalIp: null,
      imageRef: null,
      revision: "revision-1",
    });

    await expect(observeRuntimeService(stored("server", false))).resolves.toMatchObject({
      hostname: null,
      internalUrl: null,
    });
  });
});
