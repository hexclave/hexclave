import { resolveIssueIdentity, type ResolvedIssueIdentity } from "@/lib/issues/issue-identity";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import type { Tenancy } from "@/lib/tenancies";
import {
  IssueLifecycleInputError,
  IssueNotFoundError,
  type IssueLifecycleStatus,
  type IssueLifecycleTransition,
} from "@/lib/issues/issue-lifecycle";
import { ISSUE_PRODUCT_ERROR_CODES, IssueProductInputError } from "@/lib/issues/issue-product";
import type { SmartRequest } from "@/route-handlers/smart-request";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { MAX_ISSUE_TIMESTAMP_MILLIS } from "@hexclave/shared/dist/interface/admin-issues";

export const MAX_ACTION_TIMESTAMP_MILLIS = MAX_ISSUE_TIMESTAMP_MILLIS;
const MAX_ACTION_ISSUE_ID_LENGTH = 64;

export const IssueActionAuthSchema = yupObject({
  type: serverOrHigherAuthTypeSchema.defined(),
  tenancy: adaptSchema.defined(),
}).defined();

export const IssueActionParamsSchema = yupObject({
  issue_id: yupString().nonEmpty().max(MAX_ACTION_ISSUE_ID_LENGTH).defined(),
}).defined();

const ISSUE_ACTIONS = ["assign", "unassign", "resolve", "ignore", "unresolve", "regress", "snooze", "unsnooze"] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];

const ISSUE_TRANSITION_KINDS = ["status_changed", "status_unchanged", "regressed", "reopened", "occurrence_unchanged"] as const;

export const IssueActionResponseSchema = yupObject({
  action: yupString().oneOf([...ISSUE_ACTIONS]).defined(),
  issue_id: yupString().uuid().defined(),
  redirected: yupBoolean().defined(),
  redirected_from_issue_id: yupString().uuid().nullable().defined(),
  changed: yupBoolean().defined(),
  changed_at_millis: yupNumber().integer().min(0).max(MAX_ACTION_TIMESTAMP_MILLIS).defined(),
  status: yupString().oneOf(["unresolved", "resolved", "ignored"]).nullable().defined(),
  previous_assignee_user_id: yupString().uuid().nullable().defined(),
  assignee_user_id: yupString().uuid().nullable().defined(),
  transition_kind: yupString().oneOf([...ISSUE_TRANSITION_KINDS]).nullable().defined(),
  ignored_until_millis: yupNumber().integer().min(0).max(MAX_ACTION_TIMESTAMP_MILLIS).nullable().defined(),
  regressed_at_millis: yupNumber().integer().min(0).max(MAX_ACTION_TIMESTAMP_MILLIS).nullable().defined(),
}).defined();

export type IssueActionResponse = {
  action: IssueAction,
  issue_id: string,
  redirected: boolean,
  redirected_from_issue_id: string | null,
  changed: boolean,
  changed_at_millis: number,
  status: IssueLifecycleStatus | null,
  previous_assignee_user_id: string | null,
  assignee_user_id: string | null,
  transition_kind: (typeof ISSUE_TRANSITION_KINDS)[number] | null,
  ignored_until_millis: number | null,
  regressed_at_millis: number | null,
};

export type IssueActionTarget = ResolvedIssueIdentity;

export function assertIssueActionsEnabled(tenancy: Tenancy): void {
  assertObservabilityEnabled(tenancy);
}

export function actorUserId(fullReq: SmartRequest): string | null {
  return fullReq.auth?.user?.id ?? fullReq.auth?.adminUserId ?? null;
}

export function isIssueRowVanishedError(error: unknown): boolean {
  return error instanceof IssueProductInputError
    && error.code === ISSUE_PRODUCT_ERROR_CODES.issueNotFoundInBranch;
}

export async function withIssueActionTarget<T>(options: {
  tenancy: Tenancy,
  rawIssueId: string,
  action: (target: IssueActionTarget) => Promise<T>,
  // Injection seam so tests can exercise the replica-then-primary retry logic
  // without the DB-backed resolver; production callers omit it.
  resolveIdentity?: typeof resolveIssueIdentity,
}): Promise<{ target: IssueActionTarget, result: T }> {
  const resolveIdentity = options.resolveIdentity ?? resolveIssueIdentity;
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await resolveIdentity(options.tenancy, options.rawIssueId, {
      consistency: attempt === 0 ? "replica" : "primary",
    });
    if (target === null) {
      if (attempt === 0) continue;
      throw new StatusError(StatusError.NotFound, "Issue not found");
    }
    try {
      return { target, result: await options.action(target) };
    } catch (error) {
      if ((error instanceof IssueNotFoundError || isIssueRowVanishedError(error)) && attempt === 0) continue;
      rethrowIssueActionError(error);
    }
  }
  throw new StatusError(StatusError.NotFound, "Issue not found");
}

export function rethrowIssueActionError(error: unknown): never {
  if (error instanceof IssueNotFoundError) {
    throw new StatusError(StatusError.NotFound, "Issue not found");
  }
  if (error instanceof IssueLifecycleInputError) {
    throw new StatusError(StatusError.BadRequest, "Invalid issue action");
  }
  if (error instanceof IssueProductInputError) {
    if (isIssueRowVanishedError(error)) {
      throw new StatusError(StatusError.NotFound, "Issue not found");
    }
    throw new StatusError(StatusError.BadRequest, "Invalid issue product action");
  }
  throw error;
}

export function baseActionResponse(options: {
  target: IssueActionTarget,
  action: IssueAction,
  changed: boolean,
  changedAt: Date,
}): IssueActionResponse {
  return {
    action: options.action,
    issue_id: options.target.issueId,
    redirected: options.target.redirectedFromIssueId !== null,
    redirected_from_issue_id: options.target.redirectedFromIssueId,
    changed: options.changed,
    changed_at_millis: options.changedAt.getTime(),
    status: null,
    previous_assignee_user_id: null,
    assignee_user_id: null,
    transition_kind: null,
    ignored_until_millis: null,
    regressed_at_millis: null,
  };
}

export function transitionActionResponse(options: {
  target: IssueActionTarget,
  action: IssueAction,
  transition: IssueLifecycleTransition,
}): IssueActionResponse {
  const response = baseActionResponse({
    target: options.target,
    action: options.action,
    changed: options.transition.kind !== "status_unchanged" && options.transition.kind !== "occurrence_unchanged",
    changedAt: options.transition.at,
  });
  return {
    ...response,
    status: options.transition.current.status,
    transition_kind: options.transition.kind,
    ignored_until_millis: options.transition.current.ignoredUntil?.getTime() ?? null,
    regressed_at_millis: options.transition.current.regressedAt?.getTime() ?? null,
  };
}
