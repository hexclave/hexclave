// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MultiSelect } from "./multi-select";

afterEach(cleanup);

const OPTIONS = [
  { value: "ok", label: "OK" },
  { value: "error", label: "Error" },
] as const;

function Harness() {
  const [selected, setSelected] = useState<ReadonlySet<"ok" | "error">>(new Set());
  return <div>
    <MultiSelect label="Status" options={OPTIONS} selected={selected} onChange={setSelected} />
    <span data-testid="outside">outside</span>
  </div>;
}

describe("MultiSelect", () => {
  it("summarises the selection, toggles options and clears", () => {
    const view = within(render(<Harness />).container);
    const trigger = view.getByRole("button", { name: "Status" });
    expect(trigger.textContent).toContain("All");

    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("option", { name: "Error" }));
    expect(trigger.textContent).toContain("Error");
    expect(view.getByRole("option", { name: "Error" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(view.getByRole("option", { name: "OK" }));
    expect(trigger.textContent).toContain("2 selected");

    fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
    expect(trigger.textContent).toContain("All");
  });

  it("closes on Escape and on a click outside", () => {
    const view = within(render(<Harness />).container);
    const trigger = view.getByRole("button", { name: "Status" });
    fireEvent.click(trigger);
    expect(view.queryByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.pointerDown(view.getByTestId("outside"));
    expect(view.queryByRole("listbox")).toBeNull();
  });
});
