import { Prisma } from "@/generated/prisma/client";
import { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import {
  WORKFLOW_ID_REGEX,
  type WorkflowManifestJson,
  type WorkflowRunDetailsJson,
  type WorkflowRunJson,
  type WorkflowRunStateJson,
  type WorkflowStepAttemptJson,
  type WorkflowStepResultJson,
  type WorkflowSummaryJson,
  type WorkflowSyncResultJson,
  type WorkflowVersionJson,
} from "@hexclave/shared/dist/interface/workflows";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { compileAndExtractWorkflowManifest } from "./compile";

// Query + serialization layer between the workflows API routes and the DB.
// Routes stay thin: gate check, schema, then a call in here.

// Static route segments under /internal/workflows/ that would shadow a
// workflow of the same name — refuse to create those.
const RESERVED_WORKFLOW_IDS = ["runs", "events", "definitions"];

export function validateWorkflowId(workflowId: string): void {
  if (!WORKFLOW_ID_REGEX.test(workflowId)) {
    throw new StatusError(400, "Workflow ids must be 1-64 chars of lowercase letters, digits, and dashes");
  }
  if (RESERVED_WORKFLOW_IDS.includes(workflowId)) {
    throw new StatusError(400, `"${workflowId}" is a reserved name and cannot be used as a workflow id`);
  }
}

function getStoredScheduleKeys(manifest: Prisma.JsonValue): string[] {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return throwErr("Stored workflow manifest must be an object");
  }
  const triggers = manifest.triggers;
  if (!Array.isArray(triggers)) {
    return throwErr("Stored workflow manifest must contain a triggers array");
  }
  const scheduleKeys: string[] = [];
  for (const trigger of triggers) {
    if (trigger == null || typeof trigger !== "object" || Array.isArray(trigger)) {
      return throwErr("Stored workflow trigger must be an object");
    }
    if (trigger.type !== "schedule") continue;
    if (typeof trigger.cron !== "string" || typeof trigger.timezone !== "string") {
      return throwErr("Stored workflow schedule trigger must contain cron and timezone strings");
    }
    scheduleKeys.push(`${trigger.cron}|${trigger.timezone}`);
  }
  return scheduleKeys;
}

// ─── Sync (create + save source; every save of changed source mints a version) ───

