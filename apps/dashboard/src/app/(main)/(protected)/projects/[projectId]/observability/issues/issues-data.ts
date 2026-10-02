import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import {
  IssueBulkStatusRequestSchema,
  IssueBulkStatusResponseSchema,
  IssueDetailResponseSchema,
  IssueListResponseSchema,
  IssueMergeRequestSchema,
  IssueMergeResponseSchema,
  IssueUnmergeRequestSchema,
  IssueUnmergeResponseSchema,
  ISSUE_LIST_PAGE_SIZE,
  type IssueDetailResponse,
  type IssueBulkStatus,
  type IssueBulkStatusResponse,
  type IssueFrame,
  type IssueListResponse,
  type IssueListSortField,
  type IssueMergeResponse,
  type IssueOwner,
  type IssueOccurrence,
  type IssueSubject,
  type IssueStatus,
  type IssueUnmergeResponse,
} from "@hexclave/shared/dist/interface/admin-issues";
import * as yup from "yup";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { sendInternalAdminRequest } from "@/lib/hexclave-app-internals";
import type { RowData } from "../../analytics/shared";
import { getBucketGranularity } from "../bucket-granularity";
import { isObservabilityTimeRangeHours, type ObservabilityTimeRangeHours } from "../filters";
import { parseServiceIdentityRow, type ServiceIdentity } from "../service-identity";


export type {
  IssueDetailResponse,
  IssueFrame,
  IssueListItem,
  IssueListResponse,
  IssueListSortField,
  IssueOwner,
  IssueOccurrence,
  IssueSubject,
  IssueStatus,
  IssueSubstatus,
} from "@hexclave/shared/dist/interface/admin-issues";

export { ISSUE_LIST_PAGE_SIZE } from "@hexclave/shared/dist/interface/admin-issues";

export type IssueStatusCounts = IssueListResponse["counts"];

export const ISSUE_STATUSES: readonly IssueStatus[] = ["unresolved", "resolved", "ignored"];

export type IssueOccurrenceDirection = "newer" | "older";

export type IssueHandledFilter = "all" | "handled" | "unhandled";

export type IssueListRequest = {
  hours: ObservabilityTimeRangeHours,
  status: IssueStatus | "all",
  service: ServiceIdentity | null,
  environment: string | null,
  handled: IssueHandledFilter,
  search: string,
  sort: IssueListSortField,
  sortDir: "asc" | "desc",
  cursor: string | null,
  limit: number,
};


export function getIssueSparklineQuery(
  hours: number,
  hashes: readonly string[],
): { query: string, params: Record<string, string | number | string[]> } {
  if (!isObservabilityTimeRangeHours(hours)) {
    throw new Error(`Unknown issues time range: ${hours}`);
  }
  if (hashes.length === 0) {
    throw new Error("Refusing to build a sparkline query for zero hashes");
  }
  const granularity = getBucketGranularity(hours);
  return {
    query: `
SELECT
  issue_hash,
  toStartOfInterval(event_at, ${granularity.stepSql}) AS bucket_start,
  count() AS occurrences,
  max(now64(3)) AS query_now
FROM default.errors
WHERE event_at >= now64(3) - INTERVAL ${hours} HOUR
  AND issue_hash IN {issueHashes:Array(String)}
GROUP BY issue_hash, bucket_start
ORDER BY issue_hash ASC, bucket_start ASC
`,
    params: { issueHashes: [...hashes] },
  };
}

export function getIssueFacetsQuery(hours: number): { query: string, params: Record<string, string> } {
  if (!isObservabilityTimeRangeHours(hours)) {
    throw new Error(`Unknown issues time range: ${hours}`);
  }
  return {
    query: `
SELECT
  service_namespace,
  service_name,
  deployment_environment_name
FROM default.errors
WHERE event_at >= now64(3) - INTERVAL ${hours} HOUR
GROUP BY service_namespace, service_name, deployment_environment_name
ORDER BY service_namespace ASC, service_name ASC, deployment_environment_name ASC
LIMIT 500
`,
    params: {},
  };
}

export type IssueSparklineBucket = { bucketMs: number, occurrences: number };
export type IssueFacets = { services: ServiceIdentity[], environments: string[] };

