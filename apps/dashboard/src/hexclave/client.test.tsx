// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const clientAppState = vi.hoisted(() => ({
  constructorOptions: [] as Array<{ automaticSideEffects?: boolean }>,
}));

vi.mock("@hexclave/next", () => ({
  StackClientApp: class {
    constructor(options: { automaticSideEffects?: boolean }) {
      clientAppState.constructorOptions.push(options);
    }
  },
}));

vi.mock("@/lib/env", () => {
  const publicEnvironment = new Map<string, string>([
    ["NEXT_PUBLIC_STACK_PROJECT_ID", "internal"],
    ["NEXT_PUBLIC_STACK_IS_PREVIEW", "false"],
    ["NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT", "false"],
    ["NEXT_PUBLIC_BROWSER_STACK_API_URL", "http://localhost:8102"],
    ["NEXT_PUBLIC_SERVER_STACK_API_URL", "http://localhost:8102"],
    ["NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY", "test-key"],
  ]);
  return {
    getPublicEnvVar: (name: string) => publicEnvironment.get(name),
  };
});

vi.mock("../polyfills", () => ({}));

beforeEach(() => {
  vi.resetModules();
  clientAppState.constructorOptions.length = 0;
});

describe("dashboard client automatic side effects", () => {
  it("disables dashboard side effects for the independent display", async () => {
    window.history.replaceState({}, "", "/tv");

    await import("./client");

    expect(clientAppState.constructorOptions).toHaveLength(1);
    expect(clientAppState.constructorOptions[0]?.automaticSideEffects).toBe(false);
  });

  it("retains dashboard side effects on ordinary dashboard routes", async () => {
    window.history.replaceState({}, "", "/projects/project-id/tv-mode");

    await import("./client");

    expect(clientAppState.constructorOptions).toHaveLength(1);
    expect(clientAppState.constructorOptions[0]?.automaticSideEffects).toBe(true);
  });
});
