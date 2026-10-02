import {
  IssueActivityType as PrismaIssueActivityType,
  IssueOwnerSource as PrismaIssueOwnerSource,
  IssueOwnerType as PrismaIssueOwnerType,
  IssuePriority as PrismaIssuePriority,
  IssueSubjectType as PrismaIssueSubjectType,
  Prisma,
} from "@/generated/prisma/client";
import type { Tenancy } from "@/lib/tenancies";
import { getBillingTeamId } from "@/lib/plan-entitlements";
import { isPrismaJsonObject } from "@/lib/prisma-json";
import { getPrismaClientForTenancy, isPrismaError, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { deepPlainEquals } from "@hexclave/shared/dist/utils/objects";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_BRANCH_ID } from "@/lib/branch-constants";
import type { IssuePriority } from "./issue-lifecycle";
import type { IssueActivitySubject } from "./issue-activity";
import { anyVersionUuidPattern as UUID_PATTERN } from "@hexclave/shared/dist/utils/uuids";

export const ISSUE_PRODUCT_MAX_PAGE_SIZE = 100;
export const ISSUE_PRODUCT_MAX_OWNER_CONTEXT_BYTES = 65_536;

const ISSUE_OWNER_SOURCES = ["manual", "ownership_rule", "codeowners", "suspect_commit", "seer_suggested"] as const;
export type IssueOwnerSource = (typeof ISSUE_OWNER_SOURCES)[number];
export type IssueOwnerType = "user" | "team";

export const ISSUE_PRODUCT_ERROR_CODES = {
  // The authenticated branch has no row for the referenced issue — callers use
  // this to map the failure onto a 404 rather than a 400.
  issueNotFoundInBranch: "issue_not_found_in_branch",
} as const;

export class IssueProductInputError extends Error {
  public readonly code: (typeof ISSUE_PRODUCT_ERROR_CODES)[keyof typeof ISSUE_PRODUCT_ERROR_CODES] | null;

  constructor(message: string, options?: { code?: (typeof ISSUE_PRODUCT_ERROR_CODES)[keyof typeof ISSUE_PRODUCT_ERROR_CODES] }) {
    super(message);
    this.name = "IssueProductInputError";
    this.code = options?.code ?? null;
  }
}

function issueNotFoundInBranchError(): IssueProductInputError {
  return new IssueProductInputError("Issue was not found in the authenticated branch", { code: ISSUE_PRODUCT_ERROR_CODES.issueNotFoundInBranch });
}

export type IssueProductScope = {
  tenancy: Tenancy,
  issueId: string,
};

export type IssuePriorityMutationResult = {
  tenancyId: string,
  issueId: string,
  previousPriority: IssuePriority | null,
  priority: IssuePriority | null,
  actorUserId: string | null,
  changedAt: Date,
  changed: boolean,
};

export type IssueTeamMutationResult = {
  tenancyId: string,
  issueId: string,
  previousTeamId: string | null,
  teamId: string | null,
  actorUserId: string | null,
  changedAt: Date,
  changed: boolean,
};

export type IssueOwnerInput = {
  type: IssueOwnerType,
  userId?: string,
  teamId?: string,
  source: IssueOwnerSource,
  context?: Prisma.InputJsonValue | null,
};

export type IssueOwnerRecord = {
  id: string,
  type: IssueOwnerType,
  userId: string | null,
  teamId: string | null,
  source: IssueOwnerSource,
  context: Prisma.JsonValue | null,
  createdAt: Date,
  updatedAt: Date,
};

export type IssueCommentRecord = {
  id: string,
  authorUserId: string,
  body: string,
  idempotencyKey: string,
  createdAt: Date,
  updatedAt: Date,
};

export type IssueActivityRecord = {
  id: string,
  actorUserId: string | null,
  type: string,
  idempotencyKey: string,
  data: Prisma.JsonValue,
  occurredAt: Date,
  createdAt: Date,
};

export type IssueSubjectRecord = {
  type: IssueOwnerType,
  id: string,
  isActive: boolean,
  reason: string | null,
  createdAt: Date,
  updatedAt: Date,
};

export type IssueBookmarkMutationResult = {
  userId: string,
  bookmarked: boolean,
  changed: boolean,
  changedAt: Date,
};

