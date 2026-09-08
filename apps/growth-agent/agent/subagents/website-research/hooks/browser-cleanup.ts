import { defineHook, type HookContext } from "eve/hooks";
import { stopBrowserSession } from "#lib/browser-session.ts";


const cleanedSessionIds = new Set<string>();

async function cleanUpTerminalSession(context: HookContext): Promise<void> {
  if (cleanedSessionIds.has(context.session.id)) return;
  await stopBrowserSession(context);
  cleanedSessionIds.add(context.session.id);
}

// Website research children are one-shot sessions. Close Chromium and stop the
// VM on every terminal boundary; Vercel's idle timeout remains only a final
// safety net for a process crash that prevents these hooks from running.
export default defineHook({
  events: {
    "session.completed": async (_event, context) => await cleanUpTerminalSession(context),
    "session.failed": async (_event, context) => await cleanUpTerminalSession(context),
    "turn.cancelled": async (_event, context) => await cleanUpTerminalSession(context),
  },
});
