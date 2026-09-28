// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StrictMode } from "react";
import GlobalError from "./global-error";
import {
  GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY,
  MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS,
} from "./global-error-recovery";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
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
