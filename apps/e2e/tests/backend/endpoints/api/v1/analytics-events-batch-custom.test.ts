import { randomUUID } from "node:crypto";
import { it } from "../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../backend-helpers";

// E2E tests for customer-defined ("custom") analytics events uploaded through
// POST /api/v1/analytics/events/batch. Reserved auto-capture events
// ($page-view, $click) are covered in analytics-events-batch.test.ts; this
// file covers the custom-event validation surface (see
// apps/backend/src/lib/analytics-custom-events.ts).

async function uploadEventBatch(options: {
  sessionReplaySegmentId: string,
  batchId: string,
  sentAtMs: number,
  events: { event_type: string, event_at_ms: number, data: unknown, value?: unknown }[],
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

it("accepts a custom event with a valid name, properties, and value", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  const now = Date.now();
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: now,
    events: [
      {
        event_type: "purchase-completed",
        event_at_ms: now - 100,
        data: {
          plan: "pro",
          seats: 3,
          annual: true,
          metadata: { source: "onboarding" },
        },
        value: 49.99,
      },
      {
        // A custom event without properties or value is also valid.
        event_type: "signed-up",
        event_at_ms: now - 50,
        data: {},
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

it("rejects the reserved $feature-flag-exposure event type", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  // $feature-flag-exposure rows may only enter through the signed
  // feature-flags exposure route (see feature-flags-exposures-batch.test.ts),
  // never through the public analytics ingestion route.
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$feature-flag-exposure", event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Reserved event type \\"$feature-flag-exposure\\" cannot be uploaded via this endpoint",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects unknown $-prefixed event types", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  // Any name starting with $ is reserved (isReservedEventName), so a customer
  // can never define a $-prefixed custom event — even one that doesn't
  // collide with an existing reserved event type.
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "$made-up", event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Reserved event type \\"$made-up\\" cannot be uploaded via this endpoint",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a non-finite value on a custom event", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  // JSON can't express NaN/Infinity, so the practical non-finite input is a
  // non-number type; validateCustomEventPayload rejects both the same way.
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "purchase-completed", event_at_ms: Date.now(), data: {}, value: "not-a-number" }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Event \\"purchase-completed\\": value must be a finite number",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects custom event properties nested deeper than 4 levels", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [
      {
        event_type: "checkout",
        event_at_ms: Date.now(),
        // The root properties object is depth 1, so l4's value already sits at
        // depth 5 — beyond MAX_CUSTOM_EVENT_PROPERTY_DEPTH.
        data: { l1: { l2: { l3: { l4: { l5: 1 } } } } },
      },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Event \\"checkout\\": properties must not be nested deeper than 4 levels",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects custom event property keys starting with $", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "signed-up", event_at_ms: Date.now(), data: { $hidden: true } }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Event \\"signed-up\\": property keys starting with $ are reserved",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a value on the reserved $page-view event type", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  // The numeric observation only makes sense for custom events (numeric
  // experiment metrics); auto-capture events must never carry one.
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [
      {
        event_type: "$page-view",
        event_at_ms: Date.now(),
        data: { url: "https://example.com/page", path: "/page" },
        value: 1,
      },
    ],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Reserved event type \\"$page-view\\" does not accept a value",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects custom event names longer than 128 characters", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.Otp.signIn();

  // Rejected at the request-schema level (yup max), before the handler's
  // custom-event validation even runs.
  const res = await uploadEventBatch({
    sessionReplaySegmentId: randomUUID(),
    batchId: randomUUID(),
    sentAtMs: Date.now(),
    events: [{ event_type: "a".repeat(129), event_at_ms: Date.now(), data: {} }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/analytics/events/batch:
              - body.events[0].event_type must be at most 128 characters
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/analytics/events/batch:
            - body.events[0].event_type must be at most 128 characters
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});
