export type BackendShutdownDependencies = {
  stopAcceptingRequests: (timeoutMs: number) => Promise<void>,
  drainBackgroundTasks: (timeoutMs: number) => Promise<void>,
  disconnectDatabases: (timeoutMs: number) => Promise<void>,
  closeInstrumentation: (timeoutMs: number) => Promise<void>,
  log: (event: BackendShutdownLogEvent) => void,
};

// Cloud Run and Docker commonly allow ten seconds between SIGTERM and SIGKILL.
// Graceful work ends one second before our hard exit, which itself runs one
// second before the platform kill, so the process owns its terminal log and
// exit code. Database and instrumentation time is reserved from the end of the
// graceful deadline; HTTP has a cap because close waits for active requests,
// while background work receives any time HTTP did not use.
export const backendShutdownBudget = {
  gracefulShutdownTimeoutMs: 8000,
  httpServerMaxTimeoutMs: 2000,
  databaseMaxTimeoutMs: 1000,
  instrumentationMaxTimeoutMs: 1000,
  hardExitTimeoutMs: 9000,
  platformGracePeriodMs: 10000,
};

export type BackendShutdownLogEvent = {
  event: "backend.shutdown.started" | "backend.shutdown.completed" | "backend.shutdown.failed",
  signal: NodeJS.Signals,
  durationMs?: number,
  failedSteps?: string[],
};

type ShutdownStep = {
  name: string,
  run: () => Promise<void>,
};

export async function runShutdownOperationWithTimeout<T>(
  operationName: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${operationName} did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
  }
}

async function runShutdownStep(step: ShutdownStep) {
  const [result] = await Promise.allSettled([Promise.resolve().then(step.run)]);
  return {
    name: step.name,
    result,
  };
}

function getRemainingShutdownTimeoutMs(
  deadline: number,
  reservedTailMs: number,
  now: () => number,
): number {
  return Math.max(0, Math.floor(deadline - now() - reservedTailMs));
}

/**
 * Stops ingress first, then drains resources in dependency order against one
 * monotonic deadline. Each phase uses allSettled so one broken cleanup path
 * cannot prevent telemetry from reporting it.
 */
export async function shutdownBackend(
  signal: NodeJS.Signals,
  dependencies: BackendShutdownDependencies,
  now: () => number = () => performance.now(),
): Promise<void> {
  const startedAt = now();
  const deadline = startedAt + backendShutdownBudget.gracefulShutdownTimeoutMs;
  const cleanupTailMs = (
    backendShutdownBudget.databaseMaxTimeoutMs
    + backendShutdownBudget.instrumentationMaxTimeoutMs
  );
  dependencies.log({
    event: "backend.shutdown.started",
    signal,
  });

  const results = [
    await runShutdownStep({
      name: "http-server",
      run: async () => await dependencies.stopAcceptingRequests(Math.min(
        backendShutdownBudget.httpServerMaxTimeoutMs,
        getRemainingShutdownTimeoutMs(deadline, cleanupTailMs, now),
      )),
    }),
    await runShutdownStep({
      name: "background-tasks",
      run: async () => await dependencies.drainBackgroundTasks(
        getRemainingShutdownTimeoutMs(deadline, cleanupTailMs, now),
      ),
    }),
    await runShutdownStep({
      name: "databases",
      run: async () => await dependencies.disconnectDatabases(Math.min(
        backendShutdownBudget.databaseMaxTimeoutMs,
        getRemainingShutdownTimeoutMs(deadline, backendShutdownBudget.instrumentationMaxTimeoutMs, now),
      )),
    }),
    await runShutdownStep({
      name: "instrumentation",
      run: async () => await dependencies.closeInstrumentation(Math.min(
        backendShutdownBudget.instrumentationMaxTimeoutMs,
        getRemainingShutdownTimeoutMs(deadline, 0, now),
      )),
    }),
  ];
  const failures = results.filter((entry) => entry.result.status === "rejected");

  if (failures.length > 0) {
    const failedSteps = failures.map((entry) => entry.name);
    dependencies.log({
      event: "backend.shutdown.failed",
      signal,
      durationMs: now() - startedAt,
      failedSteps,
    });
    throw new AggregateError(
      failures.map((entry) => entry.result.status === "rejected" ? entry.result.reason : undefined),
      `Backend shutdown failed in: ${failedSteps.join(", ")}`,
    );
  }

  dependencies.log({
    event: "backend.shutdown.completed",
    signal,
    durationMs: now() - startedAt,
  });
}
