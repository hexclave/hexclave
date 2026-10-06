// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

const { queryAnalyticsMock, searchMode } = vi.hoisted(() => ({
  queryAnalyticsMock: vi.fn(),
  searchMode: { value: "" },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => key === "mode" ? searchMode.value : null }),
}));

vi.mock("../../use-admin-app", () => ({
  useAdminApp: () => ({
    queryAnalytics: queryAnalyticsMock,
  }),
}));

vi.mock("../../app-enabled-guard", () => ({
  AppEnabledGuard: ({ appId, children }: { appId: string, children: React.ReactNode }) => (
    <div data-testid="app-guard" data-app-id={appId}>{children}</div>
  ),
}));

vi.mock("../../page-layout", () => ({
  PageLayout: ({
    title,
    description,
    children,
  }: {
    title: string,
    description: string,
    children: React.ReactNode,
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </main>
  ),
}));

vi.mock("./paths-graph-canvas", () => ({
  PathsGraphCanvas: ({
    nodes,
    edges,
    initialCompareMode,
    comparePaths,
  }: {
    nodes: { id: string }[],
    edges: { count: number }[],
    initialCompareMode: boolean,
    comparePaths: (paths: string[]) => Promise<{ path: string, uniqueVisitors: number }[]>,
  }) => (
    <div data-testid="paths-graph">
      {nodes.length} nodes / {edges.reduce((total, edge) => total + edge.count, 0)} transitions
      <span>{initialCompareMode ? "compare active" : "explore active"}</span>
      <button onClick={() => runAsynchronously(async () => {
        const results = await comparePaths(["/", "/missing", "/signup"]);
        document.body.setAttribute("data-comparison", results.map((result) => `${result.path}:${result.uniqueVisitors}`).join(","));
      })}>Run comparison</button>
    </div>
  ),
}));

describe("Paths page client", () => {
  afterEach(() => {
    cleanup();
    queryAnalyticsMock.mockReset();
    searchMode.value = "";
    document.body.removeAttribute("data-comparison");
  });

  it("loads and aggregates navigation paths for Analytics-enabled projects", async () => {
    queryAnalyticsMock
      .mockResolvedValueOnce({
        result: [
          { from_path: "/products/123", to_path: "/checkout", cnt: "12" },
          { from_path: "/products/456", to_path: "/checkout", cnt: "8" },
        ],
      })
      .mockResolvedValueOnce({
        result: [
          { path: "/products/123", page_domain: "example.com", views: "30" },
          { path: "/products/456", page_domain: "example.com", views: "20" },
          { path: "/checkout", page_domain: "example.com", views: "10" },
        ],
      });

    render(<PageClient />);

    expect(screen.getByTestId("app-guard").getAttribute("data-app-id")).toBe("analytics");
    expect(screen.getByRole("heading", { name: "Paths" })).toBeTruthy();
    expect(screen.getByText("Explore the routes users take between product events.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("paths-graph").textContent).toContain("2 nodes / 20 transitions");
    });
    expect(queryAnalyticsMock).toHaveBeenCalledTimes(2);
  });

  it("activates compare mode from the URL and returns zero for absent exact paths", async () => {
    searchMode.value = "compare";
    queryAnalyticsMock
      .mockResolvedValueOnce({ result: [{ from_path: "/", to_path: "/signup", cnt: "5" }] })
      .mockResolvedValueOnce({
        result: [
          { path: "/", page_domain: "example.com", views: "10" },
          { path: "/signup", page_domain: "example.com", views: "5" },
        ],
      })
      .mockResolvedValueOnce({ result: [{ path: "/", users: "7" }, { path: "/signup", users: 3 }] });

    render(<PageClient />);

    await screen.findByText("compare active");
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    await waitFor(() => {
      expect(document.body.getAttribute("data-comparison")).toBe("/:7,/missing:0,/signup:3");
    });
    expect(queryAnalyticsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.stringContaining("arrayFold"),
      params: { paths: ["/", "/missing", "/signup"] },
    }));
    expect(queryAnalyticsMock.mock.calls.at(-1)?.[0].query).toContain("regexpQuoteMeta");
  });
});
