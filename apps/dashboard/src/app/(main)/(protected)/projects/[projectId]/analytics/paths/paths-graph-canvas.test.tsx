// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathsGraphCanvas } from "./paths-graph-canvas";

const nodes = [
  { id: "/projects/:id/releases", label: "/projects/:id/releases", domain: "example.com", pageViews: 12, width: 180, x: 0, y: 0 },
  { id: "/checkout", label: "/checkout", domain: "example.com", pageViews: 5, width: 120, x: 300, y: 0 },
];
const edges = [{ from: "/projects/:id/releases", to: "/checkout", count: 5, weight: 5 }];

beforeEach(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCanvas(
  initialCompareMode = false,
  comparePaths = async (paths: string[]) => paths.map((path) => ({ path, uniqueVisitors: 1 })),
) {
  return render(
    <PathsGraphCanvas
      nodes={nodes}
      edges={edges}
      weakEdges={[]}
      totalNodeCount={2}
      totalEdgeCount={1}
      totalTransitionCount={5}
      visibleTransitionCount={5}
      initialCompareMode={initialCompareMode}
      comparePaths={comparePaths}
    />,
  );
}

describe("PathsGraphCanvas", () => {
  it("shows the full domain and normalized path in a selectable wrapped inspector", () => {
    renderCanvas();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "example.com/projects/:id/releases, 12 page views" }));

    const fullPath = screen.getByText("example.com/projects/:id/releases");
    expect(fullPath.className).toContain("select-text");
    expect(fullPath.className).toContain("break-all");
    expect(fullPath.className).not.toContain("truncate");
  });

  it("moves a node with pointer capture and updates its incident path", () => {
    const { container } = renderCanvas();
    const node = screen.getByRole("button", { name: "example.com/projects/:id/releases, 12 page views" });
    node.setPointerCapture = vi.fn();
    node.releasePointerCapture = vi.fn();
    const pathBefore = container.querySelector('path[marker-end="url(#paths-arrow)"]')?.getAttribute("d");

    fireEvent.pointerDown(node, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { pointerId: 7, clientX: 120, clientY: 110 });
    fireEvent.pointerUp(node, { pointerId: 7, clientX: 120, clientY: 110 });

    expect(node.style.left).toBe("-70px");
    expect(container.querySelector('path[marker-end="url(#paths-arrow)"]')?.getAttribute("d")).not.toBe(pathBefore);
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  });

  it("starts in compare mode and fills ordered editable inputs from node activation", () => {
    renderCanvas(true);
    const node = screen.getByRole("button", { name: "example.com/projects/:id/releases, 12 page views" });
    node.setPointerCapture = vi.fn();
    node.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(node, { button: 0, pointerId: 3, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(node, { pointerId: 3, clientX: 20, clientY: 20 });

    expect(screen.getByRole("button", { name: "Check paths" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Check paths" }).className).toContain("bg-zinc-100");
    expect(screen.getByRole("button", { name: "Check paths" }).className).toContain("dark:bg-primary");
    expect(screen.getByRole("heading", { name: "Path funnel" }).closest("section")?.className).toContain("bg-white");
    expect(screen.getByLabelText("Exact path 1").getAttribute("value")).toBe("/projects/:id/releases");
    expect(node.getAttribute("aria-pressed")).toBe("true");
    expect(node.className).toContain("opacity-70");
    expect(node.className).toContain("ring-1");
    expect(node.className).toContain("dark:bg-blue-500/5");

    fireEvent.mouseEnter(node);
    expect(node.className).toContain("opacity-100");
    expect(node.className).toContain("ring-2");
    expect(node.className).toContain("shadow-md");
    expect(node.className).toContain("dark:bg-blue-500/10");

    fireEvent.mouseLeave(node);
    expect(node.className).toContain("opacity-70");
    expect(node.className).not.toContain("shadow-md");

    fireEvent.change(screen.getByLabelText("Exact path 1"), { target: { value: "/another-path" } });
    expect(node.getAttribute("aria-pressed")).toBe("false");
    expect(node.className).not.toContain("opacity-70");
  });

  it("marks a normalized graph node without changing the exact comparison path", async () => {
    const comparePaths = vi.fn(async (paths: string[]) => paths.map((path) => ({ path, uniqueVisitors: 1 })));
    renderCanvas(true, comparePaths);
    const node = screen.getByRole("button", { name: "example.com/projects/:id/releases, 12 page views" });
    const concretePath = "/projects/550e8400-e29b-41d4-a716-446655440000/releases";

    fireEvent.change(screen.getByLabelText("Exact path 1"), {
      target: { value: concretePath },
    });
    fireEvent.change(screen.getByLabelText("Exact path 2"), { target: { value: "/checkout" } });

    expect(node.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(comparePaths).toHaveBeenCalledWith([concretePath, "/checkout"]));
  });

  it("renders ordered comparison results as a horizontal conversion funnel", async () => {
    const { container } = renderCanvas(true, async (paths) => paths.map((path, index) => ({
      path,
      uniqueVisitors: [100, 60, 30][index],
    })));
    fireEvent.click(screen.getByRole("button", { name: "Add funnel step" }));
    fireEvent.change(screen.getByLabelText("Exact path 1"), { target: { value: "/landing" } });
    fireEvent.change(screen.getByLabelText("Exact path 2"), { target: { value: "/signup" } });
    fireEvent.change(screen.getByLabelText("Exact path 3"), { target: { value: "/welcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    const funnel = await screen.findByRole("list", { name: "Path conversion funnel" });
    const steps = Array.from(funnel.querySelectorAll("li"));
    expect(steps.map((step) => step.textContent)).toEqual([
      "100 visitors1. /landing",
      "60 visitors2. /signup",
      "30 visitors3. /welcome",
    ]);
    const funnelBand = container.querySelector('svg path[class*="stroke-zinc"]');
    expect(funnelBand?.getAttribute("d")).toContain("C");
    expect(funnelBand?.getAttribute("class")).toContain("dark:stroke-blue-500/45");
    expect(screen.getByText("−40%")).toBeTruthy();
    expect(screen.getByText("30% conversion")).toBeTruthy();
  });

  it("adds, removes, and clears funnel step inputs", () => {
    renderCanvas(true);
    fireEvent.change(screen.getByLabelText("Exact path 1"), { target: { value: "/landing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add funnel step" }));
    fireEvent.change(screen.getByLabelText("Exact path 3"), { target: { value: "/welcome" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.getByLabelText("Exact path 2").getAttribute("value")).toBe("/welcome");

    fireEvent.click(screen.getByRole("button", { name: "Clear funnel steps" }));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(screen.getByLabelText("Exact path 1").getAttribute("value")).toBe("");
    expect(screen.getByLabelText("Exact path 2").getAttribute("value")).toBe("");
  });

  it("activates focused nodes from the keyboard", () => {
    renderCanvas();
    const node = screen.getByRole("button", { name: "example.com/projects/:id/releases, 12 page views" });

    fireEvent.keyDown(node, { key: "Enter" });

    expect(node.getAttribute("aria-pressed")).toBe("true");
  });
});
