import { describe, expect, it } from "vitest";
import {
  calculateTvEmailEvidenceRate,
  createTvEmailEvaluatorState,
  createTvPaymentEvaluatorState,
  evaluateTvEmailDelivery,
  evaluateTvSubscriptionCollection,
  evaluateTvUserMilestone,
  median,
  TV_EMAIL_RECOVERY_TITLE,
  type TvEmailBaseline,
  type TvEmailEvaluationSample,
  type TvEmailEvaluatorState,
  type TvEmailEvidenceWindow,
  type TvPaymentSample,
  type TvPaymentEvaluatorState,
  type TvUserMilestoneEvaluatorState,
} from "./event-evaluators";

const baseline: TvEmailBaseline = {
  startsAt: "2026-07-01T00:00:00.000Z",
  endsAt: "2026-07-29T00:00:00.000Z",
  computedAt: "2026-07-29T12:00:00.000Z",
  assessableSends: 10_000,
  qualifiedDays: 28,
  days: [],
  medianDeliveryRatePercent: 99.7,
};

function windowAt(options: {
  assessable: number,
  failures: number,
  startsAt?: string,
  endsAt?: string,
}): TvEmailEvidenceWindow {
  const delivered = options.assessable - options.failures;
  const rates = calculateTvEmailEvidenceRate(delivered, options.failures);
  return {
    startsAt: options.startsAt ?? "2026-07-29T11:40:00.000Z",
    endsAt: options.endsAt ?? "2026-07-29T11:55:00.000Z",
    finishedSends: options.assessable,
    deliveredSends: delivered,
    bouncedSends: options.failures,
    serverErrorSends: 0,
    neutralOrUnknownSends: 0,
    explicitFailures: options.failures,
    ...rates,
  };
}

function sampleAt(minute: number, options?: {
  current?: TvEmailEvidenceWindow,
  lowVolume?: TvEmailEvidenceWindow,
  baseline?: TvEmailBaseline | null,
  status?: TvEmailEvaluationSample["status"],
}): TvEmailEvaluationSample {
  const evaluatedAt = new Date(Date.UTC(2026, 6, 29, 12, minute)).toISOString();
  return {
    status: options?.status ?? "fresh",
    evaluatedAt,
    observedAt: evaluatedAt,
    current: options?.current ?? windowAt({ assessable: 100, failures: 1 }),
    lowVolume: options?.lowVolume ?? windowAt({ assessable: 400, failures: 4 }),
    baseline: options != null && "baseline" in options ? options.baseline ?? null : baseline,
  };
}

function evaluateSequence(
  samples: TvEmailEvaluationSample[],
  initial = createTvEmailEvaluatorState(),
) {
  const first = samples.at(0);
  if (first == null) throw new Error("Email evaluator sequences require at least one sample.");
  let result = evaluateTvEmailDelivery(initial, first);
  let state = result.state;
  for (const sample of samples.slice(1)) {
    result = evaluateTvEmailDelivery(state, sample);
    state = result.state;
  }
  return result;
}

function paymentSampleAt(minute: number, options?: {
  current?: PaymentWindowValues,
  lowVolume?: PaymentWindowValues,
}): TvPaymentSample {
  const evaluatedAt = new Date(Date.UTC(2026, 6, 29, 12, minute)).toISOString();
  return {
    status: "fresh",
    evaluatedAt,
    observedAt: evaluatedAt,
    current: {
      startsAt: evaluatedAt,
      endsAt: evaluatedAt,
      ...(options?.current ?? { outcomes: 50, successes: 49, failures: 1, successRatePercent: 98 }),
    },
    lowVolume: {
      startsAt: evaluatedAt,
      endsAt: evaluatedAt,
      ...(options?.lowVolume ?? { outcomes: 20, successes: 19, failures: 1, successRatePercent: 95 }),
    },
    baseline: {
      computedAt: "2026-07-29T12:00:00.000Z",
      qualifiedWeeks: 4,
      assessableOutcomes: 100,
      medianSuccessRatePercent: 99.7,
    },
  };
}

type PaymentWindowValues = {
  outcomes: number,
  successes: number,
  failures: number,
  successRatePercent: number | null,
};