export function parseClickHouseUtc(value: Json | undefined, key: string): number {
  if (typeof value !== "string") {
    throw new HexclaveAssertionError(`Expected ${key} to be a ClickHouse timestamp string`);
  }
  const trimmed = value.trim();
  const normalized = trimmed.replace(" ", "T") + (trimmed.includes("Z") || trimmed.includes("+") ? "" : "Z");
  const millis = new Date(normalized).getTime();
  if (Number.isNaN(millis)) throw new HexclaveAssertionError(`Invalid ${key}: ${value}`);
  return millis;
}

function toCount(value: Json | undefined, key: string): number {
  const count = typeof value === "string" ? Number(value) : value;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    throw new HexclaveAssertionError(`Expected ${key} to be a count, got ${String(value)}`);
  }
  return count;
}

export function parseIssueSparklineRows(
  rows: readonly RowData[],
  requestedHashes: readonly string[],
  hours: ObservabilityTimeRangeHours,
  nowMs: number,
): Map<string, IssueSparklineBucket[]> {
  const granularity = getBucketGranularity(hours);
  const queryNowValue = rows.find((row) => row.query_now != null)?.query_now;
  const gridNowMs = queryNowValue == null ? nowMs : parseClickHouseUtc(queryNowValue, "sparkline query_now");
  const latestBucketMs = Math.floor(gridNowMs / granularity.stepMs) * granularity.stepMs;
  const earliestBucketMs = latestBucketMs - (granularity.bucketCount - 1) * granularity.stepMs;
  const byHash = new Map<string, IssueSparklineBucket[]>(
    requestedHashes.map((hash) => [hash, Array.from({ length: granularity.bucketCount }, (_unused, index) => ({
      bucketMs: earliestBucketMs + index * granularity.stepMs,
      occurrences: 0,
    }))]),
  );
  for (const row of rows) {
    const hash = row.issue_hash;
    if (typeof hash !== "string") {
      throw new HexclaveAssertionError("Expected sparkline row issue_hash to be a string");
    }
    const existing = byHash.get(hash);
    if (existing == null) {
      throw new HexclaveAssertionError(`Sparkline row returned an unrequested issue hash: ${hash}`);
    }
    const bucketMs = parseClickHouseUtc(row.bucket_start, "sparkline bucket_start");
    if (bucketMs < earliestBucketMs || bucketMs > latestBucketMs) continue;
    const index = (bucketMs - earliestBucketMs) / granularity.stepMs;
    if (!Number.isInteger(index)) {
      throw new HexclaveAssertionError(`Sparkline bucket ${bucketMs} is not aligned to the ${granularity.label} grid`);
    }
    const bucket = existing[index]
      ?? throwErr(`Sparkline bucket index ${index} is out of range despite the bounds check above`);
    bucket.occurrences += toCount(row.occurrences, "sparkline occurrences");
  }
  return byHash;
}

export function parseIssueFacetRows(rows: readonly RowData[]): IssueFacets {
  const services = new Map<string, ServiceIdentity>();
  const environments = new Set<string>();
  for (const row of rows) {
    const name = row.service_name;
    if (typeof name === "string" && name !== "") {
      const identity = parseServiceIdentityRow(row);
      services.set(`${identity.namespace}${identity.name}`, identity);
    }
    const environment = row.deployment_environment_name;
    if (typeof environment === "string" && environment !== "") environments.add(environment);
  }
  return {
    services: [...services.values()],
    environments: [...environments].sort(stringCompare),
  };
}


export function buildIssueListQueryString(request: IssueListRequest): string {
  const params = new URLSearchParams();
  params.set("hours", String(request.hours));
  params.set("status", request.status);
  if (request.service != null) params.set("service", request.service.name);
  if (request.environment != null) params.set("environment", request.environment);
  params.set("handled", request.handled);
  if (request.search !== "") params.set("search", request.search);
  params.set("sort", request.sort);
  params.set("sort_dir", request.sortDir);
  if (request.cursor != null) params.set("cursor", request.cursor);
  params.set("limit", String(Math.min(request.limit, ISSUE_LIST_PAGE_SIZE)));
  return params.toString();
}

async function readJsonOrThrow(response: Response, what: string): Promise<Json> {
  if (!response.ok) {
    throw new HexclaveAssertionError(`${what} failed with status ${response.status}`);
  }
  return await response.json();
}

