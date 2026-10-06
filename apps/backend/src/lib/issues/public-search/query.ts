import { getSharedClickhouseAdminClient, type ClickHouseClient } from "@/lib/clickhouse";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { Prisma } from "@/generated/prisma/client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { issueRangeStart } from "@/lib/issues/issue-queries";
import {
  PUBLIC_SEARCH_ATTACHMENT_EVENT_MATCH_CAP,
  PUBLIC_SEARCH_ATTACHMENT_METADATA_PER_EVENT_CAP,
  PUBLIC_SEARCH_FACET_COUNT_CAP,
  PUBLIC_SEARCH_HASH_MATCH_CAP,
  hasPublicSearchAttachmentFilter,
  type PublicSearchAttachment,
  type PublicSearchFilters,
  type PublicSearchFacets,
  type PublicSearchRecord,
  type PublicSearchResponse,
} from "./contract";
import {
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  type PublicSearchCursorPosition,
} from "./cursor";
import {
  toPublicSearchIssue,
  toPublicSearchFacets,
  publicSearchAttachmentEventId,
  toPublicSearchAttachmentMetadata,
  toPublicSearchOccurrence,
  type PublicSearchFacetRow,
  type PublicSearchIssueRow,
  type PublicSearchOccurrenceRow,
} from "./projection";

type ClickHouseSearchClient = Pick<ClickHouseClient, "query">;
type SearchPrismaClient = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;
type ClickHouseParameter = string | number | string[];
type PublicSearchRawQuery = <T>(query: Prisma.Sql) => Promise<T>;

function createPublicSearchRawQuery(prisma: SearchPrismaClient): PublicSearchRawQuery {
  return async <T>(query: Prisma.Sql): Promise<T> => await prisma.$replica().$queryRaw<T>(query);
}

export type PublicSearchPlanTenancy = {
  project: { id: string },
  branchId: string,
};

export type PublicSearchTenancy = PublicSearchPlanTenancy & {
  id: string,
};

export type PublicSearchClickHousePlan = {
  query: string,
  query_params: Record<string, ClickHouseParameter>,
  format: "JSONEachRow",
};

export type PublicSearchDependencies = {
  clickhouse?: ClickHouseSearchClient,
  prisma?: SearchPrismaClient,
  now?: Date,
  cursorSecret?: string,
};

function badRequest(message: string): never {
  throw new StatusError(StatusError.BadRequest, message);
}

function isOccurrenceFilter(filters: PublicSearchFilters): boolean {
  return filters.eventId !== null
    || filters.tagKey !== null
    || filters.release !== null
    || filters.environment !== null
    || filters.service !== null
    || filters.level !== null
    || filters.userId !== null
    || filters.contextKey !== null
    || filters.propertyKey !== null
    || hasPublicSearchAttachmentFilter(filters)
    || (filters.handled !== null && filters.record !== "issue")
    || (filters.issueHash !== null && filters.message !== null);
}

type PublicSearchAttachmentRow = {
  eventId: string,
  id: string,
  occurrenceId: string | null,
  filename: string,
  contentType: string,
  attachmentType: string,
  byteLength: number,
  sha256: string,
};

function attachmentFilterSql(filters: PublicSearchFilters): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [];
  if (filters.attachmentFilename !== null) {
    clauses.push(Prisma.sql`AND strpos(lower("filename"), lower(${filters.attachmentFilename})) > 0`);
  }
  if (filters.attachmentContentType !== null) {
    clauses.push(Prisma.sql`AND lower("contentType") = lower(${filters.attachmentContentType})`);
  }
  if (filters.attachmentType !== null) {
    clauses.push(Prisma.sql`AND "attachmentType" = ${filters.attachmentType}`);
  }
  return clauses;
}

