// @vitest-environment jsdom

import type { AdminProjectSecretJson } from "@hexclave/shared/dist/interface/admin-interface";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageClient, { createAddSecretFormSchema, environmentsLosingValue } from "./page-client";

const searchParamsState = vi.hoisted(() => ({ current: new URLSearchParams() }));
const project = vi.hoisted(() => ({
  id: "project-1",
  listProjectSecrets: vi.fn(async (): Promise<AdminProjectSecretJson[]> => []),
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

const validAdd = {
  key: "OPENAI_API_KEY",
  value: "sk-new",
  scope: "specific" as const,
  production: false,
  preview: false,
  development: false,
};

describe("createAddSecretFormSchema", () => {
  const occupied = new Set(["OPENAI_API_KEY\0default"]);
  const schema = createAddSecretFormSchema(occupied);

  it("rejects a key that already exists for Default", async () => {
    await expect(schema.validate({ ...validAdd, scope: "default" })).rejects.toThrow(/already exists for Default/);
  });

  it("allows adding a specific environment when only Default exists", async () => {
    await expect(schema.validate({ ...validAdd, development: true })).resolves.toMatchObject({ key: "OPENAI_API_KEY", scope: "specific", development: true });
  });

  it("requires a subset when scope is specific", async () => {
    await expect(schema.validate(validAdd)).rejects.toThrow(/at least one environment/);
  });
});

describe("environmentsLosingValue", () => {
  const item = (key: string, environment: "default" | "production" | "preview" | "development") => ({ key, environment, updatedAtMillis: 1 });

  it("reports nothing when a Default value still covers the environment", () => {
    expect(environmentsLosingValue([item("K", "default"), item("K", "production")], { key: "K", environment: "production" })).toEqual([]);
  });

  it("reports every environment that only the Default value covered", () => {
    expect(environmentsLosingValue([item("K", "default"), item("K", "production")], { key: "K", environment: "default" })).toEqual(["preview", "development"]);
  });

  it("reports the environment itself when nothing else covers it", () => {
    expect(environmentsLosingValue([item("K", "production"), item("K", "development")], { key: "K", environment: "production" })).toEqual(["production"]);
  });

  it("ignores other keys", () => {
    expect(environmentsLosingValue([item("K", "production"), item("OTHER", "default")], { key: "K", environment: "production" })).toEqual(["production"]);
  });
});

describe("Project secrets settings page", () => {
  beforeEach(() => {
    searchParamsState.current = new URLSearchParams();
    project.listProjectSecrets.mockReset();
    project.listProjectSecrets.mockResolvedValue([]);
    project.setProjectSecret.mockReset();
    project.setProjectSecret.mockResolvedValue(undefined);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const fillSpecificAdd = async () => {
    fireEvent.change(await screen.findByPlaceholderText("e.g. OPENAI_API_KEY"), { target: { value: "API_KEY" } });
    fireEvent.change(screen.getByPlaceholderText("Secret value"), { target: { value: "v" } });
    fireEvent.click(screen.getByText("Specific"));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Production" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Development" }));
  };

  it("saves every selected environment in a single request", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");
    render(<PageClient />);
    await fillSpecificAdd();
    const loadsBeforeSubmit = project.listProjectSecrets.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(project.listProjectSecrets.mock.calls.length).toBeGreaterThan(loadsBeforeSubmit));
    expect(project.setProjectSecret.mock.calls).toEqual([["API_KEY", "v", ["production", "development"]]]);
  });

  it("surfaces a failed save", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");
    project.setProjectSecret.mockRejectedValueOnce(new Error("write failed"));
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PageClient />);
    await fillSpecificAdd();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(project.setProjectSecret).toHaveBeenCalledTimes(1);
  });

  it("gives every environment checkbox an accessible name", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");
    render(<PageClient />);
    fireEvent.click(await screen.findByText("Specific"));

    expect(await screen.findByRole("checkbox", { name: "Production" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Development" })).toBeTruthy();
  });

  it("clears the already-exists error as soon as the scope changes", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");
    project.listProjectSecrets.mockResolvedValue([{ key: "API_KEY", environment: "default", created_at_millis: 1, updated_at_millis: 1 }]);
    render(<PageClient />);
    fireEvent.change(await screen.findByPlaceholderText("e.g. OPENAI_API_KEY"), { target: { value: "API_KEY" } });
    fireEvent.change(screen.getByPlaceholderText("Secret value"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/already exists for Default/)).toBeTruthy();

    fireEvent.click(screen.getByText("Specific"));

    await waitFor(() => expect(screen.queryByText(/already exists for Default/)).toBeNull());
    expect(project.setProjectSecret).not.toHaveBeenCalled();
  });

  it("opens the add-secret dialog when addSecret is true", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");

    render(<PageClient />);

    expect(await screen.findByRole("heading", { name: "Add Secret" })).toBeTruthy();
    expect(await screen.findByPlaceholderText("e.g. OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("Specific")).toBeTruthy();
  });

  it("keeps Add disabled and the addSecret dialog closed until the list has loaded", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");
    let resolveList: (secrets: AdminProjectSecretJson[]) => void = () => {
      throw new Error("listProjectSecrets was not called");
    };
    project.listProjectSecrets.mockReturnValue(new Promise((resolve) => {
      resolveList = resolve;
    }));

    render(<PageClient />);

    expect(screen.getByRole("button", { name: "Add Secret" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    resolveList([{ key: "OPENAI_API_KEY", environment: "default", created_at_millis: 1, updated_at_millis: 1 }]);

    expect(await screen.findByRole("heading", { name: "Add Secret" })).toBeTruthy();
  });

  it("offers a retry when the first load fails, which then enables Add and opens addSecret", async () => {
    searchParamsState.current = new URLSearchParams("addSecret=true");
    project.listProjectSecrets
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([]);

    render(<PageClient />);

    expect(await screen.findByText("Failed to load secrets: network down")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Secret" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Add Secret" })).toBeTruthy();
    expect(screen.queryByText("Failed to load secrets: network down")).toBeNull();
  });

  it("keeps the add-secret dialog closed without addSecret=true", () => {
    render(<PageClient />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists Default and a more specific value as separate rows", async () => {
    project.listProjectSecrets.mockResolvedValue([
      { key: "OPENAI_API_KEY", environment: "default", created_at_millis: 1, updated_at_millis: 1 },
      { key: "OPENAI_API_KEY", environment: "production", created_at_millis: 2, updated_at_millis: 2 },
    ]);

    render(<PageClient />);

    expect(await screen.findByRole("button", { name: "Actions for OPENAI_API_KEY (Default)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for OPENAI_API_KEY (Production)" })).toBeTruthy();
    expect(screen.getAllByText("OPENAI_API_KEY")).toHaveLength(2);
  });

  it("lists Production and Development as separate rows so each can be edited on its own", async () => {
    project.listProjectSecrets.mockResolvedValue([
      { key: "TEST", environment: "production", created_at_millis: 1, updated_at_millis: 1 },
      { key: "TEST", environment: "development", created_at_millis: 2, updated_at_millis: 2 },
    ]);

    render(<PageClient />);

    expect(await screen.findByRole("button", { name: "Actions for TEST (Production)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for TEST (Development)" })).toBeTruthy();
    expect(screen.getAllByText("TEST")).toHaveLength(2);
    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByText("Development")).toBeTruthy();
  });
});