function evaluatePaymentSequence(
  samples: TvPaymentSample[],
  initial: TvPaymentEvaluatorState = createTvPaymentEvaluatorState(),
) {
  const first = samples.at(0);
  if (first == null) throw new Error("Payment evaluator sequences require at least one sample.");
  let result = evaluateTvSubscriptionCollection(initial, first);
  let state = result.state;
  for (const sample of samples.slice(1)) {
    result = evaluateTvSubscriptionCollection(state, sample);
    state = result.state;
  }
  return result;
}

describe("email delivery TV event evaluator V2", () => {
  it("uses recovery-specific presentation copy", () => {
    expect(TV_EMAIL_RECOVERY_TITLE).toBe("Email Delivery Restored");
  });

  it("classifies only delivered and explicit failures as assessable", () => {
    expect(calculateTvEmailEvidenceRate(9, 1)).toEqual({
      assessableSends: 10,
      deliveryRatePercent: 90,
      explicitFailureRatePercent: 10,
    });
  });

  it("never activates for 9 delivered and one failure", () => {
    const tiny = windowAt({ assessable: 10, failures: 1 });
    const samples = Array.from({ length: 20 }, (_, minute) => sampleAt(minute, { current: tiny, lowVolume: tiny }));
    expect(evaluateSequence(samples).action).toEqual({ type: "none" });
  });

  it("activates a low-volume incident after sustained repeated failures", () => {
    const low = windowAt({ assessable: 20, failures: 4 });
    const samples = Array.from({ length: 11 }, (_, minute) => sampleAt(minute, {
      current: windowAt({ assessable: 8, failures: 1 }),
      lowVolume: low,
    }));
    expect(evaluateSequence(samples).action).toEqual({ type: "activate", presentationClass: "incident" });
  });

  it("activates standard degradation after three accumulated fresh minutes", () => {
    const degraded = windowAt({ assessable: 100, failures: 10 });
    const samples = Array.from({ length: 4 }, (_, minute) => sampleAt(minute, { current: degraded }));
    expect(evaluateSequence(samples).action).toEqual({ type: "activate", presentationClass: "incident" });
  });

  it("freezes for two borderline evaluations and resumes without threshold flapping", () => {
    const degraded = windowAt({ assessable: 100, failures: 10 });
    const borderline = windowAt({ assessable: 100, failures: 4 });
    const result = evaluateSequence([
      sampleAt(0, { current: degraded }),
      sampleAt(1, { current: degraded }),
      sampleAt(2, { current: degraded }),
      sampleAt(3, { current: borderline, lowVolume: borderline }),
      sampleAt(4, { current: degraded }),
    ]);
    expect(result.action).toEqual({ type: "activate", presentationClass: "incident" });
  });

  it("expires a pending candidate after three borderline evaluations", () => {
    const degraded = windowAt({ assessable: 100, failures: 10 });
    const borderline = windowAt({ assessable: 100, failures: 4 });
    const result = evaluateSequence([
      sampleAt(0, { current: degraded }),
      sampleAt(1, { current: degraded }),
      sampleAt(2, { current: borderline }),
      sampleAt(3, { current: borderline }),
      sampleAt(4, { current: borderline }),
    ]);
    expect(result.state.candidate).toBeNull();
  });

  it("resets a pending candidate on clearly healthy evidence", () => {
    const degraded = windowAt({ assessable: 100, failures: 10 });
    const result = evaluateSequence([
      sampleAt(0, { current: degraded }),
      sampleAt(1, { current: degraded }),
      sampleAt(2),
    ]);
    expect(result.state.candidate).toBeNull();
  });

  it("ignores a commercially trivial high-volume movement", () => {
    expect(evaluateSequence([
      sampleAt(0, { current: windowAt({ assessable: 100_000, failures: 500 }) }),
      sampleAt(1, { current: windowAt({ assessable: 100_000, failures: 500 }) }),
    ]).action).toEqual({ type: "none" });
  });

  it("immediately activates the high-impact override", () => {
    expect(evaluateSequence([
      sampleAt(0, { current: windowAt({ assessable: 500, failures: 50 }) }),
    ]).action).toEqual({ type: "activate", presentationClass: "critical-incident" });
  });

  it("activates Critical after one sustained minute and escalates the same lifecycle", () => {
    const critical = windowAt({ assessable: 50, failures: 11 });
    expect(evaluateSequence([
      sampleAt(0, { current: critical }),
      sampleAt(1, { current: critical }),
    ]).action).toEqual({ type: "activate", presentationClass: "critical-incident" });

    const incident: TvEmailEvaluatorState = { ...createTvEmailEvaluatorState(), activeClass: "incident" };
    expect(evaluateSequence([
      sampleAt(0, { current: critical }),
      sampleAt(1, { current: critical }),
    ], incident).action).toEqual({ type: "escalate", presentationClass: "critical-incident" });
  });

  it("uses strict fallback rules when the baseline is unavailable", () => {
    const degraded = windowAt({ assessable: 100, failures: 20 });
    expect(evaluateSequence(Array.from({ length: 6 }, (_, minute) => (
      sampleAt(minute, { current: degraded, baseline: null })
    ))).action).toEqual({ type: "activate", presentationClass: "incident" });
  });

  it("does not let stale, failed, or insufficient evidence create or resolve an incident", () => {
    const pending = evaluateTvEmailDelivery(createTvEmailEvaluatorState(), sampleAt(0, {
      current: windowAt({ assessable: 100, failures: 10 }),
    })).state;
    expect(evaluateTvEmailDelivery(pending, sampleAt(1, { status: "stale" })).state.candidate).toBeNull();

    const active: TvEmailEvaluatorState = { ...createTvEmailEvaluatorState(), activeClass: "critical-incident" };
    for (const status of ["stale", "error", "insufficient"] as const) {
      expect(evaluateTvEmailDelivery(active, sampleAt(1, { status })).state).toMatchObject({
        activeClass: "critical-incident",
        recovery: null,
      });
    }
  });

  it("caps elapsed persistence so a polling gap does not qualify", () => {
    const degraded = windowAt({ assessable: 100, failures: 10 });
    const state = evaluateTvEmailDelivery(createTvEmailEvaluatorState(), sampleAt(0, { current: degraded })).state;
    const afterGap = evaluateTvEmailDelivery(state, sampleAt(30, { current: degraded }));
    expect(afterGap.state.candidate?.accumulatedMs).toBe(60_000);
    expect(afterGap.action).toEqual({ type: "none" });
  });

  it("validates recovery for five fresh minutes without downgrading Critical", () => {
    const active: TvEmailEvaluatorState = { ...createTvEmailEvaluatorState(), activeClass: "critical-incident" };
    const result = evaluateSequence(Array.from({ length: 6 }, (_, minute) => sampleAt(minute)), active);
    expect(result.action).toEqual({ type: "resolve" });
  });

  it("resets recovery on relapse", () => {
    const active: TvEmailEvaluatorState = { ...createTvEmailEvaluatorState(), activeClass: "critical-incident" };
    const recovering = evaluateSequence([sampleAt(0), sampleAt(1), sampleAt(2)], active).state;
    const relapse = evaluateTvEmailDelivery(recovering, sampleAt(3, {
      current: windowAt({ assessable: 100, failures: 10 }),
    }));
    expect(relapse.state).toMatchObject({ activeClass: "critical-incident", recovery: null });
    expect(relapse.action).toEqual({ type: "none" });
  });

  it("freezes active recovery on borderline fresh evidence", () => {
    const active: TvEmailEvaluatorState = { ...createTvEmailEvaluatorState(), activeClass: "critical-incident" };
    const recovering = evaluateSequence([sampleAt(0), sampleAt(1), sampleAt(2)], active).state;
    const borderline = windowAt({ assessable: 100, failures: 4 });
    const frozen = evaluateTvEmailDelivery(recovering, sampleAt(3, {
      current: borderline,
      lowVolume: borderline,
    }));
    expect(frozen.state.recovery).toEqual(recovering.recovery);
    expect(frozen.action).toEqual({ type: "none" });
  });

  it("does not retain a critical candidate across a non-critical breach", () => {
    const incident: TvEmailEvaluatorState = { ...createTvEmailEvaluatorState(), activeClass: "incident" };
    const critical = windowAt({ assessable: 50, failures: 11 });
    const candidate = evaluateTvEmailDelivery(incident, sampleAt(0, { current: critical })).state;
    const borderline = windowAt({ assessable: 100, failures: 4 });
    const frozen = evaluateTvEmailDelivery(candidate, sampleAt(1, {
      current: borderline,
      lowVolume: borderline,
    }));
    expect(frozen.state.candidate).toBeNull();
    const escalated = evaluateTvEmailDelivery(frozen.state, sampleAt(2, { current: critical }));
    expect(escalated.action).toEqual({ type: "none" });
    expect(escalated.state.candidate).toMatchObject({
      presentationClass: "critical-incident",
      accumulatedMs: 0,
      borderlineEvaluations: 0,
    });
  });

  it("uses a robust median daily baseline", () => {
    expect(median([99, 99.5, 99.8, 70, 72, 99.9, 100])).toBe(99.5);
    expect(median([98, 99, 100, 75])).toBe(98.5);
  });
});

