import { throwErr } from "@hexclave/shared/dist/utils/errors";
import {
  calculateTvEmailRates,
  calculateTvPaymentSuccessPercent,
  getTvBuiltInProfile,
  TV_MINIMUM_EMAIL_OUTCOMES,
  TV_MINIMUM_PAYMENT_ATTEMPTS,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import type {
  TvAudienceMomentumScreen,
  TvEmailHealthScreen,
  TvEvent,
  TvFixtureVariant,
  TvLivePulseScreen,
  TvPresentedEventHighlight,
  TvPresentedTakeover,
  TvProfileFixture,
  TvRevenuePaymentsScreen,
  TvScreenSnapshot,
  TvSnapshot,
} from "./types";

const FIXTURE_NOW = "2026-07-23T14:32:00.000Z";
const FIXTURE_STALE_AFTER = "2026-07-23T14:32:45.000Z";
const DAY = 24 * 60 * 60 * 1000;
export { TV_MINIMUM_EMAIL_OUTCOMES, TV_MINIMUM_PAYMENT_ATTEMPTS };
const engineeringProfile = getTvBuiltInProfile("engineering-office") ?? throwErr("Missing shared engineering-office TV profile");
const companyPulseProfile = getTvBuiltInProfile("company-pulse") ?? throwErr("Missing shared company-pulse TV profile");

export function calculateFixturePaymentSuccess(applicableAttempts: number, successfulAttempts: number): number | null {
  return calculateTvPaymentSuccessPercent(applicableAttempts, successfulAttempts);
}

export function calculateFixtureEmailRates(assessableSends: number, delivered: number, bounced: number) {
  return calculateTvEmailRates(assessableSends, delivered, bounced);
}

function windowFrom(days: number, comparison = true) {
  const endsAt = new Date(FIXTURE_NOW);
  const startsAt = days === 1
    ? new Date(Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth(), endsAt.getUTCDate()))
    : new Date(endsAt.getTime() - days * DAY);
  const comparisonEndsAt = new Date(startsAt);
  const comparisonStartsAt = new Date(comparisonEndsAt.getTime() - days * DAY);
  return {
    current: {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      label: days === 1 ? "Today · UTC" : `Trailing ${days} days`,
    },
    comparison: comparison ? {
      startsAt: comparisonStartsAt.toISOString(),
      endsAt: comparisonEndsAt.toISOString(),
      label: `Previous ${days} days`,
    } : null,
  };
}

const livePulseScreen: TvLivePulseScreen = {
  id: "live-pulse",
  sourceStatus: "ready",
  sourceLabel: "Hexclave activity",
  observedAt: FIXTURE_NOW,
  window: windowFrom(1, false),
  diagnosticCode: null,
  data: {
    liveUsers: 42,
    todayActiveUsers: 186,
    hourlyActivity: [
      { label: "08:00", value: 12 }, { label: "09:00", value: 18 },
      { label: "10:00", value: 17 }, { label: "11:00", value: 29 },
      { label: "12:00", value: 25 }, { label: "13:00", value: 37 },
      { label: "14:00", value: 42 },
    ],
    sourceHealth: [
      { label: "Email delivery", status: "ready", value: "99.2%", detail: "Metrics available" },
      { label: "Payment collection", status: "ready", value: "98.6%", detail: "Metrics available" },
      { label: "Audience", status: "ready", value: "Fresh", detail: "All metrics available" },
    ],
  },
  insight: {
    kind: "live-activity-above-baseline",
    message: "Live activity is 18% above the comparable recent baseline.",
    evidence: { currentLiveUsers: 42, baselineLiveUsers: 35.5, deltaPercent: 18.3 },
  },
};

const audienceMomentumScreen: TvAudienceMomentumScreen = {
  id: "audience-momentum",
  sourceStatus: "ready",
  sourceLabel: "Hexclave users & analytics",
  observedAt: FIXTURE_NOW,
  window: windowFrom(7),
  diagnosticCode: null,
  data: {
    totalUsers: 512,
    userGrowthPercent: 12.8,
    newUsers: 38,
    monthlyActiveUsers: 361,
    verificationRatePercent: 91.6,
    lifecycle: [
      { label: "Thu", primary: 18, secondary: 48, tertiary: 12 },
      { label: "Fri", primary: 24, secondary: 56, tertiary: 14 },
      { label: "Sat", primary: 16, secondary: 51, tertiary: 11 },
      { label: "Sun", primary: 21, secondary: 58, tertiary: 15 },
      { label: "Mon", primary: 29, secondary: 72, tertiary: 18 },
      { label: "Tue", primary: 31, secondary: 79, tertiary: 22 },
      { label: "Wed", primary: 38, secondary: 91, tertiary: 25 },
    ],
    analytics: {
      sourceStatus: "ready",
      observedAt: FIXTURE_NOW,
      diagnosticCode: null,
      data: {
        visitors: 923,
        qualifyingSessions: 214,
        averageSessionSeconds: 252,
      },
    },
  },
  insight: {
    kind: "returning-users-leading",
    message: "Audience momentum is being driven primarily by returning users.",
    evidence: {
      newActivity: 177,
      retainedActivity: 455,
      reactivatedActivity: 117,
      leadMarginPercent: 157.1,
    },
  },
};

