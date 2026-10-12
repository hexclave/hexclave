import { executeJavascript } from "@/lib/js-execution";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { WorkflowSandboxInput, WorkflowSandboxOutcome } from "./protocol";

// One sandbox invocation of a compiled workflow bundle. The per-invocation
// input rides in a prelude prepended to the stored bundle (rather than env
// vars or engine-specific channels) so the invocation shape is identical
// across Freestyle, Vercel Sandbox, and the local mock. ESM import hoisting
// makes the prelude-then-bundle concatenation safe: the bundle's only real
// imports are the pinned stdlib, which doesn't read our global.

export type WorkflowInvocationFailure = {
  // "invocation-error": the sandbox/js-execution layer failed (engine
  // unreachable, runner crashed, unparseable result).
  // "runtime-error": the invocation succeeded but our runtime harness threw
  // (a platform bug — user-code errors come back as normal outcomes).
  // "timeout": the engine-side backstop timer fired; the sandbox may still
  // be running, so the run will later be re-claimed and re-executed from the
  // last committed step (at-least-once step execution).
  kind: "invocation-error" | "runtime-error" | "timeout",
  // User-safe BY CONSTRUCTION: consumers persist this message into run
  // diagnostics (upgrade divergence details) and return it from public APIs
  // (sync 400s), so it must never contain raw provider/runtime error text —
  // upstream sandbox providers can put infrastructure details in their
  // messages. Full details go to telemetry instead: the invocation-error and
  // runtime-error branches below captureError the raw failure before
  // returning the generic message.
  message: string,
  // Correlates telemetry across layers for one sandbox invocation. Because
  // the generic message deliberately carries no detail, the only way to
  // trace a failure back to its root cause is by id: the invoke-level
  // captures here, js-execution's internal captures (the id is embedded in
  // logSafeCode), and the engine's run-context captures (which read it from
  // this failure) all carry the same id.
  invocationId: string,
};

export async function invokeWorkflowSandbox(options: {
  compiledBundle: string,
  input: WorkflowSandboxInput,
  /** Exact-pinned stdlib packages to install in the sandbox (from the version's recorded runtime env, filtered to what the source imports). */
  nodeModules: Record<string, string>,
  /** Engine-side backstop; the authoritative per-step timeout is enforced by the runtime inside the sandbox. */
  timeoutMs: number,
}): Promise<Result<WorkflowSandboxOutcome, WorkflowInvocationFailure>> {
  const prelude = "globalThis.__HEXCLAVE_WORKFLOWS_INPUT__ = " + JSON.stringify(options.input) + ";\n";
  const executed = await executeWorkflowCode(prelude + options.compiledBundle, {
    bundleBytes: options.compiledBundle.length,
    mode: options.input.mode,
    nodeModules: options.nodeModules,
    timeoutMs: options.timeoutMs,
  });
  if (executed.status === "error") return executed;
  return Result.ok(parseWorkflowOutcome(executed.data, options.input.mode));
}

// The bundle's entry harness is its default export, which esbuild always
// emits as a trailing `export { <entry> as default };` block. Already-synced
// bundles are byte-pinned, so the batch wrapper keys off that block instead
// of the runtime source; a bundle that does not end in it is simply not
// batchable.
const BUNDLE_DEFAULT_EXPORT_REGEX = /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*,?\s*\}\s*;?\s*$/;

/**
 * Rewrites a compiled bundle so that one sandbox invocation runs its entry
 * harness once per input, in order, and returns every harness result.
 * Returns null when the bundle does not have the shape this relies on.
 *
 * The entry reads its input from the global on every call and
 * runWorkflowInvocation resets its per-invocation state (logs, console
 * patching, step state) each time, so sequential calls are independent
 * except that the workflow module is evaluated once per batch, not once per
 * input. That matters to a runKey that keeps module-level state, which the
 * "runKey is a pure function of the event" contract rules out, and to a
 * module whose top-level code throws: see invokeWorkflowRunKeyBatch. The
 * batch's inputs are detached from the global before any workflow code runs,
 * so a runKey still only sees its own event. Nothing is declared at module
 * scope, so no name in the bundle can collide with the wrapper.
 */