export async function syncWorkflowSource(tenancy: Tenancy, options: { workflowId: string, source: string, displayName?: string, mustBeNew: boolean }): Promise<WorkflowSyncResultJson> {
  validateWorkflowId(options.workflowId);

  const existing = await globalPrismaClient.workflowDefinition.findUnique({
    where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId: options.workflowId } },
  });
  if (options.mustBeNew && existing != null) {
    throw new StatusError(400, `A workflow with id "${options.workflowId}" already exists`);
  }
  if (!options.mustBeNew && existing == null) {
    throw new StatusError(404, `Workflow "${options.workflowId}" not found`);
  }

  // Compile + manifest-extract BEFORE looking at hashes so invalid source is
  // always rejected with its actual error, even if it matches an old hash.
  const compiled = await compileAndExtractWorkflowManifest(options.source, options.workflowId);
  if (compiled.status === "error") {
    throw new StatusError(400, compiled.error);
  }

  let previousScheduleKeys: string[] = [];
  if (existing != null) {
    const latestVersion = await globalPrismaClient.workflowVersion.findUnique({
      where: { tenancyId_workflowId_version: { tenancyId: tenancy.id, workflowId: options.workflowId, version: existing.latestVersion } },
    }) ?? throwErr("WorkflowDefinition.latestVersion points at a missing version row");
    previousScheduleKeys = getStoredScheduleKeys(latestVersion.manifest);
    if (latestVersion.sourceHash === compiled.data.sourceHash) {
      // Unchanged source (and runtime env): no version minted.
      return {
        workflow_id: options.workflowId,
        version: existing.latestVersion,
        created: false,
        in_flight_runs_on_older_versions: await countInFlightRunsOnOlderVersions(tenancy.id, options.workflowId, existing.latestVersion),
      };
    }
  }

  const newVersionNumber = (existing?.latestVersion ?? 0) + 1;
  const deployedAt = new Date();
  const scheduleKeys = compiled.data.manifest.triggers
    .filter((trigger) => trigger.type === "schedule")
    .map((trigger) => `${trigger.cron}|${trigger.timezone}`);
  const newlyActivatedScheduleKeys = scheduleKeys.filter((scheduleKey) => !previousScheduleKeys.includes(scheduleKey));
  try {
    await retryTransaction(globalPrismaClient, async (tx) => {
      await tx.workflowVersion.create({
        data: {
          tenancyId: tenancy.id,
          workflowId: options.workflowId,
          version: newVersionNumber,
          source: options.source,
          sourceHash: compiled.data.sourceHash,
          compiledBundle: compiled.data.compiledBundle,
          runtimeEnvVersion: compiled.data.runtimeEnvVersion,
          manifest: compiled.data.manifest as any,
        },
      });
      await tx.workflowDefinition.upsert({
        where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId: options.workflowId } },
        create: {
          tenancyId: tenancy.id,
          workflowId: options.workflowId,
          displayName: options.displayName ?? options.workflowId,
          latestVersion: newVersionNumber,
        },
        update: {
          latestVersion: newVersionNumber,
          ...(options.displayName != null ? { displayName: options.displayName } : {}),
        },
      });
      // A cursor starts when its schedule is deployed, not when an engine
      // happens to see it. This preserves occurrences between deployment and
      // the first tick. Removed/edited schedules lose their old cursor so
      // re-adding one cannot backfill the interval in which it was inactive.
      if (scheduleKeys.length === 0) {
        await tx.workflowScheduleCursor.deleteMany({
          where: { tenancyId: tenancy.id, workflowId: options.workflowId },
        });
      } else {
        await tx.workflowScheduleCursor.deleteMany({
          where: {
            tenancyId: tenancy.id,
            workflowId: options.workflowId,
            scheduleKey: { notIn: scheduleKeys },
          },
        });
        // Reset re-activated keys even if an obsolete pre-fix cursor was
        // left behind from an earlier deployment that removed the schedule.
        await tx.workflowScheduleCursor.updateMany({
          where: {
            tenancyId: tenancy.id,
            workflowId: options.workflowId,
            scheduleKey: { in: newlyActivatedScheduleKeys },
          },
          data: { lastMaterializedAt: deployedAt },
        });
        await tx.workflowScheduleCursor.createMany({
          data: scheduleKeys.map((scheduleKey) => ({
            tenancyId: tenancy.id,
            workflowId: options.workflowId,
            scheduleKey,
            lastMaterializedAt: deployedAt,
          })),
          skipDuplicates: true,
        });
      }
    });
  } catch (error) {
    // Unique violation on the version pkey = a concurrent save raced us.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new StatusError(409, "Another save happened concurrently — reload and try again");
    }
    throw error;
  }

  return {
    workflow_id: options.workflowId,
    version: newVersionNumber,
    created: true,
    in_flight_runs_on_older_versions: await countInFlightRunsOnOlderVersions(tenancy.id, options.workflowId, newVersionNumber),
  };
}

async function countInFlightRunsOnOlderVersions(tenancyId: string, workflowId: string, latestVersion: number): Promise<number> {
  return await globalPrismaClient.workflowRun.count({
    where: {
      tenancyId,
      workflowId,
      state: { in: ["QUEUED", "RUNNING", "SLEEPING"] },
      version: { lt: latestVersion },
    },
  });
}

// ─── Listing workflows with stats ──────────────────────────────────────────

type StatsRow = { workflowId: string, total: number, active: number, sleeping: number, failed7d: number };
type VolumeRow = { workflowId: string, day: Date, count: number };

