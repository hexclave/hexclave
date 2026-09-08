import type { Session } from "eve/channels";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_STREAM_RECONNECT_POLICY,
  followSessionEvents,
  SessionStreamLostError,
  SessionStreamLimitError,
  SessionTimeoutError,
  type SessionStreamEvent,
  type SessionStreamReconnectPolicy,
} from "#lib/session-stream.ts";


function startedEvent(index: number): SessionStreamEvent {
  return { type: "session.started", data: {}, meta: { at: new Date(0).toISOString(), id: `evt_${index}` } };
}

function completedEvent(index: number): SessionStreamEvent {
  return { type: "session.completed", meta: { at: new Date(0).toISOString(), id: `evt_${index}` } };
}

function waitingEvent(index: number): SessionStreamEvent {
  return { type: "session.waiting", data: { continuationToken: "growth:test", wait: "next-user-message" }, meta: { at: new Date(0).toISOString(), id: `evt_${index}` } };
}

type ConnectionOpen =
  | { readonly kind: "ok" }
  | { readonly kind: "throw", readonly error: Error }
  | { readonly kind: "hang" };

type ConnectionEnd =
  | { readonly kind: "close" }
  | { readonly kind: "disconnect" }
  | { readonly kind: "fatal", readonly error: Error };

type ScriptedConnection = {
  readonly deliver: number,
  readonly end: ConnectionEnd,
  readonly open?: ConnectionOpen,
};

type FakeSession = {
  readonly session: Session,
  readonly openedAt: number[],
  readonly cancelCalls: () => number,
};

function createFakeSession(options: {
  readonly log: readonly SessionStreamEvent[],
  readonly connections: readonly ScriptedConnection[],
  readonly onCancel?: () => Promise<void>,
}): FakeSession {
  const openedAt: number[] = [];
  let cancelCalls = 0;
  let connectionIndex = 0;

  const session: Session = {
    id: "wrun_test",
    send: async () => throwErr("fake session does not send"),
    respond: async () => throwErr("fake session does not respond"),
    cancel: async () => {
      cancelCalls += 1;
      if (options.onCancel !== undefined) await options.onCancel();
      return { sessionId: "wrun_test", status: "accepted" };
    },
    compact: async () => throwErr("fake session does not compact"),
    clear: async () => throwErr("fake session does not clear"),
    reset: async () => throwErr("fake session does not reset"),
    getStreamTailIndex: async () => options.log.length - 1,
    getEventStream: async (streamOptions) => {
      const startIndex = streamOptions?.startIndex ?? 0;
      openedAt.push(startIndex);
      // A script that runs out means the follower reconnected more times than the test expected;
      // serving an endless empty stream would hang it, so fail loudly instead.
      const connection = options.connections[connectionIndex] ?? throwErr(`fake session opened ${connectionIndex + 1} streams but the script has ${options.connections.length}`);
      connectionIndex += 1;
      const open = connection.open ?? { kind: "ok" };
      if (open.kind === "throw") throw open.error;
      // Deliberately a promise that never settles, not a long timer: the follower must be shown
      // racing the open against its cap, not merely outlasting a slow one.
      if (open.kind === "hang") await new Promise<never>(() => {});
      const available = options.log.slice(startIndex, startIndex + connection.deliver);
      let emitted = 0;
      return new ReadableStream<SessionStreamEvent>({
        pull(controller) {
          if (emitted < available.length) {
            controller.enqueue(available[emitted] ?? throwErr("slice index out of range"));
            emitted += 1;
            return;
          }
          switch (connection.end.kind) {
            case "close": {
              controller.close();
              return;
            }
            case "disconnect": {
              // The message undici uses for a socket cut, which is what the follower matches on.
              controller.error(new Error("terminated"));
              return;
            }
            case "fatal": {
              controller.error(connection.end.error);
              return;
            }
          }
        },
      });
    },
  };

  return { session, openedAt, cancelCalls: () => cancelCalls };
}

