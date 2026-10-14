import { beforeEach, describe, expect, test, vi } from "vitest";
import { WORKFLOWS_PROTOCOL_VERSION, type WorkflowSandboxInput } from "./protocol";

const { executeJavascriptMock } = vi.hoisted(() => ({
  executeJavascriptMock: vi.fn(),
}));

vi.mock("@/lib/js-execution", () => ({
  executeJavascript: executeJavascriptMock,
}));

import { invokeWorkflowRunKeyBatch, invokeWorkflowSandbox } from "./invoke";

const input: WorkflowSandboxInput = {
  protocolVersion: WORKFLOWS_PROTOCOL_VERSION,
  mode: "manifest",
  limits: {
    stepResultMaxBytes: 1,
    defaultStepTimeoutMs: 1,
    maxStepTimeoutMs: 1,
    logsMaxBytes: 1,
    inlineSleepMaxMs: 1,
    inlineSleepBudgetMs: 1,
  },
};

describe("invokeWorkflowSandbox", () => {
  beforeEach(() => {
    executeJavascriptMock.mockReset();
    executeJavascriptMock.mockResolvedValue({
      status: "ok",
      data: {
        type: "manifest",
        manifest: {
          workflowId: "timeout-test",
          triggers: [],
          hasRunKey: false,
          onConflict: "skip",
        },
      },
    });
  });

  test("gives providers the same ceiling as the engine backstop", async () => {
    const result = await invokeWorkflowSandbox({
      compiledBundle: "export default async () => ({ status: 'ok' });",
      input,
      nodeModules: {},
      timeoutMs: 630_000,
    });

    expect(result.status).toBe("ok");
    expect(executeJavascriptMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ executionTimeoutMs: 630_000 }),
    );
  });
});

describe("invokeWorkflowRunKeyBatch", () => {
  const batchableBundle = "var entry_default = async () => ({ status: 'ok', data: null });\nexport {\n  entry_default as default\n};\n";
  const runKeyInput = (id: string): WorkflowSandboxInput => ({
    ...input,
    mode: "run-key",
    event: { id, type: "user.created", tsMillis: 0, data: { id } },
  });

  beforeEach(() => {
    executeJavascriptMock.mockReset();
  });

  test("maps each harness envelope to its own result", async () => {
    executeJavascriptMock.mockResolvedValue({
      status: "ok",
      data: [
        { status: "ok", data: { type: "run-key", runKey: "a" } },
        { status: "error", error: { message: "harness broke" } },
      ],
    });

    const result = await invokeWorkflowRunKeyBatch({
      compiledBundle: batchableBundle,
      inputs: [runKeyInput("a"), runKeyInput("b")],
      nodeModules: {},
      timeoutMs: 60_000,
    });

    expect(executeJavascriptMock).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") return;
    expect(result.data[0]).toEqual({ status: "ok", data: { type: "run-key", runKey: "a" } });
    expect(result.data[1]).toMatchObject({ status: "error", error: { kind: "runtime-error" } });
  });

  test("fails the whole batch when the invocation fails", async () => {
    executeJavascriptMock.mockRejectedValue(new Error("provider down"));

    const result = await invokeWorkflowRunKeyBatch({
      compiledBundle: batchableBundle,
      inputs: [runKeyInput("a"), runKeyInput("b")],
      nodeModules: {},
      timeoutMs: 60_000,
    });

    expect(result).toMatchObject({ status: "error", error: { kind: "invocation-error" } });
  });

  test("rejects a result that does not line up with the inputs", async () => {
    executeJavascriptMock.mockResolvedValue({ status: "ok", data: [{ status: "ok", data: { type: "run-key", runKey: "a" } }] });

    await expect(invokeWorkflowRunKeyBatch({
      compiledBundle: batchableBundle,
      inputs: [runKeyInput("a"), runKeyInput("b")],
      nodeModules: {},
      timeoutMs: 60_000,
    })).rejects.toThrow("malformed result");
  });

  test("declines a batch in which the workflow module failed to import", async () => {
    // After a throwing module init, later calls in the same sandbox see an
    // empty module, so the other items would be misleading failures.
    executeJavascriptMock.mockResolvedValue({
      status: "ok",
      data: [
        { status: "ok", data: { type: "handler-failed", phase: "import", nonRetriable: false, error: { name: "Error", message: "flaky init" }, completedSleeps: [], logs: null } },
        { status: "ok", data: { type: "handler-failed", phase: "import", nonRetriable: true, error: { name: "WorkflowContractViolationError", message: "must default-export" }, completedSleeps: [], logs: null } },
      ],
    });

    const result = await invokeWorkflowRunKeyBatch({
      compiledBundle: batchableBundle,
      inputs: [runKeyInput("a"), runKeyInput("b")],
      nodeModules: {},
      timeoutMs: 60_000,
    });

    expect(result).toBeNull();
  });

  test("returns null without invoking anything for an unbatchable bundle", async () => {
    const result = await invokeWorkflowRunKeyBatch({
      compiledBundle: "export default async () => ({ status: 'ok', data: null });",
      inputs: [runKeyInput("a")],
      nodeModules: {},
      timeoutMs: 60_000,
    });

    expect(result).toBeNull();
    expect(executeJavascriptMock).not.toHaveBeenCalled();
  });

  test("refuses to batch anything but run-key invocations", async () => {
    await expect(invokeWorkflowRunKeyBatch({
      compiledBundle: batchableBundle,
      inputs: [input],
      nodeModules: {},
      timeoutMs: 60_000,
    })).rejects.toThrow("Only run-key invocations can be batched");
  });
});