export async function listWorkflowsWithStats(tenancy: Tenancy): Promise<WorkflowSummaryJson[]> {
  // Primary, unlike the aggregates below: the dashboard re-reads this list
  // immediately after every mutation (pause/resume, deploy, delete) to refresh
  // its cache, and replication waiting defaults to "none". Off the replica, a
  // pause can come back reporting the state it had a moment ago and stick
  // there until something else invalidates the cache. This row set is one
  // indexed join per project — the expensive run aggregates stay on the
  // replica, where staleness only costs a slightly old count.
  const definitions = await globalPrismaClient.$queryRaw<{
    workflowId: string,
    displayName: string,
    latestVersion: number,
    createdAt: Date,
    pausedAt: Date | null,
    manifest: WorkflowManifestJson,
    lastDeployedAt: Date,
  }[]>(Prisma.sql`
    SELECT d."workflowId", d."displayName", d."latestVersion", d."createdAt", d."pausedAt", v."manifest", v."createdAt" AS "lastDeployedAt"
    FROM "WorkflowDefinition" d
    JOIN "WorkflowVersion" v
      ON v."tenancyId" = d."tenancyId" AND v."workflowId" = d."workflowId" AND v."version" = d."latestVersion"
    WHERE d."tenancyId" = ${tenancy.id}::uuid
    ORDER BY v."createdAt" DESC, d."workflowId" ASC
  `);
  if (definitions.length === 0) return [];

  const stats = await globalPrismaClient.$replica().$queryRaw<StatsRow[]>(Prisma.sql`
    SELECT "workflowId",
      -- The dashboard's Runs tab shows the full retained history, not only
      -- the operationally active subset counted by the fields below.
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE "state" IN ('QUEUED', 'RUNNING'))::int AS "active",
      COUNT(*) FILTER (WHERE "state" = 'SLEEPING')::int AS "sleeping",
      COUNT(*) FILTER (WHERE "state" = 'FAILED' AND "completedAt" > NOW() - interval '7 days')::int AS "failed7d"
    FROM "WorkflowRun"
    WHERE "tenancyId" = ${tenancy.id}::uuid
    GROUP BY "workflowId"
  `);
  const statsByWorkflow = new Map(stats.map((row) => [row.workflowId, row]));

  const volume = await globalPrismaClient.$replica().$queryRaw<VolumeRow[]>(Prisma.sql`
    SELECT "workflowId", date_trunc('day', "createdAt") AS "day", COUNT(*)::int AS "count"
    FROM "WorkflowRun"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "createdAt" > NOW() - interval '14 days'
    GROUP BY "workflowId", date_trunc('day', "createdAt")
  `);
  const volumeByWorkflow = new Map<string, VolumeRow[]>();
  for (const row of volume) {
    const rows = volumeByWorkflow.get(row.workflowId) ?? [];
    rows.push(row);
    volumeByWorkflow.set(row.workflowId, rows);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = new Date(new Date().toISOString().slice(0, 10)).getTime();

  return definitions.map((definition) => {
    const stat = statsByWorkflow.get(definition.workflowId);
    const runVolume14d = Array.from({ length: 14 }, (_, i) => {
      const bucketStart = todayStart - (13 - i) * dayMs;
      return volumeByWorkflow.get(definition.workflowId)?.find((row) => row.day.getTime() === bucketStart)?.count ?? 0;
    });
    return {
      id: definition.workflowId,
      display_name: definition.displayName,
      latest_version: definition.latestVersion,
      triggers: definition.manifest.triggers,
      is_paused: definition.pausedAt != null,
      paused_at_millis: definition.pausedAt?.getTime() ?? null,
      stats: {
        total_runs: stat?.total ?? 0,
        active_runs: stat?.active ?? 0,
        sleeping_runs: stat?.sleeping ?? 0,
        failed_7d: stat?.failed7d ?? 0,
        run_volume_14d: runVolume14d,
      },
      created_at_millis: definition.createdAt.getTime(),
      last_deployed_at_millis: definition.lastDeployedAt.getTime(),
    };
  });
}

/**
 * Deletes a workflow and all of its version/run history. Deleting the run
 * rows is also what revokes any credential still held by an in-flight
 * sandbox: a run token is validated against live run state, so once the run
 * is gone its token authenticates as `run-not-found`.
 */
export async function deleteWorkflow(tenancy: Tenancy, workflowId: string): Promise<void> {
  validateWorkflowId(workflowId);

  const definition = await globalPrismaClient.workflowDefinition.findUnique({
    where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId } },
    select: { workflowId: true },
  });
  if (definition == null) {
    throw new StatusError(404, `Workflow "${workflowId}" not found`);
  }

  await retryTransaction(globalPrismaClient, async (tx) => {
    // Remove the definition first so subsequent engine ticks stop matching
    // new events while the historical rows are being removed.
    await tx.workflowDefinition.delete({
      where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId } },
    });
    await tx.workflowScheduleCursor.deleteMany({ where: { tenancyId: tenancy.id, workflowId } });
    // Step results and attempts cascade from WorkflowRun.
    await tx.workflowRun.deleteMany({ where: { tenancyId: tenancy.id, workflowId } });
    await tx.workflowVersion.deleteMany({ where: { tenancyId: tenancy.id, workflowId } });
  });
}