const exactRevenueTrend = [
  { label: "Jun 24", value: 112000 }, { label: "Jun 29", value: 149000 },
  { label: "Jul 4", value: 128000 }, { label: "Jul 9", value: 176000 },
  { label: "Jul 14", value: 162000 }, { label: "Jul 19", value: 201000 },
  { label: "Jul 23", value: 238000 },
];

const revenuePaymentsScreen: TvRevenuePaymentsScreen = {
  id: "revenue-payments",
  sourceStatus: "ready",
  sourceLabel: "Hexclave payments",
  observedAt: FIXTURE_NOW,
  window: windowFrom(30),
  diagnosticCode: null,
  data: {
    financials: {
      visibility: "exact",
      paidRevenueCents: 4823156,
      revenueTrend: exactRevenueTrend,
    },
    revenueChangePercent: 14.2,
    activeSubscriptions: 147,
    newSubscriptions: 24,
    pastDueSubscriptions: 3,
    paymentSuccess: { applicableAttempts: 286, percent: calculateFixturePaymentSuccess(286, 282) },
  },
  insight: {
    kind: "revenue-up-payments-stable",
    message: "Gross collected revenue increased while subscription collection remained stable.",
    evidence: {
      revenueChangePercent: 14.2,
      paymentSuccessPercent: 98.6,
      applicablePaymentAttempts: 286,
    },
  },
};

const emailHealthScreen: TvEmailHealthScreen = {
  id: "email-health",
  sourceStatus: "ready",
  sourceLabel: "Hexclave email",
  observedAt: FIXTURE_NOW,
  window: windowFrom(7),
  diagnosticCode: null,
  data: {
    sent: 12640,
    assessableSends: 12640,
    delivered: 12539,
    bounced: 63,
    errors: 38,
    inProgress: 21,
    ...calculateFixtureEmailRates(12640, 12539, 63),
    volumeChangePercent: 22.1,
    statusTrend: [
      { label: "Thu", primary: 1298, secondary: 8, tertiary: 14 },
      { label: "Fri", primary: 1463, secondary: 9, tertiary: 16 },
      { label: "Sat", primary: 1080, secondary: 5, tertiary: 13 },
      { label: "Sun", primary: 1188, secondary: 7, tertiary: 16 },
      { label: "Mon", primary: 1752, secondary: 12, tertiary: 19 },
      { label: "Tue", primary: 1977, secondary: 14, tertiary: 20 },
      { label: "Wed", primary: 2347, secondary: 19, tertiary: 18 },
    ],
  },
  insight: {
    kind: "delivery-healthy-volume-up",
    message: "Delivery remained above 99% while sending volume increased by 22%.",
    evidence: { deliveryRatePercent: 99.2, volumeChangePercent: 22.1, finishedSends: 12640 },
  },
};

