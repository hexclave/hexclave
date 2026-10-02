// @vitest-environment jsdom

import { InternalSession } from "@hexclave/shared/dist/sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StackAdminApp } from "../interfaces/admin-app";
import { StackClientApp } from "../interfaces/client-app";
import { SessionRecorder } from "./session-replay";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client analytics on admin apps", () => {
  it("does not start SessionRecorder when authenticated via projectOwnerSession", () => {
    const startSpy = vi.spyOn(SessionRecorder.prototype, "start");
    const ownerSession = new InternalSession({
      refreshAccessTokenCallback: async () => null,
      refreshToken: null,
      accessToken: null,
    });

    const adminApp = new StackAdminApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000000",
      tokenStore: null,
      projectOwnerSession: ownerSession,
      noAutomaticPrefetch: true,
      analytics: { enabled: true, replays: { enabled: true } },
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(Reflect.get(adminApp, "_clientAnalytics")).toBeNull();
  });

  it("disables analytics on owned admin apps created from a client app", () => {
    const startSpy = vi.spyOn(SessionRecorder.prototype, "start");
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "internal",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      analytics: { enabled: false },
      telemetry: { resource: { service: { name: "test-client" } } },
    });
    const ownerSession = new InternalSession({
      refreshAccessTokenCallback: async () => null,
      refreshToken: null,
      accessToken: null,
    });

    const getOwnedAdminApp = Reflect.get(clientApp, "_getOwnedAdminApp");
    if (typeof getOwnedAdminApp !== "function") {
      throw new Error("Expected StackClientApp to expose _getOwnedAdminApp in tests.");
    }
    const ownedAdminApp = getOwnedAdminApp.call(
      clientApp,
      "00000000-0000-4000-8000-000000000001",
      ownerSession,
    );

    expect(startSpy).not.toHaveBeenCalled();
    expect(Reflect.get(ownedAdminApp, "_clientAnalytics")).toBeNull();
    expect(Reflect.get(ownedAdminApp, "_analyticsOptions")).toEqual({ enabled: false });
  });
});
