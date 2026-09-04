import type {
  TvInterruptionPreferences,
  TvScreenId,
} from "@hexclave/shared/dist/interface/admin-tv-mode";

export {
  TV_SCREEN_IDS,
  TV_SNAPSHOT_POLL_INTERVAL_MS,
  TV_SNAPSHOT_STALE_AFTER_MS,
  TvSnapshotSchema,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
export type {
  TvAudienceMomentumScreen,
  TvEmailHealthScreen,
  TvEvent,
  TvLivePulseScreen,
  TvPresentedEventHighlight,
  TvPresentedTakeover,
  TvProfileSnapshot,
  TvReportingWindow,
  TvRevenuePaymentsScreen,
  TvScreenId,
  TvScreenSnapshot,
  TvSnapshot,
  TvSourceStatus,
  TvStackedTrendPoint,
  TvStatusFact,
  TvTrendPoint,
} from "@hexclave/shared/dist/interface/admin-tv-mode";

function defineTvFixtureVariants<const TVariants extends readonly string[]>(variants: TVariants): TVariants {
  return variants;
}

export const TV_FIXTURE_VARIANTS = defineTvFixtureVariants([
  "default",
  "celebration-highlight",
  "celebration-takeover",
  "celebration-suspended",
  "celebration-resumed",
  "celebration-animation-expired",
  "celebration-highlight-expired",
  "celebration-replaced",
  "event-long-content",
  "incident-highlight",
  "critical-highlight",
  "payment-incident-takeover",
  "incident-takeover",
  "critical-takeover",
  "incident-recovery",
  "incident-recovery-highlight",
  "critical-recovery",
  "stale",
  "offline",
  "loading",
  "empty",
  "insufficient-data",
  "unavailable",
  "partial-failure",
  "financial-redacted",
  "long-names",
  "error",
]);
export type TvFixtureVariant = typeof TV_FIXTURE_VARIANTS[number];

export type TvConnectionStatus = "online" | "stale" | "offline";
export type TvProfileFixture = {
  id: string,
  displayName: string,
  description: string,
  mode: "general",
  defaultDurationSeconds: number,
  playlist: Array<{
    screenId: TvScreenId,
    enabled: boolean,
    durationSecondsOverride: number | null,
  }>,
  incidentTypes: {
    emailDeliveryDegradation: boolean,
    subscriptionCollectionDegradation: boolean,
  },
  celebrations: {
    userMilestone: boolean,
    revenueMilestone: boolean,
  },
  interruptionTiming: TvInterruptionPreferences["timing"],
  showExactFinancialValues: boolean,
};
