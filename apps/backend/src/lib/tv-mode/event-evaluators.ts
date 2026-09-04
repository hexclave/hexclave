export const TV_EVENT_EVALUATION_INTERVAL_MS = 60_000;
export const TV_EMAIL_CURRENT_WINDOW_MINUTES = 15;
export const TV_EMAIL_LOW_VOLUME_WINDOW_MINUTES = 6 * 60;
export const TV_EMAIL_MATURITY_DELAY_MINUTES = 5;
export const TV_EMAIL_BASELINE_DAYS = 28;
export const TV_EMAIL_BASELINE_REFRESH_MS = 6 * 60 * 60 * 1000;
export const TV_EMAIL_BASELINE_STALE_MS = 12 * 60 * 60 * 1000;
export const TV_EMAIL_RECOVERY_TITLE = "Email Delivery Restored";
export const TV_EMAIL_RULE_VERSION = 2;
// Persisted payment candidates need a fresh interpretation after splitting the critical rule paths.
export const TV_PAYMENT_RULE_VERSION = 2;
export const TV_PAYMENT_BASELINE_REFRESH_MS = 6 * 60 * 60 * 1000;
export const TV_PAYMENT_BASELINE_STALE_MS = 12 * 60 * 60 * 1000;
export const TV_PAYMENT_RECOVERY_TITLE = "Subscription Payments Restored";
export const TV_USER_MILESTONES = [
  100,
  500,
  1_000,
  5_000,
  10_000,
  50_000,
  100_000,
  500_000,
  1_000_000,
] as const;

export type TvEmailPresentationClass = "incident" | "critical-incident";
export type TvEmailRulePath = "standard" | "low-volume" | "strict-standard" | "strict-low-volume" | "critical" | "high-impact";
export type TvEmailObservationStatus = "fresh" | "insufficient" | "stale" | "error";

export type TvEmailEvidenceWindow = {
  startsAt: string,
  endsAt: string,
  finishedSends: number,
  deliveredSends: number,
  bouncedSends: number,
  serverErrorSends: number,
  neutralOrUnknownSends: number,
  assessableSends: number,
  explicitFailures: number,
  deliveryRatePercent: number | null,
  explicitFailureRatePercent: number | null,
};

export type TvEmailBaseline = {
  startsAt: string,
  endsAt: string,
  computedAt: string,
  assessableSends: number,
  qualifiedDays: number,
  days: Array<{
    day: string,
    deliveredSends: number,
    explicitFailures: number,
    assessableSends: number,
    deliveryRatePercent: number,
  }>,
  medianDeliveryRatePercent: number | null,
};

export type TvEmailEvaluationSample = {
  status: TvEmailObservationStatus,
  evaluatedAt: string,
  observedAt: string | null,
  current: TvEmailEvidenceWindow | null,
  lowVolume: TvEmailEvidenceWindow | null,
  baseline: TvEmailBaseline | null,
};

type TvEmailCandidate = {
  rulePath: TvEmailRulePath,
  presentationClass: TvEmailPresentationClass,
  accumulatedMs: number,
  borderlineEvaluations: number,
};

type TvEmailRecoveryCandidate = {
  window: "current" | "low-volume",
  accumulatedMs: number,
};

export type TvEmailEvaluatorState = {
  ruleVersion: typeof TV_EMAIL_RULE_VERSION,
  activeClass: TvEmailPresentationClass | null,
  candidate: TvEmailCandidate | null,
  recovery: TvEmailRecoveryCandidate | null,
  lastFreshEvaluatedAt: string | null,
  baseline: TvEmailBaseline | null,
};

export type TvEmailEvaluationAction =
  | { type: "none" }
  | { type: "activate", presentationClass: TvEmailPresentationClass }
  | { type: "escalate", presentationClass: "critical-incident" }
  | { type: "resolve" };

export type TvEmailEvaluationResult = {
  state: TvEmailEvaluatorState,
  action: TvEmailEvaluationAction,
  qualification: TvEmailRulePath | "recovery" | null,
};

export type TvPaymentWindow = {
  startsAt: string,
  endsAt: string,
  outcomes: number,
  successes: number,
  failures: number,
  successRatePercent: number | null,
};