export async function loadPublicSearchAttachmentEventIds(options: {
  query: PublicSearchRawQuery,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
}): Promise<string[]> {
  if (!hasPublicSearchAttachmentFilter(options.filters)) return [];
  const rows = await options.query<Array<{ eventId: string }>>(buildPublicSearchAttachmentEventIdsQuery({
    tenancy: options.tenancy,
    filters: options.filters,
  }));
  if (rows.length > PUBLIC_SEARCH_ATTACHMENT_EVENT_MATCH_CAP) {
    throw new StatusError(
      StatusError.BadRequest,
      `attachment search matched more than ${PUBLIC_SEARCH_ATTACHMENT_EVENT_MATCH_CAP} events; add a narrower filter`,
    );
  }
  return rows.map((row) => {
    if (!/^[0-9a-f]{32}$/.test(row.eventId)) throw new Error("Postgres returned an invalid attachment event id for public search");
    return row.eventId;
  });
}

export function buildPublicSearchAttachmentEventIdsQuery(options: {
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
}): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT "eventId" AS "eventId"
    FROM "ErrorAttachment"
    WHERE "tenancyId" = ${options.tenancy.id}::uuid
      AND "projectId" = ${options.tenancy.project.id}
      AND "branchId" = ${options.tenancy.branchId}
      ${Prisma.join(attachmentFilterSql(options.filters), "\n      ")}
    ORDER BY "eventId" ASC
    LIMIT ${PUBLIC_SEARCH_ATTACHMENT_EVENT_MATCH_CAP + 1}
  `;
}

async function loadPublicSearchAttachmentMetadata(options: {
  query: PublicSearchRawQuery,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  eventIds: readonly string[],
}): Promise<Map<string, PublicSearchAttachment[]>> {
  const uniqueEventIds = [...new Set(options.eventIds)];
  const attachmentsByEvent = new Map<string, PublicSearchAttachment[]>(uniqueEventIds.map((eventId) => [eventId, []]));
  if (uniqueEventIds.length === 0) return attachmentsByEvent;

  const rows = await options.query<PublicSearchAttachmentRow[]>(Prisma.sql`
    SELECT "eventId", "id", "occurrenceId", "filename", "contentType", "attachmentType", "byteLength", "sha256"
    FROM (
      SELECT
        "eventId", "id", "occurrenceId", "filename", "contentType", "attachmentType", "byteLength", "sha256",
        row_number() OVER (PARTITION BY "eventId" ORDER BY "createdAt" DESC, "id" DESC) AS "rowNumber"
      FROM "ErrorAttachment"
      WHERE "tenancyId" = ${options.tenancy.id}::uuid
        AND "projectId" = ${options.tenancy.project.id}
        AND "branchId" = ${options.tenancy.branchId}
        AND "eventId" IN (${Prisma.join(uniqueEventIds)})
        ${Prisma.join(attachmentFilterSql(options.filters), "\n        ")}
    ) AS scoped_attachments
    WHERE "rowNumber" <= ${PUBLIC_SEARCH_ATTACHMENT_METADATA_PER_EVENT_CAP}
    ORDER BY "eventId" ASC, "rowNumber" ASC
    LIMIT ${uniqueEventIds.length * PUBLIC_SEARCH_ATTACHMENT_METADATA_PER_EVENT_CAP}
  `);
  for (const row of rows) {
    const attachments = attachmentsByEvent.get(row.eventId);
    if (attachments === undefined || attachments.length >= PUBLIC_SEARCH_ATTACHMENT_METADATA_PER_EVENT_CAP) continue;
    const attachment = toPublicSearchAttachmentMetadata({
      id: row.id,
      filename: row.filename,
      content_type: row.contentType,
      size: row.byteLength,
      checksum: row.sha256,
      attachment_type: row.attachmentType,
    });
    if (attachment !== null) attachments.push(attachment);
  }
  return attachmentsByEvent;
}

function errorEnvelopeFieldExpression(field: "event_id" | "release" | "environment"): string {
  return `JSONExtractString(error_envelope, '${field}')`;
}

function searchMessageExpression(): string {
  const envelopeMessage = "JSONExtractString(error_envelope, 'message')";
  return `if(${envelopeMessage} != '', ${envelopeMessage}, body)`;
}

function searchTagExpression(keyParameter = "tagKey"): string {
  return `JSONExtractString(JSONExtractRaw(error_envelope, 'tags'), {${keyParameter}:String})`;
}

function searchServiceExpression(): string {
  return "if(service_name != '', service_name, JSONExtractString(JSONExtractRaw(error_envelope, 'runtime'), 'service_name'))";
}

function searchEnvironmentExpression(): string {
  return `if(deployment_environment_name != '', deployment_environment_name, ${errorEnvelopeFieldExpression("environment")})`;
}

function searchLevelExpression(): string {
  return `if(JSONExtractString(error_envelope, 'level') != '', JSONExtractString(error_envelope, 'level'), level)`;
}

function searchHandledExpression(): string {
  const envelope = "JSONExtractRaw(error_envelope, 'handled')";
  return `if(${envelope} = 'true', 1, if(${envelope} = 'false', 0, -1))`;
}

function searchUserExpression(field: "id" | "email" | "username"): string {
  return `JSONExtractString(JSONExtractRaw(error_envelope, 'user'), '${field}')`;
}

function searchObjectStringExpression(container: "contexts" | "extra", keyParameter: string): string {
  return `JSONExtractString(JSONExtractRaw(error_envelope, '${container}'), {${keyParameter}:String})`;
}

function facetExpression(facet: string, keyParameter: string): string {
  if (facet === "level") return searchLevelExpression();
  if (facet === "service") return searchServiceExpression();
  if (facet === "environment") return searchEnvironmentExpression();
  if (facet === "release") return errorEnvelopeFieldExpression("release");
  if (facet.startsWith("tag:")) return searchTagExpression(keyParameter);
  if (facet.startsWith("context:")) return searchObjectStringExpression("contexts", keyParameter);
  if (facet.startsWith("property:")) return searchObjectStringExpression("extra", keyParameter);
  throw new Error(`Unsupported public search facet: ${facet}`);
}

type OccurrenceFilterClauses = {
  prewhere: string[],
  where: string[],
};

function buildOccurrenceWhere(
  filters: PublicSearchFilters,
  params: Record<string, ClickHouseParameter>,
  projectId: string,
  branchId: string,
  rangeStart: Date,
  rangeEnd: Date,
  attachmentEventIds: readonly string[] | undefined,
): OccurrenceFilterClauses {
  params.projectId = projectId;
  params.branchId = branchId;
  params.rangeStart = Math.floor(rangeStart.getTime() / 1000);
  params.rangeEnd = Math.floor(rangeEnd.getTime() / 1000);
  const prewhere = [
    "project_id = {projectId:String}",
    "branch_id = {branchId:String}",
    "event_type = '$error'",
    "event_at >= {rangeStart:DateTime}",
    "event_at <= {rangeEnd:DateTime}",
  ];
  const where = [
    "issue_hash != ''",
  ];

  if (filters.issueHash !== null) {
    params.issueHash = filters.issueHash;
    where.push("issue_hash = {issueHash:String}");
  }
  if (filters.eventId !== null) {
    params.eventId = filters.eventId;
    where.push(`${errorEnvelopeFieldExpression("event_id")} = {eventId:String}`);
  }
  if (filters.tagKey !== null && filters.tagValue !== null) {
    params.tagKey = filters.tagKey;
    params.tagValue = filters.tagValue;
    where.push(`${searchTagExpression()} = {tagValue:String}`);
  }
  if (filters.message !== null) {
    where.push(`${searchMessageExpression()} ILIKE {messagePattern:String}`);
    params.messagePattern = `%${filters.message}%`;
  }
  if (filters.release !== null) {
    params.release = filters.release;
    where.push(`${errorEnvelopeFieldExpression("release")} = {release:String}`);
  }
  if (filters.environment !== null) {
    params.environment = filters.environment;
    where.push(`(deployment_environment_name = {environment:String} OR ${errorEnvelopeFieldExpression("environment")} = {environment:String})`);
  }
  if (filters.service !== null) {
    params.service = filters.service;
    where.push(`${searchServiceExpression()} = {service:String}`);
  }
  if (filters.level !== null) {
    params.level = filters.level;
    where.push(`${searchLevelExpression()} = {level:String}`);
  }
  if (filters.handled !== null && filters.record !== "issue") {
    params.handled = filters.handled ? 1 : 0;
    where.push(`${searchHandledExpression()} = {handled:UInt8}`);
  }
  if (filters.userId !== null) {
    params.userId = filters.userId;
    where.push(`${searchUserExpression("id")} = {userId:String}`);
  }
  if (filters.contextKey !== null && filters.contextValue !== null) {
    params.contextKey = filters.contextKey;
    params.contextValue = filters.contextValue;
    where.push(`${searchObjectStringExpression("contexts", "contextKey")} = {contextValue:String}`);
  }
  if (filters.propertyKey !== null && filters.propertyValue !== null) {
    params.propertyKey = filters.propertyKey;
    params.propertyValue = filters.propertyValue;
    where.push(`${searchObjectStringExpression("extra", "propertyKey")} = {propertyValue:String}`);
  }
  if (hasPublicSearchAttachmentFilter(filters)) {
    if (attachmentEventIds === undefined) throw new Error("Attachment-filtered public search requires scoped attachment event ids");
    params.attachmentEventIds = [...attachmentEventIds];
    where.push(`(${errorEnvelopeFieldExpression("event_id")} IN {attachmentEventIds:Array(String)} OR occurrence_id IN {attachmentEventIds:Array(String)})`);
  }
  return { prewhere, where };
}

function occurrenceSelect(): string {
  return `
      SELECT occurrence_id, event_at, body, level, data, error_envelope, error_frames,
             service_name, deployment_environment_name, issue_hash
      FROM analytics_internal.events`;
}

function occurrenceFilterSql(clauses: OccurrenceFilterClauses): string {
  return `PREWHERE ${clauses.prewhere.join("\n        AND ")}\n      WHERE ${clauses.where.join("\n        AND ")}`;
}

export function buildPublicSearchOccurrencePlan(options: {
  tenancy: PublicSearchPlanTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  cursor: PublicSearchCursorPosition | null,
  attachmentEventIds?: readonly string[],
}): PublicSearchClickHousePlan {
  const params: Record<string, ClickHouseParameter> = {
    resultLimit: options.filters.limit + 1,
  };
  const clauses = buildOccurrenceWhere(
    options.filters,
    params,
    options.tenancy.project.id,
    options.tenancy.branchId,
    options.rangeStart,
    options.rangeEnd,
    options.attachmentEventIds,
  );
  if (options.filters.record === "event") clauses.where.push(`${errorEnvelopeFieldExpression("event_id")} != ''`);

  let cursorSql = "";
  if (options.cursor !== null) {
    if (options.cursor.kind !== "occurrence") throw new Error("An issue cursor cannot be used for an occurrence query");
    params.cursorAt = new Date(options.cursor.eventAtMillis).toISOString().replace("T", " ").replace("Z", "");
    params.cursorId = options.cursor.occurrenceId;
    cursorSql = "AND (event_at, occurrence_id) < ({cursorAt:DateTime64(3)}, {cursorId:String})";
  }

  return {
    query: `${occurrenceSelect()}
      ${occurrenceFilterSql(clauses)}
        ${cursorSql}
      ORDER BY event_at DESC, occurrence_id DESC
      LIMIT {resultLimit:UInt32}`,
    query_params: params,
    format: "JSONEachRow",
  };
}

function dynamicFacetKey(facet: string): string | null {
  if (facet.startsWith("tag:") || facet.startsWith("context:") || facet.startsWith("property:")) {
    return facet.slice(facet.indexOf(":") + 1);
  }
  return null;
}

export function buildPublicSearchFacetPlan(options: {
  tenancy: PublicSearchPlanTenancy,
  filters: PublicSearchFilters,
  facet: string,
  rangeStart: Date,
  rangeEnd: Date,
  attachmentEventIds?: readonly string[],
}): PublicSearchClickHousePlan {
  const params: Record<string, ClickHouseParameter> = {
    facetName: options.facet,
    facetLimit: PUBLIC_SEARCH_FACET_COUNT_CAP,
  };
  const facetKey = dynamicFacetKey(options.facet);
  if (facetKey !== null) params.facetKey = facetKey;
  const clauses = buildOccurrenceWhere(
    options.filters,
    params,
    options.tenancy.project.id,
    options.tenancy.branchId,
    options.rangeStart,
    options.rangeEnd,
    options.attachmentEventIds,
  );
  if (options.filters.record === "event") clauses.where.push(`${errorEnvelopeFieldExpression("event_id")} != ''`);
  const expression = facetExpression(options.facet, "facetKey");
  return {
    query: `
      SELECT {facetName:String} AS facet_key, ${expression} AS facet_value, toUInt64(count()) AS count
      FROM analytics_internal.events
      ${occurrenceFilterSql(clauses)}
        AND ${expression} != ''
      GROUP BY facet_value
      ORDER BY count DESC, facet_value ASC
      LIMIT {facetLimit:UInt32}`,
    query_params: params,
    format: "JSONEachRow",
  };
}

export function buildPublicSearchIssueHashPlan(options: {
  tenancy: PublicSearchPlanTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  attachmentEventIds?: readonly string[],
}): PublicSearchClickHousePlan {
  const params: Record<string, ClickHouseParameter> = {
    resultLimit: PUBLIC_SEARCH_HASH_MATCH_CAP + 1,
  };
  const clauses = buildOccurrenceWhere(
    options.filters,
    params,
    options.tenancy.project.id,
    options.tenancy.branchId,
    options.rangeStart,
    options.rangeEnd,
    options.attachmentEventIds,
  );
  return {
    query: `
      SELECT DISTINCT issue_hash AS issueHash
      FROM analytics_internal.events
      ${occurrenceFilterSql(clauses)}
      LIMIT {resultLimit:UInt32}`,
    query_params: params,
    format: "JSONEachRow",
  };
}

function resolveCursor(
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  secret: string | undefined,
): PublicSearchCursorPosition | null {
  if (filters.cursor === null) return null;
  const cursor = decodePublicSearchCursor(filters.cursor, {
    projectId: tenancy.project.id,
    branchId: tenancy.branchId,
    filters,
  }, secret);
  if (cursor === null) return badRequest("cursor is invalid or does not match this project, branch, record, or filter set");
  return cursor;
}

function issueMessageSql(filters: PublicSearchFilters, useClickHouse: boolean): Prisma.Sql {
  if (useClickHouse || filters.message === null) return Prisma.sql``;
  const pattern = `%${filters.message}%`;
  return Prisma.sql`AND (
    i."type" ILIKE ${pattern}
    OR i."value" ILIKE ${pattern}
    OR i."culprit" ILIKE ${pattern}
  )`;
}

function issueStatusSql(filters: PublicSearchFilters, now: Date): Prisma.Sql {
  if (filters.status === null) return Prisma.sql``;
  if (filters.status === "resolved") return Prisma.sql`AND i."status"::text = 'RESOLVED'`;
  if (filters.status === "ignored") return Prisma.sql`AND i."status"::text = 'IGNORED' AND (i."ignoredUntil" IS NULL OR i."ignoredUntil" >= ${now}::timestamptz)`;
  return Prisma.sql`AND (i."status"::text = 'UNRESOLVED' OR (i."status"::text = 'IGNORED' AND i."ignoredUntil" < ${now}::timestamptz))`;
}

function issueHandledSql(filters: PublicSearchFilters): Prisma.Sql {
  if (filters.handled === null) return Prisma.sql``;
  return Prisma.sql`AND i."handled" = ${filters.handled}`;
}

function issueHashSql(matchingHashes: readonly string[] | null): Prisma.Sql {
  if (matchingHashes === null) return Prisma.sql``;
  if (matchingHashes.length === 0) return Prisma.sql`AND FALSE`;
  return Prisma.sql`AND EXISTS (
    SELECT 1
    FROM "IssueHash" h
    WHERE h."tenancyId" = i."tenancyId"
      AND h."issueId" = i."id"
      AND h."hash" = ANY(${[...matchingHashes]}::text[])
  )`;
}

async function loadMatchingHashes(options: {
  clickhouse: ClickHouseSearchClient,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  attachmentEventIds?: readonly string[],
}): Promise<string[]> {
  const resultSet = await options.clickhouse.query(buildPublicSearchIssueHashPlan({
    tenancy: options.tenancy,
    filters: options.filters,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    attachmentEventIds: options.attachmentEventIds,
  }));
  const rows = await resultSet.json<{ issueHash: string }>();
  if (rows.length > PUBLIC_SEARCH_HASH_MATCH_CAP) {
    throw new StatusError(StatusError.BadRequest, `search matched more than ${PUBLIC_SEARCH_HASH_MATCH_CAP} issue hashes; add a narrower filter`);
  }
  return rows.map((row) => {
    if (!/^[0-9a-f]{32}$/.test(row.issueHash)) throw new Error("ClickHouse returned an invalid issue hash for public search");
    return row.issueHash;
  });
}

async function loadIssueRows(options: {
  prisma: SearchPrismaClient,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  cursor: PublicSearchCursorPosition | null,
  matchingHashes: readonly string[] | null,
  useClickHouse: boolean,
  now: Date,
}): Promise<PublicSearchIssueRow[]> {
  const cursorSql = options.cursor === null
    ? Prisma.sql``
    : options.cursor.kind !== "issue"
      ? (() => { throw new Error("An occurrence cursor cannot be used for an issue query"); })()
      : Prisma.sql`AND (i."lastSeenAt", i."id") < (${new Date(options.cursor.lastSeenAtMillis)}::timestamptz, ${options.cursor.issueId}::uuid)`;

  return await options.prisma.$replica().$queryRaw<PublicSearchIssueRow[]>(Prisma.sql`
    SELECT
      i."id", i."shortId", i."type", i."value", i."culprit",
      i."status"::text AS "status", i."ignoredUntil", i."firstSeenAt", i."lastSeenAt",
      i."timesSeen", i."serviceName", i."deploymentEnvironmentName", i."lastSeenRelease",
      i."handled", i."synthetic", i."updatedAt"
    FROM "Issue" i
    WHERE i."tenancyId" = ${options.tenancy.id}::uuid
      AND i."lastSeenAt" >= ${options.rangeStart}::timestamptz
      AND i."lastSeenAt" <= ${options.rangeEnd}::timestamptz
      ${issueHashSql(options.matchingHashes)}
      ${issueMessageSql(options.filters, options.useClickHouse)}
      ${issueStatusSql(options.filters, options.now)}
      ${issueHandledSql(options.filters)}
      ${cursorSql}
    ORDER BY i."lastSeenAt" DESC, i."id" DESC
    LIMIT ${options.filters.limit + 1}
  `);
}

function pageRecords(
  rows: PublicSearchRecord[],
  limit: number,
): { items: PublicSearchRecord[], hasMore: boolean } {
  return {
    items: rows.slice(0, limit),
    hasMore: rows.length > limit,
  };
}

export function pagePublicSearchRecords(
  rows: PublicSearchRecord[],
  limit: number,
): { items: PublicSearchRecord[], hasMore: boolean } {
  return pageRecords(rows, limit);
}

async function searchOccurrences(options: {
  clickhouse?: ClickHouseSearchClient,
  prisma?: SearchPrismaClient,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  cursor: PublicSearchCursorPosition | null,
  cursorSecret: string | undefined,
  attachmentEventIds: readonly string[] | null,
}): Promise<PublicSearchResponse> {
  const clickhouse = options.clickhouse ?? getSharedClickhouseAdminClient();
  const resultSet = await clickhouse.query(buildPublicSearchOccurrencePlan({
    tenancy: options.tenancy,
    filters: options.filters,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    cursor: options.cursor,
    attachmentEventIds: options.attachmentEventIds ?? undefined,
  }));
  const rows = await resultSet.json<PublicSearchOccurrenceRow>();
  const pageRows = rows.slice(0, options.filters.limit);
  const pageAttachmentEventIds = [...new Set(pageRows.map(publicSearchAttachmentEventId))];
  const attachmentsByEvent = hasPublicSearchAttachmentFilter(options.filters)
    ? await loadPublicSearchAttachmentMetadata({
      query: createPublicSearchRawQuery(options.prisma ?? throwMissingAttachmentSearchPrisma()),
      tenancy: options.tenancy,
      filters: options.filters,
      eventIds: pageAttachmentEventIds,
    })
    : new Map<string, PublicSearchAttachment[]>();
  const page = {
    items: pageRows.map((row) => toPublicSearchOccurrence(
      row,
      options.filters,
      attachmentsByEvent.get(publicSearchAttachmentEventId(row)) ?? [],
    )),
    hasMore: rows.length > options.filters.limit,
  };
  const last = page.items.at(-1);
  const facets = await loadOccurrenceFacets({
    clickhouse,
    tenancy: options.tenancy,
    filters: options.filters,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    attachmentEventIds: options.attachmentEventIds,
  });
  return {
    items: page.items,
    next_cursor: page.hasMore && last !== undefined
      ? encodePublicSearchCursor({
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        filters: options.filters,
        position: {
          kind: "occurrence",
          eventAtMillis: last.event_at_millis,
          occurrenceId: last.occurrence_id ?? throwMissingOccurrenceId(),
        },
      }, options.cursorSecret)
      : null,
    facets,
  };
}

async function loadOccurrenceFacets(options: {
  clickhouse: ClickHouseSearchClient,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  attachmentEventIds: readonly string[] | null,
}): Promise<PublicSearchFacets> {
  if (options.filters.facets.length === 0) return {};
  const rows = await Promise.all(options.filters.facets.map(async (facet) => {
    const resultSet = await options.clickhouse.query(buildPublicSearchFacetPlan({
      tenancy: options.tenancy,
      filters: options.filters,
      facet,
      rangeStart: options.rangeStart,
      rangeEnd: options.rangeEnd,
      attachmentEventIds: options.attachmentEventIds ?? undefined,
    }));
    return await resultSet.json<PublicSearchFacetRow>();
  }));
  return toPublicSearchFacets(rows.flat());
}

function issueFacetExpression(facet: string, now: Date): Prisma.Sql {
  if (facet === "status") {
    return Prisma.sql`CASE
      WHEN i."status"::text = 'RESOLVED' THEN 'resolved'
      WHEN i."status"::text = 'IGNORED' AND (i."ignoredUntil" IS NULL OR i."ignoredUntil" >= ${now}::timestamptz) THEN 'ignored'
      ELSE 'unresolved'
    END`;
  }
  if (facet === "service") return Prisma.sql`i."serviceName"`;
  if (facet === "environment") return Prisma.sql`i."deploymentEnvironmentName"`;
  if (facet === "release") return Prisma.sql`i."lastSeenRelease"`;
  throw new Error(`Unsupported issue facet: ${facet}`);
}

async function loadIssueFacets(options: {
  prisma: SearchPrismaClient,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  matchingHashes: readonly string[] | null,
  useClickHouse: boolean,
  now: Date,
}): Promise<PublicSearchFacets> {
  if (options.filters.facets.length === 0) return {};
  const rows = await Promise.all(options.filters.facets.map(async (facet) => {
    const expression = issueFacetExpression(facet, options.now);
    return await options.prisma.$replica().$queryRaw<PublicSearchFacetRow[]>(Prisma.sql`
      SELECT ${facet} AS "facet_key", ${expression} AS "facet_value", count(*)::bigint AS count
      FROM "Issue" i
      WHERE i."tenancyId" = ${options.tenancy.id}::uuid
        AND i."lastSeenAt" >= ${options.rangeStart}::timestamptz
        AND i."lastSeenAt" <= ${options.rangeEnd}::timestamptz
        ${issueHashSql(options.matchingHashes)}
        ${issueMessageSql(options.filters, options.useClickHouse)}
        ${issueStatusSql(options.filters, options.now)}
        ${issueHandledSql(options.filters)}
        AND ${expression} IS NOT NULL
        AND ${expression} <> ''
      GROUP BY ${expression}
      ORDER BY count DESC, "facet_value" ASC
      LIMIT ${PUBLIC_SEARCH_FACET_COUNT_CAP}
    `);
  }));
  return toPublicSearchFacets(rows.flat());
}

function throwMissingOccurrenceId(): never {
  throw new Error("A public search occurrence result is missing its occurrence id");
}

function throwMissingAttachmentSearchPrisma(): never {
  throw new Error("Attachment-filtered public search requires a tenant-scoped Prisma read client");
}

async function searchIssues(options: {
  clickhouse?: ClickHouseSearchClient,
  prisma: SearchPrismaClient,
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date,
  cursor: PublicSearchCursorPosition | null,
  cursorSecret: string | undefined,
  attachmentEventIds: readonly string[] | null,
}): Promise<PublicSearchResponse> {
  const useClickHouse = isOccurrenceFilter(options.filters);
  let matchingHashes: readonly string[] | null = null;
  if (useClickHouse) {
    const clickhouse = options.clickhouse ?? getSharedClickhouseAdminClient();
    matchingHashes = await loadMatchingHashes({
      clickhouse,
      tenancy: options.tenancy,
      filters: options.filters,
      rangeStart: options.rangeStart,
      rangeEnd: options.rangeEnd,
      attachmentEventIds: options.attachmentEventIds ?? undefined,
    });
  } else if (options.filters.issueHash !== null) {
    matchingHashes = [options.filters.issueHash];
  }
  if (matchingHashes !== null && matchingHashes.length === 0) return { items: [], next_cursor: null, facets: {} };

  const rows = await loadIssueRows({
    prisma: options.prisma,
    tenancy: options.tenancy,
    filters: options.filters,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    cursor: options.cursor,
    matchingHashes,
    useClickHouse,
    now: options.now,
  });
  const page = pageRecords(rows.map((row) => toPublicSearchIssue(row, options.filters, options.now)), options.filters.limit);
  const last = page.items.at(-1);
  const facets = await loadIssueFacets({
    prisma: options.prisma,
    tenancy: options.tenancy,
    filters: options.filters,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    matchingHashes,
    useClickHouse,
    now: options.now,
  });
  return {
    items: page.items,
    next_cursor: page.hasMore && last !== undefined
      ? encodePublicSearchCursor({
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        filters: options.filters,
        position: {
          kind: "issue",
          lastSeenAtMillis: last.event_at_millis,
          issueId: last.issue_id ?? throwMissingIssueId(),
        },
      }, options.cursorSecret)
      : null,
    facets,
  };
}

function throwMissingIssueId(): never {
  throw new Error("A public search issue result is missing its issue id");
}

export async function searchPublicRecords(options: {
  tenancy: PublicSearchTenancy,
  filters: PublicSearchFilters,
  dependencies?: PublicSearchDependencies,
}): Promise<PublicSearchResponse> {
  const dependencies = options.dependencies ?? {};
  const now = dependencies.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Public search requires a valid current time");
  const rangeStart = issueRangeStart(options.filters.hours, now);
  const cursor = resolveCursor(options.tenancy, options.filters, dependencies.cursorSecret);
  const attachmentEventIds = hasPublicSearchAttachmentFilter(options.filters)
    ? await loadPublicSearchAttachmentEventIds({
      query: createPublicSearchRawQuery(dependencies.prisma ?? throwMissingAttachmentSearchPrisma()),
      tenancy: options.tenancy,
      filters: options.filters,
    })
    : null;
  if (attachmentEventIds !== null && attachmentEventIds.length === 0) return { items: [], next_cursor: null, facets: {} };

  if (options.filters.record === "issue") {
    const prisma = dependencies.prisma;
    if (prisma === undefined) {
      throw new Error("Public issue search requires a tenant-scoped Prisma read client");
    }
    return await searchIssues({
      clickhouse: dependencies.clickhouse,
      prisma,
      tenancy: options.tenancy,
      filters: options.filters,
      rangeStart,
      rangeEnd: now,
      now,
      cursor,
      cursorSecret: dependencies.cursorSecret,
      attachmentEventIds,
    });
  }

  return await searchOccurrences({
    clickhouse: dependencies.clickhouse,
    tenancy: options.tenancy,
    filters: options.filters,
    rangeStart,
    rangeEnd: now,
    cursor,
    cursorSecret: dependencies.cursorSecret,
    attachmentEventIds,
  });
}