export const TV_PROFILE_FIXTURES = [
  {
    id: "engineering-office",
    displayName: engineeringProfile.configuration.displayName,
    description: "A broad company pulse for the engineering workspace.",
    mode: "general",
    defaultDurationSeconds: engineeringProfile.configuration.defaultDurationSeconds,
    playlist: [
      { screenId: "live-pulse", enabled: engineeringProfile.configuration.playlist.some((entry) => entry.screenId === "live-pulse"), durationSecondsOverride: 15 },
      { screenId: "audience-momentum", enabled: engineeringProfile.configuration.playlist.some((entry) => entry.screenId === "audience-momentum"), durationSecondsOverride: 20 },
      { screenId: "revenue-payments", enabled: engineeringProfile.configuration.playlist.some((entry) => entry.screenId === "revenue-payments"), durationSecondsOverride: 18 },
      { screenId: "email-health", enabled: engineeringProfile.configuration.playlist.some((entry) => entry.screenId === "email-health"), durationSecondsOverride: 18 },
    ],
    incidentTypes: engineeringProfile.configuration.interruptionPreferences.incidentTypes,
    celebrations: engineeringProfile.configuration.interruptionPreferences.celebrations,
    interruptionTiming: engineeringProfile.configuration.interruptionPreferences.timing,
    showExactFinancialValues: false,
  },
  {
    id: "company-pulse",
    displayName: companyPulseProfile.configuration.displayName,
    description: "A complete project overview for shared office spaces.",
    mode: "general",
    defaultDurationSeconds: companyPulseProfile.configuration.defaultDurationSeconds,
    playlist: [
      { screenId: "live-pulse", enabled: companyPulseProfile.configuration.playlist.some((entry) => entry.screenId === "live-pulse"), durationSecondsOverride: 15 },
      { screenId: "audience-momentum", enabled: companyPulseProfile.configuration.playlist.some((entry) => entry.screenId === "audience-momentum"), durationSecondsOverride: 20 },
      { screenId: "revenue-payments", enabled: companyPulseProfile.configuration.playlist.some((entry) => entry.screenId === "revenue-payments"), durationSecondsOverride: 18 },
      { screenId: "email-health", enabled: companyPulseProfile.configuration.playlist.some((entry) => entry.screenId === "email-health"), durationSecondsOverride: 18 },
    ],
    incidentTypes: companyPulseProfile.configuration.interruptionPreferences.incidentTypes,
    celebrations: companyPulseProfile.configuration.interruptionPreferences.celebrations,
    interruptionTiming: companyPulseProfile.configuration.interruptionPreferences.timing,
    showExactFinancialValues: companyPulseProfile.configuration.financialVisibility === "exact",
  },
] satisfies readonly TvProfileFixture[];

const userMilestoneEvent: TvEvent = {
  id: "fixture-user-milestone-500",
  type: "user-milestone",
  presentationClass: "celebration",
  status: "active",
  title: "500 Users",
  summary: "The community reached a new milestone—worth celebrating together.",
  metricLabel: "Total users",
  metricValue: "512",
  expectedRange: null,
  sourceLabel: "Hexclave users",
  occurredAt: "2026-07-23T14:30:00.000Z",
  updatedAt: FIXTURE_NOW,
};

const newerUserMilestoneEvent: TvEvent = {
  ...userMilestoneEvent,
  id: "fixture-user-milestone-1000",
  title: "1K Users",
  metricValue: "1,024",
  occurredAt: "2026-07-23T14:31:00.000Z",
};

const longContentMilestoneEvent: TvEvent = {
  ...newerUserMilestoneEvent,
  id: "fixture-user-milestone-long-content",
  title: "One Hundred Thousand Customers Now Building With Acme International",
  summary: "Teams around the world helped the community reach this milestone today.",
};

const emailDegradationEvent: TvEvent = {
  id: "fixture-email-delivery-degradation",
  type: "email-delivery-degradation",
  presentationClass: "critical-incident",
  status: "active",
  title: "Email Delivery Degraded",
  summary: "Email delivery is below the expected range. We’re monitoring recovery.",
  metricLabel: "Delivery rate",
  metricValue: "78.4%",
  expectedRange: "Expected 95% or higher",
  sourceLabel: "Hexclave email",
  occurredAt: "2026-07-23T14:28:00.000Z",
  updatedAt: FIXTURE_NOW,
};

const ordinaryEmailIncidentEvent: TvEvent = {
  ...emailDegradationEvent,
  id: "fixture-email-delivery-incident",
  presentationClass: "incident",
  metricValue: "92.1%",
};

const paymentDegradationEvent: TvEvent = {
  id: "fixture-subscription-collection-degradation",
  type: "subscription-collection-degradation",
  presentationClass: "incident",
  status: "active",
  title: "Subscription Payments Degraded",
  summary: "Subscription collection is below the expected range. We’re monitoring recovery.",
  metricLabel: "Payment Success",
  metricValue: "82%",
  expectedRange: "Expected collection range",
  sourceLabel: "Hexclave payments",
  occurredAt: "2026-07-23T14:28:00.000Z",
  updatedAt: FIXTURE_NOW,
};

const resolvedEmailEvent: TvEvent = {
  ...emailDegradationEvent,
  status: "resolved",
  title: "Email Delivery Restored",
  metricValue: "98.2%",
  summary: "Email delivery is back within the expected range.",
};

