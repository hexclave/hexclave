// @vitest-environment jsdom

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailMetricStrip, DetailPanelTabs, DetailTabPanel } from "./DetailPanelNavigation";

describe("DetailPanelTabs", () => {
  it("identifies the active section and sends the selected value", () => {
    const onChange = vi.fn();
    const { container } = render(
      <DetailPanelTabs
        id="sections"
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

  it("links each tab to its panel and back, and keeps a hidden panel mounted", () => {
    const { container } = render(
      <>
        <DetailPanelTabs
          id="sections"
          label="Request sections"
          value="conversation"
          onChange={() => {}}
          items={[
            { value: "conversation", label: "Conversation" },
            { value: "request", label: "Request details" },
          ]}
        />
        <DetailTabPanel id="sections" value="conversation">Transcript</DetailTabPanel>
        <DetailTabPanel id="sections" value="request" hidden>Draft correction</DetailTabPanel>
      </>,
    );
    const view = within(container);

    const tab = view.getByRole("tab", { name: "Conversation" });
    const panel = view.getByRole("tabpanel", { name: "Conversation" });
    expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);

    const hiddenPanel = view.getByText("Draft correction");
    expect(hiddenPanel.hidden).toBe(true);
    const inactiveTab = view.getByRole("tab", { name: "Request details" });
    expect(hiddenPanel.getAttribute("aria-labelledby")).toBe(inactiveTab.id);
    // An inactive tab's panel may not exist, so it must not point at an id that is not there.
    expect(inactiveTab.hasAttribute("aria-controls")).toBe(false);
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
