import { describe, expect, it } from "vitest";
import type {
  TvAudienceMomentumScreen,
  TvEmailHealthScreen,
  TvLivePulseScreen,
  TvRevenuePaymentsScreen,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { getTvBuiltInProfile } from "@hexclave/shared/dist/interface/admin-tv-mode";
import {
  addTvSourceHealth,
  assertTvRevenueFactsAreTrustworthy,
  applyTvDisplayFinancialPolicy,
  applyTvAudienceAnalytics,
  assembleTvSnapshot,
  buildCumulativeRevenueTrend,
  createReadyTvLivePulseScreen,
  createTvAudienceAnalyticsObservation,
  createTvLivePulseErrorScreen,
  getTvOperationalMetricsClient,
  getTvAudienceWindowBounds,
  getTvAudienceLifecycleSince,
  hasTvPaymentData,
  isTvEmailInsightEligible,
  isTvReturningInsightEligible,
  sourceHealthFact,
  TV_AUDIENCE_ANALYTICS_QUERY,
  TV_AUDIENCE_LIFECYCLE_QUERY,
  TV_LEGACY_SUBSCRIPTION_REVENUE_OUTCOME_FILTER,
  TV_NORMALIZED_SUBSCRIPTION_REVENUE_OUTCOME_FILTER,
} from "./snapshot";

const observedAt = "2026-07-25T12:00:00.000Z";
type TvAudienceAnalytics = NonNullable<TvAudienceMomentumScreen["data"]>["analytics"];
const window = {
  current: { startsAt: observedAt, endsAt: observedAt, label: "Current" },
  comparison: null,
};

const screens = {
  livePulse: {
    id: "live-pulse",
    sourceStatus: "ready",
    sourceLabel: "Activity",
    observedAt,
    window,
    diagnosticCode: null,
    data: { liveUsers: 1, todayActiveUsers: 2, hourlyActivity: [], sourceHealth: [] },
    insight: null,
  } satisfies TvLivePulseScreen,
  audience: {
    id: "audience-momentum",
    sourceStatus: "error",
    sourceLabel: "Audience",
    observedAt,
    window,
    diagnosticCode: "source-query-failed",
    data: null,
    insight: null,
  } satisfies TvAudienceMomentumScreen,
  revenue: {
    id: "revenue-payments",
    sourceStatus: "unavailable",
    sourceLabel: "Payments",
    observedAt,
    window,
    diagnosticCode: "payments-app-disabled",
    data: null,
    insight: null,
  } satisfies TvRevenuePaymentsScreen,
  email: {
    id: "email-health",
    sourceStatus: "insufficient-data",
    sourceLabel: "Email",
    observedAt,
    window,
    diagnosticCode: null,
    data: {
      sent: 5,
      assessableSends: 5,
      delivered: 5,
      bounced: 0,
      errors: 0,
      inProgress: 0,
      deliveryRatePercent: null,
      bounceRatePercent: null,
      volumeChangePercent: 0,
      statusTrend: [],
    },
    insight: null,
  } satisfies TvEmailHealthScreen,
};

const companyPulseProfile = getTvBuiltInProfile("company-pulse");
if (companyPulseProfile == null) {
  throw new Error("The Company Pulse TV profile must exist.");
}

describe("assembleTvSnapshot", () => {
  it("forces exact display profiles through the server-side redaction policy", () => {
    const exactFinancialVisibility: "exact" = "exact";
    const exactProfile = {
      ...companyPulseProfile,
      configuration: {
        ...companyPulseProfile.configuration,
        financialVisibility: exactFinancialVisibility,
        interruptionPreferences: {
          ...companyPulseProfile.configuration.interruptionPreferences,
          celebrations: {
            ...companyPulseProfile.configuration.interruptionPreferences.celebrations,
            revenueMilestone: true,
          },
        },
      },
    };
    const effective = applyTvDisplayFinancialPolicy(exactProfile, true);
    expect(effective.configuration.financialVisibility).toBe("redacted");
    expect(effective.configuration.interruptionPreferences.celebrations.revenueMilestone).toBe(false);
    expect(exactProfile.configuration.financialVisibility).toBe("exact");
  });

  it("keeps each source state isolated in one authoritative snapshot", () => {
    const snapshot = assembleTvSnapshot({
      project: { id: "project-a", displayName: "Project A" },
      profile: companyPulseProfile,
      now: new Date(observedAt),
      screens,
    });

    expect(snapshot).toMatchObject({
      generatedAt: observedAt,
      staleAfter: "2026-07-25T12:00:45.000Z",
      project: { id: "project-a", displayName: "Project A" },
      profile: { id: "company-pulse" },
      screens: [
        { id: "live-pulse", sourceStatus: "ready" },
        { id: "audience-momentum", sourceStatus: "error" },
        { id: "revenue-payments", sourceStatus: "unavailable" },
        { id: "email-health", sourceStatus: "insufficient-data" },
      ],
    });
  });

  it("places resolved per-screen timing under the snapshot profile", () => {
    const snapshot = assembleTvSnapshot({
      project: { id: "project-a", displayName: "Project A" },
      profile: companyPulseProfile,
      now: new Date(observedAt),
      includeScreenDurations: true,
      screens,
    });

    expect(snapshot.profile.screenDurations).toEqual([
      { screenId: "live-pulse", durationSeconds: 15 },
      { screenId: "audience-momentum", durationSeconds: 20 },
      { screenId: "revenue-payments", durationSeconds: 18 },
      { screenId: "email-health", durationSeconds: 18 },
    ]);
  });

  it("returns redacted live financial data supplied by the payments adapter", () => {
    const snapshot = assembleTvSnapshot({
      project: { id: "project-a", displayName: "Project A" },
      profile: companyPulseProfile,
      now: new Date(observedAt),
      screens: {
        ...screens,
        revenue: {
          ...screens.revenue,
          sourceStatus: "ready",
          diagnosticCode: null,
          data: {
            financials: { visibility: "redacted", direction: "up", normalizedRevenueTrend: [] },
            revenueChangePercent: 10,
            activeSubscriptions: 2,
            newSubscriptions: 1,
            pastDueSubscriptions: 0,
            paymentSuccess: { applicableAttempts: 10, percent: 100 },
          },
        },
      },
    });
    const revenueScreen = snapshot.screens.find((screen) => screen.id === "revenue-payments");
    expect(revenueScreen?.data?.financials).toEqual({
      visibility: "redacted",
      direction: "up",
      normalizedRevenueTrend: [],
    });
  });

  it("rejects exact financial values at the live snapshot assembly boundary", () => {
    expect(() => assembleTvSnapshot({
      project: { id: "project-a", displayName: "Project A" },
      profile: companyPulseProfile,
      now: new Date(observedAt),
      screens: {
        ...screens,
        revenue: {
          ...screens.revenue,
          sourceStatus: "ready",
          diagnosticCode: null,
          data: {
            financials: {
              visibility: "exact",
              paidRevenueCents: 100,
              revenueTrend: [],
            },
            revenueChangePercent: 0,
            activeSubscriptions: 1,
            newSubscriptions: 0,
            pastDueSubscriptions: 0,
            paymentSuccess: { applicableAttempts: 10, percent: 100 },
          },
        },
      },
    })).toThrow("must not expose exact financial values");
  });
});

describe("TV revenue trend boundaries", () => {
  it("uses the same terminal-outcome filters for summary totals and daily trends", () => {
    expect(TV_NORMALIZED_SUBSCRIPTION_REVENUE_OUTCOME_FILTER).toContain(
      '("markedUncollectibleAt" IS NULL OR "markedUncollectibleAt" <= "paidAt")',
    );
    expect(TV_NORMALIZED_SUBSCRIPTION_REVENUE_OUTCOME_FILTER).toContain(
      '("voidedAt" IS NULL OR "voidedAt" <= "paidAt")',
    );
    expect(TV_LEGACY_SUBSCRIPTION_REVENUE_OUTCOME_FILTER).toContain('"markedUncollectibleAt" IS NULL');
    expect(TV_LEGACY_SUBSCRIPTION_REVENUE_OUTCOME_FILTER).toContain('"voidedAt" IS NULL');
  });

  it("includes revenue from every UTC date touched by the trailing timestamp window", () => {
    const trend = buildCumulativeRevenueTrend({
      currentStartsAt: new Date("2026-07-22T12:00:00.000Z"),
      currentEndsAt: new Date("2026-08-21T12:00:00.000Z"),
      comparisonStartsAt: new Date("2026-06-22T12:00:00.000Z"),
      comparisonEndsAt: new Date("2026-07-22T12:00:00.000Z"),
    }, new Map([
      ["2026-07-22", 100],
      ["2026-08-21", 200],
    ]));

    expect(trend).toHaveLength(7);
    expect(trend[0]).toEqual({ label: "Jul 22", value: 100 });
    expect(trend.at(-1)).toEqual({ label: "Aug 21", value: 300 });
  });

  it("does not add the exclusive end date when the window ends at UTC midnight", () => {
    const trend = buildCumulativeRevenueTrend({
      currentStartsAt: new Date("2026-07-22T00:00:00.000Z"),
      currentEndsAt: new Date("2026-08-21T00:00:00.000Z"),
      comparisonStartsAt: new Date("2026-06-22T00:00:00.000Z"),
      comparisonEndsAt: new Date("2026-07-22T00:00:00.000Z"),
    }, new Map([
      ["2026-07-22", 100],
      ["2026-08-21", 900],
    ]));

    expect(trend[0]).toEqual({ label: "Jul 22", value: 100 });
    expect(trend.at(-1)).toEqual({ label: "Aug 20", value: 100 });
  });
});

describe("TV source health facts", () => {
  const readyAudience = {
    ...screens.audience,
    sourceStatus: "ready",
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
        data: { visitors: 1, qualifyingSessions: 1, averageSessionSeconds: 10 },
      },
    },
  } satisfies TvAudienceMomentumScreen;

  it("describes a ready source as reporting without claiming evaluator-backed health", () => {
    expect(sourceHealthFact("Audience", readyAudience)).toEqual({
      label: "Audience",
      status: "ready",
      value: "Fresh",
      detail: "All metrics available",
    });
  });

  it.each([
    ["unavailable", "analytics-app-disabled", "Engagement metrics not enabled"],
    ["error", "source-query-failed", "Engagement metrics temporarily unavailable"],
    ["insufficient-data", "insufficient-analytics-data", "Not enough engagement data"],
  ] satisfies ReadonlyArray<readonly [TvAudienceAnalytics["sourceStatus"], string, string]>)("describes %s Analytics enrichment as limited Audience data", (sourceStatus, diagnosticCode, detail) => {
    const audience = applyTvAudienceAnalytics(readyAudience, {
      sourceStatus,
      observedAt,
      diagnosticCode,
      data: null,
    });
    expect(sourceHealthFact("Audience", audience)).toEqual({
      label: "Audience",
      status: "limited",
      value: "Limited",
      detail,
    });
  });

  it.each([
    ["empty", "empty", "No activity", "No data in this reporting window"],
    ["insufficient-data", "insufficient-data", "Limited", "Insufficient data"],
    ["unavailable", "unavailable", "Unavailable", "Source unavailable"],
    ["error", "error", "Error", "Source error"],
    ["stale", "stale", "Stale", "Data may be outdated"],
  ] as const)("maps %s to accurate source wording", (sourceStatus, status, value, detail) => {
    expect(sourceHealthFact("Audience", { ...screens.audience, sourceStatus })).toEqual({
      label: "Audience",
      status,
      value,
      detail,
    });
  });
});

