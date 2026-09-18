import type { CreateVmOptions } from "freestyle";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import type { ExecuteResult } from "./js-execution-types";
export { DEFAULT_FREESTYLE_SNAPSHOT_ID } from "./freestyle-vm-constants";

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const CLEANUP_DELETE_ATTEMPTS = 3;
const DEFAULT_CLEANUP_RETRY_DELAY_BASE_MS = 500;
const VM_TTL_GRACE_SECONDS = 5 * 60;
const RUNTIME_ROOT = "/opt/hexclave-runtime";

type CleanupOptions = {
  timeoutMs: number,
  retryDelayBaseMs: number,
};

type FreestyleExecutionPty = {
  detach: () => void,
};

type OpenPtyOptions = {
  exec: string,
  onExit: (exitCode: number) => void,
  onClose: (info: { wasClean: boolean, code: number, reason: string }) => void,
  onError: (error: unknown) => void,
};

export type FreestyleExecutionVm = {
  id: string,
  makeDirectory: (path: string) => Promise<void>,
  writeTextFile: (path: string, content: string, signal: AbortSignal) => Promise<void>,
  readTextFile: (path: string, signal: AbortSignal) => Promise<string>,
  openPty: (options: OpenPtyOptions) => Promise<FreestyleExecutionPty>,
  delete: () => Promise<void>,
};

export type CreateFreestyleExecutionVm = (
  options: CreateVmOptions,
) => Promise<FreestyleExecutionVm>;

const runnerSource = `
import { writeFile } from "node:fs/promises";

const userModule = await import("./code.mjs");
const exported = userModule.default ?? userModule;
const result = await (typeof exported === "function" ? exported() : exported);
const serialized = JSON.stringify(result);
if (serialized === undefined) throw new Error("Sandbox result is not JSON-serializable");
await writeFile("./result.json", serialized);
`;

export async function executeJavascriptInFreestyleVm(options: {
  createVm: CreateFreestyleExecutionVm,
  snapshotId: string,
  code: string,
  nodeModules: Map<string, string>,
  executionTimeoutMs?: number,
  cleanupTimeoutMs?: number,
  cleanupRetryDelayBaseMs?: number,
  signal?: AbortSignal,
  scheduleCleanup: (cleanup: Promise<void>) => void,
  onCleanupError: (vmId: string, error: unknown) => void,
}): Promise<ExecuteResult> {
  const timeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  const cleanupOptions: CleanupOptions = {
    timeoutMs: options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    retryDelayBaseMs: options.cleanupRetryDelayBaseMs ?? DEFAULT_CLEANUP_RETRY_DELAY_BASE_MS,
  };
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const executionSignal = options.signal == null
    ? timeoutSignal
    : AbortSignal.any([options.signal, timeoutSignal]);
  executionSignal.throwIfAborted();

  // The VM lifetime is bounded independently of this process. If the request
  // disappears while create is completing, Freestyle still deletes the
  // otherwise-unreachable VM after the execution budget plus a cleanup grace.
  const runtimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const createVmPromise = options.createVm({
    snapshotId: options.snapshotId,
    automaticRestart: false,
    // A stopped or max-run-paused VM is immediately deleted. The absolute TTL
    // remains a provider-owned backstop even if this process disappears.
    autoDeleteSeconds: 0,
    maxRunSeconds: runtimeSeconds + 60,
    ttlSeconds: runtimeSeconds + VM_TTL_GRACE_SECONDS,
    metadata: {
      app: "hexclave",
      purpose: "javascript-execution",
    },
    firewall: {
      rules: [{ action: "allow", source: {}, destination: { public: true } }],
    },
  });

  let vm: FreestyleExecutionVm;
  try {
    vm = await awaitWithAbortSignal(createVmPromise, executionSignal);
  } catch (error) {
    if (executionSignal.aborted) {
      // Cancellation can win before create returns a handle. Keep ownership of
      // that pending result and delete the VM as soon as it materializes.
      options.scheduleCleanup(deleteFreestyleVmWhenCreated(
        createVmPromise,
        options.onCleanupError,
        cleanupOptions,
      ));
    }
    throw error;
  }

  try {
    const jobId = crypto.randomUUID();
    const hostJobDirectory = `${RUNTIME_ROOT}/work/${jobId}`;
    const packageJson = JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(options.nodeModules),
    }, null, 2) + "\n";

    await awaitWithAbortSignal(vm.makeDirectory(hostJobDirectory), executionSignal);
    await Promise.all([
      vm.writeTextFile(`${hostJobDirectory}/code.mjs`, options.code, executionSignal),
      vm.writeTextFile(`${hostJobDirectory}/runner.mjs`, runnerSource, executionSignal),
      vm.writeTextFile(`${hostJobDirectory}/package.json`, packageJson, executionSignal),
    ]);

    const exitCode = await runPtyCommand(
      vm,
      `/usr/local/bin/hexclave-run-job ${hostJobDirectory}`,
      executionSignal,
    );
    if (exitCode !== 0) {
      throw new HexclaveAssertionError("Freestyle VM JavaScript runner exited with non-zero code", {
        vmId: vm.id,
        exitCode,
      });
    }

    const resultJson = await vm.readTextFile(
      `${hostJobDirectory}/result.json`,
      executionSignal,
    );
    let result: unknown;
    try {
      result = JSON.parse(resultJson);
    } catch (error) {
      throw new HexclaveAssertionError("Freestyle VM returned malformed JSON", {
        cause: error,
        vmId: vm.id,
        resultJsonLength: resultJson.length,
      });
    }
    if (!isExecuteResult(result)) {
      throw new HexclaveAssertionError("Freestyle VM returned a malformed execution result", {
        vmId: vm.id,
        resultType: typeof result,
        resultKeys: typeof result === "object" && result !== null ? Object.keys(result) : undefined,
      });
    }
    return result;
  } finally {
    const cleanupPromise = deleteFreestyleVmAfterExecution(
      vm,
      options.onCleanupError,
      cleanupOptions,
    );
    if (executionSignal.aborted) {
      options.scheduleCleanup(cleanupPromise);
    } else {
      await cleanupPromise;
    }
  }
}

