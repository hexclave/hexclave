// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../lib/hexclave-app";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import { TranslationProviderClient } from "../providers/translation-provider-client";
import { SignOut } from "./sign-out";

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

// The real `use` delegates to React.use, which breaks in this test setup because the shared
// package and react-dom resolve different React instances. Replace it with an equivalent
// Suspense-compatible implementation that doesn't depend on the React dispatcher.
vi.mock("@hexclave/shared/dist/utils/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hexclave/shared/dist/utils/react")>();
  type PromiseState = { status: "pending" } | { status: "ok", value: unknown } | { status: "error", error: unknown };
  const promiseStates = new WeakMap<Promise<unknown>, PromiseState>();
  return {
    ...original,
    use: <T,>(promise: Promise<T>): T => {
      const state = promiseStates.get(promise);
      if (state == null) {
        promiseStates.set(promise, { status: "pending" });
        promise.then(
          (value) => promiseStates.set(promise, { status: "ok", value }),
          (error) => promiseStates.set(promise, { status: "error", error }),
        );
        throw promise;
      }
      switch (state.status) {
        case "pending": {
          throw promise;
        }
        case "error": {
          throw state.error;
        }
        case "ok": {
          // This cast is safe because the value was stored from this exact promise's resolution;
          // the WeakMap just can't express the per-key type relationship.
          return state.value as T;
        }
      }
    },
  };
});

vi.mock("@hexclave/ui", async () => {
  const React = await import("react");
  return {
    Button: (props: { children: React.ReactNode, onClick?: () => void }) => (
      <button type="button" onClick={props.onClick}>{props.children}</button>
    ),
    Typography: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
    cn: (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" "),
  };
});

const previousActEnvironment = globalThis["IS_REACT_ACT_ENVIRONMENT"];

function createAppTestDouble(options: {
  trustedUrls: string[],
}) {
  const app = {
    redirectToSignIn: vi.fn(async () => {}),
    [hexclaveAppInternalsSymbol]: {
      isTrustedRedirectUrl: vi.fn(async (url: string) => options.trustedUrls.includes(url)),
    },
  };

  // This test double intentionally implements only the StackClientApp surface that SignOut and
  // the rendered signed-out card touch.
  return app as unknown as StackClientApp<true>;
}

function createUserTestDouble() {
  const user = {
    signOut: vi.fn(async () => {}),
  };
  // Same as the app test double: only the surface SignOut touches.
  return user as unknown as CurrentUser & { signOut: ReturnType<typeof vi.fn> };
}

// jsdom's window.location is not configurable, so it can't be spied on; replace it wholesale.
const originalLocation = window.location;
let locationReplaceMock = vi.fn();

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderSignOut(options: {
  app: StackClientApp<true>,
  user: unknown,
  searchParams?: Record<string, string>,
}) {
  appMockState.app = options.app;
  appMockState.user = options.user;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TranslationProviderClient quetzalKeys={new Map()} quetzalLocale={new Map()}>
        <React.Suspense fallback={<div data-testid="suspense-fallback" />}>
          <SignOut searchParams={options.searchParams} />
        </React.Suspense>
      </TranslationProviderClient>
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("SignOut", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    locationReplaceMock = vi.fn();
    Reflect.deleteProperty(window, "location");
    Reflect.set(window, "location", { href: "https://demo.example.test/handler/sign-out", replace: locationReplaceMock });
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
    Reflect.set(window, "location", originalLocation);
    vi.restoreAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("signs out with a trusted after_auth_return_to redirect URL", async () => {
    const app = createAppTestDouble({ trustedUrls: ["/dashboard"] });
    const user = createUserTestDouble();

    await renderSignOut({ app, user, searchParams: { after_auth_return_to: "/dashboard" } });

    expect(user.signOut).toHaveBeenCalledWith({ redirectUrl: "/dashboard" });
  });

  it("ignores an untrusted after_auth_return_to and falls back to the default sign-out redirect", async () => {
    const app = createAppTestDouble({ trustedUrls: [] });
    const user = createUserTestDouble();

    await renderSignOut({ app, user, searchParams: { after_auth_return_to: "https://evil.example.test/phishing" } });

    // The untrusted URL is dropped entirely; sign-out proceeds with the default destination.
    expect(user.signOut).toHaveBeenCalledWith({ redirectUrl: undefined });
  });

  it("does not follow an untrusted after_auth_return_to when already signed out", async () => {
    const app = createAppTestDouble({ trustedUrls: [] });

    await renderSignOut({ app, user: null, searchParams: { after_auth_return_to: "https://evil.example.test/phishing-signed-out" } });

    expect(locationReplaceMock).not.toHaveBeenCalled();
  });

  it("follows a trusted after_auth_return_to when already signed out", async () => {
    const app = createAppTestDouble({ trustedUrls: ["/trusted-dashboard"] });

    await renderSignOut({ app, user: null, searchParams: { after_auth_return_to: "/trusted-dashboard" } });

    expect(locationReplaceMock).toHaveBeenCalledWith("/trusted-dashboard");
  });
});
