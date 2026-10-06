import { utf8ByteLength } from "@/lib/utf8";
import { yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import {
  parsePublicSearchQuery,
  type PublicSearchFilters,
} from "../public-search/contract";

export const SAVED_ISSUE_SEARCH_QUERY_VERSION = 1 as const;
export const SAVED_ISSUE_SEARCH_QUERY_MAX_BYTES = 16 * 1024;
export const SAVED_ISSUE_SEARCH_VIEW_NAME_MAX_LENGTH = 128;
export const SAVED_ISSUE_SEARCH_VIEW_MAX_PER_SCOPE = 100;
export const SAVED_ISSUE_SEARCH_VIEW_LIST_MAX = 100;

export const SAVED_ISSUE_SEARCH_FILTER_KEYS = [
  "record",
  "hours",
  "issue_hash",
  "event_id",
  "tag_key",
  "tag_value",
  "message",
  "status",
  "level",
  "handled",
  "user_id",
  "release",
  "environment",
  "service",
  "attachment_filename",
  "attachment_content_type",
  "attachment_type",
  "context_key",
  "context_value",
  "property_key",
  "property_value",
  "facets",
  "limit",
] as const;

const SAVED_ISSUE_SEARCH_FILTER_KEY_SET = new Set<string>(SAVED_ISSUE_SEARCH_FILTER_KEYS);

export const SAVED_ISSUE_SEARCH_VIEW_VISIBILITIES = ["private", "project"] as const;
export type SavedIssueSearchViewVisibility = typeof SAVED_ISSUE_SEARCH_VIEW_VISIBILITIES[number];

export type SavedIssueSearchRawFilters = Partial<Record<typeof SAVED_ISSUE_SEARCH_FILTER_KEYS[number], string>>;

export type SavedIssueSearchQuery = {
  version: typeof SAVED_ISSUE_SEARCH_QUERY_VERSION,
  filters: SavedIssueSearchRawFilters,
};

export type SavedIssueSearchViewMutation = {
  name: string,
  nameKey: string,
  visibility: SavedIssueSearchViewVisibility,
  query: SavedIssueSearchQuery,
};

export type SavedIssueSearchView = {
  id: string,
  schemaVersion: typeof SAVED_ISSUE_SEARCH_QUERY_VERSION,
  name: string,
  nameKey: string,
  visibility: SavedIssueSearchViewVisibility,
  ownerUserId: string | null,
  query: SavedIssueSearchQuery,
  createdAt: Date,
  updatedAt: Date,
};

export type SavedIssueSearchViewResponse = {
  id: string,
  schema_version: typeof SAVED_ISSUE_SEARCH_QUERY_VERSION,
  name: string,
  visibility: SavedIssueSearchViewVisibility,
  owner_user_id: string | null,
  query: SavedIssueSearchQuery,
  created_at_millis: number,
  updated_at_millis: number,
};

export type SavedIssueSearchViewListResponse = {
  items: SavedIssueSearchViewResponse[],
  has_more: boolean,
};

export const SavedIssueSearchViewQuerySchema = yupMixed<SavedIssueSearchQuery>().defined();

export const SavedIssueSearchViewMutationSchema = yupObject({
  name: yupString().defined(),
  visibility: yupString().oneOf([...SAVED_ISSUE_SEARCH_VIEW_VISIBILITIES]).defined(),
  query: yupMixed().defined(),
}).defined();

export const SavedIssueSearchViewResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  schema_version: yupNumber().oneOf([SAVED_ISSUE_SEARCH_QUERY_VERSION]).defined(),
  name: yupString().defined(),
  visibility: yupString().oneOf([...SAVED_ISSUE_SEARCH_VIEW_VISIBILITIES]).defined(),
  owner_user_id: yupString().uuid().nullable().defined(),
  query: SavedIssueSearchViewQuerySchema,
  created_at_millis: yupNumber().integer().min(0).defined(),
  updated_at_millis: yupNumber().integer().min(0).defined(),
}).defined();

export const SavedIssueSearchViewListResponseSchema = yupObject({
  items: yupArray(SavedIssueSearchViewResponseSchema).defined(),
  has_more: yupBoolean().defined(),
}).defined();

function badRequest(message: string): never {
  throw new StatusError(StatusError.BadRequest, message);
}

function forbidden(message: string): never {
  throw new StatusError(StatusError.Forbidden, message);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function serializedByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return utf8ByteLength(serialized);
}

function parseVisibility(value: unknown): SavedIssueSearchViewVisibility {
  if (value === "private" || value === "project") return value;
  return badRequest("visibility must be private or project");
}

function normalizeName(value: unknown): { name: string, nameKey: string } {
  if (typeof value !== "string") return badRequest("name must be a string");
  const name = value.normalize("NFKC").trim();
  if (name.length === 0) return badRequest("name must not be empty");
  if (name.length > SAVED_ISSUE_SEARCH_VIEW_NAME_MAX_LENGTH) {
    return badRequest(`name must be at most ${SAVED_ISSUE_SEARCH_VIEW_NAME_MAX_LENGTH} characters`);
  }
  if (/\p{Cc}|\p{Cf}|\p{Cs}/u.test(name)) return badRequest("name must not contain control characters");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)) {
    return badRequest("name must start with a letter or number and contain only letters, numbers, spaces, _, -, or .");
  }

  const nameKey = name.toLowerCase();
  if (nameKey.length > SAVED_ISSUE_SEARCH_VIEW_NAME_MAX_LENGTH) {
    return badRequest(`name must be at most ${SAVED_ISSUE_SEARCH_VIEW_NAME_MAX_LENGTH} characters after normalization`);
  }
  return { name, nameKey };
}

