// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../lib/hexclave-app";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { TranslationProviderClient } from "../providers/translation-provider-client";
import { Onboarding } from "./onboarding";

const appMockState = vi.hoisted(() => ({
  app: null as unknown,
  user: null as unknown,
}));

vi.mock("..", () => ({
  useStackApp: () => {
    if (appMockState.app == null) {
      throw new Error("Expected test app to be set before rendering.");
    }
    return appMockState.app;
  },
  useUser: () => appMockState.user,
}));

vi.mock("@hexclave/ui", async () => {
  const React = await import("react");
  return {
    Button: (props: { children: React.ReactNode, onClick?: () => void }) => (
      <button type="button" onClick={props.onClick}>{props.children}</button>
    ),
    Input: (props: Record<string, unknown>) => <input {...props} />,
    Typography: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
    cn: (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" "),
  };
});

const previousActEnvironment = globalThis["IS_REACT_ACT_ENVIRONMENT"];

function createAppTestDouble() {
  const app = {
    redirectToSignIn: vi.fn(async () => {}),
    redirectToAfterSignIn: vi.fn(async () => {}),
  };

  // This test double intentionally implements only the StackClientApp surface that Onboarding touches.
  return app as unknown as StackClientApp<true> & {
    redirectToSignIn: ReturnType<typeof vi.fn>,
    redirectToAfterSignIn: ReturnType<typeof vi.fn>,
  };
}

function createUserTestDouble(user: Partial<CurrentUser>) {
  // Same as the app test double: only the surface Onboarding touches.
  return {
    isAnonymous: false,
    isRestricted: true,
    restrictedReason: null,
    restrictedByAdmin: false,
    restrictedByAdminReason: null,
    primaryEmail: "user@example.com",
    signOut: vi.fn(async () => {}),
    ...user,
  } as unknown as CurrentUser;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderOnboarding(options: {
  app: StackClientApp<true>,
  user: unknown,
}) {
  appMockState.app = options.app;
  appMockState.user = options.user;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TranslationProviderClient quetzalKeys={new Map()} quetzalLocale={new Map()}>
        <Onboarding />
      </TranslationProviderClient>
    );
  });
  return container;
}

describe("Onboarding", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    appMockState.app = null;
    appMockState.user = null;
    vi.restoreAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("redirects signed-out users to sign-in", async () => {
    const app = createAppTestDouble();

    const container = await renderOnboarding({ app, user: null });

    expect(app.redirectToSignIn).toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("redirects anonymous users to sign-in", async () => {
    const app = createAppTestDouble();

    const container = await renderOnboarding({ app, user: createUserTestDouble({ isAnonymous: true, restrictedReason: { type: "anonymous" } }) });

    expect(app.redirectToSignIn).toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("redirects users that are no longer restricted to their destination", async () => {
    const app = createAppTestDouble();

    await renderOnboarding({ app, user: createUserTestDouble({ isRestricted: false }) });

    expect(app.redirectToAfterSignIn).toHaveBeenCalled();
    expect(app.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("shows the administrator's public reason to admin-restricted users", async () => {
    const app = createAppTestDouble();

    const container = await renderOnboarding({
      app,
      user: createUserTestDouble({
        restrictedReason: { type: "restricted_by_administrator" },
        restrictedByAdmin: true,
        restrictedByAdminReason: "Your sign-up was flagged by our fraud prevention rules.",
      }),
    });

    expect(container.textContent).toContain("Your account has been restricted");
    expect(container.textContent).toContain("Your sign-up was flagged by our fraud prevention rules.");
    expect(container.textContent).not.toContain("Complete your account setup");
  });

  it("falls back to a generic restricted message when no public reason is set", async () => {
    const app = createAppTestDouble();

    const container = await renderOnboarding({
      app,
      user: createUserTestDouble({
        restrictedReason: { type: "restricted_by_administrator" },
        restrictedByAdmin: true,
        restrictedByAdminReason: null,
      }),
    });

    expect(container.textContent).toContain("Your account has been restricted");
    expect(container.textContent).toContain("An administrator has restricted your account.");
  });

  it("shows the setup-required message for unknown restricted reasons", async () => {
    const app = createAppTestDouble();

    const container = await renderOnboarding({
      app,
      // The reason types are a closed union, so an unknown reason can only come from a newer backend.
      user: createUserTestDouble({ restrictedReason: { type: "some_future_reason" } as unknown as CurrentUser["restrictedReason"] }),
    });

    expect(container.textContent).toContain("Complete your account setup");
  });
});
