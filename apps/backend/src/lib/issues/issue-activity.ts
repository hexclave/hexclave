import type {
  IssueLifecycleStatus,
  IssuePriority,
  IssueScope,
} from "./issue-lifecycle";
import {
  IssueLifecycleInputError,
  validateIssueScope,
  validateIssueUserId,
} from "./issue-lifecycle";
import {
  addIssueComment as persistIssueComment,
  appendIssueActivity as persistIssueActivity,
  setIssueBookmark as persistIssueBookmark,
  setIssueSubscription as persistIssueSubscription,
} from "./issue-product";
import type { IssueActivityRecord, IssueBookmarkMutationResult, IssueCommentRecord, IssueSubjectRecord } from "./issue-product";

export const ISSUE_ACTIVITY_TYPES = [
  "comment",
  "status_changed",
  "assignment_changed",
  "priority_changed",
  "subscription_changed",
  "bookmark_changed",
  "regressed",
] as const;
export type IssueActivityType = (typeof ISSUE_ACTIVITY_TYPES)[number];

export type IssueActivitySubject = {
  type: "user" | "team",
  id: string,
};

type IssueActivityInputBase = {
  actorUserId?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
};

export type IssueActivityInput = IssueActivityInputBase & (
  | { type: "comment", data: { body: string } }
  | { type: "status_changed", data: { from: IssueLifecycleStatus, to: IssueLifecycleStatus, ignoredUntil: string | null } }
  | { type: "assignment_changed", data: { previousAssigneeUserId: string | null, assigneeUserId: string | null } }
  | { type: "priority_changed", data: { from: IssuePriority | null, to: IssuePriority | null } }
  | { type: "subscription_changed", data: { subject: IssueActivitySubject, subscribed: boolean } }
  | { type: "bookmark_changed", data: { userId: string, bookmarked: boolean } }
  | { type: "regressed", data: { receivedAt: string } }
);

export type IssueActivityCommand = IssueScopeForPersistence & IssueActivityInput & {
  occurredAt: Date,
  actorUserId: string | null,
};

export type IssueScopeForPersistence = {
  tenancyId: string,
  issueId: string,
};

export type IssueCommentCommand = IssueScopeForPersistence & {
  operation: "comment",
  body: string,
  actorUserId: string,
  idempotencyKey: string,
  occurredAt: Date,
};

export type IssueSubscriptionCommand = IssueScopeForPersistence & {
  operation: "subscription",
  subject: IssueActivitySubject,
  subscribed: boolean,
  actorUserId: string | null,
  reason: string | null,
  idempotencyKey: string,
  occurredAt: Date,
};

export type IssueBookmarkCommand = IssueScopeForPersistence & {
  operation: "bookmark",
  userId: string,
  bookmarked: boolean,
  actorUserId: string | null,
  idempotencyKey: string,
  occurredAt: Date,
};

export const ISSUE_COMMENT_MAX_LENGTH = 10_000;
export const ISSUE_ACTIVITY_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function resolveOccurredAt(value: Date | undefined): Date {
  const occurredAt = value ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new IssueLifecycleInputError("occurredAt must be a valid Date");
  }
  return new Date(occurredAt.getTime());
}

function resolveActorUserId(value: string | null | undefined): string | null {
  if (value == null) return null;
  validateIssueUserId(value, "actorUserId");
  return value;
}

