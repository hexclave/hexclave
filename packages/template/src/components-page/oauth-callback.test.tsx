// @vitest-environment jsdom

import { KnownErrors } from "@hexclave/shared";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import { TranslationProviderClient } from "../providers/translation-provider-client";
import { OAuthCallback } from "./oauth-callback";

const appMockState = vi.hoisted(() => ({ app: null as unknown }));

vi.mock("..", () => ({
  useStackApp: () => {
    if (appMockState.app == null) {
      throw new Error("Expected test app to be set before rendering.");
    }
    return appMockState.app;
  },
}));

vi.mock("@hexclave/ui", async () => {
  const React = await import("react");
  return {
    Button: (props: { children: React.ReactNode, onClick?: () => void }) => (
      <button type="button" onClick={props.onClick}>{props.children}</button>
    ),
    Spinner: () => <div data-testid="spinner" />,
    Typography: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
    cn: (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" "),
  };
});

const previousActEnvironment = globalThis["IS_REACT_ACT_ENVIRONMENT"];

function createAppTestDouble(options: {
  callOAuthCallback: () => Promise<boolean>,
}) {
  const app = {
    callOAuthCallback: options.callOAuthCallback,
    redirectToSignIn: vi.fn(async () => {}),
    redirectToHome: vi.fn(async () => {}),
    [hexclaveAppInternalsSymbol]: {
      awaitPendingAuthResolutions: vi.fn(async () => {}),
    },
  };

  // This test double intentionally implements only the StackClientApp surface
  // that OAuthCallback and the rendered error card touch.
  return app as unknown as StackClientApp<true>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderWithApp(app: StackClientApp<true>) {
  appMockState.app = app;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TranslationProviderClient quetzalKeys={new Map()} quetzalLocale={new Map()}>
        <OAuthCallback />
      </TranslationProviderClient>
    );
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("OAuthCallback", () => {
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
    vi.restoreAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("renders backend-encoded OAuth callback errors on the callback page", async () => {
    const errorMessage = "Your sign up was rejected by an administrator's sign-up rule.";
    const callOAuthCallback = vi.fn(async () => {
      throw new KnownErrors.SignUpRejected(errorMessage);
    });
    const app = createAppTestDouble({ callOAuthCallback });

    await renderWithApp(app);
    await flushEffects();

    expect(callOAuthCallback).toHaveBeenCalledOnce();
    expect(container?.textContent).toContain("SIGN_UP_REJECTED");
    expect(container?.textContent).toContain(errorMessage);
    expect(app.redirectToSignIn).not.toHaveBeenCalled();
  });
});
