import { describe, expect, it, vi } from "vitest";
import {
  issueFiltersToSavedIssueSearchQuery,
  savedIssueSearchQueryToIssueFilters,
  savedIssueSearchViewMutationForFilters,
  savedIssueSearchViewQueryIsCompatible,
  fetchSavedIssueSearchViews,
  createSavedIssueSearchView,
  updateSavedIssueSearchView,
  deleteSavedIssueSearchView,
  type SavedIssueSearchView,
} from "./issue-saved-views-data";
import {
  DEFAULT_ISSUE_FILTERS,
  serializeIssueFilters,
  type IssueFilters,
} from "./issue-filters";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";

// The data module reaches the backend through the admin app's internals
// symbol, so the test injects a fake `sendRequest` through that same seam
// instead of mocking the module. The real `sendInternalAdminRequest` runs,
// which also pins the "admin" request type in the call assertions.
const sendRequestMock = vi.fn();
const adminApp = { [hexclaveAppInternalsSymbol]: { sendRequest: sendRequestMock } };

const SAMPLE_VIEW: SavedIssueSearchView = {
  id: "11111111-1111-4111-8111-111111111111",
  schema_version: 1,
  name: "Production regressions",
  visibility: "project",
  owner_user_id: null,
  query: {
    version: 1,
    filters: {
      record: "issue",
      hours: "168",
      limit: "50",
      status: "resolved",
      service: "api",
      environment: "staging",
      handled: "false",
      message: "timeout",
    },
  },
  created_at_millis: 1_700_000_000_000,
  updated_at_millis: 1_700_000_000_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("dashboard saved issue search view data", () => {
  it("round-trips the issue URL filters into the bounded saved-view shape", () => {
    const filters: IssueFilters = {
      hours: 168,
      status: "resolved",
      service: { namespace: "backend", name: "api" },
      environment: "staging",
      handled: "unhandled",
      search: "timeout",
    };
    expect(issueFiltersToSavedIssueSearchQuery(filters)).toEqual({
      version: 1,
      filters: {
        record: "issue",
        hours: "168",
        limit: "50",
        status: "resolved",
        service: "api",
        environment: "staging",
        handled: "false",
        message: "timeout",
      },
    });
    expect(savedIssueSearchQueryToIssueFilters(issueFiltersToSavedIssueSearchQuery(filters))).toEqual({
      ...filters,
      service: { namespace: "", name: "api" },
    });
  });

  it("does not let applying a view discard grid URL state", () => {
    const applied = savedIssueSearchQueryToIssueFilters(SAMPLE_VIEW.query);
    const params = new URLSearchParams("issues_s=events:desc&issues_h=release&issues_p=cursor");
    serializeIssueFilters(applied, params);
    expect(params.get("issues_s")).toBe("events:desc");
    expect(params.get("issues_h")).toBe("release");
    expect(params.get("issues_p")).toBe("cursor");
    expect(params.get("range")).toBe("168");
    expect(params.get("status")).toBe("resolved");
  });

  it("fails closed for saved queries outside the issue-list vocabulary", () => {
    expect(savedIssueSearchViewQueryIsCompatible(SAMPLE_VIEW.query)).toBe(true);
    expect(savedIssueSearchViewQueryIsCompatible({
      version: 1,
      filters: { record: "issue", hours: "3", limit: "50" },
    })).toBe(false);
    expect(savedIssueSearchQueryToIssueFilters({
      version: 1,
      filters: { record: "issue", hours: "not-a-range", limit: "50" },
    })).toEqual(DEFAULT_ISSUE_FILTERS);
  });

  it("uses the admin internal route family for bounded CRUD", async () => {
    sendRequestMock
      .mockResolvedValueOnce(jsonResponse({ items: [SAMPLE_VIEW], has_more: false }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_VIEW, 201))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_VIEW))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(fetchSavedIssueSearchViews(adminApp)).resolves.toEqual([SAMPLE_VIEW]);
    await expect(createSavedIssueSearchView(adminApp, savedIssueSearchViewMutationForFilters("Errors", DEFAULT_ISSUE_FILTERS))).resolves.toEqual(SAMPLE_VIEW);
    await expect(updateSavedIssueSearchView(adminApp, SAMPLE_VIEW.id, savedIssueSearchViewMutationForFilters("Updated", DEFAULT_ISSUE_FILTERS))).resolves.toEqual(SAMPLE_VIEW);
    await expect(deleteSavedIssueSearchView(adminApp, SAMPLE_VIEW.id)).resolves.toBeUndefined();

    expect(sendRequestMock.mock.calls.map(([path, request, requestType]) => [path, request.method, requestType])).toEqual([
      ["/internal/issues/search-views?limit=100", "GET", "admin"],
      ["/internal/issues/search-views", "POST", "admin"],
      [`/internal/issues/search-views/${SAMPLE_VIEW.id}`, "PUT", "admin"],
      [`/internal/issues/search-views/${SAMPLE_VIEW.id}`, "DELETE", "admin"],
    ]);
  });
});
