/**
 * Freestyle enforces an account-wide resource limit on concurrent VMs. When
 * it is reached, `POST /v5/vms` answers 429 `LIMIT_EXCEEDED` for every caller
 * until enough VMs finish. Retrying a few hundred milliseconds later cannot
 * succeed, it only adds latency to the execution (e.g. a sign-in code email
 * waiting on its render) and more requests against the exhausted account.
 *
 * This module recognizes that condition and keeps a short, process-local
 * cooldown during which executions go straight to the fallback engine.
 */

const MAX_CAUSE_DEPTH = 8;

/**
 * True when `error` (or anything in its `cause` / `errors` chain, as wrapped
 * by Result.retry's RetryError or our own HexclaveAssertionErrors) is a
 * Freestyle API rejection because the account is out of capacity.
 */
export function isFreestyleAccountLimitError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > MAX_CAUSE_DEPTH || typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    const candidate = value as { name?: unknown, status?: unknown, code?: unknown, cause?: unknown, errors?: unknown };
    if (candidate.name === "FreestyleApiError" && (candidate.status === 429 || candidate.code === "LIMIT_EXCEEDED")) {
      return true;
    }
    if (Array.isArray(candidate.errors) && candidate.errors.some((inner) => visit(inner, depth + 1))) {
      return true;
    }
    return visit(candidate.cause, depth + 1);
  };
  return visit(error, 0);
}

export type FreestyleCapacityGate = {
  /** Whether a cooldown is running, without counting a skip. */
  isCoolingDown: () => boolean,
  /**
   * Whether Freestyle should be skipped right now because the account limit
   * was hit recently. Each `true` is counted as one skipped execution.
   */
  shouldSkipFreestyle: () => boolean,
  /**
   * Records an account-limit rejection and (re)starts the cooldown. Returns
   * whether the caller should report it: only the rejection that opens a new
   * cooldown is reported, with how many executions the previous cooldowns
   * routed straight to the fallback since the last report.
   */
  recordAccountLimit: () => { shouldReport: boolean, skippedSinceLastReport: number },
};

export function createFreestyleCapacityGate(options: {
  cooldownMs: number,
  now?: () => number,
}): FreestyleCapacityGate {
  const now = options.now ?? (() => Date.now());
  let cooldownUntil = 0;
  let skippedSinceLastReport = 0;
  return {
    isCoolingDown: () => now() < cooldownUntil,
    shouldSkipFreestyle: () => {
      if (now() < cooldownUntil) {
        skippedSinceLastReport++;
        return true;
      }
      return false;
    },
    recordAccountLimit: () => {
      const alreadyCoolingDown = now() < cooldownUntil;
      cooldownUntil = now() + options.cooldownMs;
      if (alreadyCoolingDown) {
        // A concurrent execution that started before the cooldown opened; the
        // one that opened it already reported.
        return { shouldReport: false, skippedSinceLastReport };
      }
      const skipped = skippedSinceLastReport;
      skippedSinceLastReport = 0;
      return { shouldReport: true, skippedSinceLastReport: skipped };
    },
  };
}
