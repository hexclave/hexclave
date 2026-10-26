// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

const createCheckoutUrlMock = vi.fn();

function createPlanUsageState() {
  return {
    ownerTeamId: "00000000-0000-4000-8000-000000000001",
    ownerTeamDisplayName: "Acme",
    planId: "free",
    planDisplayName: "Free",
    periodStart: new Date(Date.UTC(2026, 5, 1)),
    periodEnd: new Date(Date.UTC(2026, 6, 1)),
    nextPlanId: "team",
    arePlanLimitsEnforced: true,
    rows: [
      {
        itemId: "dashboard_admins",
        displayName: "Dashboard admins",
        kind: "current",
        used: 1,
        limit: 1,
        remaining: 0,
        overage: 0,
        isUnlimited: false,
      },
      {
        itemId: "auth_users",
        displayName: "Auth users",
        kind: "current",
        used: 45,
        limit: null,
        remaining: null,
        overage: 0,
        isUnlimited: true,
      },
      {
        itemId: "analytics_events",
        displayName: "Analytics events",
        kind: "metered",
        used: 120,
        limit: 100,
        remaining: 0,
        overage: 20,
        isUnlimited: false,
      },
      {
        itemId: "session_replays",
        displayName: "Session replays",
        kind: "metered",
        used: 24,
        limit: 2500,
        remaining: 2476,
        overage: 0,
        isUnlimited: false,
      },
      {
        itemId: "analytics_timeout_seconds",
        displayName: "Analytics timeout",
        kind: "capability",
        used: null,
        limit: 10,
        remaining: null,
        overage: null,
        isUnlimited: false,
      },
    ],
  };
}

let planUsageState = createPlanUsageState();

vi.mock("../../use-admin-app", () => ({
  useAdminApp: () => ({
    useProject: () => ({
      id: "project-1",
    }),
    usePlanUsage: () => planUsageState,
  }),
}));

vi.mock("@/lib/dashboard-user", () => ({
  useDashboardInternalUser: () => ({
    useTeam: (teamId: string) => teamId === planUsageState.ownerTeamId ? {
      id: planUsageState.ownerTeamId,
      createCheckoutUrl: createCheckoutUrlMock,
    } : null,
  }),
}));

describe("Usage settings page", () => {
  beforeEach(() => {
    planUsageState = createPlanUsageState();
    createCheckoutUrlMock.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
    createCheckoutUrlMock.mockReset();
  });

  it("renders the plan, usage rows, and overage state", () => {
    render(<PageClient />);

    // The page title
    expect(screen.getAllByText("Billing & Usage").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Dashboard admins").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Authentication").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Auth users").length).toBeGreaterThan(0);
    expect(screen.getByText("45 users · Unlimited")).toBeTruthy();
    expect(screen.getByText("100% · 20 over")).toBeTruthy();
    expect(screen.getAllByLabelText("Auth users usage").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Analytics").length).toBeGreaterThan(0);
    expect(screen.getByText("Analytics events")).toBeTruthy();
    expect(screen.getByText("Session replays")).toBeTruthy();
    expect(screen.getAllByText("Analytics query timeout").length).toBeGreaterThan(0);
    expect(screen.getAllByText("10s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("You exceeded your limits. Upgrade to the Team or Growth plan to get higher quotas.").length).toBeGreaterThan(0);
  });

  it("renders zero capped auth users with an empty progress bar", () => {
    planUsageState = {
      ...createPlanUsageState(),
      rows: createPlanUsageState().rows.map((row) => row.itemId === "auth_users" ? {
        ...row,
        used: 0,
        limit: 10000,
        remaining: 10000,
        overage: 0,
        isUnlimited: false,
      } : row),
    };

    render(<PageClient />);

    expect(screen.getByText("0% · 10,000 left")).toBeTruthy();
    const authUsageBar = screen.getAllByLabelText("Auth users usage")[0];
    const authUsageFill = authUsageBar.firstElementChild;
    if (!(authUsageFill instanceof HTMLElement)) {
      throw new Error("Expected Auth users progress fill element");
    }
    expect(authUsageFill.style.width).toBe("0%");
  });

  it("hides overage banner when plan limits are not enforced", () => {
    planUsageState = {
      ...createPlanUsageState(),
      arePlanLimitsEnforced: false,
    };

    render(<PageClient />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts checkout for the next plan from the upgrade CTA", async () => {
    render(<PageClient />);

    fireEvent.click(screen.getAllByRole("button", { name: /^upgrade$/i })[0]);

    await waitFor(() => {
      expect(createCheckoutUrlMock).toHaveBeenCalledWith({
        productId: "team",
        returnUrl: window.location.href,
      });
    });
  });
});
