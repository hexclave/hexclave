import { getSoleTenancyFromProjectBranch, DEFAULT_BRANCH_ID, type Tenancy } from "@/lib/tenancies";
import { IssueAlertDeliveryOutcome, IssueAlertDeliveryState, WorkflowRunState } from "@/generated/prisma/enums";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as errorUtils from "@hexclave/shared/dist/utils/errors";
import { ensureIssueAlertEmailWorkflow } from "./registration";
import { deleteWorkflow } from "../api";
import { ISSUE_ALERT_EMAIL_WORKFLOW_ID, ISSUE_ALERT_WORKFLOW_EVENT_TYPE, enqueueIssueAlertWorkflowEventWithWriter } from "./contract";
import { runWorkflowEngineStep } from "../engine";
import { deterministicWorkflowUuid, enqueueWorkflowEvent } from "../events";
import { evaluateIssueAlertRule } from "@/lib/issues/issue-alerts/evaluator";
import {
  claimIssueAlertDeliveryInTransaction,
  IssueAlertPersistenceService,
  recordIssueAlertWorkflowUpdateInTransaction,
  type IssueAlertRuleRecord,
} from "@/lib/issues/issue-alerts/persistence";
import {
  reconcileIssueAlertWorkflowRun,
  replayIssueAlertWorkflowDelivery,
} from "@/lib/issues/issue-alerts/workflow-status";
import type {
  IssueAlertMatch,
  IssueAlertRule,
  IssueAlertRuleScope,
  IssueAlertSignal,
} from "@/lib/issues/issue-alerts/types";

const RUN_PREFIX = `alert-delivery-proof-${randomUUID()}`;
const TEST_TIMEOUT_MS = 180_000;

let tenancy: Tenancy | undefined;
let scope: IssueAlertRuleScope | undefined;
let databaseRule: IssueAlertRuleRecord | undefined;
let issueId: string | undefined;
let issueShortId: bigint | undefined;
let recipientIds: string[] = [];
let recipientOwnerTeamId: string | undefined;
let service: IssueAlertPersistenceService | undefined;
let workflowWasCreated = false;
const eventIds: string[] = [];
const runIds: string[] = [];
const deliveryIds: string[] = [];
const subjects: string[] = [];

function getScope(): IssueAlertRuleScope {
  if (scope === undefined) throw new Error("Issue alert delivery proof scope was not initialized");
  return scope;
}

function getTenancy(): Tenancy {
  if (tenancy === undefined) throw new Error("Issue alert delivery proof tenancy was not initialized");
  return tenancy;
}

function getDatabaseRule(): IssueAlertRuleRecord {
  if (databaseRule === undefined) throw new Error("Issue alert delivery proof rule was not initialized");
  return databaseRule;
}

function getIssueId(): string {
  if (issueId === undefined) throw new Error("Issue alert delivery proof issue was not initialized");
  return issueId;
}

function getIssueShortId(): bigint {
  if (issueShortId === undefined) throw new Error("Issue alert delivery proof issue short id was not initialized");
  return issueShortId;
}

function getService(): IssueAlertPersistenceService {
  if (service === undefined) throw new Error("Issue alert delivery proof service was not initialized");
  return service;
}

function makeRule(): IssueAlertRule {
  return {
    schemaVersion: 1,
    id: RUN_PREFIX,
    version: 1,
    enabled: true,
    conditions: {},
    cooldown: { durationSeconds: 0, keyBy: "issue_environment" },
    action: {
      type: "email",
      userIds: recipientIds,
      subject: "unused",
      html: "unused",
    },
  };
}

function makeMatch(suffix: string): IssueAlertMatch {
  const subject = `Issue alert delivery proof ${RUN_PREFIX} ${suffix}`;
  subjects.push(subject);
  const rule: IssueAlertRule = {
    ...makeRule(),
    action: {
      type: "email",
      userIds: recipientIds,
      subject,
      html: `<!-- ${RUN_PREFIX} ${suffix} --> <p>Issue alert delivery proof</p>`,
    },
  };
  const signal: IssueAlertSignal = {
    tenancyId: getScope().tenancyId,
    projectId: getScope().projectId,
    branchId: getScope().branchId,
    issue: {
      id: getIssueId(),
      shortId: getIssueShortId().toString(),
      type: "AlertDeliveryProofError",
      value: `${RUN_PREFIX} ${suffix}`,
      culprit: "delivery-proof.test.ts",
      status: "unresolved",
      isNew: true,
      isRegression: false,
    },
    occurrence: {
      id: `${RUN_PREFIX}-${suffix}`,
      occurredAt: new Date("2026-08-06T12:00:00.000Z"),
    },
    environment: `test-${suffix}`,
    release: RUN_PREFIX,
    tags: new Map([["proof", "issue-alert-delivery"]]),
    attributes: new Map([["proof", true]]),
    frequencyCounts: new Map(),
  };
  const evaluation = evaluateIssueAlertRule(rule, signal);
  if (evaluation.outcome !== "match") throw new Error(`Expected an issue-alert match, received ${evaluation.outcome}`);
  return evaluation;
}

