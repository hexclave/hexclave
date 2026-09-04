import { afterEach, describe, expect, it, vi } from "vitest";
import { envVars } from "../generated/env";
import { StackClientApp } from "../lib/hexclave-app";
import { mountPushedConfigErrorOverlay } from ".";

function createMockElement() {
  return {
    style: {},
    appendChild: () => {},
    addEventListener: () => {},
    setAttribute: () => {},
    replaceChildren: () => {},
    remove: () => {},
  };
}

describe("pushed config error overlay", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("defers the first project refresh until after construction-time callers finish", async () => {
    const app = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000000",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "none",
      devTool: false,
    });
    const getProject = vi.fn(async () => ({
      pushedConfigError: null,
      configWarnings: [],
    }));
    Reflect.set(app, "getProject", getProject);
    const appendChild = vi.fn();
    vi.stubEnv("NODE_ENV", "development");
    expect(envVars["NODE_ENV"]).toBe("development");

    vi.stubGlobal("window", {
      "__hexclave-pushed-config-error-overlay": null,
      location: {
        href: "http://localhost:3000",
      },
    });
    vi.stubGlobal("document", {
      body: {
        appendChild,
      },
      createElement: () => createMockElement(),
      createTextNode: () => createMockElement(),
    });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const cleanup = mountPushedConfigErrorOverlay(app);
    try {
      expect(appendChild).toHaveBeenCalledOnce();
      expect(getProject).not.toHaveBeenCalled();

      await Promise.resolve();

      expect(getProject).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }
  });
});
