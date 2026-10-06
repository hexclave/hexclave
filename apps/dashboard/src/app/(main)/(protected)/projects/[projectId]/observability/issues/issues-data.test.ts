import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDetailResponseSchema } from "@hexclave/shared/dist/interface/admin-issues";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { OBSERVABILITY_TIME_RANGES } from "../filters";
import {
  buildIssueListQueryString,
  getIssueFacetsQuery,
  getIssueSparklineQuery,
  parseIssueFacetRows,
  parseIssueSparklineRows,
  setIssueAssignee,
  setIssueBookmarkState,
  setIssueOwnerState,
  clearManualIssueOwnerState,
  setIssueSubscriptionState,
  setIssueTeam,
  updateIssueAssignment,
  updateIssueBookmark,
  updateIssueOwner,
  clearManualIssueOwners,
  updateIssueSubscription,
  updateIssueTeam,
  mergeIssues,
  unmergeIssue,
  snoozeIssue,
  unsnoozeIssue,
  regressIssue,
  searchPublicIssues,
  updateIssuesStatusBulk,
  type IssueListRequest,
} from "./issues-data";

// The data module reaches the backend through the admin app's internals
// symbol, so the test injects a fake `sendRequest` through that same seam
// instead of mocking the module. The real `sendInternalAdminRequest` runs,
// which also pins the "admin" request type in the call assertions.
const sendRequestMock = vi.fn();

const SAMPLE_HASH_A = "0123456789abcdef0123456789abcdef";
const SAMPLE_HASH_B = "fedcba9876543210fedcba9876543210";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const TEAM_ID = "00000000-0000-4000-8000-000000000002";
const ISSUE_ID = "00000000-0000-4000-8000-000000000003";
const adminApp = { projectId: "project-1", [hexclaveAppInternalsSymbol]: { sendRequest: sendRequestMock } };

const detail = IssueDetailResponseSchema.validateSync({
  issue: {
    id: ISSUE_ID, short_id: "1", type: "TypeError", value: "boom", culprit: "app.ts",
    level: "error", status: "unresolved", substatus: "ongoing", first_seen_at_millis: 1,
    last_seen_at_millis: 2, times_seen: "3", counters_truncated_at_millis: null,
    window_occurrences: 3, window_users: 1, service_name: "web", environment: "production",
    release: null, handled: false, synthetic: false, updated_at_millis: 2, issue_hashes: [SAMPLE_HASH_A],
  },
  occurrence: null,
  newer_cursor: null,
  older_cursor: null,
  release_context: { first_release: null, last_release: null, release_commits: [], suspect_commits: [] },
  redirected_from_issue_id: null,
  product: {
    priority: null,
    assignee_user_id: null,
    team_id: null,
    owners: [],
    activities: [],
    comments: [],
    subscriptions: [],
    bookmarked_user_ids: [],
  },
});

beforeEach(() => {
  sendRequestMock.mockReset();
});

describe("getIssueSparklineQuery", () => {
  it("binds the hashes as a parameter instead of interpolating them", () => {
    const { query, params } = getIssueSparklineQuery(24, [SAMPLE_HASH_A, SAMPLE_HASH_B]);
    expect(query).toContain("issue_hash IN {issueHashes:Array(String)}");
    expect(query).not.toContain(SAMPLE_HASH_A);
    expect(params.issueHashes).toEqual([SAMPLE_HASH_A, SAMPLE_HASH_B]);
  });

  it("reads the errors view and bounds the scan by the selected range", () => {
    expect(getIssueSparklineQuery(24, [SAMPLE_HASH_A]).query).toContain("FROM default.errors");
    for (const range of OBSERVABILITY_TIME_RANGES) {
      expect(getIssueSparklineQuery(range.hours, [SAMPLE_HASH_A]).query)
        .toContain(`event_at >= now64(3) - INTERVAL ${range.hours} HOUR`);
    }
  });

  it("throws for an hours value outside the shared range set", () => {
    expect(() => getIssueSparklineQuery(3, [SAMPLE_HASH_A])).toThrow(/Unknown issues time range/);
    expect(() => getIssueSparklineQuery(0, [SAMPLE_HASH_A])).toThrow(/Unknown issues time range/);
  });

  it("refuses to build a query for zero hashes, which would scan every error", () => {
    expect(() => getIssueSparklineQuery(24, [])).toThrow(/zero hashes/);
  });
});

