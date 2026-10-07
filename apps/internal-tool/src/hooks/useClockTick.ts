import { useEffect, useState } from "react";

/**
 * A `now` that re-renders on a fixed cadence. Several views classify rows purely by elapsed time
 * (an unreviewed MCP call reads as "pending" and then, after QA_REVIEW_FAILED_THRESHOLD_MS, as
 * "review failed"), so a component that computes such a state from `Date.now()` during render
 * would freeze on whatever the clock said at its last data change. Reading the clock through this
 * hook keeps those states moving even when the subscription is quiet.
 */
export const DEFAULT_CLOCK_TICK_MS = 60_000;

export function useClockTick(intervalMs: number = DEFAULT_CLOCK_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