export type IssueProductSnapshot = {
  priority: IssuePriority | null,
  assigneeUserId: string | null,
  teamId: string | null,
  owners: readonly IssueOwnerRecord[],
  activities: readonly IssueActivityRecord[],
  comments: readonly IssueCommentRecord[],
  subscriptions: readonly IssueSubjectRecord[],
  bookmarkedUserIds: readonly string[],
};

function assertUuid(value: string, fieldName: string): void {
  if (!UUID_PATTERN.test(value)) throw new IssueProductInputError(`${fieldName} must be a UUID`);
}

function assertScope(scope: IssueProductScope): void {
  assertUuid(scope.issueId, "issueId");
}

function assertValidDate(value: Date, fieldName: string): Date {
  if (!Number.isFinite(value.getTime())) throw new IssueProductInputError(`${fieldName} must be a valid Date`);
  return new Date(value.getTime());
}

function actorId(value: string | null | undefined): string | null {
  if (value == null) return null;
  assertUuid(value, "actorUserId");
  return value;
}

function assertBoundedString(value: string, fieldName: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength) {
    throw new IssueProductInputError(`${fieldName} must contain 1-${maxLength} characters`);
  }
}

function assertJsonBounded(value: Prisma.InputJsonValue | null | undefined, fieldName: string): void {
  if (value === null || value === undefined) return;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > ISSUE_PRODUCT_MAX_OWNER_CONTEXT_BYTES) {
    throw new IssueProductInputError(`${fieldName} must be at most ${ISSUE_PRODUCT_MAX_OWNER_CONTEXT_BYTES} bytes of JSON`);
  }
}

function priorityToPrisma(priority: IssuePriority | null): PrismaIssuePriority | null {
  if (priority === null) return null;
  switch (priority) {
    case "low": { return PrismaIssuePriority.LOW; }
    case "medium": { return PrismaIssuePriority.MEDIUM; }
    case "high": { return PrismaIssuePriority.HIGH; }
  }
}

function priorityFromPrisma(priority: PrismaIssuePriority | null): IssuePriority | null {
  if (priority === null) return null;
  switch (priority) {
    case PrismaIssuePriority.LOW: { return "low"; }
    case PrismaIssuePriority.MEDIUM: { return "medium"; }
    case PrismaIssuePriority.HIGH: { return "high"; }
  }
}

function ownerSourceToPrisma(source: IssueOwnerSource): PrismaIssueOwnerSource {
  switch (source) {
    case "manual": { return PrismaIssueOwnerSource.MANUAL; }
    case "ownership_rule": { return PrismaIssueOwnerSource.OWNERSHIP_RULE; }
    case "codeowners": { return PrismaIssueOwnerSource.CODEOWNERS; }
    case "suspect_commit": { return PrismaIssueOwnerSource.SUSPECT_COMMIT; }
    case "seer_suggested": { return PrismaIssueOwnerSource.SEER_SUGGESTED; }
  }
}

function ownerSourceFromPrisma(source: PrismaIssueOwnerSource): IssueOwnerSource {
  switch (source) {
    case PrismaIssueOwnerSource.MANUAL: { return "manual"; }
    case PrismaIssueOwnerSource.OWNERSHIP_RULE: { return "ownership_rule"; }
    case PrismaIssueOwnerSource.CODEOWNERS: { return "codeowners"; }
    case PrismaIssueOwnerSource.SUSPECT_COMMIT: { return "suspect_commit"; }
    case PrismaIssueOwnerSource.SEER_SUGGESTED: { return "seer_suggested"; }
  }
}

function activityTypeToPrisma(type: string): PrismaIssueActivityType {
  switch (type) {
    case "comment": { return PrismaIssueActivityType.COMMENT; }
    case "status_changed": { return PrismaIssueActivityType.STATUS_CHANGED; }
    case "assignment_changed": { return PrismaIssueActivityType.ASSIGNMENT_CHANGED; }
    case "priority_changed": { return PrismaIssueActivityType.PRIORITY_CHANGED; }
    case "team_changed": { return PrismaIssueActivityType.TEAM_CHANGED; }
    case "owner_changed": { return PrismaIssueActivityType.OWNER_CHANGED; }
    case "subscription_changed": { return PrismaIssueActivityType.SUBSCRIPTION_CHANGED; }
    case "bookmark_changed": { return PrismaIssueActivityType.BOOKMARK_CHANGED; }
    case "regressed": { return PrismaIssueActivityType.REGRESSED; }
    default: { throw new IssueProductInputError(`Unsupported issue activity type: ${type}`); }
  }
}

