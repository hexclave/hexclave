import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { describe, expect, it } from "vitest";
import { computeExperimentConfigRevisionHash, validateExperimentConfig } from "./experiment-config";

const validConfig = () => ({
  flag_id: "my-flag",
  assignment_unit: "user",
  traffic_allocation_basis_points: 10000,
  control_variant_id: "control",
  variants: {
    control: { weight_basis_points: 5000, flag_value: false },
    treatment: { weight_basis_points: 5000, flag_value: true },
  },
  primary_metric: { id: "signup", kind: "binary", event_name: "signed-up", direction: "increase" },
  attribution_window_seconds: 7 * 24 * 60 * 60,
});

describe("validateExperimentConfig", () => {
  it("accepts a minimal valid config and normalizes optional lists", async () => {
    const config = await validateExperimentConfig(validConfig());
    expect(config.flag_id).toBe("my-flag");
    expect(config.secondary_metrics).toEqual([]);
    expect(config.guardrail_metrics).toEqual([]);
    expect(config.primary_metric).toEqual({ id: "signup", kind: "binary", event_name: "signed-up", direction: "increase" });
  });

  it("accepts numeric and funnel metrics, hypothesis, and schedule", async () => {
    const config = await validateExperimentConfig({
      ...validConfig(),
      hypothesis: "Treatment increases signups",
      secondary_metrics: [{ id: "revenue", kind: "numeric", event_name: "purchase", direction: "increase", property_name: "value", aggregation: "sum" }],
      guardrail_metrics: [{ id: "checkout", kind: "funnel", steps: ["add-to-cart", "checkout", "purchase"], direction: "increase" }],
      schedule: { start_at_millis: 1000, end_at_millis: 2000 },
    });
    expect(config.hypothesis).toBe("Treatment increases signups");
    expect(config.guardrail_metrics[0]).toEqual({ id: "checkout", kind: "funnel", steps: ["add-to-cart", "checkout", "purchase"], direction: "increase" });
    expect(config.schedule).toEqual({ start_at_millis: 1000, end_at_millis: 2000 });
  });

  it("rejects weights that do not sum to 10000 basis points", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      variants: { control: { weight_basis_points: 5000, flag_value: false }, treatment: { weight_basis_points: 4000, flag_value: true } },
    })).rejects.toThrow(StatusError);
  });

  it("rejects fewer than two variants", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      control_variant_id: "control",
      variants: { control: { weight_basis_points: 10000, flag_value: false } },
    })).rejects.toThrow(StatusError);
  });

  it("rejects experiments with fewer than two positive-weight variants", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      variants: {
        control: { weight_basis_points: 10000, flag_value: false },
        treatment: { weight_basis_points: 0, flag_value: true },
      },
    })).rejects.toThrow("Experiments must define at least two variants with positive weights");
  });

  it("rejects a zero-weight control even when two treatments have positive weights", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      variants: {
        control: { weight_basis_points: 0, flag_value: false },
        treatment_a: { weight_basis_points: 5000, flag_value: true },
        treatment_b: { weight_basis_points: 5000, flag_value: "alternative" },
      },
    })).rejects.toThrow("The control variant must have a positive weight");
  });

  it("rejects a control_variant_id that is not a variant", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      control_variant_id: "nonexistent",
    })).rejects.toThrow(StatusError);
  });

  it("rejects a control_variant_id that only exists on Object.prototype", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      control_variant_id: "toString",
    })).rejects.toThrow(/not a key of variants/);
  });

  it("accepts team assignment units", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      assignment_unit: "team",
    })).resolves.toMatchObject({ assignment_unit: "team" });
  });

  it("validates page-view and click filters in frozen binary metrics", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      primary_metric: {
        id: "page",
        kind: "binary",
        event_name: "$page-view",
        direction: "increase",
        event_filter: { field: "path", operator: "starts_with", value: "/pricing" },
      },
    })).resolves.toMatchObject({
      primary_metric: { event_filter: { field: "path", operator: "starts_with", value: "/pricing" } },
    });
  });

  it("allows page-view metrics but rejects other reserved event names", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      primary_metric: { id: "page", kind: "binary", event_name: "$page-view", direction: "increase" },
    })).resolves.toBeDefined();
    await expect(validateExperimentConfig({
      ...validConfig(),
      primary_metric: { id: "bad", kind: "binary", event_name: "$session-replay", direction: "increase" },
    })).rejects.toThrow(StatusError);
  });

  it("rejects duplicate metric ids across roles", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      secondary_metrics: [{ id: "signup", kind: "numeric", event_name: "purchase", direction: "increase", property_name: "value", aggregation: "sum" }],
    })).rejects.toThrow(StatusError);
  });

  it("rejects an inverted schedule", async () => {
    await expect(validateExperimentConfig({
      ...validConfig(),
      schedule: { start_at_millis: 2000, end_at_millis: 1000 },
    })).rejects.toThrow(StatusError);
  });

  it("rejects out-of-range traffic allocation and attribution window", async () => {
    await expect(validateExperimentConfig({ ...validConfig(), traffic_allocation_basis_points: 10001 })).rejects.toThrow(StatusError);
    await expect(validateExperimentConfig({ ...validConfig(), traffic_allocation_basis_points: 0.5 })).rejects.toThrow(StatusError);
    await expect(validateExperimentConfig({ ...validConfig(), attribution_window_seconds: 0 })).rejects.toThrow(StatusError);
    await expect(validateExperimentConfig({ ...validConfig(), attribution_window_seconds: 90 * 24 * 60 * 60 + 1 })).rejects.toThrow(StatusError);
  });

  it("rejects unknown top-level fields and funnels with fewer than two steps", async () => {
    await expect(validateExperimentConfig({ ...validConfig(), surprise: true })).rejects.toThrow(StatusError);
    await expect(validateExperimentConfig({
      ...validConfig(),
      primary_metric: { id: "funnel", kind: "funnel", steps: ["only-one"], direction: "increase" },
    })).rejects.toThrow(StatusError);
  });

  it("rejects non-object input with a 400 (not an internal error)", async () => {
    for (const bad of [null, undefined, 42, "config", []]) {
      let thrown: unknown;
      try {
        await validateExperimentConfig(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StatusError);
      if (thrown instanceof StatusError) expect(thrown.statusCode).toBe(400);
    }
  });
});