/**
 * Pauses or resumes a workflow's intake. Pausing stops NEW runs from being
 * created; runs already in flight keep executing to completion (there is no
 * paused run state — see the note on WorkflowRunStateJson).
 *
 * Resuming also fast-forwards every schedule cursor to the resume instant, in
 * the same transaction as the state change so no concurrent tick can observe
 * a resumed workflow with a stale cursor. Without it, the engine would treat
 * the whole paused interval as a catch-up backlog and materialize every cron
 * occurrence that fell inside it — a month-long pause would resume into
 * tens of thousands of runs. Two limits of that fast-forward, both accepted:
 * it also discards occurrences the engine already owed BEFORE the pause, and
 * it does not retract schedule events already sitting in the outbox — a
 * catch-up flood that was materialized before the pause still dispatches if
 * the operator resumes before the engine finishes draining it.
 */
export async function setWorkflowPaused(tenancy: Tenancy, workflowId: string, isPaused: boolean): Promise<{ isPaused: boolean, pausedAtMillis: number | null }> {
  validateWorkflowId(workflowId);

  const now = new Date();
  const result = await retryTransaction(globalPrismaClient, async (tx) => {
    // One conditional UPDATE rather than read-then-write: this runs at READ
    // COMMITTED, so a check outside the write would let two concurrent
    // toggles both pass it and the loser would report a state it did not
    // commit — for an emergency stop, "reported paused, actually running" is
    // the one outcome worth ruling out structurally. Zero rows updated means
    // the workflow was already in the requested state.
    const updated = await tx.$queryRaw<{ pausedAt: Date | null }[]>(Prisma.sql`
      UPDATE "WorkflowDefinition"
      SET "pausedAt" = ${isPaused ? now : null}, "updatedAt" = NOW()
      WHERE "tenancyId" = ${tenancy.id}::uuid
        AND "workflowId" = ${workflowId}
        AND "pausedAt" IS ${isPaused ? Prisma.sql`NULL` : Prisma.sql`NOT NULL`}
      RETURNING "pausedAt"
    `);

    if (updated.length === 0) {
      // Either the workflow does not exist, or it is already in the requested
      // state — re-pausing keeps the original pausedAt so "paused 3 days ago"
      // stays true, and re-resuming leaves the schedule cursors alone rather
      // than skipping occurrences it never paused through.
      const existing = await tx.workflowDefinition.findUnique({
        where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId } },
        select: { pausedAt: true },
      });
      if (existing == null) return null;
      return { isPaused: existing.pausedAt != null, pausedAtMillis: existing.pausedAt?.getTime() ?? null };
    }

    if (!isPaused) {
      // updateMany alone would miss a schedule whose cursor row does not exist
      // yet, and the engine's self-healing path would then seed that cursor
      // back at the version's deployment time — reopening the catch-up window
      // this fast-forward exists to close. Seed the missing rows here instead.
      const latestVersion = await tx.workflowVersion.findFirst({
        where: { tenancyId: tenancy.id, workflowId },
        orderBy: { version: "desc" },
        select: { manifest: true },
      });
      const scheduleKeys = latestVersion == null ? [] : getStoredScheduleKeys(latestVersion.manifest);
      if (scheduleKeys.length > 0) {
        await tx.workflowScheduleCursor.createMany({
          data: scheduleKeys.map((scheduleKey) => ({ tenancyId: tenancy.id, workflowId, scheduleKey, lastMaterializedAt: now })),
          skipDuplicates: true,
        });
      }
      await tx.workflowScheduleCursor.updateMany({
        where: { tenancyId: tenancy.id, workflowId },
        data: { lastMaterializedAt: now },
      });
    }

    return { isPaused, pausedAtMillis: isPaused ? now.getTime() : null };
  });

  if (result == null) throw new StatusError(404, `Workflow "${workflowId}" not found`);
  return result;
}

