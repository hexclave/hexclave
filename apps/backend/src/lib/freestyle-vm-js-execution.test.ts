import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { CreateVmOptions } from "freestyle";
import { describe, expect, test, vi } from "vitest";
import {
  executeJavascriptInFreestyleVm,
  isExecuteResult,
  type FreestyleExecutionVm,
} from "./freestyle-vm-js-execution";

function createFakeVm(options: {
  exitCode?: number | null,
  resultJson?: string,
  // One entry per delete attempt; the last entry repeats for any further attempts.
  deleteOutcomes?: (Error | "hangs" | "ok")[],
  onPtyOpen?: () => void,
} = {}) {
  const writes = new Map<string, string>();
  const directories: string[] = [];
  const commands: string[] = [];
  const detach = vi.fn();
  const deleteOutcomes = options.deleteOutcomes ?? ["ok"];
  const deleteVm = vi.fn(() => {
    const outcome = deleteOutcomes[Math.min(deleteVm.mock.calls.length - 1, deleteOutcomes.length - 1)];
    if (outcome === "hangs") return new Promise<void>(() => {});
    if (outcome !== "ok") throw outcome;
    return Promise.resolve();
  });
  const vm: FreestyleExecutionVm = {
    id: "vm-test",
    makeDirectory: async (path) => {
      directories.push(path);
    },
    writeTextFile: async (path, content) => {
      writes.set(path, content);
    },
    readTextFile: async () => options.resultJson ?? JSON.stringify({
      status: "ok",
      data: { rendered: true },
    }),
    openPty: async (ptyOptions) => {
      commands.push(ptyOptions.exec);
      options.onPtyOpen?.();
      if (options.exitCode !== null) {
        queueMicrotask(() => ptyOptions.onExit(options.exitCode ?? 0));
      }
      return { detach };
    },
    delete: deleteVm,
  };
  return { vm, writes, directories, commands, detach, deleteVm };
}

