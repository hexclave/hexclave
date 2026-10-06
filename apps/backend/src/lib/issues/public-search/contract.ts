import yup from "yup";
import { yupArray, yupBoolean, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export type PublicSearchRecordType = "issue" | "event" | "occurrence";
export const PUBLIC_SEARCH_RECORD_TYPES: [PublicSearchRecordType, PublicSearchRecordType, PublicSearchRecordType] = [
  "issue",
  "event",
  "occurrence",
];

export const PUBLIC_SEARCH_PAGE_SIZE = 50;
export const PUBLIC_SEARCH_HASH_MATCH_CAP = 1_000;
export const PUBLIC_SEARCH_FACET_COUNT_CAP = 10;
export const PUBLIC_SEARCH_FACET_REQUEST_CAP = 5;
export const PUBLIC_SEARCH_ATTACHMENT_EVENT_MATCH_CAP = 1_000;
export const PUBLIC_SEARCH_ATTACHMENT_METADATA_PER_EVENT_CAP = 20;

const PUBLIC_SEARCH_ATTACHMENT_FILENAME_MAX_LENGTH = 128;
const PUBLIC_SEARCH_ATTACHMENT_CONTENT_TYPE_MAX_LENGTH = 255;
const PUBLIC_SEARCH_ATTACHMENT_TYPE_MAX_LENGTH = 64;
const PUBLIC_SEARCH_ATTACHMENT_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}(?:;[ -~]{1,96})?$/i;
const PUBLIC_SEARCH_ATTACHMENT_TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

export const PUBLIC_SEARCH_LEVELS = ["fatal", "error", "warning", "info", "debug", "log"] as const;
export type PublicSearchLevel = typeof PUBLIC_SEARCH_LEVELS[number];

export const PUBLIC_SEARCH_ISSUE_STATUSES = ["unresolved", "resolved", "ignored"] as const;

export type PublicSearchFacetValue = {
  value: string,
  count: number,
};

export type PublicSearchFacets = Record<string, PublicSearchFacetValue[]>;

export type PublicSearchAttachment = {
  id: string | null,
  filename: string | null,
  content_type: string | null,
  size: number | null,
  checksum: string | null,
  attachment_type: string | null,
};

export type PublicSearchSourceLink = {
  path: string | null,
  function: string | null,
  module: string | null,
  line: number | null,
  column: number | null,
  debug_id: string | null,
};

export type PublicSearchTag = {
  key: string,
  value: string,
};

export type PublicSearchIssueStatus = "unresolved" | "resolved" | "ignored";

export type PublicSearchRecord = {
  record_type: PublicSearchRecordType,
  issue_id: string | null,
  issue_short_id: string | null,
  issue_type: string | null,
  issue_value: string | null,
  issue_culprit: string | null,
  issue_status: PublicSearchIssueStatus | null,
  issue_hash: string | null,
  event_id: string | null,
  occurrence_id: string | null,
  event_at_millis: number,
  message: string,
  level: string,
  handled: boolean | null,
  service: string | null,
  environment: string | null,
  release: string | null,
  matched_tag: PublicSearchTag | null,
  attachments: PublicSearchAttachment[],
  source_links: PublicSearchSourceLink[],
};

export type PublicSearchResponse = {
  items: PublicSearchRecord[],
  next_cursor: string | null,
  facets: PublicSearchFacets,
};

export const PublicSearchAttachmentSchema = yupObject({
  id: yupString().nullable().defined(),
  filename: yupString().nullable().defined(),
  content_type: yupString().nullable().defined(),
  size: yupNumber().nullable().defined(),
  checksum: yupString().nullable().defined(),
  attachment_type: yupString().nullable().defined(),
}).defined();

export const PublicSearchSourceLinkSchema = yupObject({
  path: yupString().nullable().defined(),
  function: yupString().nullable().defined(),
  module: yupString().nullable().defined(),
  line: yupNumber().nullable().defined(),
  column: yupNumber().nullable().defined(),
  debug_id: yupString().nullable().defined(),
}).defined();

export const PublicSearchTagSchema = yupObject({
  key: yupString().defined(),
  value: yupString().defined(),
}).defined();