async function createEnqueuedDelivery(match: IssueAlertMatch, scheduledAt?: Date): Promise<{ deliveryId: string, eventId: string, runId: string }> {
  const targetTenancy = getTenancy();
  const targetScope = getScope();
  const targetRule = getDatabaseRule();
  const now = new Date();
  const result = await retryTransaction(globalPrismaClient, async (tx) => {
    const claim = await claimIssueAlertDeliveryInTransaction(tx, {
      scope: targetScope,
      databaseRuleId: targetRule.databaseId,
      match,
      now,
    });
    if (claim.status !== "claimed") throw new Error(`Expected a claimed issue-alert delivery, received ${claim.status}`);

    const enqueued = await enqueueIssueAlertWorkflowEventWithWriter(targetTenancy, match, async (write) => {
      return await enqueueWorkflowEvent(tx, { ...write, ...(scheduledAt === undefined ? {} : { scheduledAt }) });
    });
    if (enqueued.status !== "enqueued") throw new Error(`Expected an enqueued issue-alert event, received ${enqueued.status}`);
    await recordIssueAlertWorkflowUpdateInTransaction(tx, targetScope, claim.delivery.id, {
      kind: "enqueued",
      workflowEventId: enqueued.eventId,
      at: now,
    });
    return {
      deliveryId: claim.delivery.id,
      eventId: enqueued.eventId,
      runId: deterministicWorkflowUuid(`run:${targetTenancy.id}:${enqueued.eventId}:${ISSUE_ALERT_EMAIL_WORKFLOW_ID}`),
    };
  }, { level: "serializable" });
  eventIds.push(result.eventId);
  runIds.push(result.runId);
  deliveryIds.push(result.deliveryId);
  return result;
}

async function tickUntil(check: () => Promise<boolean>, workflowEventId?: string): Promise<void> {
  if (await check()) return;
  const deadline = performance.now() + TEST_TIMEOUT_MS;
  while (performance.now() < deadline) {
    await runWorkflowEngineStep({ deadlineMs: Date.now() + 5_000 });
    if (workflowEventId !== undefined) {
      await reconcileIssueAlertWorkflowRun({ tenancyId: getTenancy().id, workflowEventId });
    }
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Issue alert delivery proof did not converge within ${TEST_TIMEOUT_MS}ms`);
}

async function materializeWorkflowRun(run: { runId: string }): Promise<void> {
  const deadline = performance.now() + TEST_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const existing = await globalPrismaClient.workflowRun.findUnique({
      where: { tenancyId_id: { tenancyId: getTenancy().id, id: run.runId } },
      select: { id: true },
    });
    if (existing !== null) return;
    await runWorkflowEngineStep({ deadlineMs: Date.now() + 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Workflow event did not materialize parent run ${run.runId} within ${TEST_TIMEOUT_MS}ms`);
}

async function makeWorkflowRunDue(run: { runId: string }): Promise<void> {
  const updated = await globalPrismaClient.workflowRun.updateMany({
    where: { tenancyId: getTenancy().id, id: run.runId, state: "QUEUED" },
    data: { wakeAt: new Date() },
  });
  if (updated.count === 1) return;
  const existing = await globalPrismaClient.workflowRun.findUnique({
    where: { tenancyId_id: { tenancyId: getTenancy().id, id: run.runId } },
    select: { state: true },
  });
  if (existing?.state === WorkflowRunState.COMPLETED) return;
  throw new Error(`Workflow run ${run.runId} was not queued after event materialization`);
}

async function terminalizeWorkflowRun(run: { runId: string }): Promise<void> {
  const updated = await globalPrismaClient.workflowRun.updateMany({
    where: { tenancyId: getTenancy().id, id: run.runId },
    data: {
      state: WorkflowRunState.FAILED,
      wakeAt: null,
      leaseUntil: null,
      completedAt: new Date(),
      errorSummary: "proof terminal failure",
    },
  });
  if (updated.count !== 1) {
    const existing = await globalPrismaClient.workflowRun.findUnique({
      where: { tenancyId_id: { tenancyId: getTenancy().id, id: run.runId } },
      select: { id: true, state: true, triggerEventId: true },
    });
    throw new Error(`Expected proof run ${run.runId} to become terminal; existing=${JSON.stringify(existing)}`);
  }
}

async function outboxRows(subject: string) {
  return await globalPrismaClient.emailOutbox.findMany({
    where: { tenancyId: getTenancy().id, overrideSubject: subject },
    orderBy: { id: "asc" },
    select: { id: true, to: true },
  });
}

