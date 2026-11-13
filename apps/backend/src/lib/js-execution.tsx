import { traceSpan } from '@/utils/telemetry';
import { getOptionalRequestAbortSignal } from '@/lib/runtime/request-context';
import { runAsynchronouslyAndWaitUntil } from '@/utils/background-tasks';
import { getEnvVariable, getNodeEnvironment } from '@hexclave/shared/dist/utils/env';
import { HexclaveAssertionError, captureError } from '@hexclave/shared/dist/utils/errors';
import { Sandbox } from '@vercel/sandbox';
import { Freestyle as FreestyleClient } from 'freestyle';
import { wait } from '@hexclave/shared/dist/utils/promises';
import { createFreestyleCapacityGate, isFreestyleAccountLimitError } from './freestyle-capacity';
import {
  DEFAULT_FREESTYLE_SNAPSHOT_ID,
  executeJavascriptInFreestyleVm,
  isExecuteResult,
} from './freestyle-vm-js-execution';
import type { ExecuteResult } from './js-execution-types';

export type { ExecuteResult } from './js-execution-types';

export type ExecuteJavascriptOptions = {
  /** Cancels provider setup, command execution, and fallback attempts. */
  signal?: AbortSignal,
  nodeModules?: Record<string, string>,
  /**
   * Maximum time the caller allows the execution provider to remain alive.
   * Vercel Sandbox enforces this as a whole-sandbox lifetime, so callers
   * running long-lived code must set it explicitly.
   */
  executionTimeoutMs?: number,
  /**
   * Skip the random cross-engine sanity comparison for this invocation.
   * REQUIRED for side-effectful code (e.g. workflow step execution): the
   * sanity test runs the code on BOTH engines, which would double-fire its
   * side effects.
   */
  disableSanityTest?: boolean,
  /**
   * Substitute attached to error reports instead of the raw code. Set this
   * when the code embeds secrets/credentials (e.g. the workflow invocation
   * prelude) so they can never leak into Sentry.
   */
  logSafeCode?: string,
};

type JsEngine = {
  name: string,
  execute: (code: string, options: ExecuteJavascriptOptions) => Promise<ExecuteResult>,
};

function createFreestyleEngine(): JsEngine {
  return {
    name: 'freestyle',
    execute: async (code: string, options: ExecuteJavascriptOptions): Promise<ExecuteResult> => {
      const apiKey = getEnvVariable("STACK_FREESTYLE_API_KEY");
      let baseUrl = getEnvVariable("STACK_FREESTYLE_API_ENDPOINT", "") || undefined;

      if (apiKey === "mock_stack_freestyle_key") {
        if (!["development", "test"].includes(getNodeEnvironment())) {
          throw new HexclaveAssertionError("Mock Freestyle key used in production; please set the STACK_FREESTYLE_API_KEY environment variable.");
        }
        if (!baseUrl) {
          const prefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
          baseUrl = `http://localhost:${prefix}22`;
        }
        return await executeJavascriptWithLocalFreestyleMock(baseUrl, code, options);
      }

      const freestyle = new FreestyleClient({
        apiKey,
        baseUrl,
      });
      const snapshotId = getEnvVariable(
        "STACK_FREESTYLE_SNAPSHOT_ID",
        DEFAULT_FREESTYLE_SNAPSHOT_ID,
      );
      return await executeJavascriptInFreestyleVm({
        snapshotId,
        code,
        nodeModules: new Map(Object.entries(options.nodeModules ?? {})),
        executionTimeoutMs: options.executionTimeoutMs,
        signal: options.signal,
        scheduleCleanup: runAsynchronouslyAndWaitUntil,
        onCleanupError: (vmId, error) => {
          captureError("js-execution-freestyle-vm-cleanup-failed", new HexclaveAssertionError(
            "Failed to delete Freestyle VM after JavaScript execution",
            { cause: error, vmId },
          ));
        },
        createVm: async (createOptions) => {
          const { vm } = await freestyle.vms.create(createOptions);
          return {
            id: vm.id,
            makeDirectory: async (path) => {
              await vm.fs.mkdir(path);
            },
            writeTextFile: async (path, content, signal) => {
              await vm.fs.writeTextFile(path, content, { signal });
            },
            readTextFile: async (path, signal) => {
              return await vm.fs.readTextFile(path, { signal });
            },
            openPty: async (ptyOptions) => {
              return await vm.pty.open(ptyOptions);
            },
            delete: async () => {
              await vm.delete();
            },
          };
        },
      });
    },
  };
}

