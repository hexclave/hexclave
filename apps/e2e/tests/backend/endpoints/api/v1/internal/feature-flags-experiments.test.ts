import { wait } from "@hexclave/shared/dist/utils/promises";
import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../../backend-helpers";

// E2E tests for the internal experiment-run lifecycle endpoints:
//   POST/GET /api/v1/internal/feature-flags/experiments/:experiment_id/runs
//   POST     .../runs/:run_id/{start,pause,resume,complete,revision}
//   GET      .../runs/:run_id/results
//   GET      /api/v1/internal/feature-flags/experiment-schedule-processor
//
// Results include a live evaluate → exposure → ClickHouse attribution cycle.
// Bayesian winner/SRM math stays in backend unit tests.

const EXPERIMENT_ID = "my-experiment";
const SECOND_EXPERIMENT_ID = "my-second-experiment";
const DEFAULT_ATTRIBUTION_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function validExperimentConfig() {
  return {
    hypothesis: "The treatment improves sign-up completion",
    flag_id: "my-flag",
    assignment_unit: "user",
    traffic_allocation_basis_points: 10000,
    control_variant_id: "control",
    variants: {
      control: { weight_basis_points: 5000, flag_value: false },
      treatment: { weight_basis_points: 5000, flag_value: true },
    },
    primary_metric: { id: "signup", kind: "binary", event_name: "signed-up", direction: "increase" },
    attribution_window_seconds: DEFAULT_ATTRIBUTION_WINDOW_SECONDS,
  };
}

function featureFlagsConfig(options?: {
  attributionWindowSeconds?: number,
  trafficAllocationBasisPoints?: number,
  startsAt?: string,
  endsAt?: string,
  // Published treatment value and weights, used to change the branch definition
  // while a run is active and prove the overlay serves the frozen snapshot.
  treatmentValue?: boolean,
  variantWeights?: { control: number, treatment: number },
  funnelSteps?: Record<string, string>,
}) {
  const variantWeights = options?.variantWeights ?? { control: 5000, treatment: 5000 };
  const variants = { control: { value: false }, treatment: { value: options?.treatmentValue ?? true } };
  const primaryMetric = options?.funnelSteps === undefined ? {
    id: "signup",
    type: "custom_event",
    eventName: "signed-up",
    direction: "increase",
    attributionWindowSeconds: options?.attributionWindowSeconds ?? DEFAULT_ATTRIBUTION_WINDOW_SECONDS,
  } : {
    id: "signup",
    type: "funnel",
    direction: "increase",
    funnelSteps: options.funnelSteps,
    attributionWindowSeconds: options.attributionWindowSeconds ?? DEFAULT_ATTRIBUTION_WINDOW_SECONDS,
  };
  const experiment = {
    key: "my-experiment",
    hypothesis: "The treatment improves sign-up completion",
    flagId: "my-flag",
    assignmentUnit: "user",
    trafficAllocationBasisPoints: options?.trafficAllocationBasisPoints ?? 10000,
    controlVariantKey: "control",
    variantWeights,
    primaryMetric,
    ...(options?.startsAt === undefined ? {} : { startsAt: options.startsAt }),
    ...(options?.endsAt === undefined ? {} : { endsAt: options.endsAt }),
  };
  return {
    flags: {
      "my-flag": {
        key: "my-flag",
        type: "boolean",
        enabled: true,
        allocationSalt: "my-flag-allocation",
        fallbackVariantKey: "control",
        variants,
      },
    },
    experiments: {
      [EXPERIMENT_ID]: experiment,
    },
  };
}

function featureFlagConfigOverride(options?: Parameters<typeof featureFlagsConfig>[0], analyticsEnabled = true, featureFlagsEnabled = true) {
  return {
    apps: { installed: { analytics: { enabled: analyticsEnabled }, "feature-flags": { enabled: featureFlagsEnabled } } },
    featureFlags: featureFlagsConfig(options),
  };
}

async function updateFeatureFlagConfig(options?: Parameters<typeof featureFlagsConfig>[0], analyticsEnabled = true, featureFlagsEnabled = true) {
  await Project.updateConfig(featureFlagConfigOverride(options, analyticsEnabled, featureFlagsEnabled));
}

