import { GrowthPhaseStatus, GrowthRunStatus } from "@/generated/prisma/enums";
import { describe, expect, it } from "vitest";
import {
  computeGrowthAnalysisFingerprint,
  getComputeMetricsDates,
  GROWTH_PHASE_DAG,
  GROWTH_PHASE_MAX_ATTEMPTS,
  GROWTH_PHASE_STUCK_TIMEOUT_MS,
  isGrowthAnalysisResting,
  isGrowthRollupDateWithinWindow,
  isGrowthRunAwaitingIntegrations,
  isPhaseStuck,
  selectReadyPhaseKeys,
  shouldAutoSkipGrowthIntegrationsPhase,
} from "./orchestration";

const NOW = new Date("2026-08-04T12:00:00.000Z");

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

describe("GROWTH_PHASE_DAG", () => {
  it("declares the expected tiers", () => {
    expect(GROWTH_PHASE_DAG.computeMetricsPhaseKey).toBe("compute-metrics");
    expect(GROWTH_PHASE_DAG.integrationsPhaseKey).toBe("integrations");
    expect(GROWTH_PHASE_DAG.immediatePhaseKeys).toEqual(["website-research", "data-analysis"]);
    expect(GROWTH_PHASE_DAG.immediatePhaseKeyPrefix).toBe("analysis:");
    expect(GROWTH_PHASE_DAG.afterImmediatePhaseKey).toBe("interview-questions");
    expect(GROWTH_PHASE_DAG.interviewGatedPhaseKey).toBe("report");
  });
});

describe("GROWTH_PHASE_MAX_ATTEMPTS", () => {
  it("allows one automatic retry before requiring a manual retry", () => {
    expect(GROWTH_PHASE_MAX_ATTEMPTS).toBe(2);
  });
});

