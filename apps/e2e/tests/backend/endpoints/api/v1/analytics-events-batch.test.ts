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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  backendContext.set({ userAuth: null });

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      sent_at_ms: Date.now(),
      events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
    },
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
      "body": {
        "dropped": 0,
        "inserted": 2,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("accepts batches from clients with a skewed clock", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  // A device clock that is hours off is common. Both sent_at_ms and
  // event_at_ms come from that clock, so neither may cause a rejection.
  const skewed = Date.now() + 3 * 60 * 60 * 1000;
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: skewed,
    events: [
      { event_type: "$page-view", event_at_ms: skewed - 100, data: { path: "/skewed" } },
      { event_type: "$page-view", event_at_ms: skewed, data: { path: "/skewed-2" } },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "dropped": 0,
        "inserted": 2,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("drops events with implausible timestamps instead of rejecting the batch", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      { event_type: "$page-view", event_at_ms: now - 100, data: { path: "/ok" } },
      { event_type: "$page-view", event_at_ms: now + 2 * 24 * 60 * 60 * 1000, data: { path: "/far-future" } },
      { event_type: "$page-view", event_at_ms: now - 8 * 24 * 60 * 60 * 1000, data: { path: "/far-past" } },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "dropped": 2,
        "inserted": 1,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("keeps stable event ids anchored to the original batch position when earlier events are dropped", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const sessionReplaySegmentId = randomUUID();
  const batchId = randomUUID();
  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId,
    batchId,
    sentAtMs: now,
    events: [
      { event_type: "$page-view", event_at_ms: now + 30 * 24 * 60 * 60 * 1000, data: { path: "/dropped" } },
      { event_type: "$page-view", event_at_ms: now - 100, data: { path: "/kept" } },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ inserted: 1, dropped: 1 });

  // The id is batch_id:<position in the uploaded batch>, so the surviving
  // event is :1 even though it is the only row stored. A retried batch that
  // later accepts the first event must not renumber this one to :0.
  let queryRes;
  for (let attempt = 0; attempt < 15; attempt++) {
    await wait(500);
    queryRes = await niceBackendFetch("/api/v1/analytics/query", {
      method: "POST",
      accessType: "server",
      body: {
        query: "SELECT toString(data.event_id) AS event_id, toString(data.path) AS path FROM events WHERE session_replay_segment_id = {segId:String}",
        params: { segId: sessionReplaySegmentId },
      },
    });
    if (queryRes.status === 200 && queryRes.body?.result?.length === 1) break;
  }
  expect(queryRes?.status).toBe(200);
  expect(queryRes?.body.result).toEqual([{ event_id: `${batchId.toLowerCase()}:1`, path: "/kept" }]);
});

it("returns 200 with nothing inserted when every event is implausible, so the client can move on", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$page-view", event_at_ms: Date.now() + 365 * 24 * 60 * 60 * 1000, data: { path: "/next-year" } }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "dropped": 1,
        "inserted": 0,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("accepts valid $click events", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
      "body": {
        "dropped": 0,
        "inserted": 1,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("accepts a gzipped binary body (adblocker-evasion encoding)", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
      "body": {
        "dropped": 0,
        "inserted": 1,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a binary body that isn't valid gzip", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
      "body": {
        "dropped": 0,
        "inserted": 1,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects empty events array", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      session_replay_segment_id: "not-a-uuid",
      batch_id: randomUUID(),
      sent_at_ms: Date.now(),
      events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
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
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      session_replay_segment_id: randomUUID(),
      batch_id: "not-a-uuid",
      sent_at_ms: Date.now(),
      events: [{ event_type: "$page-view", event_at_ms: Date.now(), data: {} }],
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

it("rejects unknown reserved event_type", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  // Since custom events were introduced, non-$ names are accepted as customer
  // events; only unknown RESERVED ($-prefixed) types are rejected, now by the
  // handler rather than the request schema.
  const res = await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      sent_at_ms: Date.now(),
      events: [{ event_type: "$invalid-type", event_at_ms: Date.now(), data: {} }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Reserved event type \\"$invalid-type\\" cannot be uploaded via this endpoint",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("inserted events are queryable via analytics query endpoint", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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
      "body": {
        "dropped": 0,
        "inserted": 2,
      },
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
  const { createProjectResponse } = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
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

it("does not debit event quota for dropped implausible events", { timeout: 120_000 }, async ({ expect }) => {
  const { ownerTeamId } = await setupProjectWithPlan("free");
  await Auth.Otp.signIn();

  const quantityBeforeBatch = await waitForItemQuantityToStabilize(
    ownerTeamId,
    ITEM_IDS.analyticsEvents,
    { minimumElapsedMs: 5000 },
  );

  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      { event_type: "$page-view", event_at_ms: now - 1, data: { path: "/ok-1" } },
      { event_type: "$page-view", event_at_ms: now - 2, data: { path: "/ok-2" } },
      { event_type: "$page-view", event_at_ms: now + 30 * 24 * 60 * 60 * 1000, data: { path: "/next-month" } },
    ],
  });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ inserted: 2, dropped: 1 });

  const afterQuantity = await getItemQuantity(ownerTeamId, ITEM_IDS.analyticsEvents);
  expect(afterQuantity).toBe(quantityBeforeBatch - 2);
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
