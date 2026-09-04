// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PageLayout } from "./page-layout";

afterEach(() => {
  cleanup();
});

describe("PageLayout shell attributes", () => {
  it("renders shell attributes on an outermost layout", () => {
    const { container } = render(
      <PageLayout containedHeight fullBleed>
        <div />
      </PageLayout>,
    );

    const containedHeightLayouts = container.querySelectorAll("[data-contained-height]");
    const fullBleedLayouts = container.querySelectorAll("[data-full-bleed]");
    expect(containedHeightLayouts).toHaveLength(1);
    expect(fullBleedLayouts).toHaveLength(1);
    expect(containedHeightLayouts[0].getAttribute("data-contained-height")).toBe("true");
    expect(fullBleedLayouts[0].getAttribute("data-full-bleed")).toBe("true");
  });

  it("does not expose shell attributes from nested layouts", () => {
    const { container } = render(
      <PageLayout containedHeight fullBleed>
        <PageLayout containedHeight fullBleed>
          <div />
        </PageLayout>
      </PageLayout>,
    );

    const root = container.firstElementChild;
    if (root == null) {
      throw new Error("Expected the outer PageLayout to render a root element");
    }

    expect(root.getAttribute("data-contained-height")).toBe("true");
    expect(root.getAttribute("data-full-bleed")).toBe("true");
    expect(root.querySelector("[data-contained-height]")).toBeNull();
    expect(root.querySelector("[data-full-bleed]")).toBeNull();
  });

  it("does not expose shell attributes from layouts in header props", () => {
    const { container } = render(
      <PageLayout
        containedHeight
        fullBleed
        actions={<PageLayout containedHeight fullBleed />}
      />,
    );

    const root = container.firstElementChild;
    if (root == null) {
      throw new Error("Expected the outer PageLayout to render a root element");
    }

    expect(root.getAttribute("data-contained-height")).toBe("true");
    expect(root.getAttribute("data-full-bleed")).toBe("true");
    expect(root.querySelector("[data-contained-height]")).toBeNull();
    expect(root.querySelector("[data-full-bleed]")).toBeNull();
  });
});