function presentedTakeover(
  event: TvEvent,
  variant: TvPresentedTakeover["variant"],
  durationSeconds: number,
): TvPresentedTakeover {
  return {
    event,
    variant,
    startedAt: FIXTURE_NOW,
    endsAt: new Date(new Date(FIXTURE_NOW).getTime() + durationSeconds * 1000).toISOString(),
  };
}

function celebrationHighlightWith(options: {
  event?: TvEvent,
  expiresAt?: string,
  animationExpiresAt?: string,
  timing: TvProfileFixture["interruptionTiming"]["celebration"],
}): TvPresentedEventHighlight {
  const event = options.event ?? userMilestoneEvent;
  const occurredAt = new Date(event.occurredAt).getTime();
  return {
    event,
    variant: "celebration",
    expiresAt: options.expiresAt ?? new Date(occurredAt + options.timing.highlightSeconds * 1000).toISOString(),
    animationExpiresAt: options.animationExpiresAt ?? new Date(occurredAt + options.timing.animationSeconds * 1000).toISOString(),
  };
}

function incidentHighlight(
  event: TvEvent,
  variant: "active-incident" | "resolved-incident",
  expiresAt: string | null,
): TvPresentedEventHighlight {
  return {
    event,
    variant,
    expiresAt,
    animationExpiresAt: null,
  };
}

export function getTvProfileFixture(profileId: string): TvProfileFixture | null {
  return TV_PROFILE_FIXTURES.find((profile) => profile.id === profileId) ?? null;
}

function redactRevenue(screen: TvRevenuePaymentsScreen): void {
  if (screen.data == null) return;
  screen.data.financials = {
    visibility: "redacted",
    direction: screen.data.revenueChangePercent > 0 ? "up" : screen.data.revenueChangePercent < 0 ? "down" : "flat",
    normalizedRevenueTrend: exactRevenueTrend.map((point, index) => ({ label: point.label, value: 100 + index * 4 })),
  };
}

function setNonDataState(screen: TvScreenSnapshot, status: "empty" | "unavailable" | "error"): void {
  screen.sourceStatus = status;
  screen.data = null;
  screen.insight = null;
  screen.diagnosticCode = status === "unavailable" ? "required-app-disabled" : status === "error" ? "source-query-failed" : null;
}

