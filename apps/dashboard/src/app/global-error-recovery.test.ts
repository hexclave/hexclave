// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY,
  GLOBAL_ERROR_RECOVERY_WINDOW_MS,
  MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS,
  recordGlobalErrorRecoveryAttempt,
} from "./global-error-recovery";

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("global error recovery", () => {
  it("stops retrying after the recovery limit", () => {
    vi.useFakeTimers();
    expect(Array.from({ length: MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS }, () => recordGlobalErrorRecoveryAttempt())).toEqual([true, true]);
    expect(recordGlobalErrorRecoveryAttempt()).toBe(false);
    expect(JSON.parse(window.sessionStorage.getItem(GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY) ?? "{}")).toMatchObject({
      attempts: MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS,
    });
  });

  it("allows a fresh attempt after the recovery window", () => {
    vi.useFakeTimers();
    recordGlobalErrorRecoveryAttempt();
    vi.advanceTimersByTime(GLOBAL_ERROR_RECOVERY_WINDOW_MS + 1);
    expect(recordGlobalErrorRecoveryAttempt()).toBe(true);
  });

  it("allows a fresh attempt when the stored timestamp is in the future", () => {
    vi.useFakeTimers();
    const now = performance.timeOrigin + performance.now();
    window.sessionStorage.setItem(
      GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY,
      JSON.stringify({
        attempts: MAX_GLOBAL_ERROR_RECOVERY_ATTEMPTS,
        lastAttemptAt: now + GLOBAL_ERROR_RECOVERY_WINDOW_MS,
      }),
    );

    expect(recordGlobalErrorRecoveryAttempt()).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(GLOBAL_ERROR_RECOVERY_ATTEMPTS_KEY) ?? "{}")).toMatchObject({
      attempts: 1,
    });
  });
});