describe("computeExperimentConfigRevisionHash", () => {
  it("is stable under key reordering", async () => {
    const a = await validateExperimentConfig(validConfig());
    const reordered = await validateExperimentConfig({
      attribution_window_seconds: 7 * 24 * 60 * 60,
      primary_metric: { direction: "increase", event_name: "signed-up", kind: "binary", id: "signup" },
      variants: {
        treatment: { flag_value: true, weight_basis_points: 5000 },
        control: { weight_basis_points: 5000, flag_value: false },
      },
      control_variant_id: "control",
      traffic_allocation_basis_points: 10000,
      assignment_unit: "user",
      flag_id: "my-flag",
    });
    expect(computeExperimentConfigRevisionHash(reordered)).toBe(computeExperimentConfigRevisionHash(a));
  });

  it("changes when any semantic field changes", async () => {
    const base = computeExperimentConfigRevisionHash(await validateExperimentConfig(validConfig()));
    const changedWeights = computeExperimentConfigRevisionHash(await validateExperimentConfig({
      ...validConfig(),
      variants: { control: { weight_basis_points: 6000, flag_value: false }, treatment: { weight_basis_points: 4000, flag_value: true } },
    }));
    const changedWindow = computeExperimentConfigRevisionHash(await validateExperimentConfig({
      ...validConfig(),
      attribution_window_seconds: 14 * 24 * 60 * 60,
    }));
    expect(changedWeights).not.toBe(base);
    expect(changedWindow).not.toBe(base);
  });

  it("produces 64-character lowercase hex", async () => {
    const hash = computeExperimentConfigRevisionHash(await validateExperimentConfig(validConfig()));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