function isActorUserId(value: string | null): boolean {
  return value === null || isUuid(value);
}

function canonicalizeFilters(filters: PublicSearchFilters): SavedIssueSearchRawFilters {
  const canonical: SavedIssueSearchRawFilters = {
    record: filters.record,
    hours: String(filters.hours),
    limit: String(filters.limit),
  };
  if (filters.issueHash !== null) canonical.issue_hash = filters.issueHash;
  if (filters.eventId !== null) canonical.event_id = filters.eventId;
  if (filters.tagKey !== null) canonical.tag_key = filters.tagKey;
  if (filters.tagValue !== null) canonical.tag_value = filters.tagValue;
  if (filters.message !== null) canonical.message = filters.message;
  if (filters.status !== null) canonical.status = filters.status;
  if (filters.level !== null) canonical.level = filters.level;
  if (filters.handled !== null) canonical.handled = String(filters.handled);
  if (filters.userId !== null) canonical.user_id = filters.userId;
  if (filters.release !== null) canonical.release = filters.release;
  if (filters.environment !== null) canonical.environment = filters.environment;
  if (filters.service !== null) canonical.service = filters.service;
  if (filters.attachmentFilename !== null) canonical.attachment_filename = filters.attachmentFilename;
  if (filters.attachmentContentType !== null) canonical.attachment_content_type = filters.attachmentContentType;
  if (filters.attachmentType !== null) canonical.attachment_type = filters.attachmentType;
  if (filters.contextKey !== null) canonical.context_key = filters.contextKey;
  if (filters.contextValue !== null) canonical.context_value = filters.contextValue;
  if (filters.propertyKey !== null) canonical.property_key = filters.propertyKey;
  if (filters.propertyValue !== null) canonical.property_value = filters.propertyValue;
  if (filters.facets.length > 0) canonical.facets = filters.facets.join(",");
  return canonical;
}

export function parseSavedIssueSearchQuery(value: unknown): SavedIssueSearchQuery {
  if (!isRecord(value)) return badRequest("query must be an object");
  if (serializedByteLength(value) > SAVED_ISSUE_SEARCH_QUERY_MAX_BYTES) {
    return badRequest(`query must be at most ${SAVED_ISSUE_SEARCH_QUERY_MAX_BYTES} bytes`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "version" && key !== "filters")) {
    return badRequest("query may only contain version and filters");
  }
  if (value.version !== SAVED_ISSUE_SEARCH_QUERY_VERSION) {
    return badRequest(`query version must be ${SAVED_ISSUE_SEARCH_QUERY_VERSION}`);
  }
  if (!isRecord(value.filters)) return badRequest("query.filters must be an object");

  const filterKeys = Object.keys(value.filters);
  const unsupportedKey = filterKeys.find((key) => !SAVED_ISSUE_SEARCH_FILTER_KEY_SET.has(key));
  if (unsupportedKey !== undefined) {
    return badRequest(unsupportedKey === "cursor"
      ? "cursor is execution state and cannot be persisted in a saved view"
      : `unsupported saved issue search filter: ${unsupportedKey}`);
  }
  if (!isStringRecord(value.filters)) return badRequest("saved issue search filters must contain only strings");

  const filters = parsePublicSearchQuery(value.filters);
  return {
    version: SAVED_ISSUE_SEARCH_QUERY_VERSION,
    filters: canonicalizeFilters(filters),
  };
}

export function applySavedIssueSearchCursor(query: SavedIssueSearchQuery, cursor: string | null): PublicSearchFilters {
  const raw: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query.filters)) raw[key] = value;
  if (cursor !== null) raw.cursor = cursor;
  return parsePublicSearchQuery(raw);
}

export function parseSavedIssueSearchViewMutation(
  value: unknown,
  actorUserId: string | null,
  options: { allowPrivateWithoutActor?: boolean } = {},
): SavedIssueSearchViewMutation {
  if (!isActorUserId(actorUserId)) return forbidden("saved issue search view owner is invalid");
  if (!isRecord(value)) return badRequest("saved issue search view body must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "name" && key !== "visibility" && key !== "query")) {
    return badRequest("saved issue search view body may only contain name, visibility, and query");
  }

  const visibility = parseVisibility(value.visibility);
  if (visibility === "private" && actorUserId === null && options.allowPrivateWithoutActor !== true) {
    return forbidden("private saved issue search views require an authenticated user");
  }
  const { name, nameKey } = normalizeName(value.name);
  return {
    name,
    nameKey,
    visibility,
    query: parseSavedIssueSearchQuery(value.query),
  };
}

export function parseSavedIssueSearchViewName(value: string): { name: string, nameKey: string } {
  return normalizeName(value);
}

export function toSavedIssueSearchViewResponse(view: SavedIssueSearchView): SavedIssueSearchViewResponse {
  return {
    id: view.id,
    schema_version: view.schemaVersion,
    name: view.name,
    visibility: view.visibility,
    owner_user_id: view.ownerUserId,
    query: view.query,
    created_at_millis: view.createdAt.getTime(),
    updated_at_millis: view.updatedAt.getTime(),
  };
}

export function isSavedIssueSearchViewVisibility(value: string): value is SavedIssueSearchViewVisibility {
  return value === "private" || value === "project";
}

export function isSavedIssueSearchQuery(value: unknown): value is SavedIssueSearchQuery {
  if (!isRecord(value) || value.version !== SAVED_ISSUE_SEARCH_QUERY_VERSION) return false;
  try {
    parseSavedIssueSearchQuery(value);
    return true;
  } catch (error) {
    if (StatusError.isStatusError(error)) return false;
    throw error;
  }
}
