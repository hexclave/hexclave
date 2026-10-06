import { getSharedClickhouseAdminClient, type ClickHouseClient } from "@/lib/clickhouse";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import {
  CLICKHOUSE_RANKED_SORT_FIELDS,
  ISSUE_LIST_PAGE_SIZE,
  ISSUE_RANK_CANDIDATE_CAP,
  ISSUE_LIST_SORT_FIELDS,
  type IssueListItem,
  type IssueListSortField,
  type IssueStatus,
  type IssueSubstatus,
} from "@hexclave/shared/dist/interface/admin-issues";
import { Prisma } from "@/generated/prisma/client";


export type IssueListFilters = {
  hours: number,
  status: IssueStatus | "all",
  serviceName: string | null,
  environment: string | null,
  handled: boolean | null,
  search: string | null,
  sort: IssueListSortField,
  sortDir: "asc" | "desc",
  cursor: string | null,
  limit: number,
};

type IssueRow = {
  id: string,
  shortId: bigint,
  type: string,
  value: string,
  culprit: string,
  platform: string,
  status: "UNRESOLVED" | "RESOLVED" | "IGNORED",
  firstSeenAt: Date,
  lastSeenAt: Date,
  regressedAt: Date | null,
  timesSeen: bigint,
  countersTruncatedAt: Date | null,
  ignoredUntil: Date | null,
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
  lastSeenRelease: string | null,
  updatedAt: Date,
  handled: boolean,
  synthetic: boolean,
  hashes: string[],
};

type WindowStats = {
  issueId: string,
  occurrences: number,
  users: number,
};

type CursorDirection = "asc" | "desc";

function isIssueListSortField(value: unknown): value is IssueListSortField {
  return ISSUE_LIST_SORT_FIELDS.some((field) => field === value);
}

function isCursorDirection(value: unknown): value is CursorDirection {
  return value === "asc" || value === "desc";
}

