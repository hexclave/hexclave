import yup from "yup";
import {
  ISSUE_LIST_PAGE_SIZE,
  ISSUE_LIST_SORT_FIELDS,
  type IssueListItem,
  type IssueListSortField,
  IssueAttachmentSchema,
  type IssueAttachment,
  IssueGroupingHashProvenanceSchema,
  type IssueGroupingHashProvenance,
  IssueProductMetadataSchema,
  type IssueProductMetadata,
  type IssueFrame,
  type IssueOccurrence,
  type IssueStatus,
} from "@hexclave/shared/dist/interface/admin-issues";
import { yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { scrubPublicText } from "@/lib/issues/public-scrub";
import type { SymbolicationDiagnosticCode } from "@/lib/symbolication";
import {
  decodeIssueCursor,
  decodeOccurrenceCursor,
  type IssueListFilters,
  type OccurrenceCursor,
} from "@/lib/issues/issue-queries";
import type { IssueReleaseContext } from "@/lib/releases/issue-release-context";

export type { IssueGroupingHashProvenance };

export type PublicIssue = Pick<IssueListItem,
  | "id"
  | "short_id"
  | "type"
  | "value"
  | "culprit"
  | "level"
  | "status"
  | "substatus"
  | "first_seen_at_millis"
  | "last_seen_at_millis"
  | "times_seen"
  | "window_occurrences"
  | "window_users"
  | "service_name"
  | "environment"
  | "release"
  | "handled"
  | "synthetic"
  | "updated_at_millis"
>;

const PUBLIC_ISSUE_SYMBOLICATION_DIAGNOSTIC_CODES = [
  "frame_limit_exceeded",
  "invalid_frame",
  "invalid_frame_location",
  "missing_debug_id",
  "invalid_debug_id",
  "invalid_artifact",
  "missing_artifact",
  "artifact_mismatch",
  "artifact_integrity_mismatch",
  "artifact_storage_unavailable",
  "missing_bundle",
  "bundle_too_large",
  "missing_source_map",
  "source_map_too_large",
  "invalid_source_map",
  "unsupported_source_map",
  "no_mapping",
  "missing_source_content",
  "source_content_too_large",
  "source_context_unavailable",
  "missing_release_metadata",
  "invalid_release_metadata",
  "invalid_dist_metadata",
  "missing_code_file_metadata",
] as const satisfies readonly (SymbolicationDiagnosticCode | "missing_release_metadata" | "invalid_release_metadata" | "invalid_dist_metadata" | "missing_code_file_metadata")[];

export type PublicIssueSymbolicationDiagnosticCode = (typeof PUBLIC_ISSUE_SYMBOLICATION_DIAGNOSTIC_CODES)[number];

export type PublicIssueSymbolicationDiagnostic = {
  code: PublicIssueSymbolicationDiagnosticCode,
  message: string,
  debug_id?: string,
  code_file?: string,
  line?: number | null,
  column?: number | null,
  source?: string,
};

export type PublicIssueSourceContext = {
  pre: string[],
  line: string,
  post: string[],
};

export type PublicIssueErrorEnvelope = Record<string, Json>;

export type PublicIssueFrameSymbolication = {
  status: "symbolicated" | "unsymbolicated" | "not_attempted",
  source_file: string | null,
  original_line: number | null,
  original_column: number | null,
  name: string | null,
  context: PublicIssueSourceContext | null,
  diagnostics: PublicIssueSymbolicationDiagnostic[],
};

export type PublicIssueFrame = Omit<IssueFrame, "symbolication"> & {
  symbolication: PublicIssueFrameSymbolication,
};

export type PublicIssueOccurrence = Omit<Pick<IssueOccurrence,
  | "occurrence_id"
  | "event_at_millis"
  | "message"
  | "level"
  | "data"
  | "grouping_provenance"
  | "frames"
  | "raw_stack"
  | "trace_id"
  | "span_id"
  | "page_view_span_id"
  | "session_replay_id"
  | "user_id"
  | "service_name"
  | "environment"
  | "release"
  >, "frames"> & {
  frames: PublicIssueFrame[],
  attachments: IssueAttachment[],
  error_envelope: PublicIssueErrorEnvelope | null,
  grouping_provenance: IssueGroupingHashProvenance[],
  symbolication_diagnostics: PublicIssueSymbolicationDiagnostic[],
};

export type PublicIssueReleaseContext = IssueReleaseContext;

const PublicIssueReleaseCommitSchema = yupObject({
  id: yupString().defined(),
  release_id: yupString().defined(),
  release_version: yupString().defined(),
  repository: yupString().defined(),
  commit_sha: yupString().defined(),
  position: yupNumber().integer().defined(),
  message: yupString().nullable().defined(),
  author_name: yupString().nullable().defined(),
  committed_at: yupString().nullable().defined(),
  url: yupString().nullable().defined(),
}).defined();

const PublicIssueReleaseDeploymentSchema = yupObject({
  id: yupString().defined(),
  release_id: yupString().defined(),
  deployment_key: yupString().defined(),
  environment: yupString().defined(),
  name: yupString().nullable().defined(),
  url: yupString().nullable().defined(),
  started_at: yupString().nullable().defined(),
  finished_at: yupString().defined(),
}).defined();

const PublicIssueReleaseSchema = yupObject({
  id: yupString().defined(),
  version: yupString().defined(),
  status: yupString().oneOf(["open", "archived"]).defined(),
  date_added: yupString().defined(),
  date_started: yupString().nullable().defined(),
  date_released: yupString().nullable().defined(),
  deployments: yupArray(PublicIssueReleaseDeploymentSchema).defined(),
  commits: yupArray(PublicIssueReleaseCommitSchema).defined(),
}).defined();

const PublicIssueSuspectCommitSchema = yupObject({
  owner_id: yupString().defined(),
  matched_by: yupString().oneOf(["release_commit_id", "commit_sha"]).defined(),
  strategy: yupString().nullable().defined(),
  commit: PublicIssueReleaseCommitSchema,
}).defined();

export const PublicIssueReleaseContextSchema = yupObject({
  first_release: PublicIssueReleaseSchema.nullable().defined(),
  last_release: PublicIssueReleaseSchema.nullable().defined(),
  release_commits: yupArray(PublicIssueReleaseCommitSchema).defined(),
  suspect_commits: yupArray(PublicIssueSuspectCommitSchema).defined(),
}).defined();

export const PublicIssueSourceContextSchema = yupObject({
  pre: yupArray(yupString().defined()).defined(),
  line: yupString().defined(),
  post: yupArray(yupString().defined()).defined(),
}).defined();

export const PublicIssueSymbolicationDiagnosticSchema = yupObject({
  code: yupString().oneOf(PUBLIC_ISSUE_SYMBOLICATION_DIAGNOSTIC_CODES).defined(),
  message: yupString().defined(),
  debug_id: yupString().optional(),
  code_file: yupString().optional(),
  line: yupNumber().nullable().optional(),
  column: yupNumber().nullable().optional(),
  source: yupString().optional(),
}).defined();

export const PublicIssueFrameSymbolicationSchema = yupObject({
  status: yupString().oneOf(["symbolicated", "unsymbolicated", "not_attempted"]).defined(),
  source_file: yupString().nullable().defined(),
  original_line: yupNumber().nullable().defined(),
  original_column: yupNumber().nullable().defined(),
  name: yupString().nullable().defined(),
  context: PublicIssueSourceContextSchema.nullable().defined(),
  diagnostics: yupArray(PublicIssueSymbolicationDiagnosticSchema).defined(),
}).defined();

export const PublicIssueFrameSchema = yupObject({
  filename: yupString().nullable().defined(),
  function: yupString().nullable().defined(),
  module: yupString().nullable().defined(),
  abs_path: yupString().nullable().defined(),
  lineno: yupNumber().nullable().defined(),
  colno: yupNumber().nullable().defined(),
  in_app: yupBoolean().defined(),
  debug_id: yupString().optional(),
  symbolication: PublicIssueFrameSymbolicationSchema.defined(),
}).defined();

export const PublicIssueSchema = yupObject({
  id: yupString().defined(),
  short_id: yupString().defined(),
  type: yupString().defined(),
  value: yupString().defined(),
  culprit: yupString().defined(),
  level: yupString().defined(),
  status: yupString().oneOf(["unresolved", "resolved", "ignored"]).defined(),
  substatus: yupString().oneOf(["new", "ongoing", "regressed"]).defined(),
  first_seen_at_millis: yupNumber().defined(),
  last_seen_at_millis: yupNumber().defined(),
  times_seen: yupString().defined(),
  window_occurrences: yupNumber().defined(),
  window_users: yupNumber().defined(),
  service_name: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  release: yupString().nullable().defined(),
  handled: yupBoolean().defined(),
  synthetic: yupBoolean().defined(),
  updated_at_millis: yupNumber().defined(),
}).defined();

export const PublicIssueOccurrenceSchema = yupObject({
  occurrence_id: yupString().defined(),
  event_at_millis: yupNumber().defined(),
  message: yupString().defined(),
  level: yupString().defined(),
  data: yupMixed().defined(),
  error_envelope: yupMixed<PublicIssueErrorEnvelope>().nullable().defined(),
  grouping_provenance: yupArray(IssueGroupingHashProvenanceSchema).max(16).defined(),
  frames: yupArray(PublicIssueFrameSchema).defined(),
  raw_stack: yupString().nullable().defined(),
  trace_id: yupString().nullable().defined(),
  span_id: yupString().nullable().defined(),
  page_view_span_id: yupString().nullable().defined(),
  session_replay_id: yupString().nullable().defined(),
  user_id: yupString().nullable().defined(),
  service_name: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  release: yupString().nullable().defined(),
  attachments: yupArray(IssueAttachmentSchema).max(100).defined(),
  symbolication_diagnostics: yupArray(PublicIssueSymbolicationDiagnosticSchema).defined(),
}).defined();

export const PublicIssueListResponseSchema = yupObject({
  items: yupArray(PublicIssueSchema).defined(),
  next_cursor: yupString().nullable().defined(),
  counts: yupObject({
    unresolved: yupNumber().defined(),
    resolved: yupNumber().defined(),
    ignored: yupNumber().defined(),
  }).defined(),
  approximate: yupBoolean().defined(),
}).defined();

export const PublicIssueDetailResponseSchema = yupObject({
  issue: PublicIssueSchema,
  occurrence: PublicIssueOccurrenceSchema.nullable().defined(),
  product: IssueProductMetadataSchema,
  release_context: PublicIssueReleaseContextSchema,
  newer_cursor: yupString().nullable().defined(),
  older_cursor: yupString().nullable().defined(),
}).defined();

export const PublicIssueOccurrencesResponseSchema = yupObject({
  items: yupArray(PublicIssueOccurrenceSchema).defined(),
  next_cursor: yupString().nullable().defined(),
}).defined();

export const PublicIssueListQuerySchema = yupObject({
  hours: yupString().optional(),
  status: yupString().optional(),
  service: yupString().max(255).optional(),
  environment: yupString().max(255).optional(),
  handled: yupString().optional(),
  search: yupString().max(256).optional(),
  sort: yupString().optional(),
  sort_dir: yupString().optional(),
  cursor: yupString().optional(),
  limit: yupString().optional(),
}).defined();

export const PublicIssueDetailQuerySchema = yupObject({
  hours: yupString().optional(),
  occurrence: yupString().optional(),
  direction: yupString().optional(),
}).defined();

export const PublicIssueOccurrencesQuerySchema = yupObject({
  cursor: yupString().optional(),
  direction: yupString().optional(),
  limit: yupString().optional(),
}).defined();

export type PublicIssueListQuery = yup.InferType<typeof PublicIssueListQuerySchema>;
export type PublicIssueDetailQuery = yup.InferType<typeof PublicIssueDetailQuerySchema>;
export type PublicIssueOccurrencesQuery = yup.InferType<typeof PublicIssueOccurrencesQuerySchema>;

const ALLOWED_HOURS = [1, 24, 168, 720] as const;
const DEFAULT_HOURS = 24;
export const PUBLIC_ISSUE_PAGE_SIZE = ISSUE_LIST_PAGE_SIZE;

function badRequest(message: string): never {
  throw new StatusError(StatusError.BadRequest, message);
}

function parseHours(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HOURS;
  const value = Number(raw);
  if (!ALLOWED_HOURS.some((hour) => hour === value)) {
    return badRequest(`hours must be one of ${ALLOWED_HOURS.join(", ")}`);
  }
  return value;
}

function parseStatus(raw: string | undefined): IssueStatus | "all" {
  if (raw === undefined) return "unresolved";
  if (raw === "all" || raw === "unresolved" || raw === "resolved" || raw === "ignored") return raw;
  return badRequest("status must be one of unresolved, resolved, ignored, all");
}

function parseSort(raw: string | undefined): IssueListSortField {
  if (raw === undefined) return "last_seen";
  const sort = ISSUE_LIST_SORT_FIELDS.find((field) => field === raw);
  if (sort === undefined) return badRequest(`sort must be one of ${ISSUE_LIST_SORT_FIELDS.join(", ")}`);
  return sort;
}

function parseSortDirection(raw: string | undefined): "asc" | "desc" {
  if (raw === undefined || raw === "desc") return "desc";
  if (raw === "asc") return "asc";
  return badRequest("sort_dir must be one of asc, desc");
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return PUBLIC_ISSUE_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return badRequest("limit must be a positive integer");
  return Math.min(value, PUBLIC_ISSUE_PAGE_SIZE);
}

function parseHandled(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "all") return null;
  if (raw === "handled") return true;
  if (raw === "unhandled") return false;
  return badRequest("handled must be one of all, handled, unhandled");
}