describe("payment collection TV event evaluator", () => {
  const activeIncident: TvPaymentEvaluatorState = {
    ...createTvPaymentEvaluatorState(),
    activeClass: "incident",
  };
  const critical = {
    outcomes: 50,
    successes: 20,
    failures: 30,
    successRatePercent: 40,
  };
  const nonCriticalBreach = {
    outcomes: 100,
    successes: 90,
    failures: 10,
    successRatePercent: 90,
  };
  const notHealthy = {
    outcomes: 100,
    successes: 98,
    failures: 2,
    successRatePercent: 98,
  };

  it("requires a fresh persistence window after a non-critical breach", () => {
    const afterGap = evaluatePaymentSequence([
      paymentSampleAt(0, { current: critical }),
      paymentSampleAt(1, { current: critical }),
      paymentSampleAt(2, { current: nonCriticalBreach }),
    ], activeIncident);
    expect(afterGap.state.candidate).toBeNull();

    const beforeEscalation = evaluatePaymentSequence([
      paymentSampleAt(3, { current: critical }),
      paymentSampleAt(4, { current: critical }),
      paymentSampleAt(5, { current: critical }),
      paymentSampleAt(6, { current: critical }),
      paymentSampleAt(7, { current: critical }),
    ], afterGap.state);
    expect(beforeEscalation.action).toEqual({ type: "none" });

    expect(evaluateTvSubscriptionCollection(
      beforeEscalation.state,
      paymentSampleAt(8, { current: critical }),
    ).action).toEqual({ type: "escalate", presentationClass: "critical-incident" });
  });

  it("requires a fresh persistence window after a not-healthy observation", () => {
    const afterGap = evaluatePaymentSequence([
      paymentSampleAt(0, { current: critical }),
      paymentSampleAt(1, { current: critical }),
      paymentSampleAt(2, { current: notHealthy }),
    ], activeIncident);
    expect(afterGap.state.candidate).toBeNull();

    const beforeEscalation = evaluatePaymentSequence([
      paymentSampleAt(3, { current: critical }),
      paymentSampleAt(4, { current: critical }),
      paymentSampleAt(5, { current: critical }),
      paymentSampleAt(6, { current: critical }),
      paymentSampleAt(7, { current: critical }),
    ], afterGap.state);
    expect(beforeEscalation.action).toEqual({ type: "none" });
    expect(evaluateTvSubscriptionCollection(
      beforeEscalation.state,
      paymentSampleAt(8, { current: critical }),
    ).action).toEqual({ type: "escalate", presentationClass: "critical-incident" });
  });

  it("escalates after consecutive critical observations", () => {
    expect(evaluatePaymentSequence(
      Array.from({ length: 6 }, (_, minute) => paymentSampleAt(minute, { current: critical })),
      activeIncident,
    ).action).toEqual({ type: "escalate", presentationClass: "critical-incident" });
  });
});

describe("user milestone TV event evaluator", () => {
  const initial: TvUserMilestoneEvaluatorState = {
    baselineEstablished: false,
    highestConsumedThreshold: 0,
    lastObservedTotal: 0,
  };

  it("establishes a baseline without replaying historical milestones", () => {
    expect(evaluateTvUserMilestone(initial, 12_000)).toEqual({
      state: {
        baselineEstablished: true,
        highestConsumedThreshold: 10_000,
        lastObservedTotal: 12_000,
      },
      crossedThreshold: null,
    });
  });

  it("emits only the highest threshold crossed together and never re-enables it after a decrease", () => {
    const established = evaluateTvUserMilestone(initial, 90).state;
    const crossed = evaluateTvUserMilestone(established, 5_400);
    expect(crossed.crossedThreshold).toBe(5_000);
    const decreased = evaluateTvUserMilestone(crossed.state, 400);
    expect(decreased.crossedThreshold).toBeNull();
    expect(evaluateTvUserMilestone(decreased.state, 4_900).crossedThreshold).toBeNull();
  });
});