describe("executeJavascriptInFreestyleVm", () => {
  test("boots the configured snapshot, runs through PTY, and deletes the VM", async () => {
    const fake = createFakeVm();
    let createOptions: CreateVmOptions | undefined;
    const result = await executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default async () => ({ status: 'ok', data: 42 });",
      nodeModules: new Map([["react", "19.1.1"]]),
      executionTimeoutMs: 630_000,
      scheduleCleanup: vi.fn(),
      onCleanupError: vi.fn(),
      createVm: async (options) => {
        createOptions = options;
        return fake.vm;
      },
    });

    expect(result).toEqual({ status: "ok", data: { rendered: true } });
    expect(createOptions).toMatchObject({
      snapshotId: "sandbox-snapshot",
      automaticRestart: false,
      autoDeleteSeconds: 0,
      maxRunSeconds: 690,
      ttlSeconds: 930,
      metadata: { app: "hexclave", purpose: "javascript-execution" },
      firewall: {
        rules: [{ action: "allow", source: {}, destination: { public: true } }],
      },
    });
    expect(fake.directories).toHaveLength(1);
    const jobDirectory = fake.directories[0];
    expect(fake.writes.get(`${jobDirectory}/code.mjs`)).toContain("data: 42");
    expect(JSON.parse(fake.writes.get(`${jobDirectory}/package.json`) ?? "")).toEqual({
      private: true,
      type: "module",
      dependencies: { react: "19.1.1" },
    });
    expect(fake.commands).toEqual([
      `/usr/local/bin/hexclave-run-job ${jobDirectory}`,
    ]);
    expect(fake.detach).toHaveBeenCalledOnce();
    expect(fake.deleteVm).toHaveBeenCalledOnce();
  });

  test("rejects a failed runner and still deletes its VM", async () => {
    const fake = createFakeVm({ exitCode: 7 });
    const execution = executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default () => 42;",
      nodeModules: new Map(),
      scheduleCleanup: vi.fn(),
      onCleanupError: vi.fn(),
      createVm: async () => fake.vm,
    });

    await expect(execution).rejects.toThrow("runner exited with non-zero code");
    const thrownError = await execution.then(
      () => undefined,
      error => error,
    );
    expect(thrownError).toBeInstanceOf(HexclaveAssertionError);
    if (thrownError instanceof HexclaveAssertionError) {
      expect(thrownError.extraData).toMatchObject({ vmId: "vm-test", exitCode: 7 });
    }

    expect(fake.detach).toHaveBeenCalledOnce();
    expect(fake.deleteVm).toHaveBeenCalledOnce();
  });

  test("retries a transiently failing delete and reports nothing once it succeeds", async () => {
    const fake = createFakeVm({ deleteOutcomes: [new TypeError("fetch failed"), "ok"] });
    const onCleanupError = vi.fn();

    await expect(executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default () => ({ status: 'ok', data: 42 });",
      nodeModules: new Map(),
      cleanupRetryDelayBaseMs: 1,
      scheduleCleanup: vi.fn(),
      onCleanupError,
      createVm: async () => fake.vm,
    })).resolves.toEqual({ status: "ok", data: { rendered: true } });

    expect(fake.deleteVm).toHaveBeenCalledTimes(2);
    expect(onCleanupError).not.toHaveBeenCalled();
  });

  test("reports cleanup failures with every attempt's error without replacing a successful result", async () => {
    const cleanupErrors = [new Error("delete failed 1"), new Error("delete failed 2"), new Error("delete failed 3")];
    const fake = createFakeVm({ deleteOutcomes: cleanupErrors });
    const onCleanupError = vi.fn();

    await expect(executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default () => ({ status: 'ok', data: 42 });",
      nodeModules: new Map(),
      cleanupRetryDelayBaseMs: 1,
      scheduleCleanup: vi.fn(),
      onCleanupError,
      createVm: async () => fake.vm,
    })).resolves.toEqual({ status: "ok", data: { rendered: true } });

    expect(fake.deleteVm).toHaveBeenCalledTimes(3);
    expect(onCleanupError).toHaveBeenCalledOnce();
    const [vmId, reported] = onCleanupError.mock.calls[0];
    expect(vmId).toBe("vm-test");
    expect(reported).toBeInstanceOf(AggregateError);
    expect(reported.errors).toEqual(cleanupErrors);
    expect(reported.cause).toBe(cleanupErrors[2]);
  });

  test("schedules deletion without delaying an aborted invocation", async () => {
    const controller = new AbortController();
    const abortReason = new Error("request ended");
    const fake = createFakeVm({
      exitCode: null,
      onPtyOpen: () => queueMicrotask(() => queueMicrotask(() => controller.abort(abortReason))),
    });
    let scheduledCleanup: Promise<void> | undefined;
    const scheduleCleanup = vi.fn((cleanup: Promise<void>) => {
      scheduledCleanup = cleanup;
    });

    await expect(executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default () => 42;",
      nodeModules: new Map(),
      signal: controller.signal,
      scheduleCleanup,
      onCleanupError: vi.fn(),
      createVm: async () => fake.vm,
    })).rejects.toBe(abortReason);

    expect(scheduleCleanup).toHaveBeenCalledOnce();
    await scheduledCleanup;
    expect(fake.deleteVm).toHaveBeenCalledOnce();
    expect(fake.detach).toHaveBeenCalledOnce();
  });

  test("deletes a VM that finishes creating after the invocation aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("request ended during VM creation");
    const fake = createFakeVm();
    let resolveCreate: (vm: FreestyleExecutionVm) => void = () => {
      throw new Error("create resolver used before initialization");
    };
    const createPromise = new Promise<FreestyleExecutionVm>((resolve) => {
      resolveCreate = resolve;
    });
    let scheduledCleanup: Promise<void> | undefined;
    const scheduleCleanup = vi.fn((cleanup: Promise<void>) => {
      scheduledCleanup = cleanup;
    });

    const execution = executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default () => 42;",
      nodeModules: new Map(),
      signal: controller.signal,
      scheduleCleanup,
      onCleanupError: vi.fn(),
      createVm: async () => await createPromise,
    });
    controller.abort(abortReason);

    await expect(execution).rejects.toBe(abortReason);
    expect(scheduleCleanup).toHaveBeenCalledOnce();
    expect(fake.deleteVm).not.toHaveBeenCalled();

    resolveCreate(fake.vm);
    await scheduledCleanup;
    expect(fake.deleteVm).toHaveBeenCalledOnce();
    expect(fake.commands).toEqual([]);
  });

  test("reports cleanup timeout without delaying a successful result", async () => {
    const fake = createFakeVm({ deleteOutcomes: ["hangs"] });
    const onCleanupError = vi.fn();

    await expect(executeJavascriptInFreestyleVm({
      snapshotId: "sandbox-snapshot",
      code: "export default () => ({ status: 'ok', data: 42 });",
      nodeModules: new Map(),
      cleanupTimeoutMs: 10,
      scheduleCleanup: vi.fn(),
      onCleanupError,
      createVm: async () => fake.vm,
    })).resolves.toEqual({ status: "ok", data: { rendered: true } });

    // The timeout budget spans all attempts, so a hanging delete is not retried.
    expect(fake.deleteVm).toHaveBeenCalledOnce();
    expect(onCleanupError).toHaveBeenCalledOnce();
    expect(onCleanupError).toHaveBeenCalledWith(
      "vm-test",
      expect.objectContaining({
        errors: [expect.objectContaining({ name: "TimeoutError" })],
        cause: expect.objectContaining({ name: "TimeoutError" }),
      }),
    );
  });
});

describe("isExecuteResult", () => {
  test("rejects malformed results and accepts valid results", () => {
    expect(isExecuteResult({ status: "ok" })).toBe(false);
    expect(isExecuteResult({ status: "weird" })).toBe(false);
    expect(isExecuteResult({ status: "error", error: { message: 1 } })).toBe(false);
    expect(isExecuteResult({ status: "error", error: { message: "x", stack: 2 } })).toBe(false);
    expect(isExecuteResult({ status: "ok", data: null })).toBe(true);
    expect(isExecuteResult({ status: "error", error: { message: "x" } })).toBe(true);
  });
});
