// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import GlobalError from "./global-error";
import {
  GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY,
  MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS,
} from "./global-error-recovery";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/hexclave/client", () => ({
  hexclaveClientApp: { getUser },
}));

beforeEach(() => {
  getUser.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe("global error screen", () => {
  it("shows a safe manual retry screen after automatic recovery stops", () => {
    const exhaustedState = JSON.stringify({
      attempts: MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS,
      lastAttemptAt: performance.timeOrigin + performance.now(),
    });
    window.sessionStorage.setItem(
      GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY,
      exhaustedState,
    );

    render(<GlobalError error={new Error("internal failure details")} />);

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByText("The dashboard could not load this page. Try again, or reload the page manually later.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("internal failure details")).toBeNull();
    expect(window.sessionStorage.getItem(GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY)).toBe(exhaustedState);
  });

  it("does not offer signing out when no user is signed in", async () => {
    render(<GlobalError error={new Error("internal failure details")} />);

    await vi.waitFor(() => expect(getUser).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("offers signing out when a user is signed in", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    getUser.mockResolvedValue({ id: "user-id", primaryEmail: "user@example.com", displayName: null, signOut });

    render(<GlobalError error={new Error("internal failure details")} />);

    const signOutButton = await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByText(/Signed in as user@example\.com\./)).toBeTruthy();
    fireEvent.click(signOutButton);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("records at most one recovery attempt when StrictMode replays effects", () => {
    render(
      <StrictMode>
        <GlobalError error={new Error("internal failure details")} />
      </StrictMode>,
    );

    expect(JSON.parse(window.sessionStorage.getItem(GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY) ?? "{}")).toMatchObject({
      attempts: 1,
    });
  });
});
