import type { Session } from "eve/channels";

export type SessionStreamEvent =
  Awaited<ReturnType<Session["getEventStream"]>> extends ReadableStream<infer TEvent> ? TEvent : never;

export type SessionStreamReconnectPolicy = {
  readonly baseDelayMs: number,
  readonly maxDelayMs: number,

  readonly maxEmptyAttempts: number,
  readonly maxOpenAttempts: number,
};

export const DEFAULT_SESSION_STREAM_RECONNECT_POLICY: SessionStreamReconnectPolicy = {
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  maxEmptyAttempts: 5,
  maxOpenAttempts: 12,
};

const CANCEL_WAIT_MS = 10_000;

export class SessionTimeoutError extends Error {}

export class SessionStreamLostError extends Error {}

export class SessionStreamLimitError extends Error {}


function isStreamDisconnectError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "UND_ERR_SOCKET") return true;
  if (error.name === "AbortError" || error.message === "terminated") return true;
  if (error instanceof TypeError && /^(?:failed to fetch|fetch failed)$/i.test(error.message)) return true;
  return /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message);
}

function sleep(ms: number): Promise<"slept"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("slept"), ms);
    timer.unref();
  });
}


async function cancelAbandonedSession(session: Session, label: string, waitMs: number): Promise<void> {
  try {
    const outcome = await Promise.race([session.cancel().then(() => "cancelled" as const), sleep(waitMs)]);
    if (outcome === "slept") {
      console.error(`[growth-agent] gave up waiting for session cancellation after ${waitMs}ms: ${label} session=${session.id}`);
    }
  } catch (error) {
    console.error(`[growth-agent] failed to cancel abandoned session: ${label} session=${session.id}`, error);
  }
}

export type FollowSessionOptions = {
  readonly session: Session,
  readonly label: string,
  readonly maxSessionMs: number,
  readonly reconnect?: SessionStreamReconnectPolicy,
  readonly cancelWaitMs?: number,
  readonly isAlreadyStopped?: () => boolean,
  /**
   * Maximum serialized bytes this follower will accept before cancelling the session. This is a
   * logical stream budget rather than an allocated-disk measurement, but it is enforced while the
   * stream is live and therefore stops cumulative snapshot events before they can grow without
   * bound in either the local or hosted workflow store.
   */
  readonly maxStreamBytes?: number,
};


export async function* followSessionEvents(options: FollowSessionOptions): AsyncGenerator<SessionStreamEvent, never, void> {
  const { session, label, maxSessionMs } = options;
  const policy = options.reconnect ?? DEFAULT_SESSION_STREAM_RECONNECT_POLICY;
  const cancelWaitMs = options.cancelWaitMs ?? CANCEL_WAIT_MS;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutTimer = setTimeout(() => resolve("timeout"), maxSessionMs);
    timeoutTimer.unref();
  });
  const timedOut = (): SessionTimeoutError => new SessionTimeoutError(`${label} timed out: session=${session.id}`);

  let consumed = 0;
  let emptyAttempts = 0;
  let openAttempts = 0;
  let delayMs = policy.baseDelayMs;
  let sessionSettled = false;
  let streamBytes = 0;

  try {
    while (true) {
      let stream: Awaited<ReturnType<Session["getEventStream"]>> | "timeout";
      try {
        stream = await Promise.race([session.getEventStream({ startIndex: consumed }), timeoutPromise]);
      } catch (error) {
        if (!isStreamDisconnectError(error)) throw error;
        openAttempts += 1;
        if (openAttempts >= policy.maxOpenAttempts) {
          throw new SessionStreamLostError(`${label} event stream could not be reopened: session=${session.id} (${policy.maxOpenAttempts} failed attempts from index ${consumed})`);
        }
        delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
        if (await Promise.race([sleep(delayMs), timeoutPromise]) === "timeout") throw timedOut();
        continue;
      }
      if (stream === "timeout") throw timedOut();
      openAttempts = 0;

      const reader = stream.getReader();
      let deliveredThisConnection = false;
      try {
        while (true) {
          let readResult: ReadableStreamReadResult<SessionStreamEvent> | "timeout";
          try {
            readResult = await Promise.race([reader.read(), timeoutPromise]);
          } catch (error) {
            if (!isStreamDisconnectError(error)) throw error;
            break;
          }
          if (readResult === "timeout") throw timedOut();
          if (readResult.done) break;
          consumed += 1;
          deliveredThisConnection = true;
          if (options.maxStreamBytes !== undefined) {
            streamBytes += Buffer.byteLength(JSON.stringify(readResult.value), "utf8");
            if (streamBytes > options.maxStreamBytes) {
              throw new SessionStreamLimitError(
                `${label} exceeded its ${options.maxStreamBytes}-byte event-stream budget: session=${session.id} consumed=${streamBytes}`,
              );
            }
          }
          if (readResult.value.type === "session.completed" || readResult.value.type === "session.failed") {
            sessionSettled = true;
          }
          yield readResult.value;
        }
      } finally {
        await Promise.race([reader.cancel().catch(() => undefined), sleep(cancelWaitMs)]);
        reader.releaseLock();
      }

      if (deliveredThisConnection) {
        emptyAttempts = 0;
        delayMs = policy.baseDelayMs;
      } else {
        emptyAttempts += 1;
        if (emptyAttempts >= policy.maxEmptyAttempts) {
          throw new SessionStreamLostError(
            `${label} event stream ended without a terminal event: session=${session.id} (no events across ${policy.maxEmptyAttempts} reconnects from index ${consumed})`,
          );
        }
        delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
      }
      if (await Promise.race([sleep(delayMs), timeoutPromise]) === "timeout") throw timedOut();
    }
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    const alreadyStopped = sessionSettled || (options.isAlreadyStopped?.() ?? false);
    if (!alreadyStopped) await cancelAbandonedSession(session, label, cancelWaitMs);
  }
}
