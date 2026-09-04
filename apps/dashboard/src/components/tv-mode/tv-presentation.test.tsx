// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTvFixtureSnapshot } from "@/lib/tv-mode/fixtures";
import type { TvAudienceMomentumScreen } from "@/lib/tv-mode/types";
import * as errorReporting from "@hexclave/shared/dist/utils/errors";
import { getTvInsightPresentation, renderTvScreen } from "./screen-registry";
import { TvPresentation } from "./tv-presentation";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T14:32:00.000Z"));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document.documentElement, "requestFullscreen");
  Reflect.deleteProperty(document, "exitFullscreen");
  vi.useRealTimers();
});

describe("TvPresentation rotation", () => {
  it("reports a missing configured screen once while showing the terminal empty state", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    const captureError = vi.spyOn(errorReporting, "captureError");
    const incompleteSnapshot = {
      ...snapshot,
      screens: [],
    };
    const { rerender } = render(<TvPresentation snapshot={incompleteSnapshot} />);
    rerender(<TvPresentation snapshot={{ ...incompleteSnapshot, generatedAt: "2026-07-23T14:32:15.000Z" }} />);
    expect(screen.getByRole("heading", { name: "Waiting for Activity" })).toBeDefined();
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError).toHaveBeenCalledWith(
      "tv-presentation-missing-screen",
      expect.any(Error),
    );
    captureError.mockRestore();
  });

  it("renders the terminal empty state when a configured screen is missing", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    render(<TvPresentation snapshot={{
      ...snapshot,
      screens: snapshot.screens.filter((screen) => screen.id !== snapshot.profile.playlist[0]),
    }} />);
    expect(screen.getByRole("heading", { name: "Waiting for Activity" })).toBeDefined();
  });

  it("renders the terminal empty state when a playlist entry cannot be resolved", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    render(<TvPresentation snapshot={{
      ...snapshot,
      profile: {
        ...snapshot.profile,
        playlist: ["live-pulse", "audience-momentum", "revenue-payments", "email-health"],
      },
      screens: snapshot.screens.filter((screen) => screen.id !== "live-pulse"),
    }} />);
    expect(screen.getByRole("heading", { name: "Waiting for Activity" })).toBeDefined();
  });

  it("renders an authorization state when the snapshot credential is rejected", () => {
    render(<TvPresentation snapshot={null} unavailableReason="unauthorized" />);
    expect(screen.getByRole("heading", { name: "TV Mode Authorization Required" })).toBeDefined();
  });

  it("can render without dashboard exit navigation for an independent display", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    render(<TvPresentation snapshot={snapshot} />);
    expect(screen.queryByRole("button", { name: "Exit TV Mode" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause rotation" })).toBeDefined();
  });

  it("omits fullscreen controls when the browser does not support the Fullscreen API", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    render(<TvPresentation snapshot={snapshot} />);
    expect(screen.queryByRole("button", { name: "Enter fullscreen" })).toBeNull();
  });

  it("requests fullscreen when the browser supports the Fullscreen API", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });

    render(<TvPresentation snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("does not toggle rotation when Space activates a focused control", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    render(<TvPresentation snapshot={snapshot} />);
    const pauseButton = screen.getByRole("button", { name: "Pause rotation" });
    fireEvent.mouseMove(window);
    fireEvent.keyDown(pauseButton, { key: " " });
    expect(screen.getByRole("button", { name: "Pause rotation" })).toBeDefined();
  });

  it("re-arms control auto-hide when controls are shown again", async () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");
    render(<TvPresentation snapshot={snapshot} />);
    const pauseButton = screen.getByRole("button", { name: "Pause rotation" });
    expect(pauseButton.getAttribute("tabindex")).toBe("-1");
    fireEvent.mouseMove(window);
    await act(() => vi.advanceTimersByTime(2_000));
    fireEvent.mouseMove(window);
    await act(() => vi.advanceTimersByTime(1_000));
    expect(pauseButton.getAttribute("tabindex")).toBe("0");
    await act(() => vi.advanceTimersByTime(1_800));
    expect(pauseButton.getAttribute("tabindex")).toBe("-1");
  });

  it("does not restart rotation or reset the current screen when polling replaces the snapshot", async () => {
    const fixtureSnapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (fixtureSnapshot == null) throw new Error("Missing company-pulse fixture");
    // Keep this polling-regression test on a uniform clock. Per-screen timing
    // is covered separately and should not change its 15s + 5s assertions.
    const snapshot = {
      ...fixtureSnapshot,
      profile: {
        ...fixtureSnapshot.profile,
        screenDurations: fixtureSnapshot.profile.playlist.map((screenId) => ({
          screenId,
          durationSeconds: 20,
        })),
      },
    };
    const { rerender } = render(
      <TvPresentation snapshot={snapshot} onExit={() => undefined} />,
    );

    expect(screen.getByRole("heading", { name: "Live Pulse" })).toBeDefined();
    await act(() => vi.advanceTimersByTime(15_000));

    const refreshedSnapshot = {
      ...snapshot,
      generatedAt: "2026-07-23T14:32:15.000Z",
      staleAfter: "2026-07-23T14:33:00.000Z",
    };
    rerender(<TvPresentation snapshot={refreshedSnapshot} onExit={() => undefined} />);

    await act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByLabelText("Screen 2 of 4")).toBeDefined();

    await act(() => vi.advanceTimersByTime(15_000));
    rerender(
      <TvPresentation
        snapshot={{
          ...refreshedSnapshot,
          generatedAt: "2026-07-23T14:32:30.000Z",
          staleAfter: "2026-07-23T14:33:15.000Z",
        }}
        onExit={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Screen 2 of 4")).toBeDefined();
    await act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByLabelText("Screen 3 of 4")).toBeDefined();
  });

  it("does not reset rotation as Audience Analytics recovers on a later poll", () => {
    const fullSnapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    const fullAudience = fullSnapshot?.screens.find((candidate) => candidate.id === "audience-momentum");
    if (fullSnapshot == null || fullAudience?.id !== "audience-momentum" || fullAudience.data == null) {
      throw new Error("Missing Audience polling fixture");
    }
    const failedAnalytics = {
      sourceStatus: "error",
      observedAt: "2026-07-23T14:32:15.000Z",
      diagnosticCode: "source-query-failed",
      data: null,
    } satisfies NonNullable<TvAudienceMomentumScreen["data"]>["analytics"];
    const partialSnapshot = {
      ...fullSnapshot,
      generatedAt: "2026-07-23T14:32:15.000Z",
      screens: fullSnapshot.screens.map((candidate) => candidate.id === "audience-momentum" ? {
        ...candidate,
        data: candidate.data == null ? null : {
          ...candidate.data,
          analytics: failedAnalytics,
        },
      } : candidate),
    };
    const { rerender } = render(<TvPresentation snapshot={fullSnapshot} onExit={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Next screen" }));
    expect(screen.getByLabelText("Screen 2 of 4")).toBeDefined();

    rerender(<TvPresentation snapshot={partialSnapshot} onExit={() => undefined} />);
    expect(screen.getByLabelText("Screen 2 of 4")).toBeDefined();

    rerender(<TvPresentation snapshot={{
      ...fullSnapshot,
      generatedAt: "2026-07-23T14:32:30.000Z",
    }} onExit={() => undefined} />);
    expect(screen.getByLabelText("Screen 2 of 4")).toBeDefined();
  });
});

