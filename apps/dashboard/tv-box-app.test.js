/** @vitest-environment jsdom */
import { CookieJar } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTvBoxDocument } from "./src/app/tv-box/document.ts";
import { createTvFixtureSnapshot, getTvProfileFixture } from "./src/lib/tv-mode/fixtures.ts";
import {
  DISPLAY_SESSION_RETRY_INITIAL_MS,
  DISPLAY_SESSION_RETRY_MAXIMUM_MS,
  TV_SNAPSHOT_POLL_INTERVAL_MS,
  TV_SNAPSHOT_REQUEST_TIMEOUT_MS,
} from "./public/tv-box/runtime.mjs";

const profile = getTvProfileFixture("company-pulse");
if (profile == null) throw new Error("The renderer tests require the company-pulse fixture.");
const challenge = {
  challengeId: "927dfeac-2e80-4311-8180-4879b687bfc0",
  pairingCode: "A2BC3DEF",
  deviceSecret: "display-secret-with-at-least-32-characters",
  expiresAt: "2099-08-19T01:00:00.000Z",
  pollingIntervalSeconds: 5,
};
function createSnapshot(variant = "default") {
  const result = createTvFixtureSnapshot("renderer-test", profile, variant);
  return {
    ...result,
    profile: {
      ...result.profile,
      defaultDurationSeconds: 20,
      screenDurations: result.profile.playlist.map((screenId) => ({ screenId, durationSeconds: 20 })),
    },
  };
}
const snapshot = createSnapshot();
const fetchMock = vi.fn();

