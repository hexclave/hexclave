// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IssueDetailResponseSchema } from "@hexclave/shared/dist/interface/admin-issues";
import { IssueReleaseContextSection } from "./issue-release-context";

const detail = IssueDetailResponseSchema.validateSync({
  issue: {
    id: "00000000-0000-4000-8000-000000000003", short_id: "1", type: "TypeError", value: "boom", culprit: "app.ts",
    level: "error", status: "unresolved", substatus: "ongoing", first_seen_at_millis: 1,
    last_seen_at_millis: 2, times_seen: "3", counters_truncated_at_millis: null,
    window_occurrences: 3, window_users: 1, service_name: "web", environment: "production",
    release: "web@2026.08.06", handled: false, synthetic: false, updated_at_millis: 2, issue_hashes: ["0123456789abcdef0123456789abcdef"],
  },
  occurrence: null,
  newer_cursor: null,
  older_cursor: null,
  release_context: {
    first_release: null,
    last_release: null,
    release_commits: [],
    suspect_commits: [],
  },
  redirected_from_issue_id: null,
  product: {
    priority: null, assignee_user_id: null, team_id: null, owners: [], activities: [], comments: [], subscriptions: [], bookmarked_user_ids: [],
  },
});

afterEach(() => cleanup());

describe("IssueReleaseContextSection", () => {
  it("uses one compact state for a missing release graph", () => {
    render(<IssueReleaseContextSection context={detail.release_context} />);
    expect(screen.getByText("No release context is retained for this issue in the current project and branch.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders bounded release, deployment, and suspect-commit context", () => {
    render(
      <IssueReleaseContextSection
        context={{
          first_release: {
            id: "release-1", version: "web@2026.08.06", status: "open", date_added: "2026-08-06T00:00:00.000Z",
            date_started: null, date_released: "2026-08-06T01:00:00.000Z", deployments: [{
              id: "deployment-1", release_id: "release-1", deployment_key: "deploy-1", environment: "production",
              name: "web", url: "https://deploy.example.test", started_at: null, finished_at: "2026-08-06T01:00:00.000Z",
            }], commits: [{
              id: "commit-1", release_id: "release-1", release_version: "web@2026.08.06", repository: "hexclave",
              commit_sha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", position: 1,
              message: "Fix payment boundary", author_name: "Ada", committed_at: null, url: "https://git.example.test/commit/1",
            }],
          },
          last_release: null,
          release_commits: [],
          suspect_commits: [{
            owner_id: "00000000-0000-4000-8000-000000000004", matched_by: "commit_sha", strategy: "release-range",
            commit: {
              id: "commit-1", release_id: "release-1", release_version: "web@2026.08.06", repository: "hexclave",
              commit_sha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", position: 1,
              message: "Fix payment boundary", author_name: "Ada", committed_at: null, url: null,
            },
          }],
        }}
      />,
    );

    expect(screen.getAllByText("web@2026.08.06").length).toBeGreaterThan(0);
    expect(screen.getByText("Suspect · SHA")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy();
  });
});
