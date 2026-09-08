import type { ChannelFrom } from "eve/channels";
import { buildGrowthSessionAuth, type GrowthSessionAuthInput } from "#lib/run-context.ts";
import { followSessionEvents, SessionTimeoutError } from "#lib/session-stream.ts";
import type { JsonValue } from "#lib/types.ts";

export class SafeRunError extends Error {}

export function safeMessageFromError(error: unknown, fallback: string): string {
  return error instanceof SafeRunError ? error.message : fallback;
}

export type AgentSessionOutcome = {
  readonly sessionId: string,
  readonly structuredResult: unknown,
};

// Normal phase streams are tiny compared with this. The pathological report run crossed it only
// because every reasoning token carried the full cumulative reasoning snapshot, so 64 MiB leaves
// ample room for real reports and tool results while stopping that amplification early.
export const MAX_AGENT_SESSION_STREAM_BYTES = 64 * 1024 * 1024;

export async function runAgentSession(options: {
  readonly from: ChannelFrom,
  readonly message: string,
  readonly context: GrowthSessionAuthInput,
  readonly continuationToken: string,
  readonly title: string,
  readonly maxSessionMs: number,
  readonly timeoutMessage: string,
  readonly outputSchema?: Readonly<Record<string, JsonValue>>,
}): Promise<AgentSessionOutcome> {
  const session = await options.from(options.continuationToken).send(
    options.message,
    {
      auth: buildGrowthSessionAuth(options.context),
      mode: "task",
      title: options.title,
      outputSchema: options.outputSchema,
      // Retries must queue behind an in-flight run instead of steering it away.
      turnPolicy: "queue",
    },
  );
  let structuredResult: unknown = null;
  try {
    for await (const event of followSessionEvents({
      session,
      label: "Agent session",
      maxSessionMs: options.maxSessionMs,
      maxStreamBytes: MAX_AGENT_SESSION_STREAM_BYTES,
    })) {
      switch (event.type) {
        case "result.completed": {
          structuredResult = event.data.result;
          break;
        }
        case "session.completed": {
          return { sessionId: session.id, structuredResult };
        }
        case "session.failed": {
          throw new Error(`Agent session failed: session=${session.id} code=${event.data.code} message=${event.data.message}`);
        }
        case "session.waiting": {
          throw new Error(`Agent session parked waiting for input in task mode: session=${session.id}`);
        }
        default: {
          // Progress events (turn/step/message/subagent/...) — keep waiting.
          break;
        }
      }
    }
    throw new Error(`Agent session follower ended without a terminal event: session=${session.id}`);
  } catch (error) {
    if (error instanceof SessionTimeoutError) throw new SafeRunError(options.timeoutMessage);
    throw error;
  }
}