export async function fetchIssueList(adminApp: object, request: IssueListRequest): Promise<IssueListResponse> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/internal/issues?${buildIssueListQueryString(request)}`,
    { method: "GET" },
  );
  return await IssueListResponseSchema.validate(await readJsonOrThrow(response, "Loading issues"));
}

export async function fetchIssueDetail(
  adminApp: object,
  idOrShortId: string,
  options: { occurrence?: string, direction?: IssueOccurrenceDirection, hours?: ObservabilityTimeRangeHours } = {},
): Promise<IssueDetailResponse> {
  const params = new URLSearchParams();
  if (options.occurrence != null) params.set("occurrence", options.occurrence);
  if (options.hours != null) params.set("hours", String(options.hours));
  if (options.direction != null) params.set("direction", options.direction);
  const search = params.toString();
  const response = await sendInternalAdminRequest(
    adminApp,
    `/internal/issues/${encodeURIComponent(idOrShortId)}${search === "" ? "" : `?${search}`}`,
    { method: "GET" },
  );
  return await IssueDetailResponseSchema.validate(await readJsonOrThrow(response, "Loading issue"));
}

const IssueStatusUpdateResponseSchema = yup.object({
  id: yup.string().defined(),
  status: yup.string().oneOf<IssueStatus>(["unresolved", "resolved", "ignored"]).defined(),
}).defined();

const IssuePriorityUpdateResponseSchema = yup.object({
  issue_id: yup.string().defined(),
  previous_priority: yup.string().oneOf(["low", "medium", "high"]).nullable().defined(),
  priority: yup.string().oneOf(["low", "medium", "high"]).nullable().defined(),
  changed: yup.boolean().defined(),
  changed_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const IssueCommentResponseSchema = yup.object({
  issue_id: yup.string().defined(),
  id: yup.string().uuid().defined(),
  author_user_id: yup.string().uuid().defined(),
  body: yup.string().defined(),
  idempotency_key: yup.string().defined(),
  created_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const IssueActionResponseSchema = yup.object({
  action: yup.string().oneOf(["assign", "unassign", "resolve", "ignore", "unresolve", "regress", "snooze", "unsnooze"]).defined(),
  issue_id: yup.string().uuid().defined(),
  redirected: yup.boolean().defined(),
  redirected_from_issue_id: yup.string().uuid().nullable().defined(),
  changed: yup.boolean().defined(),
  changed_at_millis: yup.number().integer().min(0).defined(),
  status: yup.string().oneOf(["resolved", "unresolved", "ignored"]).nullable().defined(),
  previous_assignee_user_id: yup.string().uuid().nullable().defined(),
  assignee_user_id: yup.string().uuid().nullable().defined(),
  transition_kind: yup.string().oneOf(["status_changed", "status_unchanged", "regressed", "reopened", "occurrence_unchanged"]).nullable().defined(),
  ignored_until_millis: yup.number().integer().min(0).nullable().defined(),
  regressed_at_millis: yup.number().integer().min(0).nullable().defined(),
}).defined();

const IssueTeamUpdateResponseSchema = yup.object({
  issue_id: yup.string().uuid().defined(),
  previous_team_id: yup.string().uuid().nullable().defined(),
  team_id: yup.string().uuid().nullable().defined(),
  changed: yup.boolean().defined(),
  changed_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const IssueOwnerUpdateResponseSchema = yup.object({
  issue_id: yup.string().uuid().defined(),
  id: yup.string().uuid().defined(),
  type: yup.string().oneOf(["user", "team"]).defined(),
  user_id: yup.string().uuid().nullable().defined(),
  team_id: yup.string().uuid().nullable().defined(),
  source: yup.string().oneOf(["manual", "ownership_rule", "codeowners", "suspect_commit", "seer_suggested"]).defined(),
  context: yup.mixed().nullable().defined(),
  updated_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const IssueBookmarkUpdateResponseSchema = yup.object({
  issue_id: yup.string().uuid().defined(),
  user_id: yup.string().uuid().defined(),
  bookmarked: yup.boolean().defined(),
  changed: yup.boolean().defined(),
  changed_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const IssueSubscriptionUpdateResponseSchema = yup.object({
  issue_id: yup.string().uuid().defined(),
  subject_type: yup.string().oneOf(["user", "team"]).defined(),
  subject_id: yup.string().uuid().defined(),
  subscribed: yup.boolean().defined(),
  reason: yup.string().max(64).nullable().defined(),
  updated_at_millis: yup.number().integer().min(0).defined(),
}).defined();

export type IssueOwnerSource = "manual" | "ownership_rule" | "codeowners" | "suspect_commit" | "seer_suggested";
export type IssueSubjectType = "user" | "team";

function assertUuidInput(value: string, fieldName: string): void {
  if (!yup.string().uuid().isValidSync(value)) {
    throw new HexclaveAssertionError(`${fieldName} must be a UUID`);
  }
}

function assertBoundedInput(value: string, fieldName: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength) {
    throw new HexclaveAssertionError(`${fieldName} must contain 1-${maxLength} characters`);
  }
}

export async function updateIssueStatus(
  adminApp: object,
  issueId: string,
  status: IssueStatus,
): Promise<{ id: string, status: IssueStatus }> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/internal/issues/${encodeURIComponent(issueId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  return await IssueStatusUpdateResponseSchema.validate(await readJsonOrThrow(response, "Updating the issue"));
}

export async function updateIssuesStatusBulk(
  adminApp: object,
  issueIds: readonly string[],
  status: IssueBulkStatus,
): Promise<IssueBulkStatusResponse> {
  const request = await IssueBulkStatusRequestSchema.validate({
    issue_ids: [...issueIds],
    status,
  });
  const response = await sendInternalAdminRequest(adminApp, "/issues/actions/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return await IssueBulkStatusResponseSchema.validate(await readJsonOrThrow(response, "Updating issues"));
}

export async function mergeIssues(
  adminApp: object,
  issueIds: readonly string[],
): Promise<IssueMergeResponse> {
  const request = await IssueMergeRequestSchema.validate({
    issue_ids: [...issueIds],
  });
  const response = await sendInternalAdminRequest(adminApp, "/internal/issues/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return await IssueMergeResponseSchema.validate(await readJsonOrThrow(response, "Merging issues"));
}

export async function unmergeIssue(
  adminApp: object,
  issueId: string,
  hashes: readonly string[],
): Promise<IssueUnmergeResponse> {
  const request = await IssueUnmergeRequestSchema.validate({
    hashes: [...hashes],
  });
  const response = await sendInternalAdminRequest(
    adminApp,
    `/internal/issues/${encodeURIComponent(issueId)}/unmerge`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  return await IssueUnmergeResponseSchema.validate(await readJsonOrThrow(response, "Unmerging issue"));
}

export const ISSUE_SNOOZE_PRESETS = [
  { id: "1h", label: "1 hour", durationMs: 60 * 60 * 1000 },
  { id: "1d", label: "1 day", durationMs: 24 * 60 * 60 * 1000 },
  { id: "1w", label: "1 week", durationMs: 7 * 24 * 60 * 60 * 1000 },
] as const;

export type IssueSnoozePresetId = (typeof ISSUE_SNOOZE_PRESETS)[number]["id"];

export async function snoozeIssue(
  adminApp: object,
  issueId: string,
  ignoredUntilMillis: number,
): Promise<yup.InferType<typeof IssueActionResponseSchema>> {
  if (!Number.isInteger(ignoredUntilMillis) || ignoredUntilMillis <= Date.now()) {
    throw new HexclaveAssertionError("Snooze until must be a future timestamp");
  }
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/snooze`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ignored_until_millis: ignoredUntilMillis }),
    },
  );
  return await IssueActionResponseSchema.validate(await readJsonOrThrow(response, "Snoozing issue"));
}

