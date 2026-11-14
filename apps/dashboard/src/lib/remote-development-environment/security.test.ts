import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyRemoteDevelopmentEnvironmentConfigUpdate, getPendingRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode } from "./manager";

vi.mock("server-only", () => ({}));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
  };
});

let tempDir: string | undefined;
const remoteDevelopmentEnvironmentEnabledEnv = "NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT";
const hexclaveRemoteDevelopmentEnvironmentEnabledEnv = "NEXT_PUBLIC_HEXCLAVE_IS_REMOTE_DEVELOPMENT_ENVIRONMENT";

function useTempStateFile(secret = "secret") {
  tempDir = mkdtempSync(join(tmpdir(), "stack-rde-security-"));
  process.env[remoteDevelopmentEnvironmentEnabledEnv] = "true";
  process.env.STACK_DEV_ENVS_PATH = join(tempDir, "dev-envs.json");
  writeFileSync(process.env.STACK_DEV_ENVS_PATH, JSON.stringify({
    version: 1,
    localDashboardsByPort: {
      "26700": {
        port: 26700,
        secret,
        pid: 123,
        startedAtMillis: Date.now(),
      },
    },
    projectsByConfigPath: {},
  }));
  chmodSync(process.env.STACK_DEV_ENVS_PATH, 0o600);
}

function request(headers: Record<string, string>, url = "http://127.0.0.1:26700/api/remote-development-environment/sessions") {
  return new NextRequest(url, { headers });
}

