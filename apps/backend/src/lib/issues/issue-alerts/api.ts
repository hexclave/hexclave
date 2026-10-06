import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import {
  loadOwnerTeamMemberEmailsByUserId,
  matchOwnerTeamRecipients,
} from "./owner-team-recipients";
import { replayIssueAlertWorkflowDelivery } from "./workflow-status";
import {
  IssueAlertPersistenceInputError,
  issueAlertPersistenceService,
  parseStoredIssueAlertRule,
  type IssueAlertDeliverySnapshot,
  type IssueAlertRuleRecord,
} from "./persistence";
import type { IssueAlertRule, IssueAlertRuleScope } from "./types";
import { anyVersionUuidPattern as UUID_PATTERN } from "@hexclave/shared/dist/utils/uuids";

export type IssueAlertRuleJson = IssueAlertRule;

export const ISSUE_ALERT_API_DEFAULT_LIMIT = 50;
export const ISSUE_ALERT_API_MAX_LIMIT = 100;


export type IssueAlertRuleResponse = IssueAlertRuleJson & {
  database_id: string,
};

export type IssueAlertListPage<T> = {
  items: readonly T[],
  truncated: boolean,
};

export type IssueAlertDeliveryResponse = {
  id: string,
  rule_id: string,
  issue_id: string,
  canonical_issue_id: string,
  redirected: boolean,
  redirected_from_issue_id: string | null,
  occurrence_id: string,
  rule_version: number,
  event_kind: "new" | "regression" | "occurrence",
  deduplication_key: string,
  cooldown_key: string,
  cooldown_duration_seconds: number,
  cooldown_expires_at_millis: number | null,
  state: "claimed" | "suppressed" | "enqueued" | "delivered" | "failed" | "dropped",
  outcome: "none" | "cooldown_active" | "workflow_enqueued" | "workflow_delivered" | "workflow_failed" | "workflow_dropped" | "invalid_rule",
  workflow_event_id: string | null,
  attempt_count: number,
  replay_count: number,
  last_attempt_at_millis: number | null,
  next_retry_at_millis: number | null,
  last_error: string | null,
  claimed_at_millis: number,
  enqueued_at_millis: number | null,
  completed_at_millis: number | null,
  created_at_millis: number,
  updated_at_millis: number,
};

export type IssueAlertReplayResponse = {
  delivery: IssueAlertDeliveryResponse,
  replayed: boolean,
};

export type IssueAlertRuleMutationResponse = {
  rule: IssueAlertRuleResponse,
  changed: boolean,
};

type StoredRuleApiRow = {
  id: string,
  tenancyId: string,
  projectId: string,
  branchId: string,
  ruleKey: string,
  version: number,
  schemaVersion: number,
  enabled: boolean,
  config: unknown,
};

type IssueAlertDeliveryIssueResolution = {
  canonicalIssueId: string,
  redirectedFromIssueId: string | null,
};

export function parseIssueAlertRuleInput(value: unknown): IssueAlertRule {
  const parsed = parseStoredIssueAlertRule({
    id: randomUUID(),
    tenancyId: "00000000-0000-4000-8000-000000000000",
    projectId: "api-validation",
    branchId: "api-validation",
    ruleKey: isRecord(value) && typeof value.id === "string" ? value.id : "invalid",
    version: isRecord(value) && typeof value.version === "number" ? value.version : 0,
    schemaVersion: isRecord(value) && typeof value.schemaVersion === "number" ? value.schemaVersion : 0,
    enabled: isRecord(value) && typeof value.enabled === "boolean" ? value.enabled : false,
    config: value,
  });
  if (parsed === null) throw new StatusError(StatusError.BadRequest, "Invalid issue alert rule");
  return parsed;
}

function issueAlertScope(tenancy: Tenancy): IssueAlertRuleScope {
  return { tenancyId: tenancy.id, projectId: tenancy.project.id, branchId: tenancy.branchId };
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ISSUE_ALERT_API_MAX_LIMIT) {
    throw new StatusError(StatusError.BadRequest, `limit must be between 1 and ${ISSUE_ALERT_API_MAX_LIMIT}`);
  }
  return value;
}

export function parseIssueAlertListLimit(value: unknown): number {
  if (value === undefined) return ISSUE_ALERT_API_DEFAULT_LIMIT;
  if (typeof value === "number") return validateLimit(value);
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw new StatusError(StatusError.BadRequest, "limit must be a positive integer");
  }
  const parsed = Number(value);
  return validateLimit(parsed);
}

function validateDatabaseId(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) throw new StatusError(StatusError.BadRequest, `${field} must be a UUID`);
}

function storedRuleRecord(row: StoredRuleApiRow): IssueAlertRuleRecord {
  const rule = parseStoredIssueAlertRule(row);
  if (rule === null) throw new Error("Stored issue alert rule is malformed");
  return {
    databaseId: row.id,
    scope: { tenancyId: row.tenancyId, projectId: row.projectId, branchId: row.branchId },
    rule,
  };
}