export async function listWorkflowVersions(tenancy: Tenancy, workflowId: string): Promise<WorkflowVersionJson[]> {
  const definition = await globalPrismaClient.workflowDefinition.findUnique({
    where: { tenancyId_workflowId: { tenancyId: tenancy.id, workflowId } },
  });
  if (definition == null) throw new StatusError(404, `Workflow "${workflowId}" not found`);

  const versions = await globalPrismaClient.workflowVersion.findMany({
    where: { tenancyId: tenancy.id, workflowId },
    orderBy: { version: "desc" },
    select: { version: true, source: true, sourceHash: true, runtimeEnvVersion: true, createdAt: true },
  });
  const inFlight = await globalPrismaClient.$replica().$queryRaw<{ version: number, count: number }[]>(Prisma.sql`
    SELECT "version", COUNT(*)::int AS "count"
    FROM "WorkflowRun"
    WHERE "tenancyId" = ${tenancy.id}::uuid AND "workflowId" = ${workflowId} AND "state" IN ('QUEUED', 'RUNNING', 'SLEEPING')
    GROUP BY "version"
  `);
  const inFlightByVersion = new Map(inFlight.map((row) => [row.version, row.count]));

  return versions.map((version) => ({
    workflow_id: workflowId,
    version: version.version,
    source: version.source,
    source_hash: version.sourceHash,
    runtime_env_version: version.runtimeEnvVersion,
    is_latest: version.version === definition.latestVersion,
    in_flight_runs: inFlightByVersion.get(version.version) ?? 0,
    created_at_millis: version.createdAt.getTime(),
  }));
}

// ─── Runs ──────────────────────────────────────────────────────────────────

type RunRow = {
  id: string,
  workflowId: string,
  runKey: string | null,
  state: "QUEUED" | "RUNNING" | "SLEEPING" | "COMPLETED" | "FAILED" | "CANCELED",
  version: number,
  triggerType: string,
  triggerPayload: Prisma.JsonValue,
  currentStepKey: string | null,
  errorSummary: string | null,
  failureKind: "USER" | "PLATFORM" | null,
  lastUpgradeDivergence: unknown,
  createdAt: Date,
  completedAt: Date | null,
  wakeAt: Date | null,
  stepsRecorded: number,
};

function triggerPayloadData(payloadEnvelope: Prisma.JsonValue): Prisma.JsonValue | null {
  if (payloadEnvelope == null || typeof payloadEnvelope !== "object" || Array.isArray(payloadEnvelope)) return null;
  return payloadEnvelope.data ?? null;
}

