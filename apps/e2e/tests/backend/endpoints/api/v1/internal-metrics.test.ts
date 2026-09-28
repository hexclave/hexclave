import { deepPlainEquals } from "@hexclave/shared/dist/utils/objects";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { NiceResponse, it } from "../../../../helpers";
import { Auth, InternalApiKey, Project, Team, backendContext, createMailbox, niceBackendFetch } from "../../../backend-helpers";

type MetricsUser = {
  is_anonymous: boolean,
};

type LoginMethodMetric = {
  count: number,
};

async function uploadAnalyticsEventBatch(options: {
  sessionReplaySegmentId: string,
  batchId: string,
  sentAtMs: number,
  events: { event_type: string, event_at_ms: number, data: unknown }[],
}) {
  return await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      session_replay_segment_id: options.sessionReplaySegmentId,
      batch_id: options.batchId,
      sent_at_ms: options.sentAtMs,
      events: options.events,
    },
  });
}

async function ensureAnonymousUsersAreStillExcluded(metricsResponse: NiceResponse) {
  const baselineTotalUsers = metricsResponse.body.total_users as number;
  const baselineUsersByCountry = metricsResponse.body.users_by_country as Record<string, number>;
  const baselineRecentlyRegisteredIds = (metricsResponse.body.recently_registered as Array<{ id: string }>).map((user) => user.id);
  const baselineRecentlyActiveIds = (metricsResponse.body.recently_active as Array<{ id: string }>).map((user) => user.id);

  for (let i = 0; i < 2; i++) {
    await Auth.Anonymous.signUp();
  }

  // ClickHouse ingestion is async; poll until anonymous users are excluded again.
  let response!: NiceResponse;
  for (let i = 0; i < 30; i++) {
    await wait(2_000);
    response = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'admin' });
    const noAnonymousInRecentlyRegistered = (response.body.recently_registered as MetricsUser[]).every((user) => !user.is_anonymous);
    const noAnonymousInRecentlyActive = (response.body.recently_active as MetricsUser[]).every((user) => !user.is_anonymous);
    const currentRecentlyRegisteredIds = (response.body.recently_registered as Array<{ id: string }>).map((user) => user.id);
    const currentRecentlyActiveIds = (response.body.recently_active as Array<{ id: string }>).map((user) => user.id);
    if (
      response.body.total_users === baselineTotalUsers &&
      deepPlainEquals(response.body.users_by_country, baselineUsersByCountry) &&
      noAnonymousInRecentlyRegistered &&
      noAnonymousInRecentlyActive &&
      deepPlainEquals(currentRecentlyRegisteredIds, baselineRecentlyRegisteredIds) &&
      deepPlainEquals(currentRecentlyActiveIds, baselineRecentlyActiveIds)
    ) {
      return;
    }
  }

  expect(response.body.total_users).toBe(baselineTotalUsers);
  expect(response.body.users_by_country).toEqual(baselineUsersByCountry);
  expect((response.body.recently_registered as MetricsUser[]).every((user) => !user.is_anonymous)).toBe(true);
  expect((response.body.recently_active as MetricsUser[]).every((user) => !user.is_anonymous)).toBe(true);
  expect((response.body.recently_registered as Array<{ id: string }>).map((user) => user.id)).toEqual(baselineRecentlyRegisteredIds);
  expect((response.body.recently_active as Array<{ id: string }>).map((user) => user.id)).toEqual(baselineRecentlyActiveIds);
}

async function waitForMetricsToIncludeUsersByCountry(options: { countryCode: string, expectedCount: number }): Promise<NiceResponse> {
  let response!: NiceResponse;
  for (let i = 0; i < 30; i++) {
    response = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'admin' });
    if (response.body?.users_by_country?.[options.countryCode] === options.expectedCount) {
      return response;
    }
    await wait(2_000);
  }
  throw new Error(`Timed out waiting for users_by_country[${options.countryCode}] === ${options.expectedCount}; last response: ${JSON.stringify(response.body?.users_by_country)}`);
}