describe("TV chart headers", () => {
  it.each([
    ["live-pulse", "Today’s Activity", "Current UTC day"],
    ["audience-momentum", "Audience Lifecycle", "Daily activity · trailing 7 days"],
    ["revenue-payments", "Gross Collected Revenue Momentum", "Cumulative daily trend · trailing 30 days"],
    ["email-health", "Email Delivery Volume", "Daily send status · trailing 7 days"],
  ] as const)("labels the %s chart and its reporting window", (screenId, title, subtitle) => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");

    const selectedScreen = snapshot.screens.find((candidate) => candidate.id === screenId);
    if (selectedScreen == null) throw new Error(`Missing ${screenId} fixture screen`);
    render(renderTvScreen(selectedScreen));

    expect(screen.getByText(title)).toBeDefined();
    expect(screen.getAllByText(subtitle).length).toBeGreaterThan(0);
  });
});

describe("TV metric semantics", () => {
  it("renders zero-activity stacked trend days without invalid heights", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    const audience = snapshot?.screens.find((candidate) => candidate.id === "audience-momentum");
    if (audience?.id !== "audience-momentum" || audience.data == null) {
      throw new Error("Missing Audience fixture data");
    }
    const { container } = render(renderTvScreen({
      ...audience,
      data: {
        ...audience.data,
        lifecycle: audience.data.lifecycle.map((point) => ({
          ...point,
          primary: 0,
          secondary: 0,
          tertiary: 0,
        })),
      },
    }));
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("uses precise Audience, gross-revenue, and delivered-series wording", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");

    const audience = snapshot.screens.find((candidate) => candidate.id === "audience-momentum");
    const revenue = snapshot.screens.find((candidate) => candidate.id === "revenue-payments");
    const email = snapshot.screens.find((candidate) => candidate.id === "email-health");
    if (audience == null || revenue == null || email == null) throw new Error("Missing TV metric fixture screens");

    const audienceRender = render(renderTvScreen(audience));
    screen.getByText("12.8% growth over the last 7 days");
    screen.getByText("Total Users · 7d");
    screen.getByText("Monthly Active");
    screen.getByText("Signed-In Visitors");
    screen.getByText("Session Avg · 7d");
    screen.getByText("91.6% users verified");
    screen.getByText("214 Sessions");
    audienceRender.unmount();

    const revenueRender = render(renderTvScreen(revenue));
    screen.getByText("Gross Collected Revenue · 30d");
    screen.getByText("Payment Success");
    screen.getByText("Past Due");
    revenueRender.unmount();

    render(renderTvScreen(email));
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    screen.getByText("12,640 confirmed outcomes");
    expect(screen.queryByText("Completed Successfully")).toBeNull();
  });

  it("renders unchanged revenue with a neutral direction marker", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    const revenue = snapshot?.screens.find((candidate) => candidate.id === "revenue-payments");
    if (revenue?.id !== "revenue-payments" || revenue.data == null) {
      throw new Error("Missing Revenue & Payments fixture data");
    }

    render(renderTvScreen({
      ...revenue,
      data: { ...revenue.data, revenueChangePercent: 0 },
    }));

    screen.getByText("0% vs previous 30 days · exact values off");
    expect(screen.queryByText("— 0% vs previous 30 days · exact values off")).toBeNull();
    expect(screen.queryByText("↓ 0% vs previous 30 days · exact values off")).toBeNull();
  });

  it("keeps core Audience metrics visible when Analytics enrichment is unavailable", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    const audience = snapshot?.screens.find((candidate) => candidate.id === "audience-momentum");
    if (snapshot == null || audience?.id !== "audience-momentum" || audience.data == null) throw new Error("Missing Audience fixture screen");

    render(renderTvScreen({
      ...audience,
      data: {
        ...audience.data,
        analytics: {
          sourceStatus: "unavailable",
          observedAt: snapshot.generatedAt,
          diagnosticCode: "analytics-app-disabled",
          data: null,
        },
      },
    }));

    screen.getByText("512");
    screen.getByText("361");
    screen.getByText("91.6% users verified");
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByText("Not Enabled")).toHaveLength(2);
    screen.getByText("Audience Lifecycle");
  });

  it("distinguishes no qualifying sessions from a measured zero-second session", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    const audience = snapshot?.screens.find((candidate) => candidate.id === "audience-momentum");
    if (snapshot == null || audience?.id !== "audience-momentum" || audience.data == null) throw new Error("Missing Audience fixture screen");

    const emptyRender = render(renderTvScreen({
      ...audience,
      data: {
        ...audience.data,
        analytics: {
          sourceStatus: "empty",
          observedAt: snapshot.generatedAt,
          diagnosticCode: null,
          data: { visitors: 0, qualifyingSessions: 0, averageSessionSeconds: null },
        },
      },
    }));
    expect(screen.getAllByText("No Sessions")).toHaveLength(2);
    emptyRender.unmount();

    render(renderTvScreen({
      ...audience,
      data: {
        ...audience.data,
        analytics: {
          sourceStatus: "ready",
          observedAt: snapshot.generatedAt,
          diagnosticCode: null,
          data: { visitors: 1, qualifyingSessions: 1, averageSessionSeconds: 0 },
        },
      },
    }));
    screen.getByText("0s");
    screen.getByText("1 Session");
  });
});

