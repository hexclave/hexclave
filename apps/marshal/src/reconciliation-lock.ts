import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createReconciliationLease, readReconciliationLease, releaseReconciliationLease, replaceReconciliationLease } from "./store.js";
import { MutationOutcomeUnknownError, RECONCILIATION_TAKEOVER_GRACE_MS } from "./mutation-safety.js";
import type { ReconciliationLease } from "./types.js";

export type LeaseTimings = {
  durationMs: number,
  renewIntervalMs: number,
  contendedPollMs: number,
  takeoverGraceMs: number,
  acquireTimeoutMs: number,
};

const DEFAULT_TIMINGS: LeaseTimings = {
  durationMs: 2 * 60 * 1000,
  renewIntervalMs: 20 * 1000,
  contendedPollMs: 1000,
  takeoverGraceMs: RECONCILIATION_TAKEOVER_GRACE_MS,
  // Contention has to end in an answer, not a hang — see acquireLease. Comfortably longer
  // than one renew interval, so a healthy owner finishing normal work is still waited out,
  // and far shorter than the backend's 15-minute apply timeout, so the caller learns to retry
  // while its own request is still alive.
  acquireTimeoutMs: 60 * 1000,
};

export type ReconciliationLeaseGuard = {
  assertOwned: () => Promise<void>,
};

export class ReconciliationLeaseLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReconciliationLeaseLostError";
  }
}

type HeldLease = {
  etag: string,
  value: ReconciliationLease,
};

async function acquireLease(ns: string, key: string, ownerId: string, timings: LeaseTimings): Promise<HeldLease> {
  // BOUNDED. A live owner that keeps renewing never expires, so an unbounded loop would poll
  // forever: the request holds a Marshal connection and a timer with nothing to end it, the
  // backend's own APPLY_TIMEOUT_MS abort is invisible from here, and every retry against the
  // same stuck lease stacks another loop in the process. Failing with the error app.ts already
  // maps to a retryable 409 turns contention into an answer the caller can act on.
  const deadline = Date.now() + timings.acquireTimeoutMs;
  for (;;) {
    const now = Date.now();
    const desired = { owner_id: ownerId, expires_at_millis: now + timings.durationMs } satisfies ReconciliationLease;
    const current = await readReconciliationLease(ns, key);
    if (current === null) {
      const etag = await createReconciliationLease(ns, key, desired);
      if (etag !== null) return { etag, value: desired };
    } else if (current.value.expires_at_millis + timings.takeoverGraceMs <= now) {
      // Conditional replacement is the distributed arbiter: exactly one Marshal replica can
      // take over an expired lease. The grace period also drains every bounded provider write the
      // previous owner could have started immediately before its last confirmed expiry.
      const etag = await replaceReconciliationLease(ns, key, desired, current.etag);
      if (etag !== null) return { etag, value: desired };
    }
    if (Date.now() >= deadline) {
      throw new ReconciliationLeaseLostError(`another reconciliation of ${JSON.stringify(key)} in namespace ${JSON.stringify(ns)} held the lease for longer than ${timings.acquireTimeoutMs}ms; retry`);
    }
    await delay(timings.contendedPollMs);
  }
}

async function waitForRenewalInterval(signal: AbortSignal, renewIntervalMs: number): Promise<boolean> {
  try {
    await delay(renewIntervalMs, undefined, { signal });
    return true;
  } catch (error) {
    if (signal.aborted && error instanceof Error && error.name === "AbortError") return false;
    throw error;
  }
}

export async function withReconciliationLease<T>(
  ns: string,
  key: string,
  action: (guard: ReconciliationLeaseGuard) => Promise<T>,
  timings: LeaseTimings = DEFAULT_TIMINGS,
): Promise<T> {
  const ownerId = randomUUID();
  let held = await acquireLease(ns, key, ownerId, timings);
  let lostError: Error | null = null;
  const stop = new AbortController();

  const heartbeat = (async () => {
    while (await waitForRenewalInterval(stop.signal, timings.renewIntervalMs)) {
      const desired = { owner_id: ownerId, expires_at_millis: Date.now() + timings.durationMs } satisfies ReconciliationLease;
      try {
        const etag = await replaceReconciliationLease(ns, key, desired, held.etag);
        if (etag === null) {
          lostError = new ReconciliationLeaseLostError(`lost reconciliation lease for ${ns}/${key}`);
          return;
        }
        held = { etag, value: desired };
      } catch (error) {
        // A transient S3 failure does not prove the lease was lost. Keep retrying while the
        // last confirmed lease remains live; assertOwned fails closed once it expires.
        if (Date.now() >= held.value.expires_at_millis) {
          lostError = new ReconciliationLeaseLostError(`could not renew reconciliation lease for ${ns}/${key} before it expired`, { cause: error });
          return;
        }
      }
    }
  })();

  const guard: ReconciliationLeaseGuard = {
    assertOwned: async () => {
      if (lostError !== null) throw lostError;
      if (Date.now() >= held.value.expires_at_millis) {
        throw new ReconciliationLeaseLostError(`reconciliation lease for ${ns}/${key} expired before a provider mutation`);
      }
    },
  };

  let actionFailed = false;
  let preserveLeaseForDrain = false;
  try {
    return await action(guard);
  } catch (error) {
    actionFailed = true;
    preserveLeaseForDrain = error instanceof MutationOutcomeUnknownError;
    throw error;
  } finally {
    stop.abort();
    await heartbeat;
    if (!preserveLeaseForDrain) {
      try {
        const released = await releaseReconciliationLease(ns, key, held.etag);
        if (!released && !actionFailed) {
          // Still fails the request — another owner holding this lease means the
          // action was NOT serialized, and reporting success would be a lie. But
          // it is a fencing outcome, not an internal fault: typed as one so the
          // HTTP layer answers "retry" instead of "internal error".
          throw new ReconciliationLeaseLostError(`reconciliation lease for ${ns}/${key} was replaced before it could be released`);
        }
      } catch (error) {
        // Preserve the action's original error. On success, a release failure must surface:
        // otherwise callers could believe a reconciliation was safely serialized when it was not.
        if (!actionFailed) throw error;
        console.error(`releasing reconciliation lease for ${ns}/${key} failed after the action also failed`, error);
      }
    }
  }
}
