import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredDeployment, StoredSpec, LogLine } from "./types.js";
import type { ReconciliationLeaseGuard } from "./reconciliation-lock.js";

const state = vi.hoisted(() => {
  const value: {
    deployment: StoredDeployment | null,
    specs: Map<string, StoredSpec>,
    leases: Set<string>,
    events: string[],
    logGate: Promise<void> | null,
    rejectTransition: boolean,
    failApply: boolean,
    applyError: Error | null,
  } = { deployment: null, specs: new Map(), leases: new Set(), events: [], logGate: null, rejectTransition: false, failApply: false, applyError: null };
  return value;
});

vi.mock("./config.js", async (original) => ({
  ...await original<typeof import("./config.js")>(),
  getConfig: () => ({ envId: "test", webhookSecret: "test-secret", dataEncryptionRootKey: Buffer.alloc(32, 7) }),
}));
vi.mock("./store.js", async (original) => ({
  ...await original<typeof import("./store.js")>(),
  readDeployment: async () => state.deployment === null ? null : structuredClone(state.deployment),
  readDeploymentVersioned: async () => state.deployment === null ? null : { value: structuredClone(state.deployment), etag: "deployment-etag" },
  replaceDeployment: async (next: StoredDeployment) => {
    if (state.rejectTransition) return null;
    state.deployment = structuredClone(next);
    state.events.push(`deployment:${next.status}`);
    return "deployment-etag";
  },
  readSpec: async (_ns: string, key: string) => state.specs.get(key) ?? null,
  readSpecVersioned: async (_ns: string, key: string) => {
    const value = state.specs.get(key);
    return value === undefined ? null : { value: structuredClone(value), etag: "spec-etag" };
  },
  writeSpec: async (next: StoredSpec) => {
    state.specs.set(next.key, structuredClone(next));
    return "spec-etag";
  },
  listDomainClaimsForService: async () => [],
  writeDeploymentLog: async () => { state.events.push("logs:stored"); },
  deleteValidatedUpload: async () => { state.events.push("upload:deleted"); },
}));
vi.mock("./reconciliation-lock.js", async (original) => {
  const actual = await original<typeof import("./reconciliation-lock.js")>();
  return {
    ...actual,
    withReconciliationLease: async (_ns: string, key: string, action: (guard: ReconciliationLeaseGuard) => Promise<unknown>) => {
      if (state.leases.has(key)) throw new actual.ReconciliationLeaseLostError("lease busy");
      state.leases.add(key);
      try {
        return await action({
          assertOwned: async () => {
            expect(state.leases.has(key)).toBe(true);
          },
        });
      } finally {
        state.leases.delete(key);
      }
    },
  };
});
vi.mock("./provider.js", () => ({
  providerForNamespace: async () => ({
    kind: "fly",
    builtImageRef: (_deployment: StoredDeployment, key: string, digest: string) => `registry.example.com/${key}@${digest}`,
    buildRedactionValues: () => [],
    builderLogsDrain: async (): Promise<LogLine[]> => {
      expect(state.leases.size).toBe(0);
      state.events.push("logs:start");
      await state.logGate;
      return [{ at_millis: 1, stream: "stdout", instance: null, text: "build done" }];
    },
    deleteBuilder: async () => { state.events.push("builder:deleted"); },
    applyService: async (stored: StoredSpec, image: string) => {
      state.events.push(`apply:${stored.key}`);
      if (state.applyError !== null) throw state.applyError;
      if (state.failApply) throw new Error("simulated provider failure");
      return image;
    },
    observeService: async (stored: StoredSpec) => ({
      exists: !state.failApply, ready: !state.failApply, instances: state.failApply ? 0 : 1,
      revision: stored.revision, atTarget: true, error: null,
      hostname: "web.example.com", platformUrl: "https://web.example.com", internalUrl: null, privateHost: null,
    }),
    domains: { statesFor: async () => [] },
  }),
}));

import { MutationOutcomeUnknownError } from "./mutation-safety.js";
import { advanceDeployment, completeBuild } from "./services.js";

function deployment(keys = ["web"]): StoredDeployment {
  return {
    ns: "namespace", id: "01AAAAAAAAAAAAAAAAAAAAAAAA", source_id: "source", status: "building", has_logs: true,
    error: null, started_at_millis: 1, finished_at_millis: null,
    order: keys.map(key => [key]),
    targets: keys.map(key => ({ service_key: key, dockerfile_path: "Dockerfile", spec: {
      config: { type: "serverless", min_instances: 1, max_instances: 1, public: true, ports: { "80": { protocol: "http" } } }, env: {},
    } })),
    services: Object.fromEntries(keys.map(key => [key, { service_key: key, status: "building", revision: null, url: null, image: null, error: null }])),
    images: {}, builder_app: "builder", builder_machine_id: "machine", builder_memory_mb: 8192, upload_id: "upload",
  };
}
function complete(status: "succeeded" | "failed" = "succeeded", keys = ["web"]) {
  return completeBuild({ ns: "namespace", deploymentId: "01AAAAAAAAAAAAAAAAAAAAAAAA", status,
    metadataJson: JSON.stringify({ targets: Object.fromEntries(keys.map(key => [key, "sha256:" + "a".repeat(64)])) }), errorText: status === "failed" ? "build failed" : null });
}

