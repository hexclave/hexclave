// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ISSUE_FILTERS } from "./issue-filters";
import type { SavedIssueSearchView } from "./issue-saved-views-data";
import { IssueSavedViews } from "./issue-saved-views";

const { fetchViewsMock, createViewMock, updateViewMock, deleteViewMock } = vi.hoisted(() => ({
  fetchViewsMock: vi.fn(),
  createViewMock: vi.fn(),
  updateViewMock: vi.fn(),
  deleteViewMock: vi.fn(),
}));

vi.mock("./issue-saved-views-data", () => ({
  createSavedIssueSearchView: createViewMock,
  deleteSavedIssueSearchView: deleteViewMock,
  fetchSavedIssueSearchViews: fetchViewsMock,
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  savedIssueSearchQueryToIssueFilters: () => DEFAULT_ISSUE_FILTERS,
  savedIssueSearchViewMutationForFilters: (name: string) => ({ name, visibility: "project", query: { version: 1, filters: { record: "issue", hours: "24", limit: "50" } } }),
  savedIssueSearchViewQueryIsCompatible: () => true,
  savedIssueSearchViewVisibilityLabel: (visibility: string) => visibility === "project" ? "Project" : "Private",
  updateSavedIssueSearchView: updateViewMock,
}));

vi.mock("@/components/design-components", () => ({
  DesignAlert: ({ title, description, children }: { title: string, description: string, children?: React.ReactNode }) => (
    <div role="alert"><strong>{title}</strong><span>{description}</span>{children}</div>
  ),
  DesignButton: ({ children, onClick, disabled, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
  DesignDialog: ({ open, onOpenChange, title, children, footer }: { open?: boolean, onOpenChange?: (open: boolean) => void, title?: React.ReactNode, children?: React.ReactNode, footer?: React.ReactNode }) => open ? (
    <div role="dialog"><h2>{title}</h2>{children}{footer}<button type="button" onClick={() => onOpenChange?.(false)}>Close dialog</button></div>
  ) : null,
  DesignInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  DesignMenu: ({ items }: { items: Array<{ id: string, label: string, onClick?: () => void }> }) => (
    <div>{items.map((item) => <button key={item.id} type="button" onClick={item.onClick}>{item.label}</button>)}</div>
  ),
}));

vi.mock("@/components/ui", () => {
  const PopoverContext = React.createContext({
    open: false,
    onOpenChange: (_open: boolean) => {},
  });
  const Popover = ({ children, open, onOpenChange }: { children: React.ReactNode, open?: boolean, onOpenChange?: (open: boolean) => void }) => (
    <PopoverContext.Provider value={{ open: open === true, onOpenChange: onOpenChange ?? (() => {}) }}>
      <div>{children}</div>
    </PopoverContext.Provider>
  );
  const PopoverTrigger = ({ children }: { children: React.ReactElement<{ onClick?: React.MouseEventHandler<HTMLButtonElement> }> }) => {
    const context = React.useContext(PopoverContext);
    return React.cloneElement(children, {
      onClick: (event) => {
        children.props.onClick?.(event);
        context.onOpenChange(!context.open);
      },
    });
  };
  const PopoverContent = ({ children }: { children: React.ReactNode }) => {
    const context = React.useContext(PopoverContext);
    return context.open ? <div>{children}</div> : null;
  };
  return {
    Popover,
    PopoverContent,
    PopoverTrigger,
    Typography: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  };
});

const SAMPLE_VIEW: SavedIssueSearchView = {
  id: "11111111-1111-4111-8111-111111111111",
  schema_version: 1,
  name: "Production regressions",
  visibility: "project",
  owner_user_id: null,
  query: { version: 1, filters: { record: "issue", hours: "24", limit: "50" } },
  created_at_millis: 1,
  updated_at_millis: 1,
};

describe("IssueSavedViews", () => {
  beforeEach(() => {
    fetchViewsMock.mockResolvedValue([SAMPLE_VIEW]);
    createViewMock.mockResolvedValue({ ...SAMPLE_VIEW, id: "22222222-2222-4222-8222-222222222222", name: "Current filters" });
    updateViewMock.mockResolvedValue(SAMPLE_VIEW);
    deleteViewMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads a view, applies it, and keeps the action surface explicit", async () => {
    const onApply = vi.fn();
    render(<IssueSavedViews adminApp={{}} filters={DEFAULT_ISSUE_FILTERS} onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: /Saved views/ }));
    await waitFor(() => expect(screen.getByText("Production regressions")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Production regressions/ }));
    expect(onApply).toHaveBeenCalledWith(DEFAULT_ISSUE_FILTERS);
  });

  it("shows a visible load error and a retry action", async () => {
    fetchViewsMock.mockRejectedValueOnce(new Error("backend unavailable"));
    render(<IssueSavedViews adminApp={{}} filters={DEFAULT_ISSUE_FILTERS} onApply={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Saved views/ }));
    await waitFor(() => expect(screen.getByText("backend unavailable")).toBeDefined());
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("creates a named project view from the current filters", async () => {
    render(<IssueSavedViews adminApp={{}} filters={DEFAULT_ISSUE_FILTERS} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Saved views/ }));
    await waitFor(() => expect(screen.getByText("Production regressions")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /Save current/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Current filters" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    await waitFor(() => expect(createViewMock).toHaveBeenCalledWith({}, expect.objectContaining({ name: "Current filters", visibility: "project" })));
  });
});
