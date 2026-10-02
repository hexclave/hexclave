import { IssueStatus as PrismaIssueStatus } from "@/generated/prisma/enums";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { randomUUID } from "node:crypto";
import { appendIssueActivityInTransaction, assertIssueProjectUserInTransaction, assignIssueToTeam as persistIssueTeamAssignment, setIssuePriority as persistIssuePriority } from "./issue-product";
import { emitIssueLifecycleWebhook } from "./issue-webhooks";
import { anyVersionUuidPattern as UUID_PATTERN } from "@hexclave/shared/dist/utils/uuids";

export const ISSUE_LIFECYCLE_STATUSES = ["unresolved", "resolved", "ignored"] as const;
export type IssueLifecycleStatus = (typeof ISSUE_LIFECYCLE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["low", "medium", "high"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export type IssueScope = {
  tenancy: Tenancy,
  issueId: string,
};

export type IssueLifecycleState = {
  status: IssueLifecycleStatus,
  statusChangedAt: Date | null,
  resolvedAt: Date | null,
  ignoredUntil: Date | null,
  regressedAt: Date | null,
  assigneeUserId: string | null,
};

export type IssueStatusMutation = {
  status: IssueLifecycleStatus,
  ignoredUntil?: Date | null,
};

export type IssueLifecycleTransitionKind =
  | "status_changed"
  | "status_unchanged"
  | "regressed"
  | "reopened"
  | "occurrence_unchanged";

export type IssueLifecycleTransition = {
  tenancyId: string,
  issueId: string,
  kind: IssueLifecycleTransitionKind,
  at: Date,
  previous: IssueLifecycleState,
  current: IssueLifecycleState,
};

export type IssueAssignmentResult = {
  tenancyId: string,
  issueId: string,
  previousAssigneeUserId: string | null,
  assigneeUserId: string | null,
  actorUserId: string | null,
  changedAt: Date,
  changed: boolean,
};

export class IssueLifecycleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueLifecycleInputError";
  }
}

export class IssueNotFoundError extends Error {
  readonly tenancyId: string;
  readonly issueId: string;

  constructor(scope: IssueScope) {
    super(`Issue ${scope.issueId} was not found in tenancy ${scope.tenancy.id}`);
    this.name = "IssueNotFoundError";
    this.tenancyId = scope.tenancy.id;
    this.issueId = scope.issueId;
  }
}

export class IssueLifecycleInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueLifecycleInvariantError";
  }
}


function assertUuid(value: string, fieldName: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new IssueLifecycleInputError(`${fieldName} must be a UUID`);
  }
}

function assertDate(value: Date, fieldName: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new IssueLifecycleInputError(`${fieldName} must be a valid Date`);
  }
}

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function copyState(value: IssueLifecycleState): IssueLifecycleState {
  return {
    status: value.status,
    statusChangedAt: copyDate(value.statusChangedAt),
    resolvedAt: copyDate(value.resolvedAt),
    ignoredUntil: copyDate(value.ignoredUntil),
    regressedAt: copyDate(value.regressedAt),
    assigneeUserId: value.assigneeUserId,
  };
}

function isSameDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function statusToPrisma(status: IssueLifecycleStatus): PrismaIssueStatus {
  switch (status) {
    case "unresolved": {
      return PrismaIssueStatus.UNRESOLVED;
    }
    case "resolved": {
      return PrismaIssueStatus.RESOLVED;
    }
    case "ignored": {
      return PrismaIssueStatus.IGNORED;
    }
  }
}

function statusFromDatabase(status: string): IssueLifecycleStatus {
  switch (status) {
    case PrismaIssueStatus.UNRESOLVED: {
      return "unresolved";
    }
    case PrismaIssueStatus.RESOLVED: {
      return "resolved";
    }
    case PrismaIssueStatus.IGNORED: {
      return "ignored";
    }
    default: {
      throw new IssueLifecycleInvariantError(`Unknown IssueStatus value from PostgreSQL: ${status}`);
    }
  }
}

export function parseIssueLifecycleStatus(value: unknown): IssueLifecycleStatus {
  if (typeof value !== "string") {
    throw new IssueLifecycleInputError("status must be unresolved, resolved, or ignored");
  }
  for (const status of ISSUE_LIFECYCLE_STATUSES) {
    if (value === status) return status;
  }
  throw new IssueLifecycleInputError("status must be unresolved, resolved, or ignored");
}