afterEach(() => {
  delete process.env[remoteDevelopmentEnvironmentEnabledEnv];
  delete process.env[hexclaveRemoteDevelopmentEnvironmentEnabledEnv];
  delete process.env.STACK_DEV_ENVS_PATH;
  if (tempDir != null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.restoreAllMocks();
  // Reset process-global browser-secret state so tests don't leak into each other.
  delete globalThis.__stackRemoteDevelopmentEnvironmentBrowserSecret;
  vi.resetModules();
});

describe("remote development environment security", () => {
  it("does not enforce POSIX state file permissions on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const chmodSpy = vi.mocked(chmodSync);
    useTempStateFile();
    const statePath = process.env.STACK_DEV_ENVS_PATH;
    if (statePath == null) {
      throw new Error("STACK_DEV_ENVS_PATH should be set by useTempStateFile().");
    }
    chmodSync(statePath, 0o644);
    chmodSpy.mockClear();
    const { readRemoteDevelopmentEnvironmentState } = await import("./state");

    expect(readRemoteDevelopmentEnvironmentState()).toMatchObject({
      version: 1,
      projectsByConfigPath: {},
    });
    expect(chmodSpy).not.toHaveBeenCalled();
  });

  it("is inactive unless explicitly enabled", async () => {
    useTempStateFile();
    delete process.env[remoteDevelopmentEnvironmentEnabledEnv];
    const { assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentRequest(request({
      host: "127.0.0.1:26700",
      authorization: "Bearer secret",
    }));
    expect(response?.status).toBe(404);
  });

  it("accepts the Hexclave remote development environment variable", async () => {
    useTempStateFile();
    delete process.env[remoteDevelopmentEnvironmentEnabledEnv];
    process.env[hexclaveRemoteDevelopmentEnvironmentEnabledEnv] = "true";
    const { assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentRequest(request({
      host: "127.0.0.1:26700",
      authorization: "Bearer secret",
    }));
    expect(response).toBeNull();
  });

  it("rejects missing or wrong bearer token", async () => {
    useTempStateFile();
    const { assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentRequest(request({
      host: "127.0.0.1:26700",
      authorization: "Bearer wrong",
    }));
    expect(response?.status).toBe(401);
  });

  it("rejects non-loopback hosts for bearer requests", async () => {
    useTempStateFile();
    const { assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    const badHost = assertRemoteDevelopmentEnvironmentRequest(request({
      host: "example.com",
      authorization: "Bearer secret",
    }));
    expect(badHost?.status).toBe(403);
  });

  it("requires a browser secret for same-origin browser auth", async () => {
    useTempStateFile();
    const { assertRemoteDevelopmentEnvironmentBrowserRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentBrowserRequest(request({
      host: "127.0.0.1:26700",
      origin: "http://127.0.0.1:26700",
      "sec-fetch-site": "same-origin",
    }));
    expect(response?.status).toBe(401);
    expect(response?.headers.get("x-hexclave-development-environment-browser-secret-error")).toBe("invalid_browser_secret");
  });

  it("rejects browser auth without an active local dashboard", async () => {
    useTempStateFile("");
    const { assertRemoteDevelopmentEnvironmentBrowserRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentBrowserRequest(request({
      host: "127.0.0.1:26700",
      origin: "http://127.0.0.1:26700",
      "sec-fetch-site": "same-origin",
    }));
    expect(response?.status).toBe(404);
  });

  it("rejects browser auth without the pinned browser secret", async () => {
    useTempStateFile();
    const { assertRemoteDevelopmentEnvironmentBrowserRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentBrowserRequest(request({
      host: "preview.example.test",
      origin: "http://preview.example.test",
      "sec-fetch-site": "same-origin",
    }));
    expect(response?.status).toBe(401);
  });

  it("accepts browser auth with a confirmation-code-issued host-pinned secret", async () => {
    useTempStateFile();
    const {
      initRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode,
      storeRemoteDevelopmentEnvironmentBrowserSecret,
      submitRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode,
    } = await import("./browser-secret");
    const { assertRemoteDevelopmentEnvironmentBrowserRequest } = await import("./security");

    const hostPinnedRequest = request({
      host: "preview.example.test",
      origin: "http://preview.example.test",
      "sec-fetch-site": "same-origin",
    });
    expect(initRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode(hostPinnedRequest).status).toBe(200);
    const confirmationCode = getPendingRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode();
    expect(confirmationCode?.code).toMatch(/^[A-Z0-9]{6}$/);
    if (confirmationCode == null) {
      throw new Error("Confirmation code should have been created.");
    }

    const submitResponse = submitRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode(hostPinnedRequest, confirmationCode.code);
    expect(submitResponse.status).toBe(200);
    const submitBody = await submitResponse.json();
    if (
      submitBody == null ||
      typeof submitBody !== "object" ||
      !("browser_secret" in submitBody) ||
      typeof submitBody.browser_secret !== "string"
    ) {
      throw new Error("Expected submit response to include browser_secret.");
    }

    const storeResponse = storeRemoteDevelopmentEnvironmentBrowserSecret(hostPinnedRequest, submitBody.browser_secret);
    const cookie = storeResponse.headers.get("set-cookie");
    expect(storeResponse.status).toBe(200);
    expect(cookie).toContain("hexclave-rde-browser-secret=");

    const browserResponse = assertRemoteDevelopmentEnvironmentBrowserRequest(request({
      host: "preview.example.test",
      origin: "http://preview.example.test",
      "sec-fetch-site": "same-origin",
      cookie: cookie ?? "",
    }));
    expect(browserResponse).toBeNull();
  });

  it("rejects browser secrets replayed on another host", async () => {
    useTempStateFile();
    const {
      initRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode,
      storeRemoteDevelopmentEnvironmentBrowserSecret,
      submitRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode,
    } = await import("./browser-secret");
    const { assertRemoteDevelopmentEnvironmentBrowserRequest } = await import("./security");

    const hostPinnedRequest = request({
      host: "preview.example.test",
      origin: "http://preview.example.test",
      "sec-fetch-site": "same-origin",
    });
    initRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode(hostPinnedRequest);
    const confirmationCode = getPendingRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode();
    if (confirmationCode == null) {
      throw new Error("Confirmation code should have been created.");
    }
    const submitResponse = submitRemoteDevelopmentEnvironmentBrowserSecretConfirmationCode(hostPinnedRequest, confirmationCode.code);
    const submitBody = await submitResponse.json();
    if (
      submitBody == null ||
      typeof submitBody !== "object" ||
      !("browser_secret" in submitBody) ||
      typeof submitBody.browser_secret !== "string"
    ) {
      throw new Error("Expected submit response to include browser_secret.");
    }
    const storeResponse = storeRemoteDevelopmentEnvironmentBrowserSecret(hostPinnedRequest, submitBody.browser_secret);
    const cookie = storeResponse.headers.get("set-cookie");

    const browserResponse = assertRemoteDevelopmentEnvironmentBrowserRequest(request({
      host: "attacker.example.test",
      origin: "http://attacker.example.test",
      "sec-fetch-site": "same-origin",
      cookie: cookie ?? "",
    }, "http://attacker.example.test/api/remote-development-environment/sessions"));
    expect(browserResponse?.status).toBe(401);
  });

  it("accepts CLI bearer requests from loopback without trusting arbitrary origins", async () => {
    useTempStateFile();
    const { assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentRequest(request({
      host: "127.0.0.1:26700",
      origin: "http://evil.localhost:26700",
      authorization: "Bearer secret",
    }));
    expect(response).toBeNull();
  });

  it("accepts separate dashboard secrets and origins per port", async () => {
    useTempStateFile();
    const statePath = process.env.STACK_DEV_ENVS_PATH;
    if (statePath == null) {
      throw new Error("STACK_DEV_ENVS_PATH should be set by useTempStateFile().");
    }
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      localDashboardsByPort: {
        "26700": {
          port: 26700,
          secret: "first-secret",
          pid: 123,
          startedAtMillis: Date.now(),
        },
        "26701": {
          port: 26701,
          secret: "second-secret",
          pid: 456,
          startedAtMillis: Date.now(),
        },
      },
      projectsByConfigPath: {},
    }));
    chmodSync(statePath, 0o600);

    const { assertRemoteDevelopmentEnvironmentBrowserRequest, assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    expect(assertRemoteDevelopmentEnvironmentRequest(new NextRequest("http://127.0.0.1:26701/api/remote-development-environment/sessions", {
      headers: {
        host: "127.0.0.1:26701",
        authorization: "Bearer second-secret",
      },
    }))).toBeNull();
    expect(assertRemoteDevelopmentEnvironmentBrowserRequest(new NextRequest("http://127.0.0.1:26701/api/remote-development-environment/sessions", {
      headers: {
        host: "127.0.0.1:26701",
        origin: "http://127.0.0.1:26701",
        "sec-fetch-site": "same-origin",
      },
    }))?.status).toBe(401);
  });

  it("rejects config writes without an active session", async () => {
    useTempStateFile();
    await expect(applyRemoteDevelopmentEnvironmentConfigUpdate({
      sessionId: "missing",
      configUpdate: {},
    })).rejects.toThrow(/session is not active/);
  });

  it.skipIf(process.platform === "win32")("repairs broad state file permissions before checking requests", async () => {
    useTempStateFile();
    const statePath = process.env.STACK_DEV_ENVS_PATH;
    if (statePath == null) {
      throw new Error("STACK_DEV_ENVS_PATH should be set by useTempStateFile().");
    }
    chmodSync(statePath, 0o644);

    const { assertRemoteDevelopmentEnvironmentRequest } = await import("./security");
    const response = assertRemoteDevelopmentEnvironmentRequest(request({
      host: "127.0.0.1:26700",
      authorization: "Bearer secret",
    }));
    expect(response).toBeNull();
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });
});