async function executeJavascriptWithLocalFreestyleMock(
  baseUrl: string,
  code: string,
  options: ExecuteJavascriptOptions,
): Promise<ExecuteResult> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/execute/v3/script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: code,
      config: {
        nodeModules: options.nodeModules ?? {},
        timeout: options.executionTimeoutMs,
      },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new HexclaveAssertionError("Local Freestyle mock execution failed", {
      statusCode: response.status,
      innerCode: options.logSafeCode ?? code,
      innerOptions: options,
    });
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new HexclaveAssertionError("Local Freestyle mock returned no result", {
      innerCode: options.logSafeCode ?? code,
      innerOptions: options,
    });
  }
  const result = body.result;
  if (!isExecuteResult(result)) {
    throw new HexclaveAssertionError("Local Freestyle mock returned a malformed result", {
      result,
      innerCode: options.logSafeCode ?? code,
      innerOptions: options,
    });
  }
  return result;
}

function createVercelSandboxEngine(): JsEngine {
  return {
    name: 'vercel-sandbox',
    execute: async (code: string, options: ExecuteJavascriptOptions): Promise<ExecuteResult> => {
      const teamId = getEnvVariable("STACK_VERCEL_SANDBOX_TEAM_ID");
      const projectId = getEnvVariable("STACK_VERCEL_SANDBOX_PROJECT_ID");
      const token = getEnvVariable("STACK_VERCEL_SANDBOX_TOKEN");

      const sandbox = await Sandbox.create({
        resources: { vcpus: 2 },
        timeout: options.executionTimeoutMs ?? 30_000,
        runtime: 'node24' as const,
        teamId: teamId || undefined,
        projectId: projectId || undefined,
        token: token || undefined,
        signal: options.signal,
      });

      try {
        if (options.nodeModules && Object.keys(options.nodeModules).length > 0) {
          const packages = Object.entries(options.nodeModules)
            .map(([name, version]) => `${name}@${version}`);

          const installResult = await sandbox.runCommand('npm', ['install', '--no-save', ...packages], {
            signal: options.signal,
          });

          if (installResult.exitCode !== 0) {
            // npm's own output is the only way to tell a registry outage or
            // throttle from a bad package spec; it never contains the code.
            const npmStderrTail = await readCommandOutputTail(installResult, options.signal);
            throw new HexclaveAssertionError("Failed to install packages in Vercel Sandbox", { exitCode: installResult.exitCode, npmStderrTail, innerCode: options.logSafeCode ?? code, innerOptions: options });
          }
        }

        const resultPath = '/vercel/sandbox/result.json';

        const runnerScript = `
          import { writeFileSync } from 'fs';
          import fn from './code.mjs';
          const result = await fn();
          writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
        `;

        await sandbox.writeFiles([
          { path: '/vercel/sandbox/code.mjs', content: Buffer.from(code, 'utf-8') },
          { path: '/vercel/sandbox/runner.mjs', content: Buffer.from(runnerScript, 'utf-8') },
        ], { signal: options.signal });

        const runResult = await sandbox.runCommand('node', ['/vercel/sandbox/runner.mjs'], {
          signal: options.signal,
        });

        if (runResult.exitCode !== 0) {
          throw new HexclaveAssertionError("Vercel Sandbox runner exited with non-zero code", { innerCode: options.logSafeCode ?? code, innerOptions: options, exitCode: runResult.exitCode });
        }

        const resultBuffer = await sandbox.readFileToBuffer({ path: resultPath }, { signal: options.signal });
        if (resultBuffer === null) {
          throw new HexclaveAssertionError("Result file not found in Vercel Sandbox", { resultPath, innerCode: options.logSafeCode ?? code, innerOptions: options });
        }
        const resultJson = resultBuffer.toString();

        try {
          return JSON.parse(resultJson);
        } catch (e: any) {
          throw new HexclaveAssertionError("Failed to parse result from Vercel Sandbox", { resultJson, cause: e, innerCode: options.logSafeCode ?? code, innerOptions: options });
        }
      } finally {
        const cleanupPromise = stopVercelSandboxAfterExecution(sandbox);
        if (options.signal?.aborted === true) {
          // Once the caller has timed out, cleanup must not add another five
          // seconds to its latency. Keep the teardown owned by the invocation
          // so Vercel or standalone shutdown still gives it time to finish.
          runAsynchronouslyAndWaitUntil(cleanupPromise);
        } else {
          await cleanupPromise;
        }
      }
    },
  };
}