describe("TV Audience Analytics enrichment", () => {
  const coreAudience = {
    id: "audience-momentum",
    sourceStatus: "ready",
    sourceLabel: "Audience",
    observedAt,
    window,
    diagnosticCode: null,
    data: {
      totalUsers: 12,
      userGrowthPercent: 5,
      newUsers: 2,
      monthlyActiveUsers: 8,
      verificationRatePercent: 50,
      lifecycle: [{ label: "Fri", primary: 1, secondary: 3, tertiary: 1 }],
      analytics: {
        sourceStatus: "ready",
        observedAt,
        diagnosticCode: null,
        data: { visitors: 9, qualifyingSessions: 3, averageSessionSeconds: 20 },
      },
    },
    insight: {
      kind: "returning-users-leading",
      message: "Returning users lead.",
      evidence: { newActivity: 1, retainedActivity: 3, reactivatedActivity: 1, leadMarginPercent: 300 },
    },
  } satisfies TvAudienceMomentumScreen;

  it.each([
    ["unavailable", "analytics-app-disabled"],
    ["error", "source-query-failed"],
  ] satisfies ReadonlyArray<readonly [TvAudienceAnalytics["sourceStatus"], string]>)("preserves core data and its insight when Analytics is %s", (sourceStatus, diagnosticCode) => {
    const enriched = applyTvAudienceAnalytics(coreAudience, {
      sourceStatus,
      observedAt: "2026-07-25T12:00:15.000Z",
      diagnosticCode,
      data: null,
    });
    expect(enriched).toMatchObject({
      sourceStatus: "ready",
      diagnosticCode: null,
      data: {
        totalUsers: 12,
        monthlyActiveUsers: 8,
        lifecycle: coreAudience.data.lifecycle,
        analytics: { sourceStatus, data: null },
      },
      insight: coreAudience.insight,
    });
  });

  it("replaces prior Analytics values rather than leaking them into a failed poll", () => {
    const failed = applyTvAudienceAnalytics(coreAudience, {
      sourceStatus: "error",
      observedAt: "2026-07-25T12:00:15.000Z",
      diagnosticCode: "source-query-failed",
      data: null,
    });
    const recovered = applyTvAudienceAnalytics(failed, {
      sourceStatus: "ready",
      observedAt: "2026-07-25T12:00:30.000Z",
      diagnosticCode: null,
      data: { visitors: 4, qualifyingSessions: 1, averageSessionSeconds: 0 },
    });
    expect(failed.data?.analytics.data).toBeNull();
    expect(recovered.data?.analytics).toMatchObject({
      sourceStatus: "ready",
      data: { visitors: 4, qualifyingSessions: 1, averageSessionSeconds: 0 },
    });
  });

  it("represents legitimate zero activity as an observed empty enrichment", () => {
    expect(createTvAudienceAnalyticsObservation({
      observedAt,
      visitors: 0,
      qualifyingSessions: 0,
      averageSessionSeconds: null,
    })).toEqual({
      sourceStatus: "empty",
      observedAt,
      diagnosticCode: null,
      data: { visitors: 0, qualifyingSessions: 0, averageSessionSeconds: null },
    });
  });

  it("preserves a measured zero-second session and rejects inconsistent session evidence", () => {
    expect(createTvAudienceAnalyticsObservation({
      observedAt,
      visitors: 1,
      qualifyingSessions: 1,
      averageSessionSeconds: 0,
    }).sourceStatus).toBe("ready");
    expect(() => createTvAudienceAnalyticsObservation({
      observedAt,
      visitors: 1,
      qualifyingSessions: 0,
      averageSessionSeconds: 0,
    })).toThrow("inconsistent qualification data");
  });
});

