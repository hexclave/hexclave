import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordLocalDashboardProcess } from "../lib/dev-env-state.js";
import { composeDevChildEnv, configErrorLogPrefix, dashboardEnvWithStatePath, devDashboardCommandFromEnv, isHeartbeatResponse, isVersionNewer, killLocalDashboard, logConfigSyncEvents, processExists, runChildProcess, shellChildCommand, shouldRestartDashboard, validateDevCommandSelection } from "./dev.js";

describe("validateDevCommandSelection", () => {
  it("rejects combining --service-id with a positional command", () => {
    expect(() => validateDevCommandSelection("web", ["pnpm", "dev"]))
      .toThrow("Cannot combine --service-id <id> with a positional command after --");
  });

  it("preserves service-only and command-only modes", () => {
    expect(() => validateDevCommandSelection("web", [])).not.toThrow();
    expect(() => validateDevCommandSelection(undefined, ["pnpm", "dev"])).not.toThrow();
  });
});

describe("shellChildCommand", () => {
  it("wraps the command line in /bin/sh on POSIX platforms", () => {
    expect(shellChildCommand("pnpm dev --port 3000", "darwin")).toEqual({
      command: "/bin/sh",
      args: ["-c", "pnpm dev --port 3000"],
    });
  });

  it("defers to spawn's shell mode on Windows (quoting-safe)", () => {
    // Hand-rolling the cmd.exe argv would make Node MSVCRT-escape embedded
    // double quotes (`"` -> `\"`), which cmd does not parse — spawn's own
    // shell mode is the only quoting-safe way to run a command line.
    expect(shellChildCommand('node -e "console.log(1)"', "win32")).toEqual({
      command: 'node -e "console.log(1)"',
      args: [],
      shell: true,
    });
  });
});

describe("composeDevChildEnv", () => {
  it("lets the session credentials win over service env vars, which win over the process env", () => {
    // The ordering IS the contract: a stale hexclave.* value baked into the
    // config file must not shadow the dev session's live credentials.
    expect(composeDevChildEnv(
      { FROM_PROCESS: "process", SHADOWED_BY_SERVICE: "process", HEXCLAVE_PROJECT_ID: "process" },
      { SHADOWED_BY_SERVICE: "service", HEXCLAVE_PROJECT_ID: "stale-config-value", FROM_SERVICE: "service" },
      { HEXCLAVE_PROJECT_ID: "session" },
    )).toEqual({
      FROM_PROCESS: "process",
      SHADOWED_BY_SERVICE: "service",
      FROM_SERVICE: "service",
      HEXCLAVE_PROJECT_ID: "session",
    });
  });
});

describe("isVersionNewer", () => {
  it("compares core versions numerically", () => {
    expect(isVersionNewer("2.8.110", "2.8.109")).toBe(true);
    expect(isVersionNewer("2.9.0", "2.8.999")).toBe(true);
    expect(isVersionNewer("3.0.0", "2.999.999")).toBe(true);
    expect(isVersionNewer("2.8.109", "2.8.109")).toBe(false);
    expect(isVersionNewer("2.8.108", "2.8.109")).toBe(false);
  });

  it("does not treat double-digit segments as strings", () => {
    expect(isVersionNewer("2.8.10", "2.8.9")).toBe(true);
  });

  it("ranks a final release above a prerelease of the same core", () => {
    expect(isVersionNewer("2.8.109", "2.8.109-beta.1")).toBe(true);
    expect(isVersionNewer("2.8.109-beta.1", "2.8.109")).toBe(false);
  });

  it("returns false for unparseable versions (never downgrade or guess)", () => {
    expect(isVersionNewer("garbage", "2.8.109")).toBe(false);
    expect(isVersionNewer("2.8.110", "garbage")).toBe(false);
  });

  it("tolerates a leading v and surrounding whitespace on either side", () => {
    expect(isVersionNewer("v2.8.110", "2.8.109")).toBe(true);
    expect(isVersionNewer("2.8.110", "v2.8.109")).toBe(true);
    expect(isVersionNewer("  2.8.110  ", "2.8.109")).toBe(true);
    expect(isVersionNewer("v2.8.110", "v2.8.110")).toBe(false);
  });

  it("treats a two-segment version (x.y) as unparseable", () => {
    expect(isVersionNewer("2.8", "2.8.109")).toBe(false);
    expect(isVersionNewer("2.8.109", "2.8")).toBe(false);
  });

  it("ignores prerelease identifiers when both cores are equal prereleases", () => {
    // Only "release beats prerelease" is modeled; beta.2 is NOT newer than beta.1.
    expect(isVersionNewer("2.8.109-beta.2", "2.8.109-beta.1")).toBe(false);
    expect(isVersionNewer("2.8.109-beta.1", "2.8.109-beta.2")).toBe(false);
  });

  it("compares very large numeric segments correctly", () => {
    expect(isVersionNewer("2.8.1000000000", "2.8.999999999")).toBe(true);
    expect(isVersionNewer("10000000000.0.0", "9999999999.0.0")).toBe(true);
  });
});