export function createTvFixtureSnapshot(projectId: string, profile: TvProfileFixture, variant: TvFixtureVariant = "default"): TvSnapshot {
  const screens: TvScreenSnapshot[] = structuredClone([
    livePulseScreen, audienceMomentumScreen, revenuePaymentsScreen, emailHealthScreen,
  ]);
  const revenue = screens.find((screen) => screen.id === "revenue-payments")
    ?? throwErr("The centralized TV fixture must include revenue-payments");
  const email = screens.find((screen) => screen.id === "email-health")
    ?? throwErr("The centralized TV fixture must include email-health");

  if (!profile.showExactFinancialValues || variant === "financial-redacted") redactRevenue(revenue);
  if (variant === "empty" || variant === "unavailable") {
    for (const screen of screens) setNonDataState(screen, variant);
  }
  if (variant === "stale") {
    for (const screen of screens) {
      screen.sourceStatus = "stale";
      screen.observedAt = "2026-07-23T13:58:00.000Z";
      screen.insight = null;
    }
  }
  if (variant === "partial-failure") setNonDataState(email, "error");
  if (variant === "insufficient-data") {
    revenue.sourceStatus = "insufficient-data";
    revenue.insight = null;
    if (revenue.data != null) revenue.data.paymentSuccess = { applicableAttempts: 9, percent: null };
    email.sourceStatus = "insufficient-data";
    email.insight = null;
    if (email.data != null) {
      email.data.sent = 19;
      email.data.assessableSends = 19;
      email.data.delivered = 19;
      email.data.bounced = 0;
      email.data.errors = 0;
      email.data.inProgress = 0;
      email.data.statusTrend = email.data.statusTrend.map((point, index, points) => ({
        ...point,
        primary: index === points.length - 1 ? 19 : 0,
        secondary: 0,
        tertiary: 0,
      }));
      Object.assign(email.data, calculateFixtureEmailRates(19, 19, 0));
    }
  }

  const highlight = variant === "celebration-highlight"
      || variant === "celebration-takeover"
      || variant === "celebration-suspended"
      || variant === "celebration-resumed"
    ? celebrationHighlightWith({ timing: profile.interruptionTiming.celebration })
    : variant === "celebration-animation-expired"
      ? celebrationHighlightWith({ timing: profile.interruptionTiming.celebration, animationExpiresAt: "2026-07-23T14:31:00.000Z" })
      : variant === "celebration-replaced"
        ? celebrationHighlightWith({ timing: profile.interruptionTiming.celebration, event: newerUserMilestoneEvent })
        : variant === "event-long-content"
          ? celebrationHighlightWith({ timing: profile.interruptionTiming.celebration, event: longContentMilestoneEvent })
          : variant === "payment-incident-takeover"
            ? incidentHighlight(paymentDegradationEvent, "active-incident", null)
            : variant === "incident-highlight" || variant === "incident-takeover"
              ? incidentHighlight(ordinaryEmailIncidentEvent, "active-incident", null)
              : variant === "critical-highlight" || variant === "critical-takeover"
                ? incidentHighlight(emailDegradationEvent, "active-incident", null)
                : variant === "incident-recovery-highlight"
                  ? incidentHighlight({
                    ...resolvedEmailEvent,
                    id: "fixture-resolved-email-highlight",
                    presentationClass: "incident",
                  }, "resolved-incident", new Date(new Date(FIXTURE_NOW).getTime() + profile.interruptionTiming.incident.resolvedHighlightSeconds * 1000).toISOString())
                  : null;
  const takeover = variant === "celebration-takeover"
    ? presentedTakeover(userMilestoneEvent, "celebration", profile.interruptionTiming.celebration.takeoverSeconds)
    : variant === "payment-incident-takeover"
      ? presentedTakeover(paymentDegradationEvent, "incident", profile.interruptionTiming.incident.takeoverSeconds)
      : variant === "celebration-suspended" || variant === "incident-takeover"
        ? presentedTakeover(ordinaryEmailIncidentEvent, "incident", profile.interruptionTiming.incident.takeoverSeconds)
        : variant === "critical-takeover"
          ? presentedTakeover(emailDegradationEvent, "critical-incident", profile.interruptionTiming.criticalIncident.takeoverSeconds)
          : variant === "incident-recovery"
            ? presentedTakeover({
              ...resolvedEmailEvent,
              id: "fixture-resolved-email-incident",
              presentationClass: "incident",
            }, "recovery-confirmation", profile.interruptionTiming.incident.recoveryTakeoverSeconds)
            : variant === "critical-recovery"
              ? presentedTakeover(resolvedEmailEvent, "recovery-confirmation", profile.interruptionTiming.criticalIncident.recoveryTakeoverSeconds)
              : null;
  const configuredPlaylist = profile.playlist.filter((entry) => entry.enabled).map((entry) => entry.screenId);
  const playlist: TvProfileFixture["playlist"][number]["screenId"][] = variant === "partial-failure" && configuredPlaylist.includes("email-health")
    ? ["email-health", ...configuredPlaylist.filter((id) => id !== "email-health")]
    : configuredPlaylist;

  return {
    generatedAt: variant === "stale" ? "2026-07-23T13:58:00.000Z" : FIXTURE_NOW,
    staleAfter: variant === "stale" ? "2026-07-23T13:58:45.000Z" : FIXTURE_STALE_AFTER,
    connectionStatus: variant === "offline" ? "offline" : variant === "stale" ? "stale" : "online",
    project: {
      id: projectId,
      displayName: variant === "long-names"
        ? "Acme International Production Platform and Customer Identity Services"
        : "Acme Production",
    },
    profile: {
      id: profile.id,
      displayName: variant === "long-names"
        ? "Global Engineering, Revenue, Customer Success, and Operations Office Display"
        : profile.displayName,
      mode: "general",
      defaultDurationSeconds: profile.defaultDurationSeconds,
      playlist,
      screenDurations: playlist.map((screenId) => {
        const entry = profile.playlist.find((candidate) => candidate.screenId === screenId)
          ?? throwErr(`TV fixture playlist is missing "${screenId}"`);
        return {
          screenId,
          durationSeconds: entry.durationSecondsOverride ?? profile.defaultDurationSeconds,
        };
      }),
    },
    screens, presentation: { highlight, takeover },
    fatalErrorMessage: variant === "error" ? "We couldn’t prepare the latest presentation. Please try again shortly." : null,
  };
}

export function getTvFixtureSnapshot(projectId: string, profileId: string, variant: TvFixtureVariant = "default"): TvSnapshot | null {
  const profile = getTvProfileFixture(profileId);
  return profile == null ? null : createTvFixtureSnapshot(projectId, profile, variant);
}
