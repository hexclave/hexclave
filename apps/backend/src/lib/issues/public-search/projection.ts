import { utf8ByteLength } from "@/lib/utf8";
import { getErrorAttachmentEventId } from "@/lib/attachments/attachment-event-id";
import { isErrorIngestScrubbedRecord, type ErrorIngestScrubbedRecord, type ErrorIngestScrubbedValue } from "@/lib/error-ingest";
import {
  scrubPublicOptionalText,
  scrubPublicRecord,
  scrubPublicText,
} from "@/lib/issues/public-scrub";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import type {
  PublicSearchAttachment,
  PublicSearchFilters,
  PublicSearchFacets,
  PublicSearchRecord,
  PublicSearchSourceLink,
  PublicSearchTag,
  PublicSearchIssueStatus,
} from "./contract";
import { PUBLIC_SEARCH_FACET_COUNT_CAP, PUBLIC_SEARCH_FACET_REQUEST_CAP } from "./contract";

export type PublicSearchOccurrenceRow = {
  occurrence_id: string,
  event_at: string,
  body: string,
  level: string,
  data: unknown,
  error_envelope: string | null,
  error_frames: string,
  trace_id: string | null,
  span_id: string | null,
  page_view_span_id: string | null,
  session_replay_id: string | null,
  user_id: string | null,
  service_name: string | null,
  deployment_environment_name: string | null,
  issue_hash: string,
};

export type PublicSearchFacetRow = {
  facet_key: string,
  facet_value: string,
  count: string | number | bigint,
};

export type PublicSearchIssueRow = {
  id: string,
  shortId: bigint,
  type: string,
  value: string,
  culprit: string,
  status: string,
  ignoredUntil: Date | null,
  firstSeenAt: Date,
  lastSeenAt: Date,
  timesSeen: bigint,
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
  lastSeenRelease: string | null,
  handled: boolean,
  synthetic: boolean,
  updatedAt: Date,
};

function readString(record: ErrorIngestScrubbedRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(record: ErrorIngestScrubbedRecord, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readFiniteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseJson(value: string): Json {
  try {
    // JSON.parse is typed as `any`, but a successful parse can only produce
    // JSON values, so binding it to Json is exact rather than a widening.
    const parsed: Json = JSON.parse(value);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function bodyMessage(rawBody: string): string | null {
  if (rawBody === "") return null;
  const parsed = parseJson(rawBody);
  if (isRecord(parsed)) {
    const value = parsed.value;
    if (typeof value === "string") return value;
  }
  return rawBody;
}

const PUBLIC_SEARCH_ERROR_ENVELOPE_MAX_BYTES = 256 * 1024;

function storedErrorEnvelope(raw: string | null): ErrorIngestScrubbedRecord {
  if (raw === null || raw === "" || utf8ByteLength(raw) > PUBLIC_SEARCH_ERROR_ENVELOPE_MAX_BYTES) return {};
  const parsed = parseJson(raw);
  return scrubPublicRecord(parsed);
}

export function publicSearchTimestamp(raw: string): number {
  const timestamp = Date.parse(raw.endsWith("Z") ? raw : `${raw}Z`);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`ClickHouse returned an invalid public search timestamp: ${raw}`);
  }
  return timestamp;
}

function publicIssueHash(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error(`ClickHouse returned an invalid issue hash for public search: ${value}`);
  }
  return value;
}

function publicEventId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return /^[0-9a-f]{32}$/.test(value) ? value : null;
}