const COMMAND_OUTPUT_TAIL_CHARS = 2000;

async function readCommandOutputTail(
  command: { stderr: (opts?: { signal?: AbortSignal }) => Promise<string> },
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const output = await command.stderr({ signal });
    return output.slice(-COMMAND_OUTPUT_TAIL_CHARS);
  } catch {
    // Diagnostics only: never let a failed log read replace the real error.
    return undefined;
  }
}

async function stopVercelSandboxAfterExecution(sandbox: Sandbox): Promise<void> {
  try {
    // The operation signal may already be aborted, but stopping the
    // already-created sandbox is exactly the cleanup that still needs to run.
    await sandbox.stop({ signal: AbortSignal.timeout(5000) });
  } catch (error) {
    // Teardown failure is observable, but must not replace the execution
    // result or the original provider error that led us into `finally`.
    captureError("js-execution-vercel-sandbox-cleanup-failed", new HexclaveAssertionError(
      "Failed to stop Vercel Sandbox after JavaScript execution",
      { cause: error },
    ));
  }
}

// Long enough to cover most of a burst with one report, short enough that a
// cleared account is back on Freestyle within seconds.
const FREESTYLE_ACCOUNT_LIMIT_COOLDOWN_MS = 30_000;
const freestyleCapacityGate = createFreestyleCapacityGate({ cooldownMs: FREESTYLE_ACCOUNT_LIMIT_COOLDOWN_MS });

const engineMap = new Map<string, JsEngine>([
  ['freestyle', createFreestyleEngine()],
  ['vercel-sandbox', createVercelSandboxEngine()],
]);

/**
 * Executes the given code with the given options. Returns the result of the code execution
 * if it is JSON-serializable. Has undefined behavior if it is not JSON-serializable or if
 * the code throws an error.
 */
export async function executeJavascript(code: string, options: ExecuteJavascriptOptions = {}): Promise<ExecuteResult> {
  const resolvedOptions: ExecuteJavascriptOptions = {
    ...options,
    signal: options.signal ?? getOptionalRequestAbortSignal(),
  };
  return await traceSpan({
    description: 'js-execution.executeJavascript',
    attributes: {
      'js-execution.code.length': code.length.toString(),
      'js-execution.nodeModules.count': resolvedOptions.nodeModules ? Object.keys(resolvedOptions.nodeModules).length.toString() : '0',
    }
  }, async () => {
    resolvedOptions.signal?.throwIfAborted();

    if (getEnvVariable("STACK_VERCEL_SANDBOX_TOKEN") != "vercel_sandbox_disabled_for_local_development") {
      // While Freestyle is out of capacity, a canary that runs on both engines
      // only competes with real executions for the exhausted account.
      const shouldSanityTest = !resolvedOptions.disableSanityTest && !freestyleCapacityGate.isCoolingDown() && Math.random() < 0.05;
      if (shouldSanityTest) {
        runAsynchronouslyAndWaitUntil(runSanityTestWithoutExpectedCancellation(code, resolvedOptions));
      }

      return await runWithFallback(code, resolvedOptions);
    } else {
      if (getNodeEnvironment().includes("prod")) {
        throw new HexclaveAssertionError("STACK_VERCEL_SANDBOX_TOKEN is set to the disabled sentinel value in production. Please configure a real Vercel Sandbox token.");
      }

      return await runWithoutFallback(code, resolvedOptions);
    }
  });
}

async function runSanityTestWithoutExpectedCancellation(code: string, options: ExecuteJavascriptOptions): Promise<void> {
  try {
    await runSanityTest(code, options);
  } catch (error) {
    // Client disconnects are expected cancellation, not failed canary executions.
    // Only suppress the exact reason thrown by this signal; unrelated failures
    // still reach runAsynchronouslyAndWaitUntil's error reporting.
    if (options.signal?.aborted !== true || error !== options.signal.reason) {
      throw error;
    }
  }
}

/**
 * Compare two execution results for sanity test equality.
 * For error results, we only compare status and message (not stack traces,
 * which differ between execution environments).
 */
function areResultsEqual(a: ExecuteResult, b: ExecuteResult): boolean {
  if (a.status !== b.status) return false;

  if (a.status === 'ok' && b.status === 'ok') {
    return JSON.stringify(a.data) === JSON.stringify(b.data);
  }

  if (a.status === 'error' && b.status === 'error') {
    return a.error.message === b.error.message;
  }

  return false;
}

