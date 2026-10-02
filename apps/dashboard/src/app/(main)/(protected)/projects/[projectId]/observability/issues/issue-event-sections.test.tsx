// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDetailResponseSchema } from "@hexclave/shared/dist/interface/admin-issues";
import { IssueEventSections, IssueExceptionCauses, IssueProductSection } from "./issue-event-sections";

const USER_ID = "00000000-0000-4000-8000-000000000001";

const detail = IssueDetailResponseSchema.validateSync({
  issue: {
    id: "00000000-0000-4000-8000-000000000003", short_id: "1", type: "TypeError", value: "boom", culprit: "app.ts",
    level: "error", status: "unresolved", substatus: "ongoing", first_seen_at_millis: 1,
    last_seen_at_millis: 2, times_seen: "3", counters_truncated_at_millis: null,
    window_occurrences: 3, window_users: 1, service_name: "web", environment: "production",
    release: null, handled: false, synthetic: false, updated_at_millis: 2, issue_hashes: ["0123456789abcdef0123456789abcdef"],
  },
  occurrence: null,
  newer_cursor: null,
  older_cursor: null,
  release_context: { first_release: null, last_release: null, release_commits: [], suspect_commits: [] },
  redirected_from_issue_id: null,
  product: {
    priority: null, assignee_user_id: null, team_id: null, owners: [], activities: [], comments: [], subscriptions: [], bookmarked_user_ids: [],
  },
});

const detailWithOccurrence = IssueDetailResponseSchema.validateSync({
  ...detail,
  occurrence: {
    occurrence_id: "occurrence-1",
    event_at_millis: 1_700_000_000_000,
    message: "boom",
    level: "error",
    data: {},
    error_envelope: null,
    grouping_provenance: [],
    frames: [],
    raw_stack: null,
    symbolication_diagnostics: [],
    trace_id: null,
    span_id: null,
    page_view_span_id: null,
    session_replay_id: null,
    user_id: null,
    service_name: "web",
    environment: "production",
    release: null,
    attachments: [],
  },
});

afterEach(() => cleanup());

function renderTriage(onAddComment: (body: string) => Promise<void>) {
  return render(
    <IssueProductSection
      detail={detail}
      onPriorityChange={vi.fn(async () => {})}
      onAddComment={onAddComment}
      currentUserId={USER_ID}
      ownerTeam={{ id: "00000000-0000-4000-8000-00000000000a", displayName: "Acme" }}
      actionLoading={false}
      onAssignmentChange={vi.fn(async () => {})}
      onOwnerChange={vi.fn(async () => {})}
      onTeamChange={vi.fn(async () => {})}
      assigneeOptions={[{ id: USER_ID, label: "You" }]}
      onBookmarkChange={vi.fn(async () => {})}
      onSubscriptionChange={vi.fn(async () => {})}
      onTeamSubscriptionChange={vi.fn(async () => {})}
    />,
  );
}

