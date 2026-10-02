import { describe, expect, it } from "vitest";
import type { IssueListItem } from "@hexclave/shared/dist/interface/admin-issues";
import { encodeIssueCursor, encodeOccurrenceCursor } from "@/lib/issues/issue-queries";
import {
  PublicIssueSchema,
  parsePublicIssueDetailQuery,
  parsePublicIssueHours,
  parsePublicIssueListQuery,
  parsePublicIssueOccurrencesQuery,
  toPublicIssue,
} from "./contract";

const ISSUE_ID = "00000000-0000-4000-8000-000000000001";

describe("public issue read routes", () => {
  it("accepts the list happy path and binds the cursor to its sort order", () => {
    const cursor = encodeIssueCursor({
      sortValueMillis: 1_754_502_400_000,
      id: ISSUE_ID,
      sort: "first_seen",
      sortDir: "asc",
    });

    expect(parsePublicIssueListQuery({
      hours: "168",
      status: "all",
      service: " api ",
      environment: "production",
      handled: "unhandled",
      search: "database",
      sort: "first_seen",
      sort_dir: "asc",
      cursor,
      limit: "10",
    })).toEqual({
      hours: 168,
      status: "all",
      serviceName: "api",
      environment: "production",
      handled: false,
      search: "database",
      sort: "first_seen",
      sortDir: "asc",
      cursor,
      limit: 10,
    });
  });

  it("rejects malformed and cross-sort cursors instead of silently restarting at page one", () => {
    expect(() => parsePublicIssueListQuery({ cursor: "not-a-cursor" })).toThrow("cursor is invalid");

    const cursor = encodeIssueCursor({
      sortValueMillis: 1_754_502_400_000,
      id: ISSUE_ID,
      sort: "first_seen",
      sortDir: "asc",
    });
    expect(() => parsePublicIssueListQuery({ sort: "last_seen", sort_dir: "asc", cursor })).toThrow("different sort order");
    expect(() => parsePublicIssueListQuery({ sort: "events", cursor })).toThrow("not supported");
  });

  it("accepts occurrence pagination and rejects a direction without a position", () => {
    const cursor = encodeOccurrenceCursor({
      eventAtMillis: 1_754_502_400_000,
      occurrenceId: "a".repeat(64),
    });
    expect(parsePublicIssueOccurrencesQuery({ cursor, direction: "newer", limit: "2" })).toEqual({
      cursor: {
        eventAtMillis: 1_754_502_400_000,
        occurrenceId: "a".repeat(64),
      },
      direction: "newer",
      limit: 2,
    });
    expect(() => parsePublicIssueDetailQuery({ direction: "newer" })).toThrow("requires an occurrence cursor");
  });

  it("projects the dashboard item without exposing internal hashes or truncation state", async () => {
    const dashboardItem = {
      id: ISSUE_ID,
      short_id: "42",
      type: "Error",
      value: "Database unavailable",
      culprit: "loadDashboard",
      level: "error",
      status: "unresolved",
      substatus: "ongoing",
      first_seen_at_millis: 1_754_400_000_000,
      last_seen_at_millis: 1_754_502_400_000,
      times_seen: "12",
      counters_truncated_at_millis: null,
      window_occurrences: 5,
      window_users: 2,
      service_name: "api",
      environment: "production",
      release: "release-1",
      handled: true,
      synthetic: false,
      updated_at_millis: 1_754_502_400_000,
      issue_hashes: ["private-hash"],
    } satisfies IssueListItem;

    const publicIssue = toPublicIssue(dashboardItem);
    await PublicIssueSchema.validate(publicIssue);
    expect(publicIssue).not.toHaveProperty("issue_hashes");
    expect(publicIssue).not.toHaveProperty("counters_truncated_at_millis");
    expect(publicIssue).toMatchObject({
      id: ISSUE_ID,
      short_id: "42",
      window_occurrences: 5,
      window_users: 2,
    });
  });

  it("scrubs issue identity text before returning a public projection", () => {
    const publicIssue = toPublicIssue({
      id: ISSUE_ID,
      short_id: "42",
      type: "Error",
      value: "Authorization: Bearer hidden",
      culprit: "https://example.test/path?token=hidden",
      level: "error",
      status: "unresolved",
      substatus: "ongoing",
      first_seen_at_millis: 1,
      last_seen_at_millis: 2,
      times_seen: "2",
      counters_truncated_at_millis: null,
      window_occurrences: 1,
      window_users: 1,
      service_name: null,
      environment: null,
      release: null,
      handled: true,
      synthetic: false,
      updated_at_millis: 2,
      issue_hashes: [],
    });

    expect(publicIssue.value).toBe("Authorization: Bearer [Filtered]");
    expect(publicIssue.culprit).toBe("https://example.test/path?token=[Filtered]");
  });
});

describe("parsePublicIssueHours", () => {
  it("accepts every allowlisted range and defaults to 24h when omitted", () => {
    expect(parsePublicIssueHours(undefined)).toBe(24);
    expect(parsePublicIssueHours("1")).toBe(1);
    expect(parsePublicIssueHours("24")).toBe(24);
    expect(parsePublicIssueHours("168")).toBe(168);
    expect(parsePublicIssueHours("720")).toBe(720);
  });

  it("rejects anything off the allowlist with a 400 instead of silently defaulting", () => {
    for (const raw of ["0", "-24", "25", "9999", "banana", ""]) {
      expect(() => parsePublicIssueHours(raw)).toThrowError(/hours must be one of/);
    }
  });
});
