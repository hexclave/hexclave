import { describe, expect, it } from "vitest";
import {
  createTvPaymentEvaluatorState,
  evaluateTvSubscriptionCollection,
  selectTvSubscriptionInvoiceOutcome,
  TV_PAYMENT_RULE_VERSION,
  type TvPaymentSample,
  type TvPaymentEvaluatorState,
} from "./event-evaluators";
import { getTvPaymentEvidenceWindow, readTvPaymentState } from "./events";

const now = new Date("2026-08-14T12:00:00.000Z");

function sample(options: {
  outcomes: number,
  failures: number,
  baseline?: number | null,
  evaluatedAt?: Date,
  baselineComputedAt?: Date,
  current?: { outcomes: number, failures: number },
  lowVolume?: { outcomes: number, failures: number },
}): TvPaymentSample {
  const evaluatedAt = options.evaluatedAt ?? now;
  const window = (hours: number, values: { outcomes: number, failures: number }) => ({
    startsAt: new Date(evaluatedAt.getTime() - hours * 60 * 60 * 1000).toISOString(),
    endsAt: evaluatedAt.toISOString(),
    outcomes: values.outcomes,
    successes: values.outcomes - values.failures,
    failures: values.failures,
    successRatePercent: values.outcomes === 0 ? null : (values.outcomes - values.failures) / values.outcomes * 100,
  });
  return {
    status: "fresh",
    evaluatedAt: evaluatedAt.toISOString(),
    observedAt: evaluatedAt.toISOString(),
    current: window(24, options.current ?? { outcomes: options.outcomes, failures: options.failures }),
    lowVolume: window(14 * 24, options.lowVolume ?? { outcomes: options.outcomes, failures: options.failures }),
    baseline: options.baseline === undefined ? null : {
      computedAt: (options.baselineComputedAt ?? evaluatedAt).toISOString(),
      qualifiedWeeks: 4,
      assessableOutcomes: 40,
      medianSuccessRatePercent: options.baseline,
    },
  };
}

