// @vitest-environment jsdom

import { getTvBuiltInProfile } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { Toaster, TooltipProvider } from "@/components/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PageClient from "./page-client";

const testState = vi.hoisted(() => ({
  adminApp: {},
  projectId: "project-a",
  fetchProfiles: vi.fn(),
  writeText: vi.fn(),
}));
let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardWasPatched = false;
const nativeClipboardDescriptor: PropertyDescriptor = {
  configurable: true,
  value: { writeText: vi.fn() },
};

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", nativeClipboardDescriptor);
});

afterAll(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

vi.mock("../../use-admin-app", () => ({
  useAdminApp: () => testState.adminApp,
  useProjectId: () => testState.projectId,
}));

vi.mock("@/lib/hexclave-app-internals", () => ({
  fetchTvProfilesOrThrow: (...args: unknown[]) => testState.fetchProfiles(...args),
}));

vi.mock("@/lib/tv-mode/display-url", () => ({
  getConfiguredTvDisplayUrl: () => "http://localhost:8101/tv",
  isLocalTvDisplayUrl: () => true,
}));

vi.mock("../display-management", () => ({
  TvDisplayManagement: ({ profiles }: { profiles: unknown[] }) => <div>Display management for {profiles.length} profile</div>,
}));

afterEach(() => {
  if (clipboardWasPatched) {
    if (originalClipboardDescriptor == null) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    }
    clipboardWasPatched = false;
    originalClipboardDescriptor = undefined;
  }
  cleanup();
  testState.projectId = "project-a";
  testState.fetchProfiles.mockReset();
  testState.writeText.mockReset();
});

function readyProfiles() {
  const template = getTvBuiltInProfile("company-pulse");
  if (template == null) throw new Error("Company Pulse profile is missing.");
  return {
    savedProfiles: [],
    templates: [template],
    persistenceReady: true,
    effectiveDefaultProfileId: "company-pulse",
  };
}

describe("TV displays page", () => {
  it("loads profiles and exposes the independent display link", async () => {
    testState.fetchProfiles.mockResolvedValue(readyProfiles());
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    clipboardWasPatched = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: testState.writeText },
    });
    testState.writeText.mockResolvedValue(undefined);

    render(<><TooltipProvider><PageClient /></TooltipProvider><Toaster /></>);

    expect(await screen.findByText("Display management for 1 profile")).toBeTruthy();
    const openLink = screen.getByRole("link", { name: "Open TV Display" });
    expect(openLink.getAttribute("href")).toBe("http://localhost:8101/tv");
    expect(screen.getByText("Local Development Link")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy TV display link" }));
    await waitFor(() => expect(testState.writeText).toHaveBeenCalledWith("http://localhost:8101/tv"));
    expect(await screen.findByText("TV Link Copied")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy TV display link" })).toBeTruthy();
  });

  it("does not show a previous project's load failure while the next project loads", async () => {
    const projectBLoad = Promise.withResolvers<ReturnType<typeof readyProfiles>>();
    testState.fetchProfiles
      .mockRejectedValueOnce(new Error("Project A failed"))
      .mockImplementationOnce(() => projectBLoad.promise);

    const rendered = render(<TooltipProvider><PageClient /></TooltipProvider>);
    expect(await screen.findByText("Profiles Couldn’t Be Loaded")).toBeTruthy();

    testState.projectId = "project-b";
    rendered.rerender(<TooltipProvider><PageClient /></TooltipProvider>);

    expect(screen.queryByText("Profiles Couldn’t Be Loaded")).toBeNull();
    expect(screen.getByText("Loading display profiles…")).toBeTruthy();

    projectBLoad.resolve(readyProfiles());
    expect(await screen.findByText("Display management for 1 profile")).toBeTruthy();
  });

  it("preserves the native clipboard descriptor after an unpatched test", () => {
    expect(Object.getOwnPropertyDescriptor(navigator, "clipboard")).toMatchObject({
      configurable: nativeClipboardDescriptor.configurable,
      value: nativeClipboardDescriptor.value,
    });
  });
});