function subjectTypeToPrisma(type: IssueOwnerType): PrismaIssueSubjectType {
  return type === "user" ? PrismaIssueSubjectType.USER : PrismaIssueSubjectType.TEAM;
}

function subjectTypeFromPrisma(type: PrismaIssueSubjectType): IssueOwnerType {
  return type === PrismaIssueSubjectType.USER ? "user" : "team";
}

function requireSubjectId(userId: string | null, teamId: string | null): string {
  const subjectId = userId ?? teamId;
  if (subjectId === null) throw new IssueProductInputError("Issue subscription has no subject id");
  return subjectId;
}

function activityKey(prefix: string, key: string): string {
  const digest = createHash("sha256").update(`${prefix}:${key}`).digest("hex");
  return `${prefix}:${digest}`;
}

function receiptDate(value: Prisma.JsonValue | undefined, fieldName: string): Date {
  if (typeof value !== "string") throw new IssueProductInputError(`Stored ${fieldName} receipt is invalid`);
  return assertValidDate(new Date(value), fieldName);
}

async function assertIssueExists(tx: PrismaClientTransaction, scope: IssueProductScope): Promise<void> {
  const issue = await tx.issue.findUnique({
    where: { tenancyId_id: { tenancyId: scope.tenancy.id, id: scope.issueId } },
    select: { id: true },
  });
  if (issue === null) throw issueNotFoundInBranchError();
}

async function assertProjectUser(
  tx: PrismaClientTransaction,
  tenancy: Tenancy,
  userId: string,
  fieldName: string,
  options: { allowInternalMirror?: boolean } = {},
): Promise<void> {
  assertUuid(userId, fieldName);
  const allowInternalMirror = options.allowInternalMirror ?? true;
  const rows = await tx.$queryRaw<{ projectUserId: string }[]>`
    SELECT "projectUserId"
    FROM "ProjectUser"
    WHERE "projectUserId" = ${userId}::uuid
      AND (
        "tenancyId" = ${tenancy.id}::uuid
        ${allowInternalMirror ? Prisma.sql`OR ("mirroredProjectId" = 'internal' AND "mirroredBranchId" = ${DEFAULT_BRANCH_ID})` : Prisma.empty}
      )
    ORDER BY CASE WHEN "tenancyId" = ${tenancy.id}::uuid THEN 0 ELSE 1 END
    LIMIT 1
    FOR KEY SHARE
  `;
  if (rows.length === 0) throw new IssueProductInputError(`${fieldName} is not a member of the authenticated branch`);
}

export async function assertIssueProjectUserInTransaction(
  tx: PrismaClientTransaction,
  tenancy: Tenancy,
  userId: string,
  fieldName: string,
  options: { allowInternalMirror?: boolean } = {},
): Promise<void> {
  await assertProjectUser(tx, tenancy, userId, fieldName, options);
}

async function retryOnceOnUniqueConstraintRace<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isPrismaError(error, "UNIQUE_CONSTRAINT_VIOLATION")) throw error;
    return await run();
  }
}

function projectOwnerTeamId(tenancy: Tenancy): string | null {
  return getBillingTeamId(tenancy.project);
}

function assertProjectOwnerTeam(tenancy: Tenancy, teamId: string, fieldName: string): void {
  assertUuid(teamId, fieldName);
  const ownerTeamId = projectOwnerTeamId(tenancy);
  if (ownerTeamId == null) {
    throw new IssueProductInputError(`${fieldName} cannot be set because this project has no owner team`);
  }
  if (ownerTeamId !== teamId) {
    throw new IssueProductInputError(`${fieldName} must be this project's owner team`);
  }
}