function throwErr(message: string): never {
  throw new Error(message);
}

/** No backoff, so the reconnect tests do not pay real wall-clock time for their retries. */
const INSTANT_RETRIES: SessionStreamReconnectPolicy = { baseDelayMs: 0, maxDelayMs: 0, maxEmptyAttempts: 3, maxOpenAttempts: 3 };

async function collect(session: Session, options?: {
  readonly maxSessionMs?: number,
  readonly reconnect?: SessionStreamReconnectPolicy,
  /** Which event the consumer treats as its exit. Defaults to the real terminal event. */
  readonly stopOn?: SessionStreamEvent["type"],
  readonly cancelWaitMs?: number,
  readonly isAlreadyStopped?: () => boolean,
  /** Runs on every event, so a test can mimic a consumer that stops the session mid-iteration. */
  readonly onEvent?: (event: SessionStreamEvent) => void,
  readonly maxStreamBytes?: number,
}): Promise<SessionStreamEvent[]> {
  const seen: SessionStreamEvent[] = [];
  for await (const event of followSessionEvents({
    session,
    label: "Test run",
    maxSessionMs: options?.maxSessionMs ?? 60_000,
    reconnect: options?.reconnect ?? INSTANT_RETRIES,
    cancelWaitMs: options?.cancelWaitMs ?? 50,
    isAlreadyStopped: options?.isAlreadyStopped,
    maxStreamBytes: options?.maxStreamBytes,
  })) {
    seen.push(event);
    options?.onEvent?.(event);
    if (event.type === (options?.stopOn ?? "session.completed")) break;
  }
  return seen;
}

