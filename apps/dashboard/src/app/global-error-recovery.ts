export const GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY = "hexclave-global-error-recovery-attempts";
export const MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS = 2;
export const GLOBAL_ERROR_RECOVERY_WINDOW_MS = 30_000;

type RecoveryState = {
  attempts: number;
  lastAttemptAt: number;
};

function getRecoveryState(): RecoveryState | null {
  const value = window.sessionStorage.getItem(GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY);
  if (value === null) {
    return null;
  }
  try {
    const state: unknown = JSON.parse(value);
    if (typeof state === "object" && state !== null) {
      const attempts = Object.getOwnPropertyDescriptor(state, "attempts")?.value;
      const lastAttemptAt = Object.getOwnPropertyDescriptor(state, "lastAttemptAt")?.value;
      if (
        typeof attempts === "number"
        && Number.isInteger(attempts)
        && attempts >= 0
        && typeof lastAttemptAt === "number"
        && Number.isFinite(lastAttemptAt)
      ) {
        return { attempts, lastAttemptAt };
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Invalid state is treated as a fresh recovery window.
      return null;
    }
    throw error;
  }
  return null;
}

export function recordGlobalErrorRecoveryAttempt(): boolean {
  const now = performance.timeOrigin + performance.now();
  const state = getRecoveryState();
  const attempts = state !== null
    && now >= state.lastAttemptAt
    && now - state.lastAttemptAt <= GLOBAL_ERROR_RECOVERY_WINDOW_MS
    ? state.attempts
    : 0;
  if (attempts >= MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS) {
    return false;
  }
  window.sessionStorage.setItem(
    GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY,
    JSON.stringify({ attempts: attempts + 1, lastAttemptAt: now } satisfies RecoveryState),
  );
  return true;
}
