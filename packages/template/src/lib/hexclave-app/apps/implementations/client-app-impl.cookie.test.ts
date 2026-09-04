// IF_PLATFORM next js
import { describe, expect, it, vi } from "vitest";
import { encodeBase32 } from "@hexclave/shared/dist/utils/bytes";
import { getTrustedParentDomain } from "@hexclave/shared/dist/utils/redirect-urls";
import { TextEncoder } from "util";
import { StackClientApp } from "../interfaces/client-app";

const serverCookieState = vi.hoisted(() => ({
  values: new Map<string, string>(),
}));

vi.mock("../../../cookie", () => {
  const getAll = () => Object.fromEntries(serverCookieState.values);
  const remove = (name: string) => {
    serverCookieState.values.delete(name);
  };
  const setOrDelete = (name: string, value: string | null) => {
    if (value === null) {
      remove(name);
    } else {
      serverCookieState.values.set(name, value);
    }
  };
  const helper = {
    get: (name: string) => serverCookieState.values.get(name) ?? null,
    getAll,
    set: (name: string, value: string) => setOrDelete(name, value),
    setOrDelete,
    delete: remove,
  };
  return {
    createBrowserCookieHelper: () => helper,
    createCookieHelper: async () => helper,
    createPlaceholderCookieHelper: async () => helper,
    deleteCookie: async (name: string) => remove(name),
    deleteCookieClient: remove,
    getCookieClient: (name: string) => serverCookieState.values.get(name) ?? null,
    isSecure: async () => true,
    saveVerifierAndState: async () => {
      throw new Error("saveVerifierAndState is not used in this test");
    },
    setOrDeleteCookie: async (name: string, value: string | null) => setOrDelete(name, value),
    setOrDeleteCookieClient: setOrDelete,
  };
});

describe("StackClientApp custom refresh cookie updates", () => {
  it("preserves the existing custom and default cookies without a server hostname", async () => {
    expect(getTrustedParentDomain("_.example.com", ["https://example.com", "https://**.example.com"])).toBe("example.com");
    const projectId = "00000000-0000-4000-8000-000000000000";
    const customCookieName = `hexclave-refresh-${projectId}--custom-${encodeBase32(new TextEncoder().encode("example.com"))}`;
    const defaultCookieName = `__Host-hexclave-refresh-${projectId}--default`;
    serverCookieState.values.clear();
    serverCookieState.values.set(defaultCookieName, JSON.stringify({ refresh_token: "old-refresh", updated_at_millis: 1 }));
    serverCookieState.values.set(customCookieName, JSON.stringify({ refresh_token: "old-refresh", updated_at_millis: 1 }));

    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId,
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const trustedParentLookups: string[] = [];
    Reflect.set(clientApp, "_getTrustedParentDomain", async (domain: string) => {
      trustedParentLookups.push(domain);
      return domain === "_.example.com" ? "example.com" : null;
    });
    const getOrCreateTokenStore = Reflect.get(clientApp, "_getOrCreateTokenStore");
    const cookieHelper = {
      get: (name: string) => serverCookieState.values.get(name) ?? null,
      getAll: () => Object.fromEntries(serverCookieState.values),
      set: (name: string, value: string) => serverCookieState.values.set(name, value),
      setOrDelete: (name: string, value: string | null) => {
        if (value === null) {
          serverCookieState.values.delete(name);
        } else {
          serverCookieState.values.set(name, value);
        }
      },
      delete: (name: string) => serverCookieState.values.delete(name),
    };
    const tokenStore = getOrCreateTokenStore.call(clientApp, cookieHelper, "nextjs-cookie");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    tokenStore.set({ accessToken: "new-access", refreshToken: "new-refresh" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect.soft(warnSpy).not.toHaveBeenCalled();
    const customCookieValue = serverCookieState.values.get(customCookieName);
    expect.soft(customCookieValue).toBeDefined();
    if (customCookieValue != null) {
      expect.soft(JSON.parse(customCookieValue)).toEqual({
        refresh_token: "new-refresh",
        updated_at_millis: expect.any(Number),
      });
    }
    expect.soft(serverCookieState.values.has(defaultCookieName)).toBe(true);
    expect.soft(trustedParentLookups).toEqual(["_.example.com"]);
    warnSpy.mockRestore();
  });

  it("recovers the custom cookie after overlapping server updates", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const customCookieName = `hexclave-refresh-${projectId}--custom-${encodeBase32(new TextEncoder().encode("example.com"))}`;
    const defaultCookieName = `__Host-hexclave-refresh-${projectId}--default`;
    serverCookieState.values.clear();
    serverCookieState.values.set(defaultCookieName, JSON.stringify({ refresh_token: "old-refresh", updated_at_millis: 1 }));
    serverCookieState.values.set(customCookieName, JSON.stringify({ refresh_token: "old-refresh", updated_at_millis: 1 }));

    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId,
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      devTool: false,
    });
    let releaseTrustedParentLookup: (() => void) | undefined;
    let shouldBlockTrustedParentLookup = true;
    Reflect.set(clientApp, "_getTrustedParentDomain", async (domain: string) => {
      if (shouldBlockTrustedParentLookup) {
        shouldBlockTrustedParentLookup = false;
        await new Promise<void>((resolve) => {
          releaseTrustedParentLookup = resolve;
        });
      }
      return domain === "_.example.com" ? "example.com" : null;
    });
    const getOrCreateTokenStore = Reflect.get(clientApp, "_getOrCreateTokenStore");
    const cookieHelper = {
      get: (name: string) => serverCookieState.values.get(name) ?? null,
      getAll: () => Object.fromEntries(serverCookieState.values),
      set: (name: string, value: string) => serverCookieState.values.set(name, value),
      setOrDelete: (name: string, value: string | null) => {
        if (value === null) {
          serverCookieState.values.delete(name);
        } else {
          serverCookieState.values.set(name, value);
        }
      },
      delete: (name: string) => serverCookieState.values.delete(name),
    };
    const tokenStore = getOrCreateTokenStore.call(clientApp, cookieHelper, "nextjs-cookie");

    tokenStore.set({ accessToken: "first-access", refreshToken: "first-refresh" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (releaseTrustedParentLookup == null) {
      throw new Error("Expected the first custom cookie recovery lookup to be pending.");
    }
    tokenStore.set({ accessToken: "second-access", refreshToken: "second-refresh" });
    releaseTrustedParentLookup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const customCookieValue = serverCookieState.values.get(customCookieName);
    expect(customCookieValue).toBeDefined();
    if (customCookieValue == null) {
      throw new Error("Expected the custom refresh cookie to be recovered.");
    }
    expect(JSON.parse(customCookieValue)).toMatchObject({
      refresh_token: "second-refresh",
      updated_at_millis: expect.any(Number),
    });
    expect(serverCookieState.values.has(defaultCookieName)).toBe(true);
  });
});
// END_PLATFORM
