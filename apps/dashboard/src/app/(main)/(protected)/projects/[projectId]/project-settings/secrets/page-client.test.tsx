// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

const searchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));
const project = vi.hoisted(() => ({
  id: "project-1",
  listProjectSecrets: vi.fn(async () => []),
  setProjectSecret: vi.fn(async () => undefined),
  deleteProjectSecret: vi.fn(async () => undefined),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsState.current,
}));

vi.mock("../../use-admin-app", () => ({
  useAdminApp: () => ({
    useProject: () => project,
  }),
}));

describe("Project secrets settings page", () => {
  beforeEach(() => {
    searchParamsState.current = new URLSearchParams();
    project.listProjectSecrets.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the set-secret dialog when addSecret is true", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");

    render(<PageClient />);

    expect(await screen.findByRole("heading", { name: "Set secret" })).toBeTruthy();
    expect(await screen.findByPlaceholderText("e.g. OPENAI_API_KEY")).toBeTruthy();
  });

  it("keeps the set-secret dialog closed without addSecret=true", () => {
    render(<PageClient />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