export const PublicSearchRecordSchema = yupObject({
  record_type: yupString().oneOf(PUBLIC_SEARCH_RECORD_TYPES).defined(),
  issue_id: yupString().nullable().defined(),
  issue_short_id: yupString().nullable().defined(),
  issue_type: yupString().nullable().defined(),
  issue_value: yupString().nullable().defined(),
  issue_culprit: yupString().nullable().defined(),
  issue_status: yupString().oneOf(PUBLIC_SEARCH_ISSUE_STATUSES).nullable().defined(),
  issue_hash: yupString().nullable().defined(),
  event_id: yupString().nullable().defined(),
  occurrence_id: yupString().nullable().defined(),
  event_at_millis: yupNumber().defined(),
  message: yupString().defined(),
  level: yupString().defined(),
  handled: yupBoolean().nullable().defined(),
  service: yupString().nullable().defined(),
  environment: yupString().nullable().defined(),
  release: yupString().nullable().defined(),
  matched_tag: PublicSearchTagSchema.nullable().defined(),
  attachments: yupArray(PublicSearchAttachmentSchema).defined(),
  source_links: yupArray(PublicSearchSourceLinkSchema).defined(),
}).defined();

export const PublicSearchResponseSchema = yupObject({
  items: yupArray(PublicSearchRecordSchema).defined(),
  next_cursor: yupString().nullable().defined(),
  facets: yupRecord(
    yupString().max(128),
    yupArray(yupObject({
      value: yupString().defined(),
      count: yupNumber().defined(),
    }).defined()).max(PUBLIC_SEARCH_FACET_COUNT_CAP).defined(),
  ).defined(),
}).defined();

export const PublicSearchQuerySchema = yupObject({
  record: yupString().oneOf(PUBLIC_SEARCH_RECORD_TYPES).optional(),
  hours: yupString().optional(),
  issue_hash: yupString().optional(),
  event_id: yupString().optional(),
  tag_key: yupString().optional(),
  tag_value: yupString().optional(),
  message: yupString().optional(),
  status: yupString().optional(),
  level: yupString().optional(),
  handled: yupString().optional(),
  user_id: yupString().optional(),
  release: yupString().optional(),
  environment: yupString().optional(),
  service: yupString().optional(),
  attachment_filename: yupString().optional(),
  attachment_content_type: yupString().optional(),
  attachment_type: yupString().optional(),
  context_key: yupString().optional(),
  context_value: yupString().optional(),
  property_key: yupString().optional(),
  property_value: yupString().optional(),
  facets: yupString().optional(),
  cursor: yupString().optional(),
  limit: yupString().optional(),
}).defined();

export type PublicSearchQuery = yup.InferType<typeof PublicSearchQuerySchema>;

export type PublicSearchFilters = {
  record: PublicSearchRecordType,
  hours: number,
  issueHash: string | null,
  eventId: string | null,
  tagKey: string | null,
  tagValue: string | null,
  message: string | null,
  status: PublicSearchIssueStatus | null,
  level: PublicSearchLevel | null,
  handled: boolean | null,
  userId: string | null,
  release: string | null,
  environment: string | null,
  service: string | null,
  attachmentFilename: string | null,
  attachmentContentType: string | null,
  attachmentType: string | null,
  contextKey: string | null,
  contextValue: string | null,
  propertyKey: string | null,
  propertyValue: string | null,
  facets: string[],
  cursor: string | null,
  limit: number,
};

const PUBLIC_SEARCH_HOURS: [number, number, number, number] = [1, 24, 168, 720];
const PUBLIC_SEARCH_QUERY_KEYS = new Set([
  "record", "hours", "issue_hash", "event_id", "tag_key", "tag_value", "message", "status", "level", "handled",
  "user_id", "release", "environment", "service", "context_key", "context_value", "property_key", "property_value",
  "attachment_filename", "attachment_content_type", "attachment_type", "facets", "cursor", "limit",
]);

function badRequest(message: string): never {
  throw new StatusError(StatusError.BadRequest, message);
}

