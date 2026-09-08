/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTvBoxDocument } from "./src/app/tv-box/document.ts";
import { createTvFixtureSnapshot, getTvProfileFixture } from "./src/lib/tv-mode/fixtures.ts";

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
    await vi.advanceTimersByTimeAsync(12_000);
    expect(title()).toBe("TV Mode Temporarily Unavailable");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
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
    await vi.advanceTimersByTimeAsync(12_000);
    expect(document.body.textContent).toContain("Retrying automatically");
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
    stalled.resolve(challenge);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".tv-pairing-code")?.textContent).toBe("2345-ABCD");
  });

  it("never consumes a pairing challenge twice on reconnect, and ignores a late obsolete result", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(jsonResponse(challenge))
      .mockResolvedValueOnce(stalled.response)
      .mockResolvedValueOnce(jsonResponse({ status: "paired", accessToken: "paired-token" }))
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(title()).toBe("Live Pulse");
    stalled.resolve({ status: "used" });
    await vi.advanceTimersByTimeAsync(0);
    expect(title()).toBe("Live Pulse");
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
    await vi.advanceTimersByTimeAsync(60_000);
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
    await vi.advanceTimersByTimeAsync(15_000);
    expect(title()).toBe(variant === "empty" ? "Waiting for Activity" : "TV Mode Is Temporarily Unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
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

  it("bounds refresh bodies inside snapshot requests and continues polling", async () => {
    const stalled = deferredBody();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: "initial-token" }))
      .mockResolvedValueOnce(jsonResponse(null, 401))
      .mockResolvedValueOnce(stalled.response)
      .mockResolvedValueOnce(jsonResponse(snapshot));
    await launch();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
    expect(title()).toBe("TV Mode Is Temporarily Unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
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
    await vi.advanceTimersByTimeAsync(15_000);
    expect(title()).toBe("Live Pulse");
    expect(document.body.textContent).not.toContain("Malformed response");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(title()).toBe("Audience Momentum");
  });

  it.each(["offline", "stale"])("renders the %s QA connection state without live API requests", async (variant) => {
    await launch({ mode: "fixture-preview", snapshot: createTvFixtureSnapshot("renderer-test", profile, variant) });
    expect(document.querySelector(`[data-connection-status].tv-connection-${variant}`)).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
