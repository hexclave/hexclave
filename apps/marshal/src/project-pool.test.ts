import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reapProjectPool, stepProjectPool, tenantProjectForNamespace } from "./project-pool.js";
import type { TenantProject, TenantProjectManager } from "./gcp/projects.js";
import type { PoolProjectEntry, PoolProjectState, ReconciliationLease } from "./types.js";

// The store is faked at the module boundary, exactly like reconciliation-lock.test.ts: the
// bucket CAS semantics (If-None-Match create, If-Match replace) are what the pool's arbitration
// AND its crash-resumability rely on, so the fake reproduces them rather than mocking outcomes.
// The reconciliation lease rides on the same fake, so the tick lease under test is the real one.
type Stored = { etag: string, value: unknown };

let objects: Map<string, Stored>;
let etagCounter: number;
let assignments: Map<string, string>;
let projectPoolSize: number;
let activeManager: TenantProjectManager;
// Set to a state to make the NEXT write that leaves it vanish — the bucket's view of a Vercel
// freeze, which is what every resume point has to survive.
let freezeLeaving: PoolProjectState | null;

// What the fake Google Cloud has actually been asked to do, so a resumed step can be checked
// for the thing that matters: did the freeze cause a SECOND project, or a lost one?
let gcp: {
  projects: Map<string, { number: string, billed: boolean, apis: string | null, iam: boolean }>,
  created: string[],
  deleted: string[],
  billingReady: Set<string>,
  apisDone: Set<string>,
  batchEnableCalls: number,
  recordExistedAtCreate: boolean[],
};

function put(key: string, value: unknown, condition: { ifNoneMatch?: true, ifMatch?: string }): string | null {
  const existing = objects.get(key);
  if (condition.ifNoneMatch === true && existing !== undefined) return null;
  if (condition.ifMatch !== undefined && existing?.etag !== condition.ifMatch) return null;
  const etag = `etag-${++etagCounter}`;
  objects.set(key, { etag, value });
  return etag;
}

function poolKey(projectId: string): string {
  return `gcp-project-pool/${projectId}.json`;
}

function poolEntry(projectId: string): PoolProjectEntry | undefined {
  return objects.get(poolKey(projectId))?.value as PoolProjectEntry | undefined;
}

function poolEntries(): [string, PoolProjectEntry][] {
  return [...objects]
    .filter(([key]) => key.startsWith("gcp-project-pool/"))
    .map(([key, stored]) => [key.slice("gcp-project-pool/".length, -".json".length), stored.value as PoolProjectEntry]);
}

function readyIds(): string[] {
  return poolEntries().filter(([, entry]) => entry.state === "ready").map(([projectId]) => projectId);
}

// A pool entry as the state machine would have written it. Tests that only care about the claim
// path spell out `state` and let the rest default, exactly as the parser does for legacy entries.
function entry(state: PoolProjectState, overrides: Partial<PoolProjectEntry> = {}): PoolProjectEntry {
  return {
    state,
    created_at_millis: Date.now(),
    state_since_millis: Date.now(),
    attempts: 0,
    last_error: null,
    operation_name: null,
    project_number: "123456789",
    ns: null,
    ...overrides,
  };
}