export function buildRunKeyBatchCode(compiledBundle: string, inputs: WorkflowSandboxInput[]): string | null {
  if (inputs.length === 0) return null;
  const match = BUNDLE_DEFAULT_EXPORT_REGEX.exec(compiledBundle);
  if (match == null) return null;
  const entryName = match[1];
  return "globalThis.__HEXCLAVE_WORKFLOWS_INPUT__ = " + JSON.stringify(inputs[0]) + ";\n"
    + "globalThis.__HEXCLAVE_WORKFLOWS_RUN_KEY_BATCH__ = " + JSON.stringify(inputs) + ";\n"
    + compiledBundle.slice(0, match.index)
    + "export default async () => {\n"
    + "  const inputs = globalThis.__HEXCLAVE_WORKFLOWS_RUN_KEY_BATCH__;\n"
    + "  delete globalThis.__HEXCLAVE_WORKFLOWS_RUN_KEY_BATCH__;\n"
    + "  const results = [];\n"
    + "  for (const input of inputs) {\n"
    + "    globalThis.__HEXCLAVE_WORKFLOWS_INPUT__ = input;\n"
    + "    results.push(await " + entryName + "());\n"
    + "  }\n"
    + "  return { status: \"ok\", data: results };\n"
    + "};\n";
}

/**
 * Derives the run keys of several events of one workflow version in a single
 * sandbox invocation. Returns null when the bundle cannot be batched, or the
 * workflow module failed to import; the caller then invokes per event. Each item is the result a run-key
 * invokeWorkflowSandbox call for that event would have produced, except that
 * a failure of the whole invocation fails the whole batch.
 */
export async function invokeWorkflowRunKeyBatch(options: {
  compiledBundle: string,
  inputs: WorkflowSandboxInput[],
  nodeModules: Record<string, string>,
  timeoutMs: number,
}): Promise<Result<Result<WorkflowSandboxOutcome, WorkflowInvocationFailure>[], WorkflowInvocationFailure> | null> {
  if (options.inputs.some((input) => input.mode !== "run-key")) {
    throw new HexclaveAssertionError("Only run-key invocations can be batched: every other mode is side-effectful or needs credentials", { modes: options.inputs.map((input) => input.mode) });
  }
  const code = buildRunKeyBatchCode(options.compiledBundle, options.inputs);
  if (code == null) return null;
  const executed = await executeWorkflowCode(code, {
    bundleBytes: options.compiledBundle.length,
    mode: `run-key batch of ${options.inputs.length}`,
    nodeModules: options.nodeModules,
    timeoutMs: options.timeoutMs,
  });
  if (executed.status === "error") return executed;
  const items = executed.data;
  if (!Array.isArray(items) || items.length !== options.inputs.length) {
    throw new HexclaveAssertionError("Workflow run-key batch returned a malformed result", { expectedLength: options.inputs.length, actualLength: Array.isArray(items) ? items.length : null });
  }
  // The workflow module is imported once per batch, and esbuild's lazy
  // module init does not re-run after its top-level code throws: every later
  // call gets an empty module and fails with a misleading contract
  // violation. Separate invocations would each re-run the import, so a batch
  // with any import failure is not representative of them — decline it.
  if (items.some((item) => item?.status === "ok" && item.data?.type === "handler-failed" && item.data.phase === "import")) {
    return null;
  }
  return Result.ok(items.map((item) => {
    // Each item is one entry-harness envelope, exactly what a single
    // invocation's js-execution result would have been.
    if (item?.status === "ok") return Result.ok(parseWorkflowOutcome(item.data, "run-key"));
    const invocationId = generateUuid();
    captureError("workflow-sandbox-runtime-error", new HexclaveAssertionError(
      `Workflow sandbox runtime harness failed: ${item?.error?.message ?? "malformed batch item"}`,
      { mode: "run-key (batched)", invocationId, error: item?.error },
    ));
    return Result.error({ kind: "runtime-error" as const, invocationId, message: "The workflow runtime encountered an internal error. This is usually transient — retrying is safe." });
  }));
}

