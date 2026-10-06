import { IssueAlertDeliveryState, WorkflowRunState, type IssueAlertDeliveryState as IssueAlertDeliveryStateValue } from "@/generated/prisma/enums";
import {
  ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION,
  ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
} from "@/lib/workflows/issue-alerts/contract";
import {
  buildIssueAlertWorkflowReplayPlan,
  observationFromRunState,
  reconcileIssueAlertWorkflowRun,
  reconcilePendingIssueAlertWorkflowDeliveries,
  type IssueAlertWorkflowDeliveryRef,
  type IssueAlertWorkflowRunLookup,
  type IssueAlertWorkflowRunObservation,
  type IssueAlertWorkflowStatusStore,
} from "./workflow-status";
import type { IssueAlertWorkflowUpdate } from "./persistence";
import type { IssueAlertRuleScope } from "./types";
import { describe, expect, it } from "vitest";

const tenancyId = "00000000-0000-4000-8000-000000000001";
const triggerEventId = "00000000-0000-4000-8000-000000000003";
const deliveryId = "00000000-0000-4000-8000-000000000004";
const occurredAt = new Date("2026-08-06T12:00:00.000Z");

describe("issue-alert workflow run observations", () => {
  it("treats a completed durable email step as delivered during cooldown sleep", () => {
    expect(observationFromRunState(WorkflowRunState.SLEEPING, null, true)).toEqual({ status: "completed" });
    expect(observationFromRunState(WorkflowRunState.SLEEPING, null, false)).toEqual({ status: "in_flight" });
  });
});

const scope: IssueAlertRuleScope = {
  tenancyId,
  projectId: "project-status-test",
  branchId: "branch-status-test",
};

function makeStore(
  initialState: IssueAlertDeliveryStateValue = IssueAlertDeliveryState.ENQUEUED,
  applyResult = true,
): {
  store: IssueAlertWorkflowStatusStore,
  updates: IssueAlertWorkflowUpdate[],
} {
  let delivery: IssueAlertWorkflowDeliveryRef = {
    id: deliveryId,
    scope,
    workflowEventId: triggerEventId,
    state: initialState,
    nextRetryAt: null,
    lastAttemptAt: null,
  };
  const updates: IssueAlertWorkflowUpdate[] = [];
  return {
    updates,
    store: {
      async findDeliveryByWorkflowEventId(foundTenancyId, foundWorkflowEventId) {
        if (foundTenancyId !== tenancyId || foundWorkflowEventId !== delivery.workflowEventId) return null;
        return delivery;
      },
      async listEnqueuedDeliveries() {
        if (delivery.state !== IssueAlertDeliveryState.ENQUEUED) return [];
        return [delivery];
      },
      async applyWorkflowUpdate(updateScope, foundDeliveryId, expectedWorkflowEventId, expectedDelivery, update) {
        expect(updateScope).toEqual(delivery.scope);
        expect(foundDeliveryId).toBe(delivery.id);
        expect(expectedWorkflowEventId).toBe(delivery.workflowEventId);
        expect(expectedDelivery).toEqual({
          state: delivery.state,
          nextRetryAt: delivery.nextRetryAt,
          lastAttemptAt: delivery.lastAttemptAt,
        });
        if (!applyResult) return false;
        updates.push(update);
        if (update.kind === "delivered") {
          delivery = { ...delivery, state: IssueAlertDeliveryState.DELIVERED, nextRetryAt: null };
        } else if (update.kind === "dropped") {
          delivery = { ...delivery, state: IssueAlertDeliveryState.DROPPED, nextRetryAt: null, lastAttemptAt: update.at ?? null };
        }
        return true;
      },
    },
  };
}

function makeRuns(observation: IssueAlertWorkflowRunObservation): IssueAlertWorkflowRunLookup {
  return {
    async findRunByTriggerEventId(foundTenancyId, foundWorkflowEventId) {
      expect(foundTenancyId).toBe(tenancyId);
      expect(foundWorkflowEventId).toBe(triggerEventId);
      return observation;
    },
  };
}

function makeReplayPayload() {
  return {
    schema_version: ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION,
    kind: "issue_alert",
    event_kind: "new",
    project_id: scope.projectId,
    branch_id: scope.branchId,
    issue_id: "00000000-0000-4000-8000-000000000005",
    issue_short_id: "42",
    issue_status: "unresolved",
    occurrence_id: "occurrence-status-test",
    occurred_at_millis: occurredAt.getTime(),
    environment: "test",
    release: "status-test",
    summary: "Issue alert replay",
    culprit: "workflow-status.test.ts",
    rule_id: "status-test-rule",
    rule_version: 1,
    deduplication_key: "dedupe-status-test",
    cooldown_key: "cooldown-status-test",
    cooldown_seconds: 60,
    action: {
      type: "email",
      user_ids: ["user-status-test"],
      subject: "Issue alert",
      html: "<p>Issue alert</p>",
    },
  };
}

