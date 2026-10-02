import { describe, expect, it } from "vitest";
import { encodePublicSearchCursor } from "../public-search/cursor";
import {
  SAVED_ISSUE_SEARCH_QUERY_MAX_BYTES,
  applySavedIssueSearchCursor,
  parseSavedIssueSearchQuery,
  parseSavedIssueSearchViewMutation,
} from "./contract";

const ACTOR_USER_ID = "11111111-1111-4111-8111-111111111111";

function issueQuery(filters: Record<string, string> = {}) {
  return {
    version: 1,
    filters: {
      record: "issue",
      hours: "24",
      limit: "10",
      ...filters,
    },
  };
}

describe("saved issue search contract", () => {
  it("canonicalizes the public-search filters and keeps cursors out of storage", () => {
    const query = parseSavedIssueSearchQuery(issueQuery({
      status: "unresolved",
      handled: "1",
      facets: "status,service",
    }));

    expect(query).toEqual({
      version: 1,
      filters: {
        record: "issue",
        hours: "24",
        limit: "10",
        status: "unresolved",
        handled: "true",
        facets: "status,service",
      },
    });
    expect(applySavedIssueSearchCursor(query, null)).toMatchObject({
      record: "issue",
      hours: 24,
      limit: 10,
      status: "unresolved",
      handled: true,
      cursor: null,
    });
  });

  it("restores cursor validation only at execution time", () => {
    const query = parseSavedIssueSearchQuery(issueQuery());
    const filters = applySavedIssueSearchCursor(query, null);
    const cursor = encodePublicSearchCursor({
      projectId: "project-a",
      branchId: "main",
      filters,
      position: {
        kind: "issue",
        lastSeenAtMillis: 100,
        issueId: "22222222-2222-4222-8222-222222222222",
      },
    }, "saved-view-test-secret");

    expect(() => applySavedIssueSearchCursor(query, cursor)).not.toThrow();
    expect(() => parseSavedIssueSearchQuery(issueQuery({ cursor }))).toThrow("cannot be persisted");
  });

  it("rejects malformed filters instead of silently widening the search", () => {
    expect(() => parseSavedIssueSearchQuery(issueQuery({ tag_key: "service" }))).toThrow("provided together");
    expect(() => parseSavedIssueSearchQuery(issueQuery({ unsupported: "value" }))).toThrow("unsupported saved issue search filter");
    expect(() => parseSavedIssueSearchQuery({ version: 1, filters: { status: 1 } })).toThrow("only strings");
    expect(() => parseSavedIssueSearchQuery({ version: 2, filters: {} })).toThrow("version must be 1");
  });

  it("rejects oversized query documents before public-search parsing", () => {
    const oversizedMessage = "x".repeat(SAVED_ISSUE_SEARCH_QUERY_MAX_BYTES);
    expect(() => parseSavedIssueSearchQuery(issueQuery({ message: oversizedMessage }))).toThrow("at most");
  });

  it("normalizes deterministic names and rejects caller-supplied scope or owner fields", () => {
    const mutation = parseSavedIssueSearchViewMutation({
      name: "  Error Search  ",
      visibility: "project",
      query: issueQuery(),
    }, null);
    expect(mutation.name).toBe("Error Search");
    expect(mutation.nameKey).toBe("error search");

    expect(() => parseSavedIssueSearchViewMutation({
      name: "Error Search",
      visibility: "project",
      query: issueQuery(),
      project_id: "other-project",
    }, ACTOR_USER_ID)).toThrow("only contain name, visibility, and query");
    expect(() => parseSavedIssueSearchViewMutation({
      name: "Error: Search",
      visibility: "project",
      query: issueQuery(),
    }, ACTOR_USER_ID)).toThrow("contain only");
  });

  it("requires an authenticated owner for private views", () => {
    expect(() => parseSavedIssueSearchViewMutation({
      name: "My Errors",
      visibility: "private",
      query: issueQuery(),
    }, null)).toThrow("require an authenticated user");
    expect(() => parseSavedIssueSearchViewMutation({
      name: "My Errors",
      visibility: "private",
      query: issueQuery(),
    }, "not-a-uuid")).toThrow("owner is invalid");
  });

  it("allows an explicitly authorized admin update to retain a private owner", () => {
    expect(() => parseSavedIssueSearchViewMutation({
      name: "Private Errors",
      visibility: "private",
      query: issueQuery(),
    }, null, { allowPrivateWithoutActor: true })).not.toThrow();
  });
});
