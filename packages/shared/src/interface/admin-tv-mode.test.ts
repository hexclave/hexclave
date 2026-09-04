import { describe, expect, it } from "vitest";
import {
  calculateTvEmailRates,
  calculateTvPaymentSuccessPercent,
  getTvBuiltInProfile,
  TV_SCREEN_IDS,
  TvAudienceMomentumScreenSchema,
  TvDisplayPairingChallengeSchema,
  TvDisplayResourceSchema,
  TvEmailHealthScreenSchema,
  TvProfileConfigurationSchema,
  TvSnapshotSchema,
} from "./admin-tv-mode";

function validSnapshot(sourceHealthStatus: "healthy" | "ready" | "limited" | "empty" | "insufficient-data" | "unavailable" | "error" | "stale" = "ready") {
  const observedAt = "2026-07-25T12:00:00.000Z";
  const window = {
    current: { startsAt: observedAt, endsAt: observedAt, label: "Current" },
    comparison: null,
  };
  return {
    generatedAt: observedAt,
    staleAfter: "2026-07-25T12:00:45.000Z",
    connectionStatus: "online",
    project: { id: "project", displayName: "Project" },
    profile: {
      id: "company-pulse",
      displayName: "Company Pulse",
      mode: "general",
      defaultDurationSeconds: 20,
      playlist: [...TV_SCREEN_IDS],
    },
    screens: [
      {
        id: "live-pulse",
        sourceStatus: "ready",
        sourceLabel: "Activity",
        observedAt,
        window,
        diagnosticCode: null,
        data: {
          liveUsers: 1,
          todayActiveUsers: 2,
          hourlyActivity: [],
          sourceHealth: [{ label: "Email", status: sourceHealthStatus, value: "Status", detail: "Detail" }],
        },
        insight: null,
      },
      {
        id: "audience-momentum",
        sourceStatus: "ready",
        sourceLabel: "Audience",
        observedAt,
        window,
        diagnosticCode: null,
        data: {
          totalUsers: 2,
          userGrowthPercent: 0,
          newUsers: 1,
          monthlyActiveUsers: 2,
          verificationRatePercent: 50,
          lifecycle: [],
          analytics: {
            sourceStatus: "ready",
            observedAt,
            diagnosticCode: null,
            data: { visitors: 2, qualifyingSessions: 1, averageSessionSeconds: 10 },
          },
        },
        insight: null,
      },
      {
        id: "revenue-payments",
        sourceStatus: "insufficient-data",
        sourceLabel: "Payments",
        observedAt,
        window,
        diagnosticCode: null,
        data: {
          financials: { visibility: "redacted", direction: "flat", normalizedRevenueTrend: [] },
          revenueChangePercent: 0,
          activeSubscriptions: 0,
          newSubscriptions: 0,
          pastDueSubscriptions: 0,
          paymentSuccess: { applicableAttempts: 0, percent: null },
        },
        insight: null,
      },
      {
        id: "email-health",
        sourceStatus: "insufficient-data",
        sourceLabel: "Email",
        observedAt,
        window,
        diagnosticCode: null,
        data: {
          sent: 0,
          assessableSends: 0,
          delivered: 0,
          bounced: 0,
          errors: 0,
          inProgress: 0,
          deliveryRatePercent: null,
          bounceRatePercent: null,
          volumeChangePercent: 0,
          statusTrend: [],
        },
        insight: null,
      },
    ],
    presentation: { highlight: null, takeover: null },
    fatalErrorMessage: null,
  };
}

