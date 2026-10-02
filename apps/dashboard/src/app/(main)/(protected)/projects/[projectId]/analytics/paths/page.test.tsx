// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Page, { metadata } from "./page";

vi.mock("./page-client", () => ({
  default: () => <div>Paths graph</div>,
}));

describe("Paths page", () => {
  afterEach(cleanup);

  it("exposes the paths graph from the canonical Paths route", () => {
    render(<Page />);

    expect(metadata).toEqual({ title: "Paths" });
    expect(screen.getByText("Paths graph")).toBeTruthy();
  });
});
