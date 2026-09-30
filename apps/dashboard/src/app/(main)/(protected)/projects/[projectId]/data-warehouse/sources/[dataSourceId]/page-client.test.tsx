// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

const mocks = vi.hoisted(() => ({
  deleteDataSource: vi.fn(),
  routerPush: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ dataSourceId: "source-1" }),
}));

vi.mock("@/components/router", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("../../../app-enabled-guard", () => ({
  AppEnabledGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../../../page-layout", () => ({
  PageLayout: ({ actions, children }: { actions?: ReactNode, children: ReactNode }) => (
    <div>{actions}{children}</div>
  ),
}));

vi.mock("../../../use-admin-app", () => ({
  useAdminApp: () => ({
    projectId: "project-1",
    useDataSources: () => [{
      id: "source-1",
      host: "postgres.example.com",
      error: null,
      streams: [],
    }],
    deleteDataSource: mocks.deleteDataSource,
    syncDataSource: vi.fn(),
    getDataSourceCatalog: vi.fn(),
    setDataSourceStreams: vi.fn(),
  }),
}));

vi.mock("../stream-picker", () => ({
  StreamPicker: () => null,
  formatRowCount: (value: number) => String(value),
}));

vi.mock("@/components/design-components", () => ({
  DesignAlert: ({ title, description }: { title: ReactNode, description: ReactNode }) => (
    <div role="alert"><div>{title}</div><div>{description}</div></div>
  ),
  DesignButton: ({ children, onClick }: { children: ReactNode, onClick?: () => void | Promise<void> }) => (
    <button onClick={() => runAsynchronously(onClick?.())}>{children}</button>
  ),
}));

vi.mock("@/components/ui", () => ({
  ActionDialog: ({
    open,
    onOpenChange,
    title,
    okButton,
    children,
  }: {
    open: boolean,
    onOpenChange: (open: boolean) => void,
    title: ReactNode,
    okButton: { label: string, onClick: () => Promise<"prevent-close" | void> },
    children: ReactNode,
  }) => open ? (
    <div role="dialog">
      <div>{title}</div>
      {children}
      <button onClick={() => runAsynchronously(async () => {
        if (await okButton.onClick() !== "prevent-close") onOpenChange(false);
      })}>{okButton.label}</button>
    </div>
  ) : null,
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useToast: () => ({ toast: mocks.toast }),
}));

describe("data source details", () => {
  beforeEach(() => {
    mocks.deleteDataSource.mockReset();
    mocks.routerPush.mockReset();
    mocks.toast.mockReset();
  });

  afterEach(cleanup);

  it("keeps the disconnect dialog open and shows a blocking inline error when deletion fails", async () => {
    mocks.deleteDataSource.mockRejectedValueOnce(new Error("The replication slot could not be removed."));
    render(<PageClient />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Could not disconnect")).toBeTruthy();
    expect(screen.getByText("The replication slot could not be removed.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("clears a previous error and navigates only after a successful retry", async () => {
    mocks.deleteDataSource
      .mockRejectedValueOnce(new Error("First failure"))
      .mockResolvedValueOnce(undefined);
    render(<PageClient />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" });
    fireEvent.click(confirm);
    expect(await screen.findByText("First failure")).toBeTruthy();

    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mocks.routerPush).toHaveBeenCalledWith("/projects/project-1/data-warehouse/sources");
      expect(screen.queryByText("First failure")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