function parseWorkflowOutcome(data: unknown, mode: string): WorkflowSandboxOutcome {
  const outcome = data as WorkflowSandboxOutcome | null;
  if (outcome == null || typeof outcome !== "object" || typeof (outcome as any).type !== "string") {
    throw new HexclaveAssertionError("Workflow sandbox returned a malformed outcome", { outcome, mode });
  }
  return outcome;
}

/** Runs workflow code in the sandbox and unwraps the entry harness's envelope. */
async function executeWorkflowCode(code: string, options: {
  bundleBytes: number,
  mode: string,
  nodeModules: Record<string, string>,
  timeoutMs: number,
}): Promise<Result<any, WorkflowInvocationFailure>> {
  const invocationId = generateUuid();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Workflow sandbox exceeded its ${options.timeoutMs}ms engine backstop.`));
  }, options.timeoutMs);

  let executeResult;
  try {
    executeResult = await executeJavascript(code, {
      nodeModules: options.nodeModules,
      // Give providers the same hard ceiling as the engine backstop so an
      // uncancellable remote run cannot continue after the engine gives up.
      executionTimeoutMs: options.timeoutMs,
      // Step execution is side-effectful; running it twice for a
      // cross-engine comparison would double-fire the effects.
      disableSanityTest: true,
      // The prelude embeds per-run credentials — never let
      // the raw code reach error reports. The invocation id makes
      // js-execution's internal captures correlatable with ours without
      // widening its API.
      logSafeCode: `<workflow bundle, ${options.bundleBytes} bundle bytes + redacted input prelude, mode ${options.mode}, invocation ${invocationId}>`,
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      return Result.error({ kind: "timeout", invocationId, message: `Workflow sandbox invocation exceeded the ${Math.round(options.timeoutMs / 1000)}s engine-side backstop timeout` });
    }
    // From the engine's perspective this is a retriable platform failure of
    // the attempt. Captured HERE, not just inside js-execution: several of
    // its throw paths (a missing provider env var, the disabled sentinel,
    // the no-fallback dev path) throw before any of its own captureError
    // calls run, so relying on the callee would silently drop the root
    // cause for exactly the misconfigurations that make every invocation
    // fail. A double capture on the paths js-execution does report is a
    // tolerable cost. The raw error text stays out of the Result on
    // purpose — see the user-safety note on WorkflowInvocationFailure.
    captureError("workflow-sandbox-invocation-error", new HexclaveAssertionError(
      `Workflow sandbox invocation failed: ${error instanceof Error ? error.message : String(error)}`,
      { mode: options.mode, invocationId, error },
    ));
    return Result.error({ kind: "invocation-error", invocationId, message: "The workflow sandbox could not be started because of an internal error. This is usually transient — retrying is safe." });
  } finally {
    clearTimeout(timer);
  }

  if (executeResult.status === "error") {
    // The entry harness catches all user-code errors into normal outcomes,
    // so an error envelope here means the harness/runtime itself broke — a
    // platform bug. Nothing below js-execution has reported this envelope
    // yet (the invocation itself succeeded), so capture the raw detail here,
    // and keep the Result's message generic (see WorkflowInvocationFailure).
    captureError("workflow-sandbox-runtime-error", new HexclaveAssertionError(
      `Workflow sandbox runtime harness failed: ${executeResult.error.message}`,
      { mode: options.mode, invocationId, error: executeResult.error },
    ));
    return Result.error({ kind: "runtime-error", invocationId, message: "The workflow runtime encountered an internal error. This is usually transient — retrying is safe." });
  }
  return Result.ok(executeResult.data);
}
