import { executeJavascript } from "@/lib/js-execution";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { WorkflowSandboxInput, WorkflowSandboxOutcome } from "./protocol";

function isWorkflowSandboxOutcome(value: unknown): value is WorkflowSandboxOutcome {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  switch (value.type) {
    case "manifest": { return true; }
    case "run-key": { return true; }
    case "probe": { return true; }
    case "step-completed": { return true; }
    case "sleeping": { return true; }
    case "completed": { return true; }
    case "step-failed": { return true; }
    case "handler-failed": { return true; }
    default: { return false; }
  }
}

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
  const invocationId = generateUuid();
  const prelude = "globalThis.__HEXCLAVE_WORKFLOWS_INPUT__ = " + JSON.stringify(options.input) + ";\n";
  const code = prelude + options.compiledBundle;

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
      logSafeCode: `<workflow bundle, ${options.compiledBundle.length} bundle bytes + redacted input prelude, mode ${options.input.mode}, invocation ${invocationId}>`,
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
      { mode: options.input.mode, invocationId, error },
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
      { mode: options.input.mode, invocationId, error: executeResult.error },
    ));
    return Result.error({ kind: "runtime-error", invocationId, message: "The workflow runtime encountered an internal error. This is usually transient — retrying is safe." });
  }

  const outcome = executeResult.data;
  if (!isWorkflowSandboxOutcome(outcome)) {
    throw new HexclaveAssertionError("Workflow sandbox returned a malformed outcome", { outcome, mode: options.input.mode });
  }
  return Result.ok(outcome);
}
