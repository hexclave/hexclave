// @vitest-environment jsdom

import { getTvBuiltInProfile, type TvProfileResource } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ projectId: "project-a" }));
const fetchTvProfile = vi.hoisted(() => vi.fn());
const deleteTvProfileOrThrow = vi.hoisted(() => vi.fn());
const navigateToTvProfiles = vi.hoisted(() => vi.fn());
const testAdminApp = vi.hoisted(() => ({
  useProject: () => ({ displayName: "Test Project" }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => `/projects/${testState.projectId}/tv-mode/profiles/company-pulse`,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/design-components", () => ({
  DesignAlert: ({ title }: { title: string }) => <div>{title}</div>,
  DesignButton: ({ children, ...props }: ComponentProps<"button">) => <button {...props}>{children}</button>,
  DesignCard: ({ title, children }: { title: string, children: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
  DesignInput: (props: ComponentProps<"input">) => <input {...props} />,
  DesignSelectorDropdown: ({
    triggerId,
    value,
    onValueChange,
    options,
    disabled,
  }: {
    triggerId?: string,
    value: string,
    onValueChange: (value: string) => void,
    options: Array<{ value: string, label: string }>,
    disabled?: boolean,
  }) => (
    <select
      aria-label={triggerId ?? `setting-${value}`}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

vi.mock("@/components/link", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/components/router", () => ({
  useRouterConfirm: () => ({ setNeedConfirm: vi.fn() }),
}));

vi.mock("@/components/ui", () => ({
  Typography: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ "aria-label": ariaLabel, disabled }: { "aria-label"?: string, disabled?: boolean }) => (
    <button type="button" aria-label={ariaLabel} disabled={disabled} />
  ),
}));

vi.mock("@/components/tv-mode/tv-presentation", () => ({
  TvPresentation: () => <div>TV presentation</div>,
}));

vi.mock("@/components/tv-mode/presentation-window", () => ({
  useTvPresentationLauncher: () => ({ launchPresentation: vi.fn(), popupBlocked: false }),
}));

vi.mock("@/components/tv-mode/screen-registry", () => ({
  getTvScreenDefinition: (screenId: string) => ({
    displayName: screenId,
    description: `${screenId} description`,
    accentClassName: "",
    icon: () => <span />,
  }),
}));

vi.mock("@/lib/tv-mode/fixtures", () => ({
  createTvFixtureSnapshot: () => null,
}));

vi.mock("@/lib/hexclave-app-internals", () => ({
  createTvProfileOrThrow: vi.fn(),
  deleteTvProfileOrThrow,
  duplicateTvProfileOrThrow: vi.fn(),
  fetchTvProfileOrThrow: fetchTvProfile,
  TvProfileRequestError: class TvProfileRequestError extends Error {},
  updateTvProfileOrThrow: vi.fn(),
}));

vi.mock("@/lib/tv-mode/navigation", () => ({
  navigateToTvProfiles,
}));

vi.mock("../../../page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("../../../use-admin-app", () => ({
  useAdminApp: () => testAdminApp,
  useProjectId: () => testState.projectId,
}));

vi.mock("./tv-profile-delete-dialog", () => ({
  TvProfileDeleteDialog: ({
    error,
    open,
    onConfirm,
  }: {
    error?: string | null,
    open: boolean,
    onConfirm: () => Promise<"prevent-close" | void>,
  }) => (
    <div>
      {open ? <button type="button" onClick={() => runAsynchronously(async () => { await onConfirm(); })}>Delete profile</button> : null}
      {error != null ? <div role="alert">{error}</div> : null}
    </div>
  ),
}));

import PageClient from "./page-client";

beforeEach(() => {
  testState.projectId = "project-a";
  fetchTvProfile.mockReset();
  deleteTvProfileOrThrow.mockReset();
  const profile = getTvBuiltInProfile("company-pulse");
  if (profile == null) throw new Error("Missing company-pulse profile fixture");
  fetchTvProfile.mockResolvedValue(profile);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TV profile editor layout", () => {
  it("shows one timing category at a time with Celebrations selected by default", async () => {
    render(<PageClient />);

    const timingSelector = await screen.findByLabelText("tv-presentation-timing");
    expect(screen.queryByText("Celebration Takeover")).not.toBeNull();
    expect(screen.queryByText("Incident Takeover")).toBeNull();

    fireEvent.change(timingSelector, { target: { value: "incident" } });

    expect(screen.getByText("Incident Takeover")).toBeDefined();
    expect(screen.queryByText("Celebration Takeover")).toBeNull();
  });

  it("shows developer previews only for development-enabled projects", async () => {
    const customerRender = render(<PageClient />);
    await screen.findByText("Timing");
    expect(screen.queryByText("Event Previews")).toBeNull();
    expect(screen.queryByText("State Previews")).toBeNull();
    customerRender.unmount();

    testState.projectId = "internal";
    render(<PageClient />);
    expect(await screen.findByText("Event Previews")).toBeDefined();
    expect(screen.getByText("State Previews")).toBeDefined();
  });

  it("shows a field-level error and blocks saving an overlong normalized name", async () => {
    render(<PageClient />);

    const nameInput = await screen.findByLabelText("TV Name");
    fireEvent.change(nameInput, { target: { value: `${"😀".repeat(200)} Profile` } });

    expect(screen.getByRole("alert").textContent).toContain(
      "TV profile names must remain within 80 characters after normalization.",
    );
    expect(screen.getByRole("button", { name: "Save as New Profile" })).toHaveProperty("disabled", true);
  });

  it("disables playlist movement at the boundaries", async () => {
    render(<PageClient />);

    const firstEarlierButton = await screen.findByRole("button", { name: "Move live-pulse earlier" });
    const firstLaterButton = screen.getByRole("button", { name: "Move live-pulse later" });
    expect(firstEarlierButton).toHaveProperty("disabled", true);
    expect(firstLaterButton).toHaveProperty("disabled", false);
  });

  it("keeps the delete dialog open with a safe message when deletion fails", async () => {
    const profile = getSavedProfile();
    fetchTvProfile.mockResolvedValue(profile);
    deleteTvProfileOrThrow.mockRejectedValue(new Error("database details"));

    render(<PageClient />);
    await screen.findByText("Timing");
    fireEvent.click(screen.getByRole("button", { name: "Delete Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Profile deletion is unavailable. The profile was not deleted.",
    );
  });

  it("navigates after the profile is deleted", async () => {
    const profile = getSavedProfile();
    fetchTvProfile.mockResolvedValue(profile);
    deleteTvProfileOrThrow.mockResolvedValue(undefined);

    render(<PageClient />);
    await screen.findByText("Timing");
    fireEvent.click(screen.getByRole("button", { name: "Delete Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));

    await waitFor(() => expect(navigateToTvProfiles).toHaveBeenCalledWith("project-a"));
  });
});

function getSavedProfile(): TvProfileResource {
  const profile = getTvBuiltInProfile("company-pulse");
  if (profile == null) throw new Error("Missing company-pulse profile fixture");
  return {
    ...profile,
    id: "00000000-0000-4000-8000-000000000001",
    origin: "saved",
    version: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}