describe("TV payment activity qualification", () => {
  const emptyMetrics = {
    applicableAttempts: 0,
    currentRevenue: 0,
    activeSubscriptions: 0,
    newSubscriptions: 0,
    pastDueSubscriptions: 0,
  };

  it("keeps a past-due-only project out of the empty state", () => {
    expect(hasTvPaymentData({ ...emptyMetrics, pastDueSubscriptions: 1 })).toBe(true);
  });

  it("keeps a new-subscription-only project out of the empty state", () => {
    expect(hasTvPaymentData({ ...emptyMetrics, newSubscriptions: 1 })).toBe(true);
  });

  it("recognizes a truly empty project", () => {
    expect(hasTvPaymentData(emptyMetrics)).toBe(false);
  });

  it("fails closed for malformed legacy revenue instead of understating the total", () => {
    const trustworthy = {
      unsupportedCurrencies: 0,
      invalidNormalizedFacts: 0,
      invalidLegacyFacts: 0,
    };
    expect(() => assertTvRevenueFactsAreTrustworthy(trustworthy)).not.toThrow();
    expect(() => assertTvRevenueFactsAreTrustworthy({
      ...trustworthy,
      invalidLegacyFacts: 1,
    })).toThrow("incomplete legacy payment facts");
  });
});

describe("Live Pulse activity source states", () => {
  it("keeps a successful all-zero activity observation ready", () => {
    expect(createReadyTvLivePulseScreen({
      now: new Date(observedAt),
      liveUsers: 0,
      todayActiveUsers: 0,
      hourlyActivity: [],
    })).toMatchObject({
      sourceStatus: "ready",
      diagnosticCode: null,
      data: {
        liveUsers: 0,
        todayActiveUsers: 0,
        hourlyActivity: [{ value: 0 }],
      },
    });
  });

  it("keeps zero live users with positive current-day activity ready", () => {
    expect(createReadyTvLivePulseScreen({
      now: new Date(observedAt),
      liveUsers: 0,
      todayActiveUsers: 12,
      hourlyActivity: [{ label: "11:00", value: 12 }],
    })).toMatchObject({
      sourceStatus: "ready",
      data: {
        liveUsers: 0,
        todayActiveUsers: 12,
        hourlyActivity: [{ label: "11:00", value: 12 }],
      },
    });
  });

  it("keeps Live Pulse ready when Email and Payments have limited samples", () => {
    const livePulse = addTvSourceHealth(
      createReadyTvLivePulseScreen({
        now: new Date(observedAt),
        liveUsers: 0,
        todayActiveUsers: 0,
        hourlyActivity: [],
      }),
      {
        email: screens.email,
        revenue: {
          ...screens.revenue,
          sourceStatus: "insufficient-data",
          diagnosticCode: null,
          data: {
            financials: { visibility: "redacted", direction: "flat", normalizedRevenueTrend: [] },
            revenueChangePercent: 0,
            activeSubscriptions: 0,
            newSubscriptions: 0,
            pastDueSubscriptions: 0,
            paymentSuccess: { applicableAttempts: 4, percent: null },
          },
        },
        audience: screens.audience,
      },
    );

    expect(livePulse.sourceStatus).toBe("ready");
    expect(livePulse.data?.sourceHealth.slice(0, 2)).toEqual([
      {
        label: "Email delivery",
        status: "insufficient-data",
        value: "Limited",
        detail: "Insufficient data",
      },
      {
        label: "Payment collection",
        status: "insufficient-data",
        value: "Limited",
        detail: "Insufficient data",
      },
    ]);
  });

  it("keeps an activity query failure in the error state", () => {
    expect(createTvLivePulseErrorScreen(new Date(observedAt))).toMatchObject({
      sourceStatus: "error",
      diagnosticCode: "source-query-failed",
      data: null,
      insight: null,
    });
  });
});