async function waitForMetricsMatch(
  includeAnonymous: boolean,
  predicate: (response: NiceResponse) => boolean,
): Promise<NiceResponse> {
  let response!: NiceResponse;
  const suffix = includeAnonymous ? "?include_anonymous=true" : "";
  for (let i = 0; i < 60; i++) {
    response = await niceBackendFetch(`/api/v1/internal/metrics${suffix}`, { accessType: 'admin' });
    if (predicate(response)) {
      return response;
    }
    await wait(1_000);
  }
  throw new Error(`Timed out waiting for metrics predicate to match (include_anonymous=${includeAnonymous}); last response body: ${JSON.stringify(response.body)}`);
}

async function waitForAnalyticsRowsForSessionReplaySegment(
  sessionReplaySegmentId: string,
  expectedCount: number,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const response = await niceBackendFetch("/api/v1/analytics/query", {
      method: "POST",
      accessType: "server",
      body: {
        query: `
          SELECT count() AS count
          FROM events
          WHERE session_replay_segment_id = {segId:String}
        `,
        params: { segId: sessionReplaySegmentId },
      },
    });
    if (response.status === 200 && Number(response.body.result?.[0]?.count ?? 0) >= expectedCount) {
      return;
    }
    await wait(500);
  }
  throw new Error(`Timed out waiting for ${expectedCount} analytics rows for session replay segment ${sessionReplaySegmentId}`);
}

it("should return metrics data", { timeout: 120_000 }, async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  await wait(3000);  // the event log is async, so let's give it some time to be written to the DB

  const response = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'admin' });
  expect(response).toMatchSnapshot(`metrics_result_no_users`);

  await ensureAnonymousUsersAreStillExcluded(response);
});

it("should return metrics data with users", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  // this test may run longer than the admin access token is valid for, so let's create API keys
  await InternalApiKey.createAndSetProjectKeys();

  const mailboxes = new Array(10).fill(null).map(() => createMailbox());

  backendContext.set({ mailbox: mailboxes[0], ipData: { country: "AQ", ipAddress: "127.0.0.1", city: "[placeholder city]", region: "NQ", latitude: 68, longitude: 30, tzIdentifier: "Europe/Zurich" } });
  await Auth.Otp.signIn();

  for (const mailbox of mailboxes) {
    backendContext.set({ mailbox, ipData: undefined });
    await Auth.Otp.signIn();
  }
  backendContext.set({ mailbox: mailboxes[8] });
  await Auth.Otp.signIn();
  const deleteResponse = await niceBackendFetch("/api/v1/users/me", {
    accessType: "server",
    method: "DELETE",
  });
  expect(deleteResponse.status).toBe(200);
  backendContext.set({ userAuth: { ...backendContext.value.userAuth, accessToken: undefined } });

  backendContext.set({ mailbox: mailboxes[1], ipData: { country: "CH", ipAddress: "127.0.0.1", city: "Zurich", region: "ZH", latitude: 47.3769, longitude: 8.5417, tzIdentifier: "Europe/Zurich" } });
  await Auth.Otp.signIn();
  backendContext.set({ mailbox: mailboxes[1], ipData: { country: "AQ", ipAddress: "127.0.0.1", city: "[placeholder city]", region: "NQ", latitude: 68, longitude: 30, tzIdentifier: "Europe/Zurich" } });
  await Auth.Otp.signIn();
  backendContext.set({ mailbox: mailboxes[2], ipData: { country: "CH", ipAddress: "127.0.0.1", city: "Zurich", region: "ZH", latitude: 47.3769, longitude: 8.5417, tzIdentifier: "Europe/Zurich" } });
  await Auth.Otp.signIn();

  const response = await waitForMetricsMatch(
    false,
    (r) =>
      r.body?.users_by_country?.["CH"] === 1 &&
      (r.body?.active_users_by_country?.["AQ"]?.length ?? 0) >= 2,
  );
  expect(response).toMatchSnapshot(`metrics_result_with_users`);

  const hourlyUsers: Array<{ activity: number }> = response.body.hourly_users;
  expect(hourlyUsers).toHaveLength(24);
  expect(hourlyUsers.reduce((sum, bucket) => sum + bucket.activity, 0)).toBe(
    response.body.total_users,
  );
  expect(hourlyUsers.slice(0, -2).every((bucket) => bucket.activity === 0)).toBe(true);

  await ensureAnonymousUsersAreStillExcluded(response);
}, {
  timeout: 240_000,
});