function normalizeFilter(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value === undefined || value === "" ? null : value;
}

function parseIssueCursor(
  raw: string | undefined,
  sort: IssueListSortField,
  sortDir: "asc" | "desc",
): string | null {
  if (raw === undefined) return null;
  if (sort === "events" || sort === "users") {
    return badRequest("cursor is not supported when sorting by events or users");
  }
  if (decodeIssueCursor(raw, { sort, sortDir }) === null) {
    return badRequest("cursor is invalid or was created for a different sort order");
  }
  return raw;
}

function parseOccurrenceCursor(raw: string | undefined): OccurrenceCursor | null {
  if (raw === undefined) return null;
  const cursor = decodeOccurrenceCursor(raw);
  if (cursor === null) return badRequest("occurrence cursor is invalid");
  return cursor;
}

function parseDirection(raw: string | undefined): "older" | "newer" {
  if (raw === undefined || raw === "older") return "older";
  if (raw === "newer") return "newer";
  return badRequest("direction must be one of older, newer");
}

export function parsePublicIssueHours(raw: string | undefined): number {
  return parseHours(raw);
}

export function parsePublicIssueListQuery(query: PublicIssueListQuery | undefined): IssueListFilters {
  const sort = parseSort(query?.sort);
  const sortDir = parseSortDirection(query?.sort_dir);
  return {
    hours: parseHours(query?.hours),
    status: parseStatus(query?.status),
    serviceName: normalizeFilter(query?.service),
    environment: normalizeFilter(query?.environment),
    handled: parseHandled(query?.handled),
    search: normalizeFilter(query?.search),
    sort,
    sortDir,
    cursor: parseIssueCursor(query?.cursor, sort, sortDir),
    limit: parseLimit(query?.limit),
  };
}

