// @vitest-environment jsdom

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailMetricStrip, DetailPanelTabs } from "./DetailPanelNavigation";

describe("DetailPanelTabs", () => {
  it("identifies the active section and sends the selected value", () => {
    const onChange = vi.fn();
    const { container } = render(
      <DetailPanelTabs
        label="Request sections"
        value="conversation"
        onChange={onChange}
        items={[
          { value: "conversation", label: "Conversation" },
          { value: "request", label: "Request details" },
        ]}
      />,
    );
    const view = within(container);

    expect(view.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(view.getByRole("tab", { name: "Request details" }));
    expect(onChange).toHaveBeenCalledWith("request");

    onChange.mockClear();
    fireEvent.keyDown(view.getByRole("tab", { name: "Conversation" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("request");
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Request details" }));
  });
});

describe("DetailMetricStrip", () => {
  it("exposes metric labels and values as a description list", () => {
    const { container } = render(
      <DetailMetricStrip items={[
        { label: "Result", value: "OK", tone: "success" },
        { label: "Duration", value: "420ms" },
      ]} />,
    );
    const view = within(container);

    expect(view.getByText("Result")).not.toBeNull();
    expect(view.getByText("OK")).not.toBeNull();
    expect(view.getByText("Duration")).not.toBeNull();
    expect(view.getByText("420ms")).not.toBeNull();
  });
});
