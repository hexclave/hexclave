import { describe, expect, it } from "vitest";
import {
  joinSuspectCommits,
  type IssueReleaseCommitRow,
  type IssueSuspectOwner,
} from "./issue-release-context";

const COMMIT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";

function commit(overrides: Partial<IssueReleaseCommitRow> = {}): IssueReleaseCommitRow {
  return {
    id: COMMIT_ID,
    releaseId: "33333333-3333-4333-8333-333333333333",
    releaseVersion: "web@2026.08.06",
    repository: "hexclave",
    commitSha: "a".repeat(40),
    position: 1,
    message: "Fix the issue",
    authorName: "Example Author",
    committedAt: new Date("2026-08-06T12:00:00.000Z"),
    url: "https://example.test/commit",
    ...overrides,
  };
}

function owner(context: Record<string, string>): IssueSuspectOwner {
  return { id: OWNER_ID, context };
}

describe("issue release suspect-commit joins", () => {
  it("joins a persisted suspect owner by release commit id and preserves the strategy", () => {
    const result = joinSuspectCommits({
      owners: [owner({ commit_id: COMMIT_ID, strategy: "scm_based" })],
      commits: [commit()],
    });

    expect(result).toEqual([{
      owner_id: OWNER_ID,
      matched_by: "release_commit_id",
      strategy: "scm_based",
      commit: expect.objectContaining({ id: COMMIT_ID, commit_sha: "a".repeat(40) }),
    }]);
  });

  it("joins by SHA only within the requested repository and fails closed for oversized or unknown references", () => {
    const result = joinSuspectCommits({
      owners: [
        owner({ commit_sha: "a".repeat(40), repository: "hexclave" }),
        { id: "foreign-owner", context: { commit_sha: "a".repeat(40), repository: "unrelated-repository" } },
        { id: "oversized-owner", context: { commit_sha: "a".repeat(40), padding: "x".repeat(65_537) } },
        { id: "unknown-owner", context: { commit_sha: "b".repeat(40), repository: "hexclave" } },
        { id: "ambiguous-owner", context: { commit_sha: "a".repeat(40) } },
      ],
      commits: [commit(), commit({ id: "44444444-4444-4444-8444-444444444444", repository: "other-repository" })],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ owner_id: OWNER_ID, matched_by: "commit_sha" });
  });
});