export function parseIssuePriority(value: unknown): IssuePriority {
  if (typeof value !== "string") {
    throw new IssueLifecycleInputError("priority must be low, medium, or high");
  }
  for (const priority of ISSUE_PRIORITIES) {
    if (value === priority) return priority;
  }
  throw new IssueLifecycleInputError("priority must be low, medium, or high");
}

export function validateIssueScope(scope: IssueScope): void {
  assertUuid(scope.issueId, "issueId");
}

function validateActorUserId(actorUserId: string | null | undefined): string | null {
  if (actorUserId == null) return null;
  assertUuid(actorUserId, "actorUserId");
  return actorUserId;
}

export function validateIssueUserId(userId: string, fieldName = "userId"): void {
  assertUuid(userId, fieldName);
}

function resolveAt(at: Date | undefined, fieldName: string): Date {
  const resolved = at ?? new Date();
  assertDate(resolved, fieldName);
  return new Date(resolved.getTime());
}

export function deriveIssueStatusTransition(options: {
  current: IssueLifecycleState,
  mutation: IssueStatusMutation,
  at: Date,
}): IssueLifecycleTransition["current"] & { kind: "status_changed" | "status_unchanged" } {
  const { current, mutation } = options;
  assertDate(options.at, "at");
  const ignoredUntil = mutation.status === "ignored" ? mutation.ignoredUntil ?? null : null;
  if (ignoredUntil !== null) assertDate(ignoredUntil, "ignoredUntil");

  const changed = current.status !== mutation.status || !isSameDate(current.ignoredUntil, ignoredUntil);
  if (!changed) {
    return { ...copyState(current), kind: "status_unchanged" };
  }

  return {
    ...copyState(current),
    status: mutation.status,
    statusChangedAt: new Date(options.at.getTime()),
    resolvedAt: mutation.status === "resolved" ? new Date(options.at.getTime()) : copyDate(current.resolvedAt),
    ignoredUntil,
    regressedAt: mutation.status === "resolved" ? null : copyDate(current.regressedAt),
    kind: "status_changed",
  };
}

export function deriveIssueOccurrenceTransition(options: {
  current: IssueLifecycleState,
  receivedAt: Date,
}): IssueLifecycleTransition["current"] & { kind: "regressed" | "reopened" | "occurrence_unchanged" } {
  const { current, receivedAt } = options;
  assertDate(receivedAt, "receivedAt");

  if (
    current.status === "resolved"
    && (current.resolvedAt === null || receivedAt.getTime() > current.resolvedAt.getTime())
  ) {
    return {
      ...copyState(current),
      status: "unresolved",
      statusChangedAt: new Date(receivedAt.getTime()),
      ignoredUntil: null,
      regressedAt: new Date(receivedAt.getTime()),
      kind: "regressed",
    };
  }

  if (
    current.status === "ignored"
    && current.ignoredUntil !== null
    && receivedAt.getTime() > current.ignoredUntil.getTime()
  ) {
    return {
      ...copyState(current),
      status: "unresolved",
      statusChangedAt: new Date(receivedAt.getTime()),
      ignoredUntil: null,
      kind: "reopened",
    };
  }

  return { ...copyState(current), kind: "occurrence_unchanged" };
}

type IssueLifecycleRow = {
  id: string,
  tenancyId: string,
  status: string,
  statusChangedAt: Date | null,
  resolvedAt: Date | null,
  ignoredUntil: Date | null,
  regressedAt: Date | null,
  assigneeUserId: string | null,
};

function rowToState(row: IssueLifecycleRow): IssueLifecycleState {
  return {
    status: statusFromDatabase(row.status),
    statusChangedAt: row.statusChangedAt,
    resolvedAt: row.resolvedAt,
    ignoredUntil: row.ignoredUntil,
    regressedAt: row.regressedAt,
    assigneeUserId: row.assigneeUserId,
  };
}

