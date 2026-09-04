import type { FeatureFlagEvaluateRequest, FeatureFlagEvaluateResponse, FeatureFlagExposureRequest } from "@hexclave/shared/dist/interface/crud/feature-flags";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagController, type FeatureFlagDetails } from "./feature-flags";

function responseFor(request: FeatureFlagEvaluateRequest, configVersion = "v1"): FeatureFlagEvaluateResponse {
  const results: FeatureFlagEvaluateResponse["results"] = {};
  for (const key of request.flag_keys) {
    results[key] = {
      flag_key: key,
      value: request.fallbacks?.[key] ?? null,
      variant_key: "control",
      reason: "fallback",
      rule_id: null,
      config_version: configVersion,
      experiment_id: "experiment-1",
      experiment_run_id: "run-1",
      exposure_token: `token-${key}-${configVersion}`,
    };
  }
  return { results };
}

describe("FeatureFlagController", () => {
  it("normalizes batch order without duplicating remote evaluations", async () => {
    const evaluate = vi.fn(async (_identity: string, request: FeatureFlagEvaluateRequest) => responseFor(request));
    const controller = new FeatureFlagController<string>({ evaluate, sendExposures: async () => {} });
    const identity = { cacheKey: "user-1", value: "session-1" };

    const first = await controller.getFeatureFlags(identity, [
      { key: "checkout", fallback: false, options: { exposure: "none" } },
      { key: "header", fallback: "control", options: { exposure: "none" } },
    ]);
    const second = await controller.getFeatureFlags(identity, [
      { key: "header", fallback: "control", options: { exposure: "none" } },
      { key: "checkout", fallback: false, options: { exposure: "none" } },
    ]);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect([...first.keys()]).toEqual(["checkout", "header"]);
    expect([...second.keys()]).toEqual(["checkout", "header"]);
  });

  it("returns the identical promise object for a cached result, before and after it settles", async () => {
    // React's use() only settles a suspended component if it is handed the
    // same promise object on every render; a fresh wrapper per call would
    // re-suspend forever once the evaluation rejects.
    const resolvedTeamIds: Array<string | null> = [];
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => responseFor(request),
      sendExposures: async () => {},
      onTeamContextResolved: (teamId) => resolvedTeamIds.push(teamId),
    });
    const identity = { cacheKey: "user-1", value: "session-1" };
    const requests = [{ key: "checkout", fallback: false, options: { exposure: "none" as const, teamId: "team-a" } }];

    const first = controller.getFeatureFlags(identity, requests);
    expect(controller.getFeatureFlags(identity, requests)).toBe(first);
    await first;
    expect(controller.getFeatureFlags(identity, requests)).toBe(first);
    await first;
    // The team-context side effect still fires once per call, cache hits included.
    expect(resolvedTeamIds).toEqual(["team-a", "team-a", "team-a"]);

    const failing = new FeatureFlagController<string>({
      evaluate: async () => {
        throw new Error("evaluation unavailable");
      },
      sendExposures: async () => {},
    });
    const rejected = failing.getFeatureFlags(identity, requests);
    expect(failing.getFeatureFlags(identity, requests)).toBe(rejected);
    await expect(rejected).rejects.toThrowError("evaluation unavailable");
  });

  it("keeps evaluation caches isolated when identity changes", async () => {
    const evaluate = vi.fn(async (_identity: string, request: FeatureFlagEvaluateRequest) => responseFor(request));
    const controller = new FeatureFlagController<string>({ evaluate, sendExposures: async () => {} });

    await controller.getFeatureFlag({ cacheKey: "user-1", value: "session-1" }, "checkout", false, { exposure: "none" });
    await controller.getFeatureFlag({ cacheKey: "user-2", value: "session-2" }, "checkout", false, { exposure: "none" });

    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("invalidates identity-scoped results when a newer config version is observed", async () => {
    const evaluate = vi.fn(async (_identity: string, request: FeatureFlagEvaluateRequest) => {
      return responseFor(request, request.flag_keys.includes("new-version-probe") ? "v2" : "v1");
    });
    const controller = new FeatureFlagController<string>({ evaluate, sendExposures: async () => {} });
    const identity = { cacheKey: "user-1", value: "session-1" };

    await controller.getFeatureFlag(identity, "checkout", false, { exposure: "none" });
    await controller.getFeatureFlag(identity, "new-version-probe", false, { exposure: "none" });
    await controller.getFeatureFlag(identity, "checkout", false, { exposure: "none" });

    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("supports bounded result caching for local server evaluation", async () => {
    let now = 0;
    const evaluate = vi.fn(async (_identity: string, request: FeatureFlagEvaluateRequest) => responseFor(request));
    const controller = new FeatureFlagController<string>({
      evaluate,
      sendExposures: async () => {},
      cacheTtlMillis: 30_000,
      now: () => now,
    });
    const identity = { cacheKey: "user-1", value: "session-1" };

    await controller.getFeatureFlag(identity, "checkout", false, { exposure: "none" });
    now = 29_999;
    await controller.getFeatureFlag(identity, "checkout", false, { exposure: "none" });
    now = 30_000;
    await controller.getFeatureFlag(identity, "checkout", false, { exposure: "none" });

    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("evicts old request caches instead of growing with every identity and context", async () => {
    const evaluate = vi.fn(async (_identity: string, request: FeatureFlagEvaluateRequest) => responseFor(request));
    const controller = new FeatureFlagController<string>({
      evaluate,
      sendExposures: async () => {},
      cacheMaxEntries: 2,
    });

    for (const key of ["one", "two", "three", "one"]) {
      await controller.getFeatureFlag({ cacheKey: "user-1", value: "session-1" }, key, false, { exposure: "none" });
    }

    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it("fails loudly when the server omits a requested key", async () => {
    const controller = new FeatureFlagController<string>({
      evaluate: async () => ({ results: {} }),
      sendExposures: async () => {},
    });

    await expect(controller.getFeatureFlag(
      { cacheKey: "user-1", value: "session-1" },
      "checkout",
      false,
    )).rejects.toThrowError('Feature flag evaluation response omitted "checkout".');
  });

  it("preserves generic fallback value types", async () => {
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => responseFor(request),
      sendExposures: async () => {},
    });

    const booleanValue: boolean = await controller.getFeatureFlag(
      { cacheKey: "user-1", value: "session-1" },
      "checkout",
      false,
      { exposure: "none" },
    );
    const objectValue: { color: Json } = await controller.getFeatureFlag(
      { cacheKey: "user-1", value: "session-1" },
      "theme",
      { color: "blue" },
      { exposure: "none" },
    );

    expect(booleanValue).toBe(false);
    expect(objectValue).toEqual({ color: "blue" });
  });

  it("records automatic exposures once and honors manual and none modes", async () => {
    const sent: string[][] = [];
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => responseFor(request),
      sendExposures: async (_identity, exposures) => {
        sent.push(exposures.map((exposure) => exposure.exposure_token));
      },
    });
    const identity = { cacheKey: "user-1", value: "session-1" };

    const automatic = await controller.getFeatureFlagDetails(identity, "auto", false);
    await controller.getFeatureFlagDetails(identity, "auto", false);
    const manual = await controller.getFeatureFlagDetails(identity, "manual", false, { exposure: "manual" });
    const none = await controller.getFeatureFlagDetails(identity, "none", false, { exposure: "none" });
    await controller.trackFeatureFlagExposure(identity, manual);
    await controller.trackFeatureFlagExposure(identity, manual);

    expect(automatic.exposureToken).toBe("token-auto-v1");
    expect(none.exposureToken).toBeNull();
    expect(sent).toEqual([["token-auto-v1"], ["token-manual-v1"]]);
  });

  it("deduplicates exposures independently for each selected team", async () => {
    const sent: string[] = [];
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => {
        const response = responseFor(request);
        const checkout = response.results.checkout;
        checkout.exposure_token = `token-${request.team_id ?? "user"}`;
        return response;
      },
      sendExposures: async (_identity, exposures) => {
        sent.push(...exposures.map((exposure) => exposure.exposure_token));
      },
    });
    const identity = { cacheKey: "user-1", value: "session-1" };

    await controller.getFeatureFlagDetails(identity, "checkout", false, { teamId: "team-a" });
    await controller.getFeatureFlagDetails(identity, "checkout", false, { teamId: "team-a" });
    await controller.getFeatureFlagDetails(identity, "checkout", false, { teamId: "team-b" });

    expect(sent).toEqual(["token-team-a", "token-team-b"]);
  });

  it("resolves analytics team context after evaluation without a React effect", async () => {
    const resolvedTeamIds: Array<string | null> = [];
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => responseFor(request),
      sendExposures: async () => {},
      onTeamContextResolved: (teamId) => resolvedTeamIds.push(teamId),
    });
    const identity = { cacheKey: "user-1", value: "session-1" };

    await controller.getFeatureFlagDetails(identity, "team-flag", false, { teamId: "team-a" });
    await controller.getFeatureFlagDetails(identity, "user-flag", false);
    await controller.getFeatureFlagDetails(identity, "team-flag", false, { teamId: "team-a" });

    expect(resolvedTeamIds).toEqual(["team-a", null, "team-a"]);
  });

  it("allows a failed exposure to retry", async () => {
    let attempts = 0;
    const sent: FeatureFlagExposureRequest[][] = [];
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => responseFor(request),
      sendExposures: async (_identity, exposures) => {
        attempts += 1;
        sent.push(exposures);
        if (attempts === 1) throw new TypeError("offline");
      },
    });
    const identity = { cacheKey: "user-1", value: "session-1" };
    const details: FeatureFlagDetails<Json> = {
      flagKey: "checkout",
      value: false,
      variantKey: "control",
      reason: "rule",
      ruleId: null,
      configVersion: "v1",
      experimentId: "experiment-1",
      experimentRunId: "run-1",
      isStale: false,
      exposureToken: "token",
    };

    await expect(controller.trackFeatureFlagExposure(identity, details)).rejects.toThrowError("offline");
    await controller.trackFeatureFlagExposure(identity, details);
    expect(attempts).toBe(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("rejects unbounded or non-serializable targeting context", async () => {
    const controller = new FeatureFlagController<string>({
      evaluate: async (_identity, request) => responseFor(request),
      sendExposures: async () => {},
    });
    const context: Record<string, Json> = {};
    for (let index = 0; index < 33; index += 1) context[`key-${index}`] = index;

    await expect(controller.getFeatureFlag(
      { cacheKey: "user-1", value: "session-1" },
      "checkout",
      false,
      { context },
    )).rejects.toThrowError("at most 32 attributes");
  });
});
