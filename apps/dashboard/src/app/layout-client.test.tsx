// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const layoutState = vi.hoisted(() => ({
  pathname: "/tv",
  dashboardModuleLoaded: vi.fn(),
  dashboardRendered: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => layoutState.pathname,
}));

vi.mock("./dashboard-layout-client", () => {
  layoutState.dashboardModuleLoaded();
  return {
    default: ({ children }: { children: ReactNode }) => {
      layoutState.dashboardRendered();
      return <div data-testid="dashboard-layout">{children}</div>;
    },
  };
});

import { LayoutClient } from "./layout-client";

afterEach(() => {
  cleanup();
  layoutState.pathname = "/tv";
  layoutState.dashboardRendered.mockClear();
  layoutState.dashboardModuleLoaded.mockClear();
});

describe("root dashboard layout routing", () => {
  it("renders the independent TV route without loading dashboard providers", () => {
    const { rerender } = render(<LayoutClient><div>Independent display</div></LayoutClient>);

    expect(screen.getByText("Independent display")).toBeTruthy();
    expect(layoutState.dashboardModuleLoaded).not.toHaveBeenCalled();
    expect(layoutState.dashboardRendered).not.toHaveBeenCalled();

    layoutState.pathname = "/tv/";
    rerender(<LayoutClient><div>Independent display with slash</div></LayoutClient>);

    expect(screen.getByText("Independent display with slash")).toBeTruthy();
    expect(layoutState.dashboardModuleLoaded).not.toHaveBeenCalled();
    expect(layoutState.dashboardRendered).not.toHaveBeenCalled();
  });

  it("keeps all other routes inside the dashboard provider boundary", async () => {
    layoutState.pathname = "/projects/project-id/tv-mode";
    render(<LayoutClient><div>Dashboard TV Mode</div></LayoutClient>);

    expect(await screen.findByTestId("dashboard-layout")).toBeTruthy();
    expect(screen.getByText("Dashboard TV Mode")).toBeTruthy();
    expect(layoutState.dashboardModuleLoaded).toHaveBeenCalledTimes(1);
    expect(layoutState.dashboardRendered).toHaveBeenCalledTimes(1);
  });
});
