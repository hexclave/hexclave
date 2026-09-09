import { describe, expect, it, vi, beforeEach } from "vitest";

// The two things a wrong answer here would do to a customer: stop a service that
// should be running, or leave one running that the plan says should be stopped.
// The first is the dangerous one, so most of what is pinned below is a direction
// of failure rather than a happy path.

const planIds = vi.hoisted(() => new Map<string, string | null>());
const planLimitsEnforced = vi.hoisted(() => ({ value: true }));
const marshalConfigured = vi.hoisted(() => ({ value: true }));
const platformConfig = vi.hoisted(() => ({ value: { deploymentsEnabled: true, freePlanParkingEnabled: true, freePlanParkAfterHours: 24 } }));
const serviceRows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));
const marshalCalls = vi.hoisted(() => [] as { call: "park" | "unpark", ns: string, serviceId: string, reason?: string }[]);
const rowWrites = vi.hoisted(() => [] as { serviceId: string, data: Record<string, unknown> }[]);
const parkThrows = vi.hoisted(() => ({ value: false }));
// What Marshal REPORTS after each call. It answers 200 with a failed state rather
// than throwing when a provider refuses an apply, so these are the difference
// between a park that happened and one that only returned.
const parkStatus = vi.hoisted(() => ({ value: "parked" as string }));
const unparkStatus = vi.hoisted(() => ({ value: "running" as string }));

vi.mock("@/prisma-client", () => ({
  globalPrismaClient: {
    deploymentService: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const wantsParked = "parkedReason" in args.where;
        if (wantsParked) return serviceRows.value.filter((row) => row.parkedAt != null);
        // The park path's second read: every running service of ONE project,
        // grandfathered rows included, which is what makes the window a question
        // about the whole project rather than the row that raised it.
        if ("tenancyId" in args.where) {
          return serviceRows.value.filter((row) => row.tenancyId === args.where.tenancyId && row.parkedAt == null);
        }
        // Mirrors the real query's grandfathering filter, so a test row with no
        // runningSince is invisible to the park sweep exactly as it would be.
        return serviceRows.value.filter((row) => row.parkedAt == null && row.runningSince != null);
      }),
    },
  },
  getPrismaClientForTenancy: async () => ({
    deploymentService: {
      updateMany: async (args: { where: { serviceId: string }, data: Record<string, unknown> }) => {
        rowWrites.push({ serviceId: args.where.serviceId, data: args.data });
        return { count: 1 };
      },
    },
  }),
}));

vi.mock("@/lib/tenancies", () => ({
  getTenancy: async (tenancyId: string) => planIds.has(tenancyId)
    ? { id: tenancyId, project: { id: `project-${tenancyId}`, ownerTeamId: "team" } }
    : null,
}));

vi.mock("@/lib/plan-entitlements", () => ({
  arePlanLimitsEnforced: () => planLimitsEnforced.value,
  getPlanIdForProjectOrNull: async (project: { id: string }) => planIds.get(project.id.replace("project-", "")) ?? null,
}));

vi.mock("./marshal-client", () => ({
  getMarshalDeploymentsConfigOrNull: () => marshalConfigured.value ? { baseUrl: "http://marshal", apiKey: "key" } : null,
  getMarshalClientOrThrow: () => ({
    parkService: async (ns: string, serviceId: string, reason: string) => {
      if (parkThrows.value) throw new Error("marshal said no");
      marshalCalls.push({ call: "park", ns, serviceId, reason });
      // A park whose apply failed keeps the park state and reports a status that
      // is not "parked" — see serviceStateWith in apps/marshal/src/services.ts.
      return { status: parkStatus.value, parked: { reason, since_millis: 1000 }, error: null };
    },
    unparkService: async (ns: string, serviceId: string) => {
      marshalCalls.push({ call: "unpark", ns, serviceId });
      // The apply clears the park state before it runs, so a failed unpark
      // reports a null `parked` too: only the status separates the two.
      return { status: unparkStatus.value, parked: null, error: null };
    },
  }),
}));

vi.mock("./platform-config", () => ({
  getDeploymentsPlatformConfig: async () => platformConfig.value,
}));

import { FREE_PLAN_PARK_REASON, planShouldBeParked, projectWindowClosed, servicesPastFreePlanLimit, sweepFreePlanParking, windowStartedAt } from "./parking";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

function row(overrides: Record<string, unknown> = {}) {
  return {
    tenancyId: "tenancy-1",
    serviceId: "web",
    runningSince: hoursAgo(48),
    provisionedAt: hoursAgo(72),
    parkedAt: null,
    parkedReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  planIds.clear();
  planIds.set("tenancy-1", "free");
  planLimitsEnforced.value = true;
  marshalConfigured.value = true;
  parkThrows.value = false;
  parkStatus.value = "parked";
  unparkStatus.value = "running";
  platformConfig.value = { deploymentsEnabled: true, freePlanParkingEnabled: true, freePlanParkAfterHours: 24 };
  serviceRows.value = [];
  marshalCalls.length = 0;
  rowWrites.length = 0;
});