describe("IssueProductSection", () => {
  it("collapses and reopens the triage controls without losing the card", async () => {
    renderTriage(vi.fn(async () => {}));

    expect(screen.getByText("Priority")).toBeDefined();
    const collapseButton = screen.getByRole("button", { name: "Collapse triage panel" });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseButton);

    await waitFor(() => expect(screen.queryByText("Priority")).toBeNull());
    const expandButton = screen.getByRole("button", { name: "Expand triage panel" });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandButton);

    await waitFor(() => expect(screen.getByText("Priority")).toBeDefined());
  });

  it("keeps the comment control busy until the durable action settles", async () => {
    let resolve: (() => void) | undefined;
    const onAddComment = vi.fn(() => new Promise<void>((nextResolve) => {
      resolve = nextResolve;
    }));
    renderTriage(onAddComment);
    fireEvent.change(screen.getByRole("textbox", { name: "Issue comment" }), { target: { value: "Investigating" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Comment" });
      if (!(button instanceof HTMLButtonElement)) throw new Error("Comment control should be a button");
      expect(button.disabled).toBe(true);
    });
    expect(onAddComment).toHaveBeenCalledWith("Investigating");
    resolve?.();
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Comment" });
      if (!(button instanceof HTMLButtonElement)) throw new Error("Comment control should be a button");
      expect(button.disabled).toBe(false);
    });
  });

  it("keeps the draft and surfaces a durable action error", async () => {
    const onAddComment = vi.fn(async () => {
      throw new Error("Adding issue comment failed with status 409");
    });
    renderTriage(onAddComment);
    const textbox = screen.getByRole("textbox", { name: "Issue comment" });
    fireEvent.change(textbox, { target: { value: "Duplicate triage note" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(screen.getByText("Adding issue comment failed with status 409")).toBeDefined());
    if (!(textbox instanceof HTMLTextAreaElement)) throw new Error("Comment control should be a textarea");
    expect(textbox.value).toBe("Duplicate triage note");
  });

  it("offers an assignee picker and stamps the owner team rather than listing other teams", () => {
    renderTriage(vi.fn(async () => {}));
    expect(document.getElementById("issue-assignee")).not.toBeNull();
    expect(document.getElementById("issue-team")).toBeNull();
    expect(screen.getByRole("button", { name: "Assign to Acme" })).toBeDefined();
  });
});

describe("IssueEventSections", () => {
  it("keeps optional empty event groups out of the page", () => {
    render(
      <IssueEventSections
        issue={detailWithOccurrence.issue}
        occurrence={detailWithOccurrence.occurrence}
        detail={detailWithOccurrence}
        nowMs={1_700_000_100_000}
        actionLoading={false}
        onUnmerge={vi.fn(async () => {})}
      />,
    );

    expect({
      occurrence: screen.queryByText("Occurrence") != null,
      request: screen.queryByText("Request context") != null,
      tags: screen.queryByText("Tags") != null,
      contexts: screen.queryByText("Contexts") != null,
      breadcrumbs: screen.queryByText("Breadcrumbs") != null,
      attachments: screen.queryByText("Attachments") != null,
      additionalData: screen.queryByText("Additional event data") != null,
      symbolication: screen.queryByText("Symbolication") != null,
      compactEmptyCopy: screen.queryByText(/No additional request, tag, breadcrumb/) != null,
    }).toMatchInlineSnapshot(`
      {
        "additionalData": false,
        "attachments": false,
        "breadcrumbs": false,
        "compactEmptyCopy": true,
        "contexts": false,
        "occurrence": true,
        "request": false,
        "symbolication": false,
        "tags": false,
      }
    `);
  });

  it("uses one compact event empty state when the occurrence aged out", () => {
    render(
      <IssueEventSections
        issue={detail.issue}
        occurrence={null}
        detail={detail}
        nowMs={1_700_000_100_000}
        actionLoading={false}
        onUnmerge={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByText(/No retained occurrence is available/)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("IssueExceptionCauses", () => {
  it("renders only additional exception values beneath the primary stack", () => {
    const retainedOccurrence = detailWithOccurrence.occurrence;
    if (retainedOccurrence == null) throw new Error("The exception-chain fixture must retain an occurrence.");
    const occurrence = IssueDetailResponseSchema.validateSync({
      ...detailWithOccurrence,
      occurrence: {
        ...retainedOccurrence,
        data: {
          exception: {
            values: [
              { type: "CauseError", value: "cause", stacktrace: { frames: [] } },
              { type: "PrimaryError", value: "primary", stacktrace: { frames: [] } },
            ],
          },
        },
      },
    }).occurrence;
    if (occurrence == null) throw new Error("The parsed exception-chain fixture must retain an occurrence.");

    render(<IssueExceptionCauses occurrence={occurrence} frameOrder="innermost-first" />);

    expect(screen.getByText("Additional causes")).toBeDefined();
    expect(screen.getByText("CauseError")).toBeDefined();
    expect(screen.queryByText("PrimaryError")).toBeNull();
  });
});