function isWindowRankedSort(value: IssueListSortField): value is Extract<IssueListSortField, "events" | "users"> {
  return CLICKHOUSE_RANKED_SORT_FIELDS.some((field) => field === value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function deriveSubstatus(
  row: { regressedAt: Date | null, firstSeenAt: Date },
  rangeStart: Date,
): IssueSubstatus {
  if (row.regressedAt !== null && row.regressedAt >= rangeStart) return "regressed";
  if (row.firstSeenAt >= rangeStart) return "new";
  return "ongoing";
}

export function effectiveStatus(row: Pick<IssueRow, "status">, ignoredUntil: Date | null, now: Date): IssueStatus {
  if (row.status === "IGNORED" && ignoredUntil !== null && ignoredUntil < now) return "unresolved";
  if (row.status === "RESOLVED") return "resolved";
  if (row.status === "IGNORED") return "ignored";
  return "unresolved";
}

export type IssueListCursor = {
  sortValueMillis: number,
  id: string,
  sort: IssueListSortField,
  sortDir: CursorDirection,
};

export function issueRangeStart(hours: number, now: Date): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export function rollupRangeStartSeconds(rangeStart: Date): number {
  return Math.floor(rangeStart.getTime() / 3_600_000) * 3600;
}

export function encodeIssueCursor(cursor: IssueListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeIssueCursor(
  raw: string,
  expected?: { sort: IssueListSortField, sortDir: CursorDirection },
): IssueListCursor | null {
  try {
    if (raw.length === 0) return null;
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isRecord(parsed)) return null;

    const { sortValueMillis, id, sort, sortDir } = parsed;
    if (
      typeof sortValueMillis !== "number"
      || !Number.isSafeInteger(sortValueMillis)
      || sortValueMillis < 0
      || sortValueMillis > 8_640_000_000_000_000
      || typeof id !== "string"
      || !isUuid(id)
    ) return null;
    if (!isIssueListSortField(sort)) return null;
    if (!isCursorDirection(sortDir)) return null;
    if (expected !== undefined && (sort !== expected.sort || sortDir !== expected.sortDir)) return null;

    return { sortValueMillis, id, sort, sortDir };
  } catch {
    return null;
  }
}

export function requireIssueListCursor(
  raw: string,
  expected: { sort: IssueListSortField, sortDir: CursorDirection },
): IssueListCursor {
  const cursor = decodeIssueCursor(raw, expected);
  if (cursor === null) {
    throw new StatusError(StatusError.BadRequest, "cursor is invalid or was created for a different sort order");
  }
  return cursor;
}

function handledFilterSql(handled: boolean | null): Prisma.Sql {
  if (handled === null) return Prisma.sql``;
  return Prisma.sql`AND i."handled" = ${handled}`;
}

function searchFilterSql(search: string | null): Prisma.Sql {
  if (search === null || search.trim() === "") return Prisma.sql``;
  return Prisma.sql`AND (i."type" ILIKE ${`%${search}%`} OR i."value" ILIKE ${`%${search}%`} OR i."culprit" ILIKE ${`%${search}%`})`;
}

function occurrenceHashFilterSql(matchingHashes: readonly string[] | null): Prisma.Sql {
  if (matchingHashes === null) return Prisma.sql``;
  if (matchingHashes.length === 0) return Prisma.sql`AND FALSE`;
  return Prisma.sql`AND EXISTS (
    SELECT 1
    FROM "IssueHash" h
    WHERE h."tenancyId" = i."tenancyId"
      AND h."issueId" = i."id"
      AND h."hash" = ANY(${matchingHashes}::text[])
  )`;
}

function statusFilterSql(status: IssueStatus | "all", now: Date): Prisma.Sql {
  if (status === "all") return Prisma.sql``;
  const lapsedSnooze = Prisma.sql`(i."status" = 'IGNORED' AND i."ignoredUntil" IS NOT NULL AND i."ignoredUntil" < ${now}::timestamptz)`;
  if (status === "unresolved") {
    return Prisma.sql`AND (i."status" = 'UNRESOLVED' OR ${lapsedSnooze})`;
  }
  if (status === "ignored") {
    return Prisma.sql`AND i."status" = 'IGNORED' AND NOT ${lapsedSnooze}`;
  }
  return Prisma.sql`AND i."status" = ${status.toUpperCase()}::"IssueStatus"`;
}

async function loadCandidateIssues(
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  tenancyId: string,
  filters: IssueListFilters,
  rangeStart: Date,
  now: Date,
  limit: number,
  matchingHashes: readonly string[] | null,
): Promise<IssueRow[]> {
  const rankedSort = isWindowRankedSort(filters.sort) ? filters.sort : null;
  const isWindowRanked = rankedSort !== null;
  const cursor = filters.cursor === null || isWindowRanked
    ? null
    : requireIssueListCursor(filters.cursor, { sort: filters.sort, sortDir: filters.sortDir });
  const cursorSql = cursor === null
    ? Prisma.sql``
    : filters.sortDir === "asc"
      ? Prisma.sql`AND (${filters.sort === "first_seen" ? Prisma.sql`i."firstSeenAt"` : Prisma.sql`i."lastSeenAt"`}, i."id") > (${new Date(cursor.sortValueMillis)}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.sql`AND (${filters.sort === "first_seen" ? Prisma.sql`i."firstSeenAt"` : Prisma.sql`i."lastSeenAt"`}, i."id") < (${new Date(cursor.sortValueMillis)}::timestamptz, ${cursor.id}::uuid)`;

  const sortColumn = filters.sort === "first_seen" ? Prisma.sql`i."firstSeenAt"` : Prisma.sql`i."lastSeenAt"`;
  const descending = filters.sortDir !== "asc";
  const orderSql = descending
    ? Prisma.sql`ORDER BY ${sortColumn} DESC, i."id" DESC`
    : Prisma.sql`ORDER BY ${sortColumn} ASC, i."id" ASC`;

  return await prisma.$replica().$queryRaw<IssueRow[]>(Prisma.sql`
    SELECT
      i."id", i."shortId", i."type", i."value", i."culprit", i."platform",
      i."status"::text AS "status", i."firstSeenAt", i."lastSeenAt", i."regressedAt",
      i."timesSeen", i."countersTruncatedAt", i."ignoredUntil",
      i."serviceName", i."deploymentEnvironmentName", i."lastSeenRelease", i."updatedAt",
      i."handled", i."synthetic",
      COALESCE(
        (SELECT array_agg(h."hash") FROM "IssueHash" h
         WHERE h."tenancyId" = i."tenancyId" AND h."issueId" = i."id"),
        ARRAY[]::text[]
      ) AS "hashes"
    FROM "Issue" i
    WHERE i."tenancyId" = ${tenancyId}::uuid
      AND i."lastSeenAt" >= ${rangeStart}::timestamptz
      ${statusFilterSql(filters.status, now)}
      ${handledFilterSql(filters.handled)}
      ${searchFilterSql(filters.search)}
      ${occurrenceHashFilterSql(matchingHashes)}
      ${cursorSql}
    ${orderSql}
    LIMIT ${limit}
  `);
}

async function loadMatchingHashes(
  clickhouse: ClickHouseClient,
  projectId: string,
  branchId: string,
  rangeStart: Date,
  filters: Pick<IssueListFilters, "serviceName" | "environment">,
): Promise<string[] | null> {
  if (filters.serviceName === null && filters.environment === null) return null;

  const serviceFilter = filters.serviceName === null ? "" : "AND service_name = {service:String}";
  const environmentFilter = filters.environment === null ? "" : "AND deployment_environment_name = {environment:String}";
  const resultSet = await clickhouse.query({
    query: `
      SELECT DISTINCT issue_hash AS issueHash
      FROM analytics_internal.issue_occurrence_rollup
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND bucket_start >= {rangeStart:DateTime}
        ${serviceFilter}
        ${environmentFilter}
    `,
    query_params: {
      projectId,
      branchId,
      rangeStart: rollupRangeStartSeconds(rangeStart),
      ...filters.serviceName === null ? {} : { service: filters.serviceName },
      ...filters.environment === null ? {} : { environment: filters.environment },
    },
    format: "JSONEachRow",
  });

  const rows = await resultSet.json<{ issueHash: string }>();
  return rows.map((row) => row.issueHash);
}

async function loadWindowStats(
  clickhouse: ClickHouseClient,
  projectId: string,
  branchId: string,
  issues: readonly Pick<IssueRow, "id" | "hashes">[],
  rangeStart: Date,
  filters: IssueListFilters,
): Promise<Map<string, WindowStats>> {
  const hashToIssue = issues.flatMap((issue) => issue.hashes.map((hash) => ({ hash, issueId: issue.id })));
  if (hashToIssue.length === 0) return new Map();

  const hashes = hashToIssue.map((entry) => entry.hash);
  const issueIds = hashToIssue.map((entry) => entry.issueId);

  const serviceFilter = filters.serviceName === null ? "" : "AND service_name = {service:String}";
  const environmentFilter = filters.environment === null ? "" : "AND deployment_environment_name = {environment:String}";

  const resultSet = await clickhouse.query({
    query: `
      WITH mapFromArrays({hashes:Array(String)}, {issueIds:Array(String)}) AS issue_by_hash
      SELECT
        issue_by_hash[issue_hash] AS issueId,
        toUInt64(sum(occurrences)) AS occurrences,
        toUInt64(uniqMerge(users_state)) AS users
      FROM analytics_internal.issue_occurrence_rollup
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND issue_hash IN {hashes:Array(String)}
        AND bucket_start >= {rangeStart:DateTime}
        ${serviceFilter}
        ${environmentFilter}
        AND issue_by_hash[issue_hash] != ''
      GROUP BY issueId
    `,
    query_params: {
      projectId,
      branchId,
      hashes,
      issueIds,
      rangeStart: rollupRangeStartSeconds(rangeStart),
      ...filters.serviceName === null ? {} : { service: filters.serviceName },
      ...filters.environment === null ? {} : { environment: filters.environment },
    },
    format: "JSONEachRow",
  });

  const rows = await resultSet.json<{ issueId: string, occurrences: string, users: string }>();
  return new Map(rows.map((row) => [row.issueId, {
    issueId: row.issueId,
    occurrences: Number(row.occurrences),
    users: Number(row.users),
  }]));
}

function toListItem(row: IssueRow, stats: Map<string, WindowStats>, rangeStart: Date, now: Date, ignoredUntil: Date | null): IssueListItem {
  const stat = stats.get(row.id);
  const occurrences = stat?.occurrences ?? 0;
  const users = stat?.users ?? 0;

  return {
    id: row.id,
    short_id: row.shortId.toString(),
    type: row.type,
    value: row.value,
    culprit: row.culprit,
    level: "error",
    status: effectiveStatus(row, ignoredUntil, now),
    substatus: deriveSubstatus(row, rangeStart),
    first_seen_at_millis: row.firstSeenAt.getTime(),
    last_seen_at_millis: row.lastSeenAt.getTime(),
    times_seen: row.timesSeen.toString(),
    counters_truncated_at_millis: row.countersTruncatedAt?.getTime() ?? null,
    window_occurrences: occurrences,
    window_users: users,
    service_name: row.serviceName,
    environment: row.deploymentEnvironmentName,
    release: row.lastSeenRelease,
    handled: row.handled,
    synthetic: row.synthetic,
    updated_at_millis: row.updatedAt.getTime(),
    issue_hashes: row.hashes,
  };
}

export async function loadIssueWindowStats(options: {
  tenancy: Tenancy,
  hashes: readonly string[],
  rangeStart: Date,
}): Promise<{ occurrences: number, users: number }> {
  const { tenancy, hashes, rangeStart } = options;
  if (hashes.length === 0) return { occurrences: 0, users: 0 };

  const resultSet = await getSharedClickhouseAdminClient().query({
    query: `
      SELECT toUInt64(sum(occurrences)) AS occurrences, toUInt64(uniqMerge(users_state)) AS users
      FROM analytics_internal.issue_occurrence_rollup
      WHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND issue_hash IN {hashes:Array(String)}
        AND bucket_start >= {rangeStart:DateTime}
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      hashes,
      rangeStart: rollupRangeStartSeconds(rangeStart),
    },
    format: "JSONEachRow",
  });
  const rows = await resultSet.json<{ occurrences: string, users: string }>();
  if (rows.length === 0) return { occurrences: 0, users: 0 };
  return { occurrences: Number(rows[0].occurrences), users: Number(rows[0].users) };
}

