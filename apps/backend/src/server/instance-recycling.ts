// Opt-in recycling of long-lived instances: after a (jittered) maximum lifetime,
// the instance starts failing its readiness endpoint so the platform (e.g. Cloud
// Run with a readiness probe on /health/ready) stops routing new requests to it,
// waits for in-flight requests to finish, and then runs the normal graceful
// shutdown so the autoscaler can replace it with a fresh instance.
//
// Failing readiness alone never terminates an instance on Cloud Run — it would
// sit there unready, still counting against max instances — so exiting
// ourselves after the drain is required.

export const maxInstanceLifetimeEnvVar = "HEXCLAVE_MAX_INSTANCE_LIFETIME_SECONDS";

const minLifetimeSeconds = 60;
// Instances that started together (e.g. during a scale-up) would otherwise all
// recycle at the same moment and drop capacity at once.
const maxJitterFraction = 0.25;
// Time for the platform to observe the failing readiness probe and stop routing
// to us. Requests keep arriving until then, so in-flight reaching zero earlier
// does not mean we are drained. The readiness probe must detect failure within
// this window (e.g. periodSeconds 5 × failureThreshold 2 = 10s).
export const readinessPropagationDelayMs = 20_000;
// Upper bound on waiting for in-flight requests; anything still running after
// this is presumed stuck and is left to the regular shutdown budget.
export const maxDrainWaitMs = 5 * 60_000;
const drainPollIntervalMs = 500;

export type InstanceRecyclingConfig = {
  lifetimeMs: number,
};

export type InstanceRecyclingLogEvent = {
  event: "backend.instance-recycling.scheduled" | "backend.instance-recycling.draining" | "backend.instance-recycling.drained",
  lifetimeMs?: number,
  inFlightRequests?: number,
  drainDurationMs?: number,
  timedOut?: boolean,
};

export function parseInstanceRecyclingConfig(value: string): InstanceRecyclingConfig | undefined {
  if (value.trim() === "") {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < minLifetimeSeconds) {
    throw new Error(`${maxInstanceLifetimeEnvVar} must be a number of seconds >= ${minLifetimeSeconds}, got: ${JSON.stringify(value)}`);
  }
  return { lifetimeMs: seconds * 1000 };
}

export function createInstanceRecycler(options: { random?: () => number, now?: () => number } = {}) {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());
  let draining = false;
  let inFlightRequests = 0;
  let started = false;

  return {
    async trackRequest<T>(handler: () => Promise<T>): Promise<T> {
      inFlightRequests++;
      try {
        return await handler();
      } finally {
        inFlightRequests--;
      }
    },

    getInFlightRequestCount: () => inFlightRequests,

    isDraining: () => draining,

    createReadinessResponse(): Response {
      return Response.json({ status: draining ? "draining" : "ready" }, { status: draining ? 503 : 200 });
    },

    start(startOptions: {
      config: InstanceRecyclingConfig,
      onDrained: () => void,
      log: (event: InstanceRecyclingLogEvent) => void,
    }) {
      if (started) {
        throw new Error("Instance recycling was started twice");
      }
      started = true;
      const lifetimeMs = Math.round(startOptions.config.lifetimeMs * (1 + random() * maxJitterFraction));
      startOptions.log({ event: "backend.instance-recycling.scheduled", lifetimeMs });

      // unref() so a pending recycle never keeps an otherwise-finished process alive.
      setTimeout(() => {
        draining = true;
        const drainStartedAt = now();
        startOptions.log({ event: "backend.instance-recycling.draining", inFlightRequests });

        const poll = () => {
          const elapsedMs = now() - drainStartedAt;
          const timedOut = elapsedMs >= maxDrainWaitMs;
          if (timedOut || (elapsedMs >= readinessPropagationDelayMs && inFlightRequests === 0)) {
            startOptions.log({
              event: "backend.instance-recycling.drained",
              inFlightRequests,
              drainDurationMs: Math.round(elapsedMs),
              timedOut,
            });
            startOptions.onDrained();
            return;
          }
          setTimeout(poll, drainPollIntervalMs).unref();
        };
        poll();
      }, lifetimeMs).unref();
    },
  };
}

export const instanceRecycler = createInstanceRecycler();