function jsonResponse(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredBody() {
  const pending = Promise.withResolvers();
  const response = new Response(null, { status: 200 });
  vi.spyOn(response, "json").mockReturnValue(pending.promise);
  return { response, resolve: pending.resolve };
}

async function launch(options = { mode: "live", api: { mode: "configured", apiBaseUrl: "https://api.example.com" } }) {
  const markup = new DOMParser().parseFromString(createTvBoxDocument(options), "text/html");
  document.body.replaceChildren(...markup.body.childNodes);
  // Import the real entrypoint, including its listeners and asynchronous startup.
  // No test-only exports or copies of the production controller are involved.
  await import("./public/tv-box/app.mjs");
  await vi.advanceTimersByTimeAsync(0);
}

function title() {
  return document.querySelector("#tv-box-stage h1")?.textContent;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(snapshot.generatedAt));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

afterEach(async () => {
  window.dispatchEvent(new Event("pagehide"));
  await vi.advanceTimersByTimeAsync(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("TV Box actual renderer orchestration", () => {
  it("signals module readiness before waiting for the backend", async () => {
    const ready = vi.fn();
    window.addEventListener("hexclave-tv-box-ready", ready, { once: true });
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await launch();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Connecting TV Mode");
  });

  it("times out a stalled refresh body and restores without asking to pair", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(stalled.response)
      .mockResolvedValueOnce(jsonResponse({ accessToken: "restored-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
    expect(title()).toBe("TV Mode Temporarily Unavailable");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_INITIAL_MS);
    expect(title()).toBe("Live Pulse");
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toMatchInlineSnapshot(`
      [
        "/api/latest/tv-displays/auth/refresh",
        "/api/latest/tv-displays/auth/refresh",
        "/api/latest/tv-displays/snapshot",
      ]
    `);
    stalled.resolve({ accessToken: "expired-response-token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Live Pulse");
  });

  it("reports a stalled snapshot fetch as a snapshot timeout", async () => {
    const error = vi.spyOn(console, "error");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockReturnValueOnce(new Promise(() => {}));
    await launch();
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("snapshot-timeout"),
      expect.any(Error),
    );
  });

  it("keeps challenge creation single-flight across reconnects and ignores a timed-out body", async () => {
    const stalled = deferredBody();
    const replacement = { ...challenge, pairingCode: "2345ABCD" };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(stalled.response)
      .mockResolvedValueOnce(jsonResponse(replacement))
      .mockResolvedValue(jsonResponse({ status: "waiting", retryAfterSeconds: 5 }));
    await launch();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
    expect(document.body.textContent).toContain("Retrying automatically");
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_INITIAL_MS);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
    stalled.resolve(challenge);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
  });

  it("restores the received cookie after a consumed pairing body stalls, without overlapping recovery", async () => {
    const stalled = deferredBody();
    const restored = deferredBody();
    const cookieJar = new CookieJar();
    const cookie = "hexclave-tv-display-refresh=example-refresh-token; Path=/api/latest/tv-displays; HttpOnly; Secure";
    stalled.response.headers.set("set-cookie", cookie);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockImplementationOnce(async (url, options) => {
        // Fetch delivers headers, and the browser stores HttpOnly cookies,
        // before the JSON body completes. A body timeout does not undo that.
        expect(options.credentials).toBe("include");
        cookieJar.setCookieSync(cookie, url);
        return stalled.response;
      })
      .mockResolvedValueOnce(jsonResponse({ status: "used" }))
      .mockImplementationOnce(async (url, options) => {
        expect(new URL(url).pathname).toBe("/api/latest/tv-displays/auth/refresh");
        expect(options.credentials).toBe("include");
        expect(cookieJar.getCookieStringSync(url)).toBe("hexclave-tv-display-refresh=example-refresh-token");
        return restored.response;
      })
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_INITIAL_MS);
    expect(title()).toBe("Connecting TV Mode");
    expect(document.querySelector(".tv-pairing-code")).toBeNull();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    restored.resolve({ accessToken: "restored-token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Live Pulse");
    stalled.resolve({ status: "paired", accessToken: "obsolete-token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Live Pulse");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[5][1].headers.get("authorization")).toBe("Bearer restored-token");
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toMatchInlineSnapshot(`
      [
        "/api/latest/tv-displays/auth/refresh",
        "/api/latest/tv-displays/pairing-challenges",
        "/api/latest/tv-displays/pairing-challenges/927dfeac-2e80-4311-8180-4879b687bfc0/status",
        "/api/latest/tv-displays/pairing-challenges/927dfeac-2e80-4311-8180-4879b687bfc0/status",
        "/api/latest/tv-displays/auth/refresh",
        "/api/latest/tv-displays/snapshot",
      ]
    `);
  });

  it("requires a new pairing when a consumed challenge has no valid refresh cookie", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse({ status: "used" }))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({
        ...challenge,
        challengeId: "eb3c1c65-4c2e-4c0d-9a68-8868b635fbea",
        pairingCode: "2345ABCD",
      }))
      .mockImplementation(async () => jsonResponse({ status: "waiting", retryAfterSeconds: 5 }));
    await launch();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
    expect(document.body.textContent).not.toContain(snapshot.project.displayName);
    expect(fetchMock.mock.calls.slice(0, 5).map(([url]) => new URL(url).pathname)).toMatchInlineSnapshot(`
      [
        "/api/latest/tv-displays/auth/refresh",
        "/api/latest/tv-displays/pairing-challenges",
        "/api/latest/tv-displays/pairing-challenges/927dfeac-2e80-4311-8180-4879b687bfc0/status",
        "/api/latest/tv-displays/auth/refresh",
        "/api/latest/tv-displays/pairing-challenges",
      ]
    `);
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/snapshot"))).toBe(false);
  });

  it.each(["expired", "rejected"])("renews a %s challenge without treating it as a consumed approval", async (status) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse({ status }))
      .mockResolvedValueOnce(jsonResponse({ ...challenge, pairingCode: "2345ABCD" }))
      .mockImplementation(async () => jsonResponse({ status: "waiting", retryAfterSeconds: 5 }));
    await launch();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
    expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/snapshot"))).toBe(false);
  });

  it("returns a recovered pairing to a new challenge when refreshed snapshot access is rejected, without background snapshot polling", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse({ status: "used" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "recovered-token" }))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "refreshed-token" }))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({
        ...challenge,
        challengeId: "eb3c1c65-4c2e-4c0d-9a68-8868b635fbea",
        pairingCode: "2345ABCD",
      }))
      .mockImplementation(async () => jsonResponse({ status: "waiting", retryAfterSeconds: 5 }));
    await launch();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_MAXIMUM_MS);
    const requestedPaths = fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
    expect(requestedPaths.filter((path) => path.endsWith("/snapshot"))).toHaveLength(2);
    expect(requestedPaths.filter((path) => path.endsWith("/auth/refresh"))).toHaveLength(3);
    expect(requestedPaths.filter((path) => path.endsWith("/pairing-challenges"))).toHaveLength(2);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
    expect(document.body.textContent).not.toContain(snapshot.project.displayName);
  });

  it.each(["server", "transport", "timeout"])("retries %s failures while restoring a consumed pairing without creating another challenge", async (failure) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse({ status: "used" }));
    if (failure === "server") {
      fetchMock.mockResolvedValueOnce(jsonResponse(null, 503));
    } else if (failure === "transport") {
      fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    } else {
      fetchMock.mockResolvedValueOnce(deferredBody().response);
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "restored-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    if (failure === "timeout") {
      await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
      expect(fetchMock.mock.calls[3][1].signal.aborted).toBe(true);
    }
    expect(title()).toBe("TV Mode Temporarily Unavailable");
    expect(document.querySelector(".tv-pairing-code")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_INITIAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(title()).toBe("Live Pulse");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/pairing-challenges"))).toHaveLength(1);
  });

  it.each(["body", "backoff"])("cancels consumed-pairing recovery during %s on page exit", async (phase) => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse({ status: "used" }))
      .mockResolvedValueOnce(phase === "body" ? stalled.response : jsonResponse(null, 503));
    await launch();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new URL(fetchMock.mock.calls[3][0]).pathname).toBe("/api/latest/tv-displays/auth/refresh");
    window.dispatchEvent(new Event("pagehide"));
    stalled.resolve({ accessToken: "obsolete-token" });
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_MAXIMUM_MS);
    if (phase === "body") expect(fetchMock.mock.calls[3][1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.body.textContent).not.toContain(snapshot.project.displayName);
  });

  it("aborts pending pairing on page exit without applying or retrying its late response", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(stalled.response);
    await launch();
    window.dispatchEvent(new Event("pagehide"));
    stalled.resolve({ status: "paired", accessToken: "obsolete-token" });
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_MAXIMUM_MS);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["empty", "error"])("resumes rotation after the %s presentation recovers", async (variant) => {
    const unavailable = createSnapshot(variant);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "restored-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockImplementation(async () => jsonResponse(snapshot));
    await launch();
    expect(title()).toBe("Live Pulse");
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(title()).toBe(variant === "empty" ? "Waiting for Activity" : "TV Mode Is Temporarily Unavailable");
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(title()).toBe("Live Pulse");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(title()).toBe("Audience Momentum");
  });

  it("resumes the same playlist after revocation and re-pairing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(jsonResponse({ status: "paired", accessToken: "replacement-token" }))
      .mockImplementation(async () => jsonResponse(snapshot));
    await launch();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(title()).toBe("Live Pulse");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(title()).toBe("Audience Momentum");
  });

  it("clears the previous presentation immediately after a post-refresh snapshot rejection", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "refreshed-token" }))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(stalled.response);
    await launch();
    expect(document.body.textContent).toContain(snapshot.project.displayName);
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(title()).toBe("Launch TV Mode");
    expect(document.body.textContent).not.toContain(snapshot.project.displayName);
    expect(document.querySelector("#tv-box-footer")?.textContent).toBe("");
    expect(document.querySelector("#tv-box-controls")?.textContent).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(new URL(fetchMock.mock.calls[5][0]).pathname).toBe("/api/latest/tv-displays/pairing-challenges");
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
    expect(document.body.textContent).not.toContain(snapshot.project.displayName);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each(["refresh", "snapshot"])("retains the authorized presentation across a temporary %s failure during credential renewal", async (failure) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(null, 401));
    if (failure === "snapshot") {
      fetchMock.mockResolvedValueOnce(jsonResponse({ accessToken: "refreshed-token" }));
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 503))
      .mockImplementation(async () => jsonResponse(snapshot));
    await launch();
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(document.body.textContent).toContain(snapshot.project.displayName);
    expect(document.querySelector(".tv-pairing-code-panel")).toBeNull();
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(document.body.textContent).toContain(snapshot.project.displayName);
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/pairing-challenges"))).toBe(false);
  });

  it("bounds refresh bodies inside snapshot requests and continues polling", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(stalled.response)
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_REQUEST_TIMEOUT_MS);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
    expect(title()).toBe("TV Mode Is Temporarily Unavailable");
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(title()).toBe("Live Pulse");
  });

  it("retains the last snapshot when a body stalls without applying it after the deadline", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(stalled.response)
      .mockImplementation(async () => jsonResponse(snapshot));
    await launch();
    await vi.advanceTimersByTimeAsync(27_000);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
    stalled.resolve({ ...snapshot, project: { ...snapshot.project, displayName: "Obsolete response" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.body.textContent).not.toContain("Obsolete response");
    expect(document.body.textContent).toContain(snapshot.project.displayName);
  });

  it("keeps rendering the last safe snapshot when fresh data contains malformed insight evidence", async () => {
    const malformed = {
      ...snapshot,
      screens: snapshot.screens.map((screen) => screen.id === "live-pulse"
        ? { ...screen, insight: { message: "Malformed response", evidence: null } }
        : screen),
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce(jsonResponse(malformed));
    await launch();
    await vi.advanceTimersByTimeAsync(TV_SNAPSHOT_POLL_INTERVAL_MS);
    expect(title()).toBe("Live Pulse");
    expect(document.body.textContent).not.toContain("Malformed response");
    await vi.advanceTimersByTimeAsync(DISPLAY_SESSION_RETRY_INITIAL_MS);
    expect(title()).toBe("Audience Momentum");
  });

  it.each(["offline", "stale"])("renders the %s QA connection state without live API requests", async (variant) => {
    await launch({ mode: "fixture-preview", snapshot: createTvFixtureSnapshot("renderer-test", profile, variant) });
    expect(document.querySelector(`[data-connection-status].tv-connection-${variant}`)).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a visible notice when fullscreen fails", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error("denied")),
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    document.querySelector('button[aria-label="Enter fullscreen"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".tv-control-notice")?.textContent).toMatch(/Fullscreen isn’t available/);
    expect(document.querySelector(".tv-control-notice")?.getAttribute("role")).toBe("alert");
    await vi.advanceTimersByTimeAsync(2_801);
    expect(document.querySelector(".tv-control-notice")).toBeNull();
  });

  it("does not show a notice when fullscreen succeeds", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    document.querySelector('button[aria-label="Enter fullscreen"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".tv-control-notice")).toBeNull();
  });
});