async function readIssueForUpdate(
  tx: PrismaClientTransaction,
  scope: IssueScope,
): Promise<IssueLifecycleState | null> {
  const rows = await tx.$queryRaw<IssueLifecycleRow[]>`
    SELECT "id", "tenancyId", "status"::text AS "status", "statusChangedAt",
           "resolvedAt", "ignoredUntil", "regressedAt", "assigneeUserId"
    FROM "Issue"
    WHERE "tenancyId" = ${scope.tenancy.id}::uuid AND "id" = ${scope.issueId}::uuid
    FOR UPDATE
  `;
  const row = rows.at(0);
  return row === undefined ? null : rowToState(row);
}

async function withLockedIssue<T>(
  scope: IssueScope,
  callback: (tx: PrismaClientTransaction, current: IssueLifecycleState) => Promise<T>,
): Promise<T> {
  validateIssueScope(scope);
  const prisma = await getPrismaClientForTenancy(scope.tenancy);
  return await retryTransaction(prisma, async (tx) => {
    const current = await readIssueForUpdate(tx, scope);
    if (current === null) throw new IssueNotFoundError(scope);
    return await callback(tx, current);
  });
}

export async function assignIssue(options: IssueScope & {
  assigneeUserId: string | null,
  actorUserId?: string | null,
  changedAt?: Date,
}): Promise<IssueAssignmentResult> {
  const actorUserId = validateActorUserId(options.actorUserId);
  if (options.assigneeUserId !== null) assertUuid(options.assigneeUserId, "assigneeUserId");
  const changedAt = resolveAt(options.changedAt, "changedAt");
  const actionId = randomUUID();
  const scope: IssueScope = { tenancy: options.tenancy, issueId: options.issueId };

  return await withLockedIssue(scope, async (tx, current) => {
    if (options.assigneeUserId !== null) {
      await assertIssueProjectUserInTransaction(tx, scope.tenancy, options.assigneeUserId, "assigneeUserId", { allowInternalMirror: false });
    }
    if (actorUserId !== null) {
      await assertIssueProjectUserInTransaction(tx, scope.tenancy, actorUserId, "actorUserId");
    }
    const changed = current.assigneeUserId !== options.assigneeUserId;
    if (changed) {
      await tx.issue.update({
        where: { tenancyId_id: { tenancyId: scope.tenancy.id, id: scope.issueId } },
        data: { assigneeUserId: options.assigneeUserId, updatedAt: changedAt },
      });
      await appendIssueActivityInTransaction({
        tx,
        tenancy: scope.tenancy,
        issueId: scope.issueId,
        actorUserId,
        type: "assignment_changed",
        idempotencyKey: `assignment:${actionId}`,
        data: { previous_assignee_user_id: current.assigneeUserId, assignee_user_id: options.assigneeUserId },
        occurredAt: changedAt,
      });
    }
    return {
      tenancyId: scope.tenancy.id,
      issueId: scope.issueId,
      previousAssigneeUserId: current.assigneeUserId,
      assigneeUserId: options.assigneeUserId,
      actorUserId,
      changedAt,
      changed,
    };
  });
}

export async function assignIssueToTeam(options: IssueScope & {
  teamId: string | null,
  actorUserId?: string | null,
  changedAt?: Date,
}): Promise<{
  tenancyId: string,
  issueId: string,
  previousTeamId: string | null,
  teamId: string | null,
  actorUserId: string | null,
  changedAt: Date,
  changed: boolean,
}> {
  return await persistIssueTeamAssignment(options);
}