describe("shouldRestartDashboard", () => {
  it("restarts only when ours is strictly newer than the running dashboard", () => {
    expect(shouldRestartDashboard("2.8.110", "2.8.109")).toBe(true);
    expect(shouldRestartDashboard("2.8.109", "2.8.109")).toBe(false);
    expect(shouldRestartDashboard("2.8.108", "2.8.109")).toBe(false);
  });

  it("reuses (does not restart) when either version is unknown", () => {
    // A dashboard recorded by a pre-feature CLI has no version field.
    expect(shouldRestartDashboard("2.8.110", undefined)).toBe(false);
    expect(shouldRestartDashboard(undefined, "2.8.109")).toBe(false);
    expect(shouldRestartDashboard(undefined, undefined)).toBe(false);
  });
});

describe("processExists", () => {
  it("returns true for the current process and false for an impossible pid", () => {
    expect(processExists(process.pid)).toBe(true);
    // pid 1 always exists; a huge pid effectively never does.
    expect(processExists(2_147_483_646)).toBe(false);
  });
});

describe("devDashboardCommandFromEnv", () => {
  it("uses a non-empty custom dashboard command", () => {
    expect(devDashboardCommandFromEnv({
      HEXCLAVE_CLI_DEV_DASHBOARD_COMMAND: " pnpm --dir apps/dashboard run dev ",
    })).toBe("pnpm --dir apps/dashboard run dev");
  });

  it("ignores missing and blank custom dashboard commands", () => {
    expect(devDashboardCommandFromEnv({})).toBeUndefined();
    expect(devDashboardCommandFromEnv({ HEXCLAVE_CLI_DEV_DASHBOARD_COMMAND: "   " })).toBeUndefined();
  });
});

describe("dashboardEnvWithStatePath", () => {
  it("passes the resolved state path to the dashboard child", () => {
    expect(dashboardEnvWithStatePath({ NODE_ENV: "production" }, "C:\\Users\\Test\\AppData\\Local\\Hexclave\\dev-envs.json")).toEqual({
      NODE_ENV: "production",
      STACK_DEV_ENVS_PATH: "C:\\Users\\Test\\AppData\\Local\\Hexclave\\dev-envs.json",
    });
  });

  it("preserves an explicit state path override", () => {
    expect(dashboardEnvWithStatePath({
      STACK_DEV_ENVS_PATH: "C:\\custom\\dev-envs.json",
    }, "C:\\Users\\Test\\AppData\\Local\\Hexclave\\dev-envs.json").STACK_DEV_ENVS_PATH).toBe("C:\\custom\\dev-envs.json");
  });
});

describe("runChildProcess", () => {
  const args = [
    "plain",
    "space containing argument",
    "a&b",
    "%PATH%",
    "!PATH!",
    "^caret",
    'a"quoted"b',
    '{"json":"value"}',
    "trailing\\",
    'back\\slash"quote',
    "",
  ];

  function createArgvShim() {
    const tempDir = mkdtempSync(join(tmpdir(), "hexclave-windows-argv-"));
    const outputPath = join(tempDir, "argv.json");
    const scriptPath = join(tempDir, "print-argv.cjs");
    const shimPath = join(tempDir, "print-argv.cmd");

    writeFileSync(scriptPath, [
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'fs.writeFileSync(process.env.HEXCLAVE_TEST_ARGV_OUTPUT, JSON.stringify(args));',
    ].join("\n"));
    writeFileSync(shimPath, [
      "@echo off",
      `node "%~dp0print-argv.cjs" %*`,
    ].join("\r\n"));

    return { outputPath, shimPath, tempDir };
  }

  it.skipIf(process.platform !== "win32")("preserves argv through a Windows command shim", async () => {
    const { outputPath, shimPath, tempDir } = createArgvShim();

    try {
      await expect(runChildProcess({
        command: shimPath,
        args,
      }, {
        ...process.env,
        HEXCLAVE_TEST_ARGV_OUTPUT: outputPath,
      })).resolves.toBe(0);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(args);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("resolves a bare command name to its Windows shim", async () => {
    const { outputPath, tempDir } = createArgvShim();

    try {
      await expect(runChildProcess({
        command: "print-argv",
        args,
      }, {
        ...process.env,
        PATH: `;${tempDir};${process.env.PATH ?? ""}`,
        HEXCLAVE_TEST_ARGV_OUTPUT: outputPath,
      })).resolves.toBe(0);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(args);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("configErrorLogPrefix", () => {
  it("highlights the config error badge when color is supported", () => {
    expect(configErrorLogPrefix(true)).toBe("[Hexclave] \x1b[41;37;1m[CONFIG ERROR]\x1b[0m ");
  });

  it("keeps a readable plain-text badge without color support", () => {
    expect(configErrorLogPrefix(false)).toBe("[Hexclave] [CONFIG ERROR] ");
  });
});

describe("isHeartbeatResponse", () => {
  it("accepts config sync events from the dashboard heartbeat", () => {
    expect(isHeartbeatResponse({
      ok: true,
      config_sync_events: [
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "syncing",
          created_at_millis: 1_717_999_999_999,
        },
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "success",
          created_at_millis: 1_718_000_000_000,
        },
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "error",
          error_message: "Could not reach the API.",
          created_at_millis: 1_718_000_000_001,
        },
      ],
    })).toBe(true);
  });

  it("rejects malformed config sync events", () => {
    expect(isHeartbeatResponse({
      ok: true,
      config_sync_events: [
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "pending",
          created_at_millis: 1_718_000_000_000,
        },
      ],
    })).toBe(false);
    expect(isHeartbeatResponse({
      ok: true,
      config_sync_events: [
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "error",
          created_at_millis: 1_718_000_000_000,
        },
      ],
    })).toBe(false);
  });
});

describe("logConfigSyncEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports detection before confirming a successful sync", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    logConfigSyncEvents({
      ok: true,
      config_sync_events: [
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "syncing",
          created_at_millis: 1_718_000_000_000,
        },
        {
          config_file_path: "/app/hexclave.config.ts",
          status: "success",
          created_at_millis: 1_718_000_000_001,
        },
      ],
    });

    expect(warn.mock.calls).toEqual([
      ["[Hexclave] Detected change to config file at /app/hexclave.config.ts. Syncing..."],
      ["[Hexclave] Updated config sync successful!"],
    ]);
  });
});

