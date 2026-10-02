import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { evaluateIssueAlertRule } from "./evaluator";
import {
  IssueAlertPersistenceInputError,
  IssueAlertPersistenceService,
  parseStoredIssueAlertRule,
  type IssueAlertRuleRecord,
} from "./persistence";
import type { IssueAlertRule, IssueAlertRuleScope, IssueAlertSignal } from "./types";

const RUN_PREFIX = `alert-persistence-${randomUUID()}`;
const WORKFLOW_EVENT_ID = "00000000-0000-4000-8000-000000000099";
const now = new Date("2026-08-06T12:00:00.000Z");

let tenancy: Tenancy;
let otherTenancy: Tenancy;
let issueId: string;
let service: IssueAlertPersistenceService;
let scope: IssueAlertRuleScope;
let otherScope: IssueAlertRuleScope;
let databaseRule: IssueAlertRuleRecord;

function toScope(target: Tenancy): IssueAlertRuleScope {
  return { tenancyId: target.id, projectId: target.project.id, branchId: target.branchId };
}

function makeRule(ruleId = `${RUN_PREFIX}-rule`, version = 1, cooldownSeconds = 60): IssueAlertRule {
  return {
    schemaVersion: 1,
    id: ruleId,
    version,
    enabled: true,
    conditions: {},
    cooldown: { durationSeconds: cooldownSeconds, keyBy: "issue" },
    action: {
      type: "email",
      userIds: [`${RUN_PREFIX}-user`],
      subject: "Issue alert",
      html: "<p>Issue alert</p>",
    },
  };
}

function makeSignal(occurrenceId: string, targetScope = scope): IssueAlertSignal {
  return {
    tenancyId: targetScope.tenancyId,
    projectId: targetScope.projectId,
    branchId: targetScope.branchId,
    issue: {
      id: issueId,
      shortId: "1",
      type: "TypeError",
      value: "alert persistence test",
      culprit: "persistence.test.ts",
      status: "unresolved",
      isNew: true,
      isRegression: false,
    },
    occurrence: { id: occurrenceId, occurredAt: now },
    environment: "test",
    release: "alert-persistence",
    tags: new Map([["suite", "alert-persistence"]]),
    attributes: new Map([["test", true]]),
    frequencyCounts: new Map(),
  };
}

function evaluateMatch(rule: IssueAlertRule, occurrenceId: string) {
  const evaluation = evaluateIssueAlertRule(rule, makeSignal(occurrenceId));
  if (evaluation.outcome !== "match") throw new Error(`Expected a match, received ${evaluation.outcome}`);
  return evaluation;
}

function getClaimedDelivery(results: readonly Awaited<ReturnType<IssueAlertPersistenceService["claimDelivery"]>>[]) {
  const claimed = results.find((result) => result.status === "claimed");
  if (claimed?.status !== "claimed") throw new Error("The concurrent claim did not produce a winner");
  return claimed.delivery;
}

beforeAll(async () => {
  service = new IssueAlertPersistenceService();
  const tenancies = await globalPrismaClient.tenancy.findMany({ orderBy: { id: "asc" }, take: 2 });
  if (tenancies.length < 2) throw new Error("Alert persistence integration tests need two seeded tenancies.");
  const first = await getTenancy(tenancies[0].id);
  const second = await getTenancy(tenancies[1].id);
  if (first === null || second === null) throw new Error("The alert persistence test tenancies disappeared.");
  tenancy = first;
  otherTenancy = second;
  scope = toScope(tenancy);
  otherScope = toScope(otherTenancy);

  const counter = await globalPrismaClient.issueCounter.upsert({
    where: { tenancyId: scope.tenancyId },
    create: { tenancyId: scope.tenancyId, nextShortId: 2n },
    update: { nextShortId: { increment: 1n } },
    select: { nextShortId: true },
  });
  issueId = randomUUID();
  await globalPrismaClient.issue.create({
    data: {
      id: issueId,
      tenancyId: scope.tenancyId,
      shortId: counter.nextShortId - 1n,
      type: "AlertPersistenceTestError",
      value: `${RUN_PREFIX}-issue`,
      culprit: "persistence.test.ts",
      platform: "node",
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
    },
  });
});

afterAll(async () => {
  const ruleRows = await globalPrismaClient.issueAlertRule.findMany({
    where: {
      OR: [
        { tenancyId: scope.tenancyId, ruleKey: { startsWith: RUN_PREFIX } },
        { tenancyId: otherScope.tenancyId, ruleKey: { startsWith: RUN_PREFIX } },
      ],
    },
    select: { tenancyId: true, id: true },
  });
  const ruleReferences = ruleRows.map((row) => ({ tenancyId: row.tenancyId, ruleId: row.id }));
  await globalPrismaClient.issueAlertDelivery.deleteMany({
    where: { OR: ruleReferences },
  });
  await globalPrismaClient.issueAlertCooldownClaim.deleteMany({
    where: { OR: ruleReferences },
  });
  await globalPrismaClient.issueAlertRule.deleteMany({
    where: { OR: [{ tenancyId: scope.tenancyId, ruleKey: { startsWith: RUN_PREFIX } }, { tenancyId: otherScope.tenancyId, ruleKey: { startsWith: RUN_PREFIX } }] },
  });
  await globalPrismaClient.issue.deleteMany({ where: { tenancyId: scope.tenancyId, id: issueId } });
});