export function selectTvSubscriptionInvoiceOutcome(invoice: {
  paidAt: Date | null,
  markedUncollectibleAt: Date | null,
  voidedAt: Date | null,
}): { type: "success" | "failure", at: Date } | null {
  const transitions = [
    invoice.markedUncollectibleAt == null ? null : { type: "failure" as const, at: invoice.markedUncollectibleAt, rank: 1 },
    invoice.voidedAt == null ? null : { type: "neutral" as const, at: invoice.voidedAt, rank: 2 },
    invoice.paidAt == null ? null : { type: "success" as const, at: invoice.paidAt, rank: 3 },
  ].filter((transition) => transition != null).sort((left, right) => right.at.getTime() - left.at.getTime() || right.rank - left.rank);
  const latest = transitions.at(0);
  return latest == null || latest.type === "neutral" ? null : { type: latest.type, at: latest.at };
}

export type TvPaymentBaseline = {
  computedAt: string,
  qualifiedWeeks: number,
  assessableOutcomes: number,
  medianSuccessRatePercent: number | null,
};

export type TvPaymentSample = {
  status: TvEmailObservationStatus,
  evaluatedAt: string,
  observedAt: string | null,
  current: TvPaymentWindow | null,
  lowVolume: TvPaymentWindow | null,
  baseline: TvPaymentBaseline | null,
};

export type TvPaymentRulePath = "standard" | "low-volume" | "strict" | "critical" | "strict-critical" | "low-volume-critical";

type TvPaymentCandidate = {
  rulePath: TvPaymentRulePath,
  presentationClass: TvEmailPresentationClass,
  accumulatedMs: number,
};

export type TvPaymentEvaluatorState = {
  ruleVersion: typeof TV_PAYMENT_RULE_VERSION,
  activeClass: TvEmailPresentationClass | null,
  candidate: TvPaymentCandidate | null,
  recovery: { window: "current" | "low-volume", accumulatedMs: number } | null,
  lastFreshEvaluatedAt: string | null,
  baseline: TvPaymentBaseline | null,
};

export function createTvPaymentEvaluatorState(options?: {
  activeClass?: TvEmailPresentationClass | null,
  baseline?: TvPaymentBaseline | null,
}): TvPaymentEvaluatorState {
  return {
    ruleVersion: TV_PAYMENT_RULE_VERSION,
    activeClass: options?.activeClass ?? null,
    candidate: null,
    recovery: null,
    lastFreshEvaluatedAt: null,
    baseline: options?.baseline ?? null,
  };
}

function paymentBaselineRate(sample: TvPaymentSample): number | null {
  const baseline = sample.baseline;
  return baseline != null
    && baseline.qualifiedWeeks >= 4
    && baseline.assessableOutcomes >= 40
    && new Date(sample.evaluatedAt).getTime() - new Date(baseline.computedAt).getTime() <= TV_PAYMENT_BASELINE_STALE_MS
    ? baseline.medianSuccessRatePercent
    : null;
}

function paymentBreach(sample: TvPaymentSample): TvPaymentCandidate | null {
  if (sample.current == null || sample.lowVolume == null) return null;
  const baseline = paymentBaselineRate(sample);
  const currentRate = sample.current.successRatePercent;
  const lowRate = sample.lowVolume.successRatePercent;
  if (baseline == null) {
    if (sample.lowVolume.outcomes >= 20 && sample.lowVolume.failures >= 15 && lowRate != null && lowRate <= 25) {
      return { rulePath: "strict-critical", presentationClass: "critical-incident", accumulatedMs: 0 };
    }
    if (sample.lowVolume.outcomes >= 10 && sample.lowVolume.failures >= 5 && lowRate != null && lowRate <= 50) {
      return { rulePath: "strict", presentationClass: "incident", accumulatedMs: 0 };
    }
    return null;
  }
  if (sample.current.outcomes >= 10 && sample.current.failures >= 5 && currentRate != null && currentRate <= 50 && baseline - currentRate >= 25) {
    return { rulePath: "critical", presentationClass: "critical-incident", accumulatedMs: 0 };
  }
  if (sample.lowVolume.outcomes >= 5 && sample.lowVolume.failures >= 4 && lowRate != null && lowRate <= 40 && baseline - lowRate >= 25) {
    return { rulePath: "low-volume-critical", presentationClass: "critical-incident", accumulatedMs: 0 };
  }
  if (sample.current.outcomes >= 10 && sample.current.failures >= 3 && currentRate != null && currentRate <= 80 && baseline - currentRate >= 10) {
    return { rulePath: "standard", presentationClass: "incident", accumulatedMs: 0 };
  }
  if (sample.lowVolume.outcomes >= 5 && sample.lowVolume.failures >= 3 && lowRate != null && lowRate <= 60 && baseline - lowRate >= 15) {
    return { rulePath: "low-volume", presentationClass: "incident", accumulatedMs: 0 };
  }
  return null;
}

