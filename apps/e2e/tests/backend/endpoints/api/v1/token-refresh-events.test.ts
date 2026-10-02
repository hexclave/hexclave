import { generateW3cSpanId, generateW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Auth, InternalApiKey, Project, backendContext, niceBackendFetch } from "../../../backend-helpers";

type AnalyticsEvent = {
  event_type: string,
  project_id: string,
  branch_id: string,
  user_id: string,
  team_id: string,
  refresh_token_id: string,
  event_at: string,
};

/**
 * Query events from ClickHouse with the specified filters.
 */
const queryEvents = async (params: {
  userId?: string,
  eventType?: string,
}) => await niceBackendFetch("/api/v1/analytics/query", {
  method: "POST",
  accessType: "server",
  body: {
    query: `
      SELECT event_type, project_id, branch_id, user_id, team_id, refresh_token_id, event_at
      FROM events
      WHERE 1
        ${params.userId ? "AND user_id = {user_id:Nullable(String)}" : ""}
        ${params.eventType ? "AND event_type = {event_type:String}" : ""}
      ORDER BY event_at DESC
      LIMIT 100
    `,
    params: {
      ...(params.userId ? { user_id: params.userId } : {}),
      ...(params.eventType ? { event_type: params.eventType } : {}),
    },
  },
});

/**
 * Fetch events with retry, waiting for at least the expected count of events to appear.
 */
const fetchEventsWithRetry = async (
  params: { userId?: string, eventType?: string },
  options: { attempts?: number, delayMs?: number, expectedCount?: number, timeoutMs?: number } = {}
) => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const delayMs = options.delayMs ?? 500;
  const expectedCount = options.expectedCount ?? 1;
  const startedAt = performance.now();

  let response = await queryEvents(params);
  while (performance.now() - startedAt < timeoutMs) {
    if (response.status !== 200) {
      break;
    }
    const results = Array.isArray(response.body?.result) ? response.body.result : [];
    if (results.length >= expectedCount) {
      break;
    }
    await wait(delayMs);
    response = await queryEvents(params);
  }

  return response;
};

const queryTraceSpans = async (traceId: string) => await niceBackendFetch("/api/v1/analytics/query", {
  method: "POST",
  accessType: "server",
  body: {
    query: `
      SELECT trace_id, span_id, parent_span_id, span_type, refresh_token_id, user_id
      FROM spans
      WHERE trace_id = {trace_id:String}
      ORDER BY started_at ASC
    `,
    params: { trace_id: traceId },
  },
});

const fetchTraceSpansWithRetry = async (traceId: string) => {
  const startedAt = performance.now();
  let response = await queryTraceSpans(traceId);
  while (
    performance.now() - startedAt < 30_000
    && response.status === 200
    && (!Array.isArray(response.body?.result) || response.body.result.length === 0)
  ) {
    await wait(500);
    response = await queryTraceSpans(traceId);
  }
  return response;
};

/**
 * Wait for exactly the expected number of events to appear, then verify.
 * We wait a bit longer after reaching the expected count to ensure no additional events appear.
 */
const expectExactlyNTokenRefreshEvents = async (
  userId: string,
  expectedCount: number,
  options: { projectId?: string } = {}
) => {
  // First, wait for events to appear
  const response = await fetchEventsWithRetry(
    { userId, eventType: "$token-refresh" },
    { expectedCount }
  );

  if (response.status !== 200) {
    throw new Error(`Failed to query events: ${response.status}`);
  }

  // Wait a bit more to catch any delayed duplicate events
  await wait(1000);

  // Query again to get the final count
  const finalResponse = await queryEvents({ userId, eventType: "$token-refresh" });
  const results = Array.isArray(finalResponse.body?.result) ? finalResponse.body.result : [];

  if (results.length !== expectedCount) {
    throw new Error(
      `Expected exactly ${expectedCount} $token-refresh event(s) for user ${userId}, ` +
      `but found ${results.length}. Events: ${JSON.stringify(results, null, 2)}`
    );
  }

  // Verify project_id if provided
  if (options.projectId) {
    for (const event of results) {
      if (event.project_id !== options.projectId) {
        throw new Error(
          `Event has unexpected project_id: ${event.project_id}, expected: ${options.projectId}`
        );
      }
    }
  }

  return results;
};

/**
 * Refresh the session using the refresh token, preserving the refresh token in context.
 * The session refresh endpoint only returns access_token, not refresh_token.
 */