describe("followSessionEvents", () => {
  it("resumes from the cursor when the stream ends before the terminal event", async () => {
    // The exact production failure: the connection dies after two events, and the terminal event
    // only exists on the far side of a reconnect.
    const log = [startedEvent(0), startedEvent(1), completedEvent(2)];
    const fake = createFakeSession({
      log,
      connections: [{ deliver: 2, end: { kind: "close" } }, { deliver: 1, end: { kind: "close" } }],
    });

    const seen = await collect(fake.session);

    expect(seen.map((event) => event.meta.id)).toMatchInlineSnapshot(`
      [
        "evt_0",
        "evt_1",
        "evt_2",
      ]
    `);
    // The second open resumes at 2 — the count already consumed — so nothing is replayed and the
    // consumer never sees a duplicate.
    expect(fake.openedAt).toMatchInlineSnapshot(`
      [
        0,
        2,
      ]
    `);
    expect(fake.cancelCalls()).toBe(0);
  });

  it("treats a mid-stream transport error the same as a clean early end", async () => {
    const log = [startedEvent(0), completedEvent(1)];
    const fake = createFakeSession({
      log,
      connections: [{ deliver: 1, end: { kind: "disconnect" } }, { deliver: 1, end: { kind: "close" } }],
    });

    const seen = await collect(fake.session);

    expect(seen.map((event) => event.type)).toEqual(["session.started", "session.completed"]);
    expect(fake.openedAt).toEqual([0, 1]);
  });

  it("rethrows an error that does not look like a disconnect", async () => {
    // A real bug in our own reading code must not be retried into silence.
    const fake = createFakeSession({
      log: [startedEvent(0)],
      connections: [{ deliver: 0, end: { kind: "fatal", error: new Error("unexpected token < in JSON") } }],
    });

    await expect(collect(fake.session)).rejects.toThrow("unexpected token < in JSON");
    expect(fake.openedAt).toEqual([0]);
  });

  it("keeps reconnecting while events still arrive, without spending the empty budget", async () => {
    // Five drops, but every connection delivers something — a slow session that keeps producing is
    // alive by definition, however often its connection is cut.
    const log = [startedEvent(0), startedEvent(1), startedEvent(2), startedEvent(3), completedEvent(4)];
    const fake = createFakeSession({
      log,
      connections: Array.from({ length: 5 }, () => ({ deliver: 1, end: { kind: "close" } as const })),
    });

    const seen = await collect(fake.session);

    expect(seen).toHaveLength(5);
    expect(fake.openedAt).toEqual([0, 1, 2, 3, 4]);
  });

  it("gives up after the empty-reconnect budget and cancels the abandoned session", async () => {
    const fake = createFakeSession({
      log: [startedEvent(0)],
      connections: [
        { deliver: 1, end: { kind: "close" } },
        { deliver: 0, end: { kind: "close" } },
        { deliver: 0, end: { kind: "close" } },
        { deliver: 0, end: { kind: "close" } },
      ],
    });

    await expect(collect(fake.session)).rejects.toThrow(SessionStreamLostError);
    // One productive connection plus exactly the budget: the counter reset on the event it did see.
    expect(fake.openedAt).toEqual([0, 1, 1, 1]);
    // Nothing else would ever stop the session, so it must be cancelled on the way out.
    expect(fake.cancelCalls()).toBe(1);
  });

  it("cancels the session when the wall-clock cap elapses", async () => {
    // A stream that stays open and silent forever is the shape the cap exists for.
    const fake = createFakeSession({
      log: [],
      connections: [{ deliver: 0, end: { kind: "close" } }],
    });
    const stalled: Session = {
      ...fake.session,
      getEventStream: async () => new ReadableStream<SessionStreamEvent>({ pull() { /* never resolves a read */ } }),
    };

    await expect(collect(stalled, { maxSessionMs: 20 })).rejects.toThrow(SessionTimeoutError);
    expect(fake.cancelCalls()).toBe(1);
  });

  it("cancels a session before its serialized event stream can grow without bound", async () => {
    const log = [startedEvent(0), startedEvent(1), completedEvent(2)];
    const fake = createFakeSession({
      log,
      connections: [{ deliver: 3, end: { kind: "close" } }],
    });

    await expect(collect(fake.session, { maxStreamBytes: 100 })).rejects.toThrow(SessionStreamLimitError);
    expect(fake.cancelCalls()).toBe(1);
  });

  it("reports a cancel failure without letting it replace the error the caller needs", async () => {
    // The timeout is the diagnosis; a cancel that also fails must not become the thrown message,
    // because several callers render what they catch to a customer.
    const fake = createFakeSession({
      log: [],
      connections: [{ deliver: 0, end: { kind: "close" } }],
      onCancel: () => Promise.reject(new Error("cancel route returned 503")),
    });
    const stalled: Session = {
      ...fake.session,
      getEventStream: async () => new ReadableStream<SessionStreamEvent>({ pull() { /* never resolves a read */ } }),
    };

    await expect(collect(stalled, { maxSessionMs: 20 })).rejects.toThrow(/Test run timed out/);
    await expect(collect(stalled, { maxSessionMs: 20 })).rejects.not.toThrow(/503/);
  });

  it("does not cancel a session the consumer finished with normally", async () => {
    // Breaking out on the terminal event is the happy path; cancelling there would be cancelling a
    // session that already completed.
    const fake = createFakeSession({
      log: [completedEvent(0)],
      connections: [{ deliver: 1, end: { kind: "close" } }],
    });

    await collect(fake.session);

    expect(fake.cancelCalls()).toBe(0);
  });

  it("retries an open that the workflow API refuses, and stops the session when it never recovers", async () => {
    // Opening is a distinct failure from a stream that opened and said nothing, and it has its own
    // budget. A blip that refuses one connection must not fail the run.
    const log = [completedEvent(0)];
    const recovers = createFakeSession({
      log,
      connections: [
        { deliver: 0, end: { kind: "close" }, open: { kind: "throw", error: new TypeError("fetch failed") } },
        { deliver: 1, end: { kind: "close" } },
      ],
    });
    expect(await collect(recovers.session)).toHaveLength(1);
    expect(recovers.cancelCalls()).toBe(0);

    const neverOpens = createFakeSession({
      log,
      connections: Array.from({ length: 3 }, () => ({
        deliver: 0,
        end: { kind: "close" } as const,
        open: { kind: "throw", error: new TypeError("fetch failed") } as const,
      })),
    });
    await expect(collect(neverOpens.session)).rejects.toThrow(SessionStreamLostError);
    // The session is still running on eve's side — the only thing that failed was our connection to
    // it — so giving up has to stop it.
    expect(neverOpens.cancelCalls()).toBe(1);
  });

  it("rethrows a non-transport open failure instead of retrying it", async () => {
    const fake = createFakeSession({
      log: [completedEvent(0)],
      connections: [{ deliver: 0, end: { kind: "close" }, open: { kind: "throw", error: new Error("session not found") } }],
    });

    await expect(collect(fake.session)).rejects.toThrow("session not found");
    expect(fake.openedAt).toHaveLength(1);
    expect(fake.cancelCalls()).toBe(1);
  });

  it("does not hang when opening the stream never resolves", async () => {
    // Without racing the open against the cap, maxSessionMs is unreachable: the follower parks
    // forever, the phase heartbeat keeps the backend from reaping it, and the session runs unbounded.
    const fake = createFakeSession({
      log: [],
      connections: [{ deliver: 0, end: { kind: "close" }, open: { kind: "hang" } }],
    });

    await expect(collect(fake.session, { maxSessionMs: 20 })).rejects.toThrow(SessionTimeoutError);
    expect(fake.cancelCalls()).toBe(1);
  });

  it("stops the session after a fatal read error", async () => {
    const fake = createFakeSession({
      log: [startedEvent(0)],
      connections: [{ deliver: 1, end: { kind: "fatal", error: new Error("unexpected token < in JSON") } }],
    });

    await expect(collect(fake.session)).rejects.toThrow("unexpected token < in JSON");
    // The read failed for a reason that is ours, not the transport's — but the session on the other
    // end is unaffected and still running.
    expect(fake.cancelCalls()).toBe(1);
  });

  it("stops the session when the consumer exits on a non-terminal event", async () => {
    // `session.waiting` is where this bites in production: a task-mode session should never park,
    // so every consumer treats it as a failure and bails — leaving a live, parked session that
    // holds its continuation until eve's own timeout unless someone cancels it.
    const fake = createFakeSession({
      log: [waitingEvent(0)],
      connections: [{ deliver: 1, end: { kind: "close" } }],
    });

    const seen = await collect(fake.session, { stopOn: "session.waiting" });

    expect(seen.map((event) => event.type)).toEqual(["session.waiting"]);
    expect(fake.cancelCalls()).toBe(1);
  });

  it("skips the cleanup cancel when the caller says it already stopped the session", async () => {
    // The interview turn's shape: it cancels the session itself the moment a turn-ending tool
    // returns, then reads on until `turn.cancelled` and bails. That exit is not a settled session,
    // so without this option the follower would cancel a second time on every single turn — a
    // wasted round-trip on a path where a founder is waiting for the reply.
    const fake = createFakeSession({
      log: [waitingEvent(0)],
      connections: [{ deliver: 1, end: { kind: "close" } }],
    });
    let stoppedByCaller = false;

    const seen = await collect(fake.session, {
      stopOn: "session.waiting",
      // Deliberately flipped mid-iteration, after the options object was handed over: the follower
      // must read the callback when it cleans up, not when it was called.
      onEvent: () => {
        stoppedByCaller = true;
      },
      isAlreadyStopped: () => stoppedByCaller,
    });

    expect(seen.map((event) => event.type)).toEqual(["session.waiting"]);
    expect(fake.cancelCalls()).toBe(0);
  });

  it("still cancels every abandonment the caller has not stopped itself", async () => {
    // The guard is opt-in per exit, not a blanket opt-out: a caller that has not yet stopped the
    // session gets the old behaviour, including on the error paths it never reaches by choice.
    const bailsEarly = createFakeSession({
      log: [waitingEvent(0)],
      connections: [{ deliver: 1, end: { kind: "close" } }],
    });
    await collect(bailsEarly.session, { stopOn: "session.waiting", isAlreadyStopped: () => false });
    expect(bailsEarly.cancelCalls()).toBe(1);

    const timesOut = createFakeSession({
      log: [],
      connections: [{ deliver: 0, end: { kind: "close" }, open: { kind: "hang" } }],
    });
    await expect(collect(timesOut.session, { maxSessionMs: 20, isAlreadyStopped: () => false })).rejects.toThrow(SessionTimeoutError);
    expect(timesOut.cancelCalls()).toBe(1);
  });

  it("still cleans up when the caller's own stop attempt failed", async () => {
    // The guard reports what the caller achieved, not what it tried: a `cancel()` that rejected
    // leaves the session running, so the caller keeps its flag down and the cleanup cancel — the
    // last thing that can still stop it — has to run anyway.
    const fake = createFakeSession({
      log: [waitingEvent(0)],
      connections: [{ deliver: 1, end: { kind: "close" } }],
      onCancel: () => Promise.reject(new Error("cancel route returned 503")),
    });
    let stoppedByCaller = false;

    const follow = async () => {
      for await (const event of followSessionEvents({
        session: fake.session,
        label: "Test run",
        maxSessionMs: 60_000,
        reconnect: INSTANT_RETRIES,
        cancelWaitMs: 50,
        isAlreadyStopped: () => stoppedByCaller,
      })) {
        if (event.type !== "session.waiting") continue;
        await fake.session.cancel();
        stoppedByCaller = true;
        break;
      }
    };

    await expect(follow()).rejects.toThrow("cancel route returned 503");
    // The caller's failed attempt plus the follower's, and the follower's own failure stays in its
    // log rather than replacing the error the caller is already propagating.
    expect(fake.cancelCalls()).toBe(2);
  });

  it("leaves a session that failed on its own alone", async () => {
    // The mirror of the case above: `session.failed` means eve is already done with it, so
    // cancelling would be a pointless call against a dead session.
    const fake = createFakeSession({
      log: [{ type: "session.failed", data: { code: "MODEL_ERROR", message: "boom", sessionId: "wrun_test" }, meta: { at: new Date(0).toISOString(), id: "evt_0" } }],
      connections: [{ deliver: 1, end: { kind: "close" } }],
    });

    await collect(fake.session, { stopOn: "session.failed" });

    expect(fake.cancelCalls()).toBe(0);
  });

  it("does not hang when cancelling the session never resolves", async () => {
    // Cleanup on an error path must not become the reason a run hangs; we stop waiting, and the
    // cancel may still land afterwards.
    const fake = createFakeSession({
      log: [],
      connections: [{ deliver: 0, end: { kind: "close" }, open: { kind: "hang" } }],
      onCancel: () => new Promise<never>(() => {}),
    });

    await expect(collect(fake.session, { maxSessionMs: 20, cancelWaitMs: 30 })).rejects.toThrow(SessionTimeoutError);
    expect(fake.cancelCalls()).toBe(1);
  });

  it("defaults to eve's own idle-reconnect numbers", () => {
    // Not arbitrary: these are eve's own client numbers — `streamIdleReconnectPolicy` for the
    // silence budget, `streamOpenReconnectPolicy.maxAttempts` for the open budget — the only policy
    // proven against this same durable stream. A change here should be deliberate.
    expect(DEFAULT_SESSION_STREAM_RECONNECT_POLICY).toMatchInlineSnapshot(`
      {
        "baseDelayMs": 250,
        "maxDelayMs": 4000,
        "maxEmptyAttempts": 5,
        "maxOpenAttempts": 12,
      }
    `);
  });
});
