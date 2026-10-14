// The internal Workflows Status page's backend: how far behind the workflow
// engine is, in which of its two queues, and on whose account.
//
// AUTHORIZATION: this returns data about EVERY project, so being signed into
// the internal project is not enough — ensurePlatformAdmin is what actually
// gates it; the project check only keeps the route off other projects'
// dashboards. See @/lib/platform-admin and the deployments-admin route, which
// this mirrors.

import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { getWorkflowsPlatformStatus } from "@/lib/workflows/platform-status";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import {
  adaptSchema,
  clientOrHigherAuthTypeSchema,
  yupArray,
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";

const INTERNAL_PROJECT_ID = "internal";

const millis = (date: Date | null): number | null => date == null ? null : date.getTime();

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Workflows platform status",
    description: "Cross-project health of the workflow engine: the event outbox backlog, the run queue, and recent throughput. Internal, platform-admin only.",
    tags: ["Workflows"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      project: adaptSchema.defined(),
    }).defined(),
    method: yupString().oneOf(["GET"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      generated_at_millis: yupNumber().defined(),
      limits: yupObject({
        event_batch_size: yupNumber().defined(),
        event_tenancy_concurrency: yupNumber().defined(),
        event_claim_lease_seconds: yupNumber().defined(),
        run_claim_batch_size: yupNumber().defined(),
        per_workflow_concurrency: yupNumber().defined(),
        run_lease_seconds: yupNumber().defined(),
      }).defined(),
      events: yupObject({
        pending: yupNumber().defined(),
        ready: yupNumber().defined(),
        claimed: yupNumber().defined(),
        backing_off: yupNumber().defined(),
        without_workflows: yupNumber().defined(),
        max_processing_attempts: yupNumber().defined(),
        oldest_pending_at_millis: yupNumber().nullable().defined(),
        oldest_ready_at_millis: yupNumber().nullable().defined(),
        enqueued_last_hour: yupNumber().defined(),
        processed_last_5_minutes: yupNumber().defined(),
        processed_last_hour: yupNumber().defined(),
        last_processed_at_millis: yupNumber().nullable().defined(),
        dispatch_delay_p50_seconds: yupNumber().nullable().defined(),
        dispatch_delay_p95_seconds: yupNumber().nullable().defined(),
        dispatch_delay_max_seconds: yupNumber().nullable().defined(),
        pending_by_type: yupArray(yupObject({
          type: yupString().defined(),
          count: yupNumber().defined(),
          oldest_scheduled_at_millis: yupNumber().defined(),
        }).defined()).defined(),
        pending_by_tenancy: yupArray(yupObject({
          tenancy_id: yupString().defined(),
          project_id: yupString().defined(),
          project_display_name: yupString().defined(),
          branch_id: yupString().defined(),
          workflow_count: yupNumber().defined(),
          count: yupNumber().defined(),
          oldest_scheduled_at_millis: yupNumber().defined(),
        }).defined()).defined(),
      }).defined(),
      runs: yupObject({
        queued_due: yupNumber().defined(),
        queued_backing_off: yupNumber().defined(),
        running: yupNumber().defined(),
        running_lease_expired: yupNumber().defined(),
        sleeping: yupNumber().defined(),
        sleeping_overdue: yupNumber().defined(),
        oldest_due_at_millis: yupNumber().nullable().defined(),
        completed_last_hour: yupNumber().defined(),
        failed_last_hour: yupNumber().defined(),
        canceled_last_hour: yupNumber().defined(),
        completed_last_day: yupNumber().defined(),
        failed_last_day: yupNumber().defined(),
        platform_failed_last_day: yupNumber().defined(),
        canceled_last_day: yupNumber().defined(),
        active_by_workflow: yupArray(yupObject({
          tenancy_id: yupString().defined(),
          project_id: yupString().defined(),
          project_display_name: yupString().defined(),
          workflow_id: yupString().defined(),
          paused: yupBoolean().defined(),
          due: yupNumber().defined(),
          running: yupNumber().defined(),
          waiting: yupNumber().defined(),
          oldest_due_at_millis: yupNumber().nullable().defined(),
        }).defined()).defined(),
      }).defined(),
      definitions: yupObject({
        total: yupNumber().defined(),
        paused: yupNumber().defined(),
        tenancies: yupNumber().defined(),
      }).defined(),
      schedules: yupObject({
        cursors: yupNumber().defined(),
        stalest_materialized_at_millis: yupNumber().nullable().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    if (auth.project.id !== INTERNAL_PROJECT_ID) {
      throw new KnownErrors.ExpectedInternalProject();
    }
    // Not redundant with the auth schema: client auth is satisfied by a
    // publishable key alone, so without this a request with no user at all
    // would reach ensurePlatformAdmin.
    if (!auth.user) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    await ensurePlatformAdmin(auth.user);

    const status = await getWorkflowsPlatformStatus();
    const { events, runs } = status;
    return {
      statusCode: 200,
      bodyType: "json" as const,
      body: {
        generated_at_millis: status.generatedAt.getTime(),
        limits: {
          event_batch_size: status.limits.eventBatchSize,
          event_tenancy_concurrency: status.limits.eventTenancyConcurrency,
          event_claim_lease_seconds: status.limits.eventClaimLeaseMs / 1000,
          run_claim_batch_size: status.limits.runClaimBatchSize,
          per_workflow_concurrency: status.limits.perWorkflowConcurrency,
          run_lease_seconds: status.limits.runLeaseMs / 1000,
        },
        events: {
          pending: events.pending,
          ready: events.ready,
          claimed: events.claimed,
          backing_off: events.backingOff,
          without_workflows: events.withoutWorkflows,
          max_processing_attempts: events.maxProcessingAttempts ?? 0,
          oldest_pending_at_millis: millis(events.oldestPendingAt),
          oldest_ready_at_millis: millis(events.oldestReadyAt),
          // Arrivals in the hour = those still pending + those already
          // dispatched. Compared against processed_last_hour, it says whether
          // the outbox is gaining or losing ground.
          enqueued_last_hour: events.enqueuedLastHour + events.enqueuedAndProcessedLastHour,
          processed_last_5_minutes: events.processedLast5Minutes,
          processed_last_hour: events.processedLastHour,
          last_processed_at_millis: millis(events.lastProcessedAt),
          dispatch_delay_p50_seconds: events.delayP50Seconds,
          dispatch_delay_p95_seconds: events.delayP95Seconds,
          dispatch_delay_max_seconds: events.delayMaxSeconds,
          pending_by_type: events.pendingByType.map((row) => ({
            type: row.type,
            count: row.count,
            oldest_scheduled_at_millis: row.oldestScheduledAt.getTime(),
          })),
          pending_by_tenancy: events.pendingByTenancy.map((row) => ({
            tenancy_id: row.tenancyId,
            project_id: row.projectId,
            project_display_name: row.projectDisplayName,
            branch_id: row.branchId,
            workflow_count: row.workflowCount,
            count: row.count,
            oldest_scheduled_at_millis: row.oldestScheduledAt.getTime(),
          })),
        },
        runs: {
          queued_due: runs.queuedDue,
          queued_backing_off: runs.queuedBackingOff,
          running: runs.running,
          running_lease_expired: runs.runningLeaseExpired,
          sleeping: runs.sleeping,
          sleeping_overdue: runs.sleepingOverdue,
          oldest_due_at_millis: millis(runs.oldestDueAt),
          completed_last_hour: runs.completedLastHour,
          failed_last_hour: runs.failedLastHour,
          canceled_last_hour: runs.canceledLastHour,
          completed_last_day: runs.completedLastDay,
          failed_last_day: runs.failedLastDay,
          platform_failed_last_day: runs.platformFailedLastDay,
          canceled_last_day: runs.canceledLastDay,
          active_by_workflow: runs.activeByWorkflow.map((row) => ({
            tenancy_id: row.tenancyId,
            project_id: row.projectId,
            project_display_name: row.projectDisplayName,
            workflow_id: row.workflowId,
            paused: row.paused,
            due: row.due,
            running: row.running,
            waiting: row.waiting,
            oldest_due_at_millis: millis(row.oldestDueAt),
          })),
        },
        definitions: status.definitions,
        schedules: {
          cursors: status.schedules.cursors,
          stalest_materialized_at_millis: millis(status.schedules.stalestMaterializedAt),
        },
      },
    };
  },
});
