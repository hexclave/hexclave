import { describe, expect, it } from "vitest";
import { TV_FIXTURE_VARIANTS, TV_SCREEN_IDS, TvSnapshotSchema, type TvFixtureVariant } from "./types";
import {
  calculateFixtureEmailRates,
  calculateFixturePaymentSuccess,
  createTvFixtureSnapshot,
  getTvProfileFixture,
  TV_PROFILE_FIXTURES,
} from "./fixtures";

function getProfile(id = "company-pulse") {
  const profile = getTvProfileFixture(id);
  if (profile == null) throw new Error("Fixture profile is missing");
  return profile;
}

describe("TV Mode centralized fixtures", () => {
  it("validates every deterministic fixture through the shared runtime schema", async () => {
    for (const profile of TV_PROFILE_FIXTURES) {
      for (const variant of TV_FIXTURE_VARIANTS) {
        await expect(TvSnapshotSchema.validate(
          createTvFixtureSnapshot("project-fixture", profile, variant),
          { strict: true },
        )).resolves.toBeDefined();
      }
    }
  });

  it("registers the approved four-screen profile playlist", () => {
    expect(TV_PROFILE_FIXTURES.map((profile) => ({
      id: profile.id,
      mode: profile.mode,
      screens: profile.playlist.map((entry) => entry.screenId),
    }))).toMatchInlineSnapshot(`
      [
        {
          "id": "engineering-office",
          "mode": "general",
          "screens": [
            "live-pulse",
            "audience-momentum",
            "revenue-payments",
            "email-health",
          ],
        },
        {
          "id": "company-pulse",
          "mode": "general",
          "screens": [
            "live-pulse",
            "audience-momentum",
            "revenue-payments",
            "email-health",
          ],
        },
      ]
    `);
    expect(new Set(TV_PROFILE_FIXTURES.flatMap((profile) => profile.playlist.map((entry) => entry.screenId))))
      .toEqual(new Set(TV_SCREEN_IDS));
  });

  it("keeps reporting windows and deterministic evidence in the snapshot", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile());
    expect(snapshot.screens.find((screen) => screen.id === "live-pulse")?.window.current).toMatchObject({
      startsAt: "2026-07-23T00:00:00.000Z",
      endsAt: "2026-07-23T14:32:00.000Z",
      label: "Today · UTC",
    });
    expect(snapshot.screens.map((screen) => ({
      id: screen.id,
      window: screen.window.current.label,
      comparison: screen.window.comparison?.label ?? null,
      insight: screen.insight?.kind ?? null,
    }))).toMatchInlineSnapshot(`
      [
        {
          "comparison": null,
          "id": "live-pulse",
          "insight": "live-activity-above-baseline",
          "window": "Today · UTC",
        },
        {
          "comparison": "Previous 7 days",
          "id": "audience-momentum",
          "insight": "returning-users-leading",
          "window": "Trailing 7 days",
        },
        {
          "comparison": "Previous 30 days",
          "id": "revenue-payments",
          "insight": "revenue-up-payments-stable",
          "window": "Trailing 30 days",
        },
        {
          "comparison": "Previous 7 days",
          "id": "email-health",
          "insight": "delivery-healthy-volume-up",
          "window": "Trailing 7 days",
        },
      ]
    `);
  });

  it("keeps synthetic Audience enrichment aligned with the live snapshot contract", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile());
    const audience = snapshot.screens.find((screen) => screen.id === "audience-momentum");
    const livePulse = snapshot.screens.find((screen) => screen.id === "live-pulse");
    if (audience?.id !== "audience-momentum" || audience.data == null) throw new Error("Audience fixture data is missing");
    if (livePulse?.id !== "live-pulse" || livePulse.data == null) throw new Error("Live Pulse fixture data is missing");

    expect(audience.data.analytics).toMatchObject({
      sourceStatus: "ready",
      diagnosticCode: null,
      data: {
        visitors: 923,
        qualifyingSessions: 214,
        averageSessionSeconds: 252,
      },
    });
    expect(livePulse.data.sourceHealth.at(2)).toEqual({
      label: "Audience",
      status: "ready",
      value: "Fresh",
      detail: "All metrics available",
    });
  });

  it("models non-data states without metric payloads and stale with last-safe data", () => {
    for (const variant of ["empty", "unavailable"] satisfies TvFixtureVariant[]) {
      const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), variant);
      expect(snapshot.screens.every((screen) => screen.data == null && screen.insight == null)).toBe(true);
    }
    const stale = createTvFixtureSnapshot("project-fixture", getProfile(), "stale");
    expect(stale.screens.every((screen) =>
      screen.sourceStatus === "stale" && screen.data != null && screen.insight == null,
    )).toBe(true);
  });

  it("isolates a partial email failure", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "partial-failure");
    expect(snapshot.screens.map((screen) => `${screen.id}:${screen.sourceStatus}`)).toMatchInlineSnapshot(`
      [
        "live-pulse:ready",
        "audience-momentum:ready",
        "revenue-payments:ready",
        "email-health:error",
      ]
    `);
  });

  it("suppresses health rates and insights below minimum samples", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "insufficient-data");
    const revenue = snapshot.screens.find((screen) => screen.id === "revenue-payments");
    const email = snapshot.screens.find((screen) => screen.id === "email-health");
    expect({
      revenueStatus: revenue?.sourceStatus,
      attempts: revenue?.data?.paymentSuccess.applicableAttempts,
      paymentSuccess: revenue?.data?.paymentSuccess.percent,
      revenueInsight: revenue?.insight,
      emailStatus: email?.sourceStatus,
      sends: email?.data?.sent,
      inProgress: email?.data?.inProgress,
      trendTotal: email?.data?.statusTrend.reduce((total, point) => (
        total + point.primary + point.secondary + point.tertiary
      ), 0),
      delivery: email?.data?.deliveryRatePercent,
      emailInsight: email?.insight,
    }).toMatchInlineSnapshot(`
      {
        "attempts": 9,
        "delivery": null,
        "emailInsight": null,
        "emailStatus": "insufficient-data",
        "inProgress": 0,
        "paymentSuccess": null,
        "revenueInsight": null,
        "revenueStatus": "insufficient-data",
        "sends": 19,
        "trendTotal": 19,
      }
    `);
  });

  it("applies payment and email thresholds at their exact boundaries", () => {
    expect([
      calculateFixturePaymentSuccess(9, 9),
      calculateFixturePaymentSuccess(10, 9),
      calculateFixturePaymentSuccess(11, 10),
    ]).toEqual([null, 90, 90.9]);
    expect([
      calculateFixtureEmailRates(19, 19, 0),
      calculateFixtureEmailRates(20, 19, 1),
      calculateFixtureEmailRates(21, 20, 1),
    ]).toEqual([
      { deliveryRatePercent: null, bounceRatePercent: null },
      { deliveryRatePercent: 95, bounceRatePercent: 5 },
      { deliveryRatePercent: 95.2, bounceRatePercent: 4.8 },
    ]);
  });

  it("redacts currency fields and currency-bearing evidence", () => {
    const redacted = createTvFixtureSnapshot("project-fixture", getProfile(), "financial-redacted");
    const revenue = redacted.screens.find((screen) => screen.id === "revenue-payments");
    expect(revenue?.data?.financials.visibility).toBe("redacted");
    expect(JSON.stringify(revenue)).not.toContain("4823156");
    expect(JSON.stringify(revenue)).not.toContain("112000");

    for (const profileId of ["engineering-office", "company-pulse"]) {
      const profileRedacted = createTvFixtureSnapshot("project-fixture", getProfile(profileId));
      const profileRevenue = profileRedacted.screens.find((screen) => screen.id === "revenue-payments");
      expect(profileRevenue?.data?.financials.visibility).toBe("redacted");
    }
  });

  it("builds each interruption treatment centrally", () => {
    const variants: TvFixtureVariant[] = [
      "celebration-highlight",
      "celebration-takeover",
      "incident-highlight",
      "critical-highlight",
      "payment-incident-takeover",
      "incident-takeover",
      "critical-takeover",
      "incident-recovery-highlight",
      "critical-recovery",
    ];
    expect(variants.map((variant) => {
      const presentation = createTvFixtureSnapshot("project-fixture", getProfile(), variant).presentation;
      return presentation.takeover?.variant ?? presentation.highlight?.variant;
    })).toEqual([
      "celebration",
      "celebration",
      "active-incident",
      "active-incident",
      "incident",
      "incident",
      "critical-incident",
      "resolved-incident",
      "recovery-confirmation",
    ]);
  });

  it("keeps the active Incident Highlight assigned throughout bounded takeover previews", () => {
    const incident = createTvFixtureSnapshot("project-fixture", getProfile(), "incident-takeover");
    const paymentIncident = createTvFixtureSnapshot("project-fixture", getProfile(), "payment-incident-takeover");
    const critical = createTvFixtureSnapshot("project-fixture", getProfile(), "critical-takeover");

    expect(incident.presentation).toMatchObject({
      takeover: { variant: "incident" },
      highlight: {
        variant: "active-incident",
        event: { id: incident.presentation.takeover?.event.id },
      },
    });
    expect(critical.presentation).toMatchObject({
      takeover: { variant: "critical-incident" },
      highlight: {
        variant: "active-incident",
        event: { id: critical.presentation.takeover?.event.id },
      },
    });
    expect(paymentIncident.presentation).toMatchObject({
      takeover: { variant: "incident" },
      highlight: {
        variant: "active-incident",
        event: { id: paymentIncident.presentation.takeover?.event.id },
      },
    });
  });

  it("uses recovery-specific copy for resolved incident fixtures", () => {
    const recoveryScreen = createTvFixtureSnapshot("project-fixture", getProfile(), "incident-recovery");
    const recoveryHighlight = createTvFixtureSnapshot("project-fixture", getProfile(), "incident-recovery-highlight");

    expect(recoveryScreen.presentation.takeover?.event).toMatchObject({
      title: "Email Delivery Restored",
      status: "resolved",
      metricValue: "98.2%",
      expectedRange: "Expected 95% or higher",
    });
    expect(recoveryHighlight.presentation.highlight).toMatchObject({
      variant: "resolved-incident",
      event: {
        title: "Email Delivery Restored",
        status: "resolved",
      },
    });
  });

  it("models celebration suspension, resumption, replacement, and expiry without resetting deadlines", () => {
    const suspended = createTvFixtureSnapshot("project-fixture", getProfile(), "celebration-suspended");
    expect(suspended.presentation).toMatchObject({
      takeover: { variant: "incident" },
      highlight: {
        variant: "celebration",
        animationExpiresAt: "2026-07-23T15:30:00.000Z",
      },
    });
    expect(createTvFixtureSnapshot(
      "project-fixture",
      getProfile(),
      "celebration-resumed",
    ).presentation).toMatchObject({
      takeover: null,
      highlight: { variant: "celebration" },
    });
    expect(createTvFixtureSnapshot(
      "project-fixture",
      getProfile(),
      "celebration-animation-expired",
    ).presentation.highlight).toMatchObject({
      variant: "celebration",
      animationExpiresAt: "2026-07-23T14:31:00.000Z",
    });
    expect(createTvFixtureSnapshot(
      "project-fixture",
      getProfile(),
      "celebration-highlight-expired",
    ).presentation).toEqual({
      takeover: null,
      highlight: null,
    });
    expect(createTvFixtureSnapshot(
      "project-fixture",
      getProfile(),
      "celebration-replaced",
    ).presentation.highlight).toMatchObject({
      event: { id: "fixture-user-milestone-1000", occurredAt: "2026-07-23T14:31:00.000Z" },
      animationExpiresAt: "2026-07-23T15:31:00.000Z",
      expiresAt: "2026-07-23T20:31:00.000Z",
    });
  });

  it("keeps celebration deadlines anchored to the occurrence", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "celebration-takeover");
    expect(snapshot.presentation).toMatchObject({
      takeover: {
        startedAt: "2026-07-23T14:32:00.000Z",
      },
      highlight: {
        event: { occurredAt: "2026-07-23T14:30:00.000Z" },
        expiresAt: "2026-07-23T20:30:00.000Z",
        animationExpiresAt: "2026-07-23T15:30:00.000Z",
      },
    });
  });

  it("derives preview phase deadlines from the selected profile timing", () => {
    const profile = structuredClone(getProfile());
    profile.interruptionTiming = {
      celebration: { takeoverSeconds: 90, animationSeconds: 1800, highlightSeconds: 43200 },
      incident: { takeoverSeconds: 120, recoveryTakeoverSeconds: 90, resolvedHighlightSeconds: 21600 },
      criticalIncident: { takeoverSeconds: 90, recoveryTakeoverSeconds: 120, resolvedHighlightSeconds: 86400 },
    };

    expect(createTvFixtureSnapshot("project-fixture", profile, "celebration-takeover").presentation).toMatchObject({
      takeover: { endsAt: "2026-07-23T14:33:30.000Z" },
      highlight: {
        expiresAt: "2026-07-24T02:30:00.000Z",
        animationExpiresAt: "2026-07-23T15:00:00.000Z",
      },
    });
    expect(createTvFixtureSnapshot("project-fixture", profile, "critical-takeover").presentation.takeover?.endsAt).toBe("2026-07-23T14:33:30.000Z");
    expect(createTvFixtureSnapshot("project-fixture", profile, "critical-recovery").presentation.takeover?.endsAt).toBe("2026-07-23T14:34:00.000Z");
    expect(createTvFixtureSnapshot("project-fixture", profile, "incident-recovery-highlight").presentation.highlight?.expiresAt).toBe("2026-07-23T20:32:00.000Z");
  });

  it("keeps long-name stress data centralized", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "long-names");
    expect(snapshot.project.displayName.length).toBeGreaterThan(50);
    expect(snapshot.profile.displayName.length).toBeGreaterThan(50);
  });
});