function parseHours(raw: string | undefined): number {
  if (raw === undefined) return 24;
  const value = Number(raw);
  if (!PUBLIC_SEARCH_HOURS.includes(value)) {
    return badRequest(`hours must be one of ${PUBLIC_SEARCH_HOURS.join(", ")}`);
  }
  return value;
}

function normalizeFilter(raw: string | undefined, name: string, maxLength: number): string | null {
  const value = raw?.trim();
  if (value === undefined || value === "") return null;
  if (value.length > maxLength) return badRequest(`${name} must be at most ${maxLength} characters`);
  return value;
}

function normalizeAttachmentFilter(raw: string | undefined, name: string, maxLength: number): string | null {
  const value = normalizeFilter(raw, name, maxLength);
  if (value === null) return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return badRequest(`${name} must not contain control characters`);
  return value;
}

function parseAttachmentContentType(raw: string | undefined): string | null {
  const value = normalizeAttachmentFilter(raw, "attachment_content_type", PUBLIC_SEARCH_ATTACHMENT_CONTENT_TYPE_MAX_LENGTH);
  if (value === null) return null;
  if (!PUBLIC_SEARCH_ATTACHMENT_MIME_RE.test(value)) return badRequest("attachment_content_type must be a valid MIME type");
  return value.toLowerCase();
}

function parseAttachmentType(raw: string | undefined): string | null {
  const value = normalizeAttachmentFilter(raw, "attachment_type", PUBLIC_SEARCH_ATTACHMENT_TYPE_MAX_LENGTH);
  if (value === null) return null;
  if (!PUBLIC_SEARCH_ATTACHMENT_TYPE_RE.test(value)) return badRequest("attachment_type must be a bounded identifier");
  return value;
}

export function hasPublicSearchAttachmentFilter(filters: Pick<PublicSearchFilters, "attachmentFilename" | "attachmentContentType" | "attachmentType">): boolean {
  return filters.attachmentFilename !== null
    || filters.attachmentContentType !== null
    || filters.attachmentType !== null;
}

function parseRecord(raw: string | undefined): PublicSearchRecordType {
  if (raw === undefined) return "occurrence";
  if (raw === "issue" || raw === "event" || raw === "occurrence") return raw;
  return badRequest("record must be one of issue, event, occurrence");
}

function parseIssueHash(raw: string | undefined): string | null {
  const value = normalizeFilter(raw, "issue_hash", 128);
  if (value === null) return null;
  if (!/^[0-9a-f]{32}$/.test(value)) return badRequest("issue_hash must be a 32-character lowercase hexadecimal hash");
  return value;
}

function parseEventId(raw: string | undefined): string | null {
  const value = normalizeFilter(raw, "event_id", 64);
  if (value === null) return null;
  if (!/^[0-9a-f]{32}$/.test(value)) return badRequest("event_id must be a 32-character lowercase hexadecimal identifier");
  return value;
}

function parseStatus(raw: string | undefined, record: PublicSearchRecordType): PublicSearchIssueStatus | null {
  const value = normalizeFilter(raw, "status", 32);
  if (value === null) return null;
  if (record !== "issue") return badRequest("status is only supported for issue records");
  if (value === "unresolved" || value === "resolved" || value === "ignored") return value;
  return badRequest("status must be one of unresolved, resolved, ignored");
}

function isPublicSearchLevel(value: string): value is PublicSearchLevel {
  return PUBLIC_SEARCH_LEVELS.some((level) => level === value);
}

function parseLevel(raw: string | undefined): PublicSearchLevel | null {
  const value = normalizeFilter(raw, "level", 16);
  if (value === null) return null;
  if (isPublicSearchLevel(value)) return value;
  return badRequest(`level must be one of ${PUBLIC_SEARCH_LEVELS.join(", ")}`);
}

function parseBoolean(raw: string | undefined, name: string): boolean | null {
  const value = normalizeFilter(raw, name, 5);
  if (value === null) return null;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return badRequest(`${name} must be true or false`);
}

