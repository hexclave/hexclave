import { utf8ByteLength } from "@/lib/utf8";
import {
  IssueAlertDeliveryOutcome,
  IssueAlertDeliveryState,
  WorkflowRunState,
  type IssueAlertDeliveryState as IssueAlertDeliveryStateValue,
} from "@/generated/prisma/enums";
import { globalPrismaClient, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { isErrorIngestScrubbedRecord, scrubErrorIngestPayload, type ErrorIngestScrubbedRecord, type ErrorIngestScrubbedValue } from "@/lib/error-ingest";
import { deterministicWorkflowUuid } from "@/lib/workflows/events";
import {
  ISSUE_ALERT_EMAIL_WORKFLOW_ID,
  ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION,
  ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
} from "@/lib/workflows/issue-alerts/contract";
import { parseOwnershipRoutingMetadata } from "@/lib/issues/ownership/routing-metadata";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import {
  IssueAlertPersistenceInputError,
  issueAlertPersistenceService,
  type IssueAlertWorkflowDeliveryExpectation,
  type IssueAlertWorkflowUpdate,
} from "./persistence";
import type { IssueAlertRuleScope } from "./types";
import { anyVersionUuidPattern as UUID_PATTERN } from "@hexclave/shared/dist/utils/uuids";

export const ISSUE_ALERT_WORKFLOW_REPLAY_MAX_COUNT = 1_000;
export const ISSUE_ALERT_WORKFLOW_REPLAY_MAX_PAYLOAD_BYTES = 32 * 1024;

const IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
type IssueAlertWorkflowReplayPayload = ErrorIngestScrubbedRecord;

function isMissingReplayPayload(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export type IssueAlertWorkflowDeliveryRef = {
  id: string,
  scope: IssueAlertRuleScope,
  workflowEventId: string,
  state: IssueAlertDeliveryStateValue,
  nextRetryAt: Date | null,
  lastAttemptAt: Date | null,
};

export type IssueAlertWorkflowRunObservation =
  | { status: "missing" }
  | { status: "in_flight" }
  | { status: "completed" }
  | { status: "failed", error: string | null }
  | { status: "canceled" };

export type IssueAlertWorkflowRunLookup = {
  findRunByTriggerEventId(tenancyId: string, workflowEventId: string): Promise<IssueAlertWorkflowRunObservation>,
};

export type IssueAlertWorkflowStatusStore = {
  findDeliveryByWorkflowEventId(tenancyId: string, workflowEventId: string): Promise<IssueAlertWorkflowDeliveryRef | null>,
  listEnqueuedDeliveries(
    limit: number,
    afterDelivery?: { tenancyId: string, id: string },
  ): Promise<IssueAlertWorkflowDeliveryRef[]>,
  applyWorkflowUpdate(
    scope: IssueAlertRuleScope,
    deliveryId: string,
    expectedWorkflowEventId: string,
    expectedDelivery: IssueAlertWorkflowDeliveryExpectation,
    update: IssueAlertWorkflowUpdate,
  ): Promise<boolean>,
};

export type IssueAlertWorkflowStatusResult =
  | { status: "ignored", reason: "delivery_not_found" | "run_not_ready" | "stale_observation" }
  | { status: "invalid", reason: string }
  | {
    status: "reconciled",
    deliveryId: string,
    observation: IssueAlertWorkflowRunObservation["status"],
    update: IssueAlertWorkflowUpdate,
  };

export const ISSUE_ALERT_WORKFLOW_RECONCILE_BATCH_SIZE = 200;

function isBoundedIdentifier(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && IDENTIFIER_PATTERN.test(value)
    && utf8ByteLength(value) <= maximumBytes;
}

function isBoundedUniqueUserIdArray(value: ErrorIngestScrubbedValue | undefined): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isBoundedIdentifier(entry, 256) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function validateScope(scope: IssueAlertRuleScope): void {
  if (!UUID_PATTERN.test(scope.tenancyId)
    || !isBoundedIdentifier(scope.projectId, 256)
    || !isBoundedIdentifier(scope.branchId, 256)) {
    throw new IssueAlertPersistenceInputError("Issue alert workflow status scope is invalid");
  }
}

function validateDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) throw new IssueAlertPersistenceInputError(`${field} must be a valid date`);
}

