/** @vitest-environment jsdom */
// Kept outside `src` because the framework-free browser runtime is a public ES module, not TypeScript application source.
import { describe, expect, it, vi } from "vitest";
import { createTvFixtureSnapshot, getTvProfileFixture } from "./src/lib/tv-mode/fixtures.ts";
import { createCelebrationLayer } from "./public/tv-box/effects.mjs";
import {
  assertPairingChallenge,
  assertPairingStatus,
  assertTvSnapshot,
  classifyDisplayRefreshResponse,
  createApiUrl,
  createRequestHeaders,
  getCelebrationEffectState,
  getConnectionStatus,
  getFixturePreviewTime,
  getDisplaySessionRetryDelay,
  getNextScreenIndex,
  getScreenDurationSeconds,
  replaceStage,
  resolveTvBoxRuntimeConfiguration,
  selectPresentationView,
  shouldPollDisplaySnapshot,
} from "./public/tv-box/runtime.mjs";

function createSnapshot() {
  return {
    generatedAt: "2026-08-26T12:00:00.000Z",
    staleAfter: "2026-08-26T12:00:45.000Z",
    connectionStatus: "online",
    project: { id: "project-a", displayName: "Demo Project" },
    profile: {
      id: "company-pulse",
      displayName: "Company Pulse",
      mode: "general",
      defaultDurationSeconds: 15,
      playlist: ["live-pulse", "audience-momentum", "revenue-payments", "email-health"],
      screenDurations: [
        { screenId: "live-pulse", durationSeconds: 20 },
        { screenId: "audience-momentum", durationSeconds: 15 },
        { screenId: "revenue-payments", durationSeconds: 15 },
        { screenId: "email-health", durationSeconds: 15 },
      ],
    },
    screens: [
      {
        id: "live-pulse",
        sourceStatus: "ready",
        sourceLabel: "Hexclave activity",
        observedAt: "2026-08-26T12:00:00.000Z",
        window: {},
        diagnosticCode: null,
        data: {
          liveUsers: 4,
          todayActiveUsers: 92,
          hourlyActivity: [{ label: "12", value: 4 }],
          sourceHealth: [{ label: "Audience", status: "ready", value: "Fresh", detail: "All metrics available" }],
        },
        insight: null,
      },
      {
        id: "audience-momentum",
        sourceStatus: "ready",
        sourceLabel: "Hexclave users & analytics",
        observedAt: "2026-08-26T12:00:00.000Z",
        window: {},
        diagnosticCode: null,
        data: {
          totalUsers: 300,
          userGrowthPercent: 5,
          newUsers: 15,
          monthlyActiveUsers: 220,
          verificationRatePercent: 83,
          lifecycle: [{ label: "Mon", primary: 2, secondary: 8, tertiary: 1 }],
          analytics: {
            sourceStatus: "ready",
            observedAt: "2026-08-26T12:00:00.000Z",
            diagnosticCode: null,
            data: { visitors: 120, qualifyingSessions: 20, averageSessionSeconds: 42 },
          },
        },
        insight: null,
      },
      {
        id: "revenue-payments",
        sourceStatus: "ready",
        sourceLabel: "Hexclave payments",
        observedAt: "2026-08-26T12:00:00.000Z",
        window: {},
        diagnosticCode: null,
        data: {
          financials: { visibility: "exact", paidRevenueCents: 129900, revenueTrend: [{ label: "1", value: 129900 }] },
          revenueChangePercent: 8,
          paymentSuccess: { applicableAttempts: 12, percent: 91.7 },
          activeSubscriptions: 18,
          newSubscriptions: 3,
          pastDueSubscriptions: 1,
        },
        insight: null,
      },
      {
        id: "email-health",
        sourceStatus: "ready",
        sourceLabel: "Hexclave email",
        observedAt: "2026-08-26T12:00:00.000Z",
        window: {},
        diagnosticCode: null,
        data: {
          sent: 304,
          deliveryRatePercent: 98.4,
          bounceRatePercent: 0.7,
          volumeChangePercent: 3,
          assessableSends: 300,
          delivered: 295,
          bounced: 2,
          errors: 3,
          inProgress: 4,
          statusTrend: [{ label: "Mon", primary: 42, secondary: 1, tertiary: 1 }],
        },
        insight: null,
      },
    ],
    presentation: { takeover: null, highlight: null },
    fatalErrorMessage: null,
  };
}