vi.mock("./store.js", () => ({
  readTenantProjectAssignment: vi.fn(async (ns: string) => assignments.get(ns) ?? null),
  assignTenantProject: vi.fn(async (ns: string, projectId: string) => {
    if (!assignments.has(ns)) assignments.set(ns, projectId);
    return assignments.get(ns)!;
  }),
  listPoolProjects: vi.fn(async () => poolEntries().map(([projectId, value]) => ({ projectId, entry: value }))),
  readPoolProject: vi.fn(async (projectId: string) => {
    const stored = objects.get(poolKey(projectId));
    return stored === undefined ? null : { etag: stored.etag, value: stored.value as PoolProjectEntry };
  }),
  createPoolProject: vi.fn(async (projectId: string, value: PoolProjectEntry) => put(poolKey(projectId), value, { ifNoneMatch: true }) !== null),
  updatePoolProject: vi.fn(async (projectId: string, value: PoolProjectEntry, etag: string) => {
    if (freezeLeaving !== null && poolEntry(projectId)?.state === freezeLeaving) {
      freezeLeaving = null;
      throw new Error("simulated sandbox freeze");
    }
    return put(poolKey(projectId), value, { ifMatch: etag }) !== null;
  }),
  deletePoolProject: vi.fn(async (projectId: string, etag: string) => {
    if (objects.get(poolKey(projectId))?.etag !== etag) return false;
    objects.delete(poolKey(projectId));
    return true;
  }),
  claimPoolProject: vi.fn(async (projectId: string, ns: string) => {
    const stored = objects.get(poolKey(projectId));
    const value = stored?.value as PoolProjectEntry | undefined;
    if (stored === undefined || value?.state !== "ready") return false;
    return put(poolKey(projectId), { ...value, state: "claimed", state_since_millis: Date.now(), ns }, { ifMatch: stored.etag }) !== null;
  }),
  unclaimPoolProject: vi.fn(async (projectId: string, ns: string) => {
    const stored = objects.get(poolKey(projectId));
    const value = stored?.value as PoolProjectEntry | undefined;
    if (stored === undefined || value?.state !== "claimed" || value.ns !== ns) return false;
    return put(poolKey(projectId), { ...value, state: "ready", state_since_millis: Date.now(), ns: null }, { ifMatch: stored.etag }) !== null;
  }),
  readPoolCreationLedgerVersioned: vi.fn(async () => {
    const stored = objects.get("ledger");
    return stored === undefined
      ? { etag: null, createdAtMillis: [] }
      : { etag: stored.etag, createdAtMillis: (stored.value as { created_at_millis: number[] }).created_at_millis };
  }),
  // The CAS is the point of this ledger, so the fake enforces it rather than accepting writes.
  writePoolCreationLedgerConditionally: vi.fn(async (created: number[], etag: string | null) => {
    const condition = etag === null ? { ifNoneMatch: true as const } : { ifMatch: etag };
    return put("ledger", { created_at_millis: created }, condition) !== null;
  }),
  readReconciliationLease: vi.fn(async (ns: string, key: string) => {
    const stored = objects.get(`lease/${ns}/${key}`);
    return stored === undefined ? null : { etag: stored.etag, value: stored.value as ReconciliationLease };
  }),
  createReconciliationLease: vi.fn(async (ns: string, key: string, lease: ReconciliationLease) => put(`lease/${ns}/${key}`, lease, { ifNoneMatch: true })),
  replaceReconciliationLease: vi.fn(async (ns: string, key: string, lease: ReconciliationLease, etag: string) => put(`lease/${ns}/${key}`, lease, { ifMatch: etag })),
  releaseReconciliationLease: vi.fn(async (ns: string, key: string, etag: string) => {
    if (objects.get(`lease/${ns}/${key}`)?.etag !== etag) return false;
    objects.delete(`lease/${ns}/${key}`);
    return true;
  }),
}));