describe("TvSnapshotSchema", () => {
  it("validates the shared snapshot contract", async () => {
    await expect(TvSnapshotSchema.validate(validSnapshot(), { strict: true })).resolves.toMatchObject({
      profile: { id: "company-pulse" },
    });
  });

  it("rejects contradictory Email Health outcome counts", async () => {
    const snapshot = validSnapshot();
    const email = snapshot.screens[3];
    await expect(TvEmailHealthScreenSchema.validate({
      ...email,
      data: { ...email.data, sent: 20, assessableSends: 10, delivered: 19, bounced: 0, errors: 0 },
    }, { strict: true })).rejects.toThrow("email outcome counts are inconsistent");
  });

  it.each(["healthy", "ready", "limited", "empty", "insufficient-data", "unavailable", "error", "stale"] as const)(
    "accepts the %s source-health status",
    async (status) => {
      await expect(TvSnapshotSchema.validate(validSnapshot(status), { strict: true })).resolves.toBeDefined();
    },
  );

  it.each([
    ["ready without data", { sourceStatus: "ready", diagnosticCode: null, data: null }],
    ["ready without activity", { sourceStatus: "ready", diagnosticCode: null, data: { visitors: 0, qualifyingSessions: 0, averageSessionSeconds: null } }],
    ["empty with activity", { sourceStatus: "empty", diagnosticCode: null, data: { visitors: 1, qualifyingSessions: 0, averageSessionSeconds: null } }],
    ["unavailable with data", { sourceStatus: "unavailable", diagnosticCode: "analytics-app-disabled", data: { visitors: 1, qualifyingSessions: 0, averageSessionSeconds: null } }],
    ["no sessions with an average", { sourceStatus: "ready", diagnosticCode: null, data: { visitors: 1, qualifyingSessions: 0, averageSessionSeconds: 0 } }],
    ["sessions without an average", { sourceStatus: "ready", diagnosticCode: null, data: { visitors: 1, qualifyingSessions: 1, averageSessionSeconds: null } }],
  ])("rejects inconsistent Audience Analytics state: %s", async (_label, analytics) => {
    const snapshot = validSnapshot();
    const audience = snapshot.screens[1];
    await expect(TvAudienceMomentumScreenSchema.validate({
      ...audience,
      data: {
        ...audience.data,
        analytics: { ...analytics, observedAt: snapshot.generatedAt },
      },
    }, { strict: true })).rejects.toThrow("Analytics source state is inconsistent");
  });

  it("accepts empty Analytics activity without treating it as a failed source", async () => {
    const snapshot = validSnapshot();
    const audience = snapshot.screens[1];
    await expect(TvAudienceMomentumScreenSchema.validate({
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
    }, { strict: true })).resolves.toBeDefined();
  });

  it("accepts a profile-owned duration schedule aligned with the playlist", async () => {
    const snapshot = validSnapshot();
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      profile: {
        ...snapshot.profile,
        screenDurations: snapshot.profile.playlist.map((screenId) => ({
          screenId,
          durationSeconds: 20,
        })),
      },
    }, { strict: true })).resolves.toBeDefined();
  });

  it("rejects duration schedules that do not align with playlist order", async () => {
    const snapshot = validSnapshot();
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      profile: {
        ...snapshot.profile,
        screenDurations: [...snapshot.profile.playlist].reverse().map((screenId) => ({
          screenId,
          durationSeconds: 20,
        })),
      },
    }, { strict: true })).rejects.toThrow("unique, known screen IDs");
  });

  it("rejects PII and unknown fields", async () => {
    const snapshot = validSnapshot();
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      project: { ...snapshot.project, primaryEmail: "private@example.com" },
    }, { strict: true })).rejects.toThrow();
  });

  it("rejects duplicate or missing screen IDs", async () => {
    const snapshot = validSnapshot();
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      screens: [snapshot.screens[0], snapshot.screens[0], snapshot.screens[2], snapshot.screens[3]],
    }, { strict: true })).rejects.toThrow("unique, known screen IDs");
  });

  it("accepts a bounded Critical takeover and rejects inconsistent lifecycle states", async () => {
    const snapshot = validSnapshot();
    const event = {
      id: "event",
      type: "email-delivery-degradation",
      presentationClass: "critical-incident",
      status: "active",
      title: "Email delivery degraded",
      summary: "Delivery is outside its expected range.",
      metricLabel: "Delivery rate",
      metricValue: "78%",
      expectedRange: "Expected 95% or higher",
      sourceLabel: "Hexclave email",
      occurredAt: snapshot.generatedAt,
      updatedAt: snapshot.generatedAt,
    };
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      presentation: {
        takeover: {
          event,
          variant: "critical-incident",
          startedAt: snapshot.generatedAt,
          endsAt: "2026-07-25T12:01:00.000Z",
        },
        highlight: null,
      },
    }, { strict: true })).resolves.toBeDefined();
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      presentation: {
        takeover: {
          event,
          variant: "critical-incident",
          startedAt: snapshot.generatedAt,
          endsAt: snapshot.generatedAt,
        },
        highlight: null,
      },
    }, { strict: true })).rejects.toThrow();
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      presentation: {
        takeover: {
          event,
          variant: "critical-incident",
          startedAt: snapshot.generatedAt,
          endsAt: "2026-07-25T12:02:01.000Z",
        },
        highlight: null,
      },
    }, { strict: true })).rejects.toThrow("deadline");
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      presentation: {
        takeover: {
          event: { ...event, type: "user-milestone" },
          variant: "critical-incident",
          startedAt: snapshot.generatedAt,
          endsAt: "2026-07-25T12:01:00.000Z",
        },
        highlight: null,
      },
    }, { strict: true })).rejects.toThrow("event type and presentation class");
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      presentation: {
        takeover: null,
        highlight: {
          event: {
            ...event,
            presentationClass: "celebration",
            status: "resolved",
            type: "user-milestone",
          },
          variant: "celebration",
          expiresAt: "2026-07-25T14:00:00.000Z",
          animationExpiresAt: "2026-07-25T13:00:00.000Z",
        },
      },
    }, { strict: true })).rejects.toThrow("inconsistent");
    await expect(TvSnapshotSchema.validate({
      ...snapshot,
      presentation: {
        takeover: null,
        highlight: {
          event,
          variant: "celebration",
          expiresAt: "2026-07-25T13:00:00.000Z",
          animationExpiresAt: "2026-07-25T14:00:00.000Z",
        },
      },
    }, { strict: true })).rejects.toThrow("inconsistent");
  });
});

