import { describe, expect, it } from "vitest";
import {
  parsePublicSearchQuery,
  type PublicSearchFilters,
} from "./contract";
import {
  decodePublicSearchCursor,
  encodePublicSearchCursor,
} from "./cursor";

const ISSUE_HASH = "a".repeat(32);
const EVENT_ID = "b".repeat(32);
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const BRANCH_ID = "main";
const SECRET = "public-search-test-secret";

function occurrenceFilters(overrides: Partial<PublicSearchFilters> = {}): PublicSearchFilters {
  return {
    record: "occurrence",
    hours: 24,
    issueHash: null,
    eventId: null,
    tagKey: null,
    tagValue: null,
    message: null,
    status: null,
    level: null,
    handled: null,
    userId: null,
    release: null,
    environment: null,
    service: null,
    attachmentFilename: null,
    attachmentContentType: null,
    attachmentType: null,
    contextKey: null,
    contextValue: null,
    propertyKey: null,
    propertyValue: null,
    facets: [],
    cursor: null,
    limit: 10,
    ...overrides,
  };
}

describe("public observability search contract", () => {
  it("normalizes the supported dimensions and bounds the result window", () => {
    expect(parsePublicSearchQuery({
      record: "event",
      hours: "720",
      issue_hash: ISSUE_HASH,
      event_id: EVENT_ID,
      tag_key: "region",
      tag_value: "production",
      message: " database ",
      release: "release-1",
      environment: "prod",
      service: "api",
      attachment_filename: " screenshot ",
      attachment_content_type: "IMAGE/PNG",
      attachment_type: "event.screenshot",
      limit: "10",
    })).toEqual({
      record: "event",
      hours: 720,
      issueHash: ISSUE_HASH,
      eventId: EVENT_ID,
      tagKey: "region",
      tagValue: "production",
      message: "database",
      status: null,
      level: null,
      handled: null,
      userId: null,
      release: "release-1",
      environment: "prod",
      service: "api",
      attachmentFilename: "screenshot",
      attachmentContentType: "image/png",
      attachmentType: "event.screenshot",
      contextKey: null,
      contextValue: null,
      propertyKey: null,
      propertyValue: null,
      facets: [],
      cursor: null,
      limit: 10,
    });
  });

  it("parses bounded event-property filters and facets", () => {
    expect(parsePublicSearchQuery({
      record: "event",
      level: "warning",
      handled: "false",
      user_id: "user-123",
      context_key: "browser",
      context_value: "Chrome",
      property_key: "plan",
      property_value: "pro",
      facets: "level,tag:region,context:browser,property:plan",
    })).toMatchObject({
      level: "warning",
      handled: false,
      userId: "user-123",
      contextKey: "browser",
      contextValue: "Chrome",
      propertyKey: "plan",
      propertyValue: "pro",
      facets: ["level", "tag:region", "context:browser", "property:plan"],
    });
  });

  it("parses attachment metadata filters only for event-level records", () => {
    expect(parsePublicSearchQuery({
      record: "occurrence",
      attachment_filename: " screenshot.png ",
      attachment_content_type: "IMAGE/PNG",
      attachment_type: "event.screenshot",
    })).toMatchObject({
      attachmentFilename: "screenshot.png",
      attachmentContentType: "image/png",
      attachmentType: "event.screenshot",
    });
  });

  it("rejects unbounded windows, oversized pages, malformed hashes, and partial tag filters", () => {
    expect(() => parsePublicSearchQuery({ hours: "721" })).toThrow("hours must be one of");
    expect(() => parsePublicSearchQuery({ limit: "51" })).toThrow("limit must be an integer");
    expect(() => parsePublicSearchQuery({ issue_hash: "not-a-hash" })).toThrow("issue_hash");
    expect(() => parsePublicSearchQuery({ tag_key: "region" })).toThrow("tag_key and tag_value");
    expect(() => parsePublicSearchQuery({ record: "event", level: "trace" })).toThrow("level must be one of");
    expect(() => parsePublicSearchQuery({ record: "event", status: "resolved" })).toThrow("status is only supported");
    expect(() => parsePublicSearchQuery({ record: "event", facets: "level,level" })).toThrow("facets must not contain duplicates");
    expect(() => parsePublicSearchQuery({ record: "event", facets: `property:${"k".repeat(124)}` })).toThrow("including their prefix");
    expect(() => parsePublicSearchQuery({ record: "event", facets: "tag:" })).toThrow("tag: facets require a non-empty key");
    expect(parsePublicSearchQuery({ record: "event", facets: `property:${"k".repeat(119)}` })).toMatchObject({
      facets: [`property:${"k".repeat(119)}`],
    });
    expect(() => parsePublicSearchQuery({ record: "issue", facets: "tag:region" })).toThrow("only supported for event and occurrence");
    expect(() => parsePublicSearchQuery({ record: "event", attachment_filename: "x".repeat(129) })).toThrow("attachment_filename");
    expect(() => parsePublicSearchQuery({ record: "event", attachment_content_type: "not-a-mime" })).toThrow("MIME type");
    expect(() => parsePublicSearchQuery({ record: "event", attachment_type: "../private" })).toThrow("attachment_type");
    expect(parsePublicSearchQuery({ record: "issue", attachment_type: "event.screenshot" })).toMatchObject({
      record: "issue",
      attachmentType: "event.screenshot",
    });
    expect(() => parsePublicSearchQuery({ unsupported_dimension: "value" })).toThrow("unsupported public search dimension");
  });

  it("binds cursors to the tenant, record, every filter, and page size", () => {
    const filters = occurrenceFilters({ message: "database" });
    const cursor = encodePublicSearchCursor({
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      filters,
      position: {
        kind: "occurrence",
        eventAtMillis: 1_754_502_400_000,
        occurrenceId: "c".repeat(64),
      },
    }, SECRET);

    expect(decodePublicSearchCursor(cursor, { projectId: PROJECT_ID, branchId: BRANCH_ID, filters }, SECRET)).toEqual({
      kind: "occurrence",
      eventAtMillis: 1_754_502_400_000,
      occurrenceId: "c".repeat(64),
    });
    expect(decodePublicSearchCursor(cursor, {
      projectId: PROJECT_ID,
      branchId: BRANCH_ID,
      filters: occurrenceFilters({ message: "other" }),
    }, SECRET)).toBe(null);
    expect(decodePublicSearchCursor(cursor, { projectId: "foreign-project", branchId: BRANCH_ID, filters }, SECRET)).toBe(null);
    expect(decodePublicSearchCursor(cursor, { projectId: PROJECT_ID, branchId: BRANCH_ID, filters }, "wrong-secret")).toBe(null);

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    expect(decodePublicSearchCursor(tampered, { projectId: PROJECT_ID, branchId: BRANCH_ID, filters }, SECRET)).toBe(null);
  });
});
