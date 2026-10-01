import { useCallback, useEffect, useRef } from "react";

/**
 * A single-slot `setTimeout` bound to the component lifetime. Scheduling again replaces the
 * pending callback (so a second "queued ✓" flash is not cut short by the first one's timer), and
 * unmounting cancels it (so nothing calls `setState` on a component that is gone).
 */
export function useScheduledTimeout(): (callback: () => void, delayMs: number) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
  }, []);
  return useCallback((callback, delayMs) => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      callback();
    }, delayMs);
  }, []);
}