// The provisioning steps, modelled as the real ones behave: idempotent, and each one observable
// so a resumed tick can be checked for duplicated work rather than merely for a green result.
function fakeManager(): TenantProjectManager {
  const describe_ = (projectId: string): TenantProject => ({ projectId, projectNumber: "123456789" });
  return {
    describeActiveProject: vi.fn(async (projectId: string) => describe_(projectId)),
    ensureForNamespace: vi.fn(async (ns: string) => {
      const projectId = `hxc-tena-dev-${ns.replace(/[^a-z0-9]/g, "").slice(0, 16)}`;
      gcp.created.push(projectId);
      return describe_(projectId);
    }),
    ensureProjectActive: vi.fn(async (projectId: string) => {
      // The invariant the whole rewrite exists for: nothing may reach Resource Manager before
      // the bucket knows the id. A false here is an invisible billed project.
      gcp.recordExistedAtCreate.push(objects.has(poolKey(projectId)));
      if (!gcp.projects.has(projectId)) {
        gcp.projects.set(projectId, { number: "123456789", billed: false, apis: null, iam: false });
        gcp.created.push(projectId);
      }
      return "123456789";
    }),
    attachBillingOnce: vi.fn(async (projectId: string) => {
      if (!gcp.billingReady.has(projectId)) return false;
      gcp.projects.get(projectId)!.billed = true;
      return true;
    }),
    beginEnableApis: vi.fn(async (projectId: string) => {
      const name = `operations/enable-${++gcp.batchEnableCalls}`;
      gcp.projects.get(projectId)!.apis = name;
      return name;
    }),
    isEnableApisDone: vi.fn(async (operationName: string) => gcp.apisDone.has(operationName)),
    ensureProjectIam: vi.fn(async (projectId: string) => {
      gcp.projects.get(projectId)!.iam = true;
    }),
    deleteDisposableProject: vi.fn(async (projectId: string) => {
      gcp.projects.delete(projectId);
      gcp.deleted.push(projectId);
    }),
  } as unknown as TenantProjectManager;
}

vi.mock("./gcp/manager.js", () => ({
  createTenantProjectManager: vi.fn(() => activeManager),
}));

vi.mock("./config.js", () => ({
  getConfig: vi.fn(() => ({ envId: "dev", gcp: { projectPoolSize, projectPrefix: "hxc-tena" } })),
}));

function seed(initials: { pool?: [string, PoolProjectEntry][], assignments?: [string, string][], size?: number } = {}): void {
  objects = new Map();
  etagCounter = 0;
  for (const [projectId, value] of initials.pool ?? []) put(poolKey(projectId), value, { ifNoneMatch: true });
  assignments = new Map(initials.assignments ?? []);
  projectPoolSize = initials.size ?? 0;
  freezeLeaving = null;
  gcp = { projects: new Map(), created: [], deleted: [], billingReady: new Set(), apisDone: new Set(), batchEnableCalls: 0, recordExistedAtCreate: [] };
  // A seeded pool entry means the GCP project exists: the record is only ever written by the
  // advancer, which writes it before it creates anything and never removes it afterwards.
  for (const [projectId, value] of initials.pool ?? []) {
    gcp.projects.set(projectId, { number: "123456789", billed: value.state !== "creating", apis: value.operation_name, iam: value.state === "ready" });
  }
  activeManager = fakeManager();
}

