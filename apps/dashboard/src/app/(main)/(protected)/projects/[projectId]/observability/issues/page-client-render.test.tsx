// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataGridColumnDef, DataGridState } from "@hexclave/dashboard-ui-components";
import PageClient from "./page-client";
import type { IssueListItem } from "./issues-data";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";


const HASHES = ["hash-a", "hash-b", "hash-c"];

function sampleIssue(index: number, overrides: Partial<IssueListItem> = {}): IssueListItem {
  return {
    id: `issue-${index}`,
    short_id: String(index),
    type: `TypeError${index}`,
    value: `boom ${index}`,
    culprit: `app/file-${index}.ts in run`,
    level: "error",
    status: "unresolved",
    substatus: "ongoing",
    first_seen_at_millis: 1_700_000_000_000,
    last_seen_at_millis: 1_700_000_900_000,
    times_seen: "12",
    window_occurrences: 4,
    window_users: 2,
    service_name: "web",
    environment: "production",
    release: null,
    handled: true,
    synthetic: false,
    counters_truncated_at_millis: null,
    updated_at_millis: 1_700_000_900_000,
    issue_hashes: [HASHES[index] ?? `hash-${index}`],
    ...overrides,
  };
}

const { adminApp, queryAnalyticsMock, sendRequestMock } = vi.hoisted(() => {
  const queryAnalytics = vi.fn();
  const sendRequest = vi.fn();
  return {
    adminApp: { projectId: "internal", queryAnalytics },
    queryAnalyticsMock: queryAnalytics,
    sendRequestMock: sendRequest,
  };
});

// PageClient reaches the backend through the admin app's internals symbol, so
// the fake admin app carries a `sendRequest` mock through that same seam
// instead of mocking @/lib/hexclave-app-internals. The symbol import cannot be
// referenced inside vi.hoisted, so it is attached here instead.
Object.assign(adminApp, { [hexclaveAppInternalsSymbol]: { sendRequest: sendRequestMock } });

vi.mock("../../use-admin-app", () => ({
  useAdminApp: () => adminApp,
}));

vi.mock("../../app-enabled-guard", () => ({
  AppEnabledGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../../page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../../sticky-page-header", () => ({
  StickyPageHeader: ({ title, actions }: { title: string, actions: React.ReactNode }) => (
    <header><h1>{title}</h1>{actions}</header>
  ),
}));

vi.mock("../../analytics/shared", () => ({
  AnalyticsEventLimitBanner: () => null,
  RowDetailField: () => null,
}));

vi.mock("@/components/router", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useRouterConfirm: () => ({ needConfirm: false }),
}));

