import { describe, expect, it } from "vitest";
import { parsePublicSearchQuery } from "./contract";
import {
  buildPublicSearchIssueHashPlan,
  buildPublicSearchAttachmentEventIdsQuery,
  buildPublicSearchFacetPlan,
  buildPublicSearchOccurrencePlan,
  pagePublicSearchRecords,
  type PublicSearchPlanTenancy,
} from "./query";
import type { PublicSearchRecord } from "./contract";

const tenancy: PublicSearchPlanTenancy = {
  project: { id: "project-a" },
  branchId: "branch-a",
};

describe("public observability search query plans", () => {
  it("binds tenant, branch, time, every dimension, and a keyset cursor", () => {
    const filters = parsePublicSearchQuery({
      record: "occurrence",
      issue_hash: "a".repeat(32),
      event_id: "b".repeat(32),
      tag_key: "region",
      tag_value: "production",
      message: "database",
      level: "warning",
      handled: "false",
      user_id: "user-123",
      context_key: "browser",
      context_value: "Chrome",
      property_key: "plan",
      property_value: "pro",
      attachment_filename: "screenshot",
      attachment_content_type: "image/png",
      attachment_type: "event.screenshot",
      release: "release-1",
      environment: "prod",
      service: "api",
      limit: "10",
    });
    const plan = buildPublicSearchOccurrencePlan({
      tenancy,
      filters,
      rangeStart: new Date("2026-08-06T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-06T12:00:00.000Z"),
      cursor: {
        kind: "occurrence",
        eventAtMillis: 1_754_502_400_000,
        occurrenceId: "c".repeat(64),
      },
      attachmentEventIds: ["d".repeat(32)],
    });

    expect(plan.query).toContain("project_id = {projectId:String}");
    expect(plan.query).toContain("branch_id = {branchId:String}");
    expect(plan.query).toContain("event_at >= {rangeStart:DateTime}");
    expect(plan.query).toContain("event_at <= {rangeEnd:DateTime}");
    expect(plan.query).toContain("JSONExtractString(error_envelope, 'event_id')");
    expect(plan.query).toContain("JSONExtractString(JSONExtractRaw(error_envelope, 'tags'), {tagKey:String})");
    expect(plan.query).toContain("JSONExtractString(error_envelope, 'message')");
    expect(plan.query).toContain("JSONExtractString(JSONExtractRaw(error_envelope, 'contexts'), {contextKey:String})");
    expect(plan.query).toContain("JSONExtractString(JSONExtractRaw(error_envelope, 'extra'), {propertyKey:String})");
    expect(plan.query).toContain("JSONExtractRaw(error_envelope, 'handled')");
    expect(plan.query).toContain("attachmentEventIds:Array(String)");
    expect(plan.query).toContain("occurrence_id IN {attachmentEventIds:Array(String)}");
    expect(plan.query).toContain("error_envelope");
    expect(plan.query).toContain("(event_at, occurrence_id) < ({cursorAt:DateTime64(3)}, {cursorId:String})");
    expect(plan.query).toContain("LIMIT {resultLimit:UInt32}");
    expect(plan.query_params).toMatchObject({
      projectId: "project-a",
      branchId: "branch-a",
      issueHash: "a".repeat(32),
      eventId: "b".repeat(32),
      tagKey: "region",
      tagValue: "production",
      messagePattern: "%database%",
      level: "warning",
      handled: 0,
      userId: "user-123",
      contextKey: "browser",
      contextValue: "Chrome",
      propertyKey: "plan",
      propertyValue: "pro",
      release: "release-1",
      environment: "prod",
      service: "api",
      resultLimit: 11,
      attachmentEventIds: ["d".repeat(32)],
    });
  });

  it("does not build an attachment-filtered ClickHouse query without scoped event ids", () => {
    const filters = parsePublicSearchQuery({ record: "event", attachment_type: "event.screenshot" });
    expect(() => buildPublicSearchOccurrencePlan({
      tenancy,
      filters,
      rangeStart: new Date("2026-08-06T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-06T12:00:00.000Z"),
      cursor: null,
    })).toThrow("scoped attachment event ids");
  });

  it("binds attachment event discovery to tenant, project, and branch without selecting private storage data", () => {
    const filters = parsePublicSearchQuery({
      record: "event",
      attachment_filename: "screenshot",
      attachment_content_type: "image/png",
      attachment_type: "event.screenshot",
    });
    const query = buildPublicSearchAttachmentEventIdsQuery({
      tenancy: { id: "tenant-a", project: { id: "project-a" }, branchId: "branch-a" },
      filters,
    });
    const sql = query.strings.join("");
    expect(sql).toContain('FROM "ErrorAttachment"');
    expect(sql).toContain('"tenancyId" = ');
    expect(sql).toContain('"projectId" = ');
    expect(sql).toContain('"branchId" = ');
    expect(sql).toContain('LIMIT ');
    expect(sql).not.toContain('"storageKey"');
    expect(sql).not.toContain('"data"');
    expect(query.values).toContain("tenant-a");
    expect(query.values).toContain("project-a");
    expect(query.values).toContain("branch-a");
    expect(query.values).toContain("screenshot");
    expect(query.values).toContain("image/png");
    expect(query.values).toContain("event.screenshot");
  });

  it("builds bounded parameterized facet plans without interpolating tenant or event values", () => {
    const filters = parsePublicSearchQuery({
      record: "event",
      message: "' OR 1=1 --",
      facets: "tag:region",
    });
    const plan = buildPublicSearchFacetPlan({
      tenancy: { project: { id: "project-'unsafe" }, branchId: "branch-unsafe" },
      filters,
      facet: "tag:region",
      rangeStart: new Date("2026-08-06T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(plan.query).toContain("project_id = {projectId:String}");
    expect(plan.query).toContain("branch_id = {branchId:String}");
    expect(plan.query).toContain("GROUP BY facet_value");
    expect(plan.query).toContain("LIMIT {facetLimit:UInt32}");
    expect(plan.query).not.toContain("project-'unsafe");
    expect(plan.query).not.toContain("' OR 1=1 --");
    expect(plan.query_params).toMatchObject({
      projectId: "project-'unsafe",
      branchId: "branch-unsafe",
      messagePattern: "%' OR 1=1 --%",
      facetKey: "region",
      facetName: "tag:region",
      facetLimit: 10,
    });
  });

  it("keeps issue-hash discovery bounded and tenant scoped", () => {
    const filters = parsePublicSearchQuery({
      record: "issue",
      tag_key: "region",
      tag_value: "production",
    });
    const plan = buildPublicSearchIssueHashPlan({
      tenancy,
      filters,
      rangeStart: new Date("2026-08-06T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(plan.query).toContain("SELECT DISTINCT issue_hash AS issueHash");
    expect(plan.query).toContain("project_id = {projectId:String}");
    expect(plan.query).toContain("branch_id = {branchId:String}");
    expect(plan.query).toContain("LIMIT {resultLimit:UInt32}");
    expect(plan.query_params.resultLimit).toBe(1_001);
  });

  it("narrows issue-hash discovery to the scoped attachment event ids", () => {
    const filters = parsePublicSearchQuery({
      record: "issue",
      attachment_type: "event.screenshot",
    });
    const plan = buildPublicSearchIssueHashPlan({
      tenancy,
      filters,
      rangeStart: new Date("2026-08-06T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-06T12:00:00.000Z"),
      attachmentEventIds: ["d".repeat(32)],
    });

    expect(plan.query).toContain("attachmentEventIds:Array(String)");
    expect(plan.query).toContain("occurrence_id IN {attachmentEventIds:Array(String)}");
    expect(plan.query_params.attachmentEventIds).toEqual(["d".repeat(32)]);
  });

  it("returns an exact empty page without inventing a cursor", () => {
    const empty: PublicSearchRecord[] = [];
    expect(pagePublicSearchRecords(empty, 10)).toEqual({ items: [], hasMore: false });
  });
});