function paymentRequiredMs(candidate: TvPaymentCandidate): number {
  if (candidate.rulePath === "critical") return 5 * 60_000;
  if (candidate.rulePath === "standard") return 10 * 60_000;
  if (candidate.rulePath === "low-volume" || candidate.rulePath === "strict-critical" || candidate.rulePath === "low-volume-critical") return 30 * 60_000;
  return 60 * 60_000;
}

export function evaluateTvSubscriptionCollection(
  previous: TvPaymentEvaluatorState,
  sample: TvPaymentSample,
): { state: TvPaymentEvaluatorState, action: TvEmailEvaluationAction, qualification: TvPaymentRulePath | "recovery" | null } {
  const baseline = sample.baseline ?? previous.baseline;
  if (sample.status !== "fresh" || sample.current == null || sample.lowVolume == null) {
    return { state: { ...previous, baseline }, action: { type: "none" }, qualification: null };
  }
  const elapsed = previous.lastFreshEvaluatedAt == null
    ? 0
    // An evaluator can only credit one scheduled observation. Otherwise an
    // outage would be mistaken for continuously observed degradation/recovery.
    : Math.max(0, Math.min(
      new Date(sample.evaluatedAt).getTime() - new Date(previous.lastFreshEvaluatedAt).getTime(),
      TV_EVENT_EVALUATION_INTERVAL_MS,
    ));
  const baseState = { ...previous, baseline, lastFreshEvaluatedAt: sample.evaluatedAt };
  const breach = paymentBreach({ ...sample, baseline });
  if (previous.activeClass != null) {
    if (previous.activeClass === "incident" && breach?.presentationClass === "critical-incident") {
      const accumulatedMs = previous.candidate?.presentationClass === "critical-incident"
        && previous.candidate.rulePath === breach.rulePath
        ? previous.candidate.accumulatedMs + elapsed
        : 0;
      const candidate = { ...breach, accumulatedMs };
      return accumulatedMs >= paymentRequiredMs(candidate)
        ? { state: { ...baseState, activeClass: "critical-incident", candidate: null, recovery: null }, action: { type: "escalate", presentationClass: "critical-incident" }, qualification: candidate.rulePath }
        : { state: { ...baseState, candidate, recovery: null }, action: { type: "none" }, qualification: candidate.rulePath };
    }
    if (breach != null) return {
      state: { ...baseState, candidate: null, recovery: null },
      action: { type: "none" },
      qualification: breach.rulePath,
    };
    const baselineRate = paymentBaselineRate({ ...sample, baseline });
    const useCurrent = baselineRate != null && sample.current.outcomes >= 10;
    const window = useCurrent ? sample.current : sample.lowVolume;
    const healthy = baselineRate == null
      ? window.outcomes >= 10 && window.failures <= 1 && window.successRatePercent != null && window.successRatePercent >= 90
      : useCurrent
        ? window.failures <= 1 && window.successRatePercent != null && window.successRatePercent >= Math.max(90, baselineRate - 5)
        : window.outcomes >= 5 && window.failures <= 1 && window.successRatePercent != null && window.successRatePercent >= Math.max(80, baselineRate - 10);
    if (!healthy) return { state: { ...baseState, candidate: null }, action: { type: "none" }, qualification: null };
    const recoveryWindow = useCurrent ? "current" : "low-volume";
    const accumulatedMs = previous.recovery?.window === recoveryWindow ? previous.recovery.accumulatedMs + elapsed : 0;
    const requiredMs = useCurrent ? 30 * 60_000 : 2 * 60 * 60_000;
    return accumulatedMs >= requiredMs
      ? { state: { ...baseState, activeClass: null, candidate: null, recovery: null }, action: { type: "resolve" }, qualification: "recovery" }
      : { state: { ...baseState, candidate: null, recovery: { window: recoveryWindow, accumulatedMs } }, action: { type: "none" }, qualification: "recovery" };
  }
  if (breach == null) {
    const baselineRate = paymentBaselineRate({ ...sample, baseline });
    const current = sample.current;
    const clearlyHealthy = current.outcomes > 0
      && (current.failures === 0
        || (current.successRatePercent != null && current.successRatePercent >= Math.max(95, (baselineRate ?? 97) - 2)));
    return {
      state: clearlyHealthy ? { ...baseState, candidate: null } : baseState,
      action: { type: "none" },
      qualification: null,
    };
  }
  const accumulatedMs = previous.candidate?.rulePath === breach.rulePath ? previous.candidate.accumulatedMs + elapsed : 0;
  const candidate = { ...breach, accumulatedMs };
  return accumulatedMs >= paymentRequiredMs(candidate)
    ? { state: { ...baseState, activeClass: candidate.presentationClass, candidate: null }, action: { type: "activate", presentationClass: candidate.presentationClass }, qualification: candidate.rulePath }
    : { state: { ...baseState, candidate }, action: { type: "none" }, qualification: candidate.rulePath };
}

