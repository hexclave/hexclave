// Cross-tenant health numbers for the internal Workflows Status page.
//
// The engine has two queues, and "workflows are behind" can mean either one:
// the event outbox (events waiting to be turned into runs) or the run queue
// (runs waiting for a sandbox slot). Everything here exists to tell those
// apart and to say who is in the queue — the question that had no answer the
// first time the outbox fell days behind.
//
// Reads the GLOBAL database across every tenancy, so it is only ever reachable
// from an internal-project, platform-admin route. All queries are raw: they run
// on the primary and are index-backed by the pending/outbox/due indexes, except
// the finished-runs window, which reads every terminal run (there is no index
// on completedAt). That is acceptable for a page an operator refreshes by hand;
// it would not be for a poller.

import { Prisma } from "@/generated/prisma/client";
import { globalPrismaClient } from "@/prisma-client";
import { WORKFLOW_ENGINE_LIMITS } from "./engine";

/** How many rows each "top N" breakdown lists. */
const BREAKDOWN_LIMIT = 15;

type PendingEventsRow = {
  pending: number,
  ready: number,
  claimed: number,
  backingOff: number,
  withoutWorkflows: number,
  enqueuedLastHour: number,
  maxProcessingAttempts: number | null,
  oldestPendingAt: Date | null,
  oldestReadyAt: Date | null,
};

type ProcessedEventsRow = {
  processedLast5Minutes: number,
  processedLastHour: number,
  enqueuedAndProcessedLastHour: number,
  lastProcessedAt: Date | null,
  delayP50Seconds: number | null,
  delayP95Seconds: number | null,
  delayMaxSeconds: number | null,
};

type ActiveRunsRow = {
  queuedDue: number,
  queuedBackingOff: number,
  running: number,
  runningLeaseExpired: number,
  sleeping: number,
  sleepingOverdue: number,
  oldestDueAt: Date | null,
};

type FinishedRunsRow = {
  completedLastHour: number,
  failedLastHour: number,
  canceledLastHour: number,
  completedLastDay: number,
  failedLastDay: number,
  platformFailedLastDay: number,
  canceledLastDay: number,
};

type DefinitionsRow = {
  total: number,
  paused: number,
  tenancies: number,
};

type SchedulesRow = {
  cursors: number,
  stalestMaterializedAt: Date | null,
};

export type WorkflowsPlatformStatus = {
  generatedAt: Date,
  limits: typeof WORKFLOW_ENGINE_LIMITS,
  events: PendingEventsRow & ProcessedEventsRow & {
    pendingByType: { type: string, count: number, oldestScheduledAt: Date }[],
    pendingByTenancy: {
      tenancyId: string,
      projectId: string,
      projectDisplayName: string,
      branchId: string,
      workflowCount: number,
      count: number,
      oldestScheduledAt: Date,
    }[],
  },
  runs: ActiveRunsRow & FinishedRunsRow & {
    activeByWorkflow: {
      tenancyId: string,
      projectId: string,
      projectDisplayName: string,
      workflowId: string,
      paused: boolean,
      due: number,
      running: number,
      waiting: number,
      oldestDueAt: Date | null,
    }[],
  },
  definitions: DefinitionsRow,
  schedules: SchedulesRow,
};

