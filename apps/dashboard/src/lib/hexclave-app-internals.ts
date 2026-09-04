import {
  MetricsResponseBodySchema,
  type MetricsResponse,
  MetricsUserCountsSchema,
  type MetricsUserCounts,
  type UserActivityResponse,
} from "@hexclave/shared/dist/interface/admin-metrics";
import {
  TvBuiltInProfileResourceSchema,
  TvProfileConfigurationSchema,
  TvProfileResourceSchema,
  TvSavedProfileResourceSchema,
  TvSnapshotSchema,
  TvDisplayResourceSchema,
  type TvProfileConfiguration,
  type TvProfileResource,
  type TvSavedProfileResource,
  type TvSnapshot,
  type TvDisplayResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { yupArray, yupBoolean, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { InferType } from "yup";

export const hexclaveAppInternalsSymbol = Symbol.for("StackAuth--DO-NOT-USE-OR-YOU-WILL-BE-FIRED--StackAppInternals");

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

function getInternalsHookOrThrow<K extends keyof AdminAppInternalsHooks>(adminApp: object, hookName: K): AdminAppInternalsHooks[K] {
  const internals = Reflect.get(adminApp, hexclaveAppInternalsSymbol);
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
  adminApp: object,
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
export function useUserActivityOrThrow(adminApp: object, userId: string): UserActivityResponse {
  return getInternalsHookOrThrow(adminApp, "useUserActivity")(userId);
}

export function useMetricsUserCountsOrThrow(adminApp: object): MetricsUserCounts {
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

async function requestJsonOrThrow(
  adminApp: object,
  path: string,
  requestOptions: RequestInit,
): Promise<unknown> {
  const response = await getInternalsHookOrThrow(adminApp, "sendRequest")(path, requestOptions, "admin");
  if (!response.ok) {
    throw new HexclaveAssertionError(`Admin app internals request failed: ${path}`);
  }
  return await response.json();
}

async function fetchJsonOrThrow(adminApp: object, path: string, headers?: HeadersInit): Promise<unknown> {
  return await requestJsonOrThrow(adminApp, path, { method: "GET", headers });
}

/**
 * Sends an authenticated user request through the dashboard app's existing
 * request plumbing. Internal feature pages use this instead of rebuilding
 * client authentication headers in dashboard code.
 */
export async function sendInternalUserRequest(adminApp: object, path: string, requestOptions: RequestInit = {}): Promise<Response> {
  return await getInternalsHookOrThrow(adminApp, "sendRequest")(path, requestOptions, "client");
}

/**
 * Sends a project-admin request through the dashboard app's request plumbing.
 * Use this for internal routes that return or mutate project-owner-only data.
 */
export async function sendInternalAdminRequest(adminApp: object, path: string, requestOptions: RequestInit = {}): Promise<Response> {
  return await getInternalsHookOrThrow(adminApp, "sendRequest")(path, requestOptions, "admin");
}

export async function fetchMetricsOrThrow(
  adminApp: object,
  includeAnonymous: boolean,
  filters?: AnalyticsOverviewFilters,
): Promise<MetricsResponse> {
  const queryString = getMetricsQueryString(includeAnonymous, filters);
  const path = `/internal/metrics${queryString ? `?${queryString}` : ""}`;
  return applyMetricsResponseDefaults(await MetricsResponseBodySchema.validate(await fetchJsonOrThrow(adminApp, path)));
}

export async function fetchMetricsUserCountsOrThrow(adminApp: object): Promise<MetricsUserCounts> {
  return await MetricsUserCountsSchema.validate(await fetchJsonOrThrow(adminApp, "/internal/metrics/user-counts"));
}

export function getTvSnapshotPath(profileId: string): string {
  return `/internal/tv-mode/profiles/${encodeURIComponent(profileId)}/snapshot`;
}

export class TvSnapshotRequestError extends Error {
  override name = "TvSnapshotRequestError";

  constructor(readonly status: number) {
    super(`TV snapshot request failed with status ${status}.`);
  }
}

export async function fetchTvSnapshotOrThrow(
  adminApp: object,
  profileId: string,
  signal?: AbortSignal,
): Promise<TvSnapshot> {
  const response = await sendInternalAdminRequest(adminApp, getTvSnapshotPath(profileId), {
    method: "GET",
    headers: { "x-hexclave-tv-snapshot-contract": "2" },
    signal,
  });
  if (!response.ok) throw new TvSnapshotRequestError(response.status);
  return await TvSnapshotSchema.validate(await response.json(), {
    strict: true,
  });
}

const TvProfileListResponseSchema = yupObject({
  persistenceReady: yupBoolean().defined(),
  effectiveDefaultProfileId: yupString().defined(),
  savedProfiles: yupArray(TvSavedProfileResourceSchema).defined(),
  templates: yupArray(TvBuiltInProfileResourceSchema).defined(),
}).noUnknown().defined();

const TvProfileResponseSchema = yupObject({
  profile: TvProfileResourceSchema,
}).noUnknown().defined();

const TvSavedProfileResponseSchema = yupObject({
  profile: TvSavedProfileResourceSchema,
}).noUnknown().defined();

export type TvProfileListResponse = InferType<typeof TvProfileListResponseSchema>;

export class TvProfileRequestError extends Error {
  override name = "TvProfileRequestError";

  constructor(readonly status: number) {
    super(`TV profile request failed with status ${status}.`);
  }
}

function getTvProfilePath(profileId?: string): string {
  return profileId == null
    ? "/internal/tv-mode/profiles"
    : `/internal/tv-mode/profiles/${encodeURIComponent(profileId)}`;
}

function jsonRequest(method: "POST" | "PATCH" | "DELETE", body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function requestTvProfileJsonOrThrow(
  adminApp: object,
  path: string,
  requestOptions: RequestInit,
): Promise<unknown> {
  const response = await getInternalsHookOrThrow(adminApp, "sendRequest")(path, requestOptions, "admin");
  if (!response.ok) throw new TvProfileRequestError(response.status);
  return await response.json();
}

export async function fetchTvProfilesOrThrow(adminApp: object): Promise<TvProfileListResponse> {
  return await TvProfileListResponseSchema.validate(
    await requestTvProfileJsonOrThrow(adminApp, getTvProfilePath(), { method: "GET" }),
    { strict: true },
  );
}

export async function fetchTvProfileOrThrow(adminApp: object, profileId: string): Promise<TvProfileResource> {
  const response = await TvProfileResponseSchema.validate(
    await requestTvProfileJsonOrThrow(adminApp, getTvProfilePath(profileId), { method: "GET" }),
    { strict: true },
  );
  return response.profile;
}

const TvDisplayListResponseSchema = yupObject({
  displays: yupArray(TvDisplayResourceSchema).defined(),
}).noUnknown().defined();

const TvDisplayApprovalResponseSchema = yupObject({
  success: yupBoolean().oneOf([true]).defined(),
  approvedAt: yupString().defined(),
  expiresAt: yupString().defined(),
}).noUnknown().defined();

export async function fetchTvDisplaysOrThrow(adminApp: object): Promise<TvDisplayResource[]> {
  const response = await requestTvProfileJsonOrThrow(adminApp, "/internal/tv-mode/displays", { method: "GET" });
  return (await TvDisplayListResponseSchema.validate(response, { strict: true })).displays;
}

export async function approveTvDisplayOrThrow(adminApp: object, input: {
  pairingCode: string,
  profileId: string,
  displayName: string,
  acknowledgeExactFinancials: boolean,
}): Promise<{ approvedAt: string, expiresAt: string }> {
  const response = await TvDisplayApprovalResponseSchema.validate(
    await requestTvProfileJsonOrThrow(adminApp, "/internal/tv-mode/displays", jsonRequest("POST", input)),
    { strict: true },
  );
  return { approvedAt: response.approvedAt, expiresAt: response.expiresAt };
}

export async function updateTvDisplayOrThrow(adminApp: object, displayId: string, input: {
  profileId: string,
  displayName: string,
  acknowledgeExactFinancials: boolean,
}): Promise<void> {
  await requestTvProfileJsonOrThrow(
    adminApp,
    `/internal/tv-mode/displays/${encodeURIComponent(displayId)}`,
    jsonRequest("PATCH", input),
  );
}

export async function unpairTvDisplayOrThrow(adminApp: object, displayId: string): Promise<void> {
  await requestTvProfileJsonOrThrow(
    adminApp,
    `/internal/tv-mode/displays/${encodeURIComponent(displayId)}`,
    { method: "DELETE" },
  );
}

export async function createTvProfileOrThrow(
  adminApp: object,
  configuration: TvProfileConfiguration,
): Promise<TvSavedProfileResource> {
  const validated = await TvProfileConfigurationSchema.validate(configuration, { strict: true });
  const response = await TvSavedProfileResponseSchema.validate(await requestTvProfileJsonOrThrow(
    adminApp,
    getTvProfilePath(),
    jsonRequest("POST", { configuration: validated }),
  ), { strict: true });
  return response.profile;
}

export async function updateTvProfileOrThrow(
  adminApp: object,
  profileId: string,
  expectedVersion: number,
  configuration: TvProfileConfiguration,
): Promise<TvSavedProfileResource> {
  const validated = await TvProfileConfigurationSchema.validate(configuration, { strict: true });
  const response = await TvSavedProfileResponseSchema.validate(await requestTvProfileJsonOrThrow(
    adminApp,
    getTvProfilePath(profileId),
    jsonRequest("PATCH", { expectedVersion, configuration: validated }),
  ), { strict: true });
  return response.profile;
}

export async function duplicateTvProfileOrThrow(
  adminApp: object,
  source: TvProfileResource,
  displayName: string,
): Promise<TvSavedProfileResource> {
  const response = await TvSavedProfileResponseSchema.validate(await requestTvProfileJsonOrThrow(
    adminApp,
    `${getTvProfilePath(source.id)}/duplicate`,
    jsonRequest("POST", {
      displayName,
      expectedSourceVersion: source.version,
    }),
  ), { strict: true });
  return response.profile;
}

export async function deleteTvProfileOrThrow(
  adminApp: object,
  profile: TvSavedProfileResource,
): Promise<void> {
  await requestTvProfileJsonOrThrow(
    adminApp,
    getTvProfilePath(profile.id),
    jsonRequest("DELETE", { expectedVersion: profile.version }),
  );
}
