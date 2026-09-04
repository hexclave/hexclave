// The pre-provisioned tenant project pool.
//
// Google's multi-tenant guidance (https://docs.cloud.google.com/run/docs/securing/multi-tenant)
// recommends assigning pre-created projects to tenants on demand, because creating a project,
// attaching billing (a brand-new project is briefly unknown to Cloud Billing), and enabling its
// APIs can take fifteen minutes — which blew every request budget in the deploy-start path.
// The pool moves ALL of that work off the request: a fully provisioned project is claimed from
// the bucket in two conditional PUTs.
//
// Provisioning is a CRON-DRIVEN RESUMABLE STATE MACHINE, not background work. It used to be
// fire-and-forget: a promise started at import time in src/vercel.ts and src/server.ts. On
// Vercel that is not background work at all — the sandbox is frozen the moment the response is
// written, so the pool never refilled in production, and each frozen attempt left behind a
// billed GCP project that nothing in the bucket knew about and therefore nothing could reap.
// Every wait is now a state persisted in the bucket, and a cron advances it (see
// apps/marshal/vercel.json). The lazy fallback below is unchanged and still covers an empty
// pool, so a stalled advancer degrades to the pre-pool latency, never to a failed deploy.
//
// State lives in the bucket (Marshal's only store), next to the domain registry:
//   tenants/<ns>.json                 — the namespace → project assignment, the idempotency anchor
//   gcp-project-pool/<projectId>.json — pool membership and provisioning state
//   gcp-project-pool-ledger.json      — the creation-rate ledger

import { getConfig } from "./config.js";
import { createTenantProjectManager } from "./gcp/manager.js";
import { pooledProjectId, type TenantProject, TenantProjectManager } from "./gcp/projects.js";
import { RECONCILIATION_TAKEOVER_GRACE_MS } from "./mutation-safety.js";
import { ReconciliationLeaseLostError, withReconciliationLease, type LeaseTimings, type ReconciliationLeaseGuard } from "./reconciliation-lock.js";
import type { PoolProjectEntry, PoolProjectState } from "./types.js";
import {
  assignTenantProject,
  claimPoolProject,
  createPoolProject,
  deletePoolProject,
  listPoolProjects,
  readPoolCreationLedgerVersioned,
  readPoolProject,
  readTenantProjectAssignment,
  unclaimPoolProject,
  updatePoolProject,
  writePoolCreationLedgerConditionally,
} from "./store.js";

// The claim and the assignment write must both land for a pooled project to be considered
// taken: if the assignment write loses (a concurrent request for the same namespace won it),
// the claim is put back so the project is not stranded as claimed-by-a-loser.
async function claimFromPool(ns: string, manager: TenantProjectManager): Promise<TenantProject | null> {
  for (const { projectId, entry } of await listPoolProjects()) {
    if (entry.state !== "ready") continue;
    if (!(await claimPoolProject(projectId, ns))) continue;
    const assignedProjectId = await assignTenantProject(ns, projectId);
    if (assignedProjectId === projectId) {
      return await manager.describeActiveProject(projectId);
    }
    // This request lost the assignment race for its own namespace: another request assigned
    // a different (claimed) project first. Put our claim back and use the winner's project.
    await unclaimPoolProject(projectId, ns);
    return await manager.describeActiveProject(assignedProjectId);
  }
  return null;
}

export async function tenantProjectForNamespace(ns: string, manager: TenantProjectManager): Promise<TenantProject> {
  const assigned = await readTenantProjectAssignment(ns);
  if (assigned !== null) return await manager.describeActiveProject(assigned);

  const claimed = await claimFromPool(ns, manager);
  if (claimed !== null) return claimed;

  // Empty (or disabled) pool: today's lazy path. The deterministic id keeps concurrent first
  // deploys for one namespace converging on the same project even without the pool.
  const project = await manager.ensureForNamespace(ns);
  const assignedProjectId = await assignTenantProject(ns, project.projectId);
  if (assignedProjectId === project.projectId) return project;
  // A pooled project won while the deterministic fallback was being provisioned. The
  // assignment is authoritative; never deploy into the losing project and split one tenant
  // across two GCP boundaries. The loser contains no runtime resources yet.
  try {
    await manager.deleteDisposableProject(project.projectId);
  } catch (error) {
    console.error(`deleting unassigned fallback project ${JSON.stringify(project.projectId)} failed`, error);
  }
  return await manager.describeActiveProject(assignedProjectId);
}

