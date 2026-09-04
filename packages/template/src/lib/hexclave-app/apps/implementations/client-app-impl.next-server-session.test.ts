import { describe, expect, it } from "vitest";
import { CookieHelper } from "../../../cookie";
import { StackClientApp } from "../interfaces/client-app";

function createCookieHelper(identity: CookieHelper["identity"]): CookieHelper {
  return {
    identity,
    get: () => null,
    getAll: () => ({}),
    set: () => {},
    setOrDelete: () => {},
    delete: () => {},
  };
}

function createClientApp() {
  return new StackClientApp({
    baseUrl: "http://localhost:12345",
    projectId: "00000000-0000-4000-8000-000000000000",
    publishableClientKey: "stack-pk-test",
    tokenStore: "memory",
    redirectMethod: "none",
    noAutomaticPrefetch: true,
    devTool: false,
  });
}

describe("StackClientApp Next.js server sessions", () => {
  it("shares one token store and session across cookie helpers from the same request", () => {
    const clientApp = createClientApp();
    const getTokenStore = clientApp["_getOrCreateTokenStore"];
    const getSession = clientApp["_getSessionFromTokenStore"];
    const requestIdentity = {};

    const firstStore = getTokenStore.call(clientApp, createCookieHelper(requestIdentity), "nextjs-cookie");
    const secondStore = getTokenStore.call(clientApp, createCookieHelper(requestIdentity), "nextjs-cookie");

    expect(secondStore).toBe(firstStore);
    expect(getSession.call(clientApp, secondStore)).toBe(getSession.call(clientApp, firstStore));
  });

  it("isolates token stores belonging to different requests", () => {
    const clientApp = createClientApp();
    const getTokenStore = clientApp["_getOrCreateTokenStore"];

    const firstStore = getTokenStore.call(clientApp, createCookieHelper({}), "nextjs-cookie");
    const secondStore = getTokenStore.call(clientApp, createCookieHelper({}), "nextjs-cookie");

    expect(secondStore).not.toBe(firstStore);
  });
});
