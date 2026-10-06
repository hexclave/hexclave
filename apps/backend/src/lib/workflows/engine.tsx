import { Prisma } from "@/generated/prisma/client";
import { getTenancy, Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import {
  WORKFLOW_RUN_MEMO_MAX_BYTES,
  WORKFLOW_SCHEDULE_TRIGGER_TYPE,
  WORKFLOW_STEP_MAX_ATTEMPTS,
  WORKFLOW_STEP_RETRY_BACKOFF_MS,
  type WorkflowDivergenceDiagnosticJson,
  type WorkflowManifestJson,
} from "@hexclave/shared/dist/interface/workflows";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { deterministicWorkflowUuid, enqueueWorkflowEvent } from "./events";
import { didAnySkippedWorkflowResume, partitionClaimedWorkflowEvents, workflowEventRetryDelayMs } from "./event-processing";
import { invokeWorkflowRunKeyBatch, invokeWorkflowSandbox } from "./invoke";
import { listCronOccurrences, MAX_CATCHUP_WINDOW_MS, parseCronExpression } from "./cron";
import {
  WORKFLOWS_DEFAULT_LIMITS,
  WORKFLOWS_PROTOCOL_VERSION,
  type WorkflowSandboxCredentials,
  type WorkflowSandboxEvent,
  type WorkflowSandboxInput,
  type WorkflowSandboxOutcome,
  type WorkflowSandboxStepBagEntry,
} from "./protocol";
import { getWorkflowsRuntimeEnv } from "./runtime-env";
import { createWorkflowRunToken } from "./run-token";

// The workflow engine: tick-driven like the email queue. A cron route calls
// runWorkflowEngineStep() in a loop; each step (1) materializes due schedule
// occurrences into the event outbox, then concurrently (2) processes
// unprocessed events into runs and (3) claims due runs with FOR UPDATE SKIP
// LOCKED and executes them in sandbox invocations, and (4) occasionally
// prunes retention. There is no locking around the tick itself — overlapping
// ticks are safe by construction: event and run claims use SKIP LOCKED +
// leases, and everything in event processing is idempotent via deterministic
// ids (an event is only marked processed AFTER its runs exist, so a crash
// replays it and every insert no-ops).

// Enough for every dispatch slot to take a full tenancy batch
// (EVENT_TENANCY_CONCURRENCY × EVENT_TENANCY_BATCH_SIZE).
const EVENT_BATCH_SIZE = 1000;
// How long a claimed event stays invisible to other ticks. An expired lease
// only costs duplicate work (run creation is idempotent), never correctness,
// but it does let a second tick dispatch the same tenancy concurrently — so
// the work budget below stops starting new events early enough that one
// in-flight run-key invocation still finishes inside the lease.
const EVENT_CLAIM_LEASE_MS = 5 * 60 * 1000;
const RUN_KEY_INVOCATION_TIMEOUT_MS = 60 * 1000;
const EVENT_CLAIM_WORK_BUDGET_MS = EVENT_CLAIM_LEASE_MS - RUN_KEY_INVOCATION_TIMEOUT_MS - 30 * 1000;
// At most this many of one tenancy's events per claim, so a batch spans
// several tenancies (and uses several dispatch slots) even when one tenancy
// holds all of the oldest events. Run keys are derived with one sandbox
// invocation per workflow version per tenancy batch (see
// precomputeRunKeys), so a larger batch spreads that invocation's cost over
// more events; what is left per event is a few statements, run serially.
const EVENT_TENANCY_BATCH_SIZE = 100;
// Tenancies of one claimed batch dispatched at once.
const EVENT_TENANCY_CONCURRENCY = 10;
// Batched run-key invocations a tenancy runs at once (one per workflow with a
// runKey), so one tick starts at most EVENT_TENANCY_CONCURRENCY × this.
const RUN_KEY_BATCH_CONCURRENCY = 3;
// Serialized event bytes per batched run-key invocation. Event payloads may
// be large, and the whole batch rides in the invocation's code.
const RUN_KEY_BATCH_MAX_INPUT_BYTES = 1024 * 1024;
// Events no workflow listens to, marked processed per tick in one statement.
// Every project's user/team/permission writes land in the outbox and almost
// none of them trigger a workflow, so this is where nearly all of the outbox
// volume goes. The pair limit bounds how many (tenancy, event type) groups
// one sweep looks at; see sweepUnlistenedEvents.
const EVENT_SWEEP_LIMIT = 10_000;
const EVENT_SWEEP_PAIR_LIMIT = 500;
// The claim is a handful of index probes per tenancy with workflows; this is
// generous headroom over Prisma's 5s default so that a slow claim degrades
// instead of failing.
const EVENT_CLAIM_TRANSACTION_TIMEOUT_MS = 30 * 1000;
// pg_try_advisory_xact_lock key serializing the event claim statement.
const WORKFLOW_EVENT_CLAIM_LOCK_ID = 74031182;
// Kept small: the claim query's per-workflow concurrency filter only counts
// leases that exist BEFORE the batch, so one batch can overshoot the
// per-workflow cap by at most the batch size. The cap is flow control, not
// a hard isolation boundary — a small batch keeps the overshoot negligible.
const RUN_CLAIM_BATCH_SIZE = 5;
const PER_WORKFLOW_CONCURRENCY = 10;
// Lease must outlive the longest possible invocation (10min step cap +
// engine-side slack); an expired lease means the worker died and the run is
// re-claimable. Re-claiming re-executes from the last committed step, so
// step execution is at-least-once: a step may run again (and re-fire its
// first-party side effects) if the worker died after acting but before the
// step result committed. Acceptable for the alpha; a dedup floor for that
// crash window is deferred to a later version.
const RUN_LEASE_MS = 12 * 60 * 1000;
// See the credential-minting comment in executeClaimedRun.
const WORKFLOW_RUN_TOKEN_TTL_MS = 35 * 60 * 1000;
export const WORKFLOW_INVOCATION_BACKSTOP_TIMEOUT_MS = WORKFLOWS_DEFAULT_LIMITS.maxStepTimeoutMs + 30 * 1000;
// How many steps a single claim may chain before handing the run back to
// the queue, so a hot run cannot starve others for a whole tick.
const MAX_CHAINED_STEPS_PER_CLAIM = 50;
/** The capacity knobs, for the internal status page: its numbers only mean something next to these. */
export const WORKFLOW_ENGINE_LIMITS = {
  eventBatchSize: EVENT_BATCH_SIZE,
  eventTenancyConcurrency: EVENT_TENANCY_CONCURRENCY,
  eventClaimLeaseMs: EVENT_CLAIM_LEASE_MS,
  runClaimBatchSize: RUN_CLAIM_BATCH_SIZE,
  perWorkflowConcurrency: PER_WORKFLOW_CONCURRENCY,
  runLeaseMs: RUN_LEASE_MS,
} as const;
const GENERIC_PLATFORM_ERROR_SUMMARY = "A platform error occurred while executing this workflow. The Hexclave team has been notified.";
// Sentinel step keys. "#" is reserved in user step ids (the runtime rejects
// it), so these can never collide with real steps. "#handler" marks failures
// thrown outside any step (handler top-level, module import, runKey fn);
// "#completion" carries the completing invocation's console output.
const HANDLER_STEP_KEY = "#handler";
const COMPLETION_STEP_KEY = "#completion";

function jitteredBackoffMs(attempt: number): number {
  // Backoff before retry N: 10s / 1m / 10m, jittered ±25%.
  const base = WORKFLOW_STEP_RETRY_BACKOFF_MS[Math.min(attempt - 1, WORKFLOW_STEP_RETRY_BACKOFF_MS.length - 1)];
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

const wallClockFormatterCache = new Map<string, Intl.DateTimeFormat>();
/** "2026-11-01 01:30" in the given timezone; the nominal identity of a schedule occurrence. */
function formatWallClockMinute(instant: Date, timezone: string): string {
  let formatter = wallClockFormatterCache.get(timezone);
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    wallClockFormatterCache.set(timezone, formatter);
  }
  return formatter.format(instant);
}

function getWorkflowsSandboxApiUrl(): string {
  // Overridable because the sandbox may not share the backend's network
  // namespace: locally the Freestyle mock runs in Docker and reaches the
  // host via host.docker.internal, while in production the public API URL
  // works from anywhere.
  return getEnvVariable("HEXCLAVE_WORKFLOWS_SANDBOX_API_URL", "") || getEnvVariable("NEXT_PUBLIC_STACK_API_URL");
}

// ─── Version loading (bundles are big; keep a tiny cache) ──────────────────

type VersionRow = {
  compiledBundle: string,
  manifest: WorkflowManifestJson,
  runtimeEnvVersion: string,
  version: number,
};

const versionCache = new Map<string, VersionRow>();
const VERSION_CACHE_MAX_ENTRIES = 20;

async function loadWorkflowVersion(tenancyId: string, workflowId: string, version: number): Promise<VersionRow | null> {
  const cacheKey = `${tenancyId}:${workflowId}:${version}`;
  const cached = versionCache.get(cacheKey);
  if (cached != null) return cached;
  const row = await globalPrismaClient.workflowVersion.findUnique({
    where: { tenancyId_workflowId_version: { tenancyId, workflowId, version } },
  });
  if (row == null) return null;
  const value: VersionRow = {
    compiledBundle: row.compiledBundle,
    manifest: row.manifest as WorkflowManifestJson,
    runtimeEnvVersion: row.runtimeEnvVersion,
    version: row.version,
  };
  // Versions are immutable, so eviction is purely about memory.
  if (versionCache.size >= VERSION_CACHE_MAX_ENTRIES) {
    const oldestKey = versionCache.keys().next().value;
    if (oldestKey != null) versionCache.delete(oldestKey);
  }
  versionCache.set(cacheKey, value);
  return value;
}

function getStdlibNodeModules(versionRow: VersionRow): Record<string, string> {
  const env = getWorkflowsRuntimeEnv(versionRow.runtimeEnvVersion);
  return {
    ...env.runtimeNodeModules,
    ...Object.fromEntries(Object.entries(env.stdlibNodeModules).filter(([pkg]) => versionRow.manifest.uses_stdlib.includes(pkg))),
  };
}

async function getCachedTenancy(tenancyId: string, tenancyCache: Map<string, Tenancy | null>): Promise<Tenancy | null> {
  let tenancy = tenancyCache.get(tenancyId);
  if (tenancy === undefined) {
    tenancy = await getTenancy(tenancyId);
    tenancyCache.set(tenancyId, tenancy);
  }
  return tenancy;
}

// ─── Schedule materialization ──────────────────────────────────────────────

type ScheduledDefinitionRow = {
  tenancyId: string,
  workflowId: string,
  latestVersion: number,
  manifest: WorkflowManifestJson,
  deployedAt: Date,
};

// A schedule that has fallen far behind (bounded only by MAX_CATCHUP_WINDOW_MS)
// can owe an enormous number of occurrences at once — an every-minute cron 92
// days behind owes ~132k. A single createMany of that size risks exceeding
// query/parameter limits and failing wholesale, so inserts are chunked.
const SCHEDULE_EVENT_INSERT_CHUNK_SIZE = 1000;

async function materializeScheduleOccurrences(tenancyCache: Map<string, Tenancy | null>, deadlineMs: number): Promise<boolean> {
  // Paused definitions are filtered out rather than materialized-then-dropped:
  // an every-minute schedule paused for a month would otherwise write ~43k
  // outbox rows that the event gate immediately discards. The resume path
  // fast-forwards the schedule cursors (see setWorkflowPaused), so the
  // interval spent paused cannot come back as a catch-up burst.
  const definitions = await globalPrismaClient.$queryRaw<ScheduledDefinitionRow[]>(Prisma.sql`
    SELECT d."tenancyId", d."workflowId", d."latestVersion", v."manifest", v."createdAt" AS "deployedAt"
    FROM "WorkflowDefinition" d
    JOIN "WorkflowVersion" v
      ON v."tenancyId" = d."tenancyId" AND v."workflowId" = d."workflowId" AND v."version" = d."latestVersion"
    WHERE v."manifest"->'triggers' @> '[{"type":"schedule"}]'
      AND d."pausedAt" IS NULL
  `);

  let didWork = false;
  for (const definition of definitions) {
    // This phase runs first in the tick and scans every scheduled definition
    // across all tenancies, so without a deadline it could starve event
    // processing and run execution for the whole step. Breaking here is safe:
    // already-processed schedules have advanced cursors, which makes
    // re-scanning them cheap, so later passes drain the remainder (the
    // definitions list has no inherent order — resumption is emergent from
    // cursor state, not positional).
    if (Date.now() >= deadlineMs) break;
    try {
      didWork = await materializeDefinitionSchedules(definition, tenancyCache, deadlineMs) || didWork;
    } catch (error) {
      // One tenancy's failing schedule (a transient DB error, a poisoned
      // manifest) must not abort materialization for every other tenancy —
      // and since this phase runs first, an uncaught throw here would also
      // take down event processing and run execution for the entire tick,
      // every tick, until the underlying row is fixed. Mirrors the per-event
      // isolation in processWorkflowEvents.
      captureError("workflow-schedule-materialization", error);
    }
  }
  return didWork;
}

/** Returns whether any occurrence events were inserted. */
async function materializeDefinitionSchedules(definition: ScheduledDefinitionRow, tenancyCache: Map<string, Tenancy | null>, deadlineMs: number): Promise<boolean> {
  const tenancy = await getCachedTenancy(definition.tenancyId, tenancyCache);
  if (tenancy == null) return false;
  // One `now` per definition so every schedule on the same workflow
  // materializes against an identical window boundary. Best-effort: a
  // deadline break below defers the remaining triggers to a later pass with
  // a later `now`, which is fine because schedules are independent
  // per-cursor and occurrence ids are deterministic.
  const now = new Date();
  let didWork = false;

  for (const trigger of definition.manifest.triggers) {
    if (trigger.type !== "schedule") continue;
    // Checked between schedules but deliberately NOT between insert chunks:
    // the cursor only advances after a schedule's full window is inserted, so
    // abandoning a started schedule mid-burst would re-list and re-insert the
    // same window every tick without ever advancing — a livelock. Finishing
    // the schedule we started keeps progress monotonic, and a worst-case
    // catch-up burst is ~132 chunked inserts, well within a tick.
    if (Date.now() >= deadlineMs) break;
    const scheduleKey = `${trigger.cron}|${trigger.timezone}`;
    const cronResult = parseCronExpression(trigger.cron);
    if (cronResult.status === "error") {
      // Sync validates cron expressions, so this is a platform bug.
      captureError("workflow-schedule-invalid-cron", new HexclaveAssertionError(`Stored workflow schedule has invalid cron: ${cronResult.error}`, { definition }));
      continue;
    }

    let cursor = await globalPrismaClient.workflowScheduleCursor.findUnique({
      where: { tenancyId_workflowId_scheduleKey: { tenancyId: definition.tenancyId, workflowId: definition.workflowId, scheduleKey } },
    });
    if (cursor == null) {
      // Compatibility/self-healing path for schedules deployed before
      // cursor-at-sync existed: begin at deployment time so the first
      // occurrence is not silently lost.
      await globalPrismaClient.workflowScheduleCursor.createMany({
        data: [{ tenancyId: definition.tenancyId, workflowId: definition.workflowId, scheduleKey, lastMaterializedAt: definition.deployedAt }],
        skipDuplicates: true,
      });
      cursor = await globalPrismaClient.workflowScheduleCursor.findUnique({
        where: { tenancyId_workflowId_scheduleKey: { tenancyId: definition.tenancyId, workflowId: definition.workflowId, scheduleKey } },
      }) ?? throwErr("Workflow schedule cursor disappeared immediately after creation");
    }

    const windowStart = new Date(Math.max(cursor.lastMaterializedAt.getTime(), now.getTime() - MAX_CATCHUP_WINDOW_MS));
    const occurrences = listCronOccurrences(cronResult.data, trigger.timezone, windowStart, now);
    if (occurrences.length > 0) {
      // Deterministic per-occurrence event ids make this crash-safe
      // without a transaction: re-running after a crash between insert and
      // cursor update re-inserts the same ids, which no-op. Missed
      // occurrences CATCH UP (delayed, never skipped): each gets its
      // nominal scheduledAt, and the outbox processes in ascending
      // scheduledAt order.
      for (let chunkStart = 0; chunkStart < occurrences.length; chunkStart += SCHEDULE_EVENT_INSERT_CHUNK_SIZE) {
        const chunk = occurrences.slice(chunkStart, chunkStart + SCHEDULE_EVENT_INSERT_CHUNK_SIZE);
        await globalPrismaClient.workflowEvent.createMany({
          data: chunk.map((occurrence) => ({
            tenancyId: definition.tenancyId,
            // Keyed by the NOMINAL wall-clock occurrence, not the UTC
            // instant: during DST fall-back the repeated wall hour matches
            // at two UTC instants, and this collapses them into one
            // occurrence (skipDuplicates drops the second insert).
            id: deterministicWorkflowUuid(`schedule:${definition.tenancyId}:${definition.workflowId}:${scheduleKey}:${formatWallClockMinute(occurrence, trigger.timezone)}`),
            type: WORKFLOW_SCHEDULE_TRIGGER_TYPE,
            payload: {
              workflow_id: definition.workflowId,
              cron: trigger.cron,
              timezone: trigger.timezone,
              scheduled_at_millis: occurrence.getTime(),
            },
            scheduledAt: occurrence,
          })),
          skipDuplicates: true,
        });
      }
      didWork = true;
    }
    // GREATEST, not a blind write: `now` was captured before this (possibly
    // slow, chunked) pass began, so an unconditional update can move the
    // cursor BACKWARDS past a value written since — including a resume's
    // fast-forward, which would hand the paused interval back as catch-up.
    // Also stops two overlapping ticks from undoing each other's progress.
    await globalPrismaClient.$executeRaw(Prisma.sql`
      UPDATE "WorkflowScheduleCursor"
      SET "lastMaterializedAt" = GREATEST("lastMaterializedAt", ${now})
      WHERE "tenancyId" = ${definition.tenancyId}::uuid
        AND "workflowId" = ${definition.workflowId}
        AND "scheduleKey" = ${scheduleKey}
    `);
  }
  return didWork;
}

// ─── Event outbox processing (event -> run creation) ───────────────────────

type WorkflowEventRow = {
  tenancyId: string,
  id: string,
  type: string,
  payload: unknown,
  scheduledAt: Date,
  processingAttempts: number,
};

type DefinitionWithManifest = {
  tenancyId: string,
  workflowId: string,
  latestVersion: number,
  manifest: WorkflowManifestJson,
};

/**
 * Workflow ids paused at THIS moment. Deliberately not folded into the cached
 * definition list: that cache lives for a whole batch, and a batch can span an
 * entire tick (run-key derivation is a sandbox invocation). A resume landing
 * mid-batch would then keep matching events against a stale `pausedAt` and
 * drop them — permanently, because they get marked processed either way. An
 * extra dispatch shortly after a resume is the accepted approximation; a
 * permanent drop after one is not.
 */
async function listPausedWorkflowIdsForTenancy(tenancyId: string): Promise<Set<string>> {
  const rows = await globalPrismaClient.$queryRaw<{ workflowId: string }[]>(Prisma.sql`
    SELECT "workflowId" FROM "WorkflowDefinition"
    WHERE "tenancyId" = ${tenancyId}::uuid AND "pausedAt" IS NOT NULL
  `);
  return new Set(rows.map((row) => row.workflowId));
}

async function listDefinitionsForTenancies(tenancyIds: string[]): Promise<Map<string, DefinitionWithManifest[]>> {
  // This read controls the irreversible processedAt decision below, so it
  // must observe the primary rather than a potentially stale replica. Raw
  // queries are not in the read-replicas extension's routing list (only the
  // model-level finders and findRaw/aggregateRaw are), so this stays on the
  // primary. Rewriting it as a findMany would silently move it to a replica.
  const rows = await globalPrismaClient.$queryRaw<DefinitionWithManifest[]>(Prisma.sql`
    SELECT d."tenancyId", d."workflowId", d."latestVersion", v."manifest"
    FROM "WorkflowDefinition" d
    JOIN "WorkflowVersion" v
      ON v."tenancyId" = d."tenancyId" AND v."workflowId" = d."workflowId" AND v."version" = d."latestVersion"
    WHERE d."tenancyId" = ANY(${tenancyIds}::uuid[])
  `);
  const byTenancy = new Map<string, DefinitionWithManifest[]>();
  for (const row of rows) {
    const definitions = byTenancy.get(row.tenancyId) ?? [];
    definitions.push(row);
    byTenancy.set(row.tenancyId, definitions);
  }
  return byTenancy;
}

function eventToSandboxEvent(event: WorkflowEventRow): WorkflowSandboxEvent {
  return {
    id: event.id,
    type: event.type,
    tsMillis: event.scheduledAt.getTime(),
    data: event.payload,
  };
}

function runKeySandboxInput(event: WorkflowEventRow): WorkflowSandboxInput {
  return {
    protocolVersion: WORKFLOWS_PROTOCOL_VERSION,
    mode: "run-key",
    limits: WORKFLOWS_DEFAULT_LIMITS,
    event: eventToSandboxEvent(event),
  };
}

async function createFailedRun(options: {
  tenancy: Tenancy,
  runId: string,
  workflowId: string,
  version: number,
  runKey: string | null,
  event: WorkflowEventRow,
  triggerPayload: { ts_millis: number, data: unknown },
  errorSummary: string,
}): Promise<void> {
  await globalPrismaClient.$executeRaw(Prisma.sql`
    INSERT INTO "WorkflowRun" ("tenancyId", "id", "workflowId", "version", "runKey", "state", "triggerEventId", "triggerType", "triggerPayload", "failureKind", "errorSummary", "completedAt", "updatedAt")
    VALUES (${options.tenancy.id}::uuid, ${options.runId}::uuid, ${options.workflowId}, ${options.version}, ${options.runKey}, 'FAILED', ${options.event.id}::uuid, ${options.event.type}, ${JSON.stringify(options.triggerPayload)}::jsonb, 'USER', ${options.errorSummary}, NOW(), NOW())
    ON CONFLICT ("tenancyId", "id") DO NOTHING
  `);
}

async function createRunForEvent(
  tenancy: Tenancy,
  event: WorkflowEventRow,
  definition: DefinitionWithManifest,
  /** This event's run-key outcome from its tenancy's batched derivation, if that produced one. */
  precomputedRunKey: WorkflowSandboxOutcome | undefined,
): Promise<void> {
  // Deterministic per (event, workflow): reprocessing after a crash (or a
  // concurrently overlapping tick) can never create a duplicate run.
  const runId = deterministicWorkflowUuid(`run:${tenancy.id}:${event.id}:${definition.workflowId}`);
  const existing = await globalPrismaClient.workflowRun.findUnique({
    where: { tenancyId_id: { tenancyId: tenancy.id, id: runId } },
    select: { id: true, workflowId: true, runKey: true, version: true, state: true, triggerType: true },
  });
  if (existing != null) {
    // This event was already processed — likely a crash between the run
    // transaction and marking the event processed. The run is durable, so
    // replay has nothing left to do.
    return;
  }

  const versionRow = await loadWorkflowVersion(tenancy.id, definition.workflowId, definition.latestVersion)
    ?? throwErr(`Workflow version ${definition.workflowId}@v${definition.latestVersion} missing while creating a run — versions are never deleted, so this should be impossible`);

  const triggerPayload = { ts_millis: event.scheduledAt.getTime(), data: event.payload };

  // runKey derivation happens at run CREATION, before any execution. It is a
  // pure function of the event, so the extra sandbox invocation is safe to
  // repeat on crash-replay.
  let runKey: string | null = null;
  if (versionRow.manifest.has_run_key) {
    // Normally batched per tenancy ahead of time; anything the batch did not
    // resolve (a failed batch, a bundle that cannot be batched) falls back
    // to its own invocation here.
    let outcome = precomputedRunKey;
    if (outcome == null) {
      const keyResult = await invokeWorkflowSandbox({
        compiledBundle: versionRow.compiledBundle,
        input: runKeySandboxInput(event),
        nodeModules: getStdlibNodeModules(versionRow),
        timeoutMs: RUN_KEY_INVOCATION_TIMEOUT_MS,
      });
      if (keyResult.status === "error") {
        // Platform failure: leave the event unprocessed (the throw aborts
        // marking it processed) so a later tick retries.
        throw new HexclaveAssertionError(`Workflow run-key invocation failed: ${keyResult.error.message}`, { tenancyId: tenancy.id, eventId: event.id, workflowId: definition.workflowId, invocationId: keyResult.error.invocationId });
      }
      outcome = keyResult.data;
    }
    if (outcome.type === "handler-failed") {
      // The user's runKey function threw: record a FAILED run so the error
      // is visible in run history (user-error channel), and move on.
      await createFailedRun({
        tenancy,
        runId,
        workflowId: definition.workflowId,
        version: versionRow.version,
        runKey: null,
        event,
        triggerPayload,
        errorSummary: `runKey function failed: ${outcome.error.name}: ${outcome.error.message}`,
      });
      return;
    }
    if (outcome.type !== "run-key") {
      throw new HexclaveAssertionError(`Unexpected run-key outcome type ${outcome.type}`, { outcome });
    }
    runKey = outcome.runKey;
  }

  // The initial wakeAt is the event's scheduledAt (not "now") so that
  // schedule catch-up backlogs execute in ascending scheduledAt order — the
  // claim query orders by wakeAt.
  const insertRun = async (): Promise<boolean> => {
    return await retryTransaction(globalPrismaClient, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO "WorkflowRun" ("tenancyId", "id", "workflowId", "version", "runKey", "state", "triggerEventId", "triggerType", "triggerPayload", "wakeAt", "updatedAt")
        VALUES (${tenancy.id}::uuid, ${runId}::uuid, ${definition.workflowId}, ${versionRow.version}, ${runKey}, 'QUEUED', ${event.id}::uuid, ${event.type}, ${JSON.stringify(triggerPayload)}::jsonb, ${event.scheduledAt}, NOW())
        ON CONFLICT ("tenancyId", "workflowId", "runKey", "isActive") DO NOTHING
        RETURNING "id"
      `);
      return rows.length > 0;
    });
  };

  let inserted: boolean;
  try {
    inserted = await insertRun();
  } catch (error) {
    // A concurrent worker created the same deterministic run id between our
    // existence check and the insert — that's the pkey conflict (the
    // ON CONFLICT clause above only targets the runKey uniqueness index).
    if (error instanceof Error && error.message.includes("WorkflowRun_pkey")) return;
    throw error;
  }

  if (!inserted) {
    // The runKey uniqueness index rejected the insert: this key already has
    // an ACTIVE run. BEFORE applying onConflict semantics, check whether the
    // "conflicting" run is this event's own run, created by a concurrently
    // overlapping tick between our existence check and the insert. Postgres
    // reports the arbiter-index conflict without raising the pkey violation
    // in that case, so without this re-check a cancel-existing workflow
    // would cancel the legitimate run it itself just created.
    const concurrentlyCreated = await globalPrismaClient.workflowRun.findUnique({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: runId } },
      select: { id: true },
    });
    if (concurrentlyCreated != null) return;
    switch (versionRow.manifest.on_conflict) {
      case "skip": {
        return;
      }
      case "error": {
        // Record the conflict as a FAILED run for auditability; terminal
        // runs have isActive NULL, so the key index does not object.
        await createFailedRun({
          tenancy,
          runId,
          workflowId: definition.workflowId,
          version: versionRow.version,
          runKey,
          event,
          triggerPayload,
          errorSummary: `runKey conflict: an active run already exists for key ${JSON.stringify(runKey)} (onConflict: "error")`,
        });
        return;
      }
      case "cancel-existing": {
        // Restart semantics: cancel the active run for this key, then
        // insert. Bounded retry because another event may race us for the
        // freed key; losing that race twice in a row means the other event
        // won legitimately.
        for (let i = 0; i < 3; i++) {
          await cancelWorkflowRuns(tenancy, { workflowId: definition.workflowId, runKey: runKey ?? throwErr("cancel-existing conflict with null runKey should be impossible (null keys never conflict)") });
          let retryInserted: boolean;
          try {
            retryInserted = await insertRun();
          } catch (error) {
            // Same pkey race as the first insert: a concurrent worker owns
            // this deterministic run id, so the event is already handled.
            if (error instanceof Error && error.message.includes("WorkflowRun_pkey")) return;
            throw error;
          }
          if (retryInserted) {
            return;
          }
        }
        captureError("workflow-cancel-existing-race", new HexclaveAssertionError("cancel-existing lost the runKey race 3 times in a row", { tenancyId: tenancy.id, eventId: event.id, workflowId: definition.workflowId, runKey }));
        return;
      }
    }
  }
}

// Which event types each tenancy's workflows listen to, as (tenancyId, type)
// rows read from the latest manifests. This is the SQL twin of
// workflowDefinitionMatchesEvent for ordinary events: a pair appears here
// exactly when some definition has an event trigger for that type. Schedule
// occurrences are matched on their payload, which only the JS matcher does,
// so every tenancy with a workflow is listed as listening to them and they
// always take the claim path.
const LISTENED_EVENT_TYPES_SQL = Prisma.sql`
  SELECT d."tenancyId", t."trigger"->>'event_type' AS "type"
  FROM "WorkflowDefinition" d
  JOIN "WorkflowVersion" v
    ON v."tenancyId" = d."tenancyId" AND v."workflowId" = d."workflowId" AND v."version" = d."latestVersion"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(v."manifest"->'triggers') = 'array' THEN v."manifest"->'triggers' ELSE '[]'::jsonb END
  ) AS t("trigger")
  WHERE t."trigger"->>'type' = 'event' AND t."trigger"->>'event_type' IS NOT NULL
  UNION
  SELECT d."tenancyId", ${WORKFLOW_SCHEDULE_TRIGGER_TYPE}::text AS "type"
  FROM "WorkflowDefinition" d
`;

/**
 * Marks pending events that no workflow listens to as processed, in one
 * statement: events of tenancies with no workflows at all, and events of
 * tenancies with workflows whose type none of those workflows triggers on.
 * That is exactly what dispatching them would conclude — without loading a
 * tenancy or spending a claim on them. Returns how many events were swept.
 *
 * The cost does not depend on the size of the backlog. Rather than reading
 * pending rows and discarding the ones somebody listens to (which re-reads a
 * busy tenancy's whole backlog every tick), it enumerates the distinct
 * (tenancy, type) pairs that have pending events — one index probe each, a
 * "loose index scan" — keeps the unlistened ones, and only then reads rows.
 */
async function sweepUnlistenedEvents(): Promise<number> {
  // The LIMIT on `unlistened` is what stops the recursion: pairs are produced
  // on demand, so the scan ends once enough unlistened ones were found. Pairs
  // are drained in key order, and a drained pair disappears from the index,
  // so successive sweeps move on. SKIP LOCKED lets overlapping ticks sweep
  // disjoint rows instead of deadlocking on each other. Runs on the primary
  // ($executeRaw), like every other read that decides processedAt.
  return await globalPrismaClient.$executeRaw(Prisma.sql`
    WITH RECURSIVE pending_pairs AS (
      (
        SELECT e."tenancyId", e."type"
        FROM "WorkflowEvent" e
        WHERE e."processedAt" IS NULL
        ORDER BY e."tenancyId", e."type"
        LIMIT 1
      )
      UNION ALL
      SELECT next_pair."tenancyId", next_pair."type"
      FROM pending_pairs p
      CROSS JOIN LATERAL (
        SELECT e."tenancyId", e."type"
        FROM "WorkflowEvent" e
        WHERE e."processedAt" IS NULL AND (e."tenancyId", e."type") > (p."tenancyId", p."type")
        ORDER BY e."tenancyId", e."type"
        LIMIT 1
      ) next_pair
    ),
    listened AS (${LISTENED_EVENT_TYPES_SQL}),
    unlistened AS (
      SELECT p."tenancyId", p."type"
      FROM pending_pairs p
      WHERE NOT EXISTS (
        SELECT 1 FROM listened l WHERE l."tenancyId" = p."tenancyId" AND l."type" = p."type"
      )
      LIMIT ${EVENT_SWEEP_PAIR_LIMIT}
    ),
    swept AS (
      SELECT pending."tenancyId", pending."id"
      FROM unlistened u
      CROSS JOIN LATERAL (
        SELECT e."tenancyId", e."id"
        FROM "WorkflowEvent" e
        WHERE e."processedAt" IS NULL AND e."tenancyId" = u."tenancyId" AND e."type" = u."type"
        LIMIT ${EVENT_SWEEP_LIMIT}
        FOR UPDATE SKIP LOCKED
      ) pending
      LIMIT ${EVENT_SWEEP_LIMIT}
    )
    UPDATE "WorkflowEvent" e
    SET "processedAt" = NOW()
    FROM swept
    WHERE e."tenancyId" = swept."tenancyId" AND e."id" = swept."id" AND e."processedAt" IS NULL
  `);
}

/**
 * Claims the oldest due events that some workflow listens to, skipping every
 * tenancy another tick is currently dispatching. One tenancy's events are
 * therefore dispatched by one tick at a time, oldest first, while overlapping
 * ticks work on different tenancies instead of repeating each other's batch.
 * `onConflict: "cancel-existing"` leans on that order (the newest event should
 * win). It is best-effort, not a guarantee: an event that fails and backs off
 * is retried after the tenancy's later events, exactly as before claims.
 *
 * Returns nothing when another tick is claiming right now; that tick's batch
 * is the one this claim would have had to step around anyway.
 *
 * Like the sweep, the cost does not depend on the size of the backlog: it
 * starts from the tenancies that have workflows and probes each one's oldest
 * due events per listened type, rather than walking pending events in global
 * time order (which made every claim step over all the rows of whichever
 * tenancy was mid-dispatch, while holding the lock).
 */
async function claimDueEvents(): Promise<WorkflowEventRow[]> {
  const events = await retryTransaction(globalPrismaClient, async (tx) => {
    // Without the lock, two ticks claiming at the same instant would each
    // compute "busy tenancies" from a snapshot that predates the other's
    // claim, and both would take the same tenancy. It is taken in its own
    // statement so that the claim statement's snapshot (READ COMMITTED: one
    // per statement) is newer than the previous holder's commit, and with
    // try-lock so that ticks never queue up behind a slow claim.
    const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${WORKFLOW_EVENT_CLAIM_LOCK_ID}) AS "locked"`;
    if (!lock[0].locked) return [];
    return await tx.$queryRaw<WorkflowEventRow[]>(Prisma.sql`
      WITH busy AS (
        SELECT DISTINCT "tenancyId"
        FROM "WorkflowEvent"
        WHERE "processedAt" IS NULL AND "claimedUntil" > NOW()
      ),
      listened AS (${LISTENED_EVENT_TYPES_SQL}),
      candidates AS (
        SELECT l."tenancyId", due."id", due."scheduledAt"
        FROM listened l
        CROSS JOIN LATERAL (
          SELECT e."id", e."scheduledAt"
          FROM "WorkflowEvent" e
          WHERE e."processedAt" IS NULL
            AND e."tenancyId" = l."tenancyId"
            AND e."type" = l."type"
            AND e."retryAt" <= NOW()
          ORDER BY e."scheduledAt" ASC
          LIMIT ${EVENT_TENANCY_BATCH_SIZE}
        ) due
        WHERE NOT EXISTS (SELECT 1 FROM busy b WHERE b."tenancyId" = l."tenancyId")
      ),
      ranked AS (
        SELECT c."tenancyId", c."id", c."scheduledAt",
          ROW_NUMBER() OVER (PARTITION BY c."tenancyId" ORDER BY c."scheduledAt" ASC, c."id" ASC) AS "position"
        FROM candidates c
      ),
      picked AS (
        SELECT r."tenancyId", r."id"
        FROM ranked r
        WHERE r."position" <= ${EVENT_TENANCY_BATCH_SIZE}
        ORDER BY r."scheduledAt" ASC, r."id" ASC
        LIMIT ${EVENT_BATCH_SIZE}
      ),
      selected AS (
        SELECT e."tenancyId", e."id"
        FROM "WorkflowEvent" e
        JOIN picked ON picked."tenancyId" = e."tenancyId" AND picked."id" = e."id"
        WHERE e."processedAt" IS NULL
        FOR UPDATE OF e SKIP LOCKED
      )
      UPDATE "WorkflowEvent" e
      SET "claimedUntil" = NOW() + make_interval(secs => ${EVENT_CLAIM_LEASE_MS / 1000})
      FROM selected
      WHERE e."tenancyId" = selected."tenancyId" AND e."id" = selected."id"
      RETURNING e."tenancyId", e."id", e."type", e."payload", e."scheduledAt", e."processingAttempts"
    `);
  }, { timeout: EVENT_CLAIM_TRANSACTION_TIMEOUT_MS });
  // UPDATE ... RETURNING does not preserve the subquery's order.
  return events.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || stringCompare(a.id, b.id));
}