describe("getIssueFacetsQuery", () => {
  it("groups services and environments together in one query", () => {
    const { query } = getIssueFacetsQuery(168);
    expect(query).toContain("FROM default.errors");
    expect(query).toContain("GROUP BY service_namespace, service_name, deployment_environment_name");
    expect(query).toContain("event_at >= now64(3) - INTERVAL 168 HOUR");
  });

  it("throws for an unknown range", () => {
    expect(() => getIssueFacetsQuery(999)).toThrow(/Unknown issues time range/);
  });
});

describe("parseIssueSparklineRows", () => {
  const NOW_MS = Date.parse("2026-07-31T12:30:00.000Z");
  const LATEST_BUCKET_MS = Date.parse("2026-07-31T12:00:00.000Z");
  const EARLIEST_BUCKET_MS = LATEST_BUCKET_MS - 23 * 3_600_000;

  it("returns a dense zero-filled grid for a requested hash with no occurrences", () => {
    const parsed = parseIssueSparklineRows([], [SAMPLE_HASH_A, SAMPLE_HASH_B], 24, NOW_MS);
    const series = parsed.get(SAMPLE_HASH_A);
    expect(series).toHaveLength(24);
    expect(series?.[0]).toEqual({ bucketMs: EARLIEST_BUCKET_MS, occurrences: 0 });
    expect(series?.[23]).toEqual({ bucketMs: LATEST_BUCKET_MS, occurrences: 0 });
    expect(series?.every((bucket) => bucket.occurrences === 0)).toBe(true);
    expect(parsed.get(SAMPLE_HASH_B)).toHaveLength(24);
  });

  it("places parsed rows onto the grid, leaving gaps at zero", () => {
    const parsed = parseIssueSparklineRows(
      [{ issue_hash: SAMPLE_HASH_A, bucket_start: "2026-07-31 12:00:00.000", occurrences: "17" }],
      [SAMPLE_HASH_A],
      24,
      NOW_MS,
    );
    const series = parsed.get(SAMPLE_HASH_A);
    expect(series?.[23]).toEqual({ bucketMs: LATEST_BUCKET_MS, occurrences: 17 });
    expect(series?.filter((bucket) => bucket.occurrences !== 0)).toHaveLength(1);
  });

  it("anchors the grid to ClickHouse time when the browser clock differs", () => {
    const parsed = parseIssueSparklineRows(
      [{
        issue_hash: SAMPLE_HASH_A,
        bucket_start: "2026-07-31 14:00:00.000",
        occurrences: 3,
        query_now: "2026-07-31 14:30:00.000",
      }],
      [SAMPLE_HASH_A],
      24,
      NOW_MS,
    );
    const series = parsed.get(SAMPLE_HASH_A);
    expect(series?.[23]).toEqual({
      bucketMs: Date.parse("2026-07-31T14:00:00.000Z"),
      occurrences: 3,
    });
  });

  it("drops the clipped partial bucket outside the grid instead of misplacing it", () => {
    const beforeEarliest = new Date(EARLIEST_BUCKET_MS - 3_600_000).toISOString().replace("T", " ").replace("Z", "");
    const parsed = parseIssueSparklineRows(
      [{ issue_hash: SAMPLE_HASH_A, bucket_start: beforeEarliest, occurrences: 5 }],
      [SAMPLE_HASH_A],
      24,
      NOW_MS,
    );
    expect(parsed.get(SAMPLE_HASH_A)?.every((bucket) => bucket.occurrences === 0)).toBe(true);
  });

  it("throws when a row carries a hash nobody asked for", () => {
    expect(() => parseIssueSparklineRows(
      [{ issue_hash: SAMPLE_HASH_B, bucket_start: "2026-07-31 12:00:00.000", occurrences: 1 }],
      [SAMPLE_HASH_A],
      24,
      NOW_MS,
    )).toThrow(/unrequested issue hash/);
  });

  it("throws on a bucket that is not aligned to the grid", () => {
    expect(() => parseIssueSparklineRows(
      [{ issue_hash: SAMPLE_HASH_A, bucket_start: "2026-07-31 11:30:00.000", occurrences: 1 }],
      [SAMPLE_HASH_A],
      24,
      NOW_MS,
    )).toThrow(/not aligned/);
  });
});