function sourcePath(value: unknown): string | null {
  const text = scrubPublicOptionalText(value);
  if (text === null) return null;

  let path = text;
  try {
    const url = new URL(text);
    path = url.pathname;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    path = text.split(/[?#]/, 1)[0];
  }

  path = path.replaceAll("\\", "/");
  path = path.replace(/^\/(?:Users|home)\/[^/]+/, "/<redacted-user>");
  return path.length === 0 ? null : path.slice(0, 2_048);
}

export function toPublicSearchAttachmentMetadata(value: unknown): PublicSearchAttachment | null {
  if (!isRecord(value)) return null;
  return {
    id: scrubPublicOptionalText(value.id),
    filename: sourcePath(value.filename),
    content_type: scrubPublicOptionalText(value.content_type ?? value.contentType),
    size: readFiniteNonNegativeInteger(value.size ?? value.byte_length ?? value.byteLength),
    checksum: scrubPublicOptionalText(value.checksum ?? value.sha256),
    attachment_type: scrubPublicOptionalText(value.attachment_type ?? value.attachmentType),
  };
}

function attachmentMetadata(value: unknown): PublicSearchAttachment[] {
  if (!Array.isArray(value)) return [];
  const result: PublicSearchAttachment[] = [];
  for (const raw of value.slice(0, 20)) {
    const attachment = toPublicSearchAttachmentMetadata(raw);
    if (attachment !== null) result.push(attachment);
  }
  return result;
}

export function publicSearchAttachmentEventId(row: PublicSearchOccurrenceRow): string {
  return getErrorAttachmentEventId(row.occurrence_id);
}

function sourceLink(value: unknown): PublicSearchSourceLink | null {
  if (!isRecord(value)) return null;
  const path = sourcePath(value.absPath ?? value.filename ?? value.code_file);
  const link: PublicSearchSourceLink = {
    path,
    function: scrubPublicOptionalText(value.function),
    module: scrubPublicOptionalText(value.module),
    line: readFiniteNonNegativeInteger(value.lineno),
    column: readFiniteNonNegativeInteger(value.colno),
    debug_id: scrubPublicOptionalText(value.debugId ?? value.debug_id),
  };
  return link.path === null
    && link.function === null
    && link.module === null
    && link.line === null
    && link.column === null
    && link.debug_id === null
    ? null
    : link;
}

function sourceLinks(rawFrames: string, ...metadataRecords: readonly ErrorIngestScrubbedRecord[]): PublicSearchSourceLink[] {
  const links: PublicSearchSourceLink[] = [];
  const seen = new Set<string>();
  const add = (link: PublicSearchSourceLink | null): void => {
    if (link === null) return;
    const key = JSON.stringify(link);
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  const frames = parseJson(rawFrames);
  if (Array.isArray(frames)) {
    for (const frame of frames.slice(0, 50)) add(sourceLink(frame));
  }

  for (const metadata of metadataRecords) {
    const debugMeta = metadata.debug_meta;
    if (isErrorIngestScrubbedRecord(debugMeta) && Array.isArray(debugMeta.images)) {
      for (const image of debugMeta.images.slice(0, 20)) add(sourceLink(image));
    }
  }
  return links;
}

function matchedTag(filters: PublicSearchFilters, ...metadataRecords: readonly ErrorIngestScrubbedRecord[]): PublicSearchTag | null {
  if (filters.tagKey === null || filters.tagValue === null) return null;
  let rawValue: ErrorIngestScrubbedValue | undefined;
  for (const metadata of metadataRecords) {
    const rawTags = metadata.tags;
    if (!isErrorIngestScrubbedRecord(rawTags)) continue;
    // Presence is tested with `in`: scrubbed records carry no undefined
    // values, so only a missing key can produce one.
    if (filters.tagKey in rawTags) {
      rawValue = rawTags[filters.tagKey];
      break;
    }
  }
  if (typeof rawValue !== "string" || rawValue !== filters.tagValue) return null;
  const key = scrubPublicOptionalText(filters.tagKey);
  const value = scrubPublicOptionalText(rawValue);
  return key === null || value === null ? null : { key, value };
}

function facetCount(value: string | number | bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("ClickHouse returned an invalid public search facet count");
  return count;
}

export function toPublicSearchFacets(rows: readonly PublicSearchFacetRow[]): PublicSearchFacets {
  const facets: PublicSearchFacets = {};
  for (const row of rows) {
    if (row.facet_key.length === 0 || row.facet_key.length > 128) throw new Error("ClickHouse returned an invalid public search facet key");
    if (!Object.prototype.hasOwnProperty.call(facets, row.facet_key) && Object.keys(facets).length >= PUBLIC_SEARCH_FACET_REQUEST_CAP) continue;
    const value = scrubPublicText(row.facet_value).slice(0, 512);
    if (value === "") continue;
    const values = facets[row.facet_key] ?? [];
    if (values.length >= PUBLIC_SEARCH_FACET_COUNT_CAP) continue;
    values.push({ value, count: facetCount(row.count) });
    facets[row.facet_key] = values;
  }
  return facets;
}

function emptyIssueFields(): Pick<PublicSearchRecord, "issue_id" | "issue_short_id" | "issue_type" | "issue_value" | "issue_culprit" | "issue_status"> {
  return {
    issue_id: null,
    issue_short_id: null,
    issue_type: null,
    issue_value: null,
    issue_culprit: null,
    issue_status: null,
  };
}

export function toPublicSearchOccurrence(
  row: PublicSearchOccurrenceRow,
  filters: PublicSearchFilters,
  additionalAttachments: readonly PublicSearchAttachment[] = [],
): PublicSearchRecord {
  if (row.occurrence_id.length === 0) throw new Error("ClickHouse returned an empty public search occurrence id");
  const data = scrubPublicRecord(row.data);
  const envelope = storedErrorEnvelope(row.error_envelope);
  const dataMessage = readString(data, "message");
  const envelopeMessage = readString(envelope, "message");
  const message = envelopeMessage ?? dataMessage ?? bodyMessage(row.body);
  const envelopeLevel = readString(envelope, "level");
  const dataLevel = readString(data, "level");
  const envelopeHandled = readBoolean(envelope, "handled");
  const dataHandled = readBoolean(data, "handled");
  const envelopeRuntime = envelope.runtime;
  const dataRuntime = data.runtime;
  const envelopeService = isErrorIngestScrubbedRecord(envelopeRuntime) ? readString(envelopeRuntime, "service_name") : null;
  const dataService: string | null = isErrorIngestScrubbedRecord(dataRuntime) ? readString(dataRuntime, "service_name") : null;
  const service = row.service_name === null || row.service_name === ""
    ? envelopeService ?? dataService
    : row.service_name;
  const envelopeEnvironment = readString(envelope, "environment");
  const dataEnvironment = readString(data, "environment");
  const rawEnvironment = row.deployment_environment_name === null || row.deployment_environment_name === ""
    ? envelopeEnvironment ?? dataEnvironment
    : row.deployment_environment_name;
  const release = readString(envelope, "release") ?? readString(data, "release");
  const eventId = readString(envelope, "event_id") ?? data.event_id;
  const fields = emptyIssueFields();

  return {
    ...fields,
    record_type: filters.record,
    issue_hash: publicIssueHash(row.issue_hash),
    event_id: publicEventId(eventId),
    occurrence_id: row.occurrence_id,
    event_at_millis: publicSearchTimestamp(row.event_at),
    message: message === null ? "" : scrubPublicText(message),
    level: envelopeLevel === null && dataLevel === null ? scrubPublicText(row.level) : scrubPublicText(envelopeLevel ?? dataLevel ?? row.level),
    handled: envelopeHandled ?? dataHandled,
    service: scrubPublicOptionalText(service),
    environment: scrubPublicOptionalText(rawEnvironment),
    release: scrubPublicOptionalText(release),
    matched_tag: matchedTag(filters, envelope, data),
    attachments: additionalAttachments.length > 0
      ? [...additionalAttachments]
      : attachmentMetadata(Array.isArray(envelope.attachments) && envelope.attachments.length > 0 ? envelope.attachments : data.attachments),
    source_links: sourceLinks(row.error_frames, envelope, data),
  };
}

function publicIssueStatus(row: PublicSearchIssueRow, now: Date): PublicSearchIssueStatus {
  if (row.status === "RESOLVED") return "resolved";
  if (row.status === "IGNORED" && (row.ignoredUntil === null || row.ignoredUntil >= now)) return "ignored";
  if (row.status === "UNRESOLVED" || row.status === "IGNORED") return "unresolved";
  throw new Error(`Postgres returned an unsupported issue status for public search: ${row.status}`);
}

function publicDate(value: Date, name: string): number {
  const timestamp = value.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(`Postgres returned an invalid ${name} for public search`);
  return timestamp;
}

export function toPublicSearchIssue(
  row: PublicSearchIssueRow,
  filters: PublicSearchFilters,
  now: Date,
): PublicSearchRecord {
  const status = publicIssueStatus(row, now);
  const fields: Pick<PublicSearchRecord, "issue_id" | "issue_short_id" | "issue_type" | "issue_value" | "issue_culprit" | "issue_status"> = {
    issue_id: row.id,
    issue_short_id: row.shortId.toString(),
    issue_type: scrubPublicText(row.type),
    issue_value: scrubPublicText(row.value),
    issue_culprit: scrubPublicText(row.culprit),
    issue_status: status,
  };
  return {
    ...fields,
    record_type: "issue",
    issue_hash: publicIssueHash(filters.issueHash),
    event_id: null,
    occurrence_id: null,
    event_at_millis: publicDate(row.lastSeenAt, "lastSeenAt"),
    message: scrubPublicText(row.value),
    level: "error",
    handled: row.handled,
    service: scrubPublicOptionalText(row.serviceName),
    environment: scrubPublicOptionalText(row.deploymentEnvironmentName),
    release: scrubPublicOptionalText(row.lastSeenRelease),
    matched_tag: filters.tagKey === null || filters.tagValue === null
      ? null
      : { key: scrubPublicText(filters.tagKey), value: scrubPublicText(filters.tagValue) },
    attachments: [],
    source_links: [],
  };
}
