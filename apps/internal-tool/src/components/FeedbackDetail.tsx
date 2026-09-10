import { format } from "date-fns";
import type { FeedbackLogRow, McpCallLogRow } from "../types";
import { toDate } from "../utils";
import { feedbackCategoryColor } from "../lib/feedback-category";
import { Badge, Button } from "./design";

function Field({ label, value }: { label: string, value: string | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words font-mono text-foreground">{value}</span>
    </div>
  );
}

export function FeedbackDetail({
  row,
  relatedCall,
  onClose,
  onOpenRelatedCall,
}: {
  row: FeedbackLogRow,
  relatedCall: McpCallLogRow | null,
  onClose: () => void,
  onOpenRelatedCall: (call: McpCallLogRow) => void,
}) {
  return (
    <div className="space-y-5 p-5">
      <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] pb-4 dark:border-white/[0.06]">
        <div className="space-y-1">
          <p className="text-sm font-semibold tracking-tight text-foreground">Feedback detail</p>
          <Badge color={feedbackCategoryColor(row.category)}>{row.category}</Badge>
          <div className="text-[10px] tabular-nums text-muted-foreground">
            {format(toDate(row.createdAt), "yyyy-MM-dd HH:mm:ss")}
          </div>
        </div>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Message</p>
        <div className="whitespace-pre-wrap break-words rounded-xl border border-black/[0.06] bg-foreground/[0.04] p-3 text-sm leading-6 text-foreground dark:border-white/[0.06]">
          {row.message}
        </div>
      </div>

      {row.conversationId != null && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Related conversation</div>
          {relatedCall != null ? (
            <button
              onClick={() => onOpenRelatedCall(relatedCall)}
              className="w-full rounded-lg border border-black/[0.08] px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:transition-none hover:bg-foreground/[0.05] dark:border-white/[0.08]"
            >
              <span className="font-mono text-[10px] text-muted-foreground">{relatedCall.toolName}</span>
              <span className="block truncate">{relatedCall.question}</span>
            </button>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
              {row.conversationId} (not in the live call log window)
            </div>
          )}
        </div>
      )}

      <div className="space-y-2 border-t border-black/[0.06] pt-4 dark:border-white/[0.06]">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Request metadata</p>
        <Field label="Correlation ID" value={row.correlationId} />
        <Field label="Conversation ID" value={row.conversationId} />
        <Field label="Transport" value={row.transport} />
        <Field label="Request IP" value={row.requestIp} />
        <Field label="IP source" value={row.requestIpSource} />
        <Field label="Request host" value={row.requestHost} />
        <Field label="MCP version" value={row.mcpProtocolVersion} />
        <Field label="User agent" value={row.userAgent} />
      </div>
    </div>
  );
}
