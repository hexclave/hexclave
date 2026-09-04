import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { it } from "../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../backend-helpers";

// E2E tests for POST /api/v1/feature-flags/exposures/batch.
// Positive paths mint a real evaluation token from a started experiment run
// via POST /api/v1/feature-flags/evaluate. Token-schema edge cases stay in
// apps/backend/src/lib/feature-flags/exposure-tokens.test.ts.

async function uploadExposureBatch(options: {
  batchId: string,
  exposures: { event_id: string, exposure_token: string, exposed_at_ms: number }[],
}) {
  return await niceBackendFetch("/api/v1/feature-flags/exposures/batch", {
    method: "POST",
    accessType: "client",
    body: {
      batch_id: options.batchId,
      exposures: options.exposures,
    },
  });
}

async function evaluateActiveExperimentToken(): Promise<string> {
  const evaluated = await niceBackendFetch("/api/v1/feature-flags/evaluate", {
    method: "POST",
    accessType: "client",
    body: { flag_keys: ["checkout-experiment"], fallbacks: { "checkout-experiment": false } },
  });
  const token = evaluated.body?.results?.["checkout-experiment"]?.exposure_token;
  if (typeof token !== "string") throw new Error("Expected an active experiment evaluation to return an exposure token");
  return token;
}

async function createActiveExperimentToken(): Promise<string> {
  const hypothesis = "The treatment improves checkout completion";
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({
    apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } },
    featureFlags: {
      flags: {
        checkout: {
          key: "checkout-experiment",
          type: "boolean",
          enabled: true,
          allocationSalt: "checkout-allocation",
          fallbackVariantKey: "control",
          variants: { control: { value: false }, treatment: { value: true } },
        },
      },
      experiments: {
        checkoutExperiment: {
          key: "checkout-experiment",
          hypothesis,
          flagId: "checkout",
          assignmentUnit: "user",
          trafficAllocationBasisPoints: 10_000,
          controlVariantKey: "control",
          variantWeights: { control: 5_000, treatment: 5_000 },
          primaryMetric: {
            id: "checkoutCompleted",
            type: "custom_event",
            direction: "increase",
            eventName: "checkout-completed",
            attributionWindowSeconds: 86_400,
          },
        },
      },
    },
  });
  await Auth.Otp.signIn();
  const created = await niceBackendFetch("/api/v1/internal/feature-flags/experiments/checkoutExperiment/runs", {
    method: "POST",
    accessType: "admin",
    body: {
      experiment_config: {
        hypothesis,
        flag_id: "checkout",
        assignment_unit: "user",
        traffic_allocation_basis_points: 10_000,
        control_variant_id: "control",
        variants: {
          control: { weight_basis_points: 5_000, flag_value: false },
          treatment: { weight_basis_points: 5_000, flag_value: true },
        },
        primary_metric: { id: "checkoutCompleted", kind: "binary", event_name: "checkout-completed", direction: "increase" },
        secondary_metrics: [],
        guardrail_metrics: [],
        attribution_window_seconds: 86_400,
      },
    },
  });
  expect(created.status).toBe(201);
  const started = await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/checkoutExperiment/runs/${created.body.id}/start`, {
    method: "POST",
    accessType: "admin",
    body: {},
  });
  expect(started.status).toBe(200);
  return await evaluateActiveExperimentToken();
}

it("records a signed exposure once across retries and rejects in-batch duplicates", async ({ expect }) => {
  const token = await createActiveExperimentToken();
  const now = Date.now();
  const request = {
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: token, exposed_at_ms: now }],
  };
  const first = await uploadExposureBatch(request);
  const replay = await uploadExposureBatch(request);
  const duplicateEvaluation = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [
      { event_id: randomUUID(), exposure_token: token, exposed_at_ms: now },
      { event_id: randomUUID(), exposure_token: token, exposed_at_ms: now },
    ],
  });

  expect(first.status).toBe(200);
  expect(first.body).toEqual({ inserted: 1, dropped: 0 });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({ inserted: 0, dropped: 0 });
  expect(duplicateEvaluation.status).toBe(400);
  expect(duplicateEvaluation.body).toBe("Exposure batches cannot contain duplicate event or evaluation IDs");
});

it("rolls back every new receipt when one event ID conflicts", async ({ expect }) => {
  const firstToken = await createActiveExperimentToken();
  const conflictingEventId = randomUUID();
  const exposedAtMillis = Date.now();
  expect((await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: conflictingEventId, exposure_token: firstToken, exposed_at_ms: exposedAtMillis }],
  })).status).toBe(200);

  const conflictingToken = await evaluateActiveExperimentToken();
  const siblingToken = await evaluateActiveExperimentToken();
  const siblingEventId = randomUUID();
  const rejected = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [
      { event_id: conflictingEventId, exposure_token: conflictingToken, exposed_at_ms: exposedAtMillis },
      { event_id: siblingEventId, exposure_token: siblingToken, exposed_at_ms: exposedAtMillis },
    ],
  });
  expect(rejected.status).toBe(409);

  const corrected = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: siblingEventId, exposure_token: siblingToken, exposed_at_ms: exposedAtMillis }],
  });
  expect(corrected.status).toBe(200);
  expect(corrected.body).toEqual({ inserted: 1, dropped: 0 });
});

it("throws error when analytics is not enabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { "feature-flags": { enabled: true } } } });
  // Analytics is disabled by default - do NOT call Project.updateConfig
  await Auth.Otp.signIn();

  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: "some-token", exposed_at_ms: Date.now() }],
  });

  expect(res.status).toBe(400);
  expect(res.body?.code).toBe("ANALYTICS_NOT_ENABLED");
});

it("rejects a garbage token with 401", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: "not-a-valid-jwt", exposed_at_ms: Date.now() }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": "Invalid or expired feature flag evaluation token",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects tokens longer than 4096 characters at the schema level", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: "a".repeat(4097), exposed_at_ms: Date.now() }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/feature-flags/exposures/batch:
              - body.exposures[0].exposure_token must be at most 4096 characters
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/feature-flags/exposures/batch:
            - body.exposures[0].exposure_token must be at most 4096 characters
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects empty exposures array", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/feature-flags/exposures/batch:
              - body.exposures field must have at least 1 items
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/feature-flags/exposures/batch:
            - body.exposures field must have at least 1 items
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects too many exposures (>500)", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } } });
  await Auth.Otp.signIn();

  const now = Date.now();
  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: Array.from({ length: 501 }, () => ({
      event_id: randomUUID(),
      exposure_token: "some-token",
      exposed_at_ms: now,
    })),
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/feature-flags/exposures/batch:
              - body.exposures field must have less than or equal to 500 items
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/feature-flags/exposures/batch:
            - body.exposures field must have less than or equal to 500 items
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("accepts exposures from a client with a skewed clock", async ({ expect }) => {
  const token = await createActiveExperimentToken();

  // The SDK awaits the automatic exposure upload inside getFeatureFlag(), so a
  // rejection here would break flag evaluation for any end user whose device
  // clock is a few minutes off. Hours of skew in either direction must land.
  const fastClock = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: token, exposed_at_ms: Date.now() + 3 * 60 * 60 * 1000 }],
  });
  expect(fastClock.status).toBe(200);
  expect(fastClock.body).toEqual({ inserted: 1, dropped: 0 });

  const slowToken = await evaluateActiveExperimentToken();
  const slowClock = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: slowToken, exposed_at_ms: Date.now() - 3 * 60 * 60 * 1000 }],
  });
  expect(slowClock.status).toBe(200);
  expect(slowClock.body).toEqual({ inserted: 1, dropped: 0 });
});

it("drops exposures with implausible exposed_at_ms instead of rejecting the batch", async ({ expect }) => {
  const plausibleToken = await createActiveExperimentToken();
  const implausibleToken = await evaluateActiveExperimentToken();

  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [
      { event_id: randomUUID(), exposure_token: plausibleToken, exposed_at_ms: Date.now() },
      { event_id: randomUUID(), exposure_token: implausibleToken, exposed_at_ms: Date.now() - 30 * 24 * 60 * 60 * 1000 },
    ],
  });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ inserted: 1, dropped: 1 });

  // Token verification still runs before the plausibility filter, so a bad
  // token cannot hide behind an implausible timestamp.
  const garbage = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: "not-a-valid-jwt", exposed_at_ms: Date.now() - 30 * 24 * 60 * 60 * 1000 }],
  });
  expect(garbage.status).toBe(401);

  const allImplausible = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: randomUUID(), exposure_token: await evaluateActiveExperimentToken(), exposed_at_ms: Date.now() + 365 * 24 * 60 * 60 * 1000 }],
  });
  expect(allImplausible.status).toBe(200);
  expect(allImplausible.body).toEqual({ inserted: 0, dropped: 1 });
});

it("rejects invalid event_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } } });
  await Auth.Otp.signIn();

  const res = await uploadExposureBatch({
    batchId: randomUUID(),
    exposures: [{ event_id: "not-a-uuid", exposure_token: "some-token", exposed_at_ms: Date.now() }],
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/feature-flags/exposures/batch:
              - Invalid event_id
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/feature-flags/exposures/batch:
            - Invalid event_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});
