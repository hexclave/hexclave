// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

const { adminApp, queryAnalyticsMock } = vi.hoisted(() => {
  const queryAnalytics = vi.fn();
  return {
    adminApp: {
      projectId: "internal",
      queryAnalytics,
    },
    queryAnalyticsMock: queryAnalytics,
  };
});

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
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}));

vi.mock("../../analytics/shared", () => ({
  AnalyticsEventLimitBanner: () => null,
  ErrorDisplay: ({ error }: { error: string }) => <div role="alert">{error}</div>,
  RowDetailDialog: () => null,
  isDateValue: (value: unknown) => (
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)
  ),
  parseClickHouseDate: (value: string) => new Date(`${value.replace(" ", "T")}Z`),
}));

vi.mock("./span-tree", () => ({
  SpanTreeList: ({ traces }: { traces: unknown[] }) => (
    <div data-testid="trace-list">{traces.length} traces</div>
  ),
}));

vi.mock("./waterfall", () => ({
  TraceWaterfall: () => <div data-testid="trace-waterfall" />,
}));

describe("Traces page client", () => {
  afterEach(() => {
    cleanup();
    queryAnalyticsMock.mockReset();
  });

  it("commits roots when physical services have realistic nullable namespaces", async () => {
    queryAnalyticsMock.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("SELECT service_namespace, service_name")) {
        return {
          result: [
            { service_namespace: null, service_name: "stack-backend" },
            { service_namespace: null, service_name: "stack-dashboard" },
          ],
        };
      }
      if (query.includes("LEFT JOIN default.users AS u")) {
        return {
          result: [
            {
              trace_id: "physical-trace",
              span_id: "physical-root",
              span_type: "POST /api/latest/analytics/events/batch",
              started_at: "2026-07-28 23:47:02.756",
              root_activity_at: "2026-07-28 23:47:02.756",
              ended_at: null,
              status_code: "unset",
              parent_span_id: null,
              user_display_name: "Administrator",
              user_primary_email: "admin@example.com",
              user_profile_image_url: null,
              trace_service_namespaces: [""],
              trace_service_names: ["stack-dashboard"],
            },
          ],
        };
      }
      if (query.includes("SELECT event_type")) return { result: [] };
      return {
        result: [{
          trace_id: "physical-trace",
          span_id: "physical-root",
          span_type: "POST /api/latest/analytics/events/batch",
          started_at: "2026-07-28 23:47:02.756",
          ended_at: null,
          status_code: "unset",
          parent_span_id: null,
        }],
      };
    });

    render(<PageClient />);

    await waitFor(() => {
      expect(screen.getByTestId("trace-list").textContent).toBe("1 traces");
    });
    expect(screen.queryByText("Hexclave")).toBeNull();
  });

  it("does not re-query the selected trace when the root list grows", async () => {
    const spanQueryMarker = "FROM default.spans";
    let rootPage = 0;
    queryAnalyticsMock.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("SELECT service_namespace, service_name")) return { result: [] };
      if (query.includes("SELECT event_type")) return { result: [] };
      if (query.includes("LEFT JOIN default.users AS u")) {
        rootPage += 1;
        return {
          result: [{
            trace_id: `trace-${rootPage}`,
            span_id: `root-${rootPage}`,
            span_type: "GET /api/thing",
            started_at: "2026-07-28 23:47:02.756",
            root_activity_at: "2026-07-28 23:47:02.756",
            ended_at: null,
            status_code: "unset",
            parent_span_id: null,
            user_display_name: null,
            user_primary_email: null,
            user_profile_image_url: null,
            trace_service_namespaces: [""],
            trace_service_names: ["stack-backend"],
          }],
        };
      }
      return { result: [] };
    });

    render(<PageClient />);
    await waitFor(() => {
      expect(screen.getByTestId("trace-list").textContent).toBe("1 traces");
    });

    const spanQueriesAfterFirstSelection = queryAnalyticsMock.mock.calls
      .filter(([options]: [{ query: string }]) => options.query.includes(spanQueryMarker)).length;

    await new Promise((resolve) => setTimeout(resolve, 0));

    const spanQueriesAfterSettle = queryAnalyticsMock.mock.calls
      .filter(([options]: [{ query: string }]) => options.query.includes(spanQueryMarker)).length;
    expect(spanQueriesAfterSettle).toBe(spanQueriesAfterFirstSelection);
  });
});