export function observationFromRunState(
  state: WorkflowRunState,
  errorSummary: string | null,
  emailStepCompleted = false,
): IssueAlertWorkflowRunObservation {
  if (emailStepCompleted) return { status: "completed" };
  switch (state) {
    case WorkflowRunState.QUEUED:
    case WorkflowRunState.RUNNING:
    case WorkflowRunState.SLEEPING: {
      return { status: "in_flight" };
    }
    case WorkflowRunState.COMPLETED: {
      return { status: "completed" };
    }
    case WorkflowRunState.FAILED: {
      return { status: "failed", error: errorSummary };
    }
    case WorkflowRunState.CANCELED: {
      return { status: "canceled" };
    }
    default: {
      const exhaustive: never = state;
      throw new HexclaveAssertionError(`Unhandled workflow run state: ${exhaustive}`);
    }
  }
}

function updateForObservation(observation: IssueAlertWorkflowRunObservation, at: Date): IssueAlertWorkflowUpdate | null {
  switch (observation.status) {
    case "missing":
    case "in_flight": {
      return null;
    }
    case "completed": {
      return { kind: "delivered", at };
    }
    case "failed": {
      return {
        kind: "dropped",
        error: observation.error ?? "Workflow run failed before issue-alert email delivery completed",
        at,
      };
    }
    case "canceled": {
      return {
        kind: "dropped",
        error: "Workflow run was canceled before issue-alert email delivery completed",
        at,
      };
    }
    default: {
      const exhaustive: never = observation;
      throw new HexclaveAssertionError(`Unhandled workflow run observation: ${exhaustive}`);
    }
  }
}

function isTerminalDelivery(state: IssueAlertDeliveryStateValue): boolean {
  return state === IssueAlertDeliveryState.DELIVERED || state === IssueAlertDeliveryState.DROPPED;
}

function toDeliveryRef(row: {
  id: string,
  tenancyId: string,
  projectId: string,
  branchId: string,
  workflowEventId: string | null,
  state: IssueAlertDeliveryStateValue,
  nextRetryAt: Date | null,
  lastAttemptAt: Date | null,
}): IssueAlertWorkflowDeliveryRef | null {
  if (row.workflowEventId === null) return null;
  return {
    id: row.id,
    scope: { tenancyId: row.tenancyId, projectId: row.projectId, branchId: row.branchId },
    workflowEventId: row.workflowEventId,
    state: row.state,
    nextRetryAt: row.nextRetryAt,
    lastAttemptAt: row.lastAttemptAt,
  };
}

const defaultRunLookup: IssueAlertWorkflowRunLookup = {
  async findRunByTriggerEventId(tenancyId, workflowEventId) {
    const runId = deterministicWorkflowUuid(`run:${tenancyId}:${workflowEventId}:${ISSUE_ALERT_EMAIL_WORKFLOW_ID}`);
    const run = await globalPrismaClient.workflowRun.findUnique({
      where: { tenancyId_id: { tenancyId, id: runId } },
      select: {
        state: true,
        errorSummary: true,
        stepResults: {
          where: { stepId: "send-email", kind: "RUN" },
          select: { stepKey: true },
          take: 1,
        },
      },
    });
    if (run === null) return { status: "missing" };
    // The built-in workflow deliberately sleeps after durable email enqueue to
    // implement cooldown. A recorded send-email step is the delivery boundary;
    // waiting for the later cooldown sleep to finish would leave successful
    // deliveries looking queued for minutes or hours.
    return observationFromRunState(run.state, run.errorSummary, run.stepResults.length > 0);
  },
};

const defaultStatusStore: IssueAlertWorkflowStatusStore = {
  async findDeliveryByWorkflowEventId(tenancyId, workflowEventId) {
    const row = await globalPrismaClient.issueAlertDelivery.findFirst({
      where: { tenancyId, workflowEventId },
      select: {
        id: true,
        tenancyId: true,
        projectId: true,
        branchId: true,
        workflowEventId: true,
        state: true,
        nextRetryAt: true,
        lastAttemptAt: true,
      },
    });
    if (row === null) return null;
    return toDeliveryRef(row);
  },
  async listEnqueuedDeliveries(limit, afterDelivery) {
    const rows = await globalPrismaClient.issueAlertDelivery.findMany({
      where: {
        state: IssueAlertDeliveryState.ENQUEUED,
        workflowEventId: { not: null },
      },
      orderBy: [{ enqueuedAt: "asc" }, { id: "asc" }],
      take: limit,
      cursor: afterDelivery === undefined ? undefined : { tenancyId_id: { tenancyId: afterDelivery.tenancyId, id: afterDelivery.id } },
      skip: afterDelivery === undefined ? undefined : 1,
      select: {
        id: true,
        tenancyId: true,
        projectId: true,
        branchId: true,
        workflowEventId: true,
        state: true,
        nextRetryAt: true,
        lastAttemptAt: true,
      },
    });
    const deliveries: IssueAlertWorkflowDeliveryRef[] = [];
    for (const row of rows) {
      const delivery = toDeliveryRef(row);
      if (delivery !== null) deliveries.push(delivery);
    }
    return deliveries;
  },
  async applyWorkflowUpdate(scope, deliveryId, expectedWorkflowEventId, expectedDelivery, update) {
    const result = await issueAlertPersistenceService.recordWorkflowUpdateIfCurrent(
      scope,
      deliveryId,
      expectedWorkflowEventId,
      expectedDelivery,
      update,
    );
    return result !== null;
  },
};

