// @vitest-environment jsdom

import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";

describe("AccountMenu", () => {
  it("opens from the identity block and exposes account settings and sign out", async () => {
    const onOpenAccountSettings = vi.fn(async () => {});
    const onSignOut = vi.fn(async () => {});
    const { container } = render(
      <AccountMenu
        accountName="Administrator"
        accountDetail="admin@example.com"
        accountInitial="A"
        onOpenAccountSettings={onOpenAccountSettings}
        onSignOut={onSignOut}
      />,
    );
    const view = within(container);
    const trigger = view.getByRole("button", { name: "Open account menu for Administrator" });

    fireEvent.click(trigger);
    expect(view.getByRole("menu", { name: "Account menu" })).not.toBeNull();
    fireEvent.click(view.getByRole("menuitem", { name: "Account settings" }));
    expect(onOpenAccountSettings).toHaveBeenCalledOnce();

    await waitFor(() => expect(view.getByRole("menuitem", { name: "Sign out" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(view.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { container } = render(
      <AccountMenu
        accountName="Administrator"
        accountDetail="admin@example.com"
        accountInitial="A"
        onOpenAccountSettings={async () => {}}
        onSignOut={async () => {}}
      />,
    );
    const view = within(container);
    const trigger = view.getByRole("button", { name: "Open account menu for Administrator" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(view.queryByRole("menu", { name: "Account menu" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
