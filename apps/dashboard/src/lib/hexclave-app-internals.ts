import {
  MetricsResponseBodySchema,
  type MetricsResponse,
  MetricsUserCountsSchema,
  type MetricsUserCounts,
  type UserActivityResponse,
} from "@hexclave/shared/dist/interface/admin-metrics";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import type { StackAdminApp, StackClientApp } from "@hexclave/next";

export const hexclaveAppInternalsSymbol = Symbol.for("StackAuth--DO-NOT-USE-OR-YOU-WILL-BE-FIRED--StackAppInternals");

type DashboardApp = StackClientApp | StackAdminApp;

// Re-export the metrics response type tree from the shared package so dashboard
// code can read these types without having to know where the schemas live.
export type {
  MetricsActivitySplit,
  MetricsAnalyticsOverview,
  MetricsAuthOverview,
  MetricsDailyEmailStatusBreakdown,
  MetricsDailyRevenuePoint,
  MetricsDataPoint,
  MetricsEmailOverview,
  MetricsLoginMethodEntry,
  MetricsNamedCount,
  MetricsPaymentsOverview,
  MetricsRecentEmail,
  MetricsResponse,
  MetricsTopCountry,
  MetricsTopReferrer,
  MetricsTopRegion,
  MetricsUserCounts,
  UserActivityResponse,
} from "@hexclave/shared/dist/interface/admin-metrics";

/**
 * Pulls the typed `useMetrics` hook out of the admin app via the internals
 * symbol. Throws as a programming error if the symbol is missing or malformed
 * — this should never happen at runtime in a correctly-built admin app.
 *
 * Returns the typed `MetricsResponse` shape derived from the same yup schemas
 * the backend route uses, so dashboard call sites do not need `as ...` casts.
 */
export type AnalyticsOverviewFilters = {
  country_code?: string,
  referrer?: string,
  browser?: string,
  os?: string,
  device?: string,
  // ISO 8601 datetimes bounding the analytics top-N breakdowns server-side
  // (top referrers / regions / browsers / OS / devices). The daily and hourly
  // series stay full-window so previous-period deltas can be computed locally.
  since?: string,
  until?: string,
};