describe("TvProfileConfigurationSchema", () => {
  it("validates built-in templates through the persisted configuration contract", async () => {
    const companyPulse = getTvBuiltInProfile("company-pulse");
    if (companyPulse == null) throw new Error("Company Pulse must exist.");
    await expect(TvProfileConfigurationSchema.validate(
      companyPulse.configuration,
      { strict: true },
    )).resolves.toEqual(companyPulse.configuration);
  });

  it("returns isolated built-in profile graphs", () => {
    const firstCompanyPulse = getTvBuiltInProfile("company-pulse");
    const secondCompanyPulse = getTvBuiltInProfile("company-pulse");
    const engineeringOffice = getTvBuiltInProfile("engineering-office");
    if (firstCompanyPulse == null || secondCompanyPulse == null || engineeringOffice == null) {
      throw new Error("TV built-in profiles must exist.");
    }

    firstCompanyPulse.configuration.interruptionPreferences.incidentTypes.emailDeliveryDegradation = false;

    expect(secondCompanyPulse.configuration.interruptionPreferences.incidentTypes.emailDeliveryDegradation).toBe(true);
    expect(engineeringOffice.configuration.interruptionPreferences.incidentTypes.emailDeliveryDegradation).toBe(true);
    expect(getTvBuiltInProfile("company-pulse")?.configuration.interruptionPreferences.incidentTypes.emailDeliveryDegradation).toBe(true);
  });

  it("rejects duplicate screens and revenue celebrations in redacted profiles", async () => {
    const companyPulse = getTvBuiltInProfile("company-pulse");
    if (companyPulse == null) throw new Error("Company Pulse must exist.");
    await expect(TvProfileConfigurationSchema.validate({
      ...companyPulse.configuration,
      playlist: [
        companyPulse.configuration.playlist[0],
        companyPulse.configuration.playlist[0],
      ],
    }, { strict: true })).rejects.toThrow("unique screen IDs");
    await expect(TvProfileConfigurationSchema.validate({
      ...companyPulse.configuration,
      interruptionPreferences: {
        ...companyPulse.configuration.interruptionPreferences,
        celebrations: { userMilestone: true, revenueMilestone: true },
      },
    }, { strict: true })).rejects.toThrow("Revenue milestones require exact financial visibility");
  });

  it("rejects celebration animation that outlives its Highlight", async () => {
    const companyPulse = getTvBuiltInProfile("company-pulse");
    if (companyPulse == null) throw new Error("Company Pulse must exist.");
    await expect(TvProfileConfigurationSchema.validate({
      ...companyPulse.configuration,
      interruptionPreferences: {
        ...companyPulse.configuration.interruptionPreferences,
        timing: {
          ...companyPulse.configuration.interruptionPreferences.timing,
          celebration: {
            takeoverSeconds: 60,
            animationSeconds: 7200,
            highlightSeconds: 3600,
          },
        },
      },
    }, { strict: true })).rejects.toThrow("must not outlive");
  });

  it("rejects display names whose normalized uniqueness key exceeds storage", async () => {
    const companyPulse = getTvBuiltInProfile("company-pulse");
    if (companyPulse == null) throw new Error("Company Pulse must exist.");
    await expect(TvProfileConfigurationSchema.validate({
      ...companyPulse.configuration,
      // Each character expands to an 18-character Arabic phrase under NFKC.
      displayName: "ﷺ".repeat(5),
    }, { strict: true })).rejects.toThrow("after normalization");
  });
});

