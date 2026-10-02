import { AsyncLocalStorage } from "node:async_hooks";

type NodeTelemetrySuppressionRunner = <T>(fn: () => Promise<T>) => Promise<T>;

const NODE_TELEMETRY_SUPPRESSION_RUNNER_KEY = Symbol.for(
  "hexclave.backend.node-telemetry-suppression-runner.v1",
);
const NODE_TELEMETRY_SUPPRESSION_STATE_KEY = Symbol.for(
  "hexclave.backend.node-telemetry-suppression-state.v1",
);

declare global {
  namespace NodeJS {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- declaration merging cannot be expressed as a type alias
    interface Process {
      [NODE_TELEMETRY_SUPPRESSION_RUNNER_KEY]?: NodeTelemetrySuppressionRunner;
      [NODE_TELEMETRY_SUPPRESSION_STATE_KEY]?: AsyncLocalStorage<boolean>;
    }
  }
}

function getNodeTelemetrySuppressionState(): AsyncLocalStorage<boolean> {
  process[NODE_TELEMETRY_SUPPRESSION_STATE_KEY] ??= new AsyncLocalStorage<boolean>();
  return process[NODE_TELEMETRY_SUPPRESSION_STATE_KEY];
}

/**
 * A backend-owned task-local guard in addition to OTel's context flag. Next.js
 * can evaluate route and instrumentation code through different server chunks;
 * the process-global ALS lets the registered SDK predicate observe collector
 * suppression even if an OTel context copy is not the one the route entered.
 */
export function isNodeTelemetrySuppressed(): boolean {
  return getNodeTelemetrySuppressionState().getStore() === true;
}

/**
 * Publishes a closure from the exact SDK instance that registered Prisma's
 * tracer provider. Next.js may evaluate instrumentation.ts and route modules
 * in separate server chunks, so reconstructing the instrumentation in the
 * route can otherwise suppress a different bridge instance.
 */
export function registerNodeTelemetrySuppressionRunner(
  runner: NodeTelemetrySuppressionRunner,
): void {
  process[NODE_TELEMETRY_SUPPRESSION_RUNNER_KEY] = runner;
}

export async function runWithNodeTelemetrySuppressed<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const runner = process[NODE_TELEMETRY_SUPPRESSION_RUNNER_KEY];
  if (runner === undefined) {
    throw new Error(
      "Backend telemetry suppression requires Node instrumentation to be registered first",
    );
  }
  return await getNodeTelemetrySuppressionState().run(
    true,
    async () => await runner(fn),
  );
}

export function resetNodeTelemetrySuppressionRunnerForTesting(): void {
  delete process[NODE_TELEMETRY_SUPPRESSION_RUNNER_KEY];
  process[NODE_TELEMETRY_SUPPRESSION_STATE_KEY]?.disable();
  delete process[NODE_TELEMETRY_SUPPRESSION_STATE_KEY];
}
