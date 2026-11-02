// @vitest-environment jsdom

import { HexclaveClientInterface } from "@hexclave/shared";
import { clerkTokenStore, HexclaveClientApp } from "@hexclave/js";
import { Result } from "@hexclave/shared/dist/utils/results";
import { afterEach, vi } from "vitest";
import { it } from "../helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does not create anonymous users or upload analytics for signed-out external-auth apps", async ({ expect }) => {
  vi.useFakeTimers();
  const app = new HexclaveClientApp({
    baseUrl: "http://localhost:12345",
    projectId: "00000000-0000-4000-8000-000000000000",
    publishableClientKey: "stack-pk-test",
    tokenStore: clerkTokenStore({ getSessionId: () => null, getToken: async () => null }),
    redirectMethod: "none",
    noAutomaticPrefetch: true,
    devTool: false,
    analytics: { replays: { enabled: false } },
  });
  const getUser = vi.spyOn(app, "getUser");
  const sdkInterface: unknown = Reflect.get(app, "_interface");
  if (!(sdkInterface instanceof HexclaveClientInterface)) {
    throw new Error("Expected the SDK analytics transport to exist");
  }
  const sendBatch = vi.spyOn(sdkInterface, "sendAnalyticsEventBatch").mockResolvedValue(Result.ok(new Response()));
  const tracker: unknown = Reflect.get(app, "_eventTracker");
  if (tracker == null || typeof tracker !== "object" || !("stop" in tracker) || typeof tracker.stop !== "function") {
    throw new Error("Expected the SDK event tracker to start");
  }
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getUser).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  } finally {
    tracker.stop();
  }
});