describe("when a service's window started", () => {
  it("measures from the last deploy", () => {
    expect(windowStartedAt({ runningSince: hoursAgo(2) })).toEqual(hoursAgo(2));
  });

  it("gives no window to a service deployed before the limit existed", () => {
    // The grandfathering, and the reason nothing is backfilled: a null here means
    // "not subject to the limit", never "unknown, assume the worst". Reading it
    // the other way would stop every long-running Free deployment on the first
    // sweep after this shipped.
    expect(windowStartedAt({ runningSince: null })).toBeNull();
  });
});

describe("servicesPastFreePlanLimit", () => {
  it("keeps a service that has not reached the limit", () => {
    expect(servicesPastFreePlanLimit([{ runningSince: hoursAgo(23) }], { now: NOW, parkAfterHours: 24 })).toEqual([]);
  });

  it("takes a service exactly at the limit", () => {
    expect(servicesPastFreePlanLimit([{ runningSince: hoursAgo(24) }], { now: NOW, parkAfterHours: 24 })).toHaveLength(1);
  });

  it("honours a limit an operator has widened", () => {
    expect(servicesPastFreePlanLimit([{ runningSince: hoursAgo(30) }], { now: NOW, parkAfterHours: 48 })).toEqual([]);
  });

  it("never takes a grandfathered service, however long it has been running", () => {
    expect(servicesPastFreePlanLimit([{ runningSince: null }], { now: NOW, parkAfterHours: 24 })).toEqual([]);
  });
});

describe("projectWindowClosed", () => {
  it("is closed only once every service is past the window", () => {
    expect(projectWindowClosed([{ runningSince: hoursAgo(48) }, { runningSince: hoursAgo(2) }], { now: NOW, parkAfterHours: 24 })).toBe(false);
    expect(projectWindowClosed([{ runningSince: hoursAgo(48) }, { runningSince: hoursAgo(25) }], { now: NOW, parkAfterHours: 24 })).toBe(true);
  });

  it("stays open while any service is grandfathered", () => {
    expect(projectWindowClosed([{ runningSince: hoursAgo(48) }, { runningSince: null }], { now: NOW, parkAfterHours: 24 })).toBe(false);
  });

  it("is open for a project with nothing running", () => {
    // Never "vacuously closed": an empty list would otherwise park a project that
    // has no services to park.
    expect(projectWindowClosed([], { now: NOW, parkAfterHours: 24 })).toBe(false);
  });
});

describe("which plans are parked", () => {
  it("parks the Free plan and nothing else", () => {
    expect(planShouldBeParked("free")).toBe(true);
    expect(planShouldBeParked("team")).toBe(false);
    expect(planShouldBeParked("growth")).toBe(false);
  });

  it("fails open on an unreadable plan", () => {
    // Null is self-hosted, limits disabled, or the billing store being down. A
    // billing outage must not stop customers' running services.
    expect(planShouldBeParked(null)).toBe(false);
  });
});

describe("the sweep's gates", () => {
  it("parks nothing while parking is switched off", async () => {
    platformConfig.value = { ...platformConfig.value, freePlanParkingEnabled: false };
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ skipped: "parking_paused", parked: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("still unparks an upgraded project while parking is switched off", async () => {
    // The switch pauses ENFORCEMENT, never the way back out of it. Gating both
    // directions on it would leave a project that upgraded while it was off
    // stopped until it happened to redeploy — which is the opposite of what the
    // Deploy Admin page says the switch does.
    platformConfig.value = { ...platformConfig.value, freePlanParkingEnabled: false };
    planIds.set("tenancy-1", "team");
    serviceRows.value = [row({ parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ skipped: "parking_paused", unparked: 1 });
    expect(marshalCalls).toEqual([{ call: "unpark", ns: "tenancy-1", serviceId: "web" }]);
  });

  it("does nothing on an instance that does not enforce plans", async () => {
    planLimitsEnforced.value = false;
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ skipped: "plan_limits_not_enforced" });
    expect(marshalCalls).toEqual([]);
  });

  it("does nothing when no runtime is configured", async () => {
    marshalConfigured.value = false;
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ skipped: "runtime_not_configured" });
    expect(marshalCalls).toEqual([]);
  });
});