async function runSanityTest(code: string, options: ExecuteJavascriptOptions) {
  const results: Array<{ engine: string, result: unknown }> = [];
  const failures: Array<{ engine: string, error: unknown }> = [];

  for (const [name, engine] of engineMap) {
    options.signal?.throwIfAborted();
    try {
      const result = await engine.execute(code, options);
      results.push({ engine: name, result });
    } catch (error) {
      options.signal?.throwIfAborted();
      failures.push({ engine: name, error });
    }
  }

  if (failures.length > 0) {
    captureError("js-execution-sanity-test-failures", new HexclaveAssertionError(
      `JS execution sanity test: ${failures.length} engine(s) failed`,
      { failures, successfulEngines: results.map(r => r.engine), innerCode: options.logSafeCode ?? code, innerOptions: options }
    ));
  }

  if (results.length < 2) {
    return;
  }

  const referenceResult = results[0].result as ExecuteResult;
  const allEqual = results.every(r => areResultsEqual(r.result as ExecuteResult, referenceResult));
  if (!allEqual) {
    captureError("js-execution-sanity-test-mismatch", new HexclaveAssertionError(
      "JS execution sanity test: engines returned different results",
      { results, innerCode: options.logSafeCode ?? code, innerOptions: options }
    ));
  }
}

async function runWithFallback(code: string, options: ExecuteJavascriptOptions): Promise<ExecuteResult> {
  const freestyleEngine = engineMap.get("freestyle")!;

  if (freestyleCapacityGate.shouldSkipFreestyle()) {
    // Freestyle rejected a VM for account capacity moments ago; it was
    // reported then. Go straight to the fallback instead of spending two
    // doomed attempts and their backoff on every execution of the burst.
    return await runVercelSandboxFallback(code, options);
  }

  const maxAttempts = 2;
  const attemptErrors: unknown[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await freestyleEngine.execute(code, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      attemptErrors.push(error);
      // The account limit does not clear within a retry's backoff.
      if (isFreestyleAccountLimitError(error)) break;
      if (attempt < maxAttempts - 1) {
        await wait((Math.random() + 0.5) * 500 * (2 ** attempt));
      }
    }
  }
  const freestyleError = new AggregateError(
    attemptErrors,
    `Freestyle failed after ${attemptErrors.length} attempt(s)`,
    { cause: attemptErrors[attemptErrors.length - 1] },
  );

  options.signal?.throwIfAborted();

  if (isFreestyleAccountLimitError(freestyleError)) {
    const { shouldReport, skippedSinceLastReport } = freestyleCapacityGate.recordAccountLimit();
    if (shouldReport) {
      captureError(`js-execution-freestyle-account-limit`, new HexclaveAssertionError(
        `Freestyle account resource limit reached; sending JS executions straight to the vercel sandbox engine for ${FREESTYLE_ACCOUNT_LIMIT_COOLDOWN_MS / 1000}s`,
        { cause: freestyleError, skippedSinceLastReport, innerCode: options.logSafeCode ?? code, innerOptions: options }
      ));
    }
  } else {
    captureError(`js-execution-freestyle-failed`, new HexclaveAssertionError(
      `JS execution freestyle engine failed, falling back to vercel sandbox engine`,
      { cause: freestyleError, innerCode: options.logSafeCode ?? code, innerOptions: options }
    ));
  }

  return await runVercelSandboxFallback(code, options);
}

async function runVercelSandboxFallback(code: string, options: ExecuteJavascriptOptions): Promise<ExecuteResult> {
  const vercelSandboxEngine = engineMap.get("vercel-sandbox")!;

  try {
    const result = await vercelSandboxEngine.execute(code, options);
    return result;
  } catch (error){
      options.signal?.throwIfAborted();
      captureError(`js-execution-vercel-sandbox-failed`, new HexclaveAssertionError(
        `JS execution vercel sandbox engine failed after fallback from freestyle engine`,
        { cause: error, innerCode: options.logSafeCode ?? code, innerOptions: options }
      ));
      throw new HexclaveAssertionError("Vercel Sandbox service unavailable", { cause: error, innerCode: options.logSafeCode ?? code, innerOptions: options });
  }
}

async function runWithoutFallback(code: string, options: ExecuteJavascriptOptions): Promise<ExecuteResult> {
  const freestyleEngine = engineMap.get("freestyle")!;
  try {
    const result = await freestyleEngine.execute(code, options);
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new HexclaveAssertionError("Freestyle rendering service unavailable when running without fallback", { cause: error, innerCode: options.logSafeCode ?? code, innerOptions: options });
  }
}