describe("selectReadyPhaseKeys", () => {
  const phase = (phaseKey: string, status: GrowthPhaseStatus) => ({ phaseKey, status });

  it("dispatches only compute-metrics on a fresh run, holding the immediate phases back", () => {
    expect(selectReadyPhaseKeys([
      phase("compute-metrics", GrowthPhaseStatus.PENDING),
      phase("website-research", GrowthPhaseStatus.PENDING),
      phase("data-analysis", GrowthPhaseStatus.PENDING),
      phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual(["compute-metrics"]);
  });

  it("holds the immediate phases back while compute-metrics is in flight or failed", () => {
    for (const unsettled of [GrowthPhaseStatus.DISPATCHED, GrowthPhaseStatus.RUNNING, GrowthPhaseStatus.FAILED]) {
      expect(selectReadyPhaseKeys([
        phase("compute-metrics", unsettled),
        phase("website-research", GrowthPhaseStatus.PENDING),
        phase("data-analysis", GrowthPhaseStatus.PENDING),
        phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
        phase("interview-questions", GrowthPhaseStatus.PENDING),
        phase("report", GrowthPhaseStatus.PENDING),
      ])).toEqual([]);
    }
  });

  it("releases all immediate phases once compute-metrics is COMPLETED or SKIPPED", () => {
    for (const settled of [GrowthPhaseStatus.COMPLETED, GrowthPhaseStatus.SKIPPED]) {
      expect(selectReadyPhaseKeys([
        phase("compute-metrics", settled),
        phase("website-research", GrowthPhaseStatus.PENDING),
        phase("data-analysis", GrowthPhaseStatus.PENDING),
        phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
        phase("interview-questions", GrowthPhaseStatus.PENDING),
        phase("report", GrowthPhaseStatus.PENDING),
      ])).toEqual(["website-research", "data-analysis", "analysis:some-topic"]);
    }
  });

  it("never returns the integrations phase, holds immediates while it is pending, and releases them once it settles", () => {
    // Pending integrations (metrics done): nothing is dispatchable — the run is awaiting the human.
    expect(selectReadyPhaseKeys([
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
      phase("integrations", GrowthPhaseStatus.PENDING),
      phase("website-research", GrowthPhaseStatus.PENDING),
      phase("data-analysis", GrowthPhaseStatus.PENDING),
      phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual([]);
    // Settled integrations (either way) releases the immediates.
    for (const settled of [GrowthPhaseStatus.COMPLETED, GrowthPhaseStatus.SKIPPED]) {
      expect(selectReadyPhaseKeys([
        phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
        phase("integrations", settled),
        phase("website-research", GrowthPhaseStatus.PENDING),
        phase("data-analysis", GrowthPhaseStatus.PENDING),
        phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
        phase("interview-questions", GrowthPhaseStatus.PENDING),
        phase("report", GrowthPhaseStatus.PENDING),
      ])).toEqual(["website-research", "data-analysis", "analysis:some-topic"]);
    }
  });

  it("keeps the compute-metrics gate ahead of a settled integrations row", () => {
    // A settled integrations row must not release immediates while compute-metrics is unsettled
    // (the settle order is enforced by the auto-settle, but the gate is defensive on its own).
    expect(selectReadyPhaseKeys([
      phase("compute-metrics", GrowthPhaseStatus.PENDING),
      phase("integrations", GrowthPhaseStatus.SKIPPED),
      phase("website-research", GrowthPhaseStatus.PENDING),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual(["compute-metrics"]);
  });

  it("only dispatches compute-metrics on a fresh run that has an integrations row", () => {
    expect(selectReadyPhaseKeys([
      phase("compute-metrics", GrowthPhaseStatus.PENDING),
      phase("integrations", GrowthPhaseStatus.PENDING),
      phase("website-research", GrowthPhaseStatus.PENDING),
      phase("data-analysis", GrowthPhaseStatus.PENDING),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual(["compute-metrics"]);
  });

  // The load-bearing backward-compatibility test: in-flight runs created before the compute-metrics
  // (or integrations) phase existed have no such rows, and both gates must be vacuously true for
  // them — they dispatch their immediate phases exactly as they did before the gates were
  // introduced.
  it("treats a run with no compute-metrics row exactly as before the gate existed", () => {
    expect(selectReadyPhaseKeys([
      phase("website-research", GrowthPhaseStatus.PENDING),
      phase("data-analysis", GrowthPhaseStatus.PENDING),
      phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual(["website-research", "data-analysis", "analysis:some-topic"]);
  });

  it("holds interview-questions back while any immediate phase is unsettled", () => {
    for (const unsettled of [GrowthPhaseStatus.PENDING, GrowthPhaseStatus.DISPATCHED, GrowthPhaseStatus.RUNNING, GrowthPhaseStatus.FAILED]) {
      expect(selectReadyPhaseKeys([
        phase("website-research", GrowthPhaseStatus.COMPLETED),
        phase("data-analysis", unsettled),
        phase("interview-questions", GrowthPhaseStatus.PENDING),
        phase("report", GrowthPhaseStatus.PENDING),
      ])).not.toContain("interview-questions");
    }
  });

  it("releases interview-questions once every immediate phase is COMPLETED or SKIPPED", () => {
    expect(selectReadyPhaseKeys([
      phase("website-research", GrowthPhaseStatus.COMPLETED),
      phase("data-analysis", GrowthPhaseStatus.SKIPPED),
      phase("analysis:some-topic", GrowthPhaseStatus.COMPLETED),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual(["interview-questions"]);
  });

  it("keeps the interview gate correct when a settled compute-metrics row is present", () => {
    expect(selectReadyPhaseKeys([
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
      phase("website-research", GrowthPhaseStatus.COMPLETED),
      phase("data-analysis", GrowthPhaseStatus.COMPLETED),
      phase("analysis:some-topic", GrowthPhaseStatus.COMPLETED),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual(["interview-questions"]);
    // A settled compute-metrics row alone must not release interview-questions while immediates run.
    expect(selectReadyPhaseKeys([
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
      phase("website-research", GrowthPhaseStatus.RUNNING),
      phase("data-analysis", GrowthPhaseStatus.COMPLETED),
      phase("interview-questions", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual([]);
  });

  it("never returns the report phase, even when everything else is settled", () => {
    expect(selectReadyPhaseKeys([
      phase("website-research", GrowthPhaseStatus.COMPLETED),
      phase("data-analysis", GrowthPhaseStatus.COMPLETED),
      phase("interview-questions", GrowthPhaseStatus.COMPLETED),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toEqual([]);
  });

  it("only returns PENDING phases", () => {
    expect(selectReadyPhaseKeys([
      phase("website-research", GrowthPhaseStatus.DISPATCHED),
      phase("data-analysis", GrowthPhaseStatus.RUNNING),
      phase("analysis:some-topic", GrowthPhaseStatus.FAILED),
    ])).toEqual([]);
  });

  it("throws on unknown phase keys instead of guessing a tier", () => {
    expect(() => selectReadyPhaseKeys([phase("definitely-not-a-phase", GrowthPhaseStatus.PENDING)])).toThrow();
  });
});

describe("isPhaseStuck", () => {
  it("flags a DISPATCHED phase with no heartbeat past the timeout", () => {
    expect(isPhaseStuck({ status: GrowthPhaseStatus.DISPATCHED, dispatchedAt: minutesBefore(NOW, 16), heartbeatAt: null }, NOW)).toBe(true);
    expect(isPhaseStuck({ status: GrowthPhaseStatus.DISPATCHED, dispatchedAt: minutesBefore(NOW, 14), heartbeatAt: null }, NOW)).toBe(false);
  });

  it("flags a RUNNING phase with a stale heartbeat", () => {
    expect(isPhaseStuck({ status: GrowthPhaseStatus.RUNNING, dispatchedAt: minutesBefore(NOW, 60), heartbeatAt: minutesBefore(NOW, 16) }, NOW)).toBe(true);
    expect(isPhaseStuck({ status: GrowthPhaseStatus.RUNNING, dispatchedAt: minutesBefore(NOW, 60), heartbeatAt: minutesBefore(NOW, 14) }, NOW)).toBe(false);
  });

  it("never flags settled or pending phases", () => {
    for (const status of [GrowthPhaseStatus.PENDING, GrowthPhaseStatus.COMPLETED, GrowthPhaseStatus.SKIPPED, GrowthPhaseStatus.FAILED]) {
      expect(isPhaseStuck({ status, dispatchedAt: minutesBefore(NOW, 999), heartbeatAt: minutesBefore(NOW, 999) }, NOW)).toBe(false);
    }
  });

  it("uses the exported timeout constant", () => {
    const justOver = new Date(NOW.getTime() - GROWTH_PHASE_STUCK_TIMEOUT_MS - 1);
    const justUnder = new Date(NOW.getTime() - GROWTH_PHASE_STUCK_TIMEOUT_MS + 1);
    expect(isPhaseStuck({ status: GrowthPhaseStatus.DISPATCHED, dispatchedAt: justOver, heartbeatAt: null }, NOW)).toBe(true);
    expect(isPhaseStuck({ status: GrowthPhaseStatus.DISPATCHED, dispatchedAt: justUnder, heartbeatAt: null }, NOW)).toBe(false);
  });
});

describe("isGrowthAnalysisResting", () => {
  it("classifies each run status", () => {
    expect(isGrowthAnalysisResting(GrowthRunStatus.AWAITING_INTERVIEW)).toBe(true);
    expect(isGrowthAnalysisResting(GrowthRunStatus.COMPLETED)).toBe(true);
    expect(isGrowthAnalysisResting(GrowthRunStatus.FAILED)).toBe(true);
    expect(isGrowthAnalysisResting(GrowthRunStatus.CANCELLED)).toBe(true);
    expect(isGrowthAnalysisResting(GrowthRunStatus.PENDING)).toBe(false);
    expect(isGrowthAnalysisResting(GrowthRunStatus.RUNNING)).toBe(false);
    expect(isGrowthAnalysisResting(GrowthRunStatus.COMPOSING_REPORT)).toBe(false);
  });
});

describe("isGrowthRunAwaitingIntegrations", () => {
  const phase = (phaseKey: string, status: GrowthPhaseStatus) => ({ phaseKey, status });
  const awaitingPhases = [
    phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
    phase("integrations", GrowthPhaseStatus.PENDING),
    phase("website-research", GrowthPhaseStatus.PENDING),
    phase("data-analysis", GrowthPhaseStatus.PENDING),
    phase("analysis:some-topic", GrowthPhaseStatus.PENDING),
    phase("interview-questions", GrowthPhaseStatus.PENDING),
    phase("report", GrowthPhaseStatus.PENDING),
  ];

  it("is true for a RUNNING run blocked only on a pending integrations phase", () => {
    expect(isGrowthRunAwaitingIntegrations(GrowthRunStatus.RUNNING, awaitingPhases)).toBe(true);
  });

  it("is false for every non-RUNNING run status", () => {
    for (const status of [GrowthRunStatus.PENDING, GrowthRunStatus.AWAITING_INTERVIEW, GrowthRunStatus.COMPOSING_REPORT, GrowthRunStatus.COMPLETED, GrowthRunStatus.FAILED, GrowthRunStatus.CANCELLED]) {
      expect(isGrowthRunAwaitingIntegrations(status, awaitingPhases)).toBe(false);
    }
  });

  it("is false while compute-metrics is unsettled (the question is not actionable yet)", () => {
    for (const unsettled of [GrowthPhaseStatus.PENDING, GrowthPhaseStatus.RUNNING, GrowthPhaseStatus.FAILED]) {
      expect(isGrowthRunAwaitingIntegrations(GrowthRunStatus.RUNNING, [
        phase("compute-metrics", unsettled),
        ...awaitingPhases.slice(1),
      ])).toBe(false);
    }
  });

  it("is false once the integrations phase settles", () => {
    for (const settled of [GrowthPhaseStatus.COMPLETED, GrowthPhaseStatus.SKIPPED]) {
      expect(isGrowthRunAwaitingIntegrations(GrowthRunStatus.RUNNING, [
        awaitingPhases[0],
        phase("integrations", settled),
        ...awaitingPhases.slice(2),
      ])).toBe(false);
    }
  });

  it("is false while any other phase is in flight or failed (the leg still has work)", () => {
    for (const busy of [GrowthPhaseStatus.DISPATCHED, GrowthPhaseStatus.RUNNING, GrowthPhaseStatus.FAILED]) {
      expect(isGrowthRunAwaitingIntegrations(GrowthRunStatus.RUNNING, [
        ...awaitingPhases.slice(0, 2),
        phase("website-research", busy),
        ...awaitingPhases.slice(3),
      ])).toBe(false);
    }
  });

  // Back-compat: pre-integrations runs have no integrations row and are never "awaiting" it.
  it("is false for runs without an integrations phase row", () => {
    expect(isGrowthRunAwaitingIntegrations(GrowthRunStatus.RUNNING, [
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
      phase("website-research", GrowthPhaseStatus.PENDING),
      phase("report", GrowthPhaseStatus.PENDING),
    ])).toBe(false);
  });
});

describe("shouldAutoSkipGrowthIntegrationsPhase", () => {
  const phase = (phaseKey: string, status: GrowthPhaseStatus) => ({ phaseKey, status });

  it("auto-skips a pending integrations phase after metrics settle", () => {
    expect(shouldAutoSkipGrowthIntegrationsPhase([
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
      phase("integrations", GrowthPhaseStatus.PENDING),
    ])).toBe(true);
    expect(shouldAutoSkipGrowthIntegrationsPhase([
      phase("compute-metrics", GrowthPhaseStatus.SKIPPED),
      phase("integrations", GrowthPhaseStatus.PENDING),
    ])).toBe(true);
  });

  it("keeps integrations pending until metrics settle", () => {
    for (const unsettled of [GrowthPhaseStatus.PENDING, GrowthPhaseStatus.DISPATCHED, GrowthPhaseStatus.RUNNING, GrowthPhaseStatus.FAILED]) {
      expect(shouldAutoSkipGrowthIntegrationsPhase([
        phase("compute-metrics", unsettled),
        phase("integrations", GrowthPhaseStatus.PENDING),
      ])).toBe(false);
    }
  });

  it("does not auto-skip when integrations is absent or already settled", () => {
    expect(shouldAutoSkipGrowthIntegrationsPhase([
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
    ])).toBe(false);
    expect(shouldAutoSkipGrowthIntegrationsPhase([
      phase("compute-metrics", GrowthPhaseStatus.COMPLETED),
      phase("integrations", GrowthPhaseStatus.SKIPPED),
    ])).toBe(false);
  });
});

describe("computeGrowthAnalysisFingerprint", () => {
  const basePhases = [
    { phaseKey: "website-research", status: GrowthPhaseStatus.PENDING, attempt: 0 },
    { phaseKey: "data-analysis", status: GrowthPhaseStatus.PENDING, attempt: 0 },
  ];

  it("is deterministic and independent of phase row order", () => {
    const a = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.RUNNING }, basePhases, null);
    const b = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.RUNNING }, [...basePhases].reverse(), null);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the run status changes", () => {
    const a = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.RUNNING }, basePhases, null);
    const b = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.AWAITING_INTERVIEW }, basePhases, null);
    expect(a).not.toBe(b);
  });

  it("changes when a phase status or attempt changes", () => {
    const a = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.RUNNING }, basePhases, null);
    const statusChanged = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.RUNNING }, [
      { ...basePhases[0], status: GrowthPhaseStatus.RUNNING },
      basePhases[1],
    ], null);
    const attemptChanged = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.RUNNING }, [
      { ...basePhases[0], attempt: 1 },
      basePhases[1],
    ], null);
    expect(statusChanged).not.toBe(a);
    expect(attemptChanged).not.toBe(a);
    expect(statusChanged).not.toBe(attemptChanged);
  });

  it("changes when the interview status changes (the AWAITING_INTERVIEW wake-up signal)", () => {
    const none = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.AWAITING_INTERVIEW }, basePhases, null);
    const active = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.AWAITING_INTERVIEW }, basePhases, "active");
    const completed = computeGrowthAnalysisFingerprint({ status: GrowthRunStatus.AWAITING_INTERVIEW }, basePhases, "completed");
    expect(new Set([none, active, completed]).size).toBe(3);
  });
});

describe("isGrowthRollupDateWithinWindow", () => {
  it("accepts yesterday through three days ago (UTC)", () => {
    expect(isGrowthRollupDateWithinWindow("2026-08-03", NOW)).toBe(true);
    expect(isGrowthRollupDateWithinWindow("2026-08-02", NOW)).toBe(true);
    expect(isGrowthRollupDateWithinWindow("2026-08-01", NOW)).toBe(true);
  });

  it("rejects today, the future, and anything older than three days", () => {
    expect(isGrowthRollupDateWithinWindow("2026-08-04", NOW)).toBe(false);
    expect(isGrowthRollupDateWithinWindow("2026-08-05", NOW)).toBe(false);
    expect(isGrowthRollupDateWithinWindow("2026-07-31", NOW)).toBe(false);
    expect(isGrowthRollupDateWithinWindow("2020-01-01", NOW)).toBe(false);
  });

  it("uses the UTC day boundary, not local time", () => {
    // At 00:00:00.000 UTC the previous UTC day is fully elapsed and becomes acceptable.
    const midnight = new Date("2026-08-04T00:00:00.000Z");
    expect(isGrowthRollupDateWithinWindow("2026-08-03", midnight)).toBe(true);
    expect(isGrowthRollupDateWithinWindow("2026-08-04", midnight)).toBe(false);
  });

  it("rejects malformed and non-canonical date strings", () => {
    expect(isGrowthRollupDateWithinWindow("2026-8-3", NOW)).toBe(false);
    expect(isGrowthRollupDateWithinWindow("not-a-date", NOW)).toBe(false);
    expect(isGrowthRollupDateWithinWindow("2026-08-03T00:00:00Z", NOW)).toBe(false);
    // Rolls over to a real date if parsed naively — must be rejected as non-canonical.
    expect(isGrowthRollupDateWithinWindow("2026-02-30", NOW)).toBe(false);
  });
});

describe("getComputeMetricsDates", () => {
  it("targets the CURRENT UTC day (unlike the rollup's yesterday)", () => {
    expect(getComputeMetricsDates(NOW)).toEqual({ targetDate: "2026-08-04" });
  });

  it("uses the UTC day boundary, not local time", () => {
    expect(getComputeMetricsDates(new Date("2026-08-04T23:59:59.999Z")).targetDate).toBe("2026-08-04");
    expect(getComputeMetricsDates(new Date("2026-08-05T00:00:00.000Z")).targetDate).toBe("2026-08-05");
  });
});