describe("TV synthetic preview safety", () => {
  it("labels fixture previews without marking normal playback", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    if (snapshot == null) throw new Error("Missing company-pulse fixture");

    const preview = render(<TvPresentation snapshot={snapshot} onExit={() => undefined} previewData />);
    screen.getByText("Preview · Synthetic Data");
    preview.unmount();

    render(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);
    expect(screen.queryByText("Preview · Synthetic Data")).toBeNull();
  });
});

describe("TV interruption presentation", () => {
  it("renders Event Highlights through the shared screen header accessory", () => {
    const snapshot = getTvFixtureSnapshot(
      "project-a",
      "company-pulse",
      "celebration-animation-expired",
    );
    if (snapshot == null) throw new Error("Missing celebration Highlight fixture");

    render(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);

    expect(screen.getByText("Event Highlight")).toBeDefined();
    expect(screen.getByRole("heading", { name: "500 Users" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Live Pulse" })).toBeDefined();
  });

  it("renders the bounded Critical Incident instead of the playlist", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "critical-takeover");
    if (snapshot == null) throw new Error("Missing Critical Incident fixture");

    render(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);

    expect(screen.getByText("Critical Incident")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Email Delivery Degraded" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Live Pulse" })).toBeNull();
  });

  it("renders the payment degradation Incident preview with production-facing copy", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "payment-incident-takeover");
    if (snapshot == null) throw new Error("Missing payment Incident fixture");

    render(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);

    expect(screen.getByText("Incident")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Subscription Payments Degraded" })).toBeDefined();
    expect(screen.getByText("Payment Success")).toBeDefined();
    expect(screen.getByText("82%")).toBeDefined();
  });

  it("treats escalation and recovery as new phases of the same occurrence", async () => {
    const incident = getTvFixtureSnapshot("project-a", "company-pulse", "incident-takeover");
    const critical = getTvFixtureSnapshot("project-a", "company-pulse", "critical-takeover");
    const recovery = getTvFixtureSnapshot("project-a", "company-pulse", "critical-recovery");
    if (incident == null || critical == null || recovery == null) throw new Error("Missing bounded lifecycle fixtures");
    const eventId = incident.presentation.takeover?.event.id;
    if (eventId == null || critical.presentation.takeover == null || recovery.presentation.takeover == null) {
      throw new Error("Missing bounded lifecycle takeover");
    }

    const { rerender } = render(<TvPresentation snapshot={incident} onExit={() => undefined} />);
    await act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByLabelText("Screen 1 of 4")).toBeDefined();

    rerender(<TvPresentation snapshot={{
      ...critical,
      presentation: {
        ...critical.presentation,
        takeover: {
          ...critical.presentation.takeover,
          event: { ...critical.presentation.takeover.event, id: eventId },
        },
      },
    }} onExit={() => undefined} />);
    expect(screen.getByText("Critical Incident")).toBeDefined();

    rerender(<TvPresentation snapshot={{
      ...recovery,
      presentation: {
        ...recovery.presentation,
        takeover: {
          ...recovery.presentation.takeover,
          event: { ...recovery.presentation.takeover.event, id: eventId },
        },
      },
    }} onExit={() => undefined} />);
    await act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("Recovery Confirmed")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Email Delivery Restored" })).toBeDefined();
  });

  it("does not let rotation pause extend an absolute takeover deadline", async () => {
    const rotation = getTvFixtureSnapshot("project-a", "company-pulse");
    const incident = getTvFixtureSnapshot("project-a", "company-pulse", "incident-takeover");
    if (rotation == null || incident == null) throw new Error("Missing rotation-pause fixtures");

    const { rerender } = render(<TvPresentation snapshot={rotation} onExit={() => undefined} />);
    fireEvent.keyDown(window, { key: " " });
    rerender(<TvPresentation snapshot={incident} onExit={() => undefined} />);
    await act(() => vi.advanceTimersByTime(60_000));
    await act(() => vi.advanceTimersByTime(1_000));

    expect(screen.getByRole("heading", { name: "Live Pulse" })).toBeDefined();
  });

  it("labels an active Critical Incident Highlight after its takeover expires", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "critical-highlight");
    if (snapshot == null) throw new Error("Missing Critical Incident Highlight fixture");

    render(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);

    expect(screen.getByText("Active Critical Incident")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Email Delivery Degraded" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Live Pulse" })).toBeDefined();
  });

  it("subtracts snapshot transport delay from absolute takeover deadlines", async () => {
    vi.setSystemTime(new Date("2026-07-23T14:32:30.000Z"));
    const incident = getTvFixtureSnapshot("project-a", "company-pulse", "incident-takeover");
    if (incident == null) throw new Error("Missing incident takeover fixture");

    render(<TvPresentation snapshot={incident} onExit={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Email Delivery Degraded" })).toBeDefined();
    await act(() => vi.advanceTimersByTime(29_999));
    expect(screen.getByRole("heading", { name: "Email Delivery Degraded" })).toBeDefined();
    await act(() => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText("Screen 1 of 4")).toBeDefined();
  });

  it("renders recovery-specific takeover and Highlight presentations", () => {
    const recoveryScreen = getTvFixtureSnapshot("project-a", "company-pulse", "incident-recovery");
    const recoveryHighlight = getTvFixtureSnapshot("project-a", "company-pulse", "incident-recovery-highlight");
    if (recoveryScreen == null || recoveryHighlight == null) throw new Error("Missing incident recovery fixtures");

    const recoveryScreenRender = render(<TvPresentation snapshot={recoveryScreen} onExit={() => undefined} />);
    expect(screen.getByText("Recovery Confirmed")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Email Delivery Restored" })).toBeDefined();
    recoveryScreenRender.unmount();

    render(<TvPresentation snapshot={recoveryHighlight} onExit={() => undefined} />);
    expect(screen.getByText("Restored")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Email Delivery Restored" })).toBeDefined();
    expect(screen.getByText("Expected 95% or higher", { exact: false })).toBeDefined();
  });

  it("arms one visible takeover entrance layer only after loading is uncovered", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-takeover");
    if (snapshot == null) throw new Error("Missing celebration takeover fixture");

    const { container, rerender } = render(
      <TvPresentation snapshot={null} loading onExit={() => undefined} />,
    );
    expect(container.querySelectorAll("[data-entry-burst='active']")).toHaveLength(0);

    rerender(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);
    expect(screen.getByRole("heading", { name: "500 Users" })).toBeDefined();
    expect(container.querySelectorAll("[data-entry-burst='active']")).toHaveLength(1);
    expect(container.querySelector("[data-takeover-effects='active']")).not.toBeNull();
  });

  it("does not replay a celebration entrance after its animation deadline", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-takeover");
    if (snapshot == null || snapshot.presentation.highlight == null) throw new Error("Missing celebration takeover fixture");
    const expiredAnimationSnapshot = {
      ...snapshot,
      presentation: {
        ...snapshot.presentation,
        highlight: {
          ...snapshot.presentation.highlight,
          animationExpiresAt: snapshot.generatedAt,
        },
      },
    };

    const { container } = render(<TvPresentation snapshot={expiredAnimationSnapshot} onExit={() => undefined} previewData />);
    expect(container.querySelectorAll("[data-entry-burst='active']")).toHaveLength(0);
  });

  it("preserves celebration canvases across polling and screen rotation", async () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-highlight");
    if (snapshot == null) throw new Error("Missing celebration Highlight fixture");

    const { container, rerender } = render(<TvPresentation snapshot={snapshot} onExit={() => undefined} />);
    const backgroundCanvas = container.querySelector("[data-celebration-layer='background']");
    const foregroundCanvas = container.querySelector("[data-celebration-layer='foreground']");
    if (backgroundCanvas == null || foregroundCanvas == null) throw new Error("Missing celebration canvases");

    rerender(<TvPresentation snapshot={{
      ...snapshot,
      generatedAt: "2026-07-23T14:32:15.000Z",
      staleAfter: "2026-07-23T14:33:00.000Z",
    }} onExit={() => undefined} />);
    await act(() => vi.advanceTimersByTime(15_000));

    expect(container.querySelector("[data-celebration-layer='background']")).toBe(backgroundCanvas);
    expect(container.querySelector("[data-celebration-layer='foreground']")).toBe(foregroundCanvas);
  });

  it("suspends ambient effects for an incident and restores an eligible celebration", () => {
    const celebration = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-highlight");
    const suspended = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-suspended");
    const resumed = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-resumed");
    const expired = getTvFixtureSnapshot("project-a", "company-pulse", "celebration-animation-expired");
    if (celebration == null || suspended == null || resumed == null || expired == null) {
      throw new Error("Missing celebration lifecycle fixtures");
    }

    const { container, rerender } = render(<TvPresentation snapshot={celebration} onExit={() => undefined} />);
    expect(container.querySelectorAll("[data-ambient-effects='active']")).toHaveLength(2);

    rerender(<TvPresentation snapshot={suspended} onExit={() => undefined} />);
    expect(container.querySelectorAll("[data-ambient-effects='active']")).toHaveLength(0);

    rerender(<TvPresentation snapshot={resumed} onExit={() => undefined} />);
    expect(container.querySelectorAll("[data-ambient-effects='active']")).toHaveLength(2);

    rerender(<TvPresentation snapshot={expired} onExit={() => undefined} />);
    expect(container.querySelectorAll("[data-ambient-effects='active']")).toHaveLength(0);
  });
});