// Everything GCP answers instantly, so one tick provisions a project end to end.
function gcpIsInstant(): void {
  vi.mocked(activeManager.attachBillingOnce).mockImplementation(async (projectId: string) => {
    gcp.projects.get(projectId)!.billed = true;
    return true;
  });
  vi.mocked(activeManager.isEnableApisDone).mockResolvedValue(true);
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claiming from the pool", () => {
  it("reuses an existing assignment without touching the pool", async () => {
    seed({ assignments: [["ns-1", "hxc-tena-assigned"]], pool: [["hxc-tena-ready", entry("ready")]] });
    const manager = fakeManager();

    const project = await tenantProjectForNamespace("ns-1", manager);

    expect(project.projectId).toBe("hxc-tena-assigned");
    expect(vi.mocked(manager.describeActiveProject)).toHaveBeenCalledOnce();
    expect(poolEntry("hxc-tena-ready")?.state).toBe("ready");
  });

  it("claims a ready pooled project and assigns it", async () => {
    seed({ pool: [["hxc-tena-ready", entry("ready")]], size: 1 });
    const manager = fakeManager();

    const project = await tenantProjectForNamespace("ns-1", manager);

    expect(project.projectId).toBe("hxc-tena-ready");
    expect(poolEntry("hxc-tena-ready")).toMatchObject({ state: "claimed", ns: "ns-1" });
    expect(assignments.get("ns-1")).toBe("hxc-tena-ready");
    // Claiming no longer starts provisioning of its own: the cron advancer owns that, because
    // work started here would be frozen with the response that started it.
    expect(gcp.created).toEqual([]);
  });

  it("falls back to lazy deterministic provisioning when the pool is empty, and still records the assignment", async () => {
    seed({ pool: [], size: 0 });
    const manager = fakeManager();

    const project = await tenantProjectForNamespace("ns-1", manager);

    expect(project.projectId).toBe("hxc-tena-dev-ns1");
    expect(vi.mocked(manager.ensureForNamespace)).toHaveBeenCalledWith("ns-1");
    expect(assignments.get("ns-1")).toBe("hxc-tena-dev-ns1");
  });

  it("uses and describes an assignment that wins while lazy provisioning is in flight", async () => {
    seed({ pool: [], size: 0 });
    const manager = fakeManager();
    vi.mocked((await import("./store.js")).assignTenantProject).mockImplementationOnce(async () => {
      assignments.set("ns-1", "hxc-tena-pooled-winner");
      return "hxc-tena-pooled-winner";
    });

    const project = await tenantProjectForNamespace("ns-1", manager);

    expect(project.projectId).toBe("hxc-tena-pooled-winner");
    expect(manager.deleteDisposableProject).toHaveBeenCalledWith("hxc-tena-dev-ns1");
    expect(manager.describeActiveProject).toHaveBeenCalledWith("hxc-tena-pooled-winner");
  });

  it("puts a claim back when it lost the assignment race for its own namespace", async () => {
    seed({ pool: [["hxc-tena-ready", entry("ready")], ["hxc-tena-winner", entry("ready")]] });
    const manager = fakeManager();
    // A concurrent request for the same namespace claimed the other project and won the
    // assignment race in between the caller's claim and its own assignment write.
    vi.mocked((await import("./store.js")).assignTenantProject).mockImplementationOnce(async () => {
      assignments.set("ns-1", "hxc-tena-winner");
      put(poolKey("hxc-tena-winner"), entry("claimed", { ns: "ns-1" }), { ifMatch: objects.get(poolKey("hxc-tena-winner"))!.etag });
      return "hxc-tena-winner";
    });

    const project = await tenantProjectForNamespace("ns-1", manager);

    expect(project.projectId).toBe("hxc-tena-winner");
    expect(poolEntry("hxc-tena-ready")?.state).toBe("ready");
    expect(poolEntry("hxc-tena-winner")).toMatchObject({ state: "claimed", ns: "ns-1" });
  });

  it("skips a project that is still being provisioned", async () => {
    seed({ pool: [["hxc-tena-half", entry("billing_pending")]], size: 1 });
    const manager = fakeManager();

    const project = await tenantProjectForNamespace("ns-1", manager);

    // The lazy fallback, not the half-provisioned project: nothing but `ready` is claimable.
    expect(project.projectId).toBe("hxc-tena-dev-ns1");
    expect(poolEntry("hxc-tena-half")?.state).toBe("billing_pending");
  });
});