describe("parking a Free-plan project", () => {
  it("parks a service past the limit and records why", async () => {
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ skipped: null, parked: 1, failed: 0 });
    expect(marshalCalls).toEqual([{ call: "park", ns: "tenancy-1", serviceId: "web", reason: FREE_PLAN_PARK_REASON }]);
    expect(rowWrites[0].data).toMatchObject({ parkedReason: FREE_PLAN_PARK_REASON });
  });

  it("leaves a paid project alone", async () => {
    planIds.set("tenancy-1", "team");
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("leaves a project alone when its plan cannot be read", async () => {
    planIds.set("tenancy-1", null);
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("parks every service of the project, not just the expired one", async () => {
    // Services reference each other through connection env vars, so a project
    // parked by halves leaves a live service with a dead dependency.
    serviceRows.value = [row({ serviceId: "web" }), row({ serviceId: "api", runningSince: hoursAgo(26) })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 2 });
  });

  it("waits for the project's most recent deploy, not its oldest", async () => {
    // The half-parked project this module exists to avoid, reached the other way:
    // "web" is well past the window on its own, but its sibling was redeployed
    // twenty minutes ago. Deciding per service would stop "web" and leave "api"
    // running against a dead dependency.
    serviceRows.value = [row({ serviceId: "web" }), row({ serviceId: "api", runningSince: hoursAgo(0.3) })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0, failed: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("parks the project once the newest of its services is past the window too", async () => {
    serviceRows.value = [row({ serviceId: "web" }), row({ serviceId: "api", runningSince: hoursAgo(25) })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 2 });
  });

  it("leaves the whole project alone while one of its services is grandfathered", async () => {
    // A grandfathered service has no window at all, so the project has none:
    // parking it would stop a service that was promised it would be left alone,
    // and parking only its sibling is the half-parked project again. The exempt
    // set drains per project, on the redeploy that gives that service a window.
    serviceRows.value = [row({ serviceId: "web" }), row({ serviceId: "api", runningSince: null })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0, failed: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("ignores an already-parked sibling when deciding, so a half-parked project converges", async () => {
    // A service parked by an earlier tick has no window left to expire. Counting
    // it would deadlock the project: its running sibling could never be parked.
    serviceRows.value = [
      row({ serviceId: "web", parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON }),
      row({ serviceId: "api" }),
    ];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 1 });
    expect(marshalCalls).toEqual([{ call: "park", ns: "tenancy-1", serviceId: "api", reason: FREE_PLAN_PARK_REASON }]);
  });

  it("does not record a park the runtime refused", async () => {
    // The other order would read as a stopped service in the dashboard and make
    // the next tick skip it, leaving it running forever.
    parkThrows.value = true;
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0, failed: 1 });
    expect(rowWrites).toEqual([]);
  });

  it("does not record a park Marshal accepted but did not apply", async () => {
    // Marshal answers 200 with a failed state rather than throwing when a
    // provider refuses the apply. Recording that as parked would be permanent:
    // the candidate query keys off parkedAt, so the row would leave the sweep for
    // good with the tenant's app still serving.
    parkStatus.value = "degraded";
    serviceRows.value = [row()];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0, failed: 1 });
    expect(rowWrites).toEqual([]);
  });

  it("never parks a service deployed before the limit existed", async () => {
    // Grandfathering, end to end: the row is a Free-plan service that has been
    // running for days, and it is left alone because it has no window.
    serviceRows.value = [row({ runningSince: null, provisionedAt: hoursAgo(500) })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0, failed: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("parks it once it redeploys, which is what sets its window", async () => {
    serviceRows.value = [row({ runningSince: hoursAgo(25), provisionedAt: hoursAgo(500) })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 1 });
  });

  it("skips a tenancy that no longer exists", async () => {
    serviceRows.value = [row({ tenancyId: "deleted-tenancy" })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ parked: 0, failed: 0 });
    expect(marshalCalls).toEqual([]);
  });
});

describe("unparking after an upgrade", () => {
  it("gives a project its services back once it is no longer on the Free plan", async () => {
    planIds.set("tenancy-1", "team");
    serviceRows.value = [row({ parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ unparked: 1 });
    expect(marshalCalls).toEqual([{ call: "unpark", ns: "tenancy-1", serviceId: "web" }]);
    expect(rowWrites[0].data).toMatchObject({ parkedAt: null, parkedReason: null });
  });

  it("keeps a still-Free project parked", async () => {
    serviceRows.value = [row({ parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ unparked: 0 });
    expect(marshalCalls).toEqual([]);
  });

  it("unparks when the plan cannot be read, which is the fail-open direction", async () => {
    planIds.set("tenancy-1", null);
    serviceRows.value = [row({ parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ unparked: 1 });
  });

  it("does not record an unpark Marshal accepted but did not apply", async () => {
    // The mirror of the park case, and the one that costs a customer who has
    // already PAID: clearing parkedAt takes the row out of the unpark sweep, so a
    // failed unpark would leave the parked page serving indefinitely.
    planIds.set("tenancy-1", "team");
    unparkStatus.value = "failed";
    serviceRows.value = [row({ parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON })];
    await expect(sweepFreePlanParking({ now: NOW })).resolves.toMatchObject({ unparked: 0, failed: 1 });
    expect(rowWrites).toEqual([]);
  });

  it("restarts the window, so a later downgrade does not park it instantly", async () => {
    planIds.set("tenancy-1", "team");
    serviceRows.value = [row({ parkedAt: hoursAgo(3), parkedReason: FREE_PLAN_PARK_REASON })];
    await sweepFreePlanParking({ now: NOW });
    expect(rowWrites[0].data.runningSince).toBeInstanceOf(Date);
  });
});