describe("TV insight area", () => {
  it.each([
    ["live-pulse", "Comparable live-activity analysis will appear when a validated recent baseline is available."],
    ["audience-momentum", "No evidence-qualified audience lifecycle insight was identified for this seven-day window."],
    ["revenue-payments", "No evidence-qualified revenue or payment insight was identified for this 30-day window."],
    ["email-health", "No evidence-qualified email delivery insight was identified for this seven-day window."],
  ] as const)("provides a neutral ready-state explanation for %s", (screenId, message) => {
    expect(getTvInsightPresentation({
      screenId,
      sourceStatus: "ready",
      insight: null,
    })).toEqual({ message, explanatory: true });
  });

  it.each([
    ["revenue-payments", "At least 10 completed payment outcomes are required before Payment Success can be assessed."],
    ["email-health", "At least 20 confirmed delivery outcomes are required before delivery health can be assessed."],
  ] as const)("explains the evidence threshold for %s", (screenId, message) => {
    expect(getTvInsightPresentation({
      screenId,
      sourceStatus: "insufficient-data",
      insight: null,
    })).toEqual({ message, explanatory: true });
  });

  it("preserves a validated structured insight for stale content", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse");
    const insight = snapshot?.screens.find((candidate) => candidate.id === "email-health")?.insight;
    if (insight == null) throw new Error("Missing Email Health fixture insight");

    expect(getTvInsightPresentation({
      screenId: "email-health",
      sourceStatus: "stale",
      insight,
    })).toEqual({ message: insight.message, explanatory: false });
  });

  it("describes stale data instead of using ready-state copy when no insight is available", () => {
    expect(getTvInsightPresentation({
      screenId: "email-health",
      sourceStatus: "stale",
      insight: null,
    })).toEqual({
      message: "Insight analysis will resume when a fresh snapshot is available.",
      explanatory: true,
    });
  });

  it("renders the threshold explanation in the shared insight card", () => {
    const snapshot = getTvFixtureSnapshot("project-a", "company-pulse", "insufficient-data");
    const revenue = snapshot?.screens.find((candidate) => candidate.id === "revenue-payments");
    if (revenue == null) throw new Error("Missing insufficient-data Revenue fixture");

    render(renderTvScreen(revenue));

    screen.getByText("At least 10 completed payment outcomes are required before Payment Success can be assessed.");
  });
});