describe("TV Box runtime contract", () => {
  it("accepts the centralized celebration fixture used by the QA route", () => {
    const profile = getTvProfileFixture("company-pulse");
    if (profile == null) throw new Error("Missing company-pulse test fixture.");
    const snapshot = createTvFixtureSnapshot("tv-box-qa-test", profile, "celebration-takeover");
    const startedAt = Date.parse(snapshot.generatedAt);

    expect(assertTvSnapshot(snapshot)).toBe(snapshot);
    expect(selectPresentationView(snapshot, 0, startedAt).type).toBe("takeover");
    expect(selectPresentationView(snapshot, 0, startedAt + 60_001).type).toBe("screen");
    expect(getCelebrationEffectState(snapshot, startedAt, false)).toMatchObject({
      entryBurst: true,
      takeoverActive: true,
    });
    expect(getCelebrationEffectState(snapshot, startedAt + 60_001, false)).toMatchObject({
      backgroundAmbient: true,
      foregroundAmbient: true,
      entryBurst: false,
      takeoverActive: false,
    });
  });

  it("accepts the production snapshot shape required by every normal screen", () => {
    const snapshot = createSnapshot();
    expect(assertTvSnapshot(snapshot)).toBe(snapshot);
  });

  it("rejects a malformed screen instead of rendering guessed data", () => {
    const snapshot = createSnapshot();
    snapshot.screens[0].data.liveUsers = "4";
    expect(() => assertTvSnapshot(snapshot)).toThrowError(/live-pulse.*invalid/);
  });

  it("rejects inconsistent event lifecycle presentation data", () => {
    const snapshot = createSnapshot();
    snapshot.presentation.takeover = {
      event: createEvent("celebration", "active"),
      variant: "critical-incident",
      startedAt: "2026-08-26T12:00:00.000Z",
      endsAt: "2026-08-26T12:01:00.000Z",
    };
    expect(() => assertTvSnapshot(snapshot)).toThrowError(/presentation state is invalid/);
  });

  it("validates pairing responses", () => {
    const challenge = {
      challengeId: "challenge-a",
      deviceSecret: "x".repeat(32),
      pairingCode: "1234ABCD",
      pollingIntervalSeconds: 2,
    };
    expect(assertPairingChallenge(challenge)).toBe(challenge);
    expect(assertPairingStatus({ status: "waiting", retryAfterSeconds: 2 })).toEqual({ status: "waiting", retryAfterSeconds: 2 });
    expect(assertPairingStatus({ status: "paired", accessToken: "token" })).toEqual({ status: "paired", accessToken: "token" });
  });
});