describe("the advancer tick", () => {
  it("records the project id BEFORE anything is created in GCP", async () => {
    seed({ size: 1 });
    gcpIsInstant();

    await stepProjectPool();

    expect(gcp.created.length).toBe(1);
    // The record-then-create ordering is the whole reason a freeze can no longer leak a
    // billed project: whatever exists in GCP is always already in the bucket.
    expect(gcp.recordExistedAtCreate).toEqual([true]);
    expect(poolEntries().map(([projectId]) => projectId)).toEqual(gcp.created);
  });

  it("runs until blocked rather than one step per tick", async () => {
    seed({ size: 1 });
    gcpIsInstant();

    const result = await stepProjectPool();

    // create → billing → apis (one park to record the operation) → poll → iam → ready, in two
    // ticks, not five: only a genuine GCP wait yields.
    expect(result.skipped).toBe(false);
    expect(readyIds().length).toBe(0);
    expect(poolEntries()[0][1].state).toBe("apis_pending");

    await stepProjectPool();

    expect(readyIds().length).toBe(1);
    expect(gcp.batchEnableCalls).toBe(1);
  });

  it("parks in billing_pending on Cloud Billing's precondition answer and resumes when it clears", async () => {
    seed({ size: 1 });
    vi.mocked(activeManager.isEnableApisDone).mockResolvedValue(true);

    await stepProjectPool();
    const [projectId, parked] = poolEntries()[0];
    expect(parked.state).toBe("billing_pending");
    // Waiting is not failing: a park must not burn the error budget that condemns a project.
    expect(parked.attempts).toBe(0);

    await stepProjectPool();
    expect(poolEntry(projectId)?.state).toBe("billing_pending");
    expect(vi.mocked(activeManager.attachBillingOnce)).toHaveBeenCalledTimes(2);

    gcp.billingReady.add(projectId);
    await stepProjectPool();
    await stepProjectPool();

    expect(poolEntry(projectId)?.state).toBe("ready");
    expect(gcp.created).toEqual([projectId]);
  });

  it("stores the API enablement operation and polls that same one on a later tick", async () => {
    seed({ size: 1 });
    vi.mocked(activeManager.attachBillingOnce).mockResolvedValue(true);

    await stepProjectPool();
    const [projectId, parked] = poolEntries()[0];
    expect(parked).toMatchObject({ state: "apis_pending", operation_name: "operations/enable-1" });

    await stepProjectPool();
    expect(poolEntry(projectId)?.state).toBe("apis_pending");
    // The recorded operation is polled; a second batchEnable is never started.
    expect(gcp.batchEnableCalls).toBe(1);

    gcp.apisDone.add("operations/enable-1");
    await stepProjectPool();

    expect(poolEntry(projectId)?.state).toBe("ready");
    expect(gcp.batchEnableCalls).toBe(1);
  });

  it("advances every in-flight project in one tick, not one per tick", async () => {
    seed({ pool: [["hxc-tena-a", entry("iam_pending")], ["hxc-tena-b", entry("iam_pending")]], size: 2 });
    gcpIsInstant();

    await stepProjectPool();

    expect(readyIds().sort()).toEqual(["hxc-tena-a", "hxc-tena-b"]);
  });
});

describe("resuming after a freeze", () => {
  // Vercel freezes the sandbox at response time, so a tick can stop between ANY GCP call and
  // the record of it. Each case freezes on the write that leaves one state and asserts the next
  // tick re-enters the same step and still converges on exactly one ready project.
  const transitions: PoolProjectState[] = ["creating", "billing_pending", "apis_pending", "iam_pending"];

  it.each(transitions)("resumes a project frozen while leaving %s", async (frozenState) => {
    seed({ size: 1 });
    gcpIsInstant();
    gcp.apisDone.add("operations/enable-1");
    freezeLeaving = frozenState;

    // The frozen tick, then ticks until it settles.
    for (let i = 0; i < 6; i++) await stepProjectPool();

    expect(freezeLeaving).toBe(null);
    expect(readyIds().length).toBe(1);
    // The step was re-entered, not duplicated: still exactly one GCP project.
    expect(gcp.created.length).toBe(1);
    expect(gcp.projects.get(gcp.created[0])).toMatchObject({ billed: true, iam: true });
  });

  it("leaves nothing behind when it freezes between the record and the create", async () => {
    seed({ size: 1 });
    gcpIsInstant();
    const store = await import("./store.js");
    vi.mocked(store.createPoolProject).mockRejectedValueOnce(new Error("simulated sandbox freeze"));

    await stepProjectPool();

    // The record is written first, so a freeze here is the harmless order: nothing was created.
    expect(gcp.created).toEqual([]);
    expect(poolEntries()).toEqual([]);
  });
});

