import { AgentBrowserCommandError, type AgentBrowserCommandResult } from "@agent-browser/eve/sandbox";
import type { RuntimeSandboxSession } from "eve/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAgentBrowserMock = vi.hoisted(() => vi.fn());

vi.mock("@agent-browser/eve/sandbox", async (importOriginal) => {
  const original = await importOriginal<typeof import("@agent-browser/eve/sandbox")>();
  return { ...original, runAgentBrowser: runAgentBrowserMock };
});

import {
  isBrowserRuntimeUnavailableError,
  isRecoverableBrowserProcessError,
  renderPageInBrowser,
  stopBrowserSession,
} from "./browser-session.ts";


function commandResult(options: { readonly json?: unknown, readonly stdout?: string }): AgentBrowserCommandResult {
  return {
    command: "agent-browser",
    exitCode: 0,
    json: options.json ?? null,
    stderr: "",
    stdout: options.stdout ?? "",
  };
}

function makeSandbox(options: { readonly browserWasUsed?: boolean } = {}): RuntimeSandboxSession {
  return {
    id: "sandbox-one",
    readBinaryFile: vi.fn(async () => new TextEncoder().encode("png")),
    readFile: vi.fn(),
    readTextFile: vi.fn(async () => options.browserWasUsed === true ? "1\n" : null),
    removePath: vi.fn(),
    resolvePath: (path) => path,
    run: vi.fn(),
    setNetworkPolicy: vi.fn(),
    spawn: vi.fn(),
    stop: vi.fn(),
    writeBinaryFile: vi.fn(),
    writeFile: vi.fn(),
    writeTextFile: vi.fn(),
  };
}

function contextFor(sandbox: RuntimeSandboxSession) {
  return { getSandbox: async () => sandbox };
}

function pageCommandResults(url: string): AgentBrowserCommandResult[] {
  return [
    commandResult({ json: { success: true, data: {} } }),
    commandResult({ json: { success: true, data: { title: "Example" } } }),
    commandResult({ json: { success: true, data: { url } } }),
    commandResult({ stdout: "- heading Example" }),
  ];
}

beforeEach(() => {
  runAgentBrowserMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser session lifecycle", () => {
  it("keeps the browser open across page calls in the same Eve sandbox", async () => {
    const sandbox = makeSandbox();
    for (const result of [...pageCommandResults("https://example.com/one"), ...pageCommandResults("https://example.com/two")]) {
      runAgentBrowserMock.mockResolvedValueOnce(result);
    }

    await renderPageInBrowser({ context: contextFor(sandbox), screenshot: false, url: "https://example.com/one" });
    await renderPageInBrowser({ context: contextFor(sandbox), screenshot: false, url: "https://example.com/two" });

    const commands = runAgentBrowserMock.mock.calls.map((call) => call[1][0]);
    expect(commands.filter((command) => command === "open")).toHaveLength(2);
    expect(commands).not.toContain("close");
    expect(sandbox.writeTextFile).toHaveBeenCalledTimes(2);
  });

  it("serializes simultaneous page calls that share a browser session", async () => {
    const sandbox = makeSandbox();
    let releaseFirstOpen: (result: AgentBrowserCommandResult) => void = () => {
      throw new Error("First browser command completed before its test gate was initialized");
    };
    const firstOpen = new Promise<AgentBrowserCommandResult>((resolve) => {
      releaseFirstOpen = resolve;
    });
    runAgentBrowserMock.mockImplementationOnce(async () => await firstOpen);
    for (const result of [
      ...pageCommandResults("https://example.com/one").slice(1),
      ...pageCommandResults("https://example.com/two"),
    ]) {
      runAgentBrowserMock.mockResolvedValueOnce(result);
    }

    const firstPage = renderPageInBrowser({ context: contextFor(sandbox), screenshot: false, url: "https://example.com/one" });
    await vi.waitFor(() => expect(runAgentBrowserMock).toHaveBeenCalledTimes(1));
    const secondPage = renderPageInBrowser({ context: contextFor(sandbox), screenshot: false, url: "https://example.com/two" });
    await Promise.resolve();

    expect(runAgentBrowserMock).toHaveBeenCalledTimes(1);
    releaseFirstOpen(commandResult({ json: { success: true, data: {} } }));
    await Promise.all([firstPage, secondPage]);
  });

  it("reads screenshot bytes from the same Eve sandbox", async () => {
    const sandbox = makeSandbox();
    for (const result of [
      ...pageCommandResults("https://example.com/"),
      commandResult({ json: { success: true, data: { path: "/workspace/screenshot.png" } } }),
    ]) {
      runAgentBrowserMock.mockResolvedValueOnce(result);
    }

    const result = await renderPageInBrowser({ context: contextFor(sandbox), screenshot: true, url: "https://example.com/" });

    expect(result.screenshotBase64).toBe("cG5n");
    expect(sandbox.readBinaryFile).toHaveBeenCalledWith({ path: "/workspace/screenshot.png" });
  });

  it("closes a used browser and stops the phase sandbox at the terminal boundary", async () => {
    const sandbox = makeSandbox({ browserWasUsed: true });
    runAgentBrowserMock.mockResolvedValueOnce(commandResult({}));

    await stopBrowserSession(contextFor(sandbox));

    expect(runAgentBrowserMock).toHaveBeenCalledWith(expect.anything(), ["close"], expect.objectContaining({ json: false }));
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });

  it("stops an unused phase sandbox without starting a browser just to close it", async () => {
    const sandbox = makeSandbox();

    await stopBrowserSession(contextFor(sandbox));

    expect(runAgentBrowserMock).not.toHaveBeenCalled();
    expect(sandbox.stop).toHaveBeenCalledOnce();
  });
});

describe("browser failure classification", () => {
  it("only treats missing browser runtime errors as curl-fallback safe", () => {
    const unavailable = new AgentBrowserCommandError({
      command: "agent-browser open",
      exitCode: 127,
      stderr: "agent-browser: command not found",
      stdout: "",
    });
    const navigation = new AgentBrowserCommandError({
      command: "agent-browser open",
      exitCode: 1,
      stderr: "Navigation timed out",
      stdout: "",
    });

    expect(isBrowserRuntimeUnavailableError(unavailable)).toBe(true);
    expect(isBrowserRuntimeUnavailableError(navigation)).toBe(false);
  });

  it("recognizes a crashed browser process as retryable", () => {
    const crashed = new AgentBrowserCommandError({
      command: "agent-browser open",
      exitCode: 1,
      stderr: "Browser has disconnected",
      stdout: "",
    });

    expect(isRecoverableBrowserProcessError(crashed)).toBe(true);
  });
});