// The typed contract for the hooks the admin app exposes through the internals
// symbol. The single `as` assertion in `getInternalsHookOrThrow` is the one
// place the untyped internals object is narrowed to this contract — call sites
// get inferred return types instead of casting each result.
type AdminAppInternalsHooks = {
  useMetrics: (includeAnonymous: boolean, filters?: AnalyticsOverviewFilters) => MetricsResponse,
  useUserActivity: (userId: string) => UserActivityResponse,
  useMetricsUserCounts: () => MetricsUserCounts,
  sendRequest: (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>,
};

function getInternalsHookOrThrow<K extends keyof AdminAppInternalsHooks>(adminApp: DashboardApp, hookName: K): AdminAppInternalsHooks[K] {
  const internals = adminApp[hexclaveAppInternalsSymbol];
  if (typeof internals !== "object" || internals == null || !(hookName in internals)) {
    throw new HexclaveAssertionError(`Admin app internals are unavailable: missing ${hookName}`);
  }

  const hook = (internals as Record<string, unknown>)[hookName];
  if (typeof hook !== "function") {
    throw new HexclaveAssertionError(`Admin app internals are unavailable: ${hookName} is not callable`);
  }

  return hook as AdminAppInternalsHooks[K];
}

export function useMetricsOrThrow(
  adminApp: DashboardApp,
  includeAnonymous: boolean,
  filters?: AnalyticsOverviewFilters,
): MetricsResponse {
  return getInternalsHookOrThrow(adminApp, "useMetrics")(includeAnonymous, filters);
}

/**
 * Pulls the typed `useUserActivity` hook out of the admin app via the internals
 * symbol. Returns the daily event counts for a single user (backed by
 * `GET /internal/user-activity`) in the same `{ date, activity }` shape the
 * metrics endpoints use.
 */
export function useUserActivityOrThrow(adminApp: DashboardApp, userId: string): UserActivityResponse {
  return getInternalsHookOrThrow(adminApp, "useUserActivity")(userId);
}

export function useMetricsUserCountsOrThrow(adminApp: DashboardApp): MetricsUserCounts {
  return getInternalsHookOrThrow(adminApp, "useMetricsUserCounts")();
}

function getMetricsQueryString(includeAnonymous: boolean, filters?: AnalyticsOverviewFilters): string {
  const params = new URLSearchParams();
  if (includeAnonymous) {
    params.append("include_anonymous", "true");
  }
  if (filters?.country_code) params.append("filter_country_code", filters.country_code);
  if (filters?.referrer) params.append("filter_referrer", filters.referrer);
  if (filters?.browser) params.append("filter_browser", filters.browser);
  if (filters?.os) params.append("filter_os", filters.os);
  if (filters?.device) params.append("filter_device", filters.device);
  if (filters?.since) params.append("filter_since", filters.since);
  if (filters?.until) params.append("filter_until", filters.until);
  return params.toString();
}

function applyMetricsResponseDefaults(body: MetricsResponse): MetricsResponse {
  // Keep this in sync with HexclaveAdminInterface.getMetrics(). These defaults
  // preserve one-release-cycle tolerance for dashboards talking to older servers.
  const rawBody: Partial<MetricsResponse> = body;
  const rawAnalytics: Partial<MetricsResponse["analytics_overview"]> = body.analytics_overview;
  return {
    ...body,
    live_users: rawBody.live_users ?? 0,
    hourly_users: rawBody.hourly_users ?? [],
    hourly_active_users: rawBody.hourly_active_users ?? [],
    analytics_overview: {
      ...body.analytics_overview,
      hourly_page_views: rawAnalytics.hourly_page_views ?? [],
      hourly_active_users: rawAnalytics.hourly_active_users ?? [],
      hourly_visitors: rawAnalytics.hourly_visitors ?? [],
      daily_anonymous_visitors_fallback: rawAnalytics.daily_anonymous_visitors_fallback ?? [],
      anonymous_visitors_fallback: rawAnalytics.anonymous_visitors_fallback ?? 0,
      top_regions: rawAnalytics.top_regions ?? [],
      bounce_rate: rawAnalytics.bounce_rate ?? 0,
      daily_bounce_rate: rawAnalytics.daily_bounce_rate ?? [],
      daily_avg_session_seconds: rawAnalytics.daily_avg_session_seconds ?? [],
      top_browsers: rawAnalytics.top_browsers ?? [],
      top_operating_systems: rawAnalytics.top_operating_systems ?? [],
      top_devices: rawAnalytics.top_devices ?? [],
    },
  };
}

async function fetchJsonOrThrow(adminApp: DashboardApp, path: string): Promise<Json> {
  const response = await getInternalsHookOrThrow(adminApp, "sendRequest")(path, { method: "GET" }, "admin");
  if (!response.ok) {
    throw new HexclaveAssertionError(`Admin app internals request failed: ${path}`);
  }
  return await response.json();
}

/**
 * Sends an authenticated user request through the dashboard app's existing
 * request plumbing. Internal feature pages use this instead of rebuilding
 * client authentication headers in dashboard code.
 */
export async function sendInternalUserRequest(adminApp: DashboardApp, path: string, requestOptions: RequestInit = {}): Promise<Response> {
  return await getInternalsHookOrThrow(adminApp, "sendRequest")(path, requestOptions, "client");
}

/**
 * Sends a project-admin request through the dashboard app's request plumbing.
 * Use this for internal routes that return or mutate project-owner-only data.
 */
export async function sendInternalAdminRequest(adminApp: DashboardApp, path: string, requestOptions: RequestInit = {}): Promise<Response> {
  return await getInternalsHookOrThrow(adminApp, "sendRequest")(path, requestOptions, "admin");
}

export async function fetchMetricsOrThrow(
  adminApp: DashboardApp,
  includeAnonymous: boolean,
  filters?: AnalyticsOverviewFilters,
): Promise<MetricsResponse> {
  const queryString = getMetricsQueryString(includeAnonymous, filters);
  const path = `/internal/metrics${queryString ? `?${queryString}` : ""}`;
  return applyMetricsResponseDefaults(await MetricsResponseBodySchema.validate(await fetchJsonOrThrow(adminApp, path)));
}

export async function fetchMetricsUserCountsOrThrow(adminApp: DashboardApp): Promise<MetricsUserCounts> {
  return await MetricsUserCountsSchema.validate(await fetchJsonOrThrow(adminApp, "/internal/metrics/user-counts"));
}