describe("killLocalDashboard", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dev-kill-"));
    process.env.STACK_DEV_ENVS_PATH = join(tempDir, "dev-envs.json");
  });

  afterEach(() => {
    delete process.env.STACK_DEV_ENVS_PATH;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does nothing when no dashboard pid is recorded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Filter to our own signals: the worker-thread runtime may call
    // process.kill for its own bookkeeping, which isn't what we're asserting.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await killLocalDashboard("http://127.0.0.1:26700", 26700);
    // No recorded pid → return before probing the process or polling the port.
    expect(fetchMock).not.toHaveBeenCalled();
    const targetedCalls = killSpy.mock.calls.filter(([, sig]) => sig === "SIGTERM" || sig === "SIGKILL");
    expect(targetedCalls).toHaveLength(0);
  });

  it("returns immediately without a wait loop when the process is already gone (ESRCH)", async () => {
    recordLocalDashboardProcess(26700, "s", 4242, "/tmp/x.log", "2.8.110");
    // processExists(0-probe) throws ESRCH → treated as not alive → early return.
    vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("no such process") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await killLocalDashboard("http://127.0.0.1:26700", 26700);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not wait on or escalate a pid owned by another process (EPERM)", async () => {
    recordLocalDashboardProcess(26700, "s", 4242, "/tmp/x.log", "2.8.110");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      // signal 0 (existence probe) → EPERM means "exists but not ours".
      // SIGTERM → also EPERM; we must bail without looping.
      const e = new Error("operation not permitted") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await killLocalDashboard("http://127.0.0.1:26700", 26700);
    // processExists sees EPERM → alive; SIGTERM throws EPERM → early return.
    // We never poll /health, and never send SIGKILL.
    expect(fetchMock).not.toHaveBeenCalled();
    const sigkillCalls = killSpy.mock.calls.filter(([, sig]) => sig === "SIGKILL");
    expect(sigkillCalls).toHaveLength(0);
  });

  it("returns once the port is free without SIGKILL, even if the pid still resolves (recycled pid)", async () => {
    recordLocalDashboardProcess(26700, "s", 4242, "/tmp/x.log", "2.8.110");
    // Every process.kill (including the `0` probe) succeeds, so processExists
    // always reports the pid as alive — simulating a pid recycled onto another
    // live same-user process after our dashboard exited.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Port is already free (connection refused), so the dashboard is gone.
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await killLocalDashboard("http://127.0.0.1:26700", 26700);

    // SIGTERM is sent once; we must return as soon as the port frees up and
    // never escalate to SIGKILL against the (possibly recycled) pid.
    const sigterm = killSpy.mock.calls.filter(([, sig]) => sig === "SIGTERM");
    const sigkill = killSpy.mock.calls.filter(([, sig]) => sig === "SIGKILL");
    expect(sigterm).toHaveLength(1);
    expect(sigkill).toHaveLength(0);
  });
});