export function isExecuteResult(value: unknown): value is ExecuteResult {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  if (value.status === "ok") return "data" in value;
  if (value.status !== "error" || !("error" in value)) return false;
  const error = value.error;
  return typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
    && (!("stack" in error) || error.stack === undefined || typeof error.stack === "string");
}

async function runPtyCommand(
  vm: FreestyleExecutionVm,
  command: string,
  signal: AbortSignal,
): Promise<number> {
  type PtyOutcome = { type: "exit", exitCode: number } | { type: "error", error: unknown };
  let exited = false;
  let resolveOutcome: (outcome: PtyOutcome) => void = () => {
    throw new HexclaveAssertionError("PTY outcome resolver was used before initialization");
  };
  const outcomePromise = new Promise<PtyOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const session = await awaitWithAbortSignal(vm.openPty({
    exec: command,
    onExit: (exitCode) => {
      exited = true;
      resolveOutcome({ type: "exit", exitCode });
    },
    onError: (error) => resolveOutcome({
      type: "error",
      error: new HexclaveAssertionError("Freestyle PTY reported an error", {
        cause: error,
        vmId: vm.id,
      }),
    }),
    onClose: (info) => {
      if (!exited) {
        resolveOutcome({
          type: "error",
          error: new HexclaveAssertionError("Freestyle PTY closed before the command exited", {
            vmId: vm.id,
            code: info.code,
            reason: info.reason,
            wasClean: info.wasClean,
          }),
        });
      }
    },
  }), signal);

  try {
    const outcome = await awaitWithAbortSignal(outcomePromise, signal);
    if (outcome.type === "error") throw outcome.error;
    return outcome.exitCode;
  } finally {
    session.detach();
  }
}

async function deleteFreestyleVmAfterExecution(
  vm: FreestyleExecutionVm,
  onCleanupError: (vmId: string, error: unknown) => void,
  cleanupOptions: CleanupOptions,
): Promise<void> {
  // ttlSeconds remains the provider-side backstop; this only bounds request latency.
  // The budget spans all attempts so retries never extend the caller's wait.
  const cleanupSignal = AbortSignal.timeout(cleanupOptions.timeoutMs);
  // The delete is usually the first request after the job ran for a while, so
  // undici's idle keep-alive connection is gone and a fresh TCP connect is
  // needed. That connect is what fails transiently (`fetch failed`), and a
  // retry moments later is far cheaper than leaking the VM until its TTL.
  const errors: unknown[] = [];
  for (let attempt = 0; attempt < CLEANUP_DELETE_ATTEMPTS; attempt++) {
    try {
      await awaitWithAbortSignal(vm.delete(), cleanupSignal);
      return;
    } catch (error) {
      errors.push(error);
    }
    if (cleanupSignal.aborted || attempt === CLEANUP_DELETE_ATTEMPTS - 1) break;
    const delayMs = (Math.random() + 0.5) * cleanupOptions.retryDelayBaseMs * (2 ** attempt);
    try {
      await awaitWithAbortSignal(wait(delayMs), cleanupSignal);
    } catch {
      // Budget exhausted while backing off; report what we have instead of trying again.
      break;
    }
  }
  onCleanupError(vm.id, new AggregateError(
    errors,
    `Freestyle VM deletion failed after ${errors.length} attempt(s)`,
    { cause: errors[errors.length - 1] },
  ));
}

async function deleteFreestyleVmWhenCreated(
  createVmPromise: Promise<FreestyleExecutionVm>,
  onCleanupError: (vmId: string, error: unknown) => void,
  cleanupOptions: CleanupOptions,
): Promise<void> {
  let vm: FreestyleExecutionVm;
  try {
    vm = await createVmPromise;
  } catch {
    // Creation failed, so there is no VM to own or delete.
    return;
  }
  await deleteFreestyleVmAfterExecution(vm, onCleanupError, cleanupOptions);
}

async function awaitWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