const refreshSession = async () => {
  const currentRefreshToken = backendContext.value.userAuth?.refreshToken;
  const response = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
    method: "POST",
    accessType: "client",
    userAuth: {
      refreshToken: currentRefreshToken,
    },
  });
  if (response.status !== 200) {
    throw new Error(`Failed to refresh session: ${response.status} ${JSON.stringify(response.body)}`);
  }
  // Preserve the refresh token since the endpoint only returns access_token
  backendContext.set({
    userAuth: {
      accessToken: response.body.access_token,
      refreshToken: currentRefreshToken,
    },
  });
  return response;
};

// ============================================================================
// Signup Tests
// ============================================================================

it("password signup creates exactly one $token-refresh event", async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { credential_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();
  const { userId } = await Auth.Password.signUpWithEmail();

  const events = await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });
  expect(events[0]).toMatchObject({
    event_type: "$token-refresh",
    project_id: projectId,
    branch_id: "main",
    user_id: userId,
  });
});

it("OTP signin (new user) creates exactly one $token-refresh event", async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { magic_link_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();
  const { userId } = await Auth.fastSignUp();

  const events = await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });
  expect(events[0]).toMatchObject({
    event_type: "$token-refresh",
    project_id: projectId,
    branch_id: "main",
    user_id: userId,
  });
});

it("anonymous signup creates exactly one $token-refresh event", async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch();
  await InternalApiKey.createAndSetProjectKeys();
  const { userId } = await Auth.Anonymous.signUp();

  const events = await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });
  expect(events[0]).toMatchObject({
    event_type: "$token-refresh",
    project_id: projectId,
    branch_id: "main",
    user_id: userId,
  });
});

it("OAuth signup creates exactly one $token-refresh event", { timeout: 120_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: {
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    },
  });
  await InternalApiKey.createAndSetProjectKeys();

  // OAuth signup flow - this creates a new user
  const { tokenResponse } = await Auth.OAuth.signIn();
  expect(tokenResponse.status).toBe(200);

  // Get the user ID from the current session
  const userResponse = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
  });
  const userId = userResponse.body.id;

  const events = await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });
  expect(events[0]).toMatchObject({
    event_type: "$token-refresh",
    project_id: projectId,
    branch_id: "main",
    user_id: userId,
  });
});

// ============================================================================
// Signin Tests
// ============================================================================

it("password signin (existing user) creates exactly one additional $token-refresh event", { timeout: 120_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { credential_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();

  // First, sign up
  const { userId, password } = await Auth.Password.signUpWithEmail();

  // Wait for the signup event to be recorded
  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  // Sign out and sign in again
  await Auth.signOut();
  backendContext.set({ userAuth: null });
  await Auth.Password.signInWithEmail({ password });

  // Now we should have 2 events: one from signup, one from signin
  const events = await expectExactlyNTokenRefreshEvents(userId, 2, { projectId });
  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);
});

it("OTP signin (existing user) creates exactly one additional $token-refresh event", { timeout: 120_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { magic_link_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();

  // First signin creates the user
  const { userId } = await Auth.Otp.signIn();
  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  // Sign out and sign in again (same email, existing user)
  await Auth.signOut();
  backendContext.set({ userAuth: null });
  await Auth.Otp.signIn();

  // Now we should have 2 events
  const events = await expectExactlyNTokenRefreshEvents(userId, 2, { projectId });
  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);
});

it("OAuth signin (existing user) creates exactly one additional $token-refresh event", { timeout: 120_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: {
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    },
  });
  await InternalApiKey.createAndSetProjectKeys();

  // First OAuth signin creates the user
  await Auth.OAuth.signIn();
  const userResponse1 = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  const userId = userResponse1.body.id;
  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  // Sign out and sign in again
  await Auth.signOut();
  backendContext.set({ userAuth: null });
  await Auth.OAuth.signIn();

  // Now we should have 2 events
  const events = await expectExactlyNTokenRefreshEvents(userId, 2, { projectId });
  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);
});

// ============================================================================
// Session Refresh Tests
// ============================================================================

it("session refresh endpoint creates exactly one additional $token-refresh event", { timeout: 120_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { magic_link_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();

  const { userId } = await Auth.fastSignUp();
  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  // Refresh the session
  await refreshSession();

  // Now we should have 2 events: one from signin, one from refresh
  const events = await expectExactlyNTokenRefreshEvents(userId, 2, { projectId });
  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);
});

