import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { enqueueIssueAlertWorkflowEvent } from "@/lib/workflows/issue-alerts/contract";
import type { SmartRequest } from "@/route-handlers/smart-request";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateIssueAlertRule } from "@/lib/issues/issue-alerts/evaluator";
import {
  IssueAlertPersistenceService,
  type IssueAlertDeliverySnapshot,
  type IssueAlertRuleRecord,
} from "@/lib/issues/issue-alerts/persistence";
import type { IssueAlertRule, IssueAlertSignal } from "@/lib/issues/issue-alerts/types";
import { GET as listRules } from "./route";
import { GET as getRule } from "./[rule_id]/route";
import { POST as disableRule } from "./[rule_id]/disable/route";
import { GET as listDeliveries } from "./deliveries/route";
import { GET as getDelivery } from "./deliveries/[delivery_id]/route";
import { POST as replayDelivery } from "./deliveries/[delivery_id]/replay/route";

const RUN_PREFIX = `alert-api-${randomUUID()}`;
const TEST_TIME = new Date("2026-08-06T12:00:00.000Z");

let tenancy: Tenancy;
let otherTenancy: Tenancy | null = null;
const service = new IssueAlertPersistenceService();
const createdRules: Array<{ tenancyId: string, id: string }> = [];
const createdDeliveries: Array<{ tenancyId: string, id: string }> = [];
const createdWorkflowEvents: Array<{ tenancyId: string, id: string }> = [];
const createdCooldowns: Array<{ tenancyId: string, key: string }> = [];
const createdIssues: Array<{ tenancyId: string, id: string }> = [];
const createdRedirects: Array<{ tenancyId: string, id: string }> = [];

function scope(target: Tenancy) {
  return { tenancyId: target.id, projectId: target.project.id, branchId: target.branchId };
}

function makeRule(ruleId: string, version = 1, enabled = true): IssueAlertRule {
  return {
    schemaVersion: 1,
    id: ruleId,
    version,
    enabled,
    conditions: {},
    cooldown: { durationSeconds: 0, keyBy: "issue" },
    action: {
      type: "email",
      userIds: [randomUUID()],
      subject: "Issue alert API test",
      html: "<p>Issue alert API test</p>",
    },
  };
}

async function createIssue(target: Tenancy): Promise<{ id: string, shortId: bigint }> {
  const targetScope = scope(target);
  const counter = await globalPrismaClient.issueCounter.upsert({
    where: { tenancyId: targetScope.tenancyId },
    create: { tenancyId: targetScope.tenancyId, nextShortId: 2n },
    update: { nextShortId: { increment: 1n } },
    select: { nextShortId: true },
  });
  const issue = {
    id: randomUUID(),
    shortId: counter.nextShortId - 1n,
  };
  await globalPrismaClient.issue.create({
    data: {
      id: issue.id,
      tenancyId: targetScope.tenancyId,
      shortId: issue.shortId,
      type: "AlertApiTestError",
      value: `${RUN_PREFIX}-issue`,
      culprit: "alerts/route.test.ts",
      platform: "node",
      firstSeenAt: TEST_TIME,
      lastSeenAt: TEST_TIME,
      timesSeen: 1n,
    },
  });
  createdIssues.push({ tenancyId: targetScope.tenancyId, id: issue.id });
  return issue;
}

async function createDelivery(target: Tenancy, rule: IssueAlertRuleRecord): Promise<IssueAlertDeliverySnapshot> {
  const issue = await createIssue(target);
  const signal: IssueAlertSignal = {
    ...scope(target),
    issue: {
      id: issue.id,
      shortId: issue.shortId.toString(),
      type: "AlertApiTestError",
      value: `${RUN_PREFIX}-issue`,
      culprit: "alerts/route.test.ts",
      status: "unresolved",
      isNew: true,
      isRegression: false,
    },
    occurrence: { id: `${RUN_PREFIX}-${randomUUID()}`, occurredAt: TEST_TIME },
    environment: "test",
    release: RUN_PREFIX,
    tags: new Map([["suite", "alert-api"]]),
    attributes: new Map([["route_test", true]]),
    frequencyCounts: new Map(),
  };
  const evaluation = evaluateIssueAlertRule(rule.rule, signal);
  if (evaluation.outcome !== "match") throw new Error(`Expected an alert match, got ${evaluation.outcome}`);
  const claim = await service.claimDelivery({
    scope: scope(target),
    databaseRuleId: rule.databaseId,
    match: evaluation,
    now: TEST_TIME,
  });
  if (claim.status !== "claimed") throw new Error(`Expected a claimed delivery, got ${claim.status}`);
  createdDeliveries.push({ tenancyId: target.id, id: claim.delivery.id });
  createdCooldowns.push({ tenancyId: target.id, key: claim.delivery.cooldownKey });
  // Recipient resolution against the owner team is covered by the delivery-proof
  // and owner-team-recipients suites; these route tests only need a stored event.
  const enqueue = await enqueueIssueAlertWorkflowEvent(globalPrismaClient, { id: target.id }, evaluation);
  if (enqueue.status !== "enqueued") throw new Error(`Expected a workflow event, got ${enqueue.status}`);
  createdWorkflowEvents.push({ tenancyId: target.id, id: enqueue.eventId });
  await service.recordWorkflowUpdate(scope(target), claim.delivery.id, {
    kind: "enqueued",
    workflowEventId: enqueue.eventId,
    at: TEST_TIME,
  });
  const dropped = await service.recordWorkflowUpdate(scope(target), claim.delivery.id, {
    kind: "dropped",
    error: "test workflow failure",
    at: TEST_TIME,
  });
  return dropped;
}