function validateIdempotencyKey(value: string): string {
  if (value.length === 0 || value.length > ISSUE_ACTIVITY_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new IssueLifecycleInputError(`idempotencyKey must contain 1-${ISSUE_ACTIVITY_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  return value;
}

function validateCommentBody(value: string): string {
  if (value.trim().length === 0) {
    throw new IssueLifecycleInputError("comment body must not be empty");
  }
  if (value.length > ISSUE_COMMENT_MAX_LENGTH) {
    throw new IssueLifecycleInputError(`comment body must be at most ${ISSUE_COMMENT_MAX_LENGTH} characters`);
  }
  return value;
}

function validateSubject(subject: IssueActivitySubject): IssueActivitySubject {
  validateIssueUserId(subject.id, subject.type === "user" ? "subject.userId" : "subject.teamId");
  return subject;
}

function validateActivityInput(input: IssueActivityInput): void {
  validateIdempotencyKey(input.idempotencyKey);
  if (input.type === "comment") validateCommentBody(input.data.body);
  if (input.type === "assignment_changed") {
    if (input.data.previousAssigneeUserId !== null) validateIssueUserId(input.data.previousAssigneeUserId, "previousAssigneeUserId");
    if (input.data.assigneeUserId !== null) validateIssueUserId(input.data.assigneeUserId, "assigneeUserId");
  }
  if (input.type === "subscription_changed") validateSubject(input.data.subject);
  if (input.type === "bookmark_changed") validateIssueUserId(input.data.userId, "userId");
}

export function buildIssueActivity(options: IssueScope & IssueActivityInput): IssueActivityCommand {
  validateIssueScope(options);
  validateActivityInput(options);
  const occurredAt = resolveOccurredAt(options.occurredAt);
  return {
    ...options,
    tenancyId: options.tenancy.id,
    issueId: options.issueId,
    actorUserId: resolveActorUserId(options.actorUserId),
    occurredAt,
  };
}

export function buildIssueComment(options: IssueScope & {
  body: string,
  actorUserId: string,
  idempotencyKey: string,
  occurredAt?: Date,
}): IssueCommentCommand {
  validateIssueScope(options);
  validateIssueUserId(options.actorUserId, "actorUserId");
  const body = validateCommentBody(options.body);
  const idempotencyKey = validateIdempotencyKey(options.idempotencyKey);
  const occurredAt = resolveOccurredAt(options.occurredAt);
  return {
    operation: "comment",
    tenancyId: options.tenancy.id,
    issueId: options.issueId,
    body,
    actorUserId: options.actorUserId,
    idempotencyKey,
    occurredAt,
  };
}

export function buildIssueSubscription(options: IssueScope & {
  subject: IssueActivitySubject,
  subscribed: boolean,
  actorUserId?: string | null,
  reason?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
}): IssueSubscriptionCommand {
  validateIssueScope(options);
  validateSubject(options.subject);
  const actorUserId = resolveActorUserId(options.actorUserId);
  const reason = options.reason ?? null;
  if (reason !== null && (reason.length === 0 || reason.length > 64)) {
    throw new IssueLifecycleInputError("reason must contain 1-64 characters");
  }
  const idempotencyKey = validateIdempotencyKey(options.idempotencyKey);
  const occurredAt = resolveOccurredAt(options.occurredAt);
  return {
    operation: "subscription",
    tenancyId: options.tenancy.id,
    issueId: options.issueId,
    subject: options.subject,
    subscribed: options.subscribed,
    actorUserId,
    reason,
    idempotencyKey,
    occurredAt,
  };
}

export function buildIssueBookmark(options: IssueScope & {
  userId: string,
  bookmarked: boolean,
  actorUserId?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
}): IssueBookmarkCommand {
  validateIssueScope(options);
  validateIssueUserId(options.userId, "userId");
  const actorUserId = resolveActorUserId(options.actorUserId);
  const idempotencyKey = validateIdempotencyKey(options.idempotencyKey);
  const occurredAt = resolveOccurredAt(options.occurredAt);
  return {
    operation: "bookmark",
    tenancyId: options.tenancy.id,
    issueId: options.issueId,
    userId: options.userId,
    bookmarked: options.bookmarked,
    actorUserId,
    idempotencyKey,
    occurredAt,
  };
}

export async function appendIssueActivity(options: IssueScope & IssueActivityInput): Promise<IssueActivityRecord> {
  const command = buildIssueActivity(options);
  return await persistIssueActivity({
    tenancy: options.tenancy,
    issueId: options.issueId,
    actorUserId: command.actorUserId,
    type: command.type,
    data: command.data,
    idempotencyKey: command.idempotencyKey,
    occurredAt: command.occurredAt,
  });
}

export async function addIssueComment(options: IssueScope & {
  body: string,
  actorUserId: string,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueCommentRecord> {
  const command = buildIssueComment(options);
  return await persistIssueComment({
    tenancy: options.tenancy,
    issueId: options.issueId,
    actorUserId: command.actorUserId,
    body: command.body,
    idempotencyKey: command.idempotencyKey,
    occurredAt: command.occurredAt,
  });
}

export async function setIssueSubscription(options: IssueScope & {
  subject: IssueActivitySubject,
  subscribed: boolean,
  actorUserId?: string | null,
  reason?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueSubjectRecord> {
  const command = buildIssueSubscription(options);
  return await persistIssueSubscription({
    tenancy: options.tenancy,
    issueId: options.issueId,
    subject: command.subject,
    subscribed: command.subscribed,
    actorUserId: command.actorUserId,
    reason: command.reason,
    idempotencyKey: command.idempotencyKey,
    occurredAt: command.occurredAt,
  });
}

export async function setIssueBookmark(options: IssueScope & {
  userId: string,
  bookmarked: boolean,
  actorUserId?: string | null,
  idempotencyKey: string,
  occurredAt?: Date,
}): Promise<IssueBookmarkMutationResult> {
  const command = buildIssueBookmark(options);
  return await persistIssueBookmark({
    tenancy: options.tenancy,
    issueId: options.issueId,
    userId: command.userId,
    bookmarked: command.bookmarked,
    actorUserId: command.actorUserId,
    idempotencyKey: command.idempotencyKey,
    occurredAt: command.occurredAt,
  });
}