describe.sequential("issue alert workflow delivery proof", () => {
  beforeAll(async () => {
    vi.stubEnv("STACK_EMAIL_BRANCHING_DISABLE_QUEUE_AUTO_TRIGGER", "true");
    const internalTenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID);
    // Explicit alert recipients must be owner-team members with a primary email.
    // A run-scoped owner team keeps the fixture out of the real owner team.
    const ownerTeamId = randomUUID();
    await globalPrismaClient.team.create({
      data: {
        tenancyId: internalTenancy.id,
        teamId: ownerTeamId,
        mirroredProjectId: internalTenancy.project.id,
        mirroredBranchId: internalTenancy.branchId,
        displayName: `${RUN_PREFIX}-owner-team`,
      },
    });
    recipientOwnerTeamId = ownerTeamId;
    tenancy = { ...internalTenancy, project: { ...internalTenancy.project, owner_team_id: ownerTeamId } };
    scope = { tenancyId: tenancy.id, projectId: tenancy.project.id, branchId: tenancy.branchId };
    service = new IssueAlertPersistenceService();
    recipientIds = [randomUUID(), randomUUID()];
    for (const [index, projectUserId] of recipientIds.entries()) {
      await globalPrismaClient.projectUser.create({
        data: {
          tenancyId: tenancy.id,
          projectUserId,
          mirroredProjectId: tenancy.project.id,
          mirroredBranchId: tenancy.branchId,
          contactChannels: {
            create: {
              type: "EMAIL",
              isPrimary: "TRUE",
              isVerified: true,
              value: `${RUN_PREFIX}-${index}@example.com`,
            },
          },
        },
      });
      await globalPrismaClient.teamMember.create({
        data: { tenancyId: tenancy.id, projectUserId, teamId: ownerTeamId },
      });
    }

    const counter = await globalPrismaClient.issueCounter.upsert({
      where: { tenancyId: tenancy.id },
      create: { tenancyId: tenancy.id, nextShortId: 2n },
      update: { nextShortId: { increment: 1n } },
      select: { nextShortId: true },
    });
    issueId = randomUUID();
    issueShortId = counter.nextShortId - 1n;
    await globalPrismaClient.issue.create({
      data: {
        id: issueId,
        tenancyId: tenancy.id,
        shortId: issueShortId,
        type: "AlertDeliveryProofError",
        value: `${RUN_PREFIX} issue`,
        culprit: "delivery-proof.test.ts",
        platform: "node",
        firstSeenAt: new Date("2026-08-06T12:00:00.000Z"),
        lastSeenAt: new Date("2026-08-06T12:00:00.000Z"),
      },
    });

    const registration = await ensureIssueAlertEmailWorkflow(tenancy);
    workflowWasCreated = registration.status === "created";
    databaseRule = await service.saveRule(getScope(), makeRule());

    vi.spyOn(errorUtils, "captureError").mockImplementation((location, error) => {
      if (location === "workflow-run-execution" || location === "workflow-event-processing") throw error;
    });
  });

  afterAll(async () => {
    if (tenancy !== undefined) {
      if (subjects.length > 0) {
        await globalPrismaClient.emailOutbox.deleteMany({
          where: { tenancyId: tenancy.id, overrideSubject: { in: subjects } },
        });
      }
      if (eventIds.length > 0) {
        await globalPrismaClient.workflowEvent.deleteMany({ where: { tenancyId: tenancy.id, id: { in: eventIds } } });
      }
      if (runIds.length > 0) {
        await globalPrismaClient.workflowRun.deleteMany({ where: { tenancyId: tenancy.id, id: { in: runIds } } });
      }
      if (deliveryIds.length > 0) {
        await globalPrismaClient.issueAlertDelivery.deleteMany({ where: { tenancyId: tenancy.id, id: { in: deliveryIds } } });
      }
      if (databaseRule !== undefined) {
        await globalPrismaClient.issueAlertCooldownClaim.deleteMany({ where: { tenancyId: tenancy.id, ruleId: databaseRule.databaseId } });
        await globalPrismaClient.issueAlertRule.deleteMany({ where: { tenancyId: tenancy.id, id: databaseRule.databaseId } });
      }
      if (issueId !== undefined) {
        await globalPrismaClient.issue.deleteMany({ where: { tenancyId: tenancy.id, id: issueId } });
      }
      if (workflowWasCreated) {
        await deleteWorkflow(tenancy, ISSUE_ALERT_EMAIL_WORKFLOW_ID);
      }
      if (recipientOwnerTeamId !== undefined) {
        await globalPrismaClient.teamMember.deleteMany({ where: { tenancyId: tenancy.id, teamId: recipientOwnerTeamId } });
        await globalPrismaClient.team.deleteMany({ where: { tenancyId: tenancy.id, teamId: recipientOwnerTeamId } });
      }
      if (recipientIds.length > 0) {
        await globalPrismaClient.projectUser.deleteMany({
          where: { tenancyId: tenancy.id, projectUserId: { in: recipientIds } },
        });
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("crosses the issue-alert event and workflow source into one EmailOutbox row per recipient", async () => {
    const created = await createEnqueuedDelivery(makeMatch("source"), new Date("2099-01-01T00:00:00.000Z"));
    await materializeWorkflowRun(created);
    await expect(globalPrismaClient.workflowRun.findUnique({
      where: { tenancyId_id: { tenancyId: getTenancy().id, id: created.runId } },
      select: { id: true },
    })).resolves.not.toBeNull();
    await makeWorkflowRunDue(created);

    await tickUntil(async () => {
      const delivery = await getService().inspectDelivery(getScope(), created.deliveryId);
      const run = await globalPrismaClient.workflowRun.findUnique({
        where: { tenancyId_id: { tenancyId: getTenancy().id, id: created.runId } },
        select: { state: true },
      });
      const rows = await outboxRows(subjects[0]);
      return delivery?.state === IssueAlertDeliveryState.DELIVERED
        && delivery.outcome === IssueAlertDeliveryOutcome.WORKFLOW_DELIVERED
        && run?.state === WorkflowRunState.COMPLETED
        && rows.length === recipientIds.length;
    }, created.eventId);

    const rows = await outboxRows(subjects[0]);
    expect(rows).toHaveLength(recipientIds.length);
    expect(rows.map((row) => row.to)).toEqual(expect.arrayContaining(recipientIds.map((userId) => ({ type: "user-primary-email", userId }))));
    const delivery = await getService().inspectDelivery(getScope(), created.deliveryId);
    expect(delivery).toMatchObject({
      state: IssueAlertDeliveryState.DELIVERED,
      outcome: IssueAlertDeliveryOutcome.WORKFLOW_DELIVERED,
      workflowEventId: created.eventId,
      attemptCount: 1,
    });
  }, TEST_TIMEOUT_MS);

  it("drops a terminal workflow failure and still accepts a durable replay", async () => {
    const created = await createEnqueuedDelivery(makeMatch("lifecycle"), new Date("2099-01-01T00:00:00.000Z"));
    await materializeWorkflowRun(created);
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId: getTenancy().id,
      workflowEventId: created.eventId,
    })).toEqual({ status: "ignored", reason: "run_not_ready" });

    await terminalizeWorkflowRun(created);
    expect(await reconcileIssueAlertWorkflowRun({
      tenancyId: getTenancy().id,
      workflowEventId: created.eventId,
    })).toMatchObject({
      status: "reconciled",
      observation: "failed",
      update: { kind: "dropped" },
    });
    await expect(getService().inspectDelivery(getScope(), created.deliveryId)).resolves.toMatchObject({
      state: IssueAlertDeliveryState.DROPPED,
      outcome: IssueAlertDeliveryOutcome.WORKFLOW_DROPPED,
      nextRetryAt: null,
    });

    const replayed = await replayIssueAlertWorkflowDelivery(getScope(), created.deliveryId, new Date("2099-01-01T00:00:40.000Z"));
    expect(replayed).toMatchObject({ status: "replayed", deliveryId: created.deliveryId, replayCount: 1 });
    if (replayed.status !== "replayed") throw new Error("Expected issue-alert replay to be accepted");
    eventIds.push(replayed.workflowEventId);
    const replayRun = { runId: deterministicWorkflowUuid(`run:${getTenancy().id}:${replayed.workflowEventId}:${ISSUE_ALERT_EMAIL_WORKFLOW_ID}`) };
    runIds.push(replayRun.runId);
    await materializeWorkflowRun(replayRun);
    await makeWorkflowRunDue(replayRun);

    await tickUntil(async () => {
      const delivery = await getService().inspectDelivery(getScope(), created.deliveryId);
      const rows = await outboxRows(subjects[1]);
      return delivery?.state === IssueAlertDeliveryState.DELIVERED && rows.length === recipientIds.length;
    }, replayed.workflowEventId);

    const rows = await outboxRows(subjects[1]);
    expect(rows).toHaveLength(recipientIds.length);
    expect(rows.map((row) => row.to)).toEqual(expect.arrayContaining(recipientIds.map((userId) => ({ type: "user-primary-email", userId }))));
    await expect(getService().inspectDelivery(getScope(), created.deliveryId)).resolves.toMatchObject({
      state: IssueAlertDeliveryState.DELIVERED,
      outcome: IssueAlertDeliveryOutcome.WORKFLOW_DELIVERED,
      replayCount: 1,
      workflowEventId: replayed.workflowEventId,
      nextRetryAt: null,
    });
  }, TEST_TIMEOUT_MS);
});