export async function unsnoozeIssue(
  adminApp: object,
  issueId: string,
): Promise<yup.InferType<typeof IssueActionResponseSchema>> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/unsnooze`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return await IssueActionResponseSchema.validate(await readJsonOrThrow(response, "Unsnoozing issue"));
}

export async function regressIssue(
  adminApp: object,
  issueId: string,
): Promise<yup.InferType<typeof IssueActionResponseSchema>> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/regress`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return await IssueActionResponseSchema.validate(await readJsonOrThrow(response, "Marking issue as regressed"));
}

export type IssuePublicSearchRequest = {
  hours: ObservabilityTimeRangeHours,
  status: IssueStatus | "all",
  service: ServiceIdentity | null,
  environment: string | null,
  handled: boolean | "all",
  search: string,
  level: string | null,
  release: string | null,
  userId: string | null,
  tagKey: string | null,
  tagValue: string | null,
  cursor: string | null,
};

export type IssuePublicSearchRecord = {
  record_type: string,
  issue_id: string | null,
  issue_short_id: string | null,
  issue_type: string | null,
  issue_value: string | null,
  issue_culprit: string | null,
  issue_status: IssueStatus | null,
  event_id: string | null,
  occurrence_id: string | null,
  event_at_millis: number,
  message: string,
  level: string,
  release: string | null,
  matched_tag: { key: string, value: string } | null,
};

