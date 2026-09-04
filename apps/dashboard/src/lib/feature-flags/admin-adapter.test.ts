import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { describe, expect, it, vi } from "vitest";
import { evaluateFlagWithoutExposure, FeatureFlagsBackendUnavailableError, getExperimentResults, getExperimentRun, listExperimentRuns, transitionExperimentRun } from "./admin-adapter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeRun(state: "draft" | "running" | "paused" | "completed" = "running") {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    experiment_id: "experiment-1",
    revision_number: 1,
    config_revision_hash: "revision",
    config_snapshot: {
      control_variant_id: "control",
      variants: { control: { weight_basis_points: 5000 }, treatment: { weight_basis_points: 5000 } },
    },
    state,
    scheduled_start_at_millis: null,
    scheduled_end_at_millis: null,
    started_at_millis: state === "draft" ? null : 1782864000000,
    paused_at_millis: null,
    completed_at_millis: null,
    created_by_user_id: null,
    created_at_millis: 1782864000000,
  };
}

function makeAdminApp(responder: (path: string, init: RequestInit) => Response) {
  const sendRequest = vi.fn(async (path: string, init: RequestInit, _requestType?: "client" | "server" | "admin") => responder(path, init));
  return { app: { [hexclaveAppInternalsSymbol]: { sendRequest } }, sendRequest };
}