describe("subscription collection evaluator", () => {
  it("selects only the latest authoritative outcome with deterministic ties", () => {
    const failure = new Date("2026-08-13T10:00:00.000Z");
    const paid = new Date("2026-08-13T11:00:00.000Z");
    expect(selectTvSubscriptionInvoiceOutcome({ paidAt: paid, markedUncollectibleAt: failure, voidedAt: null })).toEqual({ type: "success", at: paid });
    expect(selectTvSubscriptionInvoiceOutcome({ paidAt: null, markedUncollectibleAt: failure, voidedAt: new Date("2026-08-13T12:00:00.000Z") })).toBeNull();
    expect(selectTvSubscriptionInvoiceOutcome({ paidAt: paid, markedUncollectibleAt: paid, voidedAt: paid })).toEqual({ type: "success", at: paid });
  });
  it("does not activate from one failed collection", () => {
    expect(evaluateTvSubscriptionCollection(createTvPaymentEvaluatorState(), sample({ outcomes: 1, failures: 1 })).action).toEqual({ type: "none" });
  });

  it("uses the strict fallback without qualified history", () => {
    const result = evaluateTvSubscriptionCollection(createTvPaymentEvaluatorState(), sample({ outcomes: 10, failures: 5 }));
    expect(result.qualification).toBe("strict");
    expect(result.action).toEqual({ type: "none" });
  });

  it("qualifies critical degradation relative to project history", () => {
    const result = evaluateTvSubscriptionCollection(createTvPaymentEvaluatorState(), sample({ outcomes: 10, failures: 5, baseline: 99 }));
    expect(result.qualification).toBe("critical");
    expect(result.state.candidate?.presentationClass).toBe("critical-incident");
  });

  it("requires thirty observed minutes for a low-volume critical breach", () => {
    let state = createTvPaymentEvaluatorState();
    let action: ReturnType<typeof evaluateTvSubscriptionCollection>["action"] = { type: "none" };
    for (let minute = 0; minute <= 5; minute += 1) {
      const result = evaluateTvSubscriptionCollection(state, sample({
        outcomes: 0,
        failures: 0,
        baseline: 99,
        lowVolume: { outcomes: 5, failures: 4 },
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      }));
      state = result.state;
      action = result.action;
    }
    expect(action).toEqual({ type: "none" });
    for (let minute = 6; minute <= 30; minute += 1) {
      const result = evaluateTvSubscriptionCollection(state, sample({
        outcomes: 0,
        failures: 0,
        baseline: 99,
        lowVolume: { outcomes: 5, failures: 4 },
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      }));
      state = result.state;
      action = result.action;
    }
    expect(action).toEqual({ type: "activate", presentationClass: "critical-incident" });
    expect(state.activeClass).toBe("critical-incident");
  });

  it("keeps the current-window critical breach at five observed minutes", () => {
    let state = createTvPaymentEvaluatorState();
    let action: ReturnType<typeof evaluateTvSubscriptionCollection>["action"] = { type: "none" };
    for (let minute = 0; minute <= 5; minute += 1) {
      const result = evaluateTvSubscriptionCollection(state, sample({
        outcomes: 10,
        failures: 5,
        baseline: 99,
        lowVolume: { outcomes: 0, failures: 0 },
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      }));
      state = result.state;
      action = result.action;
    }
    expect(action).toEqual({ type: "activate", presentationClass: "critical-incident" });
  });

  it("resets activation persistence when critical evidence switches windows", () => {
    let currentState = createTvPaymentEvaluatorState();
    for (let minute = 0; minute <= 4; minute += 1) {
      currentState = evaluateTvSubscriptionCollection(currentState, sample({
        outcomes: 10,
        failures: 5,
        baseline: 99,
        lowVolume: { outcomes: 0, failures: 0 },
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      })).state;
    }
    const lowVolumeSwitch = evaluateTvSubscriptionCollection(currentState, sample({
      outcomes: 0,
      failures: 0,
      baseline: 99,
      lowVolume: { outcomes: 5, failures: 4 },
      evaluatedAt: new Date(now.getTime() + 5 * 60_000),
    }));
    expect(lowVolumeSwitch.state.candidate).toEqual({
      rulePath: "low-volume-critical",
      presentationClass: "critical-incident",
      accumulatedMs: 0,
    });

    let lowVolumeState = createTvPaymentEvaluatorState();
    for (let minute = 0; minute <= 4; minute += 1) {
      lowVolumeState = evaluateTvSubscriptionCollection(lowVolumeState, sample({
        outcomes: 0,
        failures: 0,
        baseline: 99,
        lowVolume: { outcomes: 5, failures: 4 },
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      })).state;
    }
    const currentSwitch = evaluateTvSubscriptionCollection(lowVolumeState, sample({
      outcomes: 10,
      failures: 5,
      baseline: 99,
      lowVolume: { outcomes: 0, failures: 0 },
      evaluatedAt: new Date(now.getTime() + 5 * 60_000),
    }));
    expect(currentSwitch.state.candidate).toEqual({
      rulePath: "critical",
      presentationClass: "critical-incident",
      accumulatedMs: 0,
    });
  });

  it("resets escalation persistence when critical evidence switches windows", () => {
    const currentState: TvPaymentEvaluatorState = {
      ...createTvPaymentEvaluatorState({ activeClass: "incident" }),
      lastFreshEvaluatedAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
      candidate: { rulePath: "critical", presentationClass: "critical-incident", accumulatedMs: 4 * 60_000 },
    };
    const lowVolumeSwitch = evaluateTvSubscriptionCollection(currentState, sample({
      outcomes: 0,
      failures: 0,
      baseline: 99,
      lowVolume: { outcomes: 5, failures: 4 },
      evaluatedAt: new Date(now.getTime() + 5 * 60_000),
    }));
    expect(lowVolumeSwitch.action).toEqual({ type: "none" });
    expect(lowVolumeSwitch.state.candidate).toEqual({
      rulePath: "low-volume-critical",
      presentationClass: "critical-incident",
      accumulatedMs: 0,
    });

    const lowVolumeState: TvPaymentEvaluatorState = {
      ...createTvPaymentEvaluatorState({ activeClass: "incident" }),
      lastFreshEvaluatedAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
      candidate: { rulePath: "low-volume-critical", presentationClass: "critical-incident", accumulatedMs: 4 * 60_000 },
    };
    const currentSwitch = evaluateTvSubscriptionCollection(lowVolumeState, sample({
      outcomes: 10,
      failures: 5,
      baseline: 99,
      lowVolume: { outcomes: 0, failures: 0 },
      evaluatedAt: new Date(now.getTime() + 5 * 60_000),
    }));
    expect(currentSwitch.action).toEqual({ type: "none" });
    expect(currentSwitch.state.candidate).toEqual({
      rulePath: "critical",
      presentationClass: "critical-incident",
      accumulatedMs: 0,
    });
  });

  it("preserves the new payment rule path and resets version-one state", () => {
    const currentState = createTvPaymentEvaluatorState();
    const persisted: TvPaymentEvaluatorState = {
      ...currentState,
      candidate: { rulePath: "low-volume-critical", presentationClass: "critical-incident", accumulatedMs: 12_000 },
    };
    expect(readTvPaymentState(persisted, null).candidate).toEqual(persisted.candidate);
    expect(readTvPaymentState({
      ruleVersion: 1,
      candidate: persisted.candidate,
    }, null).candidate).toBeNull();
    expect(readTvPaymentState({
      ruleVersion: 1,
      candidate: persisted.candidate,
    }, null).ruleVersion).toBe(TV_PAYMENT_RULE_VERSION);
  });

  it("uses the low-volume evidence window for low-volume critical breaches", () => {
    const paymentSample = sample({
      outcomes: 10,
      failures: 5,
      lowVolume: { outcomes: 5, failures: 4 },
    });
    expect(getTvPaymentEvidenceWindow("low-volume-critical", paymentSample)).toBe(paymentSample.lowVolume);
    expect(getTvPaymentEvidenceWindow("critical", paymentSample)).toBe(paymentSample.current);
  });

  it("freezes candidate accumulation for unavailable evidence", () => {
    const state = createTvPaymentEvaluatorState();
    state.candidate = { rulePath: "standard", presentationClass: "incident", accumulatedMs: 60_000 };
    const unavailable = { ...sample({ outcomes: 10, failures: 3, baseline: 99 }), status: "error" as const, current: null, lowVolume: null };
    expect(evaluateTvSubscriptionCollection(state, unavailable).state.candidate).toEqual(state.candidate);
  });

  it("freezes candidate accumulation for borderline fresh evidence", () => {
    const state = createTvPaymentEvaluatorState();
    state.candidate = { rulePath: "standard", presentationClass: "incident", accumulatedMs: 60_000 };
    expect(evaluateTvSubscriptionCollection(state, sample({ outcomes: 10, failures: 1, baseline: 99 })).state.candidate).toEqual(state.candidate);
  });

  it("does not credit an unobserved polling gap toward activation", () => {
    const first = evaluateTvSubscriptionCollection(
      createTvPaymentEvaluatorState(),
      sample({ outcomes: 10, failures: 3, baseline: 99 }),
    );
    const afterGap = evaluateTvSubscriptionCollection(first.state, sample({
      outcomes: 10,
      failures: 3,
      baseline: 99,
      evaluatedAt: new Date(now.getTime() + 30 * 60_000),
    }));
    expect(afterGap.state.candidate?.accumulatedMs).toBe(60_000);
    expect(afterGap.action).toEqual({ type: "none" });
  });

  it("falls back to strict rules when the project baseline is stale", () => {
    const result = evaluateTvSubscriptionCollection(createTvPaymentEvaluatorState(), sample({
      outcomes: 10,
      failures: 5,
      baseline: 99,
      baselineComputedAt: new Date(now.getTime() - 13 * 60 * 60_000),
    }));
    expect(result.qualification).toBe("strict");
    expect(result.state.candidate).toEqual({
      rulePath: "strict",
      presentationClass: "incident",
      accumulatedMs: 0,
    });
  });

  it("activates only after ten observed minutes of standard degradation", () => {
    let state = createTvPaymentEvaluatorState();
    let action: ReturnType<typeof evaluateTvSubscriptionCollection>["action"] = { type: "none" };
    for (let minute = 0; minute <= 10; minute += 1) {
      const result = evaluateTvSubscriptionCollection(state, sample({
        outcomes: 10,
        failures: 3,
        baseline: 99,
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      }));
      state = result.state;
      action = result.action;
    }
    expect(action).toEqual({ type: "activate", presentationClass: "incident" });
    expect(state.activeClass).toBe("incident");
  });

  it("resolves an active incident only after thirty observed healthy minutes", () => {
    let state = createTvPaymentEvaluatorState({ activeClass: "incident" });
    let action: ReturnType<typeof evaluateTvSubscriptionCollection>["action"] = { type: "none" };
    for (let minute = 0; minute <= 30; minute += 1) {
      const result = evaluateTvSubscriptionCollection(state, sample({
        outcomes: 10,
        failures: 0,
        baseline: 99,
        evaluatedAt: new Date(now.getTime() + minute * 60_000),
      }));
      state = result.state;
      action = result.action;
    }
    expect(action).toEqual({ type: "resolve" });
    expect(state.activeClass).toBeNull();
  });
});