export type OccurrenceCursor = { eventAtMillis: number, occurrenceId: string };

export function encodeOccurrenceCursor(cursor: OccurrenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeOccurrenceCursor(raw: string): OccurrenceCursor | null {
  try {
    if (raw.length === 0) return null;
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isRecord(parsed)) return null;
    const { eventAtMillis, occurrenceId } = parsed;
    if (
      typeof eventAtMillis !== "number"
      || !Number.isSafeInteger(eventAtMillis)
      || eventAtMillis < 0
      || eventAtMillis > 8_640_000_000_000_000
      || typeof occurrenceId !== "string"
      || occurrenceId.length === 0
      || occurrenceId.length > 256
    ) return null;
    return { eventAtMillis, occurrenceId };
  } catch {
    return null;
  }
}

type OccurrenceRow = {
  occurrence_id: string,
  event_at: string,
  message: string,
  level: string,
  data: Record<string, Json>,
  error_envelope: string,
  issue_grouping_provenance: string,
  error_frames: string,
  trace_id: string | null,
  span_id: string | null,
  page_view_span_id: string | null,
  session_replay_id: string | null,
  session_replay_segment_id: string | null,
  user_id: string | null,
  service_name: string | null,
  deployment_environment_name: string | null,
};

export async function loadOccurrence(options: {
  tenancy: Tenancy,
  hashes: readonly string[],
  cursor: OccurrenceCursor | null,
  direction: "older" | "newer",
}): Promise<{ occurrence: OccurrenceRow | null, newerCursor: string | null, olderCursor: string | null }> {
  const { tenancy, hashes, cursor, direction } = options;
  if (hashes.length === 0) return { occurrence: null, newerCursor: null, olderCursor: null };

  const clickhouse = getSharedClickhouseAdminClient();
  const comparison = cursor === null
    ? ""
    : direction === "older"
      ? "AND (event_at, occurrence_id) < ({cursorAt:DateTime64(3)}, {cursorId:String})"
      : "AND (event_at, occurrence_id) > ({cursorAt:DateTime64(3)}, {cursorId:String})";
  const order = direction === "older" ? "DESC" : "ASC";

  const resultSet = await clickhouse.query({
    query: `
      SELECT occurrence_id, event_at, message, level, data, error_envelope,
             issue_grouping_provenance, error_frames,
             trace_id, span_id, page_view_span_id, session_replay_id, session_replay_segment_id, user_id,
             service_name, deployment_environment_name
      FROM analytics_internal.events
      PREWHERE project_id = {projectId:String}
        AND branch_id = {branchId:String}
        AND event_type = '$error'
        ${comparison}
      WHERE issue_hash IN {hashes:Array(String)}
      ORDER BY event_at ${order}, occurrence_id ${order}
      LIMIT 2
    `,
    query_params: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      hashes,
      ...cursor === null ? {} : {
        cursorAt: new Date(cursor.eventAtMillis).toISOString().replace("T", " ").replace("Z", ""),
        cursorId: cursor.occurrenceId,
      },
    },
    format: "JSONEachRow",
  });

  const rows = await resultSet.json<OccurrenceRow>();
  if (rows.length === 0) return { occurrence: null, newerCursor: null, olderCursor: null };
  const occurrence = rows[0];

  const eventAtMillis = new Date(`${occurrence.event_at}Z`).getTime();
  if (!Number.isSafeInteger(eventAtMillis) || eventAtMillis < 0) {
    throw new Error(`ClickHouse returned an invalid issue occurrence timestamp: ${occurrence.event_at}`);
  }
  const position = { eventAtMillis, occurrenceId: occurrence.occurrence_id };
  const hasAnotherInDirection = rows.length > 1;
  const positionCursor = encodeOccurrenceCursor(position);
  return {
    occurrence,
    newerCursor: direction === "newer"
      ? hasAnotherInDirection ? positionCursor : null
      : cursor === null ? null : positionCursor,
    olderCursor: direction === "older"
      ? hasAnotherInDirection ? positionCursor : null
      : cursor === null ? null : positionCursor,
  };
}