describe("parseIssueFacetRows", () => {
  it("de-duplicates services and drops empty environments", () => {
    const facets = parseIssueFacetRows([
      { service_namespace: null, service_name: "web", deployment_environment_name: "production" },
      { service_namespace: null, service_name: "web", deployment_environment_name: "staging" },
      { service_namespace: null, service_name: "", deployment_environment_name: "" },
    ]);
    expect(facets.services).toHaveLength(1);
    expect(facets.environments).toEqual(["production", "staging"]);
  });
});

describe("buildIssueListQueryString", () => {
  const request: IssueListRequest = {
    hours: 24,
    status: "unresolved",
    service: null,
    environment: null,
    handled: "all",
    search: "",
    sort: "last_seen",
    sortDir: "desc",
    cursor: null,
    limit: 50,
  };

  it("sends the filter values the endpoint's parsers actually accept", () => {
    const params = new URLSearchParams(buildIssueListQueryString({
      ...request,
      status: "all",
      handled: "unhandled",
      environment: "staging",
    }));
    expect(params.get("status")).toBe("all");
    expect(params.get("handled")).toBe("unhandled");
    expect(params.get("environment")).toBe("staging");
    expect(params.get("hours")).toBe("24");
    expect(params.get("sort")).toBe("last_seen");
    expect(params.get("sort_dir")).toBe("desc");
  });

  it("narrows a namespaced service identity to the name the endpoint filters on", () => {
    const params = new URLSearchParams(buildIssueListQueryString({
      ...request,
      service: { namespace: "backend", name: "api" },
    }));
    expect(params.get("service")).toBe("api");
    expect(params.get("service_namespace")).toBeNull();
  });

  it("never asks for more than the server's page size", () => {
    const params = new URLSearchParams(buildIssueListQueryString({ ...request, limit: 5000 }));
    expect(params.get("limit")).toBe("50");
  });

  it("omits an empty search rather than sending a blank filter", () => {
    expect(new URLSearchParams(buildIssueListQueryString(request)).get("search")).toBeNull();
    expect(new URLSearchParams(buildIssueListQueryString({ ...request, search: "boom" })).get("search")).toBe("boom");
  });
});

