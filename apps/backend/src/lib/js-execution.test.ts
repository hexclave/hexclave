import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  freestyleExecute: vi.fn(),
  sandboxCreate: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("./freestyle-vm-js-execution", async (importOriginal) => {
  const original = await importOriginal<typeof import("./freestyle-vm-js-execution")>();
  return { ...original, executeJavascriptInFreestyleVm: mocks.freestyleExecute };
});

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: mocks.sandboxCreate },
}));

vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hexclave/shared/dist/utils/errors")>();
  return { ...original, captureError: mocks.captureError };
});

class FakeFreestyleApiError extends Error {
  readonly status = 429;
  readonly code = "LIMIT_EXCEEDED";
  constructor() {
    super("Account resource limit exceeded");
    this.name = "FreestyleApiError";
  }
}

function fakeSandbox(options: { installExitCode?: number, installStderr?: string } = {}) {
  return {
    runCommand: vi.fn(async (cmd: string) => {
      if (cmd === "npm") {
        return { exitCode: options.installExitCode ?? 0, stderr: async () => options.installStderr ?? "" };
      }
      return { exitCode: 0, stderr: async () => "" };
    }),
    writeFiles: vi.fn(async () => {}),
    readFileToBuffer: vi.fn(async () => Buffer.from(JSON.stringify({ status: "ok", data: "from-vercel" }))),
    stop: vi.fn(async () => {}),
  };
}

async function loadModule() {
  vi.resetModules();
  return await import("./js-execution");
}

describe("executeJavascript fallback on Freestyle account limit", () => {
  beforeEach(() => {
    for (const prefix of ["STACK", "HEXCLAVE"]) {
      vi.stubEnv(`${prefix}_FREESTYLE_API_KEY`, "test-freestyle-key");
      vi.stubEnv(`${prefix}_VERCEL_SANDBOX_TOKEN`, "test-vercel-token");
      vi.stubEnv(`${prefix}_VERCEL_SANDBOX_TEAM_ID`, "team_test");
      vi.stubEnv(`${prefix}_VERCEL_SANDBOX_PROJECT_ID`, "prj_test");
    }
    mocks.freestyleExecute.mockReset();
    mocks.sandboxCreate.mockReset();
    mocks.captureError.mockReset();
  });

  test("does not retry the limit, reports it once, and skips Freestyle during the cooldown", async () => {
    const { executeJavascript } = await loadModule();
    mocks.freestyleExecute.mockRejectedValue(new FakeFreestyleApiError());
    mocks.sandboxCreate.mockImplementation(async () => fakeSandbox());

    const first = await executeJavascript("export default () => 1", { disableSanityTest: true });
    expect(first).toEqual({ status: "ok", data: "from-vercel" });
    // One attempt only: the limit is not retried.
    expect(mocks.freestyleExecute).toHaveBeenCalledTimes(1);

    const second = await executeJavascript("export default () => 1", { disableSanityTest: true });
    expect(second).toEqual({ status: "ok", data: "from-vercel" });
    // Cooldown: straight to Vercel without touching Freestyle.
    expect(mocks.freestyleExecute).toHaveBeenCalledTimes(1);
    expect(mocks.sandboxCreate).toHaveBeenCalledTimes(2);

    const locations = mocks.captureError.mock.calls.map((call) => call[0]);
    expect(locations).toEqual(["js-execution-freestyle-account-limit"]);
  });

  test("other Freestyle failures still retry once and report as before", async () => {
    const { executeJavascript } = await loadModule();
    mocks.freestyleExecute.mockRejectedValue(new Error("Freestyle VM JavaScript runner exited with non-zero code"));
    mocks.sandboxCreate.mockImplementation(async () => fakeSandbox());

    const result = await executeJavascript("export default () => 1", { disableSanityTest: true });
    expect(result).toEqual({ status: "ok", data: "from-vercel" });
    expect(mocks.freestyleExecute).toHaveBeenCalledTimes(2);
    expect(mocks.captureError.mock.calls.map((call) => call[0])).toEqual(["js-execution-freestyle-failed"]);

    await executeJavascript("export default () => 1", { disableSanityTest: true });
    expect(mocks.freestyleExecute).toHaveBeenCalledTimes(4);
  });

  test("a failed npm install in Vercel Sandbox carries npm's stderr tail", async () => {
    const { executeJavascript } = await loadModule();
    mocks.freestyleExecute.mockRejectedValue(new Error("runner exited"));
    mocks.sandboxCreate.mockImplementation(async () => fakeSandbox({ installExitCode: 1, installStderr: "npm error code E429\nnpm error 429 Too Many Requests" }));

    await expect(executeJavascript("export default () => 1", { disableSanityTest: true, nodeModules: { "@hexclave/js": "1.0.52" } }))
      .rejects.toThrow("Vercel Sandbox service unavailable");

    const vercelFailure = mocks.captureError.mock.calls.find((call) => call[0] === "js-execution-vercel-sandbox-failed");
    expect(vercelFailure).toBeDefined();
    const installError = (vercelFailure![1] as any).extraData.cause;
    expect(installError.message).toContain("Failed to install packages in Vercel Sandbox");
    expect(installError.extraData.npmStderrTail).toContain("E429");
  });
});