async function loadIssueAlertRuleRow(tenancy: Tenancy, databaseId: string, useReplica: boolean): Promise<StoredRuleApiRow | null> {
  validateDatabaseId(databaseId, "rule_id");
  const prisma = await getPrismaClientForTenancy(tenancy);
  const query = {
    where: {
      tenancyId: tenancy.id,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      id: databaseId,
    },
    select: {
      id: true,
      tenancyId: true,
      projectId: true,
      branchId: true,
      ruleKey: true,
      version: true,
      schemaVersion: true,
      enabled: true,
      config: true,
    },
  };
  return useReplica
    ? await prisma.$replica().issueAlertRule.findFirst(query)
    : await prisma.issueAlertRule.findFirst(query);
}

export function toIssueAlertRuleResponse(record: IssueAlertRuleRecord): IssueAlertRuleResponse {
  return {
    ...record.rule,
    database_id: record.databaseId,
  };
}

export async function assertIssueAlertRecipients(tenancy: Tenancy, rule: IssueAlertRule): Promise<void> {
  if (rule.action.type !== "email") return;
  const prisma = await getPrismaClientForTenancy(tenancy);
  if (rule.action.userIds !== undefined) {
    const userIds = [...rule.action.userIds];
    const ownerTeamEmails = await loadOwnerTeamMemberEmailsByUserId(tenancy);
    if (ownerTeamEmails == null) {
      throw new StatusError(StatusError.BadRequest, "Issue alert recipients must be members of this project's team");
    }
    const ownerTeamMatch = matchOwnerTeamRecipients(userIds, ownerTeamEmails);
    if (ownerTeamMatch.status === "missing_email") {
      throw new StatusError(StatusError.BadRequest, "Issue alert recipients must have a primary email on this project's team");
    }
    if (ownerTeamMatch.status === "missing_member") {
      throw new StatusError(StatusError.BadRequest, "Issue alert recipients must be members of this project's team");
    }
    return;
  }

  if (rule.action.routing?.type === "team") {
    if (!UUID_PATTERN.test(rule.action.routing.teamId)) {
      throw new StatusError(StatusError.BadRequest, "Issue alert team recipients must use a valid team id");
    }
    const team = await prisma.team.findFirst({
      where: {
        tenancyId: tenancy.id,
        teamId: rule.action.routing.teamId,
        mirroredProjectId: tenancy.project.id,
        mirroredBranchId: tenancy.branchId,
      },
      select: { teamId: true },
    });
    if (team === null) {
      throw new StatusError(StatusError.BadRequest, "Issue alert team recipients must belong to the authenticated project");
    }
  }
}

export async function listIssueAlertRulesPage(tenancy: Tenancy, limit = ISSUE_ALERT_API_DEFAULT_LIMIT): Promise<IssueAlertListPage<IssueAlertRuleResponse>> {
  const boundedLimit = validateLimit(limit);
  const records = await issueAlertPersistenceService.listActiveRuleRecords(issueAlertScope(tenancy));
  return {
    items: records.slice(0, boundedLimit).map(toIssueAlertRuleResponse),
    truncated: records.length > boundedLimit,
  };
}

export async function getIssueAlertRule(tenancy: Tenancy, databaseId: string): Promise<IssueAlertRuleResponse | null> {
  const row = await loadIssueAlertRuleRow(tenancy, databaseId, true);
  return row === null ? null : toIssueAlertRuleResponse(storedRuleRecord(row));
}

async function resolveDeliveryIssue(tenancy: Tenancy, issueId: string): Promise<IssueAlertDeliveryIssueResolution> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const redirect = await prisma.$replica().issueRedirect.findUnique({
    where: { tenancyId_fromIssueId: { tenancyId: tenancy.id, fromIssueId: issueId } },
    select: { fromIssueId: true, toIssueId: true },
  });
  if (redirect !== null) {
    const survivor = await prisma.$replica().issue.findUnique({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: redirect.toIssueId } },
      select: { id: true },
    });
    if (survivor !== null) {
      return { canonicalIssueId: survivor.id, redirectedFromIssueId: redirect.fromIssueId };
    }
  }

  return { canonicalIssueId: issueId, redirectedFromIssueId: null };
}

function enumValue<T extends string>(value: string, allowed: readonly T[], field: string): T {
  const normalized = value.toLowerCase();
  const match = allowed.find((candidate) => candidate === normalized);
  if (match === undefined) throw new Error(`Stored issue alert delivery has an invalid ${field}`);
  return match;
}