describe("TV deterministic insight eligibility", () => {
  it("requires returning activity to lead new activity by at least ten percent", () => {
    expect(isTvReturningInsightEligible(100, 109)).toBe(false);
    expect(isTvReturningInsightEligible(100, 110)).toBe(true);
    expect(isTvReturningInsightEligible(0, 10)).toBe(false);
  });

  it("requires qualifying email delivery and a volume increase above twenty percent", () => {
    expect(isTvEmailInsightEligible(null, 25)).toBe(false);
    expect(isTvEmailInsightEligible(98.9, 25)).toBe(false);
    expect(isTvEmailInsightEligible(99, 20)).toBe(false);
    expect(isTvEmailInsightEligible(99, 20.1)).toBe(true);
  });
});

describe("TV operational metric routing", () => {
  it("uses the configured replica client for stale-tolerant operational metrics", () => {
    const replicaClient = { role: "replica" };
    let replicaSelections = 0;
    const selected = getTvOperationalMetricsClient({
      $replica: () => {
        replicaSelections += 1;
        return replicaClient;
      },
    });

    expect(selected).toBe(replicaClient);
    expect(replicaSelections).toBe(1);
  });
});

describe("TV Audience lifecycle query", () => {
  it("uses one rolling seven-day interval for audience metrics", () => {
    expect(getTvAudienceWindowBounds(new Date("2026-07-29T12:00:00.000Z"))).toEqual({
      currentStartsAt: new Date("2026-07-22T12:00:00.000Z"),
      currentEndsAt: new Date("2026-07-29T12:00:00.000Z"),
      comparisonStartsAt: new Date("2026-07-15T12:00:00.000Z"),
      comparisonEndsAt: new Date("2026-07-22T12:00:00.000Z"),
    });
  });

  it("aligns the final lifecycle bucket with the last rendered UTC calendar day", () => {
    const bounds = getTvAudienceWindowBounds(new Date("2026-07-29T12:00:00.000Z"));
    const lifecycleSince = getTvAudienceLifecycleSince(bounds.currentEndsAt);
    const bucketSix = new Date(lifecycleSince.getTime() + 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    expect(bucketSix).toBe("2026-07-29");
  });

  it("uses the upstream memory-bounded day-mask shape", () => {
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).toContain("sipHash64(assumeNotNull(user_id))");
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).toContain("groupBitOr");
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).toContain("ARRAY JOIN range({windowDays:UInt32})");
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).toContain("toDate(min(event_at)) AS first_date");
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).not.toContain("analytics_internal.users");
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).not.toContain("lagInFrame");
    expect(TV_AUDIENCE_LIFECYCLE_QUERY).not.toContain("SELECT DISTINCT toDate(event_at)");
  });

  it("keeps Analytics enrichment scoped and preserves empty-session semantics", () => {
    expect(TV_AUDIENCE_ANALYTICS_QUERY).toContain("project_id = {projectId:String}");
    expect(TV_AUDIENCE_ANALYTICS_QUERY).toContain("branch_id = {branchId:String}");
    expect(TV_AUDIENCE_ANALYTICS_QUERY).toContain("count() FROM sessions");
    expect(TV_AUDIENCE_ANALYTICS_QUERY).toContain("avgOrNull(duration_s)");
  });
});
