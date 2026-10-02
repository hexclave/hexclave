// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui", () => ({
  SimpleTooltip: ({
    children,
    className,
    tooltip,
  }: {
    children: ReactNode,
    className?: string,
    tooltip: ReactNode,
  }) => (
    <span className={className} tabIndex={0} data-tooltip={tooltip}>
      {children}
    </span>
  ),
}));

import { ReplayActivityMetrics } from "./replay-activity-metrics";

afterEach(() => {
  cleanup();
});

describe("ReplayActivityMetrics", () => {
  it("renders compact, keyboard-discoverable duration, event, and click metrics", () => {
    const { container } = render(
      <ReplayActivityMetrics
        durationMs={7 * 60 * 1000 + 16 * 1000}
        eventCount={7512}
        clickCount={8_000_000}
        keystrokeCount={913}
      />,
    );

    expect(screen.getByLabelText("Replay activity").textContent).toBe("7m 16s7.5k8m913");
    expect(screen.getByText("7m 16s").closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe("Replay duration: 7m 16s");
    expect(screen.getByText("7.5k").closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe("Recorded events: 7,512");
    expect(screen.getByText("8m").closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe("Recorded clicks: 8,000,000");
    expect(screen.getByText("913").closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe("Recorded keystrokes: 913");
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(4);
    expect(screen.getByLabelText("Replay activity").className).toContain("flex-wrap");
    expect(screen.getByLabelText("Replay activity").className).toContain("text-[11px]");
  });

  it("keeps metric tooltip triggers inside the replay row's click target", () => {
    const onActivate = vi.fn();
    render(
      <ReplayActivityMetrics
        durationMs={7 * 60 * 1000 + 16 * 1000}
        eventCount={7512}
        clickCount={64}
        keystrokeCount={913}
        onActivate={onActivate}
      />,
    );

    fireEvent.click(screen.getByText("7.5k"));
    expect(onActivate).toHaveBeenCalledOnce();
  });
});
