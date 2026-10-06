// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservabilityPageLayout } from "./observability-page-layout";

vi.mock("../page-layout", () => ({
  PageLayout: ({
    children,
    fillWidth,
    noPadding,
    containedHeight,
    scrollMain,
    spacing,
  }: {
    children: ReactNode,
    fillWidth: boolean,
    noPadding?: boolean,
    containedHeight?: boolean,
    scrollMain?: boolean,
    spacing?: "default" | "compact",
  }) => (
    <main
      data-testid="page-layout"
      data-fill-width={String(fillWidth)}
      data-no-padding={String(noPadding === true)}
      data-contained-height={String(containedHeight === true)}
      data-scroll-main={String(scrollMain === true)}
      data-spacing={spacing}
    >
      {children}
    </main>
  ),
}));

vi.mock("../analytics/shared", () => ({
  AnalyticsEventLimitBanner: () => <div data-testid="analytics-event-limit-banner" />,
}));

vi.mock("../sticky-page-header", () => ({
  StickyPageHeader: ({
    title,
    description,
    actions,
    sticky,
    layoutGroupId,
    scrollContainer,
  }: {
    title: string,
    description: ReactNode,
    actions: ReactNode,
    sticky: boolean,
    layoutGroupId: string,
    scrollContainer?: "shell" | "main",
  }) => (
    <header
      data-testid="sticky-page-header"
      data-sticky={String(sticky)}
      data-layout-group-id={layoutGroupId}
      data-scroll-container={scrollContainer ?? "shell"}
    >
      <h1>{title}</h1>
      <p>{description}</p>
      {actions}
    </header>
  ),
}));

describe("ObservabilityPageLayout", () => {
  afterEach(cleanup);

  it("gives every observability page the same shell-scrolling page, like overview", () => {
    render(
      <ObservabilityPageLayout title="Logs" actions={<button type="button">Refresh</button>}>
        <div>Body</div>
      </ObservabilityPageLayout>,
    );

    const pageLayout = screen.getByTestId("page-layout");
    expect(pageLayout.dataset.fillWidth).toBe("true");
    expect(pageLayout.dataset.spacing).toBe("compact");
    // The app shell is the scrollport. Pinning the page to the viewport
    // (`containedHeight`) or scrolling <main> instead would both reintroduce a
    // nested scrollbar on the grid pages.
    expect(pageLayout.dataset.scrollMain).toBe("false");
    expect(pageLayout.dataset.containedHeight).toBe("false");
    expect(pageLayout.dataset.noPadding).toBe("false");

    const header = screen.getByTestId("sticky-page-header");
    expect(header.dataset.sticky).toBe("true");
    expect(header.dataset.scrollContainer).toBe("shell");
    expect(header.dataset.layoutGroupId).not.toBe("");
    expect(screen.getByRole("heading", { name: "Logs" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
  });

  it("renders a title-and-actions header with no description line", () => {
    render(
      <ObservabilityPageLayout title="Logs" actions={null}>
        <div>Body</div>
      </ObservabilityPageLayout>,
    );
    // Matches the overview page: the pill carries a title and controls only.
    expect(screen.getByTestId("sticky-page-header").querySelector("p")?.textContent).toBe("");
  });

  it("renders header, banner, and body in that order", () => {
    const { container } = render(
      <ObservabilityPageLayout title="Issues">
        <div>Issue list</div>
      </ObservabilityPageLayout>,
    );

    const pageLayout = screen.getByTestId("page-layout");
    const regions = Array.from(pageLayout.children).map((element) => (
      element.getAttribute("data-testid") === "sticky-page-header"
        ? "header"
        : element.hasAttribute("data-observability-page-banner")
          ? "banner"
          : element.hasAttribute("data-observability-page-body")
            ? "body"
            : "unknown"
    ));
    // The header is a *direct* child, with no wrapper of its own — a wrapper
    // would become its sticky containing block and the pill would scroll away
    // instead of pinning.
    expect(regions).toEqual(["header", "banner", "body"]);
    expect(screen.getByTestId("analytics-event-limit-banner")).toBeDefined();

    // No page-level gutters of its own: PageLayout owns the padding now, so the
    // grid pages can't drift from the chart pages the way they used to.
    const body = container.querySelector("[data-observability-page-body]");
    expect(body?.classList.contains("px-3")).toBe(false);
    expect(body?.classList.contains("overflow-hidden")).toBe(false);
  });
});