describe("tick concurrency", () => {
  it("no-ops the loser instead of throwing when two ticks overlap", async () => {
    seed({ size: 2 });
    gcpIsInstant();

    const [first, second] = await Promise.all([stepProjectPool(), stepProjectPool()]);

    // Crons are at-least-once, so overlap is normal traffic, not an error to report.
    const skipped = [first, second].filter((result) => result.skipped);
    expect(skipped.length).toBe(1);
    // The winner did the whole tick's work; the loser did none of it, so the pool is not
    // double-filled.
    expect(gcp.created.length).toBe(2);
  });

  it("no-ops a reap that overlaps a step", async () => {
    seed({ pool: [["hxc-tena-a", entry("ready")]], size: 1 });
    gcpIsInstant();

    const [, reaped] = await Promise.all([stepProjectPool(), reapProjectPool()]);

    expect(reaped.skipped).toBe(true);
  });
});

describe("caps on project creation", () => {
  it("never has more than three projects in flight at once", async () => {
    seed({ size: 10 });

    await stepProjectPool();

    // Ten wanted, three allowed: nothing else bounds creation now that the in-process
    // singleton is gone, and GCP holds org quota on a deleted project for thirty days.
    expect(gcp.created.length).toBe(3);
    expect(poolEntries().length).toBe(3);
  });

  it("stops creating once the hourly budget is spent, and resumes in the next window", async () => {
    seed({ size: 10 });
    // Four ticks would create twelve at three apiece; the budget stops it at ten.
    for (let i = 0; i < 4; i++) {
      for (const [projectId] of poolEntries()) objects.delete(poolKey(projectId));
      await stepProjectPool();
    }

    expect(gcp.created.length).toBe(10);

    // An hour later the window has rolled over.
    const ledger = objects.get("ledger")!.value as { created_at_millis: number[] };
    ledger.created_at_millis = ledger.created_at_millis.map((at) => at - 61 * 60 * 1000);
    for (const [projectId] of poolEntries()) objects.delete(poolKey(projectId));
    await stepProjectPool();

    expect(gcp.created.length).toBe(13);
  });

  it("counts in-flight projects towards the pool size so a slow tick does not over-create", async () => {
    seed({ pool: [["hxc-tena-a", entry("ready")], ["hxc-tena-b", entry("billing_pending")]], size: 3 });

    await stepProjectPool();

    // 1 ready + 1 in flight + 1 new = the configured size. The in-flight one is not re-created.
    expect(gcp.created.length).toBe(1);
  });
});

