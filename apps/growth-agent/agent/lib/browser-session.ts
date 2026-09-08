import {
  AgentBrowserCommandError,
  runAgentBrowser,
  type AgentBrowserCommandResult,
} from "@agent-browser/eve/sandbox";
import type { RuntimeSandboxSession } from "eve/sandbox";


export type BrowserSessionContext = {
  readonly abortSignal?: AbortSignal,
  getSandbox(): Promise<RuntimeSandboxSession>,
};

export type BrowserPageResult = {
  readonly finalUrl: string,
  readonly title: string,
  readonly snapshotText: string,
  readonly screenshotBase64?: string,
};

const SNAPSHOT_CHAR_CAP = 20_000;
const BROWSER_USED_MARKER_PATH = "/workspace/.hexclave-browser-used";
const BROWSER_COMMAND_TIMEOUT_MS = 90_000;

// Eve normally serializes one durable child session. This small in-process
// gate also protects the shared browser when a model emits parallel tool calls
// or a queue redelivery overlaps an invocation that is still settling.
const sessionGates = new Map<string, Promise<void>>();

async function withExclusiveBrowserSession<T>(
  context: BrowserSessionContext,
  task: (context: BrowserSessionContext, sandbox: RuntimeSandboxSession) => Promise<T>,
): Promise<T> {
  const sandbox = await context.getSandbox();
  const previousGate = sessionGates.get(sandbox.id) ?? Promise.resolve();
  let releaseGate: () => void = () => {
    throw new Error("Browser session gate released before it was initialized");
  };
  const releasePromise = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const currentGate = previousGate.then(() => releasePromise);
  sessionGates.set(sandbox.id, currentGate);

  await previousGate;
  context.abortSignal?.throwIfAborted();
  const boundContext: BrowserSessionContext = {
    ...context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal },
    getSandbox: async () => sandbox,
  };
  try {
    return await task(boundContext, sandbox);
  } finally {
    releaseGate();
    if (sessionGates.get(sandbox.id) === currentGate) {
      sessionGates.delete(sandbox.id);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandData(result: AgentBrowserCommandResult): unknown {
  if (!isObject(result.json)) return result.json;
  if (result.json.success === false) {
    const detail = typeof result.json.error === "string" ? result.json.error : "unknown browser error";
    throw new Error(`agent-browser command failed: ${detail}`);
  }
  return "data" in result.json ? result.json.data : result.json;
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!isObject(value)) return undefined;
  const propertyValue = value[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function browserErrorDetail(error: Error): string {
  return error instanceof AgentBrowserCommandError
    ? `${error.stderr}\n${error.stdout}`
    : error.message;
}

export function isRecoverableBrowserProcessError(error: unknown): boolean {
  return error instanceof Error
    && /ECONNREFUSED|connection refused|browser (?:has )?(?:closed|crashed|disconnected)|target closed|daemon (?:is )?not running/i.test(browserErrorDetail(error));
}

export function isBrowserRuntimeUnavailableError(error: unknown): boolean {
  return error instanceof Error
    && /agent-browser(?::)? (?:command )?not found|browser executable (?:was )?not found|chrom(?:e|ium).*(?:not found|missing)|failed to launch|error while loading shared libraries/i.test(browserErrorDetail(error));
}

async function runBrowserCommand(
  context: BrowserSessionContext,
  args: readonly string[],
  options: { readonly json?: boolean } = {},
): Promise<AgentBrowserCommandResult> {
  const deadlineSignal = AbortSignal.timeout(BROWSER_COMMAND_TIMEOUT_MS);
  const abortSignal = context.abortSignal === undefined
    ? deadlineSignal
    : AbortSignal.any([context.abortSignal, deadlineSignal]);
  return await runAgentBrowser(context, args, {
    abortSignal,
    ...options.json === undefined ? {} : { json: options.json },
  });
}

function parseBrowserUseCount(marker: string | null): number {
  if (marker === null) return 0;
  const count = Number.parseInt(marker.trim(), 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

async function openPage(context: BrowserSessionContext, url: string): Promise<void> {
  try {
    commandData(await runBrowserCommand(context, ["open", url]));
  } catch (error) {
    if (!isRecoverableBrowserProcessError(error)) throw error;
    console.warn("[growth-agent] browser process disappeared; restarting it inside the existing website-research sandbox");
    commandData(await runBrowserCommand(context, ["open", url]));
  }
}

export async function renderPageInBrowser(options: {
  readonly context: BrowserSessionContext,
  readonly screenshot: boolean,
  readonly url: string,
}): Promise<BrowserPageResult> {
  return await withExclusiveBrowserSession(options.context, async (context, sandbox) => {
    await openPage(context, options.url);
    const previousPageCount = parseBrowserUseCount(await sandbox.readTextFile({ path: BROWSER_USED_MARKER_PATH }));
    const pageCount = previousPageCount + 1;
    await sandbox.writeTextFile({ path: BROWSER_USED_MARKER_PATH, content: `${pageCount}\n` });
    console.info(`[growth-agent] website-research browser ${previousPageCount === 0 ? "started" : "reused"}: sandbox=${sandbox.id} page=${pageCount}`);

    const titleData = commandData(await runBrowserCommand(context, ["get", "title"]));
    const title = stringProperty(titleData, "title") ?? "";
    const urlData = commandData(await runBrowserCommand(context, ["get", "url"]));
    const finalUrl = stringProperty(urlData, "url") ?? options.url;

    const snapshotResult = await runBrowserCommand(context, ["snapshot", "-i", "-c"], { json: false });
    const fullSnapshot = snapshotResult.stdout.trim();
    const snapshotText = fullSnapshot.length > SNAPSHOT_CHAR_CAP
      ? `${fullSnapshot.slice(0, SNAPSHOT_CHAR_CAP)}\n… [snapshot truncated at ${SNAPSHOT_CHAR_CAP} characters]`
      : fullSnapshot;

    if (!options.screenshot) return { finalUrl, title, snapshotText };

    const screenshotData = commandData(await runBrowserCommand(context, ["screenshot"]));
    const screenshotPath = stringProperty(screenshotData, "path");
    if (screenshotPath === undefined) {
      throw new Error("agent-browser screenshot did not return a file path");
    }
    const screenshotBytes = await sandbox.readBinaryFile({ path: screenshotPath });
    if (screenshotBytes == null) {
      throw new Error(`agent-browser screenshot path ${JSON.stringify(screenshotPath)} did not contain a readable file`);
    }
    return {
      finalUrl,
      title,
      snapshotText,
      screenshotBase64: Buffer.from(screenshotBytes).toString("base64"),
    };
  });
}

export async function stopBrowserSession(context: BrowserSessionContext): Promise<void> {
  await withExclusiveBrowserSession(context, async (boundContext, sandbox) => {
    const pageCount = parseBrowserUseCount(await sandbox.readTextFile({ path: BROWSER_USED_MARKER_PATH }));
    try {
      if (pageCount > 0) {
        await runBrowserCommand(boundContext, ["close"], { json: false });
        console.info(`[growth-agent] website-research browser closed: sandbox=${sandbox.id} pages=${pageCount}`);
      }
    } finally {
      await sandbox.removePath({ path: BROWSER_USED_MARKER_PATH, force: true, recursive: false });
      await sandbox.stop();
    }
  });
}
