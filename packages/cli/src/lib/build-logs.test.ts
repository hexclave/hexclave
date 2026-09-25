import { describe, expect, it } from "vitest";
import { STREAM_ERROR_MARKER, STREAM_TIMEOUT_MARKER, followBuildLogs, isStreamMarkerLine } from "./build-logs.js";

const URL_UNDER_TEST = "https://api.example.com/api/latest/deployments/deployments/dep-1/logs";

/** A text/plain 200 whose body is delivered in the given chunks, as the endpoint does. */
function textStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Serves the queued responses in order; the last one repeats if asked for again. */
function queuedFetch(responses: Response[]): { fetchImpl: typeof fetch, callCount: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    const response = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, callCount: () => calls };
}

function follow(options: {
  responses: Response[],
  isDeploymentFinished?: () => boolean,
}): { lines: string[], warnings: string[], done: Promise<void>, callCount: () => number } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const { fetchImpl, callCount } = queuedFetch(options.responses);
  const done = followBuildLogs({
    url: URL_UNDER_TEST,
    getAuthHeaders: () => Promise.resolve({ "x-stack-access-type": "server" }),
    isDeploymentFinished: options.isDeploymentFinished ?? (() => false),
    write: (line) => lines.push(line),
    warn: (message) => warnings.push(message),
    fetchImpl,
    waitImpl: () => Promise.resolve(),
  });
  return { lines, warnings, done, callCount };
}

