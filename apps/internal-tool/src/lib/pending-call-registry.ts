/**
 * Tracks in-flight promises so they can be force-rejected when their
 * underlying transport goes away.
 *
 * Motivation: the SpacetimeDB SDK never settles a reducer-call promise on a
 * connection that gets disconnected — outbound messages are queued on an
 * inactive socket (never flushed once the instance is torn down) and the
 * promise only settles when a server reply arrives. Without this, a call in
 * flight during our proactive token reconnect (or component unmount) would
 * hang forever, e.g. leaving a button stuck in its loading state.
 */
export type PendingCallRegistry = {
  track: <T>(promise: Promise<T>) => Promise<T>,
  rejectAll: (error: Error) => void,
  readonly pendingCount: number,
};

export function createPendingCallRegistry(): PendingCallRegistry {
  const rejectors = new Set<(error: Error) => void>();
  return {
    /**
     * Wraps a promise so it settles with the original result, unless
     * `rejectAll` fires first — whichever settles first wins.
     */
    track<T>(promise: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        rejectors.add(reject);
        // The .then handlers settle the outer promise, so the chained
        // .finally can't produce an unhandled rejection.
        promise.then(resolve, reject).finally(() => rejectors.delete(reject));
      });
    },
    /**
     * Rejects every tracked promise that is still pending. Promises tracked
     * after this call are unaffected, so the registry can be reused across
     * connection generations.
     */
    rejectAll(error: Error): void {
      const pending = [...rejectors];
      rejectors.clear();
      for (const reject of pending) {
        reject(error);
      }
    },
    get pendingCount(): number {
      return rejectors.size;
    },
  };
}