async function appendActivityInTransaction(options: {
  tx: PrismaClientTransaction,
  tenancy: Tenancy,
  issueId: string,
  actorUserId: string | null,
  type: string,
  idempotencyKey: string,
  data: Prisma.InputJsonValue,
  occurredAt: Date,
}): Promise<void> {
  assertBoundedString(options.idempotencyKey, "idempotencyKey", 128);
  assertJsonBounded(options.data, "activity data");
  const row = await options.tx.issueActivity.upsert({
    where: {
      tenancyId_projectId_branchId_issueId_idempotencyKey: {
        tenancyId: options.tenancy.id,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        issueId: options.issueId,
        idempotencyKey: options.idempotencyKey,
      },
    },
    create: {
      tenancyId: options.tenancy.id,
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      issueId: options.issueId,
      actorUserId: options.actorUserId,
      type: activityTypeToPrisma(options.type),
      idempotencyKey: options.idempotencyKey,
      data: options.data,
      occurredAt: options.occurredAt,
    },
    update: {},
  });
  if (row.type !== activityTypeToPrisma(options.type) || row.actorUserId !== options.actorUserId || !deepPlainEquals(row.data, options.data)) {
    throw new IssueProductInputError("idempotencyKey was already used for a different activity");
  }
}

export async function setIssuePriority(options: IssueProductScope & {
  priority: IssuePriority | null,
  actorUserId?: string | null,
  occurredAt?: Date,
}): Promise<IssuePriorityMutationResult> {
  assertScope(options);
  const actorUserId = actorId(options.actorUserId);
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  const actionId = randomUUID();
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    const rows = await tx.$queryRaw<Array<{ priority: PrismaIssuePriority | null }>>`
      SELECT "priority"
      FROM "Issue"
      WHERE "tenancyId" = ${options.tenancy.id}::uuid
        AND "id" = ${options.issueId}::uuid
      FOR UPDATE
    `;
    if (rows.length === 0) throw issueNotFoundInBranchError();
    const [current] = rows;
    const previousPriority = priorityFromPrisma(current.priority);
    const changed = previousPriority !== options.priority;
    if (!changed) return {
      tenancyId: options.tenancy.id, issueId: options.issueId, previousPriority, priority: options.priority,
      actorUserId, changedAt: occurredAt, changed,
    };
    await tx.issue.update({
      where: { tenancyId_id: { tenancyId: options.tenancy.id, id: options.issueId } },
      data: { priority: priorityToPrisma(options.priority), updatedAt: occurredAt },
    });
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId,
      type: "priority_changed", idempotencyKey: activityKey("priority", `${previousPriority ?? "none"}:${options.priority ?? "none"}:${occurredAt.toISOString()}:${actionId}`),
      data: { from: previousPriority, to: options.priority }, occurredAt,
    });
    return {
      tenancyId: options.tenancy.id, issueId: options.issueId, previousPriority, priority: options.priority,
      actorUserId, changedAt: occurredAt, changed,
    };
  });
}

export async function assignIssueToTeam(options: IssueProductScope & {
  teamId: string | null,
  actorUserId?: string | null,
  changedAt?: Date,
}): Promise<IssueTeamMutationResult> {
  assertScope(options);
  const actorUserId = actorId(options.actorUserId);
  const ownerTeamId = projectOwnerTeamId(options.tenancy);
  if (ownerTeamId == null) {
    throw new IssueProductInputError("This project has no owner team");
  }
  const teamId = options.teamId ?? ownerTeamId;
  assertProjectOwnerTeam(options.tenancy, teamId, "teamId");
  const changedAt = assertValidDate(options.changedAt ?? new Date(), "changedAt");
  const actionId = randomUUID();
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    const current = await tx.issue.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: options.tenancy.id, id: options.issueId } },
      select: { assignedTeamId: true },
    });
    const changed = current.assignedTeamId !== teamId;
    if (!changed) return {
      tenancyId: options.tenancy.id, issueId: options.issueId, previousTeamId: current.assignedTeamId,
      teamId, actorUserId, changedAt, changed,
    };
    await tx.issue.update({
      where: { tenancyId_id: { tenancyId: options.tenancy.id, id: options.issueId } },
      data: { assignedTeamId: teamId, updatedAt: changedAt },
    });
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId,
      type: "team_changed", idempotencyKey: activityKey("team", `${current.assignedTeamId ?? "none"}:${teamId}:${changedAt.toISOString()}:${actionId}`),
      data: { from: current.assignedTeamId, to: teamId }, occurredAt: changedAt,
    });
    return {
      tenancyId: options.tenancy.id, issueId: options.issueId, previousTeamId: current.assignedTeamId,
      teamId, actorUserId, changedAt, changed,
    };
  });
}