function request(target: Tenancy, options: {
  method: "GET" | "POST",
  params?: Record<string, string>,
  query?: Record<string, string>,
  type?: "client" | "server",
}): SmartRequest {
  return {
    auth: {
      type: options.type ?? "server",
      project: target.project,
      branchId: target.branchId,
      tenancy: target,
    },
    url: "http://localhost/api/latest/issues/alerts",
    method: options.method,
    body: {},
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    clientVersion: undefined,
  };
}

async function findPopulatedTenanciesWithObservabilityEnabled(): Promise<Tenancy[]> {
  const rows = await globalPrismaClient.$queryRaw<Array<{ id: string }>>`
    SELECT t."id"::text AS "id"
    FROM "Tenancy" t
    LEFT JOIN "ProjectUser" u ON u."tenancyId" = t."id"
    GROUP BY t."id"
    ORDER BY count(u."projectUserId") DESC, t."id" ASC
    LIMIT 2
  `;
  const result: Tenancy[] = [];
  for (const row of rows) {
    const candidate = await getTenancy(row.id);
    if (candidate !== null) result.push(withObservabilityEnabled(candidate));
  }
  return result;
}

function withObservabilityEnabled(target: Tenancy): Tenancy {
  return {
    ...target,
    config: {
      ...target.config,
      apps: {
        ...target.config.apps,
        installed: {
          ...target.config.apps.installed,
          observability: { ...target.config.apps.installed["observability"], enabled: true },
        },
      },
    },
  };
}

beforeAll(async () => {
  const candidates = await findPopulatedTenanciesWithObservabilityEnabled();
  const first = candidates.at(0);
  if (first === undefined) throw new Error("Issue alert API route tests need a tenancy in the development database.");
  tenancy = first;
  otherTenancy = candidates.find((candidate) => candidate.id !== tenancy.id) ?? null;
});

afterAll(async () => {
  await globalPrismaClient.issueRedirect.deleteMany({
    where: { OR: createdRedirects.map((redirect) => ({ tenancyId: redirect.tenancyId, fromIssueId: redirect.id })) },
  });
  await globalPrismaClient.workflowEvent.deleteMany({
    where: { OR: createdWorkflowEvents.map((event) => ({ tenancyId: event.tenancyId, id: event.id })) },
  });
  await globalPrismaClient.issueAlertDelivery.deleteMany({
    where: { OR: createdDeliveries.map((delivery) => ({ tenancyId: delivery.tenancyId, id: delivery.id })) },
  });
  await globalPrismaClient.issueAlertCooldownClaim.deleteMany({
    where: { OR: createdCooldowns.map((cooldown) => ({ tenancyId: cooldown.tenancyId, cooldownKey: cooldown.key })) },
  });
  await globalPrismaClient.issueAlertRule.deleteMany({
    where: { OR: createdRules.map((rule) => ({ tenancyId: rule.tenancyId, id: rule.id })) },
  });
  await globalPrismaClient.issue.deleteMany({
    where: { OR: createdIssues.map((issue) => ({ tenancyId: issue.tenancyId, id: issue.id })) },
  });
});