export function parsePublicIssueDetailQuery(query: PublicIssueDetailQuery | undefined): {
  hours: number,
  occurrence: OccurrenceCursor | null,
  direction: "older" | "newer",
} {
  const occurrence = parseOccurrenceCursor(query?.occurrence);
  const direction = parseDirection(query?.direction);
  if (occurrence === null && direction === "newer") {
    return badRequest("direction=newer requires an occurrence cursor");
  }
  return {
    hours: parseHours(query?.hours),
    occurrence,
    direction,
  };
}

export function parsePublicIssueOccurrencesQuery(query: PublicIssueOccurrencesQuery | undefined): {
  cursor: OccurrenceCursor | null,
  direction: "older" | "newer",
  limit: number,
} {
  return {
    cursor: parseOccurrenceCursor(query?.cursor),
    direction: parseDirection(query?.direction),
    limit: parseLimit(query?.limit),
  };
}

export function toPublicIssue(item: IssueListItem): PublicIssue {
  return {
    id: item.id,
    short_id: item.short_id,
    type: scrubPublicText(item.type),
    value: scrubPublicText(item.value),
    culprit: scrubPublicText(item.culprit),
    level: scrubPublicText(item.level),
    status: item.status,
    substatus: item.substatus,
    first_seen_at_millis: item.first_seen_at_millis,
    last_seen_at_millis: item.last_seen_at_millis,
    times_seen: item.times_seen,
    window_occurrences: item.window_occurrences,
    window_users: item.window_users,
    service_name: item.service_name === null ? null : scrubPublicText(item.service_name),
    environment: item.environment === null ? null : scrubPublicText(item.environment),
    release: item.release === null ? null : scrubPublicText(item.release),
    handled: item.handled,
    synthetic: item.synthetic,
    updated_at_millis: item.updated_at_millis,
  };
}