describe("the reaper", () => {
  it("condemns and deletes a project stuck in flight past the stall window", async () => {
    const longAgo = Date.now() - 46 * 60 * 1000;
    seed({ pool: [["hxc-tena-stuck", entry("billing_pending", { created_at_millis: longAgo, state_since_millis: longAgo })]] });

    const result = await reapProjectPool();

    expect(result).toMatchObject({ condemned: 1, deleted: 1 });
    expect(gcp.deleted).toEqual(["hxc-tena-stuck"]);
    expect(poolEntries()).toEqual([]);
  });

  it("leaves an in-flight project alone while it is merely slow", async () => {
    const recently = Date.now() - 5 * 60 * 1000;
    seed({ pool: [["hxc-tena-slow", entry("billing_pending", { created_at_millis: recently, state_since_millis: recently })]] });

    const result = await reapProjectPool();

    expect(result).toMatchObject({ condemned: 0, deleted: 0 });
    expect(gcp.deleted).toEqual([]);
    expect(poolEntry("hxc-tena-slow")?.state).toBe("billing_pending");
  });

  it("restores a claim that its namespace never took, once past the grace", async () => {
    const stranded = Date.now() - 16 * 60 * 1000;
    seed({ pool: [["hxc-tena-stranded", entry("claimed", { ns: "ns-1", state_since_millis: stranded })]] });

    const result = await reapProjectPool();

    // The claim write landed and the assignment write did not — a freeze in between the two.
    expect(result).toMatchObject({ restored: 1 });
    expect(poolEntry("hxc-tena-stranded")).toMatchObject({ state: "ready", ns: null });
  });

  it("does not race a claim that is still in between its two writes", async () => {
    seed({ pool: [["hxc-tena-fresh", entry("claimed", { ns: "ns-1", state_since_millis: Date.now() })]] });

    const result = await reapProjectPool();

    expect(result).toMatchObject({ restored: 0 });
    expect(poolEntry("hxc-tena-fresh")).toMatchObject({ state: "claimed", ns: "ns-1" });
  });

  it("forgets a claimed entry whose namespace points back at it", async () => {
    seed({
      pool: [["hxc-tena-taken", entry("claimed", { ns: "ns-1" })], ["hxc-tena-ready", entry("ready")]],
      assignments: [["ns-1", "hxc-tena-taken"]],
    });

    const result = await reapProjectPool();

    // tenants/<ns>.json is the authority once it points here, so the pool entry is residue.
    // Dropping it is what bounds listPoolProjects() — a LIST plus a GET per entry, on the
    // deploy path — by pool size rather than by lifetime tenant count.
    expect(result).toMatchObject({ forgotten: 1, deleted: 0 });
    expect(poolEntries().map(([projectId]) => projectId)).toEqual(["hxc-tena-ready"]);
    expect(gcp.deleted).toEqual([]);
  });

  it("deletes the GCP project of an entry condemned by repeated failure", async () => {
    seed({ pool: [["hxc-tena-bad", entry("condemned")]] });

    const result = await reapProjectPool();

    expect(result).toMatchObject({ deleted: 1 });
    expect(gcp.deleted).toEqual(["hxc-tena-bad"]);
    expect(poolEntries()).toEqual([]);
  });

  it("keeps reaping after one entry's deletion fails", async () => {
    const longAgo = Date.now() - 46 * 60 * 1000;
    seed({
      pool: [
        ["hxc-tena-undeletable", entry("condemned", { created_at_millis: longAgo, state_since_millis: longAgo })],
        ["hxc-tena-deletable", entry("condemned", { created_at_millis: longAgo, state_since_millis: longAgo })],
        ["hxc-tena-stranded", entry("claimed", { ns: "ns-1", state_since_millis: longAgo })],
      ],
    });
    vi.mocked(activeManager.deleteDisposableProject).mockImplementation(async (projectId: string) => {
      if (projectId === "hxc-tena-undeletable") throw new Error("project is in a state that rejects deletion");
      gcp.deleted.push(projectId);
    });

    const result = await reapProjectPool();

    // Without per-entry isolation a single wedged project aborts the loop on every hourly
    // tick, so the entries behind it keep billing and stranded claims are never restored.
    expect(result).toMatchObject({ deleted: 1, restored: 1 });
    expect(gcp.deleted).toEqual(["hxc-tena-deletable"]);
    expect(poolEntry("hxc-tena-undeletable")?.state).toBe("condemned");
    expect(poolEntry("hxc-tena-stranded")).toMatchObject({ state: "ready", ns: null });
  });

  it("condemns a project whose step keeps failing instead of retrying it forever", async () => {
    seed({ size: 1 });
    vi.mocked(activeManager.attachBillingOnce).mockRejectedValue(new Error("billing account not found"));

    for (let i = 0; i < 6; i++) await stepProjectPool();

    const [projectId, condemned] = poolEntries()[0];
    expect(condemned).toMatchObject({ state: "condemned", last_error: "billing account not found" });

    await reapProjectPool();
    expect(gcp.deleted).toEqual([projectId]);
  });
});