async function updateClaimedEvents(events: WorkflowEventRow[], set: Prisma.Sql): Promise<void> {
  if (events.length === 0) return;
  await globalPrismaClient.$executeRaw(Prisma.sql`
    UPDATE "WorkflowEvent" e
    SET ${set}
    FROM unnest(${events.map((event) => event.tenancyId)}::uuid[], ${events.map((event) => event.id)}::uuid[]) AS claimed("tenancyId", "id")
    WHERE e."tenancyId" = claimed."tenancyId" AND e."id" = claimed."id" AND e."processedAt" IS NULL
  `);
}

async function markEventsProcessed(events: WorkflowEventRow[]): Promise<void> {
  await updateClaimedEvents(events, Prisma.sql`"processedAt" = NOW(), "claimedUntil" = NULL`);
}

/** Hands claimed events back untouched, so the next tick can take them without waiting out the lease. */
async function releaseClaimedEvents(events: WorkflowEventRow[]): Promise<void> {
  await updateClaimedEvents(events, Prisma.sql`"claimedUntil" = NULL`);
}

/**
 * Creates the runs for one claimed event and marks it processed. Returns
 * false, leaving the event untouched, when the deadline arrived before every
 * matching definition was handled.
 */
async function dispatchEvent(
  event: WorkflowEventRow,
  matching: DefinitionWithManifest[],
  tenancyCache: Map<string, Tenancy | null>,
  deadlineMs: number,
  precomputedRunKeys: Map<string, WorkflowSandboxOutcome>,
): Promise<boolean> {
  const tenancy = await getCachedTenancy(event.tenancyId, tenancyCache);
  const skippedPausedWorkflowIds = new Set<string>();
  if (tenancy != null) {
    const pausedWorkflowIds = await listPausedWorkflowIdsForTenancy(event.tenancyId);
    for (const definition of matching) {
      // Paused workflows consume their matching events without dispatching
      // them. The event is still marked processed below (it may match
      // other, unpaused definitions), so events the engine sees during a
      // pause are dropped rather than queued up for the resume. The
      // boundary is approximate by design: an event enqueued shortly
      // before a resume can still dispatch if no tick reached it while the
      // workflow was paused.
      if (pausedWorkflowIds.has(definition.workflowId)) {
        skippedPausedWorkflowIds.add(definition.workflowId);
        continue;
      }
      // runKey derivation is itself a sandbox invocation. Leave the
      // event unprocessed once the latest-start deadline arrives;
      // deterministic run ids make replay safe for definitions that
      // were already handled in this partial pass.
      if (Date.now() >= deadlineMs) return false;
      await createRunForEvent(tenancy, event, definition, precomputedRunKeys.get(precomputedRunKeyId(event, definition)));
    }
  }
  if (skippedPausedWorkflowIds.size > 0) {
    // A resume that commits after the pause snapshot above must keep the event
    // pending; otherwise marking it processed would permanently drop the
    // resumed workflow's run. FOR SHARE makes a concurrent resume either
    // visible here or wait until processedAt has committed.
    return await retryTransaction(globalPrismaClient, async (tx) => {
      const rows = await tx.$queryRaw<{ workflowId: string }[]>(Prisma.sql`
        SELECT "workflowId" FROM "WorkflowDefinition"
        WHERE "tenancyId" = ${event.tenancyId}::uuid AND "pausedAt" IS NOT NULL
        FOR SHARE
      `);
      if (didAnySkippedWorkflowResume(skippedPausedWorkflowIds, new Set(rows.map((row) => row.workflowId)))) return false;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "WorkflowEvent" SET "processedAt" = NOW(), "claimedUntil" = NULL
        WHERE "tenancyId" = ${event.tenancyId}::uuid AND "id" = ${event.id}::uuid AND "processedAt" IS NULL
      `);
      return true;
    });
  }
  await markEventsProcessed([event]);
  return true;
}

function precomputedRunKeyId(event: WorkflowEventRow, definition: DefinitionWithManifest): string {
  return `${event.id}:${definition.workflowId}:${definition.latestVersion}`;
}

/**
 * Derives the run keys of one tenancy's claimed events up front, with one
 * sandbox invocation per workflow version instead of one per (event,
 * workflow): a runKey is almost always a property lookup, and starting a VM
 * for each one capped a tenancy's dispatch at roughly one event per VM
 * round trip. The events themselves are still dispatched serially and in
 * order afterward, so onConflict semantics are unchanged.
 *
 * Purely an optimization: it never throws, and an event it does not resolve
 * (the batch failed, or the bundle cannot be batched) derives its key on its
 * own in createRunForEvent, exactly as before.
 */
async function precomputeRunKeys(
  tenancyId: string,
  entries: { event: WorkflowEventRow, matching: DefinitionWithManifest[] }[],
  deadlineMs: number,
): Promise<Map<string, WorkflowSandboxOutcome>> {
  const precomputed = new Map<string, WorkflowSandboxOutcome>();
  let pausedWorkflowIds: Set<string>;
  try {
    pausedWorkflowIds = await listPausedWorkflowIdsForTenancy(tenancyId);
  } catch (error) {
    captureError("workflow-run-key-batch", error);
    return precomputed;
  }

  // One chunk per invocation: a workflow's events, split by serialized size.
  const chunks: { definition: DefinitionWithManifest, events: WorkflowEventRow[] }[] = [];
  const openChunks = new Map<string, { chunk: (typeof chunks)[number], bytes: number }>();
  for (const { event, matching } of entries) {
    const eventBytes = Buffer.byteLength(JSON.stringify(eventToSandboxEvent(event)));
    for (const definition of matching) {
      if (!definition.manifest.has_run_key || pausedWorkflowIds.has(definition.workflowId)) continue;
      let open = openChunks.get(definition.workflowId);
      if (open == null || (open.chunk.events.length > 0 && open.bytes + eventBytes > RUN_KEY_BATCH_MAX_INPUT_BYTES)) {
        open = { chunk: { definition, events: [] }, bytes: 0 };
        chunks.push(open.chunk);
        openChunks.set(definition.workflowId, open);
      }
      open.chunk.events.push(event);
      open.bytes += eventBytes;
    }
  }

  // Each chunk settles on its own (every failure is caught inside), so no
  // invocation is ever left running once this returns.
  await Promise.all(Array.from({ length: Math.min(RUN_KEY_BATCH_CONCURRENCY, chunks.length) }, async () => {
    for (let chunk = chunks.shift(); chunk != null; chunk = chunks.shift()) {
      if (Date.now() >= deadlineMs) return;
      const { definition, events } = chunk;
      try {
        const versionRow = await loadWorkflowVersion(tenancyId, definition.workflowId, definition.latestVersion);
        if (versionRow == null) continue;
        const batch = await invokeWorkflowRunKeyBatch({
          compiledBundle: versionRow.compiledBundle,
          inputs: events.map(runKeySandboxInput),
          nodeModules: getStdlibNodeModules(versionRow),
          timeoutMs: RUN_KEY_INVOCATION_TIMEOUT_MS,
        });
        if (batch == null) continue;
        if (batch.status === "error") {
          captureError("workflow-run-key-batch", new HexclaveAssertionError(`Workflow run-key batch failed; its events fall back to one invocation each: ${batch.error.message}`, { tenancyId, workflowId: definition.workflowId, eventCount: events.length, invocationId: batch.error.invocationId }));
          continue;
        }
        batch.data.forEach((item, index) => {
          if (item.status === "ok") precomputed.set(precomputedRunKeyId(events[index], definition), item.data);
        });
      } catch (error) {
        captureError("workflow-run-key-batch", error);
      }
    }
  }));
  return precomputed;
}

/**
 * Dispatches one tenancy's claimed events, serially and in scheduledAt order.
 * Events not started by the deadline are released rather than left to their
 * lease.
 */
async function dispatchTenancyEvents(
  entries: { event: WorkflowEventRow, matching: DefinitionWithManifest[] }[],
  tenancyCache: Map<string, Tenancy | null>,
  deadlineMs: number,
): Promise<void> {
  const precomputedRunKeys = entries.length === 0 ? new Map<string, WorkflowSandboxOutcome>() : await precomputeRunKeys(entries[0].event.tenancyId, entries, deadlineMs);
  for (let index = 0; index < entries.length; index++) {
    const { event, matching } = entries[index];
    let finished = false;
    if (Date.now() < deadlineMs) {
      try {
        finished = await dispatchEvent(event, matching, tenancyCache, deadlineMs, precomputedRunKeys);
      } catch (error) {
        captureError("workflow-event-processing", error);
        const nextAttempt = event.processingAttempts + 1;
        const retryDelayMs = workflowEventRetryDelayMs(nextAttempt);
        // Clearing the claim lets this tenancy's later events go on dispatching
        // while this one backs off: one poison event must not stall the rest.
        await globalPrismaClient.workflowEvent.updateMany({
          where: { tenancyId: event.tenancyId, id: event.id, processedAt: null },
          data: {
            processingAttempts: { increment: 1 },
            retryAt: new Date(Date.now() + retryDelayMs),
            claimedUntil: null,
          },
        });
        continue;
      }
    }
    if (!finished) {
      // Out of time. Deliberately outside the try above: a release that fails
      // is a bookkeeping problem, not a failed dispatch of this event.
      await releaseClaimedEvents(entries.slice(index).map((entry) => entry.event));
      return;
    }
  }
}

async function processWorkflowEvents(tenancyCache: Map<string, Tenancy | null>, deadlineMs: number): Promise<boolean> {
  // Nothing in this phase may throw out of the tick: run execution comes
  // after it in the same pass, and a transient failure here (a deadlock, a
  // claim that timed out) must cost one pass of event dispatch, not that too.
  let sweptCount = 0;
  try {
    sweptCount = await sweepUnlistenedEvents();
  } catch (error) {
    captureError("workflow-event-sweep", error);
  }

  // Events are claimed (lease + per-tenancy exclusivity, see claimDueEvents)
  // and only marked processed AFTER all their runs exist. Run creation is
  // idempotent (deterministic ids), so a crash mid-batch — or a lease that
  // expires under a slow batch — replays safely: at-least-once dispatch with
  // no duplicate runs.
  const claimedAtMs = Date.now();
  let events: WorkflowEventRow[];
  try {
    events = await claimDueEvents();
  } catch (error) {
    captureError("workflow-event-claim", error);
    return sweptCount > 0;
  }
  if (events.length === 0) return sweptCount > 0;
  const eventDeadlineMs = Math.min(deadlineMs, claimedAtMs + EVENT_CLAIM_WORK_BUDGET_MS);

  let matchedByTenancy: Map<string, { event: WorkflowEventRow, matching: DefinitionWithManifest[] }[]>;
  try {
    // Definitions are read once for the whole batch and BEFORE any tenancy is
    // loaded: an event that matches no trigger needs neither the (expensive)
    // tenancy nor a statement of its own. The sweep already took the events
    // whose type nobody listens to; what is left unmatched here is mostly
    // schedule occurrences of a trigger that has since changed.
    const definitionsByTenancy = await listDefinitionsForTenancies([...new Set(events.map((event) => event.tenancyId))]);
    const partition = partitionClaimedWorkflowEvents(events, definitionsByTenancy);
    await markEventsProcessed(partition.unmatched);
    matchedByTenancy = partition.matchedByTenancy;
  } catch (error) {
    captureError("workflow-event-batch", error);
    // Give the whole batch back; otherwise up to EVENT_BATCH_SIZE tenancies
    // would sit claimed and undispatched for the full lease.
    try {
      await releaseClaimedEvents(events);
    } catch (releaseError) {
      captureError("workflow-event-batch-release", releaseError);
    }
    return true;
  }

  const tenancyQueue = [...matchedByTenancy.values()];
  await Promise.all(Array.from({ length: Math.min(EVENT_TENANCY_CONCURRENCY, tenancyQueue.length) }, async () => {
    for (let entries = tenancyQueue.shift(); entries != null; entries = tenancyQueue.shift()) {
      try {
        await dispatchTenancyEvents(entries, tenancyCache, eventDeadlineMs);
      } catch (error) {
        // Only bookkeeping can throw here (per-event failures are handled
        // inside). Events left claimed become claimable again when the lease
        // expires; the other tenancies of this batch must still be dispatched.
        captureError("workflow-event-dispatch", error);
      }
    }
  }));
  return true;
}

// ─── Run execution ─────────────────────────────────────────────────────────

type ClaimedRunRow = {
  tenancyId: string,
  id: string,
  workflowId: string,
  version: number,
  runKey: string | null,
  triggerEventId: string | null,
  triggerType: string,
  triggerPayload: unknown,
  currentStepAttempt: number,
  currentStepKey: string | null,
  retryEpoch: number,
  memoTotalBytes: number,
  leaseToken: string,
  /** The state the run was claimed OUT OF — a SLEEPING claim means its durable timer just fired. */
  preClaimState: "QUEUED" | "SLEEPING" | "RUNNING",
  preClaimWakeAt: Date | null,
};

async function claimDueRuns(): Promise<ClaimedRunRow[]> {
  return await globalPrismaClient.$queryRaw<ClaimedRunRow[]>(Prisma.sql`
    WITH busy AS (
      SELECT "tenancyId", "workflowId", COUNT(*) AS "count"
      FROM "WorkflowRun"
      WHERE "state" = 'RUNNING' AND "leaseUntil" > NOW()
      GROUP BY "tenancyId", "workflowId"
    ),
    selected AS (
      SELECT r."tenancyId", r."id", r."state" AS "preClaimState", r."wakeAt" AS "preClaimWakeAt"
      FROM "WorkflowRun" r
      LEFT JOIN busy b ON b."tenancyId" = r."tenancyId" AND b."workflowId" = r."workflowId"
      WHERE (
        (r."state" = 'QUEUED' AND (r."wakeAt" IS NULL OR r."wakeAt" <= NOW()))
        OR (r."state" = 'SLEEPING' AND r."wakeAt" <= NOW())
        OR (r."state" = 'RUNNING' AND r."leaseUntil" <= NOW())
      )
      AND EXISTS (
        SELECT 1 FROM "WorkflowDefinition" d
        WHERE d."tenancyId" = r."tenancyId" AND d."workflowId" = r."workflowId"
      )
      AND COALESCE(b."count", 0) < ${PER_WORKFLOW_CONCURRENCY}
      ORDER BY r."wakeAt" ASC NULLS FIRST
      LIMIT ${RUN_CLAIM_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "WorkflowRun" r
    SET "state" = 'RUNNING', "leaseUntil" = NOW() + make_interval(secs => ${RUN_LEASE_MS / 1000}), "leaseToken" = gen_random_uuid(), "wakeAt" = NULL, "updatedAt" = NOW()
    FROM selected
    WHERE r."tenancyId" = selected."tenancyId" AND r."id" = selected."id"
    RETURNING r."tenancyId", r."id", r."workflowId", r."version", r."runKey", r."triggerEventId", r."triggerType", r."triggerPayload", r."currentStepAttempt", r."currentStepKey", r."retryEpoch", r."memoTotalBytes", r."leaseToken", selected."preClaimState"::text AS "preClaimState", selected."preClaimWakeAt"
  `);
}

async function loadStepBag(tenancyId: string, runId: string): Promise<Record<string, WorkflowSandboxStepBagEntry>> {
  const rows = await globalPrismaClient.workflowStepResult.findMany({
    where: { tenancyId, runId },
  });
  return Object.fromEntries(rows.map((row) => [row.stepKey, {
    kind: row.kind === "RUN" ? "run" as const : "sleep" as const,
    stepId: row.stepId,
    result: row.result,
  }]));
}

async function recordStepAttempt(options: {
  client?: PrismaClientTransaction,
  tenancyId: string,
  runId: string,
  stepKey: string,
  stepId: string,
  /** WorkflowRun.retryEpoch; part of the key so a manual retry's attempts don't collide with the original execution's. */
  retryEpoch: number,
  attempt: number,
  outcome: "SUCCEEDED" | "FAILED",
  error?: { name: string, message: string, stack?: string },
  failureKind?: "USER" | "PLATFORM",
  logs: string | null,
  startedAt: Date,
}): Promise<void> {
  const client = options.client ?? globalPrismaClient;
  await client.workflowStepAttempt.createMany({
    data: [{
      tenancyId: options.tenancyId,
      runId: options.runId,
      stepKey: options.stepKey,
      stepId: options.stepId,
      retryEpoch: options.retryEpoch,
      attempt: options.attempt,
      outcome: options.outcome,
      error: options.error,
      failureKind: options.failureKind,
      logs: options.logs,
      startedAt: options.startedAt,
      finishedAt: new Date(),
    }],
    skipDuplicates: true,
  });
}

/**
 * Guarded state transition: only applies while the run is still RUNNING
 * (i.e. it wasn't canceled — cancellation is race-safe against concurrently
 * executing runs precisely because every post-invocation transition checks
 * this) AND still holds the claimant's fencing token (a stale worker whose
 * lease expired mid-invocation cannot clobber the new claimant's state).
 * Returns whether the transition applied.
 */
async function transitionRunFromRunningWithClient(client: PrismaClientTransaction, tenancyId: string, runId: string, leaseToken: string, set: Prisma.Sql): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "WorkflowRun"
    SET ${set}, "updatedAt" = NOW()
    WHERE "tenancyId" = ${tenancyId}::uuid AND "id" = ${runId}::uuid AND "state" = 'RUNNING' AND "leaseToken" = ${leaseToken}::uuid
    RETURNING "id"
  `);
  return rows.length > 0;
}

async function transitionRunFromRunning(tenancyId: string, runId: string, leaseToken: string, set: Prisma.Sql): Promise<boolean> {
  return await transitionRunFromRunningWithClient(globalPrismaClient, tenancyId, runId, leaseToken, set);
}

/**
 * Moves a claimed run to a terminal state. Kept as a named wrapper (rather than
 * inlining `transitionRunFromRunning`) because callers identify the run by the
 * same descriptor they use elsewhere, and the extra fields document which run
 * is ending at each call site.
 */
async function transitionRunToTerminalState(options: {
  tenancy: Tenancy,
  leaseToken: string,
  set: Prisma.Sql,
  run: { id: string, workflowId: string, runKey: string | null, version: number, triggerType: string },
}): Promise<boolean> {
  return await transitionRunFromRunning(options.tenancy.id, options.run.id, options.leaseToken, options.set);
}

async function recordCompletedSleepsAtomically(options: {
  tenancy: Tenancy,
  run: ClaimedRunRow,
  version: number,
  sleeps: { stepKey: string, stepId: string, untilMillis: number }[],
}): Promise<{ continued: boolean, memoTotalBytes: number }> {
  if (options.sleeps.length === 0) {
    return { continued: true, memoTotalBytes: options.run.memoTotalBytes };
  }

  return await retryTransaction(globalPrismaClient, async (tx) => {
    const uniqueSleeps = new Map(options.sleeps.map((sleep) => [sleep.stepKey, sleep]));
    const existing = await tx.workflowStepResult.findMany({
      where: {
        tenancyId: options.run.tenancyId,
        runId: options.run.id,
        stepKey: { in: [...uniqueSleeps.keys()] },
      },
      select: { stepKey: true },
    });
    const existingKeys = new Set(existing.map((row) => row.stepKey));
    const pendingRows: {
      tenancyId: string,
      runId: string,
      stepKey: string,
      stepId: string,
      kind: "SLEEP",
      result: { until: string },
      resultSizeBytes: number,
      attempts: number,
      executedAtVersion: number,
    }[] = [...uniqueSleeps.values()]
      .filter((sleep) => !existingKeys.has(sleep.stepKey))
      .map((sleep) => {
        const result = { until: new Date(sleep.untilMillis).toISOString() };
        const resultSizeBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
        return {
          tenancyId: options.run.tenancyId,
          runId: options.run.id,
          stepKey: sleep.stepKey,
          stepId: sleep.stepId,
          kind: "SLEEP",
          result,
          resultSizeBytes,
          attempts: 1,
          executedAtVersion: options.version,
        };
      });
    if (pendingRows.length === 0) {
      return { continued: true, memoTotalBytes: options.run.memoTotalBytes };
    }

    const insertedBytes = pendingRows.reduce((sum, row) => sum + row.resultSizeBytes, 0);
    const memoTotalBytes = options.run.memoTotalBytes + insertedBytes;
    if (memoTotalBytes > WORKFLOW_RUN_MEMO_MAX_BYTES) {
      const summary = `Total memoized state would reach ${memoTotalBytes} bytes, exceeding the ${WORKFLOW_RUN_MEMO_MAX_BYTES}-byte (4 MiB) per-run limit. Store large payloads externally and keep step results small.`;
      const failed = await transitionRunFromRunningWithClient(tx, options.run.tenancyId, options.run.id, options.run.leaseToken, Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'USER', "errorSummary" = ${summary}`);
      return { continued: false, memoTotalBytes: options.run.memoTotalBytes };
    }

    // Fence before inserting: cancellation or lease loss makes the update a
    // no-op, and because the facts are written later in this same
    // transaction they cannot survive without their memo accounting.
    const transitioned = await transitionRunFromRunningWithClient(tx, options.run.tenancyId, options.run.id, options.run.leaseToken, Prisma.sql`"memoTotalBytes" = ${memoTotalBytes}, "leaseUntil" = NOW() + make_interval(secs => ${RUN_LEASE_MS / 1000})`);
    if (!transitioned) {
      return { continued: false, memoTotalBytes: options.run.memoTotalBytes };
    }
    await tx.workflowStepResult.createMany({
      data: pendingRows,
      skipDuplicates: true,
    });
    return { continued: true, memoTotalBytes };
  });
}

/**
 * Hands a claimed run back to the queue when the tick runs out of time,
 * keeping its place: its wakeAt is restored to what it was when claimed, so
 * a run that merely drew a late claim is not sent behind every other due run.
 */
async function handBackRunAtDeadline(run: ClaimedRunRow): Promise<void> {
  await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'QUEUED', "wakeAt" = ${run.preClaimWakeAt}, "leaseUntil" = NULL`);
}

async function executeClaimedRun(run: ClaimedRunRow, tenancy: Tenancy, deadlineMs: number): Promise<void> {
  if (Date.now() >= deadlineMs) {
    if (run.preClaimState === "SLEEPING") {
      // Nothing has happened yet, in particular the fired sleep has not been
      // recorded (below). Requeueing it as QUEUED would lose that: the next
      // claim would not know the timer fired, and a relative step.sleep
      // would re-arm from the current clock on replay.
      await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'SLEEPING', "wakeAt" = ${run.preClaimWakeAt}, "leaseUntil" = NULL`);
    } else {
      await handBackRunAtDeadline(run);
    }
    return;
  }
  const versionRowInitial = await loadWorkflowVersion(run.tenancyId, run.workflowId, run.version);
  if (versionRowInitial == null) {
    captureError("workflow-run-version-missing", new HexclaveAssertionError("Workflow run pinned to a nonexistent version", { run }));
    await transitionRunToTerminalState({
      tenancy,
      leaseToken: run.leaseToken,
      set: Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'PLATFORM', "errorSummary" = ${GENERIC_PLATFORM_ERROR_SUMMARY}`,
      run: { id: run.id, workflowId: run.workflowId, runKey: run.runKey, version: run.version, triggerType: run.triggerType },
    });
    return;
  }

  // A run that was canceled between the claim committing and us starting has
  // no business executing a step: the side effect would fire and only then be
  // discarded by the guarded transition. This narrows that window rather than
  // closing it — a cancellation landing one millisecond later still gets
  // through — but the run token's live-state check then blocks the sandbox's
  // first-party API calls. Cheap unlocked read; no lock is needed now that
  // nothing is being persisted here.
  const stillClaimed = await globalPrismaClient.workflowRun.findUnique({
    where: { tenancyId_id: { tenancyId: run.tenancyId, id: run.id } },
    select: { state: true, leaseToken: true },
  });
  if (stillClaimed == null || stillClaimed.state !== "RUNNING" || stillClaimed.leaseToken !== run.leaseToken) {
    if (stillClaimed != null && stillClaimed.state === "RUNNING" && stillClaimed.leaseToken !== run.leaseToken) {
      // The claim committed microseconds ago with a 12-minute lease, so losing
      // it here should be impossible. Report it: if this ever became
      // systematically true the symptom would be every run silently doing
      // nothing forever (re-claimed each time the lease expires, no-op each
      // time, no state change and no logs).
      captureError("workflow-run-lease-lost-immediately-after-claim", new HexclaveAssertionError(
        "Workflow run lost its lease between claim and execution",
        { tenancyId: run.tenancyId, runId: run.id, workflowId: run.workflowId },
      ));
    }
    return;
  }

  // Short-lived project-server credentials, minted per claim. Workflow source
  // is admin-authored, but it only ever needs to read and write project data,
  // so it receives the ServerApp surface and a token the auth path refuses on
  // admin-type requests. The expiry must cover the longest possible CHAIN of
  // steps under this claim
  // (the lease is renewed at every step boundary, but the credential is not
  // re-minted). Worst case: the loop's deadline check admits one more
  // invocation at up to 150s after the tick started, that invocation may run
  // for the full 630s engine-side backstop, and the provider sandbox outlives
  // it by 30s — ~13.5min total against a 35min TTL. MAX_CHAINED_STEPS_PER_CLAIM
  // never binds; the tick deadline does. Nothing is persisted — see
  // run-token.tsx for why, and for the properties the token relies on.
  const runToken = await createWorkflowRunToken({
    projectId: tenancy.project.id,
    tenancyId: run.tenancyId,
    branchId: tenancy.branchId,
    runId: run.id,
    workflowId: run.workflowId,
    leaseToken: run.leaseToken,
    expiresInMs: WORKFLOW_RUN_TOKEN_TTL_MS,
  });
  // Annotated so that re-adding an admin key here is a compile error rather
  // than a silent restoration of admin scope: passed as a variable into the
  // input literal below, this object would otherwise never see an
  // excess-property check.
  const credentials: WorkflowSandboxCredentials = {
    apiUrl: getWorkflowsSandboxApiUrl(),
    projectId: tenancy.project.id,
    branchId: tenancy.branchId,
    // The run token rides in the SDK's existing secret-server-key slot.
    // Reusing that slot (rather than adding a dedicated header) keeps the
    // credential change entirely inside the engine — stored bundles pin their
    // runtime shim forever, so a new header would strand every already-synced
    // workflow version. Nothing is put in the admin slot: the token is
    // server-scoped and the auth path rejects it on admin-type requests.
    secretServerKey: runToken,
  };

  const triggerPayload = run.triggerPayload as { ts_millis: number, data: unknown };
  const event: WorkflowSandboxEvent = {
    id: run.triggerEventId ?? throwErr("WorkflowRun has no triggerEventId — runs are always created from events, so this should be impossible"),
    type: run.triggerType,
    tsMillis: triggerPayload.ts_millis,
    data: triggerPayload.data,
  };

  if (run.preClaimState === "SLEEPING") {
    // The durable timer just fired: record the suspended sleep as a fact NOW,
    // at the wake boundary. This must not happen earlier (at suspension) —
    // upgrade divergence decisions rely on probing the target version and
    // seeing it request the still-unmemoized sleep — and it must not be left
    // to the replay: a relative step.sleep would recompute its wake-up time
    // from the CURRENT clock on every replay and re-arm forever.
    const sleepStepKey = run.currentStepKey ?? throwErr("SLEEPING run without currentStepKey — the sleeping transition always records the suspended step");
    const sleepUntil = run.preClaimWakeAt ?? throwErr("SLEEPING run without wakeAt — the sleeping transition always sets the timer");
    const recordedSleeps = await recordCompletedSleepsAtomically({
      tenancy,
      run,
      version: run.version,
      sleeps: [{
        stepKey: sleepStepKey,
        stepId: sleepStepKey.split("#")[0],
        untilMillis: sleepUntil.getTime(),
      }],
    });
    if (!recordedSleeps.continued) return;
    run.memoTotalBytes = recordedSleeps.memoTotalBytes;
  }

  let currentStepAttempt = run.currentStepAttempt;
  let currentVersion = run.version;
  let versionRow = versionRowInitial;

  for (let chained = 0; chained < MAX_CHAINED_STEPS_PER_CLAIM; chained++) {
    // The deadline is a latest-start boundary sized by the route so one full
    // invocation still fits in the function lifetime. Check before every
    // invocation, including the first, rather than only after it returns.
    if (Date.now() >= deadlineMs) {
      await handBackRunAtDeadline(run);
      return;
    }
    if (chained > 0) {
      // An upgrade may have landed between steps (upgrades apply at step
      // boundaries); re-read the pinned version each iteration.
      const freshRun = await globalPrismaClient.workflowRun.findUnique({
        where: { tenancyId_id: { tenancyId: run.tenancyId, id: run.id } },
        select: { version: true, state: true, memoTotalBytes: true },
      });
      if (freshRun == null || freshRun.state !== "RUNNING") return;
      run.memoTotalBytes = freshRun.memoTotalBytes;
      if (freshRun.version !== currentVersion) {
        currentVersion = freshRun.version;
        versionRow = await loadWorkflowVersion(run.tenancyId, run.workflowId, currentVersion)
          ?? throwErr("Upgraded workflow run points at a nonexistent version");
      }
    }

    const bag = await loadStepBag(run.tenancyId, run.id);
    const input: WorkflowSandboxInput = {
      protocolVersion: WORKFLOWS_PROTOCOL_VERSION,
      mode: "execute",
      limits: WORKFLOWS_DEFAULT_LIMITS,
      event,
      steps: bag,
      run: { id: run.id, workflowId: run.workflowId, version: currentVersion },
      credentials,
    };

    const attemptStartedAt = new Date();
    const invocationResult = await invokeWorkflowSandbox({
      compiledBundle: versionRow.compiledBundle,
      input,
      nodeModules: getStdlibNodeModules(versionRow),
      timeoutMs: WORKFLOW_INVOCATION_BACKSTOP_TIMEOUT_MS,
    });

    const lifecycleRun = { id: run.id, workflowId: run.workflowId, runKey: run.runKey, version: currentVersion, triggerType: run.triggerType };

    if (invocationResult.status === "error") {
      // Platform channel: report to our monitoring, retry with the normal
      // backoff, and never show users more than a generic platform-error
      // state. The failure message is generic by construction; the raw
      // detail lives in the invoke-level captures, joined by invocationId.
      captureError("workflow-invocation-failed", new HexclaveAssertionError(
        `Workflow sandbox invocation failed (${invocationResult.error.kind}): ${invocationResult.error.message}`,
        { tenancyId: run.tenancyId, runId: run.id, workflowId: run.workflowId, invocationId: invocationResult.error.invocationId },
      ));
      const attempt = currentStepAttempt + 1;
      await recordStepAttempt({
        tenancyId: run.tenancyId, runId: run.id, stepKey: HANDLER_STEP_KEY, stepId: HANDLER_STEP_KEY, retryEpoch: run.retryEpoch, attempt,
        outcome: "FAILED", error: { name: "PlatformError", message: GENERIC_PLATFORM_ERROR_SUMMARY }, failureKind: "PLATFORM", logs: null, startedAt: attemptStartedAt,
      });
      if (attempt >= WORKFLOW_STEP_MAX_ATTEMPTS) {
        await transitionRunToTerminalState({
          tenancy,
          leaseToken: run.leaseToken,
          set: Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'PLATFORM', "errorSummary" = ${GENERIC_PLATFORM_ERROR_SUMMARY}, "currentStepAttempt" = ${attempt}`,
          run: lifecycleRun,
        });
      } else {
        await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'QUEUED', "wakeAt" = NOW() + make_interval(secs => ${jitteredBackoffMs(attempt) / 1000}), "leaseUntil" = NULL, "currentStepAttempt" = ${attempt}`);
      }
      return;
    }

    const outcome: WorkflowSandboxOutcome = invocationResult.data;
    switch (outcome.type) {
      case "step-completed": {
        const recordedSleeps = await recordCompletedSleepsAtomically({
          tenancy,
          run,
          version: currentVersion,
          sleeps: outcome.completedSleeps,
        });
        if (!recordedSleeps.continued) return;
        run.memoTotalBytes = recordedSleeps.memoTotalBytes;
        // Re-measure server-side rather than trusting the sandbox-reported
        // size: sandboxes run user code, and limits enforced off attacker-
        // controllable numbers are not limits.
        const measuredResultSizeBytes = Buffer.byteLength(JSON.stringify(outcome.result ?? null), "utf8");
        const newMemoTotal = run.memoTotalBytes + measuredResultSizeBytes;
        if (measuredResultSizeBytes > WORKFLOWS_DEFAULT_LIMITS.stepResultMaxBytes) {
          const summary = `step "${outcome.stepId}" returned ${measuredResultSizeBytes} bytes, exceeding the ${WORKFLOWS_DEFAULT_LIMITS.stepResultMaxBytes}-byte step-result limit`;
          await transitionRunToTerminalState({
            tenancy,
            leaseToken: run.leaseToken,
            set: Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'USER', "errorSummary" = ${summary}, "currentStepKey" = ${outcome.stepKey}`,
            run: lifecycleRun,
          });
          return;
        }
        if (newMemoTotal > WORKFLOW_RUN_MEMO_MAX_BYTES) {
          const summary = `Total memoized state would reach ${newMemoTotal} bytes, exceeding the ${WORKFLOW_RUN_MEMO_MAX_BYTES}-byte (4 MiB) per-run limit. Store large payloads externally and keep step results small.`;
          await transitionRunToTerminalState({
            tenancy,
            leaseToken: run.leaseToken,
            set: Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'USER', "errorSummary" = ${summary}, "currentStepKey" = ${outcome.stepKey}`,
            run: lifecycleRun,
          });
          return;
        }
        const continued = await retryTransaction(globalPrismaClient, async (tx) => {
          // The memo counter and the fact it accounts for must commit
          // together. Transition first to enforce the lease fencing token;
          // a concurrent cancellation then wins without leaving an orphaned
          // result that the run's memoTotalBytes does not include.
          const transitioned = await transitionRunFromRunningWithClient(tx, run.tenancyId, run.id, run.leaseToken, Prisma.sql`"memoTotalBytes" = ${newMemoTotal}, "currentStepAttempt" = 0, "currentStepKey" = NULL, "leaseUntil" = NOW() + make_interval(secs => ${RUN_LEASE_MS / 1000})`);
          if (!transitioned) return false;
          await tx.workflowStepResult.createMany({
            data: [{
              tenancyId: run.tenancyId,
              runId: run.id,
              stepKey: outcome.stepKey,
              stepId: outcome.stepId,
              kind: "RUN",
              // `result` is JSON round-tripped by the runtime, so Prisma can
              // store it directly. Nulls are fine: kind RUN results are
              // whatever the step callback returned (undefined -> null).
              result: outcome.result as any,
              resultSizeBytes: measuredResultSizeBytes,
              attempts: currentStepAttempt + 1,
              executedAtVersion: currentVersion,
              elapsedMs: outcome.elapsedMs,
            }],
            skipDuplicates: true,
          });
          await recordStepAttempt({
            client: tx,
            tenancyId: run.tenancyId, runId: run.id, stepKey: outcome.stepKey, stepId: outcome.stepId, retryEpoch: run.retryEpoch, attempt: currentStepAttempt + 1,
            outcome: "SUCCEEDED", logs: outcome.logs, startedAt: attemptStartedAt,
          });
          return true;
        });
        if (!continued) return;
        run.memoTotalBytes = newMemoTotal;
        currentStepAttempt = 0;
        if (Date.now() >= deadlineMs) {
          // Out of tick budget: hand the run back for the next tick.
          await handBackRunAtDeadline(run);
          return;
        }
        continue;
      }
      case "sleeping": {
        if (!Number.isFinite(outcome.untilMillis) || Math.abs(outcome.untilMillis) > 8.64e15) {
          // The runtime validates this, but the value crosses a trust
          // boundary; an unrepresentable Date would crash the transition.
          const summary = `sleep "${outcome.stepId}" has an invalid wake-up time`;
          await transitionRunToTerminalState({
            tenancy,
            leaseToken: run.leaseToken,
            set: Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'USER', "errorSummary" = ${summary}, "currentStepKey" = ${outcome.stepKey}`,
            run: lifecycleRun,
          });
          return;
        }
        const recordedSleeps = await recordCompletedSleepsAtomically({
          tenancy,
          run,
          version: currentVersion,
          sleeps: outcome.completedSleeps,
        });
        if (!recordedSleeps.continued) return;
        run.memoTotalBytes = recordedSleeps.memoTotalBytes;
        await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'SLEEPING', "wakeAt" = ${new Date(outcome.untilMillis)}, "leaseUntil" = NULL, "currentStepAttempt" = 0, "currentStepKey" = ${outcome.stepKey}, "memoTotalBytes" = ${run.memoTotalBytes}`);
        return;
      }
      case "completed": {
        const recordedSleeps = await recordCompletedSleepsAtomically({
          tenancy,
          run,
          version: currentVersion,
          sleeps: outcome.completedSleeps,
        });
        if (!recordedSleeps.continued) return;
        run.memoTotalBytes = recordedSleeps.memoTotalBytes;
        if (outcome.logs != null) {
          // The completing invocation replays the whole handler, so its
          // console output is the run's full final trace — including logs
          // printed between the last step and the return, which no
          // step-attempt row would otherwise capture.
          await recordStepAttempt({
            tenancyId: run.tenancyId, runId: run.id, stepKey: COMPLETION_STEP_KEY, stepId: COMPLETION_STEP_KEY, retryEpoch: run.retryEpoch, attempt: currentStepAttempt + 1,
            outcome: "SUCCEEDED", logs: outcome.logs, startedAt: attemptStartedAt,
          });
        }
        await transitionRunToTerminalState({
          tenancy,
          leaseToken: run.leaseToken,
          set: Prisma.sql`"state" = 'COMPLETED', "completedAt" = NOW(), "leaseUntil" = NULL, "wakeAt" = NULL, "currentStepKey" = NULL, "memoTotalBytes" = ${run.memoTotalBytes}`,
          run: lifecycleRun,
        });
        return;
      }
      case "step-failed":
      case "handler-failed": {
        const recordedSleeps = await recordCompletedSleepsAtomically({
          tenancy,
          run,
          version: currentVersion,
          sleeps: outcome.completedSleeps,
        });
        if (!recordedSleeps.continued) return;
        run.memoTotalBytes = recordedSleeps.memoTotalBytes;
        const stepKey = outcome.type === "step-failed" ? outcome.stepKey : HANDLER_STEP_KEY;
        const stepId = outcome.type === "step-failed" ? outcome.stepId : HANDLER_STEP_KEY;
        const maxAttempts = outcome.type === "step-failed" ? outcome.maxAttempts : WORKFLOW_STEP_MAX_ATTEMPTS;
        const attempt = currentStepAttempt + 1;
        await recordStepAttempt({
          tenancyId: run.tenancyId, runId: run.id, stepKey, stepId, retryEpoch: run.retryEpoch, attempt,
          outcome: "FAILED", error: outcome.error, failureKind: "USER", logs: outcome.logs, startedAt: attemptStartedAt,
        });
        if (outcome.nonRetriable || attempt >= maxAttempts) {
          const summary = `${outcome.error.name}: ${outcome.error.message}` + (outcome.nonRetriable ? "" : ` (${attempt}/${maxAttempts} attempts)`);
          await transitionRunToTerminalState({
            tenancy,
            leaseToken: run.leaseToken,
            set: Prisma.sql`"state" = 'FAILED', "completedAt" = NOW(), "leaseUntil" = NULL, "failureKind" = 'USER', "errorSummary" = ${summary}, "currentStepAttempt" = ${attempt}, "currentStepKey" = ${stepKey}, "memoTotalBytes" = ${run.memoTotalBytes}`,
            run: lifecycleRun,
          });
        } else {
          await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'QUEUED', "wakeAt" = NOW() + make_interval(secs => ${jitteredBackoffMs(attempt) / 1000}), "leaseUntil" = NULL, "currentStepAttempt" = ${attempt}, "currentStepKey" = ${stepKey}, "memoTotalBytes" = ${run.memoTotalBytes}`);
        }
        return;
      }
      default: {
        captureError("workflow-unexpected-outcome", new HexclaveAssertionError(`Unexpected execute outcome type ${(outcome as any).type}`, { runId: run.id }));
        await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'QUEUED', "wakeAt" = NOW() + make_interval(secs => 60), "leaseUntil" = NULL`);
        return;
      }
    }
  }

  // Chain cap reached: hand back to the queue.
  await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'QUEUED', "wakeAt" = NOW(), "leaseUntil" = NULL`);
}

async function executeDueRuns(tenancyCache: Map<string, Tenancy | null>, deadlineMs: number): Promise<boolean> {
  if (Date.now() >= deadlineMs) return false;
  const claimed = await claimDueRuns();
  if (claimed.length === 0) return false;
  await Promise.all(claimed.map(async (run) => {
    try {
      const tenancy = await getCachedTenancy(run.tenancyId, tenancyCache);
      if (tenancy == null) {
        // A deleted tenancy normally cascades the row before this can run;
        // retain the guarded cleanup for an in-flight stale claim.
        await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'CANCELED', "completedAt" = NOW(), "leaseUntil" = NULL`);
        return;
      }
      await executeClaimedRun(run, tenancy, deadlineMs);
    } catch (error) {
      captureError("workflow-run-execution", error);
      // Give the lease back so the run retries promptly rather than waiting
      // out the full lease expiry.
      await transitionRunFromRunning(run.tenancyId, run.id, run.leaseToken, Prisma.sql`"state" = 'QUEUED', "wakeAt" = NOW() + make_interval(secs => 30), "leaseUntil" = NULL`);
    }
  }));
  return true;
}

// ─── Cancel / upgrade / retry (used by the API routes too) ─────────────────

export async function cancelWorkflowRuns(tenancy: Tenancy, filter: { workflowId: string, runKey?: string, runId?: string, state?: "queued" | "running" | "sleeping", version?: number }): Promise<{ canceledCount: number }> {
  // Leaving RUNNING is all it takes to revoke an in-flight run's credential:
  // the run token is checked against live run state on every API call, so
  // there is nothing to delete here. The engine's post-invocation transitions
  // are guarded on state = 'RUNNING', so an in-flight run sees the
  // cancellation rather than overwriting it.
  const stateFilter = filter.state != null ? Prisma.sql`AND "state" = ${filter.state.toUpperCase()}::"WorkflowRunState"` : Prisma.empty;
  const runKeyFilter = filter.runKey != null ? Prisma.sql`AND "runKey" = ${filter.runKey}` : Prisma.empty;
  const runIdFilter = filter.runId != null ? Prisma.sql`AND "id" = ${filter.runId}::uuid` : Prisma.empty;
  const versionFilter = filter.version != null ? Prisma.sql`AND "version" = ${filter.version}` : Prisma.empty;
  const rows = await retryTransaction(globalPrismaClient, async (tx) => {
    const canceled = await tx.$queryRaw<{ id: string, runKey: string | null, version: number, triggerType: string }[]>(Prisma.sql`
      UPDATE "WorkflowRun"
      SET "state" = 'CANCELED', "completedAt" = NOW(), "wakeAt" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW()
      WHERE "tenancyId" = ${tenancy.id}::uuid
        AND "workflowId" = ${filter.workflowId}
        AND "state" IN ('QUEUED', 'RUNNING', 'SLEEPING')
        ${stateFilter}
        ${runKeyFilter}
        ${runIdFilter}
        ${versionFilter}
      RETURNING "id", "runKey", "version", "triggerType"
    `);
    return canceled;
  });
  return { canceledCount: rows.length };
}

const UPGRADE_MAX_RUNS_PER_CALL = 1000;

export async function upgradeWorkflowRuns(tenancy: Tenancy, options: { workflowId: string, toVersion: number, runKey?: string, fromVersion?: number }): Promise<{
  upgradedCount: number,
  skipped: { runId: string, runKey: string | null, fromVersion: number, diagnostic: WorkflowDivergenceDiagnosticJson }[],
}> {
  const targetVersion = await loadWorkflowVersion(tenancy.id, options.workflowId, options.toVersion);
  // Request-input validation, thrown as a StatusError directly so routes
  // never have to pattern-match error messages.
  if (targetVersion == null) throw new StatusError(400, `Workflow version v${options.toVersion} does not exist for workflow ${options.workflowId}`);

  const candidates = await globalPrismaClient.workflowRun.findMany({
    where: {
      tenancyId: tenancy.id,
      workflowId: options.workflowId,
      state: { in: ["QUEUED", "RUNNING", "SLEEPING"] },
      version: { not: options.toVersion, ...(options.fromVersion != null ? { equals: options.fromVersion } : {}) },
      ...(options.runKey != null ? { runKey: options.runKey } : {}),
    },
    take: UPGRADE_MAX_RUNS_PER_CALL,
  });

  let upgradedCount = 0;
  const skipped: { runId: string, runKey: string | null, fromVersion: number, diagnostic: WorkflowDivergenceDiagnosticJson }[] = [];

  for (const candidate of candidates) {
    const skip = async (diagnostic: WorkflowDivergenceDiagnosticJson) => {
      skipped.push({ runId: candidate.id, runKey: candidate.runKey, fromVersion: candidate.version, diagnostic });
      // Persist the latest diagnostic for dashboard display; there is no
      // paused state — the run keeps executing its pinned version.
      await globalPrismaClient.$executeRaw(Prisma.sql`
        UPDATE "WorkflowRun" SET "lastUpgradeDivergence" = ${JSON.stringify(diagnostic)}::jsonb, "updatedAt" = NOW()
        WHERE "tenancyId" = ${tenancy.id}::uuid AND "id" = ${candidate.id}::uuid
      `);
    };

    if (candidate.state === "RUNNING" && candidate.leaseUntil != null && candidate.leaseUntil.getTime() > Date.now()) {
      // Mid-invocation: the step bag is changing underneath us, so any probe
      // decision would be stale by the time we commit it. Safe + reversible:
      // retry the upgrade once the step completes.
      await skip({
        reason: "run-busy",
        suspended_step_key: candidate.currentStepKey,
        found_step_key: null,
        consumed_step_keys: [],
        unconsumed_step_keys: [],
        details: "The run was executing a step for the whole upgrade window. Retry the upgrade once the current step completes.",
      });
      continue;
    }

    const bag = await loadStepBag(tenancy.id, candidate.id);
    const triggerPayload = candidate.triggerPayload as { ts_millis: number, data: unknown };
    const probeResult = await invokeWorkflowSandbox({
      compiledBundle: targetVersion.compiledBundle,
      input: {
        protocolVersion: WORKFLOWS_PROTOCOL_VERSION,
        mode: "probe",
        limits: WORKFLOWS_DEFAULT_LIMITS,
        event: {
          id: candidate.triggerEventId ?? throwErr("run without triggerEventId"),
          type: candidate.triggerType,
          tsMillis: triggerPayload.ts_millis,
          data: triggerPayload.data,
        },
        steps: bag,
      },
      nodeModules: getStdlibNodeModules(targetVersion),
      timeoutMs: 60_000,
    });

    if (probeResult.status === "error") {
      await skip({
        reason: "probe-failed",
        suspended_step_key: candidate.currentStepKey,
        found_step_key: null,
        consumed_step_keys: [],
        unconsumed_step_keys: [],
        details: `The upgrade probe could not run: ${probeResult.error.message}`,
      });
      continue;
    }
    const probe = probeResult.data;
    if (probe.type !== "probe") {
      throw new HexclaveAssertionError(`Unexpected probe outcome type ${probe.type}`, { runId: candidate.id });
    }
    if (probe.threwError != null) {
      await skip({
        reason: "probe-failed",
        suspended_step_key: candidate.currentStepKey,
        found_step_key: probe.firstRequest?.stepKey ?? null,
        consumed_step_keys: probe.consumedStepKeys,
        unconsumed_step_keys: Object.keys(bag).filter((key) => !probe.consumedStepKeys.includes(key)),
        details: `The target version's code threw while replaying this run's recorded facts: ${probe.threwError.name}: ${probe.threwError.message}`,
      });
      continue;
    }

    const unconsumedStepKeys = Object.keys(bag).filter((key) => !probe.consumedStepKeys.includes(key));
    // Mechanical divergence rules (see spec section 5):
    // 1. The target code requests an unknown step while recorded facts sit
    //    unconsumed — it took a different path through the facts.
    // 2. A SLEEPING run can only transfer to code that arrives at the SAME
    //    suspended sleep; anything else would require judgment about the
    //    pending timer that we refuse to make.
    // Completion (with all facts consumed) is always clean: no fact is
    // contradicted, the run simply ends on the target version.
    let diagnostic: WorkflowDivergenceDiagnosticJson | null = null;
    if (probe.firstRequest != null && unconsumedStepKeys.length > 0) {
      diagnostic = {
        reason: "unknown-step-with-unconsumed-facts",
        suspended_step_key: candidate.currentStepKey,
        found_step_key: probe.firstRequest.stepKey,
        consumed_step_keys: probe.consumedStepKeys,
        unconsumed_step_keys: unconsumedStepKeys,
        details: `v${options.toVersion} requests unknown step "${probe.firstRequest.stepKey}" while ${unconsumedStepKeys.length} recorded step(s) were never consumed`,
      };
    } else if (candidate.state === "SLEEPING") {
      const suspendedStepKey = candidate.currentStepKey;
      const arrivesAtSameSleep = probe.firstRequest != null && probe.firstRequest.kind === "sleep" && probe.firstRequest.stepKey === suspendedStepKey;
      if (!arrivesAtSameSleep) {
        diagnostic = {
          reason: "suspended-step-not-reached",
          suspended_step_key: suspendedStepKey,
          found_step_key: probe.firstRequest?.stepKey ?? null,
          consumed_step_keys: probe.consumedStepKeys,
          unconsumed_step_keys: unconsumedStepKeys,
          details: `The run is sleeping on "${suspendedStepKey}", but v${options.toVersion} ${probe.completed ? "completes" : `requests "${probe.firstRequest?.stepKey}"`} instead of reaching that sleep`,
        };
      }
    } else if (probe.completed && unconsumedStepKeys.length > 0) {
      diagnostic = {
        reason: "unknown-step-with-unconsumed-facts",
        suspended_step_key: candidate.currentStepKey,
        found_step_key: null,
        consumed_step_keys: probe.consumedStepKeys,
        unconsumed_step_keys: unconsumedStepKeys,
        details: `v${options.toVersion} completes the run while ${unconsumedStepKeys.length} recorded step(s) were never consumed — the code no longer takes the path these facts belong to`,
      };
    }

    if (diagnostic != null) {
      await skip(diagnostic);
      continue;
    }

    // Optimistic commit: the run must not have changed since we loaded it
    // (same version + same updatedAt). If it moved, report run-busy — the
    // caller can just retry.
    const committed = await globalPrismaClient.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "WorkflowRun"
      SET "version" = ${options.toVersion}, "lastUpgradeDivergence" = NULL, "updatedAt" = NOW()
      WHERE "tenancyId" = ${tenancy.id}::uuid AND "id" = ${candidate.id}::uuid
        AND "version" = ${candidate.version} AND "updatedAt" = ${candidate.updatedAt}
        AND "state" IN ('QUEUED', 'RUNNING', 'SLEEPING')
      RETURNING "id"
    `);
    if (committed.length === 0) {
      await skip({
        reason: "run-busy",
        suspended_step_key: candidate.currentStepKey,
        found_step_key: null,
        consumed_step_keys: probe.consumedStepKeys,
        unconsumed_step_keys: unconsumedStepKeys,
        details: "The run changed state while the upgrade was being decided. Retry the upgrade.",
      });
      continue;
    }
    upgradedCount++;
  }

  return { upgradedCount, skipped };
}

export async function retryFailedWorkflowRun(tenancy: Tenancy, runId: string): Promise<boolean> {
  // Manual re-run from the failed step with a fresh attempt budget. The
  // memoized bag is intact, so the replay resumes exactly where it failed;
  // the run stays pinned to its version.
  // The attempt budget resets to 0, so the re-executed attempts reuse attempt
  // numbers that already exist for this step. Bumping retryEpoch (part of
  // WorkflowStepAttempt's key) keeps them distinct rows — otherwise the
  // skipDuplicates insert silently drops them and the run's attempt history
  // still shows only the original failure, even after a successful retry.
  // The NOT EXISTS guard prevents reviving a keyed run whose key has since
  // been taken by a NEWER active run — flipping to QUEUED would set the
  // generated isActive column and violate the active-run uniqueness index
  // with an unhandled 500 instead of a clean error.
  const rows = await globalPrismaClient.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "WorkflowRun" r
    SET "state" = 'QUEUED', "wakeAt" = NOW(), "currentStepAttempt" = 0, "retryEpoch" = r."retryEpoch" + 1, "failureKind" = NULL, "errorSummary" = NULL, "completedAt" = NULL, "updatedAt" = NOW()
    WHERE r."tenancyId" = ${tenancy.id}::uuid AND r."id" = ${runId}::uuid AND r."state" = 'FAILED'
      AND NOT EXISTS (
        SELECT 1 FROM "WorkflowRun" other
        WHERE other."tenancyId" = r."tenancyId" AND other."workflowId" = r."workflowId"
          AND other."runKey" = r."runKey" AND other."isActive" = TRUE
      )
    RETURNING "id"
  `);
  return rows.length > 0;
}

// ─── Retention ─────────────────────────────────────────────────────────────

const RUN_RETENTION_DAYS = 90;

async function pruneWorkflowRetention(): Promise<void> {
  // A delete can race an event that already cached the old definition. Such
  // a run is never claimable (the claim query also checks the definition),
  // and this cleanup prevents the unclaimable row from accumulating.
  await globalPrismaClient.$executeRaw(Prisma.sql`
    DELETE FROM "WorkflowRun"
    WHERE ("tenancyId", "id") IN (
      SELECT r."tenancyId", r."id" FROM "WorkflowRun" r
      WHERE NOT EXISTS (
        SELECT 1 FROM "WorkflowDefinition" d
        WHERE d."tenancyId" = r."tenancyId" AND d."workflowId" = r."workflowId"
      )
      LIMIT 500
    )
  `);
  // Terminal runs: 90 days of history (step results/attempts cascade).
  await globalPrismaClient.$executeRaw(Prisma.sql`
    DELETE FROM "WorkflowRun"
    WHERE ("tenancyId", "id") IN (
      SELECT "tenancyId", "id" FROM "WorkflowRun"
      WHERE "state" IN ('COMPLETED', 'FAILED', 'CANCELED') AND "completedAt" < NOW() - make_interval(days => ${RUN_RETENTION_DAYS})
      LIMIT 500
    )
  `);
  await globalPrismaClient.$executeRaw(Prisma.sql`
    DELETE FROM "WorkflowEvent"
    WHERE ("tenancyId", "id") IN (
      SELECT "tenancyId", "id" FROM "WorkflowEvent"
      WHERE "processedAt" IS NOT NULL AND "createdAt" < NOW() - make_interval(days => 30)
      LIMIT 1000
    )
  `);
  // Note: there is deliberately nothing to sweep for run credentials. They
  // are signed tokens, not rows.
}

// ─── The tick ──────────────────────────────────────────────────────────────

let stepCounter = 0;

/**
 * One engine step. Returns whether any work was done, so the caller can
 * idle-wait longer between steps when the system is quiet.
 */
export async function runWorkflowEngineStep(options: { deadlineMs: number }): Promise<{ didWork: boolean }> {
  const tenancyCache = new Map<string, Tenancy | null>();
  let didWork = false;
  didWork = await materializeScheduleOccurrences(tenancyCache, options.deadlineMs) || didWork;
  // Dispatch and execution run side by side: run execution must not wait
  // behind a slow dispatch batch (or skip the pass entirely once dispatch has
  // used up the deadline). While dispatch is still going, execution keeps
  // claiming runs — including the ones dispatch is creating — rather than
  // idling until the step ends. Both are awaited before an error propagates,
  // so a failing phase never leaves the other running past the end of the
  // step.
  const dispatchState = { finished: false };
  const [dispatchedEvents, executedRuns] = await Promise.allSettled([
    processWorkflowEvents(tenancyCache, options.deadlineMs).finally(() => {
      dispatchState.finished = true;
    }),
    (async () => {
      let executedAny = await executeDueRuns(tenancyCache, options.deadlineMs);
      while (!dispatchState.finished && Date.now() < options.deadlineMs) {
        if (await executeDueRuns(tenancyCache, options.deadlineMs)) {
          executedAny = true;
        } else {
          await wait(1000);
        }
      }
      return executedAny;
    })(),
  ]);
  if (dispatchedEvents.status === "rejected") throw dispatchedEvents.reason;
  if (executedRuns.status === "rejected") throw executedRuns.reason;
  didWork = dispatchedEvents.value || executedRuns.value || didWork;
  // Retention pruning is cheap but pointless to run every second.
  if (stepCounter++ % 60 === 0) {
    await pruneWorkflowRetention();
  }
  return { didWork };
}
