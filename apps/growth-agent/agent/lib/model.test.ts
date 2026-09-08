import { describe, expect, it } from "vitest";
import { getGrowthModelConfig } from "./model.ts";

describe("getGrowthModelConfig", () => {
  it("routes to the Vercel AI Gateway glm-5.2", () => {
    expect(getGrowthModelConfig().model).toBe("zai/glm-5.2");
  });

  it("turns reasoning off, because it was 62% of everything the model generated", () => {
    // Measured 2026-08-10 across a full run: 58,205 reasoning tokens vs 35,421 output tokens. This
    // is the single biggest lever left after provider routing was exhausted, so a silent revert to
    // provider-default would quietly undo the main speed fix.
    expect(getGrowthModelConfig().reasoning).toBe("none");
  });

  it("reaches every agent, since all four spread the whole config", () => {
    // The reasoning field is a SIBLING of modelOptions in eve's agent definition, so it only takes
    // effect because the call sites spread getGrowthModelConfig() rather than picking fields off it.
    expect(Object.keys(getGrowthModelConfig()).sort()).toEqual(["limits", "model", "modelOptions", "reasoning"]);
  });

  it("bounds total output and lifetime for every root and delegated session", () => {
    // Eve charges delegated subagent usage against the parent quota, so this one limit covers the
    // report-composer and the root report phase together instead of granting each an extra budget.
    expect(getGrowthModelConfig().limits).toEqual({
      maxOutputTokensPerSession: 80_000,
      sessionTimeoutMs: 45 * 60 * 1000,
    });
  });

  it("sends Z.AI's native thinking switch, which is what actually disables glm-5.2's reasoning", () => {
    // The generic `reasoning` field is NOT sufficient: the gateway only translates effort levels for
    // OpenAI/Anthropic/Google/Bedrock, so for a zai model it is accepted and dropped. Measured with
    // `reasoning: "none"` already set (2026-08-11, 150 requests): reasoning was still 64.0% of
    // generated tokens, versus a 62.2% baseline before the flag existed. This provider-native option
    // is the one Vercel documents as taking "full precedence", so losing it silently restores a
    // ~3x slower run.
    const providerOptions = getGrowthModelConfig().modelOptions.providerOptions;
    expect(providerOptions?.zai).toEqual({ thinking: { type: "disabled" } });
    // Keyed under the serving provider too: the model namespace is `zai` but requests route to
    // `wafer`, and the gateway docs are ambiguous about which name provider options match on.
    expect(providerOptions?.wafer).toEqual({ thinking: { type: "disabled" } });
  });

  it("keeps the gateway routing block intact alongside the thinking options", () => {
    // The thinking options are spread into the same providerOptions object as `gateway`, so a
    // careless edit could shadow the provider order. Both must survive together.
    const providerOptions = getGrowthModelConfig().modelOptions.providerOptions;
    expect(providerOptions?.gateway).toEqual({ order: ["wafer", "zai"] });
    expect(providerOptions?.zai).toEqual({ thinking: { type: "disabled" } });
  });

  it("prefers the fastest glm-5.2 providers, in order", () => {
    // Measured 2026-08-08: unpinned routing landed on `alibaba` at ~59 tok/s steady-state. Wafer
    // serves the same model at ~90 tok/s (measured 2026-08-11 over 150 requests, fit R^2=0.963) —
    // about 1.5x, NOT the ~8x the gateway catalog's headline 466 tps implied, which is why routing
    // alone never got the run under target. The ORDER is still the point of the test: asserting
    // membership would not catch a regression that puts the slower provider first.
    expect(getGrowthModelConfig().modelOptions).toMatchInlineSnapshot(`
      {
        "providerOptions": {
          "gateway": {
            "order": [
              "wafer",
              "zai",
            ],
          },
          "wafer": {
            "thinking": {
              "type": "disabled",
            },
          },
          "zai": {
            "thinking": {
              "type": "disabled",
            },
          },
        },
      }
    `);
  });

  it("applies no provider-compliance filter, because a measured run showed one costs ~7x throughput", () => {
    // `disallowPromptTraining: true` was tried on 2026-08-10 and silently excluded Wafer despite the
    // gateway catalog flagging it compliant: measured 65 tok/s (alibaba) instead of ~466 (Wafer).
    // Pinned as a test so re-adding either filter is a deliberate act with a re-measurement, not a
    // one-line "safety" tweak. See the comment in model.ts.
    const gateway = getGrowthModelConfig().modelOptions.providerOptions?.gateway;
    expect(gateway).not.toHaveProperty("disallowPromptTraining");
    expect(gateway).not.toHaveProperty("zeroDataRetention");
  });

  it("does not pin with `only`, so an outage degrades to a slow run rather than a failed one", () => {
    const gateway = getGrowthModelConfig().modelOptions.providerOptions?.gateway;
    expect(gateway).toBeDefined();
    expect(gateway).not.toHaveProperty("only");
  });
});