// ---------------------------------------------------------------------------
// The advancer

const POOL_DISPLAY_NAME = "Hexclave tenant pool";

const IN_FLIGHT_STATES: readonly PoolProjectState[] = ["creating", "billing_pending", "apis_pending", "iam_pending"];

function isInFlight(state: PoolProjectState): boolean {
  return IN_FLIGHT_STATES.includes(state);
}

// How long one tick may run before it parks whatever is left for the next one. It has to come
// from here rather than from the platform: src/index.ts declares ONE app-wide `maxDuration`
// (sized for a service apply), so a cron that ran until the platform stopped it would run for
// minutes and be killed mid-transition rather than parking cleanly.
const TICK_BUDGET_MILLIS = 75 * 1000;

// Nothing else bounds project creation now that the in-process singleton is gone: the cron
// fires every two minutes whether or not the previous tick achieved anything, and DELETED GCP
// projects hold organization quota for 30 days — so a loop that creates and condemns would
// exhaust the org's project quota, not merely spend money.
const MAX_IN_FLIGHT = 3;
const MAX_CREATIONS_PER_HOUR = 10;
const CREATION_WINDOW_MILLIS = 60 * 60 * 1000;

// Genuine errors (not waits) tolerated in one state before the project is condemned.
const MAX_ATTEMPTS = 5;

// A project that has not reached `ready` in this long is not going to. The window is far
// wider than the worst realistic billing propagation so that slowness is never mistaken for
// a stall.
const STALL_MILLIS = 45 * 60 * 1000;

// How long a claimed entry whose namespace does not point back at it is left alone. The claim
// and the assignment write are two operations, and this grace is what keeps the reaper from
// racing a claim that is legitimately in between them.
const CLAIM_GRACE_MILLIS = 15 * 60 * 1000;

// Crons are at-least-once and two ticks can overlap (a slow tick is still running when the
// next fires, or two replicas fire together). Mirrors src/platform-domain-lock.ts, with one
// difference: `acquireTimeoutMs: 0` makes contention an immediate answer. Waiting out the
// holder would spend the whole tick budget queuing for work that is already being done.
const POOL_LEASE_TIMINGS: LeaseTimings = {
  durationMs: 2 * 60 * 1000,
  renewIntervalMs: 20 * 1000,
  contendedPollMs: 1000,
  takeoverGraceMs: RECONCILIATION_TAKEOVER_GRACE_MS,
  acquireTimeoutMs: 0,
};