function deriveTriggerSummary(triggerType: string, payloadEnvelope: Prisma.JsonValue): string {
  const data = triggerPayloadData(payloadEnvelope);
  if (triggerType === "schedule") {
    if (data != null && typeof data === "object" && !Array.isArray(data) && typeof data.scheduled_at_millis === "number") {
      return `tick ${new Date(data.scheduled_at_millis).toISOString()}`;
    }
    return "schedule tick";
  }
  if (data == null || typeof data !== "object") return "";
  for (const key of ["primary_email", "display_name", "run_id", "user_id", "team_id", "id"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function parseWorkflowAttemptError(value: Prisma.JsonValue | null): WorkflowStepAttemptJson["error"] {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new StatusError(500, "Stored workflow attempt error must be an object");
  }
  if (typeof value.name !== "string" || typeof value.message !== "string") {
    throw new StatusError(500, "Stored workflow attempt error must contain name and message strings");
  }
  return typeof value.stack === "string"
    ? { name: value.name, message: value.message, stack: value.stack }
    : { name: value.name, message: value.message };
}

function workflowFailureKind(value: "USER" | "PLATFORM" | null): WorkflowRunJson["failure_kind"] {
  if (value == null) return null;
  return value === "USER" ? "user" : "platform";
}

function runRowToJson(row: RunRow): WorkflowRunJson {
  return {
    id: row.id,
    workflow_id: row.workflowId,
    run_key: row.runKey,
    state: row.state.toLowerCase() as WorkflowRunStateJson,
    version: row.version,
    trigger_type: row.triggerType,
    trigger_summary: deriveTriggerSummary(row.triggerType, row.triggerPayload),
    // Strip the "#<n>" loop-counter suffix for display.
    current_step_id: row.currentStepKey?.split("#")[0] || null,
    steps_recorded: row.stepsRecorded,
    error_summary: row.errorSummary,
    failure_kind: workflowFailureKind(row.failureKind),
    last_upgrade_divergence: (row.lastUpgradeDivergence ?? null) as WorkflowRunJson["last_upgrade_divergence"],
    created_at_millis: row.createdAt.getTime(),
    completed_at_millis: row.completedAt?.getTime() ?? null,
    next_wake_at_millis: row.wakeAt?.getTime() ?? null,
  };
}

export async function listWorkflowRuns(tenancy: Tenancy, workflowId: string, filter: {
  state?: WorkflowRunStateJson,
  version?: number,
  runKey?: string,
  onlyActive?: boolean,
  cursor?: string,
  limit?: number,
}): Promise<{ runs: WorkflowRunJson[], nextCursor: string | null }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

  let cursorFilter = Prisma.empty;
  if (filter.cursor != null) {
    const match = /^([0-9]+)_([0-9a-f-]{36})$/.exec(filter.cursor);
    if (match == null) throw new StatusError(400, "Invalid cursor");
    cursorFilter = Prisma.sql`AND ("createdAt", "id") < (${new Date(Number(match[1]))}, ${match[2]}::uuid)`;
  }

  const rows = await globalPrismaClient.$replica().$queryRaw<RunRow[]>(Prisma.sql`
    SELECT r."id", r."workflowId", r."runKey", r."state"::text AS "state", r."version", r."triggerType", r."triggerPayload",
      r."currentStepKey", r."errorSummary", r."failureKind"::text AS "failureKind", r."lastUpgradeDivergence",
      r."createdAt", r."completedAt", r."wakeAt",
      (SELECT COUNT(*)::int FROM "WorkflowStepResult" s WHERE s."tenancyId" = r."tenancyId" AND s."runId" = r."id") AS "stepsRecorded"
    FROM "WorkflowRun" r
    WHERE r."tenancyId" = ${tenancy.id}::uuid AND r."workflowId" = ${workflowId}
      ${filter.state != null ? Prisma.sql`AND r."state" = ${filter.state.toUpperCase()}::"WorkflowRunState"` : Prisma.empty}
      ${filter.onlyActive ? Prisma.sql`AND r."state" IN ('QUEUED', 'RUNNING', 'SLEEPING')` : Prisma.empty}
      ${filter.version != null ? Prisma.sql`AND r."version" = ${filter.version}` : Prisma.empty}
      ${filter.runKey != null ? Prisma.sql`AND r."runKey" = ${filter.runKey}` : Prisma.empty}
      ${cursorFilter}
    ORDER BY r."createdAt" DESC, r."id" DESC
    LIMIT ${limit + 1}
  `);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? `${page[page.length - 1].createdAt.getTime()}_${page[page.length - 1].id}` : null;
  return { runs: page.map(runRowToJson), nextCursor };
}

export async function getWorkflowRunDetails(tenancy: Tenancy, runId: string): Promise<WorkflowRunDetailsJson> {
  const rows = await globalPrismaClient.$replica().$queryRaw<RunRow[]>(Prisma.sql`
    SELECT r."id", r."workflowId", r."runKey", r."state"::text AS "state", r."version", r."triggerType", r."triggerPayload",
      r."currentStepKey", r."errorSummary", r."failureKind"::text AS "failureKind", r."lastUpgradeDivergence",
      r."createdAt", r."completedAt", r."wakeAt",
      (SELECT COUNT(*)::int FROM "WorkflowStepResult" s WHERE s."tenancyId" = r."tenancyId" AND s."runId" = r."id") AS "stepsRecorded"
    FROM "WorkflowRun" r
    WHERE r."tenancyId" = ${tenancy.id}::uuid AND r."id" = ${runId}::uuid
  `);
  if (rows.length === 0) throw new StatusError(404, "Workflow run not found");
  const row = rows[0];

  const steps = await globalPrismaClient.workflowStepResult.findMany({
    where: { tenancyId: tenancy.id, runId },
    orderBy: { createdAt: "asc" },
  });
  const attempts = await globalPrismaClient.workflowStepAttempt.findMany({
    where: { tenancyId: tenancy.id, runId },
    // Epoch first because startedAt is stamped on the app server, not the DB:
    // with several backend instances and skewed clocks a later epoch could
    // otherwise sort ahead of an earlier one. Ordering by epoch makes the
    // grouping structural rather than clock-dependent. stepKey/attempt are a
    // deterministic tiebreaker — Postgres sorts are not stable, and
    // recordStepAttempt is not lease-fenced, so identical timestamps from a
    // stale worker are possible in principle.
    orderBy: [{ retryEpoch: "asc" }, { startedAt: "asc" }, { stepKey: "asc" }, { attempt: "asc" }],
  });

  const stepsJson: WorkflowStepResultJson[] = steps.map((step) => ({
    step_key: step.stepKey,
    step_id: step.stepId,
    kind: step.kind === "RUN" ? "run" : "sleep",
    result: step.result,
    result_size_bytes: step.resultSizeBytes,
    attempts: step.attempts,
    executed_at_version: step.executedAtVersion,
    elapsed_ms: step.elapsedMs,
    created_at_millis: step.createdAt.getTime(),
  }));
  const attemptsJson: WorkflowStepAttemptJson[] = attempts.map((attempt) => ({
    step_key: attempt.stepKey,
    step_id: attempt.stepId,
    retry_epoch: attempt.retryEpoch,
    attempt: attempt.attempt,
    outcome: attempt.outcome === "SUCCEEDED" ? "succeeded" : "failed",
    error: parseWorkflowAttemptError(attempt.error),
    failure_kind: workflowFailureKind(attempt.failureKind),
    logs: attempt.logs,
    started_at_millis: attempt.startedAt.getTime(),
    finished_at_millis: attempt.finishedAt.getTime(),
  }));

  return {
    ...runRowToJson(row),
    trigger_payload: triggerPayloadData(row.triggerPayload),
    steps: stepsJson,
    step_attempts: attemptsJson,
  };
}