describe("issue-alert workflow run status", () => {
  it("maps completed, failed, and canceled runs onto durable delivery updates", async () => {
    const completed = makeStore();
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store: completed.store,
      runs: makeRuns({ status: "completed" }),
      at: occurredAt,
    })).toMatchObject({
      status: "reconciled",
      observation: "completed",
      update: { kind: "delivered" },
    });
    expect(completed.updates).toEqual([{ kind: "delivered", at: occurredAt }]);

    const failed = makeStore();
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store: failed.store,
      runs: makeRuns({ status: "failed", error: "sandbox exploded" }),
      at: occurredAt,
    })).toMatchObject({
      status: "reconciled",
      observation: "failed",
      update: { kind: "dropped", error: "sandbox exploded" },
    });

    const canceled = makeStore();
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store: canceled.store,
      runs: makeRuns({ status: "canceled" }),
      at: occurredAt,
    })).toMatchObject({
      status: "reconciled",
      observation: "canceled",
      update: { kind: "dropped" },
    });
  });

  it("waits while the run is missing or still in flight", async () => {
    const store = makeStore().store;
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store,
      runs: makeRuns({ status: "missing" }),
    })).toEqual({ status: "ignored", reason: "run_not_ready" });
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store,
      runs: makeRuns({ status: "in_flight" }),
    })).toEqual({ status: "ignored", reason: "run_not_ready" });
  });

  it("does not rewind a terminal delivery or a lost compare-and-set", async () => {
    const staleStore = makeStore(IssueAlertDeliveryState.DELIVERED);
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store: staleStore.store,
      runs: makeRuns({ status: "failed", error: "late" }),
    })).toEqual({ status: "ignored", reason: "stale_observation" });

    const raced = makeStore(IssueAlertDeliveryState.ENQUEUED, false);
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId,
      workflowEventId: triggerEventId,
      store: raced.store,
      runs: makeRuns({ status: "completed" }),
    })).toEqual({ status: "ignored", reason: "stale_observation" });
  });

  it("scans enqueued deliveries in one pass", async () => {
    const { store, updates } = makeStore();
    const result = await reconcilePendingIssueAlertWorkflowDeliveries({
      store,
      runs: makeRuns({ status: "completed" }),
      at: occurredAt,
    });
    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    expect(updates).toEqual([{ kind: "delivered", at: occurredAt }]);
  });

  it("continues beyond a full page of stalled deliveries", async () => {
    const secondEventId = "00000000-0000-4000-8000-000000000006";
    const secondDeliveryId = "00000000-0000-4000-8000-000000000007";
    const deliveries: IssueAlertWorkflowDeliveryRef[] = [
      {
        id: deliveryId,
        scope,
        workflowEventId: triggerEventId,
        state: IssueAlertDeliveryState.ENQUEUED,
        nextRetryAt: null,
        lastAttemptAt: null,
      },
      {
        id: secondDeliveryId,
        scope,
        workflowEventId: secondEventId,
        state: IssueAlertDeliveryState.ENQUEUED,
        nextRetryAt: null,
        lastAttemptAt: null,
      },
    ];
    const cursors: Array<{ tenancyId: string, id: string } | undefined> = [];
    const store: IssueAlertWorkflowStatusStore = {
      async findDeliveryByWorkflowEventId() { return null; },
      async listEnqueuedDeliveries(limit, afterDelivery) {
        cursors.push(afterDelivery);
        const start = afterDelivery === undefined
          ? 0
          : deliveries.findIndex(({ id }) => id === afterDelivery.id) + 1;
        return deliveries.slice(start, start + limit);
      },
      async applyWorkflowUpdate() { return true; },
    };
    const runs: IssueAlertWorkflowRunLookup = {
      async findRunByTriggerEventId(_tenancyId, workflowEventId) {
        return workflowEventId === secondEventId ? { status: "completed" } : { status: "in_flight" };
      },
    };

    expect(await reconcilePendingIssueAlertWorkflowDeliveries({ store, runs, limit: 1, at: occurredAt }))
      .toEqual({ scanned: 2, reconciled: 1 });
    expect(cursors).toEqual([
      undefined,
      { tenancyId, id: deliveryId },
      { tenancyId, id: secondDeliveryId },
    ]);
  });

  it("builds a deterministic replay event from the original trigger payload", () => {
    const input = {
      deliveryId,
      sourceEventId: triggerEventId,
      sourceEventType: ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
      sourcePayload: makeReplayPayload(),
      replayCount: 0,
      scheduledAt: occurredAt,
    };
    const first = buildIssueAlertWorkflowReplayPlan(input);
    const second = buildIssueAlertWorkflowReplayPlan(input);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") throw new Error("Expected replay plans");
    expect(first.plan.eventId).toBe(second.plan.eventId);
    expect(first.plan.replayCount).toBe(1);
    expect(new TextEncoder().encode(first.plan.payloadJson).byteLength).toBeLessThanOrEqual(32 * 1024);

    expect(buildIssueAlertWorkflowReplayPlan({ ...input, sourceEventType: "custom.other" })).toEqual({
      status: "drop",
      reason: "invalid_event_type",
    });
    expect(buildIssueAlertWorkflowReplayPlan({ ...input, replayCount: 1_000 })).toEqual({
      status: "drop",
      reason: "replay_limit",
    });

    const webhookReplay = buildIssueAlertWorkflowReplayPlan({
      ...input,
      sourcePayload: { ...makeReplayPayload(), action: { type: "webhook", integration_id: "integration-prod-errors" } },
    });
    expect(webhookReplay.status).toBe("ok");
  });
});
