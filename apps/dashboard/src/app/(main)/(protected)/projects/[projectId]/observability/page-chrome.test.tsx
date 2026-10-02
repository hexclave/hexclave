// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ObservabilityEmptyState,
  ObservabilityErrorState,
  ObservabilityLoadingState,
  ObservabilitySplitLayout,
  ObservabilityTimeRangeToggle,
  ObservabilityToolbar,
} from "./page-chrome";

describe("ObservabilityToolbar", () => {
  afterEach(cleanup);

  it("keeps the scope-then-act ordering regardless of which slots are filled", () => {
    const { container } = render(
      <ObservabilityToolbar
        actions={<button type="button">Refresh</button>}
        range={<button type="button">24h</button>}
        filters={<button type="button">All services</button>}
        stats={<span>3 traces</span>}
      />,
    );

    const labels = Array.from(container.querySelectorAll("button, span"))
      .map((element) => element.textContent)
      .filter((text) => text !== "");
    expect(labels).toEqual(["All services", "3 traces", "24h", "Refresh"]);
  });

  it("only draws the divider when there is scope to separate from actions", () => {
    const withScope = render(
      <ObservabilityToolbar
        range={<button type="button">24h</button>}
        actions={<button type="button">Refresh</button>}
      />,
    );
    expect(withScope.container.querySelectorAll("[aria-hidden]")).toHaveLength(1);
    cleanup();

    const actionsOnly = render(<ObservabilityToolbar actions={<button type="button">Refresh</button>} />);
    expect(actionsOnly.container.querySelectorAll("[aria-hidden]")).toHaveLength(0);
  });
});

describe("ObservabilityTimeRangeToggle", () => {
  afterEach(cleanup);

  it("offers the shared observability windows and reports the parsed hours", () => {
    const onChange = vi.fn();
    render(<ObservabilityTimeRangeToggle hours={24} onChange={onChange} />);

    for (const label of ["1h", "24h", "7d", "30d"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }

    screen.getByRole("button", { name: "7d" }).click();
    expect(onChange).toHaveBeenCalledWith(168);
  });
});

describe("ObservabilitySplitLayout", () => {
  afterEach(cleanup);

  it("labels both regions and puts the sidebar in a sticky pane", () => {
    const { container } = render(
      <ObservabilitySplitLayout
        sidebarLabel="Trace list"
        sidebar={<div>rows</div>}
        detailLabel="Selected trace waterfall"
        detail={<div>waterfall</div>}
      />,
    );

    const aside = screen.getByRole("complementary", { name: "Trace list" });
    expect(screen.getByRole("region", { name: "Selected trace waterfall" })).toBeDefined();

    const pane = aside.firstElementChild;
    // Sized against dvh, not a container query: these pages scroll the app
    // shell, so there is no sized container for `cqh` to resolve against and the
    // pane would silently lose its height cap.
    expect(pane?.className).toContain("lg:max-h-[calc(100dvh-9.25rem)]");
    expect(pane?.className).toContain("lg:sticky");
    expect(container.querySelector(".lg\\:grid-cols-\\[22rem_minmax\\(0\\,1fr\\)\\]")).not.toBeNull();
  });
});

describe("observability status states", () => {
  afterEach(cleanup);

  it("renders loading, empty, and error states with a single shared shape", () => {
    render(<ObservabilityLoadingState label="Loading traces…" />);
    expect(screen.getByText("Loading traces…")).toBeDefined();
    cleanup();

    render(
      <ObservabilityEmptyState
        title="No spans in this time range"
        description="Send a traced request."
      >
        <code>app.startSpan()</code>
      </ObservabilityEmptyState>,
    );
    expect(screen.getByText("No spans in this time range")).toBeDefined();
    expect(screen.getByText("Send a traced request.")).toBeDefined();
    expect(screen.getByText("app.startSpan()")).toBeDefined();
    cleanup();

    const onRetry = vi.fn();
    render(<ObservabilityErrorState title="Couldn't load" description="boom" onRetry={onRetry} />);
    expect(screen.getByText("Couldn't load")).toBeDefined();
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it("omits the retry affordance when the failure is not retryable", () => {
    render(<ObservabilityErrorState title="Couldn't load" description="boom" />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