export async function transitionIssueStatus(options: IssueScope & {
  mutation: IssueStatusMutation,
  changedAt?: Date,
  onlyIfCurrentStatus?: readonly IssueLifecycleStatus[],
}): Promise<IssueLifecycleTransition> {
  const changedAt = resolveAt(options.changedAt, "changedAt");
  const actionId = randomUUID();
  if (options.mutation.status === "ignored" && options.mutation.ignoredUntil !== undefined && options.mutation.ignoredUntil !== null) {
    assertDate(options.mutation.ignoredUntil, "ignoredUntil");
  }
  const scope: IssueScope = { tenancy: options.tenancy, issueId: options.issueId };

  const transition = await withLockedIssue(scope, async (tx, current) => {
    if (options.onlyIfCurrentStatus !== undefined && !options.onlyIfCurrentStatus.includes(current.status)) {
      return {
        tenancyId: scope.tenancy.id,
        issueId: scope.issueId,
        kind: "status_unchanged" as const,
        at: changedAt,
        previous: copyState(current),
        current: copyState(current),
      };
    }
    const derived = deriveIssueStatusTransition({ current, mutation: options.mutation, at: changedAt });
    const transition: IssueLifecycleTransition = {
      tenancyId: scope.tenancy.id,
      issueId: scope.issueId,
      kind: derived.kind,
      at: changedAt,
      previous: copyState(current),
      current: copyState(derived),
    };
    if (derived.kind === "status_unchanged") return transition;

    await tx.issue.update({
      where: { tenancyId_id: { tenancyId: scope.tenancy.id, id: scope.issueId } },
      data: {
        status: statusToPrisma(derived.status),
        statusChangedAt: derived.statusChangedAt,
        resolvedAt: derived.resolvedAt,
        ignoredUntil: derived.ignoredUntil,
        regressedAt: derived.regressedAt,
        updatedAt: changedAt,
      },
    });
    await appendIssueActivityInTransaction({
      tx,
      tenancy: scope.tenancy,
      issueId: scope.issueId,
      actorUserId: null,
      type: "status_changed",
      idempotencyKey: `status:${transition.previous.status}:${transition.current.status}:${changedAt.toISOString()}:${actionId}`,
      data: {
        from: transition.previous.status,
        to: transition.current.status,
        ignored_until: transition.current.ignoredUntil?.toISOString() ?? null,
      },
      occurredAt: changedAt,
    });
    return transition;
  });

  if (transition.kind === "status_changed" && (transition.current.status === "resolved" || transition.current.status === "ignored")) {
    runAsynchronouslyAndWaitUntil(emitIssueLifecycleWebhook({
      tenancy: options.tenancy,
      issueId: options.issueId,
      event: transition.current.status,
      now: changedAt,
      eventId: `${options.issueId}.${transition.current.status}.${changedAt.getTime()}`,
    }));
  }
  return transition;
}

export async function applyIssueOccurrenceLifecycle(options: IssueScope & {
  receivedAt: Date,
}): Promise<IssueLifecycleTransition> {
  const receivedAt = resolveAt(options.receivedAt, "receivedAt");
  const actionId = randomUUID();
  const scope: IssueScope = { tenancy: options.tenancy, issueId: options.issueId };

  return await withLockedIssue(scope, async (tx, current) => {
    const derived = deriveIssueOccurrenceTransition({ current, receivedAt });
    const transition: IssueLifecycleTransition = {
      tenancyId: scope.tenancy.id,
      issueId: scope.issueId,
      kind: derived.kind,
      at: receivedAt,
      previous: copyState(current),
      current: copyState(derived),
    };
    if (derived.kind === "occurrence_unchanged") return transition;

    await tx.issue.update({
      where: { tenancyId_id: { tenancyId: scope.tenancy.id, id: scope.issueId } },
      data: {
        status: statusToPrisma(derived.status),
        statusChangedAt: derived.statusChangedAt,
        ignoredUntil: derived.ignoredUntil,
        regressedAt: derived.regressedAt,
        updatedAt: receivedAt,
      },
    });
    await appendIssueActivityInTransaction({
      tx,
      tenancy: scope.tenancy,
      issueId: scope.issueId,
      actorUserId: null,
      type: "regressed",
      idempotencyKey: `regressed:${transition.kind}:${receivedAt.toISOString()}:${actionId}`,
      data: { kind: transition.kind, received_at: receivedAt.toISOString() },
      occurredAt: receivedAt,
    });
    return transition;
  });
}

export async function setIssuePriority(options: IssueScope & {
  priority: IssuePriority | null,
  actorUserId?: string | null,
  occurredAt?: Date,
}): Promise<{
  tenancyId: string,
  issueId: string,
  previousPriority: IssuePriority | null,
  priority: IssuePriority | null,
  actorUserId: string | null,
  changedAt: Date,
  changed: boolean,
}> {
  validateIssueScope(options);
  if (options.priority !== null) parseIssuePriority(options.priority);
  validateActorUserId(options.actorUserId);
  resolveAt(options.occurredAt, "occurredAt");
  return await persistIssuePriority(options);
}