const IssuePublicSearchResponseSchema = yup.object({
  items: yup.array(yup.object({
    record_type: yup.string().defined(),
    issue_id: yup.string().nullable().defined(),
    issue_short_id: yup.string().nullable().defined(),
    issue_type: yup.string().nullable().defined(),
    issue_value: yup.string().nullable().defined(),
    issue_culprit: yup.string().nullable().defined(),
    issue_status: yup.string().oneOf(["unresolved", "resolved", "ignored"]).nullable().defined(),
    event_id: yup.string().nullable().defined(),
    occurrence_id: yup.string().nullable().defined(),
    event_at_millis: yup.number().defined(),
    message: yup.string().defined(),
    level: yup.string().defined(),
    release: yup.string().nullable().defined(),
    matched_tag: yup.object({
      key: yup.string().defined(),
      value: yup.string().defined(),
    }).nullable().defined(),
  }).defined()).defined(),
  next_cursor: yup.string().nullable().defined(),
}).defined();

export async function searchPublicIssues(
  adminApp: object,
  request: IssuePublicSearchRequest,
): Promise<{ items: IssuePublicSearchRecord[], nextCursor: string | null }> {
  const params = new URLSearchParams();
  params.set("record", "issue");
  params.set("hours", String(request.hours));
  if (request.status !== "all") params.set("status", request.status);
  if (request.service != null) params.set("service", request.service.name);
  if (request.environment != null) params.set("environment", request.environment);
  if (request.handled !== "all") params.set("handled", String(request.handled));
  if (request.search !== "") params.set("message", request.search);
  if (request.level != null) params.set("level", request.level);
  if (request.release != null) params.set("release", request.release);
  if (request.userId != null) params.set("user_id", request.userId);
  if (request.tagKey != null) params.set("tag_key", request.tagKey);
  if (request.tagValue != null) params.set("tag_value", request.tagValue);
  if (request.cursor != null) params.set("cursor", request.cursor);
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/search?${params.toString()}`,
    { method: "GET" },
  );
  const body = await IssuePublicSearchResponseSchema.validate(await readJsonOrThrow(response, "Searching issues"));
  return { items: body.items, nextCursor: body.next_cursor };
}

export type IssuePriority = "low" | "medium" | "high";

export async function updateIssuePriority(
  adminApp: object,
  issueId: string,
  priority: IssuePriority | null,
): Promise<yup.InferType<typeof IssuePriorityUpdateResponseSchema>> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/priority`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority }),
    },
  );
  return await IssuePriorityUpdateResponseSchema.validate(await readJsonOrThrow(response, "Updating issue priority"));
}

export async function addIssueComment(
  adminApp: object,
  issueId: string,
  body: string,
  idempotencyKey: string,
): Promise<yup.InferType<typeof IssueCommentResponseSchema>> {
  assertBoundedInput(body, "Comment", 10_000);
  assertBoundedInput(idempotencyKey, "Idempotency key", 128);
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/comment`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, idempotency_key: idempotencyKey }),
    },
  );
  return await IssueCommentResponseSchema.validate(await readJsonOrThrow(response, "Adding issue comment"));
}

export async function updateIssueAssignment(
  adminApp: object,
  issueId: string,
  assigneeUserId: string | null,
): Promise<yup.InferType<typeof IssueActionResponseSchema>> {
  const path = assigneeUserId == null
    ? `/issues/${encodeURIComponent(issueId)}/actions/unassign`
    : `/issues/${encodeURIComponent(issueId)}/actions/assign`;
  if (assigneeUserId != null) assertUuidInput(assigneeUserId, "Assignee user ID");
  const response = await sendInternalAdminRequest(adminApp, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(assigneeUserId == null ? {} : { assignee_user_id: assigneeUserId }),
  });
  return await IssueActionResponseSchema.validate(await readJsonOrThrow(response, "Updating issue assignment"));
}

export async function updateIssueTeam(
  adminApp: object,
  issueId: string,
  teamId: string | null,
): Promise<yup.InferType<typeof IssueTeamUpdateResponseSchema>> {
  if (teamId != null) assertUuidInput(teamId, "Team ID");
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/team`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_id: teamId }),
    },
  );
  return await IssueTeamUpdateResponseSchema.validate(await readJsonOrThrow(response, "Updating issue team"));
}