describe("issue triage action helpers", () => {
  it("validates and posts bounded bulk status changes with per-item outcomes", async () => {
    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      status: "resolved",
      results: [{
        input_issue_id: ISSUE_ID,
        action: "resolve",
        issue_id: ISSUE_ID,
        redirected: false,
        redirected_from_issue_id: null,
        changed: true,
        changed_at_millis: 10,
        status: "resolved",
        transition_kind: "status_changed",
        ignored_until_millis: null,
        regressed_at_millis: null,
        error: null,
      }],
    }), { status: 200 }));

    await expect(updateIssuesStatusBulk(adminApp, [ISSUE_ID], "resolved"))
      .resolves.toMatchObject({ status: "resolved", results: [{ issue_id: ISSUE_ID, changed: true }] });
    expect(sendRequestMock).toHaveBeenCalledWith(
      "/issues/actions/bulk",
      expect.objectContaining({ body: JSON.stringify({ issue_ids: [ISSUE_ID], status: "resolved" }) }),
      "admin",
    );

    await expect(updateIssuesStatusBulk(adminApp, [ISSUE_ID, ISSUE_ID], "resolved"))
      .rejects.toThrow(/duplicates/);
    expect(sendRequestMock).toHaveBeenCalledTimes(1);
  });

  it("validates and posts a merge of two or more issues", async () => {
    const otherIssueId = "00000000-0000-4000-8000-000000000004";
    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      primary_issue_id: ISSUE_ID,
      merged_issue_ids: [otherIssueId],
    }), { status: 200 }));

    await expect(mergeIssues(adminApp, [ISSUE_ID, otherIssueId])).resolves.toMatchObject({
      primary_issue_id: ISSUE_ID,
      merged_issue_ids: [otherIssueId],
    });
    expect(sendRequestMock).toHaveBeenCalledWith(
      "/internal/issues/merge",
      expect.objectContaining({
        body: JSON.stringify({ issue_ids: [ISSUE_ID, otherIssueId] }),
      }),
      "admin",
    );

    await expect(mergeIssues(adminApp, [ISSUE_ID])).rejects.toThrow(/at least 2/);
    expect(sendRequestMock).toHaveBeenCalledTimes(1);
  });

  it("validates and posts unmerge, snooze, unsnooze, and regress", async () => {
    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      source_issue_id: ISSUE_ID,
      new_issue_id: "00000000-0000-4000-8000-000000000006",
      counters_truncated_at_millis: 10,
    }), { status: 200 }));
    await expect(unmergeIssue(adminApp, ISSUE_ID, [SAMPLE_HASH_A])).resolves.toMatchObject({
      source_issue_id: ISSUE_ID,
    });
    expect(sendRequestMock).toHaveBeenCalledWith(
      `/internal/issues/${ISSUE_ID}/unmerge`,
      expect.objectContaining({ body: JSON.stringify({ hashes: [SAMPLE_HASH_A] }) }),
      "admin",
    );

    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      action: "snooze", issue_id: ISSUE_ID, redirected: false, redirected_from_issue_id: null,
      changed: true, changed_at_millis: 10, status: "ignored", previous_assignee_user_id: null,
      assignee_user_id: null, transition_kind: "status_changed", ignored_until_millis: 99, regressed_at_millis: null,
    }), { status: 200 }));
    await expect(snoozeIssue(adminApp, ISSUE_ID, Date.now() + 60_000)).resolves.toMatchObject({ action: "snooze", status: "ignored" });

    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      action: "unsnooze", issue_id: ISSUE_ID, redirected: false, redirected_from_issue_id: null,
      changed: true, changed_at_millis: 11, status: "unresolved", previous_assignee_user_id: null,
      assignee_user_id: null, transition_kind: "reopened", ignored_until_millis: null, regressed_at_millis: null,
    }), { status: 200 }));
    await expect(unsnoozeIssue(adminApp, ISSUE_ID)).resolves.toMatchObject({ action: "unsnooze" });

    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      action: "regress", issue_id: ISSUE_ID, redirected: false, redirected_from_issue_id: null,
      changed: true, changed_at_millis: 12, status: "unresolved", previous_assignee_user_id: null,
      assignee_user_id: null, transition_kind: "regressed", ignored_until_millis: null, regressed_at_millis: 12,
    }), { status: 200 }));
    await expect(regressIssue(adminApp, ISSUE_ID)).resolves.toMatchObject({ action: "regress", transition_kind: "regressed" });
  });

  it("validates and posts self-assignment and unassignment through their typed routes", async () => {
    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      action: "assign", issue_id: ISSUE_ID, redirected: false, redirected_from_issue_id: null,
      changed: true, changed_at_millis: 10, status: null, previous_assignee_user_id: null,
      assignee_user_id: USER_ID, transition_kind: null, ignored_until_millis: null, regressed_at_millis: null,
    }), { status: 200 }));

    await expect(updateIssueAssignment(adminApp, ISSUE_ID, USER_ID)).resolves.toMatchObject({ assignee_user_id: USER_ID });
    expect(sendRequestMock).toHaveBeenCalledWith(`/issues/${ISSUE_ID}/actions/assign`, expect.objectContaining({ body: JSON.stringify({ assignee_user_id: USER_ID }) }), "admin");

    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      action: "unassign", issue_id: ISSUE_ID, redirected: false, redirected_from_issue_id: null,
      changed: true, changed_at_millis: 11, status: null, previous_assignee_user_id: USER_ID,
      assignee_user_id: null, transition_kind: null, ignored_until_millis: null, regressed_at_millis: null,
    }), { status: 200 }));
    await expect(updateIssueAssignment(adminApp, ISSUE_ID, null)).resolves.toMatchObject({ assignee_user_id: null });
    expect(sendRequestMock).toHaveBeenCalledWith(`/issues/${ISSUE_ID}/actions/unassign`, expect.objectContaining({ body: "{}" }), "admin");
  });

  it("validates team assignment and keeps tenant/action errors visible", async () => {
    sendRequestMock.mockResolvedValue(new Response("private tenant detail", { status: 409 }));
    await expect(updateIssueTeam(adminApp, ISSUE_ID, TEAM_ID)).rejects.toThrow("Updating issue team failed with status 409");
    await expect(updateIssueTeam(adminApp, ISSUE_ID, "not-a-uuid")).rejects.toThrow("Team ID must be a UUID");
  });

  it("posts ownership with bounded null context and rejects invalid subjects", async () => {
    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      issue_id: ISSUE_ID, id: "00000000-0000-4000-8000-000000000004", type: "user",
      user_id: USER_ID, team_id: null, source: "manual", context: null, updated_at_millis: 12,
    }), { status: 200 }));
    await expect(updateIssueOwner(adminApp, ISSUE_ID, { type: "user", userId: USER_ID, teamId: null })).resolves.toMatchObject({ user_id: USER_ID });
    expect(sendRequestMock).toHaveBeenCalledWith(`/issues/${ISSUE_ID}/actions/owner`, expect.objectContaining({ body: JSON.stringify({ type: "user", user_id: USER_ID, team_id: null, source: "manual", context: null }) }), "admin");
    await expect(updateIssueOwner(adminApp, ISSUE_ID, { type: "user", userId: null, teamId: null })).rejects.toThrow("A user owner requires only a user ID");

    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      issue_id: ISSUE_ID, deleted_count: 1, updated_at_millis: 13,
    }), { status: 200 }));
    await expect(clearManualIssueOwners(adminApp, ISSUE_ID)).resolves.toBeUndefined();
    expect(sendRequestMock).toHaveBeenCalledWith(`/issues/${ISSUE_ID}/actions/owner`, { method: "DELETE" }, "admin");
  });

  it("posts bookmark and subscription changes for the authenticated subject", async () => {
    sendRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ issue_id: ISSUE_ID, user_id: USER_ID, bookmarked: true, changed: true, changed_at_millis: 13 }), { status: 200 }));
    await expect(updateIssueBookmark(adminApp, ISSUE_ID, USER_ID, true, "bookmark-1")).resolves.toMatchObject({ bookmarked: true });
    expect(sendRequestMock).toHaveBeenCalledWith(`/issues/${ISSUE_ID}/actions/bookmark`, expect.objectContaining({ body: JSON.stringify({ user_id: USER_ID, bookmarked: true, idempotency_key: "bookmark-1" }) }), "admin");

    sendRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ issue_id: ISSUE_ID, subject_type: "user", subject_id: USER_ID, subscribed: true, reason: "manual", updated_at_millis: 14 }), { status: 200 }));
    await expect(updateIssueSubscription(adminApp, ISSUE_ID, "user", USER_ID, true, "manual", "subscription-1")).resolves.toMatchObject({ subscribed: true });
    expect(sendRequestMock).toHaveBeenCalledWith(`/issues/${ISSUE_ID}/actions/subscribe`, expect.objectContaining({ body: JSON.stringify({ subject_type: "user", subject_id: USER_ID, subscribed: true, reason: "manual", idempotency_key: "subscription-1" }) }), "admin");
  });

  it("bounds comment/action text before it reaches the authenticated route", async () => {
    await expect(updateIssueBookmark(adminApp, ISSUE_ID, USER_ID, true, "x".repeat(129))).rejects.toThrow("Idempotency key must contain 1-128 characters");
    await expect(updateIssueSubscription(adminApp, ISSUE_ID, "user", USER_ID, true, "x".repeat(65), "subscription-1")).rejects.toThrow("Subscription reason must contain 1-64 characters");
  });
});