export async function setIssueOwner(options: IssueProductScope & {
  owner: IssueOwnerInput,
  actorUserId?: string | null,
  occurredAt?: Date,
}): Promise<IssueOwnerRecord> {
  assertScope(options);
  const actorUserId = actorId(options.actorUserId);
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  assertBoundedString(options.owner.source, "source", 32);
  if (!ISSUE_OWNER_SOURCES.includes(options.owner.source)) throw new IssueProductInputError("Unsupported owner source");
  assertJsonBounded(options.owner.context, "owner context");
  const ownerType = options.owner.type;
  const ownerUserId = options.owner.userId ?? null;
  const ownerTeamId = options.owner.teamId ?? null;
  switch (ownerType) {
    case "user": {
      if (ownerUserId === null || ownerTeamId !== null) throw new IssueProductInputError("A user owner requires only userId");
      break;
    }
    case "team": {
      if (ownerTeamId === null || ownerUserId !== null) throw new IssueProductInputError("A team owner requires only teamId");
      break;
    }
    default: {
      throw new IssueProductInputError("owner.type must be user or team");
    }
  }
  const actionId = randomUUID();
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryOnceOnUniqueConstraintRace(() => retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    if (ownerUserId !== null) await assertProjectUser(tx, options.tenancy, ownerUserId, "owner.userId", { allowInternalMirror: false });
    if (ownerTeamId !== null) assertProjectOwnerTeam(options.tenancy, ownerTeamId, "owner.teamId");
    const ownerWhere = {
      tenancyId: options.tenancy.id,
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      issueId: options.issueId,
      ownerType: ownerType === "user" ? PrismaIssueOwnerType.USER : PrismaIssueOwnerType.TEAM,
      ownerUserId,
      ownerTeamId,
      source: ownerSourceToPrisma(options.owner.source),
    };
    const existingOwner = await tx.issueOwner.findFirst({ where: ownerWhere });
    const owner = existingOwner === null
      ? await tx.issueOwner.create({ data: { ...ownerWhere, context: options.owner.context ?? Prisma.JsonNull } })
      : await tx.issueOwner.update({ where: { tenancyId_id: { tenancyId: options.tenancy.id, id: existingOwner.id } }, data: { context: options.owner.context ?? Prisma.JsonNull, updatedAt: occurredAt } });
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId,
      type: "owner_changed", idempotencyKey: activityKey("owner", `${owner.id}:${occurredAt.toISOString()}:${actionId}`),
      data: { owner_type: ownerType, owner_id: ownerUserId ?? ownerTeamId, source: options.owner.source }, occurredAt,
    });
    return {
      id: owner.id, type: owner.ownerType === PrismaIssueOwnerType.USER ? "user" : "team",
      userId: owner.ownerUserId, teamId: owner.ownerTeamId, source: ownerSourceFromPrisma(owner.source),
      context: owner.context, createdAt: owner.createdAt, updatedAt: owner.updatedAt,
    };
  }));
}

export async function clearManualIssueOwners(options: IssueProductScope & {
  actorUserId?: string | null,
  occurredAt?: Date,
}): Promise<{ deletedCount: number, updatedAt: Date }> {
  assertScope(options);
  const actorUserId = actorId(options.actorUserId);
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    const deleted = await tx.issueOwner.deleteMany({
      where: {
        tenancyId: options.tenancy.id,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        issueId: options.issueId,
        source: PrismaIssueOwnerSource.MANUAL,
      },
    });
    if (deleted.count > 0) {
      await appendActivityInTransaction({
        tx,
        tenancy: options.tenancy,
        issueId: options.issueId,
        actorUserId,
        type: "owner_changed",
        idempotencyKey: activityKey("owner", `clear:${occurredAt.toISOString()}:${randomUUID()}`),
        data: { owner_type: null, owner_id: null, source: "manual" },
        occurredAt,
      });
    }
    return { deletedCount: deleted.count, updatedAt: occurredAt };
  });
}