vi.mock("@/components/link", () => ({
  Link: ({ href, children, ...rest }: { href: string, children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("../event-sparkline", () => ({
  EventSparkline: ({ pending }: { pending?: boolean }) => (
    <div data-testid={pending === true ? "sparkline-pending" : "sparkline-loaded"} />
  ),
}));

vi.mock("@hexclave/dashboard-ui-components", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const MockDataGrid = (props: {
    columns: readonly DataGridColumnDef<IssueListItem>[],
    rows: readonly IssueListItem[],
    getRowId: (row: IssueListItem) => string,
    isLoading?: boolean,
    emptyState?: React.ReactNode,
    state: DataGridState,
  }) => {
    if (props.isLoading === true) return <div data-testid="grid-loading" />;
    if (props.rows.length === 0) return <div data-testid="grid-empty">{props.emptyState}</div>;
    return (
      <table>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={props.getRowId(row)} data-testid={`row-${props.getRowId(row)}`}>
              {props.columns.map((column) => (
                <td key={column.id} data-testid={`cell-${props.getRowId(row)}-${column.id}`}>
                  {column.renderCell?.({
                    row,
                    rowId: props.getRowId(row),
                    rowIndex,
                    value: null,
                    columnId: column.id,
                    isSelected: false,
                    dateDisplay: "relative",
                  })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };
  return { ...actual, DataGrid: MockDataGrid };
});

function jsonResponse(body: unknown, ok = true): Response {
  const partial = {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  };
  // SAFETY: the page client only reads ok, status, and json() from list responses; the remaining Response surface
  // is unused, and Response is assignable to this partial's type, which keeps the conversion a single legal cast.
  return partial as Response;
}

function issueListBody(items: IssueListItem[]) {
  return {
    items,
    cursor: null,
    counts: { unresolved: items.length, resolved: 0, ignored: 0 },
    approximate: false,
  };
}

const SPARKLINE_MARKER = "issue_hash IN {issueHashes:Array(String)}";

function sparklineCalls() {
  return queryAnalyticsMock.mock.calls.filter(
    ([options]: [{ query: string }]) => options.query.includes(SPARKLINE_MARKER),
  );
}

function issueListCalls() {
  return sendRequestMock.mock.calls.filter(
    ([path]: [string]) => path.startsWith("/internal/issues?"),
  );
}

describe("Issues page client", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/projects/internal/observability/issues");
  });

  afterEach(() => {
    cleanup();
    queryAnalyticsMock.mockReset();
    sendRequestMock.mockReset();
  });

  it("renders rows before the sparklines resolve", async () => {
    const issues = [sampleIssue(0), sampleIssue(1), sampleIssue(2)];
    sendRequestMock.mockResolvedValue(jsonResponse(issueListBody(issues)));
    queryAnalyticsMock.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes(SPARKLINE_MARKER)) return await new Promise(() => {});
      return { result: [] };
    });

    render(<PageClient />);

    await waitFor(() => {
      expect(screen.getByTestId("row-issue-0")).toBeDefined();
    });
    expect(screen.getByTestId("row-issue-1")).toBeDefined();
    expect(screen.getByTestId("row-issue-2")).toBeDefined();
    expect(screen.getByText("TypeError0")).toBeDefined();
    expect(screen.getAllByTestId("sparkline-pending")).toHaveLength(3);
    expect(screen.queryByTestId("sparkline-loaded")).toBeNull();
  });

  it("issues exactly ONE sparkline query per page, carrying every visible hash", async () => {
    const issues = [sampleIssue(0), sampleIssue(1), sampleIssue(2)];
    sendRequestMock.mockResolvedValue(jsonResponse(issueListBody(issues)));
    queryAnalyticsMock.mockImplementation(async ({ query }: { query: string }) => {
      if (!query.includes(SPARKLINE_MARKER)) return { result: [] };
      return {
        result: HASHES.map((hash) => ({
          issue_hash: hash,
          bucket_start: "2026-07-31 12:00:00.000",
          occurrences: 3,
        })),
      };
    });

    render(<PageClient />);

    await waitFor(() => {
      expect(screen.getAllByTestId("sparkline-loaded")).toHaveLength(3);
    });

    const calls = sparklineCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].params.issueHashes).toEqual(HASHES);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sparklineCalls()).toHaveLength(1);
  });

  it("applies a resolve optimistically without refetching the list", async () => {
    const issues = [sampleIssue(0)];
    sendRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/internal/issues?")) return jsonResponse(issueListBody(issues));
      return jsonResponse({ id: "issue-0", status: "resolved" });
    });
    queryAnalyticsMock.mockResolvedValue({ result: [] });

    render(<PageClient />);
    await waitFor(() => expect(screen.getByTestId("row-issue-0")).toBeDefined());

    const listCallsBefore = issueListCalls().length;
    expect(screen.getByTestId("cell-issue-0-status").textContent).toBe("—");

    screen.getByRole("button", { name: "Resolve" }).click();

    await waitFor(() => {
      expect(screen.getByTestId("cell-issue-0-status").textContent).toBe("Resolved");
    });
    expect(issueListCalls()).toHaveLength(listCallsBefore);
  });

  it("reverts a failed resolve and surfaces an alert, never a toast", async () => {
    const issues = [sampleIssue(0)];
    sendRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/internal/issues?")) return jsonResponse(issueListBody(issues));
      return jsonResponse({ message: "nope" }, false);
    });
    queryAnalyticsMock.mockResolvedValue({ result: [] });

    render(<PageClient />);
    await waitFor(() => expect(screen.getByTestId("row-issue-0")).toBeDefined());

    screen.getByRole("button", { name: "Resolve" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Couldn't update that issue");
    });
    expect(screen.getByTestId("cell-issue-0-status").textContent).toBe("—");
  });
});
