// @vitest-environment jsdom

import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import { HexclaveContext } from "../providers/hexclave-context";
import { useCliAuthConfirmation } from "./cli-auth-confirm";

const previousActEnvironment = globalThis["IS_REACT_ACT_ENVIRONMENT"];

function responseJson(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createAppTestDouble(options: {
  user: unknown,
  sendRequest: (path: string, requestOptions: RequestInit) => Promise<Response>,
  signInWithTokens?: (tokens: { accessToken: string, refreshToken: string }) => Promise<void>,
  redirectToSignIn?: (options: { replace: true }) => Promise<void>,
  redirectToSignUp?: (options: { replace: true }) => Promise<void>,
  redirectToOnboarding?: (options: { replace: true }) => Promise<void>,
}) {
  const app = {
    useUser: () => options.user,
    redirectToSignIn: options.redirectToSignIn ?? vi.fn(async () => {}),
    redirectToSignUp: options.redirectToSignUp ?? vi.fn(async () => {}),
    redirectToOnboarding: options.redirectToOnboarding ?? vi.fn(async () => {}),
    [hexclaveAppInternalsSymbol]: {
      sendRequest: options.sendRequest,
      signInWithTokens: options.signInWithTokens ?? vi.fn(async () => {}),
    },
  };

  // This test double intentionally implements only the StackClientApp surface
  // that useCliAuthConfirmation touches.
  return app as unknown as StackClientApp<true>;
}

function HookProbe() {
  const cliAuth = useCliAuthConfirmation();
  return (
    <>
      <div data-testid="status">{cliAuth.status}</div>
      <div data-testid="error">{cliAuth.error?.message}</div>
      <button type="button" onClick={() => runAsynchronously(cliAuth.authorize)}>authorize</button>
      <button onClick={cliAuth.retry}>retry</button>
    </>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderWithApp(app: StackClientApp<true>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <HexclaveContext.Provider value={{ app }}>
        <HookProbe />
      </HexclaveContext.Provider>
    );
  });
}

function getByTestId(testId: string): HTMLElement {
  const element = container?.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Could not find test element ${testId}`);
  }
  return element;
}

function getButton(label: string): HTMLButtonElement {
  const button = [...container?.querySelectorAll("button") ?? []]
    .find((element) => element.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button ${label}`);
  }
  return button;
}