beforeEach(() => {
  state.deployment = deployment();
  state.specs.clear();
  state.leases.clear();
  state.events.length = 0;
  state.logGate = null;
  state.rejectTransition = false;
  state.failApply = false;
  state.applyError = null;
});

describe("build completion rollout", () => {
  it("starts the runtime without a poll while logs remain blocked", async () => {
    const gate = Promise.withResolvers<void>();
    state.logGate = gate.promise;
    const completion = complete();
    try {
      await vi.waitFor(() => expect(state.events).toContain("apply:web"));
      await vi.waitFor(() => expect(state.deployment?.status).toBe("succeeded"));
      expect(state.events).not.toContain("builder:deleted");
      expect(state.events).not.toContain("logs:stored");
    } finally {
      gate.resolve();
      await completion;
    }
    expect(state.events).toContain("logs:stored");
    expect(state.events.at(-1)).toBe("builder:deleted");
  });

  it("waits for log archival before cleanup even when rollout has an unknown mutation outcome", async () => {
    const gate = Promise.withResolvers<void>();
    state.logGate = gate.promise;
    const failure = new MutationOutcomeUnknownError("provider connection closed", { cause: new Error("socket reset") });
    state.applyError = failure;
    const completion = complete();
    try {
      await vi.waitFor(() => expect(state.events).toContain("apply:web"));
      expect(state.events).not.toContain("builder:deleted");
    } finally {
      gate.resolve();
      await expect(completion).rejects.toBe(failure);
    }
    expect(state.events.indexOf("logs:stored")).toBeLessThan(state.events.indexOf("builder:deleted"));
  });

  it("does not let a concurrent duplicate delete the builder during log archival", async () => {
    const gate = Promise.withResolvers<void>();
    state.logGate = gate.promise;
    const completion = complete();
    try {
      await vi.waitFor(() => expect(state.deployment?.status).toBe("succeeded"));
      await complete();
      expect(state.events).not.toContain("builder:deleted");
    } finally {
      gate.resolve();
      await completion;
    }
    expect(state.events.filter(event => event === "builder:deleted")).toHaveLength(1);
  });

  it("does not apply again for duplicate completion notifications", async () => {
    await complete();
    await complete();
    expect(state.events.filter(event => event.startsWith("apply:"))).toEqual(["apply:web"]);
  });

  it.each(["failed", "missing-image"])("does not roll out a %s build", async (failure) => {
    await complete(failure === "failed" ? "failed" : "succeeded", []);
    expect(state.deployment?.status).toBe("failed");
    expect(state.events.some(event => event.startsWith("apply:"))).toBe(false);
    expect(state.events).toContain("logs:stored");
  });

  it("does not roll out a build whose conditional completion write lost", async () => {
    state.rejectTransition = true;
    await complete();
    expect(state.events.some(event => event.startsWith("apply:"))).toBe(false);
    expect(state.deployment?.status).toBe("building");
    expect(state.events).not.toContain("builder:deleted");
  });

  it("records a runtime failure instead of marking the deployment successful", async () => {
    state.failApply = true;
    await complete();
    expect(state.deployment?.status).toBe("failed");
    expect(state.deployment?.services.web.status).toBe("failed");
  });

  it("retains prebuilt images when completing a mixed deployment", async () => {
    const mixed = deployment(["api", "web"]);
    const prebuiltImage = "registry.example.com/api@sha256:" + "b".repeat(64);
    mixed.targets = mixed.targets.map(target => target.service_key === "api"
      ? { ...target, image: prebuiltImage, dockerfile_path: undefined }
      : target);
    mixed.images = { api: prebuiltImage };
    state.deployment = mixed;

    await complete("succeeded", ["web"]);
    expect(state.deployment.images).toEqual({
      api: prebuiltImage,
      web: "registry.example.com/web@sha256:" + "a".repeat(64),
    });
    expect(state.deployment.services.api.image).toBe(prebuiltImage);
    expect(state.deployment.status).toBe("deploying");
    await advanceDeployment("namespace", "01AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(state.deployment.status).toBe("succeeded");
  });

  it("starts only the first dependency service and lets a later poll finish the next", async () => {
    state.deployment = deployment(["api", "web"]);
    await complete("succeeded", ["api", "web"]);
    expect(state.events.filter(event => event.startsWith("apply:"))).toEqual(["apply:api"]);
    expect(state.deployment.status).toBe("deploying");
    await advanceDeployment("namespace", "01AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(state.events.filter(event => event.startsWith("apply:"))).toEqual(["apply:api", "apply:web"]);
    expect(state.deployment.status).toBe("succeeded");
  });
});