describe("feature flags admin adapter", () => {
  it("uses the nested experiment-run route and parses the backend run shape", async () => {
    const { app, sendRequest } = makeAdminApp(() => jsonResponse({ items: [makeRun("draft")] }));
    const runs = await listExperimentRuns(app, ["experiment-1"]);
    expect(runs).toMatchInlineSnapshot(`
      [
        {
          "completedAtIso": null,
          "experimentId": "experiment-1",
          "runId": "00000000-0000-4000-8000-000000000001",
          "startedAtIso": null,
          "status": "draft",
        },
      ]
    `);
    expect(sendRequest.mock.calls[0]?.[0]).toBe("/internal/feature-flags/experiments/experiment-1/runs");
  });

  it("models a configured experiment without a run as not started", async () => {
    const { app, sendRequest } = makeAdminApp(() => jsonResponse({ items: [] }));
    const run = await getExperimentRun(app, "experiment-1");
    expect(run).toMatchInlineSnapshot(`
      {
        "completedAtIso": null,
        "experimentId": "experiment-1",
        "runId": null,
        "startedAtIso": null,
        "status": "not_started",
      }
    `);
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it("loads running lifecycle metadata without requesting analytical results", async () => {
    const { app, sendRequest } = makeAdminApp((path) => {
      if (!path.endsWith("/runs")) throw new Error(`Unexpected results request: ${path}`);
      return jsonResponse({ items: [makeRun("running")] });
    });

    await expect(getExperimentRun(app, "experiment-1")).resolves.toMatchObject({ status: "running" });
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it("does not request results before a run starts", async () => {
    const { app, sendRequest } = makeAdminApp(() => jsonResponse({ items: [makeRun("draft")] }));
    await expect(getExperimentResults(app, "experiment-1", {})).resolves.toBeNull();
    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest.mock.calls[0]?.[0]).toBe("/internal/feature-flags/experiments/experiment-1/runs");
  });

  it("maps posterior means, relative lift, zero baselines, and winner rollout", async () => {
    const metricVariant = (options: {
      variantId: string,
      exposed: number,
      converted: number | null,
      sum: number | null,
      posteriorMean: number,
      lower: number,
      upper: number,
    }) => ({
      variant_id: options.variantId,
      exposed_subjects: options.exposed,
      converted_subjects: options.converted,
      sum_values: options.sum,
      posterior_mean: options.posteriorMean,
      credible_interval_95: { lower: options.lower, upper: options.upper },
      probability_best: options.variantId === "treatment" ? 0.96 : 0.04,
      is_guardrail_regression: null,
    });
    const resultsBody = {
      total_exposed_subjects: 400,
      exposed_subjects_by_variant: { control: 200, treatment: 200 },
      min_exposed_subjects_for_winner: 100,
      srm: { detected: false, statistic: 0, p_value: 1 },
      metrics: [{
        metric_id: "conversion",
        kind: "binary",
        role: "primary",
        direction: "increase",
        variants: [
          metricVariant({ variantId: "control", exposed: 200, converted: 40, sum: null, posteriorMean: 0.2, lower: 0.15, upper: 0.25 }),
          metricVariant({ variantId: "treatment", exposed: 200, converted: 60, sum: null, posteriorMean: 0.3, lower: 0.24, upper: 0.36 }),
        ],
      }, {
        metric_id: "revenue",
        kind: "numeric",
        role: "secondary",
        direction: "increase",
        variants: [
          metricVariant({ variantId: "control", exposed: 200, converted: null, sum: 0, posteriorMean: 0, lower: -0.5, upper: 0.5 }),
          metricVariant({ variantId: "treatment", exposed: 200, converted: null, sum: 1000, posteriorMean: 5, lower: 4.2, upper: 5.8 }),
        ],
      }],
      winner: { status: "winner", variant_id: "treatment", probability_best: 0.96 },
      winner_rollout: { flag_id: "flag", variant_id: "treatment", flag_value: { enabled: true } },
    };
    const { app } = makeAdminApp((path) => path.endsWith("/runs")
      ? jsonResponse({ items: [makeRun("completed")] })
      : jsonResponse(resultsBody));

    const results = await getExperimentResults(app, "experiment-1", {});
    expect(results?.controlVariantId).toBe("control");
    expect(results?.metrics[0]?.perVariant.map((variant) => [variant.variantId, variant.value, variant.liftVsControl])).toEqual([
      ["control", 40, 0],
      ["treatment", 60, 0.4999999999999999],
    ]);
    expect(results?.metrics[1]?.perVariant.map((variant) => [variant.variantId, variant.value, variant.credibleIntervalLow, variant.credibleIntervalHigh, variant.liftVsControl])).toEqual([
      ["control", 0, -0.5, 0.5, 0],
      ["treatment", 5, 4.2, 5.8, null],
    ]);
    expect(results?.winnerRollout).toEqual({ variantId: "treatment", flagValue: { enabled: true } });
  });

  it("loads the latest run before posting a transition", async () => {
    const { app, sendRequest } = makeAdminApp((path) => path.endsWith("/runs")
      ? jsonResponse({ items: [makeRun("running")] })
      : jsonResponse(makeRun("paused")));
    const run = await transitionExperimentRun(app, "experiment-1", "pause");
    expect(run.status).toBe("paused");
    expect(sendRequest.mock.calls[1]?.[0]).toBe("/internal/feature-flags/experiments/experiment-1/runs/00000000-0000-4000-8000-000000000001/pause");
  });

  it("maps unavailable routes to the explicit unavailable state", async () => {
    const { app } = makeAdminApp(() => new Response("missing", { status: 404 }));
    await expect(listExperimentRuns(app, ["experiment-1"])).rejects.toBeInstanceOf(FeatureFlagsBackendUnavailableError);
  });

  it("uses the exposure-free tester contract", async () => {
    const { app, sendRequest } = makeAdminApp(() => jsonResponse({ results: { checkout: {
      flag_key: "checkout", value: true, variant_key: "on", reason: "matched_rule", rule_id: "rule", config_version: "v1", experiment_id: null, experiment_run_id: null, exposure_token: null,
    } } }));
    const result = await evaluateFlagWithoutExposure(app, "checkout", {
      userId: "user-1", email: "user@example.com", teamId: null, environment: "production", customAttributes: new Map([["plan", "pro"]]),
    });
    expect(result).toEqual({ variantId: "on", jsonValue: "true", reason: "matched_rule", matchedRuleId: "rule" });
    const init = sendRequest.mock.calls[0][1];
    expect(init.body == null ? null : JSON.parse(init.body.toString())).toEqual({
      flag_keys: ["checkout"],
      user_id: "user-1",
      user: { email: "user@example.com" },
      context: { environment: "production", plan: "pro" },
    });
  });

  it("fails loudly when app internals are absent", async () => {
    await expect(listExperimentRuns({}, ["experiment-1"])).rejects.toThrowError(/internals/);
  });

  it("surfaces the backend error body for failed lifecycle requests", async () => {
    const { app } = makeAdminApp(() => jsonResponse("Another active run already targets this experiment or feature flag", 409));
    await expect(listExperimentRuns(app, ["experiment-1"])).rejects.toThrow("Another active run already targets this experiment or feature flag");
  });
});