async function applyRunObservation(options: {
  delivery: IssueAlertWorkflowDeliveryRef,
  observation: IssueAlertWorkflowRunObservation,
  store: IssueAlertWorkflowStatusStore,
  at: Date,
}): Promise<IssueAlertWorkflowStatusResult> {
  if (isTerminalDelivery(options.delivery.state)) {
    return { status: "ignored", reason: "stale_observation" };
  }
  const update = updateForObservation(options.observation, options.at);
  if (update === null) return { status: "ignored", reason: "run_not_ready" };
  const applied = await options.store.applyWorkflowUpdate(
    options.delivery.scope,
    options.delivery.id,
    options.delivery.workflowEventId,
    {
      state: options.delivery.state,
      nextRetryAt: options.delivery.nextRetryAt,
      lastAttemptAt: options.delivery.lastAttemptAt,
    },
    update,
  );
  if (!applied) return { status: "ignored", reason: "stale_observation" };
  return {
    status: "reconciled",
    deliveryId: options.delivery.id,
    observation: options.observation.status,
    update,
  };
}

export async function reconcileIssueAlertWorkflowRun(options: {
  tenancyId: string,
  workflowEventId: string,
  store?: IssueAlertWorkflowStatusStore,
  runs?: IssueAlertWorkflowRunLookup,
  at?: Date,
}): Promise<IssueAlertWorkflowStatusResult> {
  if (!UUID_PATTERN.test(options.tenancyId)) return { status: "invalid", reason: "workflow run tenancy id is invalid" };
  if (!UUID_PATTERN.test(options.workflowEventId)) return { status: "invalid", reason: "workflow event id is invalid" };
  const store = options.store ?? defaultStatusStore;
  const runs = options.runs ?? defaultRunLookup;
  const at = options.at ?? new Date();
  validateDate(at, "issue alert workflow reconcile time");
  const delivery = await store.findDeliveryByWorkflowEventId(options.tenancyId, options.workflowEventId);
  if (delivery === null) return { status: "ignored", reason: "delivery_not_found" };
  const observation = await runs.findRunByTriggerEventId(options.tenancyId, options.workflowEventId);
  return await applyRunObservation({ delivery, observation, store, at });
}

export async function reconcilePendingIssueAlertWorkflowDeliveries(options?: {
  store?: IssueAlertWorkflowStatusStore,
  runs?: IssueAlertWorkflowRunLookup,
  limit?: number,
  at?: Date,
}): Promise<{ scanned: number, reconciled: number }> {
  const store = options?.store ?? defaultStatusStore;
  const runs = options?.runs ?? defaultRunLookup;
  const at = options?.at ?? new Date();
  validateDate(at, "issue alert workflow reconcile time");
  const limit = options?.limit ?? ISSUE_ALERT_WORKFLOW_RECONCILE_BATCH_SIZE;
  let afterDelivery: { tenancyId: string, id: string } | undefined;
  let scanned = 0;
  let reconciled = 0;
  while (true) {
    const deliveries = await store.listEnqueuedDeliveries(limit, afterDelivery);
    for (const delivery of deliveries) {
      const observation = await runs.findRunByTriggerEventId(delivery.scope.tenancyId, delivery.workflowEventId);
      const result = await applyRunObservation({ delivery, observation, store, at });
      if (result.status === "reconciled") reconciled += 1;
    }
    scanned += deliveries.length;
    if (deliveries.length < limit) break;
    const lastDelivery = deliveries.at(-1);
    if (lastDelivery === undefined) break;
    afterDelivery = { tenancyId: lastDelivery.scope.tenancyId, id: lastDelivery.id };
  }
  return { scanned, reconciled };
}

export type IssueAlertWorkflowReplayPlan = {
  eventId: string,
  type: typeof ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
  payload: IssueAlertWorkflowReplayPayload,
  payloadJson: string,
  scheduledAt: Date,
  replayCount: number,
};

