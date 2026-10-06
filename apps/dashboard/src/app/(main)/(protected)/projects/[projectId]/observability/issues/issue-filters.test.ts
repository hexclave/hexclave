import { describe, expect, it } from "vitest";
import { DEFAULT_OBSERVABILITY_TIME_RANGE_HOURS } from "../filters";
import {
  ALL_STATUSES_FILTER_VALUE,
  DEFAULT_ISSUE_FILTERS,
  DEFAULT_ISSUE_SORT,
  isSortableIssueColumn,
  issueFiltersAreDefault,
  parseIssueFilters,
  parseIssueRangeHours,
  resolveIssueSort,
  serializeIssueFilters,
  type IssueFilters,
} from "./issue-filters";
import { issueDetailHref } from "./issue-links";

function roundTrip(filters: IssueFilters): IssueFilters {
  return parseIssueFilters(serializeIssueFilters(filters, new URLSearchParams()));
}

describe("issue filter defaults", () => {
  it("opens on 24h, not on Logs' 30d", () => {
    expect(DEFAULT_ISSUE_FILTERS.hours).toBe(24);
    expect(DEFAULT_ISSUE_FILTERS.hours).toBe(DEFAULT_OBSERVABILITY_TIME_RANGE_HOURS);
  });

  it("opens on Unresolved and on ALL handledness", () => {
    expect(DEFAULT_ISSUE_FILTERS.status).toBe("unresolved");
    expect(DEFAULT_ISSUE_FILTERS.handled).toBe("all");
  });

  it("serializes to an empty query string", () => {
    expect(serializeIssueFilters(DEFAULT_ISSUE_FILTERS, new URLSearchParams()).toString()).toBe("");
    expect(issueFiltersAreDefault(DEFAULT_ISSUE_FILTERS)).toBe(true);
  });
});

describe("parse / serialize round trip", () => {
  it("preserves every non-default filter", () => {
    const filters: IssueFilters = {
      hours: 168,
      status: "resolved",
      service: { namespace: "backend", name: "api" },
      environment: "staging",
      handled: "unhandled",
      search: "cannot read properties",
    };
    expect(roundTrip(filters)).toEqual(filters);
    expect(issueFiltersAreDefault(filters)).toBe(false);
  });

  it("supports the all-statuses tab", () => {
    const filters: IssueFilters = { ...DEFAULT_ISSUE_FILTERS, status: ALL_STATUSES_FILTER_VALUE };
    expect(roundTrip(filters).status).toBe(ALL_STATUSES_FILTER_VALUE);
  });

  it("leaves unrelated params (e.g. the grid's) untouched", () => {
    const params = new URLSearchParams("issues_s=events:desc&issues_h=release");
    serializeIssueFilters({ ...DEFAULT_ISSUE_FILTERS, hours: 720 }, params);
    expect(params.get("issues_s")).toBe("events:desc");
    expect(params.get("issues_h")).toBe("release");
    expect(params.get("range")).toBe("720");
  });

  it("deletes a param when its filter returns to the default", () => {
    const params = new URLSearchParams("range=720&status=ignored&handled=handled");
    serializeIssueFilters(DEFAULT_ISSUE_FILTERS, params);
    expect(params.toString()).toBe("");
  });

  it("treats whitespace-only search as the default", () => {
    const filters: IssueFilters = { ...DEFAULT_ISSUE_FILTERS, search: "   " };
    expect(serializeIssueFilters(filters, new URLSearchParams()).toString()).toBe("");
    expect(issueFiltersAreDefault(filters)).toBe(true);
    expect(serializeIssueFilters({ ...DEFAULT_ISSUE_FILTERS, search: "boom " }, new URLSearchParams()).get("search"))
      .toBe("boom ");
  });
});

describe("parseIssueFilters treats the URL as untrusted", () => {
  it("falls back to defaults for unknown values instead of throwing", () => {
    const parsed = parseIssueFilters(new URLSearchParams(
      "range=3&status=archived&handled=maybe&service=nonsense&environment=",
    ));
    expect(parsed).toEqual(DEFAULT_ISSUE_FILTERS);
  });

  it("survives a service value with broken percent-encoding", () => {
    expect(parseIssueFilters(new URLSearchParams("service=svc%3A%E0%A4%A")).service).toBeNull();
  });
});

describe("parseIssueRangeHours (the one filter the detail page shares)", () => {
  it("reads an allowlisted range", () => {
    expect(parseIssueRangeHours(new URLSearchParams("range=168"))).toBe(168);
  });

  it("falls back to the default for missing or unknown values", () => {
    expect(parseIssueRangeHours(new URLSearchParams())).toBe(DEFAULT_ISSUE_FILTERS.hours);
    expect(parseIssueRangeHours(new URLSearchParams("range=999"))).toBe(DEFAULT_ISSUE_FILTERS.hours);
    expect(parseIssueRangeHours(new URLSearchParams("range=banana"))).toBe(DEFAULT_ISSUE_FILTERS.hours);
  });

  it("agrees with parseIssueFilters on the same URL", () => {
    const params = new URLSearchParams("range=720");
    expect(parseIssueRangeHours(params)).toBe(parseIssueFilters(params).hours);
  });

  it("round-trips the range a detail link carries", () => {
    const href = issueDetailHref("p1", "42", { rangeHours: 720 });
    expect(parseIssueRangeHours(new URL(href, "http://localhost").searchParams)).toBe(720);
  });

  it("omits the param entirely at the default range", () => {
    expect(issueDetailHref("p1", "42", { rangeHours: DEFAULT_ISSUE_FILTERS.hours })).toBe("/projects/p1/observability/issues/42");
    expect(issueDetailHref("p1", "42")).toBe("/projects/p1/observability/issues/42");
  });
});

describe("resolveIssueSort", () => {
  it("only accepts the four window/lifetime columns", () => {
    expect(resolveIssueSort([{ columnId: "events", direction: "desc" }]))
      .toEqual({ field: "events", direction: "desc" });
    expect(resolveIssueSort([{ columnId: "users", direction: "asc" }]))
      .toEqual({ field: "users", direction: "asc" });
    expect(resolveIssueSort([{ columnId: "lastSeen", direction: "desc" }]))
      .toEqual({ field: "last_seen", direction: "desc" });
    expect(resolveIssueSort([{ columnId: "firstSeen", direction: "asc" }]))
      .toEqual({ field: "first_seen", direction: "asc" });
  });

  it("refuses to sort by columns that span two stores", () => {
    expect(isSortableIssueColumn("issue")).toBe(false);
    expect(isSortableIssueColumn("status")).toBe(false);
    expect(isSortableIssueColumn("graph")).toBe(false);
    expect(isSortableIssueColumn("environment")).toBe(false);
    expect(resolveIssueSort([{ columnId: "issue", direction: "asc" }])).toEqual(DEFAULT_ISSUE_SORT);
  });

  it("defaults to most-recently-seen first", () => {
    expect(resolveIssueSort([])).toEqual({ field: "last_seen", direction: "desc" });
  });
});
