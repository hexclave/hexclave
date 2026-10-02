import { ITEM_IDS, PLAN_LIMITS, type PlanId } from "@hexclave/shared/dist/plans";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { it } from "../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch, withInternalProject } from "../../../backend-helpers";
import {
  getItemQuantity,
  setItemQuantity,
  waitForItemQuantityToReach,
  waitForItemQuantityToStabilize,
} from "../../../payment-quota-helpers";

async function setupAnalyticsProject() {
  const project = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  return project;
}

async function uploadEventBatch(options: {
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

it("requires a user token", async ({ expect }) => {
  await setupAnalyticsProject();
  backendContext.set({ userAuth: null });

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "USER_AUTHENTICATION_REQUIRED",
        "error": "User authentication required for this endpoint.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_AUTHENTICATION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("returns ACCESS_TYPE_REQUIRED instead of crashing when no project access is provided", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    body: {
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      sent_at_ms: Date.now(),
      events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ACCESS_TYPE_REQUIRED",
        "error": deindent\`
          You must specify an access level for this Hexclave project. Make sure project API keys are provided (eg. x-hexclave-publishable-client-key) and you set the x-hexclave-access-type header to 'client', 'server', or 'admin'. (The legacy x-stack-* equivalents are also accepted.)
          
          For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "ACCESS_TYPE_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects a literal null JSON body instead of crashing", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.Otp.signIn();

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    rawBody: new TextEncoder().encode("null"),
    rawContentType: "application/json",
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - body cannot be null
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - body cannot be null
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("throws error when analytics is not enabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  // Analytics is disabled by default - do NOT call Project.updateConfig
  await Auth.fastSignUp();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
  });

  expect(res.status).toBe(400);
  expect(res.body?.code).toBe("ANALYTICS_NOT_ENABLED");
});

it("accepts valid $page-view events", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      {
        event_type: "$page-view",
        event_at_ms: now - 100,
        data: {
          url: "https://example.com/page",
          path: "/page",
          referrer: "",
          title: "Test Page",
          entry_type: "initial",
          viewport_width: 1920,
          viewport_height: 1080,
          screen_width: 1920,
          screen_height: 1080,
        },
      },
      {
        event_type: "$page-view",
        event_at_ms: now - 50,
        data: {
          url: "https://example.com/other",
          path: "/other",
          referrer: "https://example.com/page",
          title: "Other Page",
          entry_type: "push",
          viewport_width: 1920,
          viewport_height: 1080,
          screen_width: 1920,
          screen_height: 1080,
        },
      },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "inserted": 2 },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("accepts valid $click events", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      {
        event_type: "$click",
        event_at_ms: now - 50,
        data: {
          tag_name: "button",
          text: "Submit",
          href: null,
          selector: "div > form > button.submit-btn",
          x: 100,
          y: 200,
          page_x: 100,
          page_y: 500,
          viewport_width: 1920,
          viewport_height: 1080,
        },
      },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "inserted": 1 },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("accepts a gzipped binary body (adblocker-evasion encoding)", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const now = Date.now();
  const payload = {
    session_replay_segment_id: randomUUID(),
    batch_id: randomUUID(),
    sent_at_ms: now,
    events: [
      {
        event_type: "$click",
        event_at_ms: now - 50,
        data: {
          tag_name: "button",
          text: "Encoded",
          href: null,
          selector: "button.encoded",
          x: 1, y: 2, page_x: 1, page_y: 2,
          viewport_width: 100, viewport_height: 100,
        },
      },
    ],
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    rawBody: compressed,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "inserted": 1 },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a binary body that isn't valid gzip", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    rawBody: new Uint8Array([0, 1, 2, 3, 4, 5]),
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid encoded analytics body",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a binary body larger than the compressed size cap", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  // Random bytes don't compress, so even before gunzip the byteLength check
  // fires. 1.1 MB > the 1 MB MAX_COMPRESSED_BYTES cap.
  const oversized = new Uint8Array(randomBytes(Math.floor(1.1 * 1024 * 1024)));

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    rawBody: oversized,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Encoded analytics body too large",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a gzipped body that decompresses past the server size cap", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  // 9 MB of zeros gzips to ~9 KB but decompresses past the 8 MB server cap.
  const bomb = gzipSync(Buffer.alloc(9 * 1024 * 1024));

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    rawBody: bomb,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid encoded analytics body",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("handles click event data containing a truncated surrogate pair (lone high surrogate)", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  // Simulate what the client-side event tracker does: .substring(0, 200) can
  // cut a string in the middle of a surrogate pair when emoji characters are
  // near the boundary. For example, 🍉 is "\uD83C\uDF49" in UTF-16; cutting
  // after the high surrogate leaves a lone "\uD83C" that ClickHouse cannot parse.
  const paddedText = "a".repeat(199) + "\uD83C"; // lone high surrogate at position 199

  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      {
        event_type: "$click",
        event_at_ms: now - 50,
        data: {
          tag_name: "div",
          text: paddedText,
          href: null,
          selector: "div.container",
          x: 100,
          y: 200,
          page_x: 100,
          page_y: 500,
          viewport_width: 375,
          viewport_height: 647,
        },
      },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "inserted": 1 },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects empty events array", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - body.events field must have at least 1 items
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - body.events field must have at least 1 items
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects too many events (>500)", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const tooManyEvents = Array.from({ length: 501 }, (_, i) => ({
    event_type: "$page-view",
    event_at_ms: 1_700_000_000_000 + i,
    data: { url: `https://example.com/page-${i}`, path: `/page-${i}` },
  }));

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: 1_700_000_000_100,
    events: tooManyEvents,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - body.events field must have less than or equal to 500 items
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - body.events field must have less than or equal to 500 items
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects invalid session_replay_segment_id", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: "not-a-uuid",
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - Invalid session_replay_segment_id
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - Invalid session_replay_segment_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects invalid batch_id", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: "not-a-uuid",
    sentAtMs: Date.now(),
    events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - Invalid batch_id
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - Invalid batch_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects invalid event_type", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$invalid-type", event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - body.events[0].event_type must be one of the following values: $page-view, $click
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - body.events[0].event_type must be one of the following values: $page-view, $click
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects a batch carrying the withdrawn versioned fields (schema_version/resource/spans)", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const now = Date.now();
  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      schema_version: 3,
      resource: {
        service: { namespace: "e2e", name: "test-client", version: "test" },
        deploymentEnvironmentName: "test",
        attributes: { suite: "analytics-events-batch" },
      },
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      sent_at_ms: now,
      events: [{ event_type: "$page-view", event_at_ms: now, data: {} }],
      spans: [],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - body contains unknown properties: schema_version, resource, spans
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - body contains unknown properties: schema_version, resource, spans
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("inserted events are queryable via analytics query endpoint", async ({ expect }) => {
  await setupAnalyticsProject();
  await Auth.fastSignUp();

  const sessionReplaySegmentId = randomUUID();
  const now = Date.now();

  const uploadRes = await uploadEventBatch({
    sessionReplaySegmentId,
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      {
        event_type: "$page-view",
        event_at_ms: now - 200,
        data: { url: "https://example.com/test-query", path: "/test-query" },
      },
      {
        event_type: "$click",
        event_at_ms: now - 100,
        data: { tag_name: "a", text: "Link", selector: "a.link" },
      },
    ],
  });
  expect(uploadRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "inserted": 2 },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Retry query because async inserts may have a flush delay
  let queryRes;
  for (let attempt = 0; attempt < 15; attempt++) {
    await wait(500);
    queryRes = await niceBackendFetch("/api/v1/analytics/query", {
      method: "POST",
      accessType: "server",
      body: {
        query: "SELECT event_type, session_replay_segment_id FROM events WHERE session_replay_segment_id = {segId:String} ORDER BY event_at",
        params: { segId: sessionReplaySegmentId },
      },
    });
    if (queryRes.status === 200 && queryRes.body?.result?.length === 2) {
      break;
    }
  }

  expect(queryRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "query_id": "<stripped UUID>:main:<stripped UUID>",
        "result": [
          {
            "event_type": "$page-view",
            "session_replay_segment_id": "<stripped UUID>",
          },
          {
            "event_type": "$click",
            "session_replay_segment_id": "<stripped UUID>",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

// ============================================================================
// Analytics event limit enforcement tests
// ============================================================================

async function setupProjectWithPlan(planId: PlanId) {
  const { createProjectResponse } = await setupAnalyticsProject();
  const ownerTeamId = createProjectResponse.body.owner_team_id;

  if (planId !== "free") {
    await withInternalProject(async () => {
      const grantResponse = await niceBackendFetch(`/api/v1/payments/products/team/${ownerTeamId}`, {
        method: "POST",
        accessType: "server",
        body: { product_id: planId },
      });
      if (grantResponse.status !== 200) {
        throw new HexclaveAssertionError(`Failed to grant plan '${planId}' to team '${ownerTeamId}'`, { response: grantResponse });
      }
    });
  }
  await waitForItemQuantityToReach(ownerTeamId, ITEM_IDS.analyticsEvents, PLAN_LIMITS[planId].analyticsEvents);
  return { ownerTeamId };
}

it("rejects batch when analytics event quota is exhausted", async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("free");
  await Auth.Otp.signIn();

  await setItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents, 0);

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
  });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe("ITEM_QUANTITY_INSUFFICIENT_AMOUNT");
});

it("accepts batch and debits event quota correctly", { timeout: 120_000 }, async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("free");
  await Auth.Otp.signIn();

  // Drain async logEvent debits (sign-in triggers token-refresh/sign-up-rule
  // events asynchronously) before measuring baseline. The
  // `minimumElapsedMs` guards against the failure mode where stability is
  // declared before the async events have had a chance to fire — without
  // it the test reads e.g. 100000, declares it stable, then ~5s later the
  // async events land and the post-batch read is short by 2.
  const quantityBeforeBatch = await waitForItemQuantityToStabilize(
    ownerTeamId,
    ITEM_IDS.analyticsEvents,
    { minimumElapsedMs: 5000 },
  );

  const now = Date.now();
  const eventCount = 3;
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: Array.from({ length: eventCount }, (_, i) => ({
      event_type: "$page-view" as const,
      event_at_ms: now - i,
      data: { url: `https://example.com/page-${i}`, path: `/page-${i}` },
    })),
  });

  expect(res.status).toBe(200);
  expect(res.body.inserted).toBe(eventCount);

  const afterQuantity = await getItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents);
  expect(afterQuantity).toBe(quantityBeforeBatch - eventCount);
});