// Contention is a no-op, not an error: the cron would otherwise report a failure for the
// entirely normal case of two ticks overlapping.
async function withProjectPoolLease<T>(action: (lease: ReconciliationLeaseGuard) => Promise<T>): Promise<T | null> {
  try {
    return await withReconciliationLease("__platform__", "project-pool", action, POOL_LEASE_TIMINGS);
  } catch (error) {
    if (error instanceof ReconciliationLeaseLostError) return null;
    throw error;
  }
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function newEntry(now: number): PoolProjectEntry {
  return { state: "creating", created_at_millis: now, state_since_millis: now, attempts: 0, last_error: null, operation_name: null, project_number: null, ns: null };
}

// A state CHANGE resets the per-state error count and clears the last error. Staying in a
// state (parking on a wait) deliberately does not go through here, so `state_since_millis`
// keeps measuring how long the project has actually been stuck.
function transition(entry: PoolProjectEntry, state: PoolProjectState, patch?: Partial<PoolProjectEntry>): PoolProjectEntry {
  return { ...entry, ...patch, state, state_since_millis: Date.now(), attempts: 0, last_error: null };
}

type Step = {
  entry: PoolProjectEntry,
  // true = written, then yield to a later tick. Only a genuine GCP wait parks.
  park: boolean,
};

// One resume point. Everything here is idempotent, because the process can be frozen between
// the GCP call and the record that remembers it — so the next tick re-enters the same step.
async function stepProject(manager: TenantProjectManager, projectId: string, entry: PoolProjectEntry): Promise<Step> {
  switch (entry.state) {
    case "creating": {
      // The `creating` record already exists — createPoolProject wrote it before this call
      // could create anything — so a project created here is always reapable.
      const projectNumber = await manager.ensureProjectActive(projectId, POOL_DISPLAY_NAME);
      return { entry: transition(entry, "billing_pending", { project_number: projectNumber }), park: false };
    }
    case "billing_pending": {
      // The one genuinely slow wait, and the reason this state exists: a brand-new project is
      // briefly unknown to Cloud Billing, and on reseller/offline-billing organizations that
      // window regularly exceeds ten minutes. One PUT per tick; no attempt count, because
      // waiting is not failing — the reaper's stall window is what eventually gives up.
      if (await manager.attachBillingOnce(projectId)) return { entry: transition(entry, "apis_pending"), park: false };
      return { entry: { ...entry, last_error: "Cloud Billing has not accepted the project yet" }, park: true };
    }
    case "apis_pending": {
      if (entry.operation_name === null) {
        // Park with the operation name recorded. Resuming reads it back and polls, so a freeze
        // here cannot start a second batchEnable against the same project.
        return { entry: { ...entry, operation_name: await manager.beginEnableApis(projectId) }, park: true };
      }
      if (!await manager.isEnableApisDone(entry.operation_name)) return { entry, park: true };
      return { entry: transition(entry, "iam_pending", { operation_name: null }), park: false };
    }
    case "iam_pending": {
      // Seconds, and idempotent, so it runs inline rather than parking.
      const projectNumber = entry.project_number ?? await manager.ensureProjectActive(projectId, POOL_DISPLAY_NAME);
      await manager.ensureProjectIam(projectId, projectNumber);
      return { entry: transition(entry, "ready", { project_number: projectNumber }), park: false };
    }
    default: {
      throw new Error(`tenant project ${JSON.stringify(projectId)} is not in flight (state ${JSON.stringify(entry.state)})`);
    }
  }
}

type AdvanceOutcome = "ready" | "parked" | "condemned" | "failed" | "raced" | "gone" | "settled";

// Drives ONE project as far as it can go: run-until-blocked, not one step per tick. Create,
// identity and IAM are seconds and run inline; only a real GCP wait or the tick deadline stops
// it. Every write is CAS-fenced, so an overlapping tick that got the same project simply loses
// and stops rather than double-stepping it.
async function advanceProject(manager: TenantProjectManager, projectId: string, deadline: number, lease: ReconciliationLeaseGuard): Promise<AdvanceOutcome> {
  for (;;) {
    await lease.assertOwned();
    const current = await readPoolProject(projectId);
    if (current === null) return "gone";
    const { value: entry, etag } = current;
    if (!isInFlight(entry.state)) return "settled";
    if (performance.now() >= deadline) return "parked";

    let step: Step;
    try {
      step = await stepProject(manager, projectId, entry);
      await lease.assertOwned();
    } catch (error) {
      await lease.assertOwned();
      const attempts = entry.attempts + 1;
      // Condemned rather than retried forever: the reaper deletes the GCP project, which stops
      // it billing and stops every later tick from spending its budget on a lost cause.
      const failed: PoolProjectEntry = {
        ...entry,
        attempts,
        last_error: describeError(error),
        ...(attempts >= MAX_ATTEMPTS ? { state: "condemned" as const, state_since_millis: Date.now() } : {}),
      };
      await updatePoolProject(projectId, failed, etag);
      return failed.state === "condemned" ? "condemned" : "failed";
    }

    if (!await updatePoolProject(projectId, step.entry, etag)) return "raced";
    if (step.park) return "parked";
    if (step.entry.state === "ready") return "ready";
  }
}

// Consumes the creation-rate budget BEFORE anything is created, and returns how many creations
// this tick may actually start. Recording first is deliberate: a freeze between the ledger
// write and the create must over-count, never under-count.
async function consumeCreationBudget(wanted: number, now: number, lease: ReconciliationLeaseGuard): Promise<number> {
  if (wanted <= 0) return 0;
  // CAS rather than a blind write, and retried on a lost race: this cap is what stands between
  // a runaway advancer and the organization's project quota, which deleted projects hold for
  // thirty days. It has to hold even when the lease that normally serializes it does not.
  for (let attempt = 0; attempt < 5; attempt++) {
    await lease.assertOwned();
    const { etag, createdAtMillis } = await readPoolCreationLedgerVersioned();
    const recent = createdAtMillis.filter((at) => at > now - CREATION_WINDOW_MILLIS);
    const allowed = Math.max(0, Math.min(wanted, MAX_CREATIONS_PER_HOUR - recent.length));
    if (allowed === 0) return 0;
    await lease.assertOwned();
    if (await writePoolCreationLedgerConditionally([...recent, ...Array.from({ length: allowed }, () => now)], etag)) return allowed;
  }
  // Someone else is reserving against the same ledger. Creating nothing this tick is the safe
  // outcome: the next tick recounts, and under-creating only costs pool latency.
  return 0;
}

async function createAndAdvance(manager: TenantProjectManager, deadline: number, lease: ReconciliationLeaseGuard): Promise<AdvanceOutcome | "collided"> {
  const config = getConfig();
  const projectId = pooledProjectId({ envId: config.envId, projectPrefix: config.gcp.projectPrefix });
  // THE record comes first. Nothing exists in GCP yet, so an id that is somehow already taken
  // costs nothing to abandon — unlike the old order, where a collision meant tearing a real
  // project back down and a freeze meant leaking one.
  await lease.assertOwned();
  if (!await createPoolProject(projectId, newEntry(Date.now()))) return "collided";
  return await advanceProject(manager, projectId, deadline, lease);
}

export type PoolStepResult = {
  skipped: boolean,
  ready: number,
  in_flight: number,
  created: number,
  outcomes: Record<string, number>,
};

function tally(outcomes: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}

// One cron tick. Advances every in-flight project concurrently, then starts as many new ones
// as the deficit and the caps allow.
export async function stepProjectPool(): Promise<PoolStepResult> {
  const result = await withProjectPoolLease(async (lease) => {
    const deadline = performance.now() + TICK_BUDGET_MILLIS;
    const size = getConfig().gcp.projectPoolSize;
    const manager = createTenantProjectManager();

    const inFlight = (await listPoolProjects()).filter(({ entry }) => isInFlight(entry.state));
    const outcomes = await Promise.all(inFlight.map(async ({ projectId }) => {
      // One project's failure must not abandon the others: advanceProject records what it can
      // and this is the backstop for a store failure it could not.
      try {
        return await advanceProject(manager, projectId, deadline, lease);
      } catch (error) {
        if (error instanceof ReconciliationLeaseLostError) throw error;
        console.error(`advancing pooled project ${JSON.stringify(projectId)} failed`, error);
        return "failed" as const;
      }
    }));

    // Recount rather than deriving from the outcomes above: a concurrent claim can consume a
    // ready project between the two reads, and over-creating is the expensive mistake here.
    await lease.assertOwned();
    const after = await listPoolProjects();
    const ready = after.filter(({ entry }) => entry.state === "ready").length;
    const stillInFlight = after.filter(({ entry }) => isInFlight(entry.state)).length;
    const wanted = Math.min(size - ready - stillInFlight, MAX_IN_FLIGHT - stillInFlight);
    const allowed = await consumeCreationBudget(wanted, Date.now(), lease);
    const created = await Promise.all(Array.from({ length: allowed }, async () => {
      try {
        return await createAndAdvance(manager, deadline, lease);
      } catch (error) {
        if (error instanceof ReconciliationLeaseLostError) throw error;
        console.error("creating a pooled tenant project failed", error);
        return "failed" as const;
      }
    }));

    return {
      skipped: false,
      ready,
      in_flight: stillInFlight,
      created: created.filter((outcome) => outcome !== "collided").length,
      outcomes: tally([...outcomes, ...created]),
    };
  });
  return result ?? { skipped: true, ready: 0, in_flight: 0, created: 0, outcomes: {} };
}

// ---------------------------------------------------------------------------
// The reaper

export type PoolReapResult = {
  skipped: boolean,
  condemned: number,
  deleted: number,
  restored: number,
  forgotten: number,
};

// The hourly cron. Three cases, none of which the fire-and-forget replenisher had:
//
//  1. an in-flight project that has been stuck past STALL_MILLIS — condemned, and its GCP
//     project deleted, so a wedged provisioning stops billing;
//  2. a claimed entry whose namespace does NOT point back at it — the claim was stranded
//     mid-freeze between claimPoolProject and assignTenantProject, so put it back;
//  3. a claimed entry whose namespace DOES point back at it — the assignment in
//     tenants/<ns>.json is now the authority, so the pool entry is pure residue. Forgetting it
//     is what bounds listPoolProjects() by POOL SIZE instead of by lifetime tenant count: that
//     listing is a LIST plus a GET per entry, and it runs on the deploy path.
export async function reapProjectPool(): Promise<PoolReapResult> {
  const result = await withProjectPoolLease(async (lease) => {
    const manager = createTenantProjectManager();
    const now = Date.now();
    let condemned = 0;
    let deleted = 0;
    let restored = 0;
    let forgotten = 0;

    for (const { projectId } of await listPoolProjects()) {
      await lease.assertOwned();
      // One entry must not abandon the rest, the way stepProjectPool already guards each
      // project it advances. A project stuck in a state that rejects deletion, or one missing
      // permission, would otherwise abort the loop on EVERY hourly tick — leaving condemned
      // projects billing and stranded claims unrestored for as long as that one entry lasts,
      // which is exactly the leak this reaper exists to close.
      try {
        // Re-read under the lease so a decision is never made on a stale entry, and so the CAS
        // below fences a claim that landed since the listing.
        const current = await readPoolProject(projectId);
        if (current === null) continue;
        const { value: entry, etag } = current;

        const stalled = isInFlight(entry.state) && now - entry.created_at_millis > STALL_MILLIS;
        if (stalled) {
          await lease.assertOwned();
          if (!await updatePoolProject(projectId, { ...entry, state: "condemned", state_since_millis: now }, etag)) continue;
          condemned += 1;
        }
        if (stalled || entry.state === "condemned") {
          // GCP first, THEN the record: dropping the record first and freezing would leave the
          // billed project with nothing left that knows to delete it.
          await lease.assertOwned();
          await manager.deleteDisposableProject(projectId);
          await lease.assertOwned();
          const latest = await readPoolProject(projectId);
          if (latest !== null && await deletePoolProject(projectId, latest.etag)) deleted += 1;
          continue;
        }

        if (entry.state !== "claimed" || entry.ns === null) continue;
        const assigned = await readTenantProjectAssignment(entry.ns);
        if (assigned === projectId) {
          await lease.assertOwned();
          if (await deletePoolProject(projectId, etag)) forgotten += 1;
          continue;
        }
        // The grace is what makes this safe: a live claim is a claim write followed by an
        // assignment write, and in between it looks exactly like a stranded one.
        if (now - entry.state_since_millis <= CLAIM_GRACE_MILLIS) continue;
        await lease.assertOwned();
        if (await updatePoolProject(projectId, { ...entry, state: "ready", state_since_millis: now, ns: null }, etag)) restored += 1;
      } catch (error) {
        // Lease loss is not this entry's problem: nothing after it is ours to reap.
        if (error instanceof ReconciliationLeaseLostError) throw error;
        console.error(`reaping pooled project ${JSON.stringify(projectId)} failed`, error);
      }
    }

    return { skipped: false, condemned, deleted, restored, forgotten };
  });
  return result ?? { skipped: true, condemned: 0, deleted: 0, restored: 0, forgotten: 0 };
}