export function createTvEmailEvaluatorState(options?: {
  activeClass?: TvEmailPresentationClass | null,
  baseline?: TvEmailBaseline | null,
}): TvEmailEvaluatorState {
  return {
    ruleVersion: TV_EMAIL_RULE_VERSION,
    activeClass: options?.activeClass ?? null,
    candidate: null,
    recovery: null,
    lastFreshEvaluatedAt: null,
    baseline: options?.baseline ?? null,
  };
}

function percent(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator * 100;
}

function baselineIsQualified(baseline: TvEmailBaseline | null, evaluatedAt: Date): baseline is TvEmailBaseline & { medianDeliveryRatePercent: number } {
  return baseline?.medianDeliveryRatePercent != null
    && baseline.assessableSends >= 100
    && baseline.qualifiedDays >= 7
    && evaluatedAt.getTime() - new Date(baseline.computedAt).getTime() <= TV_EMAIL_BASELINE_STALE_MS;
}

type Breach = {
  rulePath: TvEmailRulePath,
  presentationClass: TvEmailPresentationClass,
  requiredMs: number,
};

function findBreach(sample: TvEmailEvaluationSample): Breach | null {
  if (sample.current == null || sample.lowVolume == null) return null;
  const evaluatedAt = new Date(sample.evaluatedAt);
  const baselineRate = baselineIsQualified(sample.baseline, evaluatedAt)
    ? sample.baseline.medianDeliveryRatePercent
    : null;
  const currentRate = sample.current.deliveryRatePercent;
  const lowVolumeRate = sample.lowVolume.deliveryRatePercent;

  if (
    sample.current.explicitFailures >= 50
    && (sample.current.explicitFailureRatePercent ?? 0) >= 10
  ) {
    return { rulePath: "high-impact", presentationClass: "critical-incident", requiredMs: 0 };
  }
  if (
    sample.current.assessableSends >= 20
    && sample.current.explicitFailures >= 10
    && currentRate != null
    && currentRate < 80
  ) {
    return { rulePath: "critical", presentationClass: "critical-incident", requiredMs: 60_000 };
  }
  if (baselineRate != null) {
    if (
      sample.current.assessableSends >= 50
      && sample.current.explicitFailures >= 5
      && currentRate != null
      && currentRate < 95
      && baselineRate - currentRate >= 5
    ) {
      return { rulePath: "standard", presentationClass: "incident", requiredMs: 3 * 60_000 };
    }
    if (
      sample.lowVolume.assessableSends >= 20
      && sample.lowVolume.explicitFailures >= 3
      && lowVolumeRate != null
      && lowVolumeRate < 85
      && baselineRate - lowVolumeRate >= 10
    ) {
      return { rulePath: "low-volume", presentationClass: "incident", requiredMs: 10 * 60_000 };
    }
    return null;
  }
  if (
    sample.current.assessableSends >= 50
    && sample.current.explicitFailures >= 10
    && currentRate != null
    && currentRate < 85
  ) {
    return { rulePath: "strict-standard", presentationClass: "incident", requiredMs: 5 * 60_000 };
  }
  if (
    sample.lowVolume.assessableSends >= 20
    && sample.lowVolume.explicitFailures >= 5
    && lowVolumeRate != null
    && lowVolumeRate < 75
  ) {
    return { rulePath: "strict-low-volume", presentationClass: "incident", requiredMs: 15 * 60_000 };
  }
  return null;
}