describe("TV Box transport and playback helpers", () => {
  it("distinguishes revoked credentials from temporary refresh failures", () => {
    expect(classifyDisplayRefreshResponse(200)).toBe("refreshed");
    expect(classifyDisplayRefreshResponse(204)).toBe("refreshed");
    expect(classifyDisplayRefreshResponse(401)).toBe("invalid-credential");
    expect(classifyDisplayRefreshResponse(408)).toBe("temporary-failure");
    expect(classifyDisplayRefreshResponse(429)).toBe("temporary-failure");
    expect(classifyDisplayRefreshResponse(503)).toBe("temporary-failure");
    expect(() => classifyDisplayRefreshResponse(0)).toThrowError(/valid HTTP status/);
  });

  it("bounds display-session recovery backoff", () => {
    expect([0, 1, 2, 3, 4, 20].map(getDisplaySessionRetryDelay)).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      60_000,
      60_000,
    ]);
    expect(() => getDisplaySessionRetryDelay(-1)).toThrowError(/non-negative integer/);
  });

  it("polls snapshots only for a currently authenticated display session", () => {
    expect(shouldPollDisplaySnapshot("paired", "access-token")).toBe(true);
    expect(shouldPollDisplaySnapshot("paired", null)).toBe(false);
    expect(shouldPollDisplaySnapshot("pairing", "stale-access-token")).toBe(false);
    expect(shouldPollDisplaySnapshot("restoring", "stale-access-token")).toBe(false);
  });

  it("uses a static accent for celebration highlights", () => {
    const container = document.createElement("div");
    const layer = createCelebrationLayer(container);

    layer.update({
      ambientActive: true,
      eventId: "celebration-a",
      entryBurst: false,
      foreground: true,
      takeoverActive: false,
    });

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.childElementCount).toBe(0);
    expect(container.dataset.ambientEffects).toBe("active");
    expect(container.dataset.takeoverEffects).toBe("inactive");

    layer.destroy();
    expect(container.childElementCount).toBe(0);
  });

  it("renders static confetti for celebration takeovers without scheduling animation work", () => {
    const context = {
      fillRect: vi.fn(),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      translate: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame");
    const container = document.createElement("div");
    Object.defineProperties(container, {
      clientHeight: { value: 1080 },
      clientWidth: { value: 1920 },
    });
    const layer = createCelebrationLayer(container);

    layer.update({
      ambientActive: true,
      eventId: "celebration-a",
      entryBurst: true,
      foreground: true,
      takeoverActive: true,
    });

    expect(container.querySelectorAll(".tv-confetti-canvas")).toHaveLength(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalledTimes(72);
    expect(context.translate.mock.calls[0]?.[0]).toBeGreaterThan(1920 * 0.03);
    expect(context.translate.mock.calls[1]?.[0]).toBeLessThan(1920 * 0.97);
    layer.destroy();
    expect(container.childElementCount).toBe(0);

    getContext.mockRestore();
    requestAnimationFrame.mockRestore();
  });

  it("keeps live transport and fixture preview boot modes disjoint", () => {
    expect(resolveTvBoxRuntimeConfiguration({
      mode: "live",
      api: { mode: "configured", apiBaseUrl: "https://api.example.com" },
    }, "https://app.example.com")).toEqual({
      mode: "live",
      apiBaseUrl: "https://api.example.com",
    });

    expect(resolveTvBoxRuntimeConfiguration({
      mode: "live",
      api: { mode: "browser-origin" },
    }, "https://test-box.trycloudflare.com")).toEqual({
      mode: "live",
      apiBaseUrl: "https://test-box.trycloudflare.com",
    });

    const snapshot = createSnapshot();
    const fixture = resolveTvBoxRuntimeConfiguration({
      mode: "fixture-preview",
      snapshot,
    }, "https://app.example.com");
    expect(fixture).toEqual({ mode: "fixture-preview", snapshot });
    expect(fixture).not.toHaveProperty("apiBaseUrl");
  });

  it("advances fixture time from the snapshot using a monotonic elapsed clock", () => {
    expect(getFixturePreviewTime(
      "2026-08-26T12:00:00.000Z",
      1_000,
      4_500,
    )).toBe(Date.parse("2026-08-26T12:00:03.500Z"));
    expect(getFixturePreviewTime(
      "2026-08-26T12:00:00.000Z",
      4_500,
      1_000,
    )).toBe(Date.parse("2026-08-26T12:00:00.000Z"));
  });

  it("adds JSON content type only when a body exists", () => {
    expect(createRequestHeaders({ method: "POST" }).has("content-type")).toBe(false);
    expect(createRequestHeaders({ method: "POST", body: "{}" }).get("content-type")).toBe("application/json");
  });

  it("builds only the existing TV-display API URL", () => {
    expect(createApiUrl("https://app.hexclave.com", "/tv-displays/snapshot"))
      .toBe("https://app.hexclave.com/api/latest/tv-displays/snapshot");
  });

  it("preserves profile durations and wraps rotation", () => {
    const snapshot = createSnapshot();
    expect(getScreenDurationSeconds(snapshot, "live-pulse")).toBe(20);
    expect(getScreenDurationSeconds(snapshot, "email-health")).toBe(15);
    expect(getNextScreenIndex(3, 4)).toBe(0);
  });

  it("derives freshness without replacing the retained snapshot", () => {
    const snapshot = createSnapshot();
    expect(getConnectionStatus(snapshot, true, Date.parse("2026-08-26T12:00:30.000Z"))).toBe("online");
    expect(getConnectionStatus(snapshot, true, Date.parse("2026-08-26T12:01:00.000Z"))).toBe("stale");
    expect(getConnectionStatus(snapshot, false, Date.parse("2026-08-26T12:00:30.000Z"))).toBe("offline");
  });

  it("selects bounded takeovers and the all-empty presentation state", () => {
    const snapshot = createSnapshot();
    snapshot.presentation.takeover = {
      event: createEvent("incident", "active"),
      variant: "incident",
      startedAt: "2026-08-26T12:00:00.000Z",
      endsAt: "2026-08-26T12:01:00.000Z",
    };
    expect(selectPresentationView(snapshot, 0, Date.parse("2026-08-26T12:00:30.000Z")).type).toBe("takeover");
    expect(selectPresentationView(snapshot, 0, Date.parse("2026-08-26T12:01:01.000Z"))).toEqual({ type: "screen", screenIndex: 0 });

    snapshot.presentation.takeover = null;
    for (const screen of snapshot.screens) {
      screen.sourceStatus = "empty";
      screen.data = null;
    }
    expect(selectPresentationView(snapshot, 0, Date.parse("2026-08-26T12:00:30.000Z"))).toEqual({ type: "empty" });
  });

  it("runs celebration effects only within their absolute animation deadline", () => {
    const snapshot = createSnapshot();
    const event = createEvent("celebration", "active");
    snapshot.presentation.highlight = {
      event,
      variant: "celebration",
      expiresAt: "2026-08-26T14:00:00.000Z",
      animationExpiresAt: "2026-08-26T13:00:00.000Z",
    };
    expect(getCelebrationEffectState(snapshot, Date.parse("2026-08-26T12:30:00.000Z"), false)).toEqual({
      eventId: event.id,
      backgroundAmbient: true,
      foregroundAmbient: true,
      entryBurst: false,
      takeoverActive: false,
    });
    expect(getCelebrationEffectState(snapshot, Date.parse("2026-08-26T13:00:01.000Z"), false)).toMatchObject({
      foregroundAmbient: true,
      entryBurst: false,
    });
    expect(getCelebrationEffectState(snapshot, Date.parse("2026-08-26T12:30:00.000Z"), true)).toMatchObject({
      foregroundAmbient: true,
      entryBurst: false,
    });
    expect(getCelebrationEffectState(snapshot, Date.parse("2026-08-26T14:00:01.000Z"), false).foregroundAmbient).toBe(false);
  });

  it("uses entry effects for a celebration takeover and suspends them for an incident", () => {
    const snapshot = createSnapshot();
    const celebration = createEvent("celebration", "active");
    snapshot.presentation.highlight = {
      event: celebration,
      variant: "celebration",
      expiresAt: "2026-08-26T14:00:00.000Z",
      animationExpiresAt: "2026-08-26T13:00:00.000Z",
    };
    snapshot.presentation.takeover = {
      event: celebration,
      variant: "celebration",
      startedAt: "2026-08-26T12:00:00.000Z",
      endsAt: "2026-08-26T12:01:00.000Z",
    };
    expect(getCelebrationEffectState(snapshot, Date.parse("2026-08-26T12:00:30.000Z"), false)).toMatchObject({
      backgroundAmbient: false,
      foregroundAmbient: true,
      entryBurst: true,
      takeoverActive: true,
    });

    snapshot.presentation.takeover = {
      event: createEvent("incident", "active"),
      variant: "incident",
      startedAt: "2026-08-26T12:00:00.000Z",
      endsAt: "2026-08-26T12:01:00.000Z",
    };
    expect(getCelebrationEffectState(snapshot, Date.parse("2026-08-26T12:00:30.000Z"), false)).toMatchObject({
      backgroundAmbient: false,
      foregroundAmbient: false,
      entryBurst: false,
      takeoverActive: false,
    });
  });
});

