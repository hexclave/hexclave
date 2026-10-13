// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserButton } from "./user-button";

type MockState = {
  app: { isExternalAuthApp: () => boolean, redirectToAccountSettings: () => Promise<void> } | null,
  user: { displayName: string, primaryEmail: string, signOut: () => Promise<void> } | null,
};

const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

const state = vi.hoisted<MockState>(() => ({
  app: null,
  user: null,
}));

vi.mock("..", () => ({
  useStackApp: () => state.app,
  useUser: () => state.user,
}));

vi.mock("../lib/translations", () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}));

vi.mock("./elements/user-avatar", () => ({
  UserAvatar: () => <div data-testid="user-avatar" />,
}));

vi.mock("@hexclave/ui", () => ({
  DropdownMenu: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  DropdownMenuContent: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  DropdownMenuItem: (props: { children: React.ReactNode, onClick: () => void }) => <button onClick={props.onClick}>{props.children}</button>,
  DropdownMenuLabel: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  Skeleton: () => <div />,
  Typography: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
}));

describe("UserButton", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    state.app = null;
    state.user = null;
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("hides external-auth sign out while keeping account settings", async () => {
    state.app = {
      isExternalAuthApp: () => true,
      redirectToAccountSettings: vi.fn(async () => {}),
    };
    state.user = {
      displayName: "External user",
      primaryEmail: "user@example.com",
      signOut: vi.fn(async () => {}),
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<UserButton />);
    });

    expect(container.textContent).toContain("Account settings");
    expect(container.textContent).not.toContain("Sign out");
  });
});