function recoveryWindow(sample: TvEmailEvaluationSample): "current" | "low-volume" | null {
  const baselineRate = baselineIsQualified(sample.baseline, new Date(sample.evaluatedAt))
    ? sample.baseline.medianDeliveryRatePercent
    : null;
  const qualifies = (window: TvEmailEvidenceWindow, minimum: number) => {
    if (window.assessableSends < minimum || window.deliveryRatePercent == null) return false;
    if (baselineRate == null) {
      return window.deliveryRatePercent >= 97 && (window.explicitFailureRatePercent ?? 100) <= 3;
    }
    const acceptableRate = Math.max(90, baselineRate - 2);
    const maximumFailures = Math.max(1, Math.floor(window.assessableSends * (100 - acceptableRate) / 100));
    return window.deliveryRatePercent >= acceptableRate && window.explicitFailures <= maximumFailures;
  };
  if (sample.current != null && sample.current.assessableSends >= 50) {
    return qualifies(sample.current, 50) ? "current" : null;
  }
  if (sample.lowVolume != null && qualifies(sample.lowVolume, 20)) return "low-volume";
  return null;
}

function clearlyHealthy(sample: TvEmailEvaluationSample): boolean {
  return recoveryWindow(sample) != null;
}

function freshIncrement(previous: TvEmailEvaluatorState, sample: TvEmailEvaluationSample): number {
  if (previous.lastFreshEvaluatedAt == null) return 0;
  const elapsed = new Date(sample.evaluatedAt).getTime() - new Date(previous.lastFreshEvaluatedAt).getTime();
  return Math.max(0, Math.min(elapsed, TV_EVENT_EVALUATION_INTERVAL_MS));
}

export function evaluateTvEmailDelivery(
  previous: TvEmailEvaluatorState,
  sample: TvEmailEvaluationSample,
): TvEmailEvaluationResult {
  const baseline = sample.baseline ?? previous.baseline;
  const stateWithBaseline = { ...previous, baseline };
  if (sample.status !== "fresh") {
    return previous.activeClass == null
      ? {
        state: { ...stateWithBaseline, candidate: null, lastFreshEvaluatedAt: null },
        action: { type: "none" },
        qualification: null,
      }
      : { state: stateWithBaseline, action: { type: "none" }, qualification: null };
  }

  const normalizedSample = { ...sample, baseline };
  const increment = freshIncrement(previous, normalizedSample);
  const breach = findBreach(normalizedSample);
  const nextFreshAt = sample.evaluatedAt;

  if (previous.activeClass === "critical-incident") {
    const recovery = recoveryWindow(normalizedSample);
    if (recovery == null) {
      return {
        state: {
          ...stateWithBaseline,
          activeClass: "critical-incident",
          recovery: breach == null ? previous.recovery : null,
          lastFreshEvaluatedAt: nextFreshAt,
        },
        action: { type: "none" },
        qualification: breach?.rulePath ?? null,
      };
    }
    const accumulatedMs = previous.recovery?.window === recovery
      ? previous.recovery.accumulatedMs + increment
      : 0;
    if (accumulatedMs >= (recovery === "current" ? 5 : 15) * 60_000) {
      return {
        state: { ...stateWithBaseline, activeClass: null, candidate: null, recovery: null, lastFreshEvaluatedAt: nextFreshAt },
        action: { type: "resolve" },
        qualification: "recovery",
      };
    }
    return {
      state: { ...stateWithBaseline, activeClass: "critical-incident", recovery: { window: recovery, accumulatedMs }, lastFreshEvaluatedAt: nextFreshAt },
      action: { type: "none" },
      qualification: "recovery",
    };
  }

  if (previous.activeClass === "incident") {
    if (breach?.presentationClass === "critical-incident") {
      const sameCandidate = previous.candidate?.rulePath === breach.rulePath;
      const accumulatedMs = sameCandidate && previous.candidate != null
        ? previous.candidate.accumulatedMs + increment
        : 0;
      if (accumulatedMs >= breach.requiredMs) {
        return {
          state: { ...stateWithBaseline, activeClass: "critical-incident", candidate: null, recovery: null, lastFreshEvaluatedAt: nextFreshAt },
          action: { type: "escalate", presentationClass: "critical-incident" },
          qualification: breach.rulePath,
        };
      }
      return {
        state: {
          ...stateWithBaseline,
          candidate: { ...breach, accumulatedMs, borderlineEvaluations: 0 },
          recovery: null,
          lastFreshEvaluatedAt: nextFreshAt,
        },
        action: { type: "none" },
        qualification: breach.rulePath,
      };
    }
    const recovery = recoveryWindow(normalizedSample);
    if (recovery == null) {
      const borderlineEvaluations = (previous.candidate?.borderlineEvaluations ?? 0) + 1;
      return {
        state: {
          ...stateWithBaseline,
          activeClass: "incident",
          candidate: null,
          recovery: breach == null ? previous.recovery : null,
          lastFreshEvaluatedAt: nextFreshAt,
        },
        action: { type: "none" },
        qualification: breach?.rulePath ?? null,
      };
    }
    const accumulatedMs = previous.recovery?.window === recovery
      ? previous.recovery.accumulatedMs + increment
      : 0;
    if (accumulatedMs >= (recovery === "current" ? 5 : 15) * 60_000) {
      return {
        state: { ...stateWithBaseline, activeClass: null, candidate: null, recovery: null, lastFreshEvaluatedAt: nextFreshAt },
        action: { type: "resolve" },
        qualification: "recovery",
      };
    }
    return {
      state: { ...stateWithBaseline, activeClass: "incident", candidate: null, recovery: { window: recovery, accumulatedMs }, lastFreshEvaluatedAt: nextFreshAt },
      action: { type: "none" },
      qualification: "recovery",
    };
  }

  if (breach != null) {
    if (breach.requiredMs === 0) {
      return {
        state: { ...stateWithBaseline, activeClass: breach.presentationClass, candidate: null, recovery: null, lastFreshEvaluatedAt: nextFreshAt },
        action: { type: "activate", presentationClass: breach.presentationClass },
        qualification: breach.rulePath,
      };
    }
    const sameCandidate = previous.candidate?.rulePath === breach.rulePath;
    const accumulatedMs = sameCandidate && previous.candidate != null
      ? previous.candidate.accumulatedMs + increment
      : 0;
    if (accumulatedMs >= breach.requiredMs) {
      return {
        state: { ...stateWithBaseline, activeClass: breach.presentationClass, candidate: null, recovery: null, lastFreshEvaluatedAt: nextFreshAt },
        action: { type: "activate", presentationClass: breach.presentationClass },
        qualification: breach.rulePath,
      };
    }
    return {
      state: {
        ...stateWithBaseline,
        candidate: { ...breach, accumulatedMs, borderlineEvaluations: 0 },
        recovery: null,
        lastFreshEvaluatedAt: nextFreshAt,
      },
      action: { type: "none" },
      qualification: breach.rulePath,
    };
  }

  if (clearlyHealthy(normalizedSample)) {
    return {
      state: { ...stateWithBaseline, candidate: null, recovery: null, lastFreshEvaluatedAt: nextFreshAt },
      action: { type: "none" },
      qualification: null,
    };
  }
  const borderlineEvaluations = (previous.candidate?.borderlineEvaluations ?? 0) + 1;
  return {
    state: {
      ...stateWithBaseline,
      candidate: previous.candidate != null && borderlineEvaluations <= 2
        ? { ...previous.candidate, borderlineEvaluations }
        : null,
      recovery: null,
      lastFreshEvaluatedAt: nextFreshAt,
    },
    action: { type: "none" },
    qualification: null,
  };
}