export async function updateIssueOwner(
  adminApp: object,
  issueId: string,
  owner: { type: IssueSubjectType, userId: string | null, teamId: string | null, source?: IssueOwnerSource },
): Promise<yup.InferType<typeof IssueOwnerUpdateResponseSchema>> {
  if (owner.type === "user") {
    if (owner.userId == null || owner.teamId !== null) throw new HexclaveAssertionError("A user owner requires only a user ID");
    assertUuidInput(owner.userId, "Owner user ID");
  } else {
    if (owner.teamId == null || owner.userId !== null) throw new HexclaveAssertionError("A team owner requires only a team ID");
    assertUuidInput(owner.teamId, "Owner team ID");
  }
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/owner`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: owner.type, user_id: owner.userId, team_id: owner.teamId, source: owner.source ?? "manual", context: null }),
    },
  );
  return await IssueOwnerUpdateResponseSchema.validate(await readJsonOrThrow(response, "Updating issue ownership"));
}

export async function clearManualIssueOwners(adminApp: object, issueId: string): Promise<void> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/owner`,
    { method: "DELETE" },
  );
  await readJsonOrThrow(response, "Clearing manual issue ownership");
}

export async function updateIssueBookmark(
  adminApp: object,
  issueId: string,
  userId: string,
  bookmarked: boolean,
  idempotencyKey: string,
): Promise<yup.InferType<typeof IssueBookmarkUpdateResponseSchema>> {
  assertUuidInput(userId, "Bookmark user ID");
  assertBoundedInput(idempotencyKey, "Idempotency key", 128);
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/bookmark`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, bookmarked, idempotency_key: idempotencyKey }),
    },
  );
  return await IssueBookmarkUpdateResponseSchema.validate(await readJsonOrThrow(response, "Updating issue bookmark"));
}

export async function updateIssueSubscription(
  adminApp: object,
  issueId: string,
  subjectType: IssueSubjectType,
  subjectId: string,
  subscribed: boolean,
  reason: string | null,
  idempotencyKey: string,
): Promise<yup.InferType<typeof IssueSubscriptionUpdateResponseSchema>> {
  assertUuidInput(subjectId, "Subscription subject ID");
  if (reason != null) assertBoundedInput(reason, "Subscription reason", 64);
  assertBoundedInput(idempotencyKey, "Idempotency key", 128);
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/${encodeURIComponent(issueId)}/actions/subscribe`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject_type: subjectType, subject_id: subjectId, subscribed, reason, idempotency_key: idempotencyKey }),
    },
  );
  return await IssueSubscriptionUpdateResponseSchema.validate(await readJsonOrThrow(response, "Updating issue subscription"));
}

export function setIssueAssignee(detail: IssueDetailResponse, assigneeUserId: string | null): IssueDetailResponse {
  return { ...detail, product: { ...detail.product, assignee_user_id: assigneeUserId } };
}

export function setIssueTeam(detail: IssueDetailResponse, teamId: string | null): IssueDetailResponse {
  return { ...detail, product: { ...detail.product, team_id: teamId } };
}

export function setIssueBookmarkState(detail: IssueDetailResponse, userId: string, bookmarked: boolean): IssueDetailResponse {
  const userIds = new Set(detail.product.bookmarked_user_ids);
  if (bookmarked) userIds.add(userId);
  else userIds.delete(userId);
  return { ...detail, product: { ...detail.product, bookmarked_user_ids: [...userIds] } };
}

export function setIssueSubscriptionState(
  detail: IssueDetailResponse,
  subject: IssueSubject,
  subscribed: boolean,
  updatedAt: string,
): IssueDetailResponse {
  const existing = detail.product.subscriptions.find((value) => value.type === subject.type && value.id === subject.id);
  const nextSubject = { ...subject, is_active: subscribed, updated_at: updatedAt, created_at: existing?.created_at ?? updatedAt };
  const subscriptions = detail.product.subscriptions.filter((value) => value !== existing);
  return { ...detail, product: { ...detail.product, subscriptions: [nextSubject, ...subscriptions].slice(0, 100) } };
}

export function setIssueOwnerState(detail: IssueDetailResponse, owner: IssueOwner): IssueDetailResponse {
  const owners = detail.product.owners.filter((value) => value.id !== owner.id);
  return { ...detail, product: { ...detail.product, owners: [owner, ...owners].slice(0, 100) } };
}

export function clearManualIssueOwnerState(detail: IssueDetailResponse): IssueDetailResponse {
  return { ...detail, product: { ...detail.product, owners: detail.product.owners.filter((owner) => owner.source !== "manual") } };
}