describe("issue alert rule persistence", () => {
  it("fails closed for malformed and oversized stored JSON", () => {
    const valid = makeRule();
    const row = {
      id: randomUUID(),
      tenancyId: scope.tenancyId,
      projectId: scope.projectId,
      branchId: scope.branchId,
      ruleKey: valid.id,
      version: valid.version,
      schemaVersion: valid.schemaVersion,
      enabled: valid.enabled,
      config: valid,
    };
    expect(parseStoredIssueAlertRule(row)).toEqual(valid);
    expect(parseStoredIssueAlertRule({ ...row, config: { ...valid, cooldown: { durationSeconds: -1, keyBy: "issue" } } })).toBeNull();
    expect(parseStoredIssueAlertRule({ ...row, config: { ...valid, action: { ...valid.action, html: "x".repeat(70_000) } } })).toBeNull();
    expect(parseStoredIssueAlertRule({ ...row, config: { ...valid, conditions: { all: [{ type: "unknown", value: true }] } } })).toBeNull();
  });

  it("saves and lists only the newest valid active version inside its scope", async () => {
    const rule = makeRule();
    databaseRule = await service.saveRule(scope, rule);
    await service.saveRule(scope, { ...rule, version: 2 });
    await service.saveRule(scope, { ...rule, version: 3, enabled: false });

    const records = await service.listActiveRuleRecords(scope);
    const matching = records.filter((record) => record.rule.id === rule.id);
    expect(matching).toHaveLength(1);
    expect(matching[0].rule.version).toBe(2);
    expect((await service.listActiveRules(otherScope)).some((candidate) => candidate.id === rule.id)).toBe(false);

    await service.saveRule(otherScope, rule);
    expect((await service.listActiveRules(otherScope)).some((candidate) => candidate.id === rule.id)).toBe(true);
    expect((await service.listActiveRules(scope)).filter((candidate) => candidate.id === rule.id)).toHaveLength(1);
  });

  it("claims a deduplication key once and a cooldown key once under concurrency", async () => {
    const rule = makeRule(`${RUN_PREFIX}-race-rule`, 1, 300);
    databaseRule = await service.saveRule(scope, rule);
    const match = evaluateMatch(rule, `${RUN_PREFIX}-occurrence-dedupe`);
    const sameKeyResults = await Promise.all([
      service.claimDelivery({ scope, databaseRuleId: databaseRule.databaseId, match, now }),
      service.claimDelivery({ scope, databaseRuleId: databaseRule.databaseId, match, now }),
    ]);
    expect(sameKeyResults.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(sameKeyResults.filter((result) => result.status === "duplicate")).toHaveLength(1);

    const nextMatch = evaluateMatch(rule, `${RUN_PREFIX}-occurrence-cooldown`);
    const suppressed = await service.claimDelivery({ scope, databaseRuleId: databaseRule.databaseId, match: nextMatch, now });
    expect(suppressed.status).toBe("cooldown_active");
    expect(suppressed.status === "cooldown_active" ? suppressed.delivery.outcome : null).toBe("COOLDOWN_ACTIVE");

    const otherMatchEvaluation = evaluateIssueAlertRule(rule, makeSignal(`${RUN_PREFIX}-occurrence-other-scope`, otherScope));
    if (otherMatchEvaluation.outcome !== "match") throw new Error("Expected an other-scope alert match");
    const invalidScope = await service.claimDelivery({
      scope: otherScope,
      databaseRuleId: databaseRule.databaseId,
      match: otherMatchEvaluation,
      now,
    });
    expect(invalidScope).toEqual({ status: "invalid_rule" });
  });

  it("records Workflows enqueue and drop", async () => {
    const rule = makeRule(`${RUN_PREFIX}-workflow-rule`, 1, 0);
    databaseRule = await service.saveRule(scope, rule);
    const match = evaluateMatch(rule, `${RUN_PREFIX}-occurrence-workflow`);
    const claim = await service.claimDelivery({ scope, databaseRuleId: databaseRule.databaseId, match, now });
    const delivery = getClaimedDelivery([claim]);

    const enqueued = await service.recordWorkflowUpdate(scope, delivery.id, {
      kind: "enqueued",
      workflowEventId: WORKFLOW_EVENT_ID,
      at: now,
    });
    expect(enqueued.state).toBe("ENQUEUED");
    expect(enqueued.workflowEventId).toBe(WORKFLOW_EVENT_ID);

    const dropped = await service.recordWorkflowUpdate(scope, delivery.id, {
      kind: "dropped",
      error: "workflow execution failed",
      at: now,
    });
    expect(dropped.state).toBe("DROPPED");
    expect(dropped.attemptCount).toBe(1);
  });

  it("rejects unbounded workflow errors and invalid list limits", async () => {
    const rule = makeRule(`${RUN_PREFIX}-validation-rule`, 1, 0);
    databaseRule = await service.saveRule(scope, rule);
    const match = evaluateMatch(rule, `${RUN_PREFIX}-occurrence-validation`);
    const claim = await service.claimDelivery({ scope, databaseRuleId: databaseRule.databaseId, match, now });
    const delivery = getClaimedDelivery([claim]);
    await expect(service.recordWorkflowUpdate(scope, delivery.id, {
      kind: "dropped",
      error: "x".repeat(9_000),
    })).rejects.toBeInstanceOf(IssueAlertPersistenceInputError);
    await expect(service.listDeliveries(scope, 0)).rejects.toBeInstanceOf(IssueAlertPersistenceInputError);
  });
});