it("allows only one concurrent batch to spend the final analytics event credit", { timeout: 120_000 }, async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("free");
  await Auth.Otp.signIn();

  await waitForItemQuantityToStabilize(
    ownerTeamId,
    ITEM_IDS.analyticsEvents,
    { minimumElapsedMs: 10_000 },
  );
  await setItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents, 1);
  await waitForItemQuantityToReach(ownerTeamId, ITEM_IDS.analyticsEvents, 1);

  const sessionReplaySegmentId = randomUUID();
  const sentAtMs = Date.now();
  const responses = await Promise.all([randomUUID(), randomUUID()].map(async (batchId) => (
    await uploadEventBatch({
      sessionReplaySegmentId,
      batchId,
      sentAtMs,
      events: [{ event_type: "$page-view", event_at_ms: sentAtMs, data: {} }],
    })
  )));

  expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 400]);
  const rejected = responses.find((response) => response.status === 400);
  expect(rejected?.body.code).toBe("ITEM_QUANTITY_INSUFFICIENT_AMOUNT");
  expect(await getItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents)).toBe(0);
});

// We don't support metered pricing or partial batches for now, so the entire
// batch is rejected when remaining quota is less than the batch size, and
// the quota must remain unchanged (no partial debit).
it("rejects batch when remaining quota is less than batch size and does not debit", { timeout: 120_000 }, async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("free");
  await Auth.Otp.signIn();

  // Drain async logEvent debits before forcing the quota down to a known
  // value — otherwise a trailing in-flight debit would push it negative
  // after we set it to 2 and break the post-condition.
  //
  // `Auth.Otp.signIn()` triggers async events via `runAsynchronouslyAndWaitUntil`
  // (e.g. $token-refresh, $sign-up-rule-trigger) that debit analytics quota.
  // Under CI load with 8 parallel workers, these async callbacks can be delayed
  // 5+ seconds after the HTTP response. `minimumElapsedMs: 10_000` ensures we
  // don't declare stability before the async pipeline has had time to fire.
  await waitForItemQuantityToStabilize(
    ownerTeamId,
    ITEM_IDS.analyticsEvents,
    { minimumElapsedMs: 10_000 },
  );
  await setItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents, 2);

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: Array.from({ length: 5 }, (_, i) => ({
      event_type: "$page-view" as const,
      event_at_ms: Date.now() - i,
      data: {},
    })),
  });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe("ITEM_QUANTITY_INSUFFICIENT_AMOUNT");

  const quantityAfter = await getItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents);
  expect(quantityAfter).toBe(2);
});

it("free plan starts with correct analytics event allocation", async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("free");

  const quantity = await getItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents);
  expect(quantity).toBe(PLAN_LIMITS.free.analyticsEvents);
});

it("team plan starts with correct analytics event allocation", async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("team");

  const quantity = await getItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents);
  expect(quantity).toBe(PLAN_LIMITS.team.analyticsEvents);
});