function parseFacets(raw: string | undefined, record: PublicSearchRecordType): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw.split(",").map((value) => value.trim());
  if (values.length > PUBLIC_SEARCH_FACET_REQUEST_CAP || values.some((value) => value === "")) {
    return badRequest(`facets must contain at most ${PUBLIC_SEARCH_FACET_REQUEST_CAP} non-empty values`);
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) return badRequest("facets must not contain duplicates");

  for (const facet of unique) {
    const dynamicPrefix = ["tag:", "context:", "property:"].find((prefix) => facet.startsWith(prefix));
    if (dynamicPrefix !== undefined) {
      const key = facet.slice(dynamicPrefix.length).trim();
      if (key === "") return badRequest(`${dynamicPrefix} facets require a non-empty key`);
      if (facet.length > 128) return badRequest("dynamic facet identifiers must be at most 128 characters including their prefix");
      if (record === "issue") return badRequest(`${facet.split(":", 1)[0]} facets are only supported for event and occurrence records`);
      continue;
    }
    const allowed = record === "issue"
      ? ["status", "service", "environment", "release"]
      : ["level", "service", "environment", "release"];
    if (!allowed.includes(facet)) return badRequest(`unsupported facet: ${facet}`);
  }
  return unique;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return PUBLIC_SEARCH_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > PUBLIC_SEARCH_PAGE_SIZE) {
    return badRequest(`limit must be an integer between 1 and ${PUBLIC_SEARCH_PAGE_SIZE}`);
  }
  return value;
}

function parseCursor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (raw.length === 0 || raw.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return badRequest("cursor is invalid");
  }
  return raw;
}

export function parsePublicSearchQuery(query: PublicSearchQuery | Record<string, string | undefined> | undefined): PublicSearchFilters {
  const unsupportedKeys = Object.keys(query ?? {}).filter((key) => !PUBLIC_SEARCH_QUERY_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    return badRequest(`unsupported public search dimension(s): ${unsupportedKeys.join(", ")}`);
  }
  const tagKey = normalizeFilter(query?.tag_key, "tag_key", 128);
  const tagValue = normalizeFilter(query?.tag_value, "tag_value", 256);
  if ((tagKey === null) !== (tagValue === null)) {
    return badRequest("tag_key and tag_value must be provided together");
  }
  const contextKey = normalizeFilter(query?.context_key, "context_key", 128);
  const contextValue = normalizeFilter(query?.context_value, "context_value", 256);
  if ((contextKey === null) !== (contextValue === null)) {
    return badRequest("context_key and context_value must be provided together");
  }
  const propertyKey = normalizeFilter(query?.property_key, "property_key", 128);
  const propertyValue = normalizeFilter(query?.property_value, "property_value", 256);
  if ((propertyKey === null) !== (propertyValue === null)) {
    return badRequest("property_key and property_value must be provided together");
  }
  const record = parseRecord(query?.record);
  const attachmentFilename = normalizeAttachmentFilter(query?.attachment_filename, "attachment_filename", PUBLIC_SEARCH_ATTACHMENT_FILENAME_MAX_LENGTH);
  const attachmentContentType = parseAttachmentContentType(query?.attachment_content_type);
  const attachmentType = parseAttachmentType(query?.attachment_type);

  return {
    record,
    hours: parseHours(query?.hours),
    issueHash: parseIssueHash(query?.issue_hash),
    eventId: parseEventId(query?.event_id),
    tagKey,
    tagValue,
    message: normalizeFilter(query?.message, "message", 256),
    status: parseStatus(query?.status, record),
    level: parseLevel(query?.level),
    handled: parseBoolean(query?.handled, "handled"),
    userId: normalizeFilter(query?.user_id, "user_id", 256),
    release: normalizeFilter(query?.release, "release", 255),
    environment: normalizeFilter(query?.environment, "environment", 255),
    service: normalizeFilter(query?.service, "service", 255),
    attachmentFilename,
    attachmentContentType,
    attachmentType,
    contextKey,
    contextValue,
    propertyKey,
    propertyValue,
    facets: parseFacets(query?.facets, record),
    cursor: parseCursor(query?.cursor),
    limit: parseLimit(query?.limit),
  };
}