export async function getWorkflowsPlatformStatus(): Promise<WorkflowsPlatformStatus> {
  // Read from the replica on purpose: these scans are heaviest during a
  // backlog, exactly when the primary can least afford them. Replica lag only
  // makes ages read a few seconds older, far below the page's thresholds.
  // (The engine itself must keep reading the primary.)
  const replica = globalPrismaClient.$replica();
  const [
    pendingEvents,
    processedEvents,
    pendingByType,
    pendingByTenancy,
    activeRuns,
    finishedRuns,
    activeByWorkflow,
    definitions,
    schedules,
  ] = await Promise.all([
    // "Ready" is the number that should be near zero: due, and not held by a
    // tick. A large "pending" made of claimed or backing-off events is not a
    // backlog. "withoutWorkflows" is what the engine's sweep clears each tick,
    // so it too should hover near zero.
    replica.$queryRaw<PendingEventsRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "pending",
        (COUNT(*) FILTER (WHERE e."retryAt" <= NOW() AND (e."claimedUntil" IS NULL OR e."claimedUntil" <= NOW())))::int AS "ready",
        (COUNT(*) FILTER (WHERE e."claimedUntil" > NOW()))::int AS "claimed",
        (COUNT(*) FILTER (WHERE e."retryAt" > NOW()))::int AS "backingOff",
        (COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM "WorkflowDefinition" d WHERE d."tenancyId" = e."tenancyId"
        )))::int AS "withoutWorkflows",
        (COUNT(*) FILTER (WHERE e."createdAt" >= NOW() - INTERVAL '1 hour'))::int AS "enqueuedLastHour",
        MAX(e."processingAttempts")::int AS "maxProcessingAttempts",
        MIN(e."scheduledAt") AS "oldestPendingAt",
        MIN(e."scheduledAt") FILTER (WHERE e."retryAt" <= NOW() AND (e."claimedUntil" IS NULL OR e."claimedUntil" <= NOW())) AS "oldestReadyAt"
      FROM "WorkflowEvent" e
      WHERE e."processedAt" IS NULL
    `),
    // Dispatch delay is processedAt - scheduledAt: how late an event was by
    // the time the engine got to it. Schedule catch-up after downtime shows
    // up here by design (those events carry their nominal time).
    replica.$queryRaw<ProcessedEventsRow[]>(Prisma.sql`
      SELECT
        (COUNT(*) FILTER (WHERE e."processedAt" >= NOW() - INTERVAL '5 minutes'))::int AS "processedLast5Minutes",
        COUNT(*)::int AS "processedLastHour",
        (COUNT(*) FILTER (WHERE e."createdAt" >= NOW() - INTERVAL '1 hour'))::int AS "enqueuedAndProcessedLastHour",
        MAX(e."processedAt") AS "lastProcessedAt",
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(EXTRACT(EPOCH FROM (e."processedAt" - e."scheduledAt"))::float8, 0)))::float8 AS "delayP50Seconds",
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY GREATEST(EXTRACT(EPOCH FROM (e."processedAt" - e."scheduledAt"))::float8, 0)))::float8 AS "delayP95Seconds",
        MAX(GREATEST(EXTRACT(EPOCH FROM (e."processedAt" - e."scheduledAt"))::float8, 0))::float8 AS "delayMaxSeconds"
      FROM "WorkflowEvent" e
      WHERE e."processedAt" >= NOW() - INTERVAL '1 hour'
    `),
    replica.$queryRaw<{ type: string, count: number, oldestScheduledAt: Date }[]>(Prisma.sql`
      SELECT e."type", COUNT(*)::int AS "count", MIN(e."scheduledAt") AS "oldestScheduledAt"
      FROM "WorkflowEvent" e
      WHERE e."processedAt" IS NULL
      GROUP BY e."type"
      ORDER BY COUNT(*) DESC, e."type" ASC
      LIMIT ${BREAKDOWN_LIMIT}
    `),
    replica.$queryRaw<WorkflowsPlatformStatus["events"]["pendingByTenancy"]>(Prisma.sql`
      SELECT
        pending."tenancyId",
        t."projectId",
        p."displayName" AS "projectDisplayName",
        t."branchId",
        (SELECT COUNT(*) FROM "WorkflowDefinition" d WHERE d."tenancyId" = pending."tenancyId")::int AS "workflowCount",
        pending."count",
        pending."oldestScheduledAt"
      FROM (
        SELECT e."tenancyId", COUNT(*)::int AS "count", MIN(e."scheduledAt") AS "oldestScheduledAt"
        FROM "WorkflowEvent" e
        WHERE e."processedAt" IS NULL
        GROUP BY e."tenancyId"
        ORDER BY COUNT(*) DESC, e."tenancyId" ASC
        LIMIT ${BREAKDOWN_LIMIT}
      ) pending
      JOIN "Tenancy" t ON t."id" = pending."tenancyId"
      JOIN "Project" p ON p."id" = t."projectId"
      ORDER BY pending."count" DESC, pending."tenancyId" ASC
    `),
    // A RUNNING run whose lease has expired is one whose worker died; the
    // engine re-claims it, so a persistent non-zero count there means claims
    // are not keeping up (or not happening). Such a run counts toward
    // oldestDueAt from the moment its lease expired.
    replica.$queryRaw<ActiveRunsRow[]>(Prisma.sql`
      SELECT
        (COUNT(*) FILTER (WHERE r."state" = 'QUEUED' AND (r."wakeAt" IS NULL OR r."wakeAt" <= NOW())))::int AS "queuedDue",
        (COUNT(*) FILTER (WHERE r."state" = 'QUEUED' AND r."wakeAt" > NOW()))::int AS "queuedBackingOff",
        (COUNT(*) FILTER (WHERE r."state" = 'RUNNING' AND r."leaseUntil" > NOW()))::int AS "running",
        (COUNT(*) FILTER (WHERE r."state" = 'RUNNING' AND (r."leaseUntil" IS NULL OR r."leaseUntil" <= NOW())))::int AS "runningLeaseExpired",
        (COUNT(*) FILTER (WHERE r."state" = 'SLEEPING'))::int AS "sleeping",
        (COUNT(*) FILTER (WHERE r."state" = 'SLEEPING' AND r."wakeAt" <= NOW()))::int AS "sleepingOverdue",
        MIN(COALESCE(r."wakeAt", r."leaseUntil", r."updatedAt")) FILTER (WHERE
          (r."state" = 'QUEUED' AND (r."wakeAt" IS NULL OR r."wakeAt" <= NOW()))
          OR (r."state" = 'SLEEPING' AND r."wakeAt" <= NOW())
          OR (r."state" = 'RUNNING' AND (r."leaseUntil" IS NULL OR r."leaseUntil" <= NOW()))
        ) AS "oldestDueAt"
      FROM "WorkflowRun" r
      WHERE r."state" IN ('QUEUED', 'RUNNING', 'SLEEPING')
    `),
    replica.$queryRaw<FinishedRunsRow[]>(Prisma.sql`
      SELECT
        (COUNT(*) FILTER (WHERE r."state" = 'COMPLETED' AND r."completedAt" >= NOW() - INTERVAL '1 hour'))::int AS "completedLastHour",
        (COUNT(*) FILTER (WHERE r."state" = 'FAILED' AND r."completedAt" >= NOW() - INTERVAL '1 hour'))::int AS "failedLastHour",
        (COUNT(*) FILTER (WHERE r."state" = 'CANCELED' AND r."completedAt" >= NOW() - INTERVAL '1 hour'))::int AS "canceledLastHour",
        (COUNT(*) FILTER (WHERE r."state" = 'COMPLETED'))::int AS "completedLastDay",
        (COUNT(*) FILTER (WHERE r."state" = 'FAILED'))::int AS "failedLastDay",
        (COUNT(*) FILTER (WHERE r."state" = 'FAILED' AND r."failureKind" = 'PLATFORM'))::int AS "platformFailedLastDay",
        (COUNT(*) FILTER (WHERE r."state" = 'CANCELED'))::int AS "canceledLastDay"
      FROM "WorkflowRun" r
      WHERE r."state" IN ('COMPLETED', 'FAILED', 'CANCELED')
        AND r."completedAt" >= NOW() - INTERVAL '1 day'
    `),
    replica.$queryRaw<WorkflowsPlatformStatus["runs"]["activeByWorkflow"]>(Prisma.sql`
      SELECT
        active."tenancyId",
        t."projectId",
        p."displayName" AS "projectDisplayName",
        active."workflowId",
        COALESCE(d."pausedAt" IS NOT NULL, FALSE) AS "paused",
        active."due",
        active."running",
        active."waiting",
        active."oldestDueAt"
      FROM (
        SELECT
          r."tenancyId",
          r."workflowId",
          (COUNT(*) FILTER (WHERE
            (r."state" = 'QUEUED' AND (r."wakeAt" IS NULL OR r."wakeAt" <= NOW()))
            OR (r."state" = 'SLEEPING' AND r."wakeAt" <= NOW())
            OR (r."state" = 'RUNNING' AND (r."leaseUntil" IS NULL OR r."leaseUntil" <= NOW()))
          ))::int AS "due",
          (COUNT(*) FILTER (WHERE r."state" = 'RUNNING' AND r."leaseUntil" > NOW()))::int AS "running",
          (COUNT(*) FILTER (WHERE r."state" IN ('QUEUED', 'SLEEPING') AND r."wakeAt" > NOW()))::int AS "waiting",
          MIN(COALESCE(r."wakeAt", r."leaseUntil", r."updatedAt")) FILTER (WHERE
            (r."state" = 'QUEUED' AND (r."wakeAt" IS NULL OR r."wakeAt" <= NOW()))
            OR (r."state" = 'SLEEPING' AND r."wakeAt" <= NOW())
            OR (r."state" = 'RUNNING' AND (r."leaseUntil" IS NULL OR r."leaseUntil" <= NOW()))
          ) AS "oldestDueAt"
        FROM "WorkflowRun" r
        WHERE r."state" IN ('QUEUED', 'RUNNING', 'SLEEPING')
        GROUP BY r."tenancyId", r."workflowId"
        ORDER BY 3 DESC, 4 DESC, 5 DESC, r."tenancyId" ASC, r."workflowId" ASC
        LIMIT ${BREAKDOWN_LIMIT}
      ) active
      JOIN "Tenancy" t ON t."id" = active."tenancyId"
      JOIN "Project" p ON p."id" = t."projectId"
      LEFT JOIN "WorkflowDefinition" d ON d."tenancyId" = active."tenancyId" AND d."workflowId" = active."workflowId"
      ORDER BY active."due" DESC, active."running" DESC, active."waiting" DESC, active."tenancyId" ASC, active."workflowId" ASC
    `),
    replica.$queryRaw<DefinitionsRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "total",
        (COUNT(*) FILTER (WHERE d."pausedAt" IS NOT NULL))::int AS "paused",
        COUNT(DISTINCT d."tenancyId")::int AS "tenancies"
      FROM "WorkflowDefinition" d
    `),
    // The stalest cursor of an unpaused schedule doubles as the engine's
    // heartbeat: every tick advances every such cursor to "now", so one that
    // is minutes old means ticks are not completing their first phase.
    replica.$queryRaw<SchedulesRow[]>(Prisma.sql`
      SELECT COUNT(*)::int AS "cursors", MIN(c."lastMaterializedAt") AS "stalestMaterializedAt"
      FROM "WorkflowScheduleCursor" c
      JOIN "WorkflowDefinition" d ON d."tenancyId" = c."tenancyId" AND d."workflowId" = c."workflowId"
      WHERE d."pausedAt" IS NULL
    `),
  ]);

  return {
    generatedAt: new Date(),
    limits: WORKFLOW_ENGINE_LIMITS,
    events: {
      ...pendingEvents[0],
      ...processedEvents[0],
      pendingByType,
      pendingByTenancy,
    },
    runs: {
      ...activeRuns[0],
      ...finishedRuns[0],
      activeByWorkflow,
    },
    definitions: definitions[0],
    schedules: schedules[0],
  };
}