// Same PATCH as Project.updateConfig, but without asserting success so tests can
// check that invalid feature-flag definitions are rejected before publishing.
async function tryUpdateFeatureFlagConfig(options?: Parameters<typeof featureFlagsConfig>[0]) {
  return await niceBackendFetch("/api/latest/internal/config/override/environment", {
    method: "PATCH",
    accessType: "admin",
    body: { config_override_string: JSON.stringify(featureFlagConfigOverride(options)) },
  });
}

async function createProjectWithAnalytics(options?: Parameters<typeof featureFlagsConfig>[0]) {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await updateFeatureFlagConfig(options);
}

async function createRun(config: unknown = validExperimentConfig(), experimentId = EXPERIMENT_ID) {
  return await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/${experimentId}/runs`, {
    method: "POST",
    accessType: "admin",
    body: { experiment_config: config },
  });
}

async function listRuns() {
  return await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/${EXPERIMENT_ID}/runs`, {
    method: "GET",
    accessType: "admin",
  });
}

async function transitionRun(runId: string, action: "start" | "pause" | "resume" | "complete", body: unknown = {}, experimentId = EXPERIMENT_ID) {
  return await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/${experimentId}/runs/${runId}/${action}`, {
    method: "POST",
    accessType: "admin",
    body,
  });
}

describe("experiment run creation", () => {
  it("requires analytics to be enabled", async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });
    await updateFeatureFlagConfig(undefined, false);

    const res = await createRun();

    expect(res.status).toBe(400);
    expect(res.body?.code).toBe("ANALYTICS_NOT_ENABLED");
  });

  it("creates a draft run with a frozen config snapshot and revision hash", async ({ expect }) => {
    await createProjectWithAnalytics();

    const res = await createRun();

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // config_revision_hash is not stripped by the snapshot serializer, so it
    // is asserted separately and replaced before snapshotting the body.
    expect(res.body.config_revision_hash).toMatch(/^[0-9a-f]{64}$/);
    expect({ ...res.body, config_revision_hash: "<asserted above>" }).toMatchInlineSnapshot(`
      {
        "completed_at_millis": null,
        "config_revision_hash": "<asserted above>",
        "config_snapshot": {
          "assignment_unit": "user",
          "attribution_window_seconds": 604800,
          "control_variant_id": "control",
          "flag_id": "my-flag",
          "guardrail_metrics": [],
          "hypothesis": "The treatment improves sign-up completion",
          "primary_metric": {
            "direction": "increase",
            "event_name": "signed-up",
            "id": "signup",
            "kind": "binary",
          },
          "secondary_metrics": [],
          "traffic_allocation_basis_points": 10000,
          "variants": {
            "control": {
              "flag_value": false,
              "weight_basis_points": 5000,
            },
            "treatment": {
              "flag_value": true,
              "weight_basis_points": 5000,
            },
          },
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "created_by_user_id": null,
        "experiment_id": "my-experiment",
        "id": "<stripped UUID>",
        "paused_at_millis": null,
        "revision_number": 1,
        "scheduled_end_at_millis": null,
        "scheduled_start_at_millis": null,
        "started_at_millis": null,
        "state": "draft",
      }
    `);
  });

  it("rejects invalid experiment configurations", async ({ expect }) => {
    await createProjectWithAnalytics();

    // Variant weights not summing to exactly 10000 basis points
    const badWeightsRes = await createRun({
      ...validExperimentConfig(),
      variants: {
        control: { weight_basis_points: 5000, flag_value: false },
        treatment: { weight_basis_points: 4000, flag_value: true },
      },
    });
    expect(badWeightsRes.status).toBe(400);
    expect(badWeightsRes.body).toContain("Variant weights must sum to exactly 10000 basis points");

    // control_variant_id that is not a key of variants
    const badControlRes = await createRun({
      ...validExperimentConfig(),
      control_variant_id: "missing",
    });
    expect(badControlRes.status).toBe(400);
    expect(badControlRes.body).toContain("control_variant_id \"missing\" is not a key of variants");

    // Reserved event names other than the two supported auto-capture events
    // must not be accepted as conversion metrics.
    const badMetricRes = await createRun({
      ...validExperimentConfig(),
      primary_metric: { id: "signup", kind: "binary", event_name: "$feature-flag-exposure", direction: "increase" },
    });
    expect(badMetricRes.status).toBe(400);
    expect(badMetricRes.body).toContain("Metric event names must be customer events");

    // At least 2 variants are required
    const singleVariantRes = await createRun({
      ...validExperimentConfig(),
      variants: {
        control: { weight_basis_points: 10000, flag_value: false },
      },
    });
    expect(singleVariantRes.status).toBe(400);
    expect(singleVariantRes.body).toContain("Experiments must define between 2 and 10 variants");
  });

  it("derives funnel order from canonical step ids", async ({ expect }) => {
    await createProjectWithAnalytics({
      funnelSteps: { step_2: "purchase-completed", step_1: "checkout-started" },
    });
    const funnelConfig = {
      ...validExperimentConfig(),
      primary_metric: {
        id: "signup",
        kind: "funnel",
        steps: ["checkout-started", "purchase-completed"],
        direction: "increase",
      },
    };
    const createRes = await createRun(funnelConfig);
    expect(createRes.status).toBe(201);
    expect(createRes.body.config_snapshot.primary_metric.steps).toEqual(["checkout-started", "purchase-completed"]);

    // Non-canonical step ids never reach a run: the branch config is rejected
    // before it is published, so the funnel order cannot become ambiguous.
    const invalidStepIdsRes = await tryUpdateFeatureFlagConfig({ funnelSteps: { opened: "checkout-started", purchased: "purchase-completed" } });
    expect(invalidStepIdsRes.status).toBe(400);
    expect(JSON.stringify(invalidStepIdsRes.body)).toContain("funnel steps must be consecutively named step_1, step_2");
  });

  it("lists created runs", async ({ expect }) => {
    await createProjectWithAnalytics();

    const firstRes = await createRun();
    expect(firstRes.status).toBe(201);
    const secondRes = await createRun();
    expect(secondRes.status).toBe(201);

    const res = await listRuns();
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Ordered newest-first, but two drafts created in the same millisecond
    // could tie-break by id, so assert order-insensitively.
    const byString = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    expect(res.body.items.map((r: any) => r.id).sort(byString)).toEqual([firstRes.body.id, secondRes.body.id].sort(byString));
    expect(res.body.items.map((r: any) => r.revision_number).sort((a: number, b: number) => a - b)).toEqual([1, 2]);
    expect(res.body.items.every((r: any) => r.state === "draft")).toBe(true);
    expect(res.body.items.every((r: any) => r.experiment_id === EXPERIMENT_ID)).toBe(true);
  });
});

describe("experiment run lifecycle transitions", () => {
  it("supports the start -> pause -> resume -> complete happy path", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id;

    const startRes = await transitionRun(runId, "start");
    expect(startRes.status).toBe(200);
    expect(startRes.body.state).toBe("running");
    expect(startRes.body.started_at_millis).toEqual(expect.any(Number));

    const pauseRes = await transitionRun(runId, "pause");
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.state).toBe("paused");
    expect(pauseRes.body.paused_at_millis).toEqual(expect.any(Number));

    const resumeRes = await transitionRun(runId, "resume");
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.state).toBe("running");

    const completeRes = await transitionRun(runId, "complete");
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.state).toBe("completed");
    expect(completeRes.body.completed_at_millis).toEqual(expect.any(Number));

    // Transitions never touch the frozen snapshot.
    expect(completeRes.body.config_revision_hash).toBe(createRes.body.config_revision_hash);
  });

  it("rejects invalid transitions with 409", async ({ expect }) => {
    await createProjectWithAnalytics();

    // Starting a completed run
    const firstCreateRes = await createRun();
    expect(firstCreateRes.status).toBe(201);
    const completedRunId = firstCreateRes.body.id;
    expect((await transitionRun(completedRunId, "start")).status).toBe(200);
    expect((await transitionRun(completedRunId, "complete")).status).toBe(200);
    const restartRes = await transitionRun(completedRunId, "start");
    expect(restartRes.status).toBe(409);
    expect(restartRes.body).toBe("Experiment run cannot be started in its current state");

    // Pausing a draft run
    const secondCreateRes = await createRun();
    expect(secondCreateRes.status).toBe(201);
    const draftRunId = secondCreateRes.body.id;
    const pauseDraftRes = await transitionRun(draftRunId, "pause");
    expect(pauseDraftRes.status).toBe(409);
    expect(pauseDraftRes.body).toBe("Experiment run cannot be paused in its current state");

    // Resuming a running (not paused) run
    expect((await transitionRun(draftRunId, "start")).status).toBe(200);
    const resumeRunningRes = await transitionRun(draftRunId, "resume");
    expect(resumeRunningRes.status).toBe(409);
    expect(resumeRunningRes.body).toBe("Experiment run cannot be resumed in its current state");
  });

  it("allows only one active run per experiment", async ({ expect }) => {
    await createProjectWithAnalytics();

    const firstCreateRes = await createRun();
    expect(firstCreateRes.status).toBe(201);
    const secondCreateRes = await createRun();
    expect(secondCreateRes.status).toBe(201);

    expect((await transitionRun(firstCreateRes.body.id, "start")).status).toBe(200);

    const secondStartRes = await transitionRun(secondCreateRes.body.id, "start");
    expect(secondStartRes.status).toBe(409);
    expect(secondStartRes.body).toBe("Another active run already targets this experiment or feature flag");
  });

  it("allows only one active experiment per feature flag", async ({ expect }) => {
    await createProjectWithAnalytics();

    const firstCreateRes = await createRun();
    expect(firstCreateRes.status).toBe(201);
    expect((await transitionRun(firstCreateRes.body.id, "start")).status).toBe(200);

    // Config forbids two non-archived definitions on the same flag, so the
    // successor is published only after the predecessor is archived. The first
    // run stays RUNNING, which is what the active-flag unique index guards.
    const published = featureFlagsConfig();
    await Project.updateConfig({
      apps: { installed: { analytics: { enabled: true }, "feature-flags": { enabled: true } } },
      featureFlags: {
        ...published,
        experiments: {
          [EXPERIMENT_ID]: { ...published.experiments[EXPERIMENT_ID], archived: true },
          [SECOND_EXPERIMENT_ID]: { ...published.experiments[EXPERIMENT_ID], key: "my-second-experiment" },
        },
      },
    });

    const secondCreateRes = await createRun(validExperimentConfig(), SECOND_EXPERIMENT_ID);
    expect(secondCreateRes.status).toBe(201);
    const secondStartRes = await transitionRun(secondCreateRes.body.id, "start", {}, SECOND_EXPERIMENT_ID);
    expect(secondStartRes.status).toBe(409);
    expect(secondStartRes.body).toBe("Another active run already targets this experiment or feature flag");
  });

  it("freezes the config snapshot at start and keeps it immutable afterwards", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id;

    // The published branch definition, not the draft or request body, is the
    // source of truth when assignment begins.
    const updatedWindowSeconds = 14 * 24 * 60 * 60;
    await updateFeatureFlagConfig({ attributionWindowSeconds: updatedWindowSeconds });
    const staleStartRes = await transitionRun(runId, "start", { experiment_config: validExperimentConfig() });
    expect(staleStartRes.status).toBe(400);
    expect(staleStartRes.body).toBe("Submitted experiment configuration does not exactly match the current branch definition");

    const startRes = await transitionRun(runId, "start");
    expect(startRes.status).toBe(200);
    expect(startRes.body.state).toBe("running");
    expect(startRes.body.config_snapshot.attribution_window_seconds).toBe(updatedWindowSeconds);
    expect(startRes.body.config_revision_hash).not.toBe(createRes.body.config_revision_hash);

    const listRes = await listRuns();
    expect(listRes.status).toBe(200);
    const runningRun = listRes.body.items.find((r: any) => r.id === runId);
    expect(runningRun.state).toBe("running");
    expect(runningRun.config_snapshot).toEqual(startRes.body.config_snapshot);
    expect(runningRun.config_revision_hash).toBe(startRes.body.config_revision_hash);

    // Completing does not change the frozen snapshot or its hash.
    const completeRes = await transitionRun(runId, "complete");
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.config_revision_hash).toBe(startRes.body.config_revision_hash);
    expect(completeRes.body.config_snapshot).toEqual(startRes.body.config_snapshot);
  });

  it("serves frozen variants when the current branch definition changes", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);
    expect((await transitionRun(createRes.body.id, "start")).status).toBe(200);

    // Republish with a different treatment value, weights, and allocation. The
    // published variants change, but the overlay rule keeps the values, weights,
    // and rollout frozen at start (see active-experiment-overlay.ts).
    await updateFeatureFlagConfig({ treatmentValue: false, variantWeights: { control: 7000, treatment: 3000 }, trafficAllocationBasisPoints: 5000 });
    const bootstrapRes = await niceBackendFetch("/api/v1/feature-flags/bootstrap", {
      method: "GET",
      accessType: "server",
    });
    expect(bootstrapRes.status).toBe(200);
    expect(bootstrapRes.body.config.flags["my-flag"].variants).toMatchObject({
      control: { value: false },
      treatment: { value: false },
    });
    expect(bootstrapRes.body.config.flags["my-flag"].rules[`experiment_${createRes.body.id}`]).toMatchObject({
      rolloutBasisPoints: 10000,
      variantWeights: { control: 5000, treatment: 5000 },
      variantValues: { control: false, treatment: true },
    });
  });
});

describe("experiment run revisions", () => {
  it("creates an immediately-running successor and completes the predecessor", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);
    const oldRunId = createRes.body.id;
    expect((await transitionRun(oldRunId, "start")).status).toBe(200);
    const oldHash = createRes.body.config_revision_hash;

    const revisedConfig = { ...validExperimentConfig(), traffic_allocation_basis_points: 5000 };
    await updateFeatureFlagConfig({ trafficAllocationBasisPoints: 5000 });
    const revisionRes = await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/${EXPERIMENT_ID}/runs/${oldRunId}/revision`, {
      method: "POST",
      accessType: "admin",
      body: { experiment_config: revisedConfig },
    });
    expect(revisionRes.status).toBe(200);
    expect(revisionRes.body.state).toBe("running");
    expect(revisionRes.body.revision_number).toBe(2);
    expect(revisionRes.body.id).not.toBe(oldRunId);
    expect(revisionRes.body.config_revision_hash).not.toBe(oldHash);
    expect(revisionRes.body.config_snapshot.traffic_allocation_basis_points).toBe(5000);

    const listRes = await listRuns();
    expect(listRes.status).toBe(200);
    const oldRun = listRes.body.items.find((r: any) => r.id === oldRunId);
    expect(oldRun.state).toBe("completed");
    // The predecessor keeps its own frozen snapshot; its exposures/results
    // stay attached to the old revision hash.
    expect(oldRun.config_revision_hash).toBe(oldHash);
  });

  it("rejects revising a draft run with 409", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);

    const revisionRes = await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/${EXPERIMENT_ID}/runs/${createRes.body.id}/revision`, {
      method: "POST",
      accessType: "admin",
      body: { experiment_config: validExperimentConfig() },
    });
    expect(revisionRes.status).toBe(409);
    expect(revisionRes.body).toBe("Experiment run cannot be revised in its current state");
  });
});

describe("experiment run results", () => {
  async function getResults(runId: string) {
    return await niceBackendFetch(`/api/v1/internal/feature-flags/experiments/${EXPERIMENT_ID}/runs/${runId}/results`, {
      method: "GET",
      accessType: "admin",
    });
  }

  it("returns 400 for a draft run and result shape for a started run", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);
    const runId = createRes.body.id;

    const draftResultsRes = await getResults(runId);
    expect(draftResultsRes.status).toBe(400);
    expect(draftResultsRes.body).toBe("Experiment run has not started yet, so there are no results");

    expect((await transitionRun(runId, "start")).status).toBe(200);

    const resultsRes = await getResults(runId);
    expect(resultsRes.status).toBe(200);
    expect(resultsRes.body.srm).toEqual({ detected: false, statistic: null, p_value: null });
    expect(resultsRes.body.winner).toEqual({ status: "no_winner", reason: "insufficient_data" });
    expect(resultsRes.body.winner_rollout).toBe(null);
  });

  it("attributes a live evaluate-and-exposure cycle in results", async ({ expect }) => {
    await createProjectWithAnalytics();
    const createRes = await createRun();
    expect(createRes.status).toBe(201);
    expect((await transitionRun(createRes.body.id, "start")).status).toBe(200);

    await Auth.Otp.signIn();
    const evaluated = await niceBackendFetch("/api/v1/feature-flags/evaluate", {
      method: "POST",
      accessType: "client",
      body: { flag_keys: ["my-flag"], fallbacks: { "my-flag": false } },
    });
    expect(evaluated.status).toBe(200);
    const result = evaluated.body.results["my-flag"];
    expect(result.experiment_id).toBe(EXPERIMENT_ID);
    expect(result.experiment_run_id).toBe(createRes.body.id);
    expect(typeof result.exposure_token).toBe("string");
    expect(["control", "treatment"]).toContain(result.variant_key);

    const now = Date.now();
    const exposure = await niceBackendFetch("/api/v1/feature-flags/exposures/batch", {
      method: "POST",
      accessType: "client",
      body: {
        batch_id: randomUUID(),
        exposures: [{
          event_id: randomUUID(),
          exposure_token: result.exposure_token,
          exposed_at_ms: now,
        }],
      },
    });
    expect(exposure.status).toBe(200);
    expect(exposure.body).toEqual({ inserted: 1, dropped: 0 });

    const conversion = await niceBackendFetch("/api/v1/analytics/events/batch", {
      method: "POST",
      accessType: "client",
      body: {
        session_replay_segment_id: randomUUID(),
        batch_id: randomUUID(),
        sent_at_ms: now + 1_000,
        events: [{ event_type: "signed-up", event_at_ms: now + 500, data: {} }],
      },
    });
    expect(conversion.status).toBe(200);
    expect(conversion.body.inserted).toBeGreaterThanOrEqual(1);

    // Both the exposure and the conversion are async ClickHouse inserts that
    // flush independently, so the results can briefly show the exposure without
    // the conversion. Poll until the variant is both exposed and converted.
    const findPrimaryVariant = (body: any) => body.metrics
      .find((metric: { metric_id: string }) => metric.metric_id === "signup")
      ?.variants.find((variant: { variant_id: string }) => variant.variant_id === result.variant_key);
    const deadline = performance.now() + 10_000;
    let resultsRes = await getResults(createRes.body.id);
    while (performance.now() < deadline) {
      if (resultsRes.status === 200 && resultsRes.body.total_exposed_subjects >= 1 && (findPrimaryVariant(resultsRes.body)?.converted_subjects ?? 0) >= 1) break;
      await wait(200);
      resultsRes = await getResults(createRes.body.id);
    }
    expect(resultsRes.status).toBe(200);
    expect(resultsRes.body.total_exposed_subjects).toBeGreaterThanOrEqual(1);
    expect(resultsRes.body.exposed_subjects_by_variant[result.variant_key]).toBeGreaterThanOrEqual(1);
    expect(resultsRes.body.metrics.find((metric: { metric_id: string }) => metric.metric_id === "signup")).toMatchObject({
      metric_id: "signup",
      role: "primary",
      kind: "binary",
    });
    expect(findPrimaryVariant(resultsRes.body)?.converted_subjects).toBeGreaterThanOrEqual(1);
  });
});

describe("experiment schedule processor", () => {
  // The e2e environment configures the backend with CRON_SECRET=mock_cron_secret
  // (same invocation pattern as the email-queue-step and failed-emails-digest
  // cron tests).
  const cronHeaders = { "Authorization": "Bearer mock_cron_secret" };

  it("rejects invalid cron authorization", async ({ expect }) => {
    const res = await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: { "Authorization": "Bearer some_invalid_secret" },
    });
    expect(res).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": "Invalid cron authorization",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("starts runs whose scheduled start time has passed, idempotently", async ({ expect }) => {
    const scheduledStartMillis = Date.now() - 60_000;
    await createProjectWithAnalytics({ startsAt: new Date(scheduledStartMillis).toISOString() });

    const createRes = await createRun({
      ...validExperimentConfig(),
      schedule: { start_at_millis: scheduledStartMillis },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.state).toBe("draft");
    expect(createRes.body.scheduled_start_at_millis).toEqual(expect.any(Number));
    const runId = createRes.body.id;

    const firstProcessRes = await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: cronHeaders,
    });
    expect(firstProcessRes.status).toBe(200);
    // The processor is global, so parallel test workers may contribute
    // additional started/completed runs; at minimum ours must be included.
    expect(firstProcessRes.body.started).toBeGreaterThanOrEqual(1);

    const listRes = await listRuns();
    expect(listRes.status).toBe(200);
    const run = listRes.body.items.find((r: any) => r.id === runId);
    expect(run.state).toBe("running");
    expect(run.started_at_millis).toEqual(expect.any(Number));

    // Idempotency: a second invocation must not touch the already-started run.
    // (The global started count can't be asserted to be 0 because other test
    // workers may have scheduled runs of their own, so assert on the run.)
    const secondProcessRes = await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: cronHeaders,
    });
    expect(secondProcessRes.status).toBe(200);

    const secondListRes = await listRuns();
    expect(secondListRes.status).toBe(200);
    const runAfterSecondProcess = secondListRes.body.items.find((r: any) => r.id === runId);
    expect(runAfterSecondProcess.state).toBe("running");
    expect(runAfterSecondProcess.started_at_millis).toBe(run.started_at_millis);
  });

  it("leaves scheduled runs in draft while a required app is disabled", async ({ expect }) => {
    // The e2e environment runs the schedule processor as a background cron, so a
    // past start time is only ever published together with a disabled app; with
    // both apps enabled the schedule is kept in the future. Otherwise the cron
    // could start the run in the gap between two config updates.
    const futureStart = { startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    const pastStart = { startsAt: new Date(Date.now() - 60_000).toISOString() };
    await createProjectWithAnalytics(futureStart);
    const createRes = await createRun({
      ...validExperimentConfig(),
      schedule: { start_at_millis: new Date(futureStart.startsAt).getTime() },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.state).toBe("draft");

    await updateFeatureFlagConfig(pastStart, false, true);
    expect((await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: cronHeaders,
    })).status).toBe(200);
    await updateFeatureFlagConfig(futureStart, true, true);
    expect((await listRuns()).body.items.find((run: any) => run.id === createRes.body.id).state).toBe("draft");

    await updateFeatureFlagConfig(pastStart, true, false);
    expect((await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: cronHeaders,
    })).status).toBe(200);
    await updateFeatureFlagConfig(futureStart, true, true);
    expect((await listRuns()).body.items.find((run: any) => run.id === createRes.body.id).state).toBe("draft");
  });

  it("reconciles cancellation and postponement from current branch config", async ({ expect }) => {
    // Create and start an unschedulable blocking run first. createRun() submits
    // the current branch definition, so a past startsAt here would 400 (the
    // submitted snapshot would omit the published schedule) and would also let
    // the background cron start later due drafts. One active run per experiment
    // keeps those drafts in DRAFT so this test only observes reconciliation.
    await createProjectWithAnalytics();
    const blockingRun = await createRun();
    expect(blockingRun.status).toBe(201);
    expect((await transitionRun(blockingRun.body.id, "start")).status).toBe(200);

    const originalStartMillis = Date.now() - 60_000;
    await updateFeatureFlagConfig({ startsAt: new Date(originalStartMillis).toISOString() });

    const cancelledRun = await createRun({
      ...validExperimentConfig(),
      schedule: { start_at_millis: originalStartMillis },
    });
    expect(cancelledRun.status).toBe(201);

    await updateFeatureFlagConfig();
    expect((await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: cronHeaders,
    })).status).toBe(200);
    const cancelled = (await listRuns()).body.items.find((run: any) => run.id === cancelledRun.body.id);
    expect(cancelled.state).toBe("draft");
    expect(cancelled.scheduled_start_at_millis).toBeNull();

    const postponedStartMillis = Date.now() + 60 * 60 * 1000;
    await updateFeatureFlagConfig({ startsAt: new Date(originalStartMillis).toISOString() });
    const postponedRun = await createRun({
      ...validExperimentConfig(),
      schedule: { start_at_millis: originalStartMillis },
    });
    expect(postponedRun.status).toBe(201);
    await updateFeatureFlagConfig({ startsAt: new Date(postponedStartMillis).toISOString() });
    expect((await niceBackendFetch("/api/v1/internal/feature-flags/experiment-schedule-processor", {
      method: "GET",
      headers: cronHeaders,
    })).status).toBe(200);
    const postponed = (await listRuns()).body.items.find((run: any) => run.id === postponedRun.body.id);
    expect(postponed.state).toBe("draft");
    expect(postponed.scheduled_start_at_millis).toBe(postponedStartMillis);
  });
});