describe("issue triage optimistic state", () => {
  it("applies each subject update immutably, so a rejected mutation can restore the exact snapshot", () => {
    const bookmarked = setIssueBookmarkState(detail, USER_ID, true);
    const subscribed = setIssueSubscriptionState(bookmarked, { type: "user", id: USER_ID, is_active: true, reason: "manual", created_at: "2026-08-06T00:00:00.000Z", updated_at: "2026-08-06T00:00:00.000Z" }, true, "2026-08-06T00:00:01.000Z");
    const assigned = setIssueAssignee(subscribed, USER_ID);
    const teamed = setIssueTeam(assigned, TEAM_ID);
    const owned = setIssueOwnerState(teamed, {
      id: "00000000-0000-4000-8000-000000000005", type: "team", user_id: null, team_id: TEAM_ID,
      source: "manual", context: null, created_at: "2026-08-06T00:00:00.000Z", updated_at: "2026-08-06T00:00:01.000Z",
    });

    expect(detail.product).toMatchObject({ assignee_user_id: null, team_id: null, bookmarked_user_ids: [], subscriptions: [], owners: [] });
    expect(owned.product).toMatchObject({ assignee_user_id: USER_ID, team_id: TEAM_ID, bookmarked_user_ids: [USER_ID] });
    expect(owned.product.subscriptions[0]?.is_active).toBe(true);
    expect(owned.product.owners[0]?.team_id).toBe(TEAM_ID);
    expect(clearManualIssueOwnerState(owned).product.owners).toEqual([]);
  });

  it("searches public issue records with the extra event dimensions", async () => {
    sendRequestMock.mockResolvedValue(new Response(JSON.stringify({
      items: [{
        record_type: "issue",
        issue_id: ISSUE_ID,
        issue_short_id: "1",
        issue_type: "TypeError",
        issue_value: "boom",
        issue_culprit: "app.ts",
        issue_status: "unresolved",
        event_id: "evt-1",
        occurrence_id: "occ-1",
        event_at_millis: 10,
        message: "boom",
        level: "error",
        release: "1.4.2",
        matched_tag: { key: "browser", value: "chrome" },
      }],
      next_cursor: null,
    }), { status: 200 }));

    await expect(searchPublicIssues(adminApp, {
      hours: 24,
      status: "unresolved",
      service: null,
      environment: null,
      handled: "all",
      search: "",
      level: "error",
      release: "1.4.2",
      userId: USER_ID,
      tagKey: "browser",
      tagValue: "chrome",
      cursor: null,
    })).resolves.toMatchObject({
      items: [{ issue_id: ISSUE_ID, level: "error", release: "1.4.2" }],
      nextCursor: null,
    });
    expect(sendRequestMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/issues\/search\?/),
      { method: "GET" },
      "admin",
    );
    const searchPath = sendRequestMock.mock.calls[0]?.[0];
    expect(searchPath).toContain("record=issue");
    expect(searchPath).toContain("level=error");
    expect(searchPath).toContain("release=1.4.2");
    expect(searchPath).toContain(`user_id=${USER_ID}`);
    expect(searchPath).toContain("tag_key=browser");
    expect(searchPath).toContain("tag_value=chrome");
  });
});