describe("authenticated issue alert management routes", () => {
  it("lists and details only bounded, active rules inside the authorized branch", async () => {
    const firstRule = await service.saveRule(scope(tenancy), makeRule(`${RUN_PREFIX}-list-one`));
    const secondRule = await service.saveRule(scope(tenancy), makeRule(`${RUN_PREFIX}-list-two`));
    createdRules.push({ tenancyId: tenancy.id, id: firstRule.databaseId }, { tenancyId: tenancy.id, id: secondRule.databaseId });

    const listed = await listRules.invoke(request(tenancy, { method: "GET", query: { limit: "1" } }));
    expect(listed.body).toMatchObject({ truncated: true });
    expect(listed.body.rules).toHaveLength(1);

    const detail = await getRule.invoke(request(tenancy, {
      method: "GET",
      params: { rule_id: firstRule.databaseId },
    }));
    expect(detail.body).toMatchObject({ rule: { database_id: firstRule.databaseId, id: firstRule.rule.id } });

    await expect(listRules.invoke(request(tenancy, { method: "GET", query: { limit: "101" } })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 400 });
    await expect(listRules.invoke(request(tenancy, { method: "GET", type: "client" })))
      .rejects.toMatchObject({ name: "HexclaveAssertionError" });

    if (otherTenancy !== null) {
      const foreign = await service.saveRule(scope(otherTenancy), makeRule(`${RUN_PREFIX}-foreign`));
      createdRules.push({ tenancyId: otherTenancy.id, id: foreign.databaseId });
      await expect(getRule.invoke(request(tenancy, { method: "GET", params: { rule_id: foreign.databaseId } })))
        .rejects.toMatchObject({ name: "StatusError", statusCode: 404 });
    }
  });

  it("lists and details deliveries, follows a redirect, and replays idempotently", async () => {
    const rule = await service.saveRule(scope(tenancy), makeRule(`${RUN_PREFIX}-delivery`));
    createdRules.push({ tenancyId: tenancy.id, id: rule.databaseId });
    const delivery = await createDelivery(tenancy, rule);
    const survivor = await createIssue(tenancy);
    await globalPrismaClient.issueRedirect.create({
      data: {
        tenancyId: tenancy.id,
        fromIssueId: delivery.issueId,
        toIssueId: survivor.id,
        fromShortId: BigInt(9_000_000),
      },
    });
    createdRedirects.push({ tenancyId: tenancy.id, id: delivery.issueId });

    const listed = await listDeliveries.invoke(request(tenancy, { method: "GET", query: { limit: "1" } }));
    expect(listed.body.deliveries).toHaveLength(1);
    expect(listed.body.deliveries[0]).toMatchObject({ id: delivery.id, state: "dropped" });

    const detail = await getDelivery.invoke(request(tenancy, {
      method: "GET",
      params: { delivery_id: delivery.id },
    }));
    expect(detail.body).toMatchObject({
      delivery: {
        id: delivery.id,
        issue_id: delivery.issueId,
        canonical_issue_id: survivor.id,
        redirected: true,
        redirected_from_issue_id: delivery.issueId,
      },
    });

    const replayed = await replayDelivery.invoke(request(tenancy, {
      method: "POST",
      params: { delivery_id: delivery.id },
    }));
    expect(replayed.body).toMatchObject({ replayed: true, delivery: { state: "enqueued", replay_count: 1 } });
    const replayedDelivery = await globalPrismaClient.issueAlertDelivery.findUnique({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: delivery.id } },
      select: { workflowEventId: true },
    });
    if (replayedDelivery === null || replayedDelivery.workflowEventId === null) throw new Error("Replay did not persist a workflow event id");
    createdWorkflowEvents.push({ tenancyId: tenancy.id, id: replayedDelivery.workflowEventId });

    const repeated = await replayDelivery.invoke(request(tenancy, {
      method: "POST",
      params: { delivery_id: delivery.id },
    }));
    expect(repeated.body).toMatchObject({ replayed: false, delivery: { state: "enqueued", replay_count: 1 } });

    if (otherTenancy !== null) {
      await expect(getDelivery.invoke(request(otherTenancy, { method: "GET", params: { delivery_id: delivery.id } })))
        .rejects.toMatchObject({ name: "StatusError", statusCode: 404 });
    }
  });

  it("disables every version of a logical rule without deleting its history", async () => {
    const rule = makeRule(`${RUN_PREFIX}-disable`, 1);
    const first = await service.saveRule(scope(tenancy), rule);
    const second = await service.saveRule(scope(tenancy), { ...rule, version: 2 });
    createdRules.push({ tenancyId: tenancy.id, id: first.databaseId }, { tenancyId: tenancy.id, id: second.databaseId });

    const disabled = await disableRule.invoke(request(tenancy, {
      method: "POST",
      params: { rule_id: first.databaseId },
    }));
    expect(disabled.body).toMatchObject({ changed: true, rule: { database_id: first.databaseId, enabled: false } });

    const listed = await listRules.invoke(request(tenancy, { method: "GET", query: { limit: "100" } }));
    expect(listed.body.rules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rule.id }),
    ]));

    const repeated = await disableRule.invoke(request(tenancy, {
      method: "POST",
      params: { rule_id: first.databaseId },
    }));
    expect(repeated.body).toMatchObject({ changed: false, rule: { enabled: false } });
  });
});