it("should not work for non-admins", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  await Auth.Otp.signIn();

  await wait(3000);  // the event log is async, so let's give it some time to be written to the DB

  const response = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'server' });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INSUFFICIENT_ACCESS_TYPE",
        "details": {
          "actual_access_type": "server",
          "allowed_access_types": ["admin"],
        },
        "error": "The x-hexclave-access-type header must be 'admin', but was 'server'. (The legacy x-stack-access-type header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
        <some fields may have been hidden>,
      },
    }
  `);

});

it("should exclude anonymous users from metrics", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  await InternalApiKey.createAndSetProjectKeys();

  // Create 1 regular user
  backendContext.set({ mailbox: createMailbox(), ipData: { country: "US", ipAddress: "127.0.0.1", city: "New York", region: "NY", latitude: 40.7128, longitude: -74.0060, tzIdentifier: "America/New_York" } });
  await Auth.Otp.signIn();

  // ClickHouse ingestion is async; wait until the baseline metrics includes the regular user's country.
  const beforeMetrics = await waitForMetricsToIncludeUsersByCountry({ countryCode: "US", expectedCount: 1 });

  // Create 2 anonymous users
  for (let i = 0; i < 2; i++) {
    await Auth.Anonymous.signUp();
  }

  // Poll until the core metrics (which exclude anonymous users) stabilize.
  // We can't compare the entire body because auth_overview.anonymous_users
  // will have changed.
  let result!: NiceResponse;
  for (let i = 0; i < 10; i++) {
    result = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'admin' });
    if (
      result.body.total_users === beforeMetrics.body.total_users &&
      deepPlainEquals(result.body.users_by_country, beforeMetrics.body.users_by_country) &&
      deepPlainEquals(
        (result.body.recently_registered as Array<{ id: string }>).map((u: { id: string }) => u.id),
        (beforeMetrics.body.recently_registered as Array<{ id: string }>).map((u: { id: string }) => u.id),
      )
    ) {
      break;
    }
    await wait(2_000);
  }

  // Verify that total_users only counts the 1 regular user, not the anonymous ones
  expect(result.body.total_users).toBe(1);

  // Verify anonymous users don't appear in recently_registered
  expect(result.body.recently_registered.length).toBe(1);
  expect(result.body.recently_registered.every((user: MetricsUser) => !user.is_anonymous)).toBe(true);

  // Verify anonymous users don't appear in recently_active
  expect(result.body.recently_active.every((user: MetricsUser) => !user.is_anonymous)).toBe(true);

  // Verify anonymous users aren't counted in daily_users
  const lastDayUsers = result.body.daily_users[result.body.daily_users.length - 1];
  expect(lastDayUsers.activity).toBe(1);

  // Verify users_by_country only includes regular users
  expect(result.body.users_by_country["US"]).toBe(1);

  await ensureAnonymousUsersAreStillExcluded(result);
}, {
  timeout: 120_000,
});

it("should handle anonymous users with activity correctly", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  await InternalApiKey.createAndSetProjectKeys();

  // Create 1 regular user with activity
  const regularMailbox = createMailbox();
  backendContext.set({ mailbox: regularMailbox, ipData: { country: "CA", ipAddress: "127.0.0.1", city: "Toronto", region: "ON", latitude: 43.6532, longitude: -79.3832, tzIdentifier: "America/Toronto" } });
  await Auth.Otp.signIn();

  // Generate some activity for regular user
  await niceBackendFetch("/api/v1/users/me", { accessType: 'client' });

  // Create 3 anonymous users with activity
  for (let i = 0; i < 3; i++) {
    await Auth.Anonymous.signUp();
  }

  const response = await waitForMetricsMatch(false, (r) => {
    if (r.body?.total_users !== 1) return false;
    const dau = r.body?.daily_active_users?.[r.body.daily_active_users.length - 1];
    return dau?.activity === 1 && r.body?.users_by_country?.["CA"] === 1;
  });

  // Should only count 1 regular user
  expect(response.body.total_users).toBe(1);

  // Daily active users should only count regular users
  const todayDAU = response.body.daily_active_users[response.body.daily_active_users.length - 1];
  expect(todayDAU.activity).toBe(1);

  // Users by country should only count regular users
  expect(response.body.users_by_country["CA"]).toBe(1);
  expect(response.body.users_by_country["US"]).toBeUndefined();

  await ensureAnonymousUsersAreStillExcluded(response);
}, {
  timeout: 120_000,
});

it("should expose lightweight user counts without loading the full metrics route", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  await InternalApiKey.createAndSetProjectKeys();

  backendContext.set({ mailbox: createMailbox() });
  await Auth.Otp.signIn();
  await Auth.Anonymous.signUp();
  await Auth.Anonymous.signUp();

  const response = await niceBackendFetch("/api/v1/internal/metrics/user-counts", { accessType: 'admin' });

  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "anonymous_users": 2,
        "total_users": 3,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should handle mixed auth methods excluding anonymous users", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
      credential_enabled: true,
    }
  });

  await InternalApiKey.createAndSetProjectKeys();

  // Create users with different auth methods
  const regularMailbox = createMailbox();

  // Regular user with OTP
  backendContext.set({ mailbox: regularMailbox });
  await Auth.Otp.signIn();

  // Regular user with password
  const passwordMailbox = createMailbox();
  backendContext.set({ mailbox: passwordMailbox });
  await Auth.Password.signUpWithEmail({ password: "test1234" });

  // Anonymous users (should not be counted)
  for (let i = 0; i < 5; i++) {
    await Auth.Anonymous.signUp();
  }

  await wait(3000);

  const response = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'admin' });

  // Should only count 2 regular users
  expect(response.body.total_users).toBe(2);

  // Login methods should only count regular users' methods
  const loginMethods = response.body.login_methods;
  const totalMethodCount = loginMethods.reduce((sum: number, method: LoginMethodMetric) => sum + method.count, 0);
  expect(totalMethodCount).toBe(2); // 1 OTP + 1 password, no anonymous

  await ensureAnonymousUsersAreStillExcluded(response);
}, {
  timeout: 120_000,
});

it("should return cross-product aggregates in the metrics response", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });

  await wait(2000);

  const response = await niceBackendFetch("/api/v1/internal/metrics", { accessType: 'admin' });
  expect(response.status).toBe(200);

  // Core auth fields must always be present
  expect(response.body).toHaveProperty('total_users');
  expect(response.body).toHaveProperty('daily_users');
  expect(response.body).toHaveProperty('daily_active_users');
  expect(response.body).toHaveProperty('login_methods');

  // Extended aggregate groups must always be present (even for sparse projects)
  expect(response.body).toHaveProperty('auth_overview');
  expect(response.body).toHaveProperty('payments_overview');
  expect(response.body).toHaveProperty('email_overview');
  expect(response.body).toHaveProperty('analytics_overview');

  // Auth overview shape
  const authOverview = response.body.auth_overview;
  expect(typeof authOverview.verified_users).toBe('number');
  expect(typeof authOverview.unverified_users).toBe('number');
  expect(typeof authOverview.anonymous_users).toBe('number');
  expect(typeof authOverview.total_teams).toBe('number');
  // MAU field introduced for analytics chart widget
  expect(typeof authOverview.mau).toBe('number');

  // Payments overview shape
  const paymentsOverview = response.body.payments_overview;
  expect(typeof paymentsOverview.subscriptions_by_status).toBe('object');
  expect(typeof paymentsOverview.active_subscription_count).toBe('number');
  expect(typeof paymentsOverview.total_one_time_purchases).toBe('number');
  expect(Array.isArray(paymentsOverview.daily_subscriptions)).toBe(true);

  // Email overview shape
  const emailOverview = response.body.email_overview;
  expect(typeof emailOverview.emails_by_status).toBe('object');
  expect(typeof emailOverview.total_emails).toBe('number');
  expect(Array.isArray(emailOverview.daily_emails)).toBe(true);

  // Analytics overview shape (may have empty arrays for sparse projects)
  const analyticsOverview = response.body.analytics_overview;
  expect(Array.isArray(analyticsOverview.daily_page_views)).toBe(true);
  expect(Array.isArray(analyticsOverview.daily_clicks)).toBe(true);
  expect(typeof analyticsOverview.total_replays).toBe('number');
  expect(typeof analyticsOverview.recent_replays).toBe('number');
  // Fields used by visitors/revenue hover charts
  expect(Array.isArray(analyticsOverview.daily_visitors)).toBe(true);
  expect(Array.isArray(analyticsOverview.daily_revenue)).toBe(true);
  expect(typeof analyticsOverview.visitors).toBe('number');
  expect(Array.isArray(analyticsOverview.top_referrers)).toBe(true);
});

it("should return correct auth_overview breakdown including teams", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });
  await Team.create();

  await InternalApiKey.createAndSetProjectKeys();

  // Create a verified user
  const verifiedMailbox = createMailbox();
  backendContext.set({ mailbox: verifiedMailbox });
  await Auth.Otp.signIn();

  // Create an anonymous user
  await Auth.Anonymous.signUp();

  const response = await waitForMetricsMatch(false, (r) => {
    const authOverview = r.body?.auth_overview;
    if (authOverview == null) return false;
    const nonAnonFromOverview = authOverview.verified_users + authOverview.unverified_users;
    return authOverview.anonymous_users >= 1 && nonAnonFromOverview >= 1 && authOverview.total_teams >= 1;
  });

  const authOverview = response.body.auth_overview;

  // Total = 1 regular (verified by OTP/magic-link) + 1 anonymous
  // anonymous_users count should be 1
  expect(authOverview.anonymous_users).toBeGreaterThanOrEqual(1);

  // verified + unverified should match non-anonymous total
  const nonAnonFromOverview = authOverview.verified_users + authOverview.unverified_users;
  expect(nonAnonFromOverview).toBeGreaterThanOrEqual(1);
  expect(authOverview.total_teams).toBeGreaterThanOrEqual(1);
});

it("should count top referrers by unique visitors and exclude anonymous analytics by default", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });
  await Project.updateConfig({
    "apps.installed.analytics": { enabled: true },
  });

  await InternalApiKey.createAndSetProjectKeys();

  backendContext.set({
    mailbox: createMailbox(),
    ipData: {
      country: "US",
      ipAddress: "127.0.0.11",
      city: "New York",
      region: "NY",
      latitude: 40.7128,
      longitude: -74.0060,
      tzIdentifier: "America/New_York",
    },
  });
  await Auth.Otp.signIn();

  const regularSessionReplaySegmentId = randomUUID();
  const regularNow = Date.now();
  const regularReferrer = "https://regular.example/source";
  const regularBatchResponse = await uploadAnalyticsEventBatch({
    sessionReplaySegmentId: regularSessionReplaySegmentId,
    batchId: randomUUID(),
    sentAtMs: regularNow,
    events: [
      {
        event_type: "$page-view",
        event_at_ms: regularNow - 200,
        data: {
          url: "https://stack-auth.example/regular-1",
          path: "/regular-1",
          referrer: regularReferrer,
          title: "Regular Page 1",
          entry_type: "initial",
          viewport_width: 1920,
          viewport_height: 1080,
          screen_width: 1920,
          screen_height: 1080,
        },
      },
      {
        event_type: "$page-view",
        event_at_ms: regularNow - 100,
        data: {
          url: "https://stack-auth.example/regular-2",
          path: "/regular-2",
          referrer: regularReferrer,
          title: "Regular Page 2",
          entry_type: "push",
          viewport_width: 1920,
          viewport_height: 1080,
          screen_width: 1920,
          screen_height: 1080,
        },
      },
    ],
  });
  expect(regularBatchResponse.status).toBe(200);
  await waitForAnalyticsRowsForSessionReplaySegment(regularSessionReplaySegmentId, 2);

  backendContext.set({
    ipData: {
      country: "CA",
      ipAddress: "127.0.0.12",
      city: "Toronto",
      region: "ON",
      latitude: 43.6532,
      longitude: -79.3832,
      tzIdentifier: "America/Toronto",
    },
  });
  await Auth.Anonymous.signUp();

  const anonymousSessionReplaySegmentId = randomUUID();
  const anonymousNow = Date.now();
  const anonymousReferrer = "https://anonymous.example/source";
  const anonymousBatchResponse = await uploadAnalyticsEventBatch({
    sessionReplaySegmentId: anonymousSessionReplaySegmentId,
    batchId: randomUUID(),
    sentAtMs: anonymousNow,
    events: [
      {
        event_type: "$page-view",
        event_at_ms: anonymousNow - 100,
        data: {
          url: "https://stack-auth.example/anonymous-1",
          path: "/anonymous-1",
          referrer: anonymousReferrer,
          title: "Anonymous Page 1",
          entry_type: "initial",
          viewport_width: 1920,
          viewport_height: 1080,
          screen_width: 1920,
          screen_height: 1080,
        },
      },
    ],
  });
  expect(anonymousBatchResponse.status).toBe(200);
  await waitForAnalyticsRowsForSessionReplaySegment(anonymousSessionReplaySegmentId, 1);

  const metricsWithoutAnonymous = await waitForMetricsMatch(false, (response) => {
    const topReferrers = response.body.analytics_overview.top_referrers as Array<{ referrer: string, visitors: number }>;
    return response.body.analytics_overview.online_live === 1
      && topReferrers.some((item) => item.referrer === regularReferrer && item.visitors === 1)
      && !topReferrers.some((item) => item.referrer === anonymousReferrer);
  });
  const topReferrersWithoutAnonymous = metricsWithoutAnonymous.body.analytics_overview.top_referrers as Array<{ referrer: string, visitors: number }>;
  expect(topReferrersWithoutAnonymous).toContainEqual({ referrer: regularReferrer, visitors: 1 });
  expect(topReferrersWithoutAnonymous.some((item) => item.referrer === anonymousReferrer)).toBe(false);
  expect(metricsWithoutAnonymous.body.analytics_overview.online_live).toBe(1);

  const metricsWithAnonymous = await waitForMetricsMatch(true, (response) => {
    const topReferrers = response.body.analytics_overview.top_referrers as Array<{ referrer: string, visitors: number }>;
    return response.body.analytics_overview.online_live === 2
      && topReferrers.some((item) => item.referrer === regularReferrer && item.visitors === 1)
      && topReferrers.some((item) => item.referrer === anonymousReferrer && item.visitors === 1);
  });
  const topReferrersWithAnonymous = metricsWithAnonymous.body.analytics_overview.top_referrers as Array<{ referrer: string, visitors: number }>;
  expect(topReferrersWithAnonymous).toContainEqual({ referrer: regularReferrer, visitors: 1 });
  expect(topReferrersWithAnonymous).toContainEqual({ referrer: anonymousReferrer, visitors: 1 });
  expect(metricsWithAnonymous.body.analytics_overview.online_live).toBe(2);
}, {
  timeout: 120_000,
});