function timestampMillis(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

export async function toIssueAlertDeliveryResponse(tenancy: Tenancy, delivery: IssueAlertDeliverySnapshot): Promise<IssueAlertDeliveryResponse> {
  const issue = await resolveDeliveryIssue(tenancy, delivery.issueId);
  return {
    id: delivery.id,
    rule_id: delivery.databaseRuleId,
    issue_id: delivery.issueId,
    canonical_issue_id: issue.canonicalIssueId,
    redirected: issue.redirectedFromIssueId !== null,
    redirected_from_issue_id: issue.redirectedFromIssueId,
    occurrence_id: delivery.occurrenceId,
    rule_version: delivery.ruleVersion,
    event_kind: enumValue(delivery.eventKind, ["new", "regression", "occurrence"], "event kind"),
    deduplication_key: delivery.deduplicationKey,
    cooldown_key: delivery.cooldownKey,
    cooldown_duration_seconds: delivery.cooldownDurationSeconds,
    cooldown_expires_at_millis: timestampMillis(delivery.cooldownExpiresAt),
    state: enumValue(delivery.state, ["claimed", "suppressed", "enqueued", "delivered", "failed", "dropped"], "state"),
    outcome: enumValue(delivery.outcome, ["none", "cooldown_active", "workflow_enqueued", "workflow_delivered", "workflow_failed", "workflow_dropped", "invalid_rule"], "outcome"),
    workflow_event_id: delivery.workflowEventId,
    attempt_count: delivery.attemptCount,
    replay_count: delivery.replayCount,
    last_attempt_at_millis: timestampMillis(delivery.lastAttemptAt),
    next_retry_at_millis: timestampMillis(delivery.nextRetryAt),
    last_error: delivery.lastError,
    claimed_at_millis: delivery.claimedAt.getTime(),
    enqueued_at_millis: timestampMillis(delivery.enqueuedAt),
    completed_at_millis: timestampMillis(delivery.completedAt),
    created_at_millis: delivery.createdAt.getTime(),
    updated_at_millis: delivery.updatedAt.getTime(),
  };
}

export async function listIssueAlertDeliveriesPage(tenancy: Tenancy, limit = ISSUE_ALERT_API_DEFAULT_LIMIT): Promise<IssueAlertListPage<IssueAlertDeliveryResponse>> {
  const boundedLimit = validateLimit(limit);
  const snapshots = await issueAlertPersistenceService.listDeliveries(issueAlertScope(tenancy), boundedLimit + 1);
  const items = await Promise.all(snapshots.slice(0, boundedLimit).map((delivery) => toIssueAlertDeliveryResponse(tenancy, delivery)));
  return { items, truncated: snapshots.length > boundedLimit };
}

export async function getIssueAlertDelivery(tenancy: Tenancy, deliveryId: string): Promise<IssueAlertDeliveryResponse | null> {
  validateDatabaseId(deliveryId, "delivery_id");
  const delivery = await issueAlertPersistenceService.inspectDelivery(issueAlertScope(tenancy), deliveryId);
  return delivery === null ? null : await toIssueAlertDeliveryResponse(tenancy, delivery);
}

export async function replayIssueAlertDelivery(tenancy: Tenancy, deliveryId: string, now = new Date()): Promise<IssueAlertReplayResponse | null> {
  validateDatabaseId(deliveryId, "delivery_id");
  const scope = issueAlertScope(tenancy);
  const replay = await replayIssueAlertWorkflowDelivery(scope, deliveryId, now);
  if (replay.status === "not_replayed" && replay.reason === "delivery_not_found") return null;

  const after = await issueAlertPersistenceService.inspectDelivery(scope, deliveryId, { consistency: "primary" });
  if (after === null) return null;
  return {
    delivery: await toIssueAlertDeliveryResponse(tenancy, after),
    replayed: replay.status === "replayed",
  };
}

export async function disableIssueAlertRule(tenancy: Tenancy, databaseId: string): Promise<IssueAlertRuleMutationResponse | null> {
  const targetRow = await loadIssueAlertRuleRow(tenancy, databaseId, false);
  if (targetRow === null) return null;
  const prisma = await getPrismaClientForTenancy(tenancy);
  const versions: StoredRuleApiRow[] = await prisma.issueAlertRule.findMany({
    where: {
      tenancyId: tenancy.id,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      ruleKey: targetRow.ruleKey,
    },
    select: {
      id: true,
      tenancyId: true,
      projectId: true,
      branchId: true,
      ruleKey: true,
      version: true,
      schemaVersion: true,
      enabled: true,
      config: true,
    },
  });
  const target = storedRuleRecord(targetRow);
  const changed = versions.some((version) => version.enabled);
  if (changed) {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "IssueAlertRule"
      SET "enabled" = false,
          "config" = jsonb_set("config", '{enabled}', 'false'::jsonb, true),
          "updatedAt" = NOW()
      WHERE "tenancyId" = ${tenancy.id}::uuid
        AND "projectId" = ${tenancy.project.id}
        AND "branchId" = ${tenancy.branchId}
        AND "ruleKey" = ${targetRow.ruleKey}
        AND "enabled" = true
    `);
  }
  return {
    rule: toIssueAlertRuleResponse({
      ...target,
      rule: { ...target.rule, enabled: false },
    }),
    changed,
  };
}

export async function saveIssueAlertRule(tenancy: Tenancy, value: unknown): Promise<IssueAlertRuleResponse> {
  const rule = parseIssueAlertRuleInput(value);
  await assertIssueAlertRecipients(tenancy, rule);
  try {
    const record = await issueAlertPersistenceService.saveRule({
      tenancyId: tenancy.id,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
    }, rule);
    return toIssueAlertRuleResponse(record);
  } catch (error) {
    if (error instanceof IssueAlertPersistenceInputError) {
      throw new StatusError(StatusError.BadRequest, "Invalid issue alert rule");
    }
    throw error;
  }
}