export type IssueAlertWorkflowReplayPlanResult =
  | { status: "ok", plan: IssueAlertWorkflowReplayPlan }
  | {
    status: "drop",
    reason: IssueAlertWorkflowReplayDropReason,
  };

export type IssueAlertWorkflowReplayDropReason =
  | "invalid_delivery_id"
  | "invalid_source_event_id"
  | "replay_limit"
  | "invalid_event_type"
  | "invalid_event_payload"
  | "payload_too_large"
  | "invalid_replay_time";

function isReplayableAction(value: ErrorIngestScrubbedValue | undefined): value is IssueAlertWorkflowReplayPayload {
  if (!isErrorIngestScrubbedRecord(value)) return false;
  if (value.type === "webhook") {
    return typeof value.integration_id === "string" && value.integration_id.length > 0;
  }
  const userIds = value.user_ids;
  const routingResolution = Object.prototype.hasOwnProperty.call(value, "routing_resolution")
    ? parseOwnershipRoutingMetadata(value.routing_resolution)
    : undefined;
  const userIdCount = Array.isArray(userIds) ? userIds.length : null;
  const validUserIds = isBoundedUniqueUserIdArray(userIds);
  const validRoutingRecipients = routingResolution === undefined
    ? validUserIds && userIdCount !== null && userIdCount > 0
    : routingResolution !== null
      && validUserIds
      && routingResolution.recipient_count === userIdCount
      && (routingResolution.status === "resolved" ? userIdCount > 0 : userIdCount === 0);
  return value.type === "email"
    && validRoutingRecipients
    && typeof value.subject === "string"
    && value.subject.length > 0
    && typeof value.html === "string"
    && value.html.length > 0;
}

function isReplayablePayload(value: ErrorIngestScrubbedValue | undefined): value is IssueAlertWorkflowReplayPayload {
  if (!isErrorIngestScrubbedRecord(value)) return false;
  return value.schema_version === ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION
    && value.kind === "issue_alert"
    && typeof value.event_kind === "string"
    && typeof value.project_id === "string"
    && typeof value.branch_id === "string"
    && typeof value.issue_id === "string"
    && typeof value.occurrence_id === "string"
    && typeof value.rule_id === "string"
    && typeof value.deduplication_key === "string"
    && typeof value.cooldown_key === "string"
    && isReplayableAction(value.action);
}

export function buildIssueAlertWorkflowReplayPlan(input: {
  deliveryId: string,
  sourceEventId: string,
  sourceEventType: string,
  sourcePayload: unknown,
  replayCount: number,
  scheduledAt: Date,
}): IssueAlertWorkflowReplayPlanResult {
  if (!UUID_PATTERN.test(input.deliveryId)) return { status: "drop", reason: "invalid_delivery_id" };
  if (!UUID_PATTERN.test(input.sourceEventId)) return { status: "drop", reason: "invalid_source_event_id" };
  if (!Number.isSafeInteger(input.replayCount) || input.replayCount < 0 || input.replayCount >= ISSUE_ALERT_WORKFLOW_REPLAY_MAX_COUNT) {
    return { status: "drop", reason: "replay_limit" };
  }
  if (input.sourceEventType !== ISSUE_ALERT_WORKFLOW_EVENT_TYPE) return { status: "drop", reason: "invalid_event_type" };
  if (!Number.isFinite(input.scheduledAt.getTime())) return { status: "drop", reason: "invalid_replay_time" };

  const scrubbed = scrubErrorIngestPayload(input.sourcePayload, {
    maxDepth: 6,
    maxPayloadBytes: ISSUE_ALERT_WORKFLOW_REPLAY_MAX_PAYLOAD_BYTES,
    maxStringBytes: 8 * 1024,
    maxKeyBytes: 128,
    maxCollectionEntries: 64,
  });
  if (!isReplayablePayload(scrubbed.value)) return { status: "drop", reason: "invalid_event_payload" };
  const payloadJson = JSON.stringify(scrubbed.value);
  if (utf8ByteLength(payloadJson) > ISSUE_ALERT_WORKFLOW_REPLAY_MAX_PAYLOAD_BYTES) {
    return { status: "drop", reason: "payload_too_large" };
  }
  return {
    status: "ok",
    plan: {
      eventId: deterministicWorkflowUuid(`issue-alert-replay:${input.deliveryId}:${input.replayCount + 1}`),
      type: ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
      payload: scrubbed.value,
      payloadJson,
      scheduledAt: input.scheduledAt,
      replayCount: input.replayCount + 1,
    },
  };
}

