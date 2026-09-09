import { describe, expect, it, vi } from "vitest";

// Parking swaps WHAT a service runs and nothing else. These tests pin the two halves of
// that: the spec the provider is applied with (which is never stored), and the park state
// that is (which is what unparking reads back). The store and the provider are mocked
// because neither the bucket nor Fly is what is under test here.

type StoredSpecShape = {
  ns: string,
  key: string,
  spec: Record<string, unknown>,
  revision: string,
  created_at_millis: number,
  updated_at_millis: number,
  last_apply_error: string | null,
  parked?: { reason: string, since_millis: number } | null,
};

const storedSpec = vi.hoisted(() => ({ current: null as StoredSpecShape | null }));
const writes = vi.hoisted(() => [] as StoredSpecShape[]);
const applies = vi.hoisted(() => [] as { spec: Record<string, unknown>, image: string, env: Record<string, string> }[]);
const applyFails = vi.hoisted(() => ({ value: false }));

vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  getConfig: () => ({ envId: "test", parkedImage: "docker.io/bgodil/deployment-parked-page:2", dataEncryptionRootKey: Buffer.alloc(32, 7) }),
}));

vi.mock("./provider.js", () => ({
  providerForNamespace: async () => ({
    kind: "fly",
    applyService: async (stored: StoredSpecShape, image: string, env: Record<string, string>) => {
      if (applyFails.value) throw new Error("fly said no");
      applies.push({ spec: stored.spec, image, env });
      return image;
    },
    observeService: async () => ({
      exists: true, ready: false, instances: 0, revision: "revision-1", atTarget: true, error: null,
      hostname: "web.internal", platformUrl: null, internalUrl: null, privateHost: null,
    }),
    hostnamePlaceholder: () => "web.internal",
    domains: { statesFor: async () => [] },
  }),
}));

vi.mock("./reconciliation-lock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./reconciliation-lock.js")>(),
  withReconciliationLease: async (_ns: string, _key: string, body: (lease: unknown) => unknown) => {
    return await body({ assertOwned: async () => {} });
  },
}));

vi.mock("./store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./store.js")>(),
  readSpec: async () => storedSpec.current,
  readSpecVersioned: async () => storedSpec.current === null ? null : { value: storedSpec.current, etag: "etag" },
  writeSpec: async (next: StoredSpecShape) => {
    writes.push(structuredClone(next));
    storedSpec.current = structuredClone(next);
    return "etag";
  },
  listDomainClaimsForService: async () => [],
  readDomainClaimVersioned: async () => null,
}));

import {
  parkService,
  parkStateFromStored,
  parkedEnvFor,
  parkedPortFor,
  parkedSpecFor,
  unparkService,
  validateParkReason,
  validateServiceSpec,
} from "./services.js";

const TENANT_IMAGE = "registry.fly.io/hxc-t-ns-we-abc@sha256:" + "a".repeat(64);

function spec(overrides: Record<string, unknown> = {}) {
  return validateServiceSpec({
    config: { type: "serverless", min_instances: 0, max_instances: 1, public: true, ports: { 3000: { protocol: "http" } }, ...overrides },
    source: { image: TENANT_IMAGE },
    env: { SECRET: { value: "hunter2" } },
  });
}

function reset(stored: Partial<StoredSpecShape> = {}) {
  writes.length = 0;
  applies.length = 0;
  applyFails.value = false;
  storedSpec.current = {
    ns: "namespace",
    key: "web",
    spec: spec() as unknown as Record<string, unknown>,
    revision: "revision-1",
    created_at_millis: 1,
    updated_at_millis: 1,
    last_apply_error: null,
    parked: null,
    ...stored,
  };
}

describe("the spec a parked service is applied with", () => {
  it("unpins every machine so a parked service can sleep", () => {
    const parked = parkedSpecFor(spec({ min_instances: 2, max_instances: 3 }), "fly");
    expect(parked.config.min_instances).toBe(0);
  });

  it("presents a Fly server as serverless, which is the only way Fly lets it stop", () => {
    // Fly pins by TYPE: a `server` is one machine that never autostops, so a parked
    // one would burn a machine around the clock to serve a static page.
    const parked = parkedSpecFor(spec({ type: "server", min_instances: 1, max_instances: 1 }), "fly");
    expect(parked.config.type).toBe("serverless");
  });

  it("leaves a GCP server's type alone, because there the type picks the resource kind", () => {
    // Rewriting it would build a Cloud Run service and orphan the VM still running
    // the tenant's image.
    const parked = parkedSpecFor(spec({ type: "server", min_instances: 1, max_instances: 1 }), "gcp");
    expect(parked.config.type).toBe("server");
  });

  it("drops the start command, which would replace the parked page's entrypoint", () => {
    const parked = parkedSpecFor(spec({ start_command: "node server.js" }), "fly");
    expect(parked.config.start_command).toBeUndefined();
  });

  it("keeps ports, max_instances, volumes and public so the machine is updated in place", () => {
    const original = spec({
      type: "server",
      min_instances: 1,
      max_instances: 1,
      persistent_volumes: { data: { path: "/data", size_gb: 1 } },
    });
    const parked = parkedSpecFor(original, "fly");
    expect(parked.config.ports).toEqual(original.config.ports);
    expect(parked.config.max_instances).toBe(original.config.max_instances);
    expect(parked.config.persistent_volumes).toEqual(original.config.persistent_volumes);
    expect(parked.config.public).toBe(original.config.public);
  });

  it("keeps naming the tenant's image, which is what unparking applies", () => {
    expect(parkedSpecFor(spec(), "fly").source).toEqual({ image: TENANT_IMAGE });
  });
});

