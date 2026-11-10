// @vitest-environment jsdom

import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccessDenied } from "./AccessDenied";

describe("AccessDenied", () => {
  it("names the signed-in account and lets the user sign out", async () => {
    let resolveSignOut: () => void = () => {};
    const onSignOut = vi.fn(() => new Promise<void>(resolve => {
      resolveSignOut = resolve;
    }));
    const { container } = render(<AccessDenied accountLabel="Jane Doe" onSignOut={onSignOut} />);
    const view = within(container);

    expect(view.getByRole("heading", { name: "Access denied" })).not.toBeNull();
    expect(container.textContent).toContain("You are signed in as Jane Doe");

    fireEvent.click(view.getByRole("button", { name: "Sign out and switch account" }));
    expect(onSignOut).toHaveBeenCalledOnce();

    const pendingButton = view.getByRole("button", { name: "Signing out…" });
    expect(pendingButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pendingButton);
    expect(onSignOut).toHaveBeenCalledOnce();

    resolveSignOut();
    await waitFor(() => expect(view.getByRole("button", { name: "Sign out and switch account" }).hasAttribute("disabled")).toBe(false));
  });
});