export async function addIssueComment(options: IssueProductScope & {
  body: string,
  actorUserId: string,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueCommentRecord> {
  assertScope(options);
  assertUuid(options.actorUserId, "actorUserId");
  assertBoundedString(options.idempotencyKey, "idempotencyKey", 128);
  if (options.body.trim().length === 0 || options.body.length > 10_000) throw new IssueProductInputError("body must contain 1-10000 characters");
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    await assertProjectUser(tx, options.tenancy, options.actorUserId, "actorUserId", { allowInternalMirror: false });
    const comment = await tx.issueComment.upsert({
      where: {
        tenancyId_projectId_branchId_issueId_idempotencyKey: {
          tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId,
          issueId: options.issueId, idempotencyKey: options.idempotencyKey,
        },
      },
      create: {
        tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId,
        issueId: options.issueId, authorUserId: options.actorUserId, body: options.body,
        idempotencyKey: options.idempotencyKey, createdAt: occurredAt, updatedAt: occurredAt,
      },
      update: {},
    });
    if (comment.body !== options.body || comment.authorUserId !== options.actorUserId) {
      throw new IssueProductInputError("idempotencyKey was already used for a different comment");
    }
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId: options.actorUserId,
      type: "comment", idempotencyKey: activityKey("comment", options.idempotencyKey),
      data: { comment_id: comment.id }, occurredAt,
    });
    return {
      id: comment.id, authorUserId: comment.authorUserId, body: comment.body,
      idempotencyKey: comment.idempotencyKey, createdAt: comment.createdAt, updatedAt: comment.updatedAt,
    };
  });
}

export async function setIssueSubscription(options: IssueProductScope & {
  subject: IssueActivitySubject,
  subscribed: boolean,
  actorUserId?: string | null,
  reason?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueSubjectRecord> {
  assertScope(options);
  const actorUserId = actorId(options.actorUserId);
  assertBoundedString(options.idempotencyKey, "idempotencyKey", 128);
  if (options.reason != null) assertBoundedString(options.reason, "reason", 64);
  assertUuid(options.subject.id, "subject.id");
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  const subjectType = subjectTypeToPrisma(options.subject.type);
  const subjectUserId = options.subject.type === "user" ? options.subject.id : null;
  const subjectTeamId = options.subject.type === "team" ? options.subject.id : null;
  const idempotencyKey = activityKey("subscription", options.idempotencyKey);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryOnceOnUniqueConstraintRace(() => retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    if (subjectUserId !== null) await assertProjectUser(tx, options.tenancy, subjectUserId, "subject.id", { allowInternalMirror: false });
    if (subjectTeamId !== null) assertProjectOwnerTeam(options.tenancy, subjectTeamId, "subject.id");
    const receipt = await tx.issueActivity.findUnique({
      where: { tenancyId_projectId_branchId_issueId_idempotencyKey: {
        tenancyId: options.tenancy.id, projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId, issueId: options.issueId, idempotencyKey,
      } },
    });
    if (receipt !== null) {
      if (receipt.type !== PrismaIssueActivityType.SUBSCRIPTION_CHANGED
        || receipt.actorUserId !== actorUserId || !isPrismaJsonObject(receipt.data)
        || receipt.data.subject_type !== options.subject.type || receipt.data.subject_id !== options.subject.id
        || receipt.data.subscribed !== options.subscribed || receipt.data.reason !== (options.reason ?? null)
        || typeof receipt.data.result_is_active !== "boolean"
        || (receipt.data.result_reason !== null && typeof receipt.data.result_reason !== "string")) {
        throw new IssueProductInputError("idempotencyKey was already used for a different subscription mutation");
      }
      return {
        type: options.subject.type,
        id: options.subject.id,
        isActive: receipt.data.result_is_active,
        reason: receipt.data.result_reason,
        createdAt: receiptDate(receipt.data.result_created_at, "subscription createdAt"),
        updatedAt: receiptDate(receipt.data.result_updated_at, "subscription updatedAt"),
      };
    }
    const subscriptionWhere = {
      tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId,
      issueId: options.issueId, subjectType, subjectUserId, subjectTeamId,
    };
    const existingSubscription = await tx.issueSubscription.findFirst({ where: subscriptionWhere });
    const subscription = existingSubscription === null
      ? await tx.issueSubscription.create({ data: { ...subscriptionWhere, isActive: options.subscribed, reason: options.reason, createdAt: occurredAt, updatedAt: occurredAt } })
      : existingSubscription.isActive === options.subscribed && existingSubscription.reason === (options.reason ?? null)
        ? existingSubscription
        : await tx.issueSubscription.update({ where: { tenancyId_id: { tenancyId: options.tenancy.id, id: existingSubscription.id } }, data: { isActive: options.subscribed, reason: options.reason, updatedAt: occurredAt } });
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId,
      type: "subscription_changed", idempotencyKey,
      data: {
        subject_type: options.subject.type,
        subject_id: options.subject.id,
        subscribed: options.subscribed,
        reason: options.reason ?? null,
        result_is_active: subscription.isActive,
        result_reason: subscription.reason,
        result_created_at: subscription.createdAt.toISOString(),
        result_updated_at: subscription.updatedAt.toISOString(),
      },
      occurredAt,
    });
    return {
      type: subjectTypeFromPrisma(subscription.subjectType),
      id: requireSubjectId(subscription.subjectUserId, subscription.subjectTeamId),
      isActive: subscription.isActive, reason: subscription.reason,
      createdAt: subscription.createdAt, updatedAt: subscription.updatedAt,
    };
  }));
}