describe("the parked page's environment", () => {
  it("listens on the port Fly maps 80/443 onto", () => {
    expect(parkedPortFor(spec({ ports: { 8080: { protocol: "http" }, 3000: { protocol: "http" } } }))).toBe(3000);
    expect(parkedEnvFor(spec(), "free_plan_24h").PORT).toBe("3000");
  });

  it("falls back to a declared port when there is no standard-ports holder", () => {
    expect(parkedPortFor(spec({ public: false, ports: { 5432: { protocol: "tcp" } } }))).toBe(5432);
  });

  it("carries nothing of the tenant's own env", () => {
    // The page has no use for the service's secrets, so they have no business in
    // a machine config that only serves a static page.
    expect(parkedEnvFor(spec(), "free_plan_24h")).toEqual({ PORT: "3000", HEXCLAVE_PARKED_REASON: "free_plan_24h" });
  });
});

describe("park reasons", () => {
  it("accepts the reason the sweeper sends", () => {
    expect(validateParkReason("free_plan_24h")).toBe("free_plan_24h");
  });

  it("refuses anything that would not survive being an env var value or a header", () => {
    for (const bad of ["", "Free Plan", "free-plan", "1free", "a".repeat(65), null, 42]) {
      expect(() => validateParkReason(bad)).toThrow();
    }
  });
});

describe("a spec written before parking existed", () => {
  it("reads as running rather than as unknown", () => {
    expect(parkStateFromStored({ last_apply_error: null } as never)).toBeNull();
  });
});

describe("parkService", () => {
  it("applies the parked page and records why", async () => {
    reset();
    const state = await parkService("namespace", "web", "free_plan_24h");
    expect(applies).toHaveLength(1);
    expect(applies[0].image).toBe("docker.io/bgodil/deployment-parked-page:2");
    expect(applies[0].env).toEqual({ PORT: "3000", HEXCLAVE_PARKED_REASON: "free_plan_24h" });
    expect(state.status).toBe("parked");
    expect(state.parked?.reason).toBe("free_plan_24h");
  });

  it("writes the park state before it applies, so a crash cannot hide a stopped service", async () => {
    reset();
    applyFails.value = true;
    const state = await parkService("namespace", "web", "free_plan_24h");
    expect(writes[0].parked?.reason).toBe("free_plan_24h");
    // The apply failed, so the tenant's image is still running: reporting this as
    // "parked" would claim a stop that never happened.
    expect(state.status).not.toBe("parked");
    expect(state.error).toContain("park failed");
  });

  it("does nothing when the service is already parked for that reason", async () => {
    reset({ parked: { reason: "free_plan_24h", since_millis: 1000 } });
    await parkService("namespace", "web", "free_plan_24h");
    expect(applies).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("retries the apply when the last one failed, rather than trusting the stored state", async () => {
    reset({ parked: { reason: "free_plan_24h", since_millis: 1000 }, last_apply_error: "park failed: fly said no" });
    await parkService("namespace", "web", "free_plan_24h");
    expect(applies).toHaveLength(1);
  });

  it("keeps the original parked-since when only the reason changes", async () => {
    reset({ parked: { reason: "free_plan_24h", since_millis: 1000 } });
    const state = await parkService("namespace", "web", "platform_pause");
    expect(state.parked).toEqual({ reason: "platform_pause", since_millis: 1000 });
  });

  it("refuses a service that does not exist", async () => {
    reset();
    storedSpec.current = null;
    await expect(parkService("namespace", "web", "free_plan_24h")).rejects.toThrow();
  });
});

describe("unparkService", () => {
  it("puts the tenant's own image back and clears the park state", async () => {
    reset({ parked: { reason: "free_plan_24h", since_millis: 1000 } });
    const state = await unparkService("namespace", "web");
    expect(applies).toHaveLength(1);
    expect(applies[0].image).toBe(TENANT_IMAGE);
    expect(applies[0].env).toEqual({ SECRET: "hunter2" });
    expect(state.parked).toBeNull();
    expect(state.status).not.toBe("parked");
  });

  it("leaves a service that is not parked completely alone", async () => {
    reset();
    await unparkService("namespace", "web");
    expect(applies).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
});

describe("deploying a parked service", () => {
  it("unparks it: a deploy is the author asking for their own code back", async () => {
    reset({ parked: { reason: "free_plan_24h", since_millis: 1000 } });
    const { applyServiceSpec } = await import("./services.js");
    const result = await applyServiceSpec("namespace", "web", spec());
    expect(result.state.parked).toBeNull();
    expect(applies[0].image).toBe(TENANT_IMAGE);
  });
});
