import yup from "yup";
import { yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "../schema-fields";
import type { Json } from "../utils/json";


/** Stored lifecycle status. `substatus` below is derived, never stored. */
export const IssueStatusSchema = yupString().oneOf(["unresolved", "resolved", "ignored"]).defined();

/**
 * Upper bound for every millisecond-epoch timestamp a client may send on an
 * issue mutation (2100-01-01T00:00:00Z). Request validation must reject values
 * beyond it: an unbounded number reaches `new Date(...)` in the handlers, and
 * anything past ±8.64e15 produces an Invalid Date that only fails later, deep
 * inside a database write — a 500 for what is really malformed client input.
 */
export const MAX_ISSUE_TIMESTAMP_MILLIS = 4_102_444_800_000;

/**
 * Statuses accepted by the bounded bulk triage action. Keep this contract
 * beside the issue list/detail schemas so dashboard clients cannot silently
 * drift from the authenticated mutation route.
 */
export const IssueBulkStatusSchema = yupString().oneOf(["unresolved", "resolved", "ignored"]).defined();

const IssueBulkIdentifierSchema = yupString()
  .nonEmpty()
  .max(64)
  .defined()
  .test(
    "uuid-or-short-id",
    "issue_ids must contain only UUIDs or numeric short ids",
    (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      || (/^\d+$/.test(value) && value.length <= 19 && (value.length < 19 || value <= "9223372036854775807")),
  );

export const IssueBulkStatusRequestSchema = yupObject({
  status: IssueBulkStatusSchema,
  issue_ids: yupArray(IssueBulkIdentifierSchema).min(1).max(1_000).defined().test(
    "unique-issue-ids",
    "issue_ids must not contain duplicates",
    (value) => !Array.isArray(value) || new Set(value).size === value.length,
  ),
}).defined();

export const IssueBulkStatusResultSchema = yupObject({
  input_issue_id: yupString().defined(),
  action: yupString().oneOf(["resolve", "ignore", "unresolve"]).defined(),
  issue_id: yupString().uuid().nullable().defined(),
  redirected: yupBoolean().defined(),
  redirected_from_issue_id: yupString().uuid().nullable().defined(),
  changed: yupBoolean().defined(),
  changed_at_millis: yupNumber().integer().min(0).nullable().defined(),
  status: IssueBulkStatusSchema.nullable().defined(),
  transition_kind: yupString().oneOf([
    "status_changed",
    "status_unchanged",
    "regressed",
    "reopened",
    "occurrence_unchanged",
  ]).nullable().defined(),
  ignored_until_millis: yupNumber().integer().min(0).nullable().defined(),
  regressed_at_millis: yupNumber().integer().min(0).nullable().defined(),
  error: yupString().oneOf(["not_found"]).nullable().defined(),
}).defined();

export const IssueBulkStatusResponseSchema = yupObject({
  status: IssueBulkStatusSchema,
  results: yupArray(IssueBulkStatusResultSchema).defined(),
}).defined();

/**
 * Derived from timestamps at read time relative to the requested window, never
 * persisted: an issue that is "new" in a 24h window is "ongoing" in a 30d one.
 */
export const IssueSubstatusSchema = yupString().oneOf(["new", "ongoing", "regressed"]).defined();

export const IssueSymbolicationDiagnosticSchema = yupObject({
  code: yupString().defined(),
  message: yupString().defined(),
  debug_id: yupString().optional(),
  code_file: yupString().optional(),
  line: yupNumber().nullable().optional(),
  column: yupNumber().nullable().optional(),
  source: yupString().optional(),
}).defined();

export const IssueSourceContextSchema = yupObject({
  pre: yupArray(yupString().defined()).defined(),
  line: yupString().defined(),
  post: yupArray(yupString().defined()).defined(),
}).defined();

export const IssueFrameSymbolicationSchema = yupObject({
  status: yupString().oneOf(["symbolicated", "unsymbolicated", "not_attempted"]).defined(),
  source_file: yupString().nullable().defined(),
  original_line: yupNumber().nullable().defined(),
  original_column: yupNumber().nullable().defined(),
  name: yupString().nullable().defined(),
  context: IssueSourceContextSchema.nullable().defined(),
  diagnostics: yupArray(IssueSymbolicationDiagnosticSchema).defined(),
}).defined();

/**
 * A stack frame after server-side parsing. Every projected frame carries its
 * symbolication result (an unsymbolicated frame still gets a status object);
 * source context, when available, lives inside `symbolication.context`.
 */
export const IssueFrameSchema = yupObject({
  filename: yupString().nullable().defined(),
  function: yupString().nullable().defined(),
  module: yupString().nullable().defined(),
  abs_path: yupString().nullable().defined(),
  lineno: yupNumber().nullable().defined(),
  colno: yupNumber().nullable().defined(),
  in_app: yupBoolean().defined(),
  debug_id: yupString().optional(),
  symbolication: IssueFrameSymbolicationSchema.defined(),
}).defined();

/**
 * The grouping decision that produced one issue hash. These fields are kept
 * separate from the flat issue identity so an operator can tell which config,
 * role, variant, and fingerprint evidence was used during a transition.
 */
export const IssueGroupingFingerprintProvenanceSchema = yupObject({
  type: yupString().max(32).defined(),
  source: yupString().max(32).defined(),
  tokens: yupArray(yupString().max(256).defined()).max(32).defined(),
  resolved_tokens: yupArray(yupString().max(4_096).defined()).max(32).defined(),
}).defined();

export const IssueGroupingHashProvenanceSchema = yupObject({
  hash: yupString().max(128).defined(),
  role: yupString().oneOf(["primary", "secondary"]).defined(),
  config_id: yupString().max(128).defined(),
  variant: yupString().max(32).defined(),
  fingerprint: IssueGroupingFingerprintProvenanceSchema,
}).defined();

export type IssueGroupingHashProvenance = yup.InferType<typeof IssueGroupingHashProvenanceSchema>;

/**
 * Attachment metadata is safe to include in issue detail responses; the
 * bytes remain behind the authenticated attachment endpoint. Keeping this
 * shape in the shared contract makes the dashboard and backend agree on the
 * privacy boundary instead of passing an opaque storage record around.
 */
export const IssueAttachmentSchema = yupObject({
  id: yupString().uuid().defined(),
  event_id: yupString().length(32).defined(),
  occurrence_id: yupString().nullable().defined(),
  filename: yupString().defined(),
  content_type: yupString().defined(),
  attachment_type: yupString().defined(),
  byte_length: yupNumber().integer().min(1).defined(),
  sha256: yupString().length(64).defined(),
  download_path: yupString().defined(),
  created_at: yupString().defined(),
}).defined();

export const IssueOwnerSchema = yupObject({
  id: yupString().uuid().defined(),
  type: yupString().oneOf(["user", "team"]).defined(),
  user_id: yupString().uuid().nullable().defined(),
  team_id: yupString().uuid().nullable().defined(),
  source: yupString().defined(),
  context: yupMixed<Exclude<Json, null>>().nullable().defined(),
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

export const IssueActivityRecordSchema = yupObject({
  id: yupString().uuid().defined(),
  actor_user_id: yupString().uuid().nullable().defined(),
  type: yupString().defined(),
  idempotency_key: yupString().defined(),
  data: yupMixed<Exclude<Json, null>>().nullable().defined(),
  occurred_at: yupString().defined(),
  created_at: yupString().defined(),
}).defined();

export const IssueCommentSchema = yupObject({
  id: yupString().uuid().defined(),
  author_user_id: yupString().uuid().defined(),
  body: yupString().defined(),
  idempotency_key: yupString().defined(),
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

export const IssueSubjectSchema = yupObject({
  type: yupString().oneOf(["user", "team"]).defined(),
  id: yupString().uuid().defined(),
  is_active: yupBoolean().defined(),
  reason: yupString().nullable().defined(),
  created_at: yupString().defined(),
  updated_at: yupString().defined(),
}).defined();

export const IssueProductMetadataSchema = yupObject({
  priority: yupString().oneOf(["low", "medium", "high"]).nullable().defined(),
  assignee_user_id: yupString().uuid().nullable().defined(),
  team_id: yupString().uuid().nullable().defined(),
  owners: yupArray(IssueOwnerSchema).max(100).defined(),
  activities: yupArray(IssueActivityRecordSchema).max(100).defined(),
  comments: yupArray(IssueCommentSchema).max(100).defined(),
  subscriptions: yupArray(IssueSubjectSchema).max(100).defined(),
  bookmarked_user_ids: yupArray(yupString().uuid().defined()).max(100).defined(),
}).defined();

export const IssueReleaseCommitSchema = yupObject({
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

export const IssueReleaseDeploymentSchema = yupObject({
  id: yupString().defined(),
  release_id: yupString().defined(),
  deployment_key: yupString().defined(),
  environment: yupString().defined(),
  name: yupString().nullable().defined(),
  url: yupString().nullable().defined(),
  started_at: yupString().nullable().defined(),
  finished_at: yupString().defined(),
}).defined();

export const IssueReleaseSchema = yupObject({
  id: yupString().defined(),
  version: yupString().defined(),
  status: yupString().oneOf(["open", "archived"]).defined(),
  date_added: yupString().defined(),
  date_started: yupString().nullable().defined(),
  date_released: yupString().nullable().defined(),
  deployments: yupArray(IssueReleaseDeploymentSchema).max(20).defined(),
  commits: yupArray(IssueReleaseCommitSchema).max(50).defined(),
}).defined();

export const IssueSuspectCommitSchema = yupObject({
  owner_id: yupString().uuid().defined(),
  matched_by: yupString().oneOf(["release_commit_id", "commit_sha"]).defined(),
  strategy: yupString().nullable().defined(),
  commit: IssueReleaseCommitSchema,
}).defined();

export const IssueReleaseContextSchema = yupObject({
  first_release: IssueReleaseSchema.nullable().defined(),
  last_release: IssueReleaseSchema.nullable().defined(),
  release_commits: yupArray(IssueReleaseCommitSchema).max(100).defined(),
  suspect_commits: yupArray(IssueSuspectCommitSchema).max(20).defined(),
}).defined();

export const IssueListItemSchema = yupObject({
  id: yupString().defined(),
  /** Per-tenancy (project AND branch) monotonic counter, as a decimal string. */
  short_id: yupString().defined(),

  type: yupString().defined(),
  value: yupString().defined(),
  culprit: yupString().defined(),
  level: yupString().defined(),

  status: IssueStatusSchema,
  substatus: IssueSubstatusSchema,

  first_seen_at_millis: yupNumber().defined(),
  last_seen_at_millis: yupNumber().defined(),
  times_seen: yupString().defined(),
  /**
   * Non-null when an unmerge seeded this issue's lifetime counters from the
   * retained window rather than from true all-time data. The UI must render
   * "N events since <date>" instead of an all-time number it cannot back up.
   */
  counters_truncated_at_millis: yupNumber().nullable().defined(),

  window_occurrences: yupNumber().defined(),
  window_users: yupNumber().defined(),

  service_name: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  release: yupString().nullable().defined(),
  handled: yupBoolean().defined(),
  synthetic: yupBoolean().defined(),

  /**
   * Lets the dashboard reconcile an optimistic status override: the override is
   * dropped once the server returns a row newer than the one it was applied to.
   * A permanent override would mask a later automatic regression of the same
   * issue.
   */
  updated_at_millis: yupNumber().defined(),

  /**
   * Every hash this issue owns. The dashboard needs them to batch one sparkline
   * query for a whole page (`WHERE issue_hash IN (...)`) instead of one query
   * per row.
   */
  issue_hashes: yupArray(yupString().defined()).defined(),
}).defined();

export const IssueListResponseSchema = yupObject({
  items: yupArray(IssueListItemSchema).defined(),
  /** Opaque keyset cursor; `null` when there is no further page. */
  cursor: yupString().nullable().defined(),
  counts: yupObject({
    unresolved: yupNumber().defined(),
    resolved: yupNumber().defined(),
    ignored: yupNumber().defined(),
  }).defined(),
  /**
   * True when the candidate set exceeded `ISSUE_RANK_CANDIDATE_CAP` and the
   * ranking is therefore over a bounded subset. Surfaced in the UI rather than
   * silently truncated — "the top 1000 issues" and "a correct ranking over a
   * declared candidate set" are different claims and only one of them is honest.
   */
  approximate: yupBoolean().defined(),
}).defined();

/** One `$error` row, resolved for the detail view. */
export const IssueOccurrenceSchema = yupObject({
  occurrence_id: yupString().defined(),
  event_at_millis: yupNumber().defined(),
  message: yupString().defined(),
  level: yupString().defined(),
  /** The flat `$error` payload, minus the fields promoted to columns. */
  data: yupMixed().defined(),
  /** Bounded canonical ErrorEnvelope; null for historical rows written before the column existed. */
  error_envelope: yupMixed().nullable().defined(),
  /** Empty for historical ClickHouse rows written before grouping provenance existed. */
  grouping_provenance: yupArray(IssueGroupingHashProvenanceSchema).max(16).defined(),
  frames: yupArray(IssueFrameSchema).defined(),
  /** Raw stack, kept so the UI can degrade to it when parsing produced nothing. */
  raw_stack: yupString().nullable().defined(),
  symbolication_diagnostics: yupArray(IssueSymbolicationDiagnosticSchema).defined(),

  trace_id: yupString().nullable().defined(),
  span_id: yupString().nullable().defined(),
  page_view_span_id: yupString().nullable().defined(),
  session_replay_id: yupString().nullable().defined(),
  user_id: yupString().nullable().defined(),

  service_name: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  release: yupString().nullable().defined(),
  attachments: yupArray(IssueAttachmentSchema).max(100).defined(),
}).defined();

export const IssueDetailResponseSchema = yupObject({
  issue: IssueListItemSchema,
  /** `null` only when every occurrence has aged out past the telemetry TTL. */
  occurrence: IssueOccurrenceSchema.nullable().defined(),
  /** Keyset cursors for occurrence navigation, over `(event_at, occurrence_id)`. */
  newer_cursor: yupString().nullable().defined(),
  older_cursor: yupString().nullable().defined(),
  product: IssueProductMetadataSchema,
  release_context: IssueReleaseContextSchema,
  /**
   * Set when the requested id resolved through an `IssueRedirect` (i.e. the
   * issue was merged away). The dashboard rewrites the URL so the next copy
   * carries the surviving id.
   */
  redirected_from_issue_id: yupString().nullable().defined(),
}).defined();

export const IssueUpdateRequestSchema = yupObject({
  status: IssueStatusSchema,
  /**
   * Only meaningful with `status: "ignored"`. Null/absent means ignore forever.
   * An ignored issue whose snooze has expired wakes up on its next occurrence —
   * there is deliberately no cron for this, because an ignored issue that never
   * recurs *should* stay ignored.
   *
   * Bounded like the public snooze action's `ignored_until_millis`: the value
   * becomes a `Date` in the handler, so it must be rejected here rather than
   * surfacing as a database-write failure.
   */
  ignored_until_millis: yupNumber().integer().min(0).max(MAX_ISSUE_TIMESTAMP_MILLIS).nullable().optional(),
}).defined();

export const IssueMergeRequestSchema = yupObject({
  /**
   * Two or more issues to merge. The primary is chosen by
   * `(firstSeenAt asc, timesSeen desc, id asc)` — Sentry's rule — rather than
   * by the caller, so the outcome is deterministic and the oldest issue (which
   * carries the most history and the most inbound links) survives.
   *
   * UUIDs only (unlike the bulk-status route, which also takes short ids):
   * `mergeIssues` feeds these straight into `::uuid[]` casts, so a malformed
   * id must be rejected at the API boundary instead of becoming a Postgres
   * cast error (a 500 for what is really bad client input).
   */
  issue_ids: yupArray(yupString().uuid().defined()).min(2).defined(),
}).defined();

export const IssueUnmergeRequestSchema = yupObject({
  /**
   * Hashes to split out into a new issue. Must be a strict subset of the
   * source issue's owned hashes — splitting all of them is a no-op, and
   * splitting none is an error.
   */
  hashes: yupArray(yupString().defined()).min(1).defined(),
}).defined();

export const IssueMergeResponseSchema = yupObject({
  primary_issue_id: yupString().defined(),
  merged_issue_ids: yupArray(yupString().defined()).defined(),
}).defined();

export const IssueUnmergeResponseSchema = yupObject({
  source_issue_id: yupString().defined(),
  new_issue_id: yupString().defined(),
  /**
   * Echoes that the new issue's lifetime counters were seeded from the retained
   * window, because lifetime counts genuinely cannot be split — the rollup only
   * goes back 90 days.
   */
  counters_truncated_at_millis: yupNumber().defined(),
}).defined();

export type IssueStatus = yup.InferType<typeof IssueStatusSchema>;
export type IssueBulkStatus = yup.InferType<typeof IssueBulkStatusSchema>;
export type IssueBulkStatusRequest = yup.InferType<typeof IssueBulkStatusRequestSchema>;
export type IssueBulkStatusResult = yup.InferType<typeof IssueBulkStatusResultSchema>;
export type IssueBulkStatusResponse = yup.InferType<typeof IssueBulkStatusResponseSchema>;
export type IssueSubstatus = yup.InferType<typeof IssueSubstatusSchema>;
export type IssueSymbolicationDiagnostic = yup.InferType<typeof IssueSymbolicationDiagnosticSchema>;
export type IssueSourceContext = yup.InferType<typeof IssueSourceContextSchema>;
export type IssueFrameSymbolication = yup.InferType<typeof IssueFrameSymbolicationSchema>;
export type IssueFrame = yup.InferType<typeof IssueFrameSchema>;
export type IssueAttachment = yup.InferType<typeof IssueAttachmentSchema>;
export type IssueOwner = yup.InferType<typeof IssueOwnerSchema>;
export type IssueActivityRecord = yup.InferType<typeof IssueActivityRecordSchema>;
export type IssueComment = yup.InferType<typeof IssueCommentSchema>;
export type IssueSubject = yup.InferType<typeof IssueSubjectSchema>;
export type IssueProductMetadata = yup.InferType<typeof IssueProductMetadataSchema>;
export type IssueReleaseCommit = yup.InferType<typeof IssueReleaseCommitSchema>;
export type IssueReleaseDeployment = yup.InferType<typeof IssueReleaseDeploymentSchema>;
export type IssueRelease = yup.InferType<typeof IssueReleaseSchema>;
export type IssueSuspectCommit = yup.InferType<typeof IssueSuspectCommitSchema>;
export type IssueReleaseContext = yup.InferType<typeof IssueReleaseContextSchema>;
export type IssueListItem = yup.InferType<typeof IssueListItemSchema>;
export type IssueListResponse = yup.InferType<typeof IssueListResponseSchema>;
export type IssueOccurrence = yup.InferType<typeof IssueOccurrenceSchema>;
export type IssueDetailResponse = yup.InferType<typeof IssueDetailResponseSchema>;
export type IssueUpdateRequest = yup.InferType<typeof IssueUpdateRequestSchema>;
export type IssueMergeRequest = yup.InferType<typeof IssueMergeRequestSchema>;
export type IssueUnmergeRequest = yup.InferType<typeof IssueUnmergeRequestSchema>;
export type IssueMergeResponse = yup.InferType<typeof IssueMergeResponseSchema>;
export type IssueUnmergeResponse = yup.InferType<typeof IssueUnmergeResponseSchema>;

export const ISSUE_LIST_SORT_FIELDS = ["last_seen", "first_seen", "events", "users"] as const;
export type IssueListSortField = (typeof ISSUE_LIST_SORT_FIELDS)[number];

/**
 * `events` and `users` are window-scoped, so ClickHouse has to do the ranking;
 * the other two are lifetime and are served straight off a Postgres index.
 * This split is what decides which of the two query paths a request takes.
 */
export const CLICKHOUSE_RANKED_SORT_FIELDS: readonly IssueListSortField[] = ["events", "users"];

export const ISSUE_LIST_PAGE_SIZE = 50;

/**
 * Upper bound on how many status-filtered candidate issues we will hand to
 * ClickHouse for window-scoped ranking. Beyond this the response sets
 * `approximate: true`.
 *
 * The alternative — mirroring `Issue.status` into ClickHouse so the whole query
 * is one statement — removes the bound but creates a second source of truth for
 * a user-mutable field. A stale mirror showing a resolved issue as unresolved
 * is exactly the bug that makes people stop trusting an error tracker, so we
 * take the bound instead and say so out loud.
 */
export const ISSUE_RANK_CANDIDATE_CAP = 5000;
