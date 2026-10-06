import { DASHBOARD_SESSION_REPLAY_BLOCK_CLASS } from "@/hexclave/session-replay-config";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

/**
 * Prevent the dashboard's recorder from descending into an embedded rrweb
 * player. A nested player reuses rrweb mirror IDs from the replay it renders;
 * exposing those nodes to the outer recorder can make playback mutations
 * remove unrelated nodes such as the dashboard's own stylesheets.
 */
export function ReplayRecordingBoundary({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-hexclave-session-replay-block=""
      className={cn("rr-block", DASHBOARD_SESSION_REPLAY_BLOCK_CLASS, className)}
    />
  );
}