export function compareRankedIssues(
  left: Pick<IssueListItem, "window_occurrences" | "window_users" | "last_seen_at_millis" | "id">,
  right: Pick<IssueListItem, "window_occurrences" | "window_users" | "last_seen_at_millis" | "id">,
  sort: Extract<IssueListSortField, "events" | "users">,
  sortDir: CursorDirection,
): number {
  const leftMetric = sort === "events" ? left.window_occurrences : left.window_users;
  const rightMetric = sort === "events" ? right.window_occurrences : right.window_users;
  const direction = sortDir === "desc" ? -1 : 1;
  const metricComparison = leftMetric === rightMetric ? 0 : leftMetric < rightMetric ? -1 : 1;
  if (metricComparison !== 0) return metricComparison * direction;

  const timeComparison = left.last_seen_at_millis === right.last_seen_at_millis
    ? 0
    : left.last_seen_at_millis < right.last_seen_at_millis ? -1 : 1;
  if (timeComparison !== 0) return timeComparison * direction;
  return stringCompare(left.id, right.id) * direction;
}

export async function listIssues(options: {
  tenancy: Tenancy,
  filters: IssueListFilters,
}): Promise<{ items: IssueListItem[], cursor: string | null, counts: { unresolved: number, resolved: number, ignored: number }, approximate: boolean }> {
  const { tenancy, filters } = options;
  const prisma = await getPrismaClientForTenancy(tenancy);
  const clickhouse = getSharedClickhouseAdminClient();
  const now = new Date();
  const rangeStart = new Date(now.getTime() - filters.hours * 60 * 60 * 1000);
  const limit = Math.min(filters.limit, ISSUE_LIST_PAGE_SIZE);

  const rankedSort = isWindowRankedSort(filters.sort) ? filters.sort : null;
  const isWindowRanked = rankedSort !== null;
  const matchingHashes = await loadMatchingHashes(clickhouse, tenancy.project.id, tenancy.branchId, rangeStart, filters);

  const candidateLimit = isWindowRanked ? ISSUE_RANK_CANDIDATE_CAP : limit + 1;
  const candidates = await loadCandidateIssues(prisma, tenancy.id, filters, rangeStart, now, candidateLimit, matchingHashes);
  const approximate = isWindowRanked && candidates.length >= ISSUE_RANK_CANDIDATE_CAP;

  const stats = await loadWindowStats(clickhouse, tenancy.project.id, tenancy.branchId, candidates, rangeStart, filters);

  const counts = await prisma.$replica().$queryRaw<{ status: string, count: bigint }[]>(Prisma.sql`
    SELECT
      CASE
        WHEN i."status" = 'IGNORED' AND i."ignoredUntil" IS NOT NULL AND i."ignoredUntil" < ${now}::timestamptz
          THEN 'UNRESOLVED'
        ELSE i."status"::text
      END AS "status",
      count(*) AS "count"
    FROM "Issue" i
    WHERE i."tenancyId" = ${tenancy.id}::uuid AND i."lastSeenAt" >= ${rangeStart}::timestamptz
      ${handledFilterSql(filters.handled)}
      ${searchFilterSql(filters.search)}
      ${occurrenceHashFilterSql(matchingHashes)}
    GROUP BY 1
  `);
  const countByStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));

  let items = candidates.map((row) => toListItem(
    row,
    stats,
    rangeStart,
    now,
    row.ignoredUntil,
  ));

  if (isWindowRanked) {
    items.sort((left, right) => compareRankedIssues(left, right, rankedSort, filters.sortDir));
    items = items.slice(0, limit);
  }

  const hasMore = !isWindowRanked && items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const last = page.at(-1);

  return {
    items: page,
    cursor: hasMore && last !== undefined
      ? encodeIssueCursor({
        sortValueMillis: filters.sort === "first_seen" ? last.first_seen_at_millis : last.last_seen_at_millis,
        id: last.id,
        sort: filters.sort,
        sortDir: filters.sortDir,
      })
      : null,
    counts: {
      unresolved: countByStatus.get("UNRESOLVED") ?? 0,
      resolved: countByStatus.get("RESOLVED") ?? 0,
      ignored: countByStatus.get("IGNORED") ?? 0,
    },
    approximate,
  };
}