function createEvent(presentationClass, status) {
  const celebration = presentationClass === "celebration";
  return {
    id: `${presentationClass}-event`,
    type: celebration ? "user-milestone" : "email-delivery-degradation",
    presentationClass,
    status,
    title: celebration ? "10,000 Users" : status === "resolved" ? "Email Delivery Restored" : "Email Delivery Degraded",
    summary: "Evidence-qualified activity was observed.",
    metricLabel: celebration ? "Total Users" : "Delivery Rate",
    metricValue: celebration ? "10K" : "82%",
    expectedRange: celebration ? null : "Expected 98% or higher",
    sourceLabel: celebration ? "Hexclave Users" : "Hexclave Email",
    occurredAt: "2026-08-26T12:00:00.000Z",
    updatedAt: "2026-08-26T12:00:00.000Z",
  };
}

describe("TV Box stage replacement", () => {
  it("hard-cuts to the incoming screen even when animation is requested", () => {
    const root = document.createElement("main");
    const current = document.createElement("section");
    const incoming = document.createElement("section");
    root.append(current);

    replaceStage(root, incoming, true);

    expect([...root.children]).toEqual([incoming]);
    expect(incoming.className).toBe("");
  });

  it("replaces immediately when animation is disabled", () => {
    const root = document.createElement("main");
    const current = document.createElement("section");
    const incoming = document.createElement("section");
    root.append(current);

    replaceStage(root, incoming, false);

    expect([...root.children]).toEqual([incoming]);
  });

  it("keeps only the newest screen across consecutive replacements", () => {
    const root = document.createElement("main");
    const current = document.createElement("section");
    const superseded = document.createElement("section");
    const latest = document.createElement("section");
    root.append(current);

    replaceStage(root, superseded, true);
    replaceStage(root, latest, true);

    expect([...root.children]).toEqual([latest]);
    expect(root.contains(superseded)).toBe(false);
  });
});