describe("TV sample thresholds", () => {
  it.each([
    [9, 9, null],
    [10, 9, 90],
    [11, 10, 90.9],
  ])("applies the payment threshold at %i attempts", (attempts, successes, expected) => {
    expect(calculateTvPaymentSuccessPercent(attempts, successes)).toBe(expected);
  });

  it.each([
    [19, 18, null],
    [20, 19, 95],
    [21, 20, 95.2],
  ])("applies the email threshold at %i assessable outcomes", (assessable, delivered, expectedDelivery) => {
    expect(calculateTvEmailRates(assessable, delivered, 0).deliveryRatePercent).toBe(expectedDelivery);
  });
});

describe("independent TV display contracts", () => {
  it("accepts only bounded pairing challenge fields", async () => {
    await expect(TvDisplayPairingChallengeSchema.validate({
      challengeId: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
      pairingCode: "A2BC3DEF",
      deviceSecret: "high-entropy-device-secret-with-safe-length",
      expiresAt: "2026-08-14T12:10:00.000Z",
      pollingIntervalSeconds: 5,
    }, { strict: true })).resolves.toBeDefined();
    await expect(TvDisplayPairingChallengeSchema.validate({
      challengeId: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
      pairingCode: "SHORT",
      deviceSecret: "secret",
      expiresAt: "2026-08-14T12:10:00.000Z",
      pollingIntervalSeconds: 5,
    }, { strict: true })).rejects.toThrow();
    await expect(TvDisplayPairingChallengeSchema.validate({
      challengeId: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
      pairingCode: "A2BC3DEF",
      deviceSecret: "x".repeat(257),
      expiresAt: "2026-08-14T12:10:00.000Z",
      pollingIntervalSeconds: 5,
    }, { strict: true })).rejects.toThrow();
  });

  it("requires explicit financial-acknowledgement state on display resources", async () => {
    await expect(TvDisplayResourceSchema.validate({
      id: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
      displayName: "Lobby",
      profileId: "company-pulse",
      profileDisplayName: "Company Pulse",
      profileFinancialVisibility: "redacted",
      state: "online",
      pairedAt: "2026-08-14T12:00:00.000Z",
      lastSeenAt: "2026-08-14T12:01:00.000Z",
    }, { strict: true })).rejects.toThrow();
  });

  it("rejects obsolete soft-revocation display state", async () => {
    await expect(TvDisplayResourceSchema.validate({
      id: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
      displayName: "Lobby",
      profileId: "company-pulse",
      profileDisplayName: "Company Pulse",
      profileFinancialVisibility: "redacted",
      state: "revoked",
      pairedAt: "2026-08-14T12:00:00.000Z",
      lastSeenAt: null,
      exactFinancialsAcknowledged: false,
    }, { strict: true })).rejects.toThrow();
  });
});