export async function setIssueBookmark(options: IssueProductScope & {
  userId: string,
  bookmarked: boolean,
  actorUserId?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueBookmarkMutationResult> {
  assertScope(options);
  assertUuid(options.userId, "userId");
  const actorUserId = actorId(options.actorUserId);
  assertBoundedString(options.idempotencyKey, "idempotencyKey", 128);
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  const idempotencyKey = activityKey("bookmark", options.idempotencyKey);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryOnceOnUniqueConstraintRace(() => retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    await assertProjectUser(tx, options.tenancy, options.userId, "userId", { allowInternalMirror: false });
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    const receipt = await tx.issueActivity.findUnique({
      where: { tenancyId_projectId_branchId_issueId_idempotencyKey: {
        tenancyId: options.tenancy.id, projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId, issueId: options.issueId, idempotencyKey,
      } },
    });
    if (receipt !== null) {
      if (receipt.type !== PrismaIssueActivityType.BOOKMARK_CHANGED
        || receipt.actorUserId !== actorUserId || !isPrismaJsonObject(receipt.data)
        || receipt.data.user_id !== options.userId || receipt.data.bookmarked !== options.bookmarked
        || typeof receipt.data.result_changed !== "boolean") {
        throw new IssueProductInputError("idempotencyKey was already used for a different bookmark mutation");
      }
      return {
        userId: options.userId,
        bookmarked: options.bookmarked,
        changed: receipt.data.result_changed,
        changedAt: receiptDate(receipt.data.result_changed_at, "bookmark changedAt"),
      };
    }
    let changed: boolean;
    if (options.bookmarked) {
      const created = await tx.issueBookmark.createMany({
        data: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId, userId: options.userId, createdAt: occurredAt },
        skipDuplicates: true,
      });
      changed = created.count > 0;
    } else {
      const deleted = await tx.issueBookmark.deleteMany({
        where: { tenancyId: options.tenancy.id, issueId: options.issueId, userId: options.userId },
      });
      changed = deleted.count > 0;
    }
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId,
      type: "bookmark_changed", idempotencyKey,
      data: {
        user_id: options.userId,
        bookmarked: options.bookmarked,
        result_changed: changed,
        result_changed_at: occurredAt.toISOString(),
      },
      occurredAt,
    });
    return { userId: options.userId, bookmarked: options.bookmarked, changed, changedAt: occurredAt };
  }));
}