describe("useCliAuthConfirmation", () => {
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
    vi.restoreAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("completes CLI auth with the current user's refresh token", async () => {
    window.history.replaceState({}, "", "/handler/cli-auth-confirm?login_code=login-code");
    const getTokens = vi.fn(async () => ({ refreshToken: "refresh-token" }));
    const sendRequest = vi.fn(async (_path: string, _requestOptions: RequestInit) => new Response(null, { status: 200 }));
    const app = createAppTestDouble({
      user: { currentSession: { getTokens } },
      sendRequest,
    });

    await renderWithApp(app);
    await act(async () => {
      getButton("authorize").click();
    });

    expect(getByTestId("status").textContent).toBe("success");
    expect(getTokens).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest.mock.calls[0][0]).toBe("/auth/cli/complete");
    expect(JSON.parse(String(sendRequest.mock.calls[0][1].body))).toMatchInlineSnapshot(`
      {
        "login_code": "login-code",
        "refresh_token": "refresh-token",
      }
    `);
  });

  it("redirects restricted users to onboarding without completing CLI auth", async () => {
    window.history.replaceState({}, "", "/handler/cli-auth-confirm?login_code=login-code");
    const redirectToOnboarding = vi.fn(async (_options: { replace: true }) => {});
    const sendRequest = vi.fn(async (_path: string, _requestOptions: RequestInit) => new Response(null, { status: 200 }));
    const app = createAppTestDouble({
      user: {
        isRestricted: true,
        isAnonymous: false,
        currentSession: {
          getTokens: vi.fn(async () => ({ refreshToken: "restricted-refresh-token" })),
        },
      },
      sendRequest,
      redirectToOnboarding,
    });

    await renderWithApp(app);
    await act(async () => {
      getButton("authorize").click();
    });

    expect(redirectToOnboarding).toHaveBeenCalledWith({ replace: true });
    expect(sessionStorage.getItem("hexclave-cli-auth-confirmed")).toBe("login-code");
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("redirects anonymous users to sign-up without completing CLI auth", async () => {
    window.history.replaceState({}, "", "/handler/cli-auth-confirm?login_code=login-code");
    const redirectToSignUp = vi.fn(async (_options: { replace: true }) => {});
    const sendRequest = vi.fn(async (_path: string, _requestOptions: RequestInit) => new Response(null, { status: 200 }));
    const app = createAppTestDouble({
      user: {
        isRestricted: true,
        isAnonymous: true,
        currentSession: {
          getTokens: vi.fn(async () => ({ refreshToken: "anonymous-refresh-token" })),
        },
      },
      sendRequest,
      redirectToSignUp,
    });

    await renderWithApp(app);
    await act(async () => {
      getButton("authorize").click();
    });

    expect(redirectToSignUp).toHaveBeenCalledWith({ replace: true });
    expect(sessionStorage.getItem("hexclave-cli-auth-confirmed")).toBe("login-code");
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("ignores duplicate authorize clicks before React re-renders", async () => {
    window.history.replaceState({}, "", "/handler/cli-auth-confirm?login_code=login-code");
    const getTokens = vi.fn(async () => ({ refreshToken: "refresh-token" }));
    const sendRequest = vi.fn(async (_path: string, _requestOptions: RequestInit) => new Response(null, { status: 200 }));
    const app = createAppTestDouble({
      user: { currentSession: { getTokens } },
      sendRequest,
    });

    await renderWithApp(app);
    await act(async () => {
      const authorizeButton = getButton("authorize");
      authorizeButton.click();
      authorizeButton.click();
    });

    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it("claims anonymous CLI sessions before redirecting to sign-up", async () => {
    window.history.replaceState({}, "", "/handler/cli-auth-confirm?login_code=login-code");
    const signInWithTokens = vi.fn(async (_tokens: { accessToken: string, refreshToken: string }) => {});
    const redirectToSignUp = vi.fn(async (_options: { replace: true }) => {});
    const sendRequest = vi.fn(async (_path: string, _requestOptions: RequestInit) => new Response(null, { status: 200 }))
      .mockResolvedValueOnce(responseJson({ cli_session_state: "anonymous" }))
      .mockResolvedValueOnce(responseJson({ access_token: "access-token", refresh_token: "refresh-token" }));
    const app = createAppTestDouble({
      user: null,
      sendRequest,
      signInWithTokens,
      redirectToSignUp,
    });

    await renderWithApp(app);
    await act(async () => {
      getButton("authorize").click();
    });

    expect(redirectToSignUp).toHaveBeenCalledWith({ replace: true });
    expect(signInWithTokens).toHaveBeenCalledWith({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    expect(sessionStorage.getItem("hexclave-cli-auth-confirmed")).toBe("login-code");
    expect(sendRequest.mock.calls.map(call => JSON.parse(String(call[1].body)))).toMatchInlineSnapshot(`
      [
        {
          "login_code": "login-code",
          "mode": "check",
        },
        {
          "login_code": "login-code",
          "mode": "claim-anon-session",
        },
      ]
    `);
  });

  it("reports invalid when the login code is missing", async () => {
    window.history.replaceState({}, "", "/handler/cli-auth-confirm");
    const app = createAppTestDouble({
      user: null,
      sendRequest: vi.fn(async (_path: string, _requestOptions: RequestInit) => new Response(null, { status: 200 })),
    });

    await renderWithApp(app);

    expect(getByTestId("status").textContent).toBe("invalid");
  });
});