export function calculateTvEmailEvidenceRate(delivered: number, failures: number): {
  assessableSends: number,
  deliveryRatePercent: number | null,
  explicitFailureRatePercent: number | null,
} {
  const assessableSends = delivered + failures;
  return {
    assessableSends,
    deliveryRatePercent: percent(delivered, assessableSends),
    explicitFailureRatePercent: percent(failures, assessableSends),
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export type TvUserMilestoneEvaluatorState = {
  baselineEstablished: boolean,
  highestConsumedThreshold: number,
  lastObservedTotal: number,
};

export type TvUserMilestoneEvaluationResult = {
  state: TvUserMilestoneEvaluatorState,
  crossedThreshold: number | null,
};

export function evaluateTvUserMilestone(
  previous: TvUserMilestoneEvaluatorState,
  totalUsers: number,
): TvUserMilestoneEvaluationResult {
  if (!previous.baselineEstablished) {
    const consumed = [...TV_USER_MILESTONES].reverse().find((threshold) => threshold <= totalUsers) ?? 0;
    return {
      state: {
        baselineEstablished: true,
        highestConsumedThreshold: consumed,
        lastObservedTotal: totalUsers,
      },
      crossedThreshold: null,
    };
  }
  const crossedThreshold = [...TV_USER_MILESTONES].reverse().find((threshold) => (
    threshold > previous.highestConsumedThreshold
    && threshold > previous.lastObservedTotal
    && threshold <= totalUsers
  )) ?? null;
  return {
    state: {
      baselineEstablished: true,
      highestConsumedThreshold: crossedThreshold ?? previous.highestConsumedThreshold,
      lastObservedTotal: totalUsers,
    },
    crossedThreshold,
  };
}