export async function appendIssueActivity(options: IssueProductScope & {
  actorUserId?: string | null,
  type: string,
  data: Prisma.InputJsonValue,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueActivityRecord> {
  assertScope(options);
  const actorUserId = actorId(options.actorUserId);
  const occurredAt = assertValidDate(options.occurredAt ?? new Date(), "occurredAt");
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  return await retryTransaction(prisma, async (tx) => {
    await assertIssueExists(tx, options);
    if (actorUserId !== null) await assertProjectUser(tx, options.tenancy, actorUserId, "actorUserId");
    await appendActivityInTransaction({
      tx, tenancy: options.tenancy, issueId: options.issueId, actorUserId,
      type: options.type, idempotencyKey: options.idempotencyKey, data: options.data, occurredAt,
    });
    const row = await tx.issueActivity.findUniqueOrThrow({
      where: {
        tenancyId_projectId_branchId_issueId_idempotencyKey: {
          tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId,
          issueId: options.issueId, idempotencyKey: options.idempotencyKey,
        },
      },
    });
    return { id: row.id, actorUserId: row.actorUserId, type: row.type.toLowerCase(), idempotencyKey: row.idempotencyKey, data: row.data, occurredAt: row.occurredAt, createdAt: row.createdAt };
  });
}

export async function listIssueActivity(options: IssueProductScope & { limit?: number }): Promise<readonly IssueActivityRecord[]> {
  assertScope(options);
  const limit = Math.min(Math.max(options.limit ?? ISSUE_PRODUCT_MAX_PAGE_SIZE, 1), ISSUE_PRODUCT_MAX_PAGE_SIZE);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const issue = await prisma.$replica().issue.findUnique({
    where: { tenancyId_id: { tenancyId: options.tenancy.id, id: options.issueId } },
    select: { id: true },
  });
  if (issue === null) throw issueNotFoundInBranchError();
  const rows = await prisma.$replica().issueActivity.findMany({
    where: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit,
  });
  return rows.map((row) => ({ id: row.id, actorUserId: row.actorUserId, type: row.type.toLowerCase(), idempotencyKey: row.idempotencyKey, data: row.data, occurredAt: row.occurredAt, createdAt: row.createdAt }));
}

export async function loadIssueProductSnapshot(options: IssueProductScope & { limit?: number }): Promise<IssueProductSnapshot> {
  assertScope(options);
  const limit = Math.min(Math.max(options.limit ?? ISSUE_PRODUCT_MAX_PAGE_SIZE, 1), ISSUE_PRODUCT_MAX_PAGE_SIZE);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const issue = await prisma.$replica().issue.findUnique({
    where: { tenancyId_id: { tenancyId: options.tenancy.id, id: options.issueId } },
    select: { priority: true, assigneeUserId: true, assignedTeamId: true },
  });
  if (issue === null) throw issueNotFoundInBranchError();
  const [owners, activities, comments, subscriptions, bookmarks] = await Promise.all([
    prisma.$replica().issueOwner.findMany({ where: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId }, orderBy: { updatedAt: "desc" }, take: limit }),
    prisma.$replica().issueActivity.findMany({ where: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit }),
    prisma.$replica().issueComment.findMany({ where: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
    prisma.$replica().issueSubscription.findMany({ where: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId }, orderBy: { updatedAt: "desc" }, take: limit }),
    prisma.$replica().issueBookmark.findMany({ where: { tenancyId: options.tenancy.id, projectId: options.tenancy.project.id, branchId: options.tenancy.branchId, issueId: options.issueId }, select: { userId: true }, take: limit }),
  ]);
  return {
    priority: priorityFromPrisma(issue.priority), assigneeUserId: issue.assigneeUserId, teamId: projectOwnerTeamId(options.tenancy) ?? issue.assignedTeamId,
    owners: owners.map((row) => ({ id: row.id, type: row.ownerType === PrismaIssueOwnerType.USER ? "user" : "team", userId: row.ownerUserId, teamId: row.ownerTeamId, source: ownerSourceFromPrisma(row.source), context: row.context, createdAt: row.createdAt, updatedAt: row.updatedAt })),
    activities: activities.map((row) => ({ id: row.id, actorUserId: row.actorUserId, type: row.type.toLowerCase(), idempotencyKey: row.idempotencyKey, data: row.data, occurredAt: row.occurredAt, createdAt: row.createdAt })),
    comments: comments.map((row) => ({ id: row.id, authorUserId: row.authorUserId, body: row.body, idempotencyKey: row.idempotencyKey, createdAt: row.createdAt, updatedAt: row.updatedAt })),
    subscriptions: subscriptions.map((row) => ({ type: subjectTypeFromPrisma(row.subjectType), id: requireSubjectId(row.subjectUserId, row.subjectTeamId), isActive: row.isActive, reason: row.reason, createdAt: row.createdAt, updatedAt: row.updatedAt })),
    bookmarkedUserIds: bookmarks.map((row) => row.userId),
  };
}

export async function appendIssueActivityInTransaction(options: {
  tx: PrismaClientTransaction,
  tenancy: Tenancy,
  issueId: string,
  actorUserId: string | null,
  type: string,
  idempotencyKey: string,
  data: Prisma.InputJsonValue,
  occurredAt: Date,
}): Promise<void> {
  await appendActivityInTransaction(options);
}