it("multiple session refreshes create one event each", { timeout: 180_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { magic_link_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();

  const { userId } = await Auth.fastSignUp();
  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  // Refresh multiple times
  await refreshSession();
  await expectExactlyNTokenRefreshEvents(userId, 2, { projectId });

  await refreshSession();
  await expectExactlyNTokenRefreshEvents(userId, 3, { projectId });

  await refreshSession();
  const events = await expectExactlyNTokenRefreshEvents(userId, 4, { projectId });

  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);
});

// ============================================================================
// OAuth Refresh Token Grant Tests
// ============================================================================

it("OAuth refresh token grant creates exactly one additional $token-refresh event", { timeout: 120_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: {
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    },
  });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });
  await InternalApiKey.createAndSetProjectKeys();

  // Sign in via OAuth to get initial tokens
  const { tokenResponse } = await Auth.OAuth.signIn();
  const refreshToken = tokenResponse.body.refresh_token;

  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  const userId = userResponse.body.id;

  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  // Use the refresh token grant to get a new access token
  const projectKeys = backendContext.value.projectKeys;
  if (projectKeys === "no-project") throw new Error("No project keys");
  const traceId = generateW3cTraceId();
  const clientSpanId = generateW3cSpanId();

  const refreshResponse = await niceBackendFetch("/api/v1/auth/oauth/token", {
    method: "POST",
    accessType: "client",
    headers: {
      traceparent: `00-${traceId}-${clientSpanId}-01`,
    },
    body: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: projectKeys.projectId,
      client_secret: projectKeys.publishableClientKey ?? throwErr("No publishable client key"),
    },
  });
  expect(refreshResponse).toMatchObject({
    status: 200,
    body: expect.objectContaining({
      access_token: expect.any(String),
    }),
  });

  // Now we should have 2 events
  const events = await expectExactlyNTokenRefreshEvents(userId, 2, { projectId });
  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);

  const refreshTokenId = events.at(0)?.refresh_token_id ?? throwErr("Token refresh event did not expose its refresh_token_id");
  const traceResponse = await fetchTraceSpansWithRetry(traceId);
  expect(traceResponse.status).toBe(200);
  expect(traceResponse.body?.result).toEqual(expect.arrayContaining([
    expect.objectContaining({
      trace_id: traceId,
      parent_span_id: clientSpanId,
      refresh_token_id: refreshTokenId,
      user_id: userId,
    }),
  ]));
  expect(traceResponse.body.result.every((span: { refresh_token_id?: unknown }) => span.refresh_token_id === refreshTokenId)).toBe(true);
});

it("multiple OAuth refresh token grants create one event each", { timeout: 180_000 }, async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: {
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    },
  });
  await InternalApiKey.createAndSetProjectKeys();

  const { tokenResponse } = await Auth.OAuth.signIn();
  const refreshToken = tokenResponse.body.refresh_token;

  const userResponse = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  const userId = userResponse.body.id;

  await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });

  const projectKeys = backendContext.value.projectKeys;
  if (projectKeys === "no-project") throw new Error("No project keys");

  // Use refresh token grant multiple times
  for (let i = 2; i <= 4; i++) {
    const refreshResponse = await niceBackendFetch("/api/v1/auth/oauth/token", {
      method: "POST",
      accessType: "client",
      body: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: projectKeys.projectId,
        client_secret: projectKeys.publishableClientKey ?? throwErr("No publishable client key"),
      },
    });
    expect(refreshResponse.status).toBe(200);
    await expectExactlyNTokenRefreshEvents(userId, i, { projectId });
  }

  const events = await expectExactlyNTokenRefreshEvents(userId, 4, { projectId });
  expect(events.every((e: AnalyticsEvent) => e.event_type === "$token-refresh")).toBe(true);
  expect(events.every((e: AnalyticsEvent) => e.user_id === userId)).toBe(true);
});

// ============================================================================
// Fast Signup (Server-side session creation) Tests
// ============================================================================

it("fast signup (server-side session creation) creates exactly one $token-refresh event", async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch({
    config: { credential_enabled: true },
  });
  await InternalApiKey.createAndSetProjectKeys();

  const { userId } = await Auth.fastSignUp();

  const events = await expectExactlyNTokenRefreshEvents(userId, 1, { projectId });
  expect(events[0]).toMatchObject({
    event_type: "$token-refresh",
    project_id: projectId,
    branch_id: "main",
    user_id: userId,
  });
});
