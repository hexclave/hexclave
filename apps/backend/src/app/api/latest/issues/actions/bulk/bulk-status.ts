import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { isValidShortId } from "@/lib/issues/issue-identity";
import type { Tenancy } from "@/lib/tenancies";
import {
  transitionIssueStatus,
  type IssueLifecycleTransition,
  type IssueLifecycleStatus,
} from "@/lib/issues/issue-lifecycle";
import {
  transitionActionResponse,
  withIssueActionTarget,
} from "../../[issue_id]/actions/_shared";

export const MAX_BULK_ISSUE_IDS = 1_000;
export const MAX_BULK_ISSUE_ID_LENGTH = 64;

export const BULK_ISSUE_STATUSES = ["resolved", "ignored", "unresolved"] as const;
export type BulkIssueStatus = (typeof BULK_ISSUE_STATUSES)[number];

export const BULK_ISSUE_ACTIONS = ["resolve", "ignore", "unresolve"] as const;
export type BulkIssueAction = (typeof BULK_ISSUE_ACTIONS)[number];

export type BulkIssueStatusResult = {
  input_issue_id: string,
  action: BulkIssueAction,
  issue_id: string | null,
  redirected: boolean,
  redirected_from_issue_id: string | null,
  changed: boolean,
  changed_at_millis: number | null,
  status: IssueLifecycleStatus | null,
  transition_kind: IssueLifecycleTransition["kind"] | null,
  ignored_until_millis: number | null,
  regressed_at_millis: number | null,
  error: "not_found" | null,
};

export function isValidBulkIssueIdentifier(value: string): boolean {
  return value.length <= MAX_BULK_ISSUE_ID_LENGTH && (isUuid(value) || isValidShortId(value));
}

export function assertBulkIssueIdentifiers(issueIds: readonly string[]): void {
  if (issueIds.length === 0 || issueIds.length > MAX_BULK_ISSUE_IDS) {
    throw new StatusError(StatusError.BadRequest, `issue_ids must contain between 1 and ${MAX_BULK_ISSUE_IDS} unique identifiers`);
  }
  if (new Set(issueIds).size !== issueIds.length) {
    throw new StatusError(StatusError.BadRequest, "issue_ids must not contain duplicates");
  }
  if (issueIds.some((issueId) => !isValidBulkIssueIdentifier(issueId))) {
    throw new StatusError(StatusError.BadRequest, "issue_ids must contain only UUIDs or numeric short ids");
  }
}

export function actionForBulkIssueStatus(status: BulkIssueStatus): BulkIssueAction {
  switch (status) {
    case "resolved": {
      return "resolve";
    }
    case "ignored": {
      return "ignore";
    }
    case "unresolved": {
      return "unresolve";
    }
  }
}

export function parseBulkIssueStatus(value: unknown): BulkIssueStatus {
  if (typeof value === "string") {
    for (const status of BULK_ISSUE_STATUSES) {
      if (value === status) return status;
    }
  }
  throw new StatusError(StatusError.BadRequest, "status must be resolved, ignored, or unresolved");
}

function notFoundResult(inputIssueId: string, action: BulkIssueAction): BulkIssueStatusResult {
  return {
    input_issue_id: inputIssueId,
    action,
    issue_id: null,
    redirected: false,
    redirected_from_issue_id: null,
    changed: false,
    changed_at_millis: null,
    status: null,
    transition_kind: null,
    ignored_until_millis: null,
    regressed_at_millis: null,
    error: "not_found",
  };
}

export async function applyBulkIssueStatusItem(options: {
  tenancy: Tenancy,
  inputIssueId: string,
  status: BulkIssueStatus,
}): Promise<BulkIssueStatusResult> {
  const action = actionForBulkIssueStatus(options.status);
  try {
    const { target, result } = await withIssueActionTarget({
      tenancy: options.tenancy,
      rawIssueId: options.inputIssueId,
      action: (resolved) => transitionIssueStatus({
        tenancy: options.tenancy,
        issueId: resolved.issueId,
        mutation: { status: options.status },
      }),
    });
    const response = transitionActionResponse({ target, action, transition: result });
    const {
      previous_assignee_user_id: _previousAssigneeUserId,
      assignee_user_id: _assigneeUserId,
      ...bulkResponse
    } = response;
    return {
      ...bulkResponse,
      input_issue_id: options.inputIssueId,
      error: null,
      action,
    };
  } catch (error) {
    if (error instanceof StatusError && error.statusCode === StatusError.NotFound.statusCode) {
      return notFoundResult(options.inputIssueId, action);
    }
    throw error;
  }
}

export async function applyBulkIssueStatus(options: {
  tenancy: Tenancy,
  issueIds: readonly string[],
  status: BulkIssueStatus,
}): Promise<BulkIssueStatusResult[]> {
  assertBulkIssueIdentifiers(options.issueIds);
  const results: BulkIssueStatusResult[] = [];
  for (const inputIssueId of options.issueIds) {
    results.push(await applyBulkIssueStatusItem({
      tenancy: options.tenancy,
      inputIssueId,
      status: options.status,
    }));
  }
  return results;
}