export type IssueAlertWorkflowReplayResult =
  | { status: "replayed", deliveryId: string, workflowEventId: string, replayCount: number }
  | {
    status: "not_replayed",
    reason: "delivery_not_found" | "delivery_not_failed" | "missing_workflow_event" | IssueAlertWorkflowReplayDropReason,
  };

async function replayIssueAlertWorkflowDeliveryInTransaction(
  client: PrismaClientTransaction,
  scope: IssueAlertRuleScope,
  deliveryId: string,
  now: Date,
): Promise<IssueAlertWorkflowReplayResult> {
  const delivery = await client.issueAlertDelivery.findFirst({
    where: {
      tenancyId: scope.tenancyId,
      projectId: scope.projectId,
      branchId: scope.branchId,
      id: deliveryId,
    },
    select: {
      id: true,
      tenancyId: true,
      projectId: true,
      branchId: true,
      state: true,
      replayCount: true,
      workflowEventId: true,
      workflowPayload: true,
    },
  });
  if (delivery === null) return { status: "not_replayed", reason: "delivery_not_found" };
  // FAILED is leftover from the old retry writer. Live reconcile writes DROPPED
  // when a workflow run fails; replay still accepts historical FAILED rows.
  if (delivery.state !== IssueAlertDeliveryState.FAILED && delivery.state !== IssueAlertDeliveryState.DROPPED) {
    return { status: "not_replayed", reason: "delivery_not_failed" };
  }
  if (delivery.workflowEventId === null) return { status: "not_replayed", reason: "missing_workflow_event" };
  const sourceEvent = await client.workflowEvent.findUnique({
    where: { tenancyId_id: { tenancyId: scope.tenancyId, id: delivery.workflowEventId } },
    select: { id: true, type: true, payload: true },
  });
  const sourcePayload = sourceEvent === null ? delivery.workflowPayload : sourceEvent.payload;
  if (sourceEvent === null && isMissingReplayPayload(sourcePayload)) {
    return { status: "not_replayed", reason: "missing_workflow_event" };
  }
  const plan = buildIssueAlertWorkflowReplayPlan({
    deliveryId: delivery.id,
    sourceEventId: sourceEvent?.id ?? delivery.workflowEventId,
    sourceEventType: sourceEvent?.type ?? ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
    sourcePayload,
    replayCount: delivery.replayCount,
    scheduledAt: now,
  });
  if (plan.status === "drop") return { status: "not_replayed", reason: plan.reason };

  await client.workflowEvent.createMany({
    data: [{
      tenancyId: scope.tenancyId,
      id: plan.plan.eventId,
      type: plan.plan.type,
      payload: JSON.parse(plan.plan.payloadJson),
      scheduledAt: plan.plan.scheduledAt,
    }],
    skipDuplicates: true,
  });
  const updated = await client.issueAlertDelivery.updateMany({
    where: {
      tenancyId: scope.tenancyId,
      projectId: scope.projectId,
      branchId: scope.branchId,
      id: delivery.id,
      state: { in: [IssueAlertDeliveryState.FAILED, IssueAlertDeliveryState.DROPPED] },
      replayCount: delivery.replayCount,
    },
    data: {
      state: IssueAlertDeliveryState.ENQUEUED,
      outcome: IssueAlertDeliveryOutcome.WORKFLOW_ENQUEUED,
      workflowEventId: plan.plan.eventId,
      replayCount: { increment: 1 },
      nextRetryAt: null,
      lastError: null,
      completedAt: null,
      claimedAt: now,
      enqueuedAt: now,
    },
  });
  if (updated.count !== 1) {
    throw new Error("Issue alert replay lost its delivery claim; the transaction must be retried");
  }
  return {
    status: "replayed",
    deliveryId: delivery.id,
    workflowEventId: plan.plan.eventId,
    replayCount: plan.plan.replayCount,
  };
}

export async function replayIssueAlertWorkflowDelivery(
  scope: IssueAlertRuleScope,
  deliveryId: string,
  now = new Date(),
): Promise<IssueAlertWorkflowReplayResult> {
  validateScope(scope);
  if (!UUID_PATTERN.test(deliveryId)) return { status: "not_replayed", reason: "invalid_delivery_id" };
  validateDate(now, "issue alert replay time");
  return await retryTransaction(globalPrismaClient, async (tx) => await replayIssueAlertWorkflowDeliveryInTransaction(tx, scope, deliveryId, now), {
    level: "serializable",
  });
}