describe("followBuildLogs", () => {
  it("writes every line of a completed build, then stops", async () => {
    const { lines, done, callCount } = follow({
      responses: [textStreamResponse(["#1 [internal] load build definition\n", "#2 DONE 0.1s\n"])],
    });
    await done;
    expect(lines).toEqual(["#1 [internal] load build definition", "#2 DONE 0.1s"]);
    // A clean close means the build is complete — no reason to ask again.
    expect(callCount()).toBe(1);
  });

  it("reassembles lines split across chunk boundaries and keeps an unterminated last line", async () => {
    const { lines, done } = follow({
      responses: [textStreamResponse(["#1 load", " build definition\n#2 DO", "NE 0.1s"])],
    });
    await done;
    expect(lines).toEqual(["#1 load build definition", "#2 DONE 0.1s"]);
  });

  it("strips CRLF so a Windows-y builder doesn't leave carriage returns", async () => {
    const { lines, done } = follow({ responses: [textStreamResponse(["step one\r\nstep two\r\n"])] });
    await done;
    expect(lines).toEqual(["step one", "step two"]);
  });

  it("resumes correctly when the reconnected stream reopens MID-history, not at line 1", async () => {
    // The case a real Fly build hit. Each request restarts with no cursor, so a
    // still-running build reopens wherever Fly's log window begins — here at
    // line 3, not line 1. Counting printed lines and skipping that many would
    // reprint 3..6; the anchor match is what makes it resume at 7.
    const { lines, done, callCount } = follow({
      responses: [
        textStreamResponse([`line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n${STREAM_TIMEOUT_MARKER}\n`]),
        textStreamResponse(["line 3\nline 4\nline 5\nline 6\nline 7\nline 8\n"]),
      ],
    });
    await done;
    expect(lines).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"]);
    expect(callCount()).toBe(2);
  });

  it("releases held lines when the window advanced past everything printed", async () => {
    // No overlap at all: the reconnected stream starts after the last printed
    // line. Those lines are the only copy there is, so they must be printed —
    // with a warning, because the gap between line 2 and line 40 is real.
    const { lines, warnings, done } = follow({
      responses: [
        textStreamResponse([`line 1\nline 2\n${STREAM_TIMEOUT_MARKER}\n`]),
        textStreamResponse(["line 40\nline 41\n"]),
      ],
    });
    await done;
    expect(lines).toEqual(["line 1", "line 2", "line 40", "line 41"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("skipped ahead");
  });

  it("does not re-anchor on a repeated line, which build output is full of", async () => {
    // "#7 pushing layers" style repetition: a one-line anchor would match the
    // FIRST copy and swallow everything after it. The multi-line anchor doesn't.
    const { lines, done } = follow({
      responses: [
        textStreamResponse([`prep\nsame\nsame\nsame\nalpha\nbravo\n${STREAM_TIMEOUT_MARKER}\n`]),
        textStreamResponse(["prep\nsame\nsame\nsame\nalpha\nbravo\ncharlie\n"]),
      ],
    });
    await done;
    expect(lines).toEqual(["prep", "same", "same", "same", "alpha", "bravo", "charlie"]);
  });

  it("skips the replay when the stream times out and it re-requests", async () => {
    // A finished deployment DOES replay in full (it is served from the durable
    // log), so the second pass must re-emit nothing the first one already wrote.
    const { lines, warnings, done, callCount } = follow({
      responses: [
        textStreamResponse([`line 1\nline 2\n${STREAM_TIMEOUT_MARKER}\n`]),
        textStreamResponse(["line 1\nline 2\nline 3\n"]),
      ],
    });
    await done;
    expect(lines).toEqual(["line 1", "line 2", "line 3"]);
    expect(callCount()).toBe(2);
    // The reconnect is transparent, so the marker itself is never shown.
    expect(warnings).toEqual([]);
  });

  it("never treats the server's stream markers as build output", async () => {
    // Markers are not part of the log, so they must not be printed and must not
    // become part of the anchor the next reconnect matches against.
    const { lines, done } = follow({
      responses: [
        textStreamResponse([`line 1\n${STREAM_ERROR_MARKER}\n`]),
        textStreamResponse([`line 1\nline 2\n${STREAM_TIMEOUT_MARKER}\n`]),
        textStreamResponse(["line 1\nline 2\nline 3\n"]),
      ],
    });
    await done;
    expect(lines).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("keeps waiting while the deployment has no build logs yet", async () => {
    let finished = false;
    const notYet = () => new Response("This deployment has no build logs yet.", { status: 400 });
    const { lines, done, callCount } = follow({
      responses: [notYet(), notYet(), textStreamResponse(["built\n"])],
      isDeploymentFinished: () => finished,
    });
    await done;
    finished = true;
    expect(lines).toEqual(["built"]);
    expect(callCount()).toBe(3);
  });

  it("gives up once the deployment is finished and there is still no build", async () => {
    // An all-prebuilt deploy answers 400 forever; the terminal state is what
    // ends the loop rather than a signal from the endpoint.
    const { lines, warnings, done, callCount } = follow({
      responses: [new Response("This deployment produced no build.", { status: 400 })],
      isDeploymentFinished: () => true,
    });
    await done;
    expect(lines).toEqual([]);
    expect(warnings).toEqual([]);
    // One pass with the deployment already terminal, then out.
    expect(callCount()).toBe(1);
  });

  it("runs one last pass after the deployment finishes, to pick up the tail", async () => {
    let finished = false;
    const { lines, done } = follow({
      responses: [
        textStreamResponse([`line 1\n${STREAM_TIMEOUT_MARKER}\n`]),
        textStreamResponse(["line 1\nline 2\n"]),
      ],
      isDeploymentFinished: () => finished,
    });
    finished = true;
    await done;
    expect(lines).toEqual(["line 1", "line 2"]);
  });

  it("warns and gives up rather than looping forever on a persistent server error", async () => {
    const { lines, warnings, done, callCount } = follow({
      responses: [new Response("nope", { status: 500 })],
    });
    await done;
    expect(lines).toEqual([]);
    expect(callCount()).toBe(5);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 500");
  });

  it("stops promptly when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const lines: string[] = [];
    await followBuildLogs({
      url: URL_UNDER_TEST,
      getAuthHeaders: () => Promise.resolve({}),
      isDeploymentFinished: () => false,
      write: (line) => lines.push(line),
      warn: () => {},
      signal: controller.signal,
      fetchImpl: (() => Promise.reject(new Error("should not be called"))) as unknown as typeof fetch,
      waitImpl: () => Promise.resolve(),
    });
    expect(lines).toEqual([]);
  });
});

describe("isStreamMarkerLine", () => {
  it("recognizes only the backend's own markers", () => {
    expect(isStreamMarkerLine(STREAM_TIMEOUT_MARKER)).toBe(true);
    expect(isStreamMarkerLine(STREAM_ERROR_MARKER)).toBe(true);
    expect(isStreamMarkerLine("[hexclave] something else")).toBe(false);
    expect(isStreamMarkerLine("#1 DONE 0.1s")).toBe(false);
  });
});
