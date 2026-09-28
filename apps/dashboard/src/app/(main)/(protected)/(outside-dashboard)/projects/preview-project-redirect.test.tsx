// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSendRequest = vi.hoisted(() => vi.fn());
const mockRefreshOwnedProjects = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());

vi.mock("@/app/loading", () => ({
  default: () => <div>Loading preview</div>,
}));

vi.mock("@/components/design-components/alert", () => ({
  DesignAlert: (props: { title: string, description: string }) => (
    <div role="alert">
      <h1>{props.title}</h1>
      <p>{props.description}</p>
    </div>
  ),
}));

vi.mock("@/components/router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/hexclave-app-internals", () => ({
  hexclaveAppInternalsSymbol: "internals",
}));

vi.mock("@hexclave/next", () => ({
  useStackApp: () => ({
    internals: {
      sendRequest: mockSendRequest,
      refreshOwnedProjects: mockRefreshOwnedProjects,
    },
  }),
  useUser: () => ({ id: "user" }),
}));

vi.mock("@hexclave/shared/dist/utils/promises", () => ({
  runAsynchronously: (
    promiseOrFunc: () => Promise<unknown>,
    options: { onError?: (error: Error) => void },
  ) => {
    void promiseOrFunc().catch(error => options.onError?.(error));
  },
}));

import PreviewProjectRedirect from "./preview-project-redirect";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockSendRequest.mockReset();
  mockRefreshOwnedProjects.mockReset();
  mockPush.mockReset();
});

describe("preview project redirect", () => {
  it("renders request failures inside the preview without opening a browser alert", async () => {
    mockSendRequest.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Something went wrong",
    });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    render(<PreviewProjectRedirect />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Preview unavailable")).toBeTruthy();
    expect(
      screen.getByText("The preview could not be opened. Reload the page to try again."),
    ).toBeTruthy();
    await waitFor(() => expect(mockSendRequest).toHaveBeenCalledTimes(1));
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockRefreshOwnedProjects).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
